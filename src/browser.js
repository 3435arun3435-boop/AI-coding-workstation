'use strict';
/**
 * browser.js
 *
 * Optional Playwright-backed browser automation. This module degrades
 * gracefully: when the `playwright` package (and its browsers) are not
 * installed, everything reports "unavailable" honestly and nothing pretends
 * to work. When available, it provides a small, bounded adapter —
 * navigate, click, type, select, screenshot, console/page/network error
 * capture — with hard timeouts and guaranteed cleanup.
 *
 * The adapter is used by (a) agent tools registered only when Playwright is
 * actually resolvable, and (b) the /api/browser/* endpoints and UI panel.
 */

const DEFAULT_NAV_TIMEOUT_MS = 30_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const IDLE_CLOSE_MS = 5 * 60_000;

let cachedModule = undefined; // undefined = not checked; null = unavailable

// Runtime-configurable options (Settings Center → Browser), applied by the server.
const options = { headless: true, defaultTimeoutMs: DEFAULT_NAV_TIMEOUT_MS };
function configure({ headless, defaultTimeoutMs } = {}) {
  if (typeof headless === 'boolean') options.headless = headless;
  if (Number.isInteger(defaultTimeoutMs)) options.defaultTimeoutMs = defaultTimeoutMs;
}
let cachedDetail = null;

/** Attempt to resolve Playwright. Never throws. */
function loadPlaywright() {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // eslint-disable-next-line global-require
    cachedModule = require('playwright');
    cachedDetail = 'playwright package resolved';
  } catch (e) {
    cachedModule = null;
    cachedDetail = `playwright is not installed (${e.code || 'module not found'}). Install with: npm install playwright && npx playwright install chromium`;
  }
  return cachedModule;
}

/** Honest capability report — used by the UI, the doctor, and the tools. */
async function browserStatus() {
  const pw = loadPlaywright();
  if (!pw) {
    return { available: false, detail: cachedDetail, browserRunning: false };
  }
  let running = false;
  try {
    running = !!(manager.browser && manager.browser.isConnected());
  } catch {
    running = false;
  }
  return {
    available: true,
    detail: cachedDetail,
    version: pw.chromium && pw.chromium.name ? `chromium via playwright` : 'playwright',
    browserRunning: running,
  };
}

/**
 * Shared browser session. One headless Chromium instance; pages are created
 * per navigation and closed with the session. Captures console errors, page
 * errors, and failed requests per page.
 */
