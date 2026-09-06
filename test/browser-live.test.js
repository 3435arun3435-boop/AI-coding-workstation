'use strict';
// Phase 7 (live) — REAL browser verification. Self-skips (honestly) when the
// optional Playwright package or its Chromium build is not installed. Nothing
// here fakes a pass.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { loadPlaywright, manager } = require('../src/browser');

const pw = loadPlaywright();

async function ensureBrowser(t) {
  if (!pw) return t.skip('playwright not installed (optional dependency) — see README for setup');
  try {
    const b = await pw.chromium.launch({ headless: true });
    await b.close();
  } catch (e) {
    return t.skip(`chromium not available: ${e.message.split('\n')[0]}`);
  }
  return true;
}

test('browser: navigate to a local page, interact, and capture errors', async (t) => {
  if (!(await ensureBrowser(t))) return;

  // Tiny local server so no network access is needed.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><title>Tiny Page</title></head><body>' +
      '<button id="b" onclick="document.getElementById(\'out\').textContent=\'clicked\'">go</button>' +
      '<div id="out"></div></body></html>');
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    const nav = await manager.navigate(`http://127.0.0.1:${port}/`);
    assert.equal(nav.ok, true);
    assert.equal(nav.title, 'Tiny Page');
    assert.equal(nav.errors.totalErrors, 0);

    const click = await manager.click('#b');
    assert.equal(click.ok, true);
    const content = await manager.content({ selector: '#out' });
    assert.equal(content.content, 'clicked');

    const shot = await manager.screenshot({});
    assert.equal(shot.encoding, 'base64');
    assert.ok(shot.bytes > 100, 'screenshot is a real image buffer');
  } finally {
    await manager.close();
    server.close();
  }
});

test('browser: page errors are captured, not swallowed', async (t) => {
  if (!(await ensureBrowser(t))) return;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<script>throw new Error("boom-on-purpose")</script><body>hi</body>');
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const nav = await manager.navigate(`http://127.0.0.1:${port}/`);
    assert.equal(nav.ok, true);
    assert.ok(nav.errors.pageErrors.some((e) => /boom-on-purpose/.test(e.text)), 'page error must be captured');
  } finally {
    await manager.close();
    server.close();
  }
});
