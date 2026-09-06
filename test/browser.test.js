'use strict';
// Phase 7 — Browser/Playwright optional adapter. The core suite runs WITHOUT
// Playwright installed, so these tests verify the honest-unavailable path,
// conditional tool registration, and the module contract. Real-browser tests
// (test/browser-live.test.js) are separate and self-skip when Playwright or
// its Chromium build is missing.

const test = require('node:test');
const assert = require('node:assert/strict');

const { browserStatus, loadPlaywright, BrowserManager } = require('../src/browser');
const { TOOL_NAMES, TOOL_DEFS } = require('../src/agent-tools');

test('browserStatus reports honestly when Playwright is unavailable', async () => {
  const status = await browserStatus();
  if (loadPlaywright()) {
    assert.equal(status.available, true); // environment has playwright: fine
    return;
  }
  assert.equal(status.available, false);
  assert.match(status.detail, /npm install playwright/);
  assert.equal(status.browserRunning, false);
});

test('when Playwright is missing, no browser tools are registered (no phantom capability)', () => {
  const browserTools = TOOL_NAMES.filter((n) => n.startsWith('browser_'));
  if (loadPlaywright()) {
    assert.ok(browserTools.length >= 6, 'playwright present: browser tools must be registered');
  } else {
    assert.deepEqual(browserTools, [], 'declared tools must never include unavailable browser capability');
  }
  // Invariant: every declared browser tool is executable, and vice versa.
  for (const def of TOOL_DEFS) assert.ok(TOOL_NAMES.includes(def.name));
});

test('BrowserManager without Playwright fails with BROWSER_UNAVAILABLE, never crashes', async () => {
  if (loadPlaywright()) return; // only meaningful when absent
  const manager = new BrowserManager();
  await assert.rejects(
    () => manager.navigate('http://example.invalid/'),
    (e) => e.code === 'BROWSER_UNAVAILABLE' && /npm install playwright/.test(e.message)
  );
  const closed = await manager.close();
  assert.equal(closed.ok, true);
});