class BrowserManager {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.consoleErrors = [];
    this.pageErrors = [];
    this.failedRequests = [];
    this.networkEvents = [];
    this.idleTimer = null;
  }

  _resetCapture() {
    this.consoleErrors = [];
    this.pageErrors = [];
    this.failedRequests = [];
    this.networkEvents = [];
  }

  _touchIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.close().catch(() => {});
    }, IDLE_CLOSE_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  async ensureLaunched() {
    if (this.browser && this.browser.isConnected()) {
      this._touchIdleTimer();
      return;
    }
    const pw = loadPlaywright();
    if (!pw) {
      const err = new Error(cachedDetail);
      err.code = 'BROWSER_UNAVAILABLE';
      throw err;
    }
    try {
      this.browser = await pw.chromium.launch({ headless: options.headless });
    } catch (e) {
      // Package present but browsers not downloaded — a distinct, actionable state.
      const err = new Error(
        `Playwright is installed but Chromium failed to launch: ${e.message}. Run: npx playwright install chromium`
      );
      err.code = 'BROWSER_UNAVAILABLE';
      throw err;
    }
    this.context = await this.browser.newContext();
    this._touchIdleTimer();
  }

  _attachListeners(page) {
    page.on('console', (msg) => {
      if (msg.type() === 'error') this.consoleErrors.push({ type: 'console', text: msg.text(), ts: new Date().toISOString() });
    });
    page.on('pageerror', (err) => {
      this.pageErrors.push({ type: 'pageerror', text: String(err && err.message ? err.message : err), ts: new Date().toISOString() });
    });
    page.on('requestfailed', (req) => {
      this.failedRequests.push({ type: 'requestfailed', url: req.url(), failure: req.failure() && req.failure().errorText, ts: new Date().toISOString() });
      this.networkEvents.push({ url: req.url(), ok: false });
    });
    page.on('response', (res) => {
      if (this.networkEvents.length < 200) this.networkEvents.push({ url: res.url(), status: res.status(), ok: res.ok() });
    });
  }

  /** Launch (if needed) and navigate to a URL. Returns page state + errors. */
  async navigate(url, { timeoutMs } = {}) {
    await this.ensureLaunched();
    this._resetCapture();
    if (this.page) {
      try {
        await this.page.close();
      } catch {
        /* already closed */
      }
    }
    this.page = await this.context.newPage();
    this._attachListeners(this.page);
    await this.page.goto(url, { timeout: Number(timeoutMs) || options.defaultTimeoutMs, waitUntil: 'domcontentloaded' });
    return {
      ok: true,
      url: this.page.url(),
      title: await this.page.title(),
      errors: this.collectErrors(),
    };
  }

  async click(selector, { timeoutMs } = {}) {
    await this._requirePage();
    await this.page.click(selector, { timeout: Number(timeoutMs) || DEFAULT_ACTION_TIMEOUT_MS });
    return { ok: true, url: this.page.url(), errors: this.collectErrors() };
  }

  async type(selector, text, { timeoutMs } = {}) {
    await this._requirePage();
    await this.page.fill(selector, String(text), { timeout: Number(timeoutMs) || DEFAULT_ACTION_TIMEOUT_MS });
    return { ok: true, errors: this.collectErrors() };
  }

  async select(selector, value, { timeoutMs } = {}) {
    await this._requirePage();
    await this.page.selectOption(selector, String(value), { timeout: Number(timeoutMs) || DEFAULT_ACTION_TIMEOUT_MS });
    return { ok: true, errors: this.collectErrors() };
  }

  async content({ selector, timeoutMs } = {}) {
    await this._requirePage();
    if (selector) {
      const el = await this.page.waitForSelector(selector, { timeout: Number(timeoutMs) || DEFAULT_ACTION_TIMEOUT_MS });
      return { ok: true, content: await el.innerHTML(), errors: this.collectErrors() };
    }
    return { ok: true, content: await this.page.content(), errors: this.collectErrors() };
  }

  /** Screenshot: writes a file when `path` is given, otherwise returns base64 PNG. */
  async screenshot({ path: filePath, fullPage = false } = {}) {
    await this._requirePage();
    const buffer = await this.page.screenshot({ path: filePath, fullPage, type: 'png' });
    return {
      ok: true,
      path: filePath || null,
      bytes: buffer.length,
      encoding: filePath ? 'file' : 'base64',
      data: filePath ? undefined : buffer.toString('base64'),
      errors: this.collectErrors(),
    };
  }

  collectErrors() {
    return {
      consoleErrors: this.consoleErrors,
      pageErrors: this.pageErrors,
      failedRequests: this.failedRequests,
      totalErrors: this.consoleErrors.length + this.pageErrors.length + this.failedRequests.length,
    };
  }

  async errors() {
    if (!this.page) {
      return { ok: false, message: 'No page is open. Navigate first.' };
    }
    return { ok: true, url: this.page.url(), ...this.collectErrors(), networkEvents: this.networkEvents.slice(-100) };
  }

  async _requirePage() {
    await this.ensureLaunched();
    if (!this.page) {
      const err = new Error('No page is open. Call browser_navigate first.');
      err.code = 'NO_PAGE';
      throw err;
    }
    this._touchIdleTimer();
  }

  async close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      if (this.page) await this.page.close().catch(() => {});
      if (this.context) await this.context.close().catch(() => {});
      if (this.browser) await this.browser.close().catch(() => {});
    } finally {
      this.page = null;
      this.context = null;
      this.browser = null;
    }
    return { ok: true };
  }
}

const manager = new BrowserManager();

module.exports = {
  BrowserManager,
  manager,
  configure,
  browserStatus,
  loadPlaywright,
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_ACTION_TIMEOUT_MS,
};
