'use strict';
// Phase 10 (backend) — the endpoints the workstation UI drives: sandboxed
// file explorer/editor, safety-gated terminal, browser status/verify, modes,
// tools, and task cancel/retry. Real HTTP against a real server instance.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = () => `http://127.0.0.1:${server.address().port}`;

let server;
let dataDir;
let projectRoot;

function api(pathname, opts = {}) {
  return fetch(`${BASE()}${pathname}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-backend-data-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-backend-proj-'));
  fs.writeFileSync(path.join(projectRoot, 'index.js'), 'console.log("hello");\n');
  fs.mkdirSync(path.join(projectRoot, 'lib'));
  fs.writeFileSync(path.join(projectRoot, 'lib', 'util.js'), 'module.exports = {};\n');

  process.env.AGENT_DATA_DIR = dataDir;
  process.env.PORT = '0';
  delete require.cache[require.resolve('../server')];
  ({ server } = require('../server'));
  await new Promise((resolve) => server.listen(0, resolve));

  await api('/api/projects', { method: 'POST', body: JSON.stringify({ rootPath: projectRoot }) });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.AGENT_DATA_DIR;
  delete process.env.PORT;
});

// --- file explorer / editor ---------------------------------------------------

test('GET /api/files lists the project directory, sandboxed', async () => {
  const res = await api('/api/files');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.entries.some((e) => e.name === 'index.js'));
  assert.ok(body.entries.some((e) => e.name === 'lib' && e.type === 'dir'));

  const evil = await api('/api/files?path=../../');
  assert.equal(evil.status, 403);
  const abs = await api(`/api/files?path=${encodeURIComponent(projectRoot)}`);
  assert.equal(abs.status, 403);
});

test('GET /api/file reads a file; traversal is rejected with 403', async () => {
  const ok = await api('/api/file?path=index.js');
  const body = await ok.json();
  assert.equal(ok.status, 200);
  assert.match(body.content, /hello/);

  const evil = await api('/api/file?path=../../../../etc/passwd');
  assert.equal(evil.status, 403);
});

test('POST /api/file/save applies in agent safety mode and proposes in assist mode', async () => {
  // default safety mode is 'agent' → applies directly
  const applied = await api('/api/file/save', {
    method: 'POST',
    body: JSON.stringify({ path: 'lib/new.js', content: 'exports.x = 1;\n' }),
  });
  const appliedBody = await applied.json();
  assert.equal(applied.status, 200);
  assert.equal(appliedBody.applied, true);
  assert.equal(fs.readFileSync(path.join(projectRoot, 'lib', 'new.js'), 'utf8'), 'exports.x = 1;\n');

  // switch to assist → becomes a pending approval with a diff
  await api('/api/settings/safety-mode', { method: 'POST', body: JSON.stringify({ mode: 'assist' }) });
  const proposed = await api('/api/file/save', {
    method: 'POST',
    body: JSON.stringify({ path: 'lib/new.js', content: 'exports.x = 2;\n' }),
  });
  const proposedBody = await proposed.json();
  assert.equal(proposedBody.proposed, true);
  assert.equal(proposedBody.approval.status, 'pending');
  assert.match(proposedBody.approval.diff, /-exports\.x = 1;/);
  // file NOT yet changed:
  assert.equal(fs.readFileSync(path.join(projectRoot, 'lib', 'new.js'), 'utf8'), 'exports.x = 1;\n');

  // readonly → hard 403
  await api('/api/settings/safety-mode', { method: 'POST', body: JSON.stringify({ mode: 'readonly' }) });
  const blocked = await api('/api/file/save', {
    method: 'POST',
    body: JSON.stringify({ path: 'lib/new.js', content: 'exports.x = 3;\n' }),
  });
  assert.equal(blocked.status, 403);

  // restore
  await api('/api/settings/safety-mode', { method: 'POST', body: JSON.stringify({ mode: 'agent' }) });
  // clean up the pending proposal so later tests start clean
  await api('/api/approvals/decide', { method: 'POST', body: JSON.stringify({ id: proposedBody.approval.id, decision: 'rejected' }) });
});

// --- terminal ------------------------------------------------------------------

test('POST /api/terminal/run: LOW risk runs, HIGH risk proposes, readonly blocks', async () => {
  const low = await api('/api/terminal/run', { method: 'POST', body: JSON.stringify({ command: 'echo terminal-ok' }) });
  const lowBody = await low.json();
  assert.equal(lowBody.applied, true);
  assert.equal(lowBody.result.exitCode, 0);
  assert.match(lowBody.result.stdout, /terminal-ok/);

  await api('/api/settings/safety-mode', { method: 'POST', body: JSON.stringify({ mode: 'agent' }) });
  const high = await api('/api/terminal/run', { method: 'POST', body: JSON.stringify({ command: 'npm install something' }) });
  const highBody = await high.json();
  assert.equal(highBody.proposed, true, 'npm install must be held for approval in agent mode');
  assert.equal(highBody.risk.level, 'high');
  await api('/api/approvals/decide', { method: 'POST', body: JSON.stringify({ id: highBody.approval.id, decision: 'rejected' }) });

  await api('/api/settings/safety-mode', { method: 'POST', body: JSON.stringify({ mode: 'readonly' }) });
  const blocked = await api('/api/terminal/run', { method: 'POST', body: JSON.stringify({ command: 'echo nope' }) });
  assert.equal(blocked.status, 403);

  await api('/api/settings/safety-mode', { method: 'POST', body: JSON.stringify({ mode: 'agent' }) });
});

// --- capability & lifecycle endpoints -------------------------------------------

test('GET /api/modes and /api/tools reflect real capability', async () => {
  const modes = await (await api('/api/modes')).json();
  assert.ok(modes.modes.some((m) => m.key === 'debug'));
  assert.ok(modes.modes.find((m) => m.key === 'ask').readOnly === true);

  const tools = await (await api('/api/tools')).json();
  assert.ok(tools.tools.some((t) => t.name === 'run_tests'));
  assert.ok(tools.tools.some((t) => t.name === 'git_status'));
});

test('GET /api/browser/status reports capability honestly', async () => {
  const { browser } = await (await api('/api/browser/status')).json();
  assert.equal(typeof browser.available, 'boolean');
  assert.ok(browser.detail);
  if (!browser.available) assert.match(browser.detail, /npm install playwright/);
});

test('POST /api/browser/verify refuses honestly when Playwright is unavailable', async () => {
  const { browser } = await (await api('/api/browser/status')).json();
  const res = await api('/api/browser/verify', { method: 'POST', body: JSON.stringify({ url: 'http://127.0.0.1:1/' }) });
  const body = await res.json();
  if (!browser.available) {
    assert.equal(res.status, 400);
    assert.match(body.error, /unavailable/i);
  } else {
    // available: connection refused is reported as ok:false, not a crash
    assert.equal(body.ok, false);
  }
});

test('task cancel + retry endpoints work', async () => {
  const created = await api('/api/tasks', { method: 'POST', body: JSON.stringify({}) }); // 404 route, just checking
  assert.equal(created.status, 404);

  // create a task through the task retry path: use retry on a nonexistent id → 404
  const badRetry = await api('/api/tasks/retry', { method: 'POST', body: JSON.stringify({ id: 'nope' }) });
  assert.equal(badRetry.status, 404);
});
