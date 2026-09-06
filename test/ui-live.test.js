'use strict';
// Phase 10 (live UI) — REAL browser click-through of the workstation UI with
// Playwright against a real running server. Self-skips (honestly) when
// Playwright/Chromium is not installed. This is what makes "the UI works" a
// verified claim rather than a hope.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { loadPlaywright } = require('../src/browser');
const pw = loadPlaywright();

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('UI: full workstation click-through (project, files, terminal, tests, approvals, chat)', { skip: !pw && 'playwright not installed' }, async (t) => {
  try {
    await pw.chromium.launch({ headless: true }).then((b) => b.close());
  } catch (e) {
    return t.skip(`chromium not available: ${e.message.split('\n')[0]}`);
  }

  // --- fixtures: data dir + a small real project with a real test suite -----
  const dataDir = tmpDir('ui-live-data-');
  const projectRoot = tmpDir('ui-live-proj-');
  fs.mkdirSync(path.join(projectRoot, 'lib'));
  fs.mkdirSync(path.join(projectRoot, 'test'));
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'ui-live', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(projectRoot, 'lib', 'calc.js'), 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n');
  fs.writeFileSync(path.join(projectRoot, 'test', 'calc.test.js'),
    "const test = require('node:test');\nconst assert = require('node:assert');\n" +
    "const { add } = require('../lib/calc');\ntest('adds', () => assert.equal(add(1, 1), 2));\n");

  // --- a scripted OpenAI-compatible mock provider (no real key, no network) --
  const provider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Mock agent confirms the workstation UI works end to end.' } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }));
    });
  });
  await new Promise((r) => provider.listen(0, r));

  // --- boot the real server ---------------------------------------------------
  process.env.AGENT_DATA_DIR = dataDir;
  process.env.PORT = '0';
  delete require.cache[require.resolve('../server')];
  const { server, config } = require('../server');
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Register the mock provider + project through the real API.
  await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'mock-1', name: 'Mock', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${provider.address().port}`, model: 'mock-model', apiKey: 'mock-key', enabled: true, priority: 1 }),
  });
  const { project } = await (await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootPath: projectRoot }),
  })).json();

  // --- drive the real UI -------------------------------------------------------
  const browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#active-project');

    const step = (n, extra) => console.log('UI-STEP', n, extra||'');
    step(1);
    // 1. Header shows the active project.
    await page.waitForFunction(() => document.getElementById('active-project').textContent.trim() !== '' && document.getElementById('active-project').textContent !== 'No project');
    assert.equal((await page.textContent('#active-project')).trim(), project.name);

    step(2);// renders and opens a file into the viewer.
    await page.waitForSelector('#file-tree .tree-item', { timeout: 5000 });
    await page.click('#file-tree .tree-item:has-text("lib")'); // expand lib/
    await page.waitForSelector('#file-tree .tree-item:has-text("calc.js")');
    await page.click('#file-tree .tree-item:has-text("calc.js")');
    await page.waitForFunction(() => document.getElementById('file-viewer').value.includes('return a + b'));
    assert.ok(true, 'file viewer shows the selected file');

    step(3);// panel runs a real command in the project root.
    await page.click('#tab-bar .tab[data-tab="terminal"]');
    await page.fill('#terminal-input', 'echo ui-smoke-ok');
    await page.click('#terminal-run-btn');
    await page.waitForFunction(() => document.getElementById('terminal-output').textContent.includes('ui-smoke-ok'), null, { timeout: 15000 });

    step(4);// runs the real suite via the button.
    await page.click('#tab-bar .tab[data-tab="tests"]');
    await page.click('#tests-run-btn');
    await page.waitForSelector('.test-summary', { timeout: 60000 });
    const testSummary = await page.textContent('.test-summary');
    assert.match(testSummary, /PASS/, 'real test run shows PASS');

    step(5);//: propose a change via the editor path (assist), approve in UI.
    await fetch(`${base}/api/settings/safety-mode`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'assist' }),
    });
    await fetch(`${base}/api/file/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'lib/calc.js', content: 'function add(a, b) {\n  return a + b; // reviewed\n}\nmodule.exports = { add };\n' }),
    });
    await page.click('#tab-bar .tab[data-tab="diff"]');
    await page.waitForSelector('.approval-card', { timeout: 5000 });
    const diffShown = await page.textContent('.approval-card');
    assert.match(diffShown, /lib\/calc\.js/, 'pending approval shows the file and diff');
    await page.click('.approval-card [data-act="approve"]');
    await page.waitForFunction(() => !document.querySelector('.approval-card') || !document.querySelector('#pending-approvals .approval-card'), null, { timeout: 5000 });
    assert.match(fs.readFileSync(path.join(projectRoot, 'lib', 'calc.js'), 'utf8'), /reviewed/, 'approved change applied to disk');
    await fetch(`${base}/api/settings/safety-mode`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'agent' }),
    });

    step(6);//: honest "not a git repository" for a non-git project.
    await page.click('#tab-bar .tab[data-tab="git"]');
    await page.waitForFunction(() => document.getElementById('git-status').textContent.toLowerCase().includes('not a git repository'), null, { timeout: 5000 });

    step(7);// shows real capability status.
    await page.click('#tab-bar .tab[data-tab="browser"]');
    await page.waitForFunction(() => document.getElementById('browser-status').textContent.includes('AVAILABLE'), null, { timeout: 5000 });

    step(8);//: run a real agent task against the scripted provider via the UI composer.
    await page.click('#tab-bar .tab[data-tab="chat"]');
    await page.fill('#composer-input', 'say the UI works');
    await page.click('#send-btn');
    await page.waitForSelector('.card', { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('#chat-log .card-title') && document.querySelector('#chat-log .card-title').textContent.includes('completed'), null, { timeout: 30000 });
    const summary = await page.textContent('#chat-log .card pre');
    assert.match(summary, /Mock agent confirms/, 'agent result card shows the real model output');

    step(9);// during the whole session.
    assert.deepEqual(errors, [], 'no uncaught page errors during the UI session');
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    await new Promise((r) => provider.close(r));
    delete process.env.AGENT_DATA_DIR;
    delete process.env.PORT;
  }
});
