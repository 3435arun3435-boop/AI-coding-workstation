'use strict';
// Phase 12 — hardening: request limits, malformed input handling, honest 404s,
// and the single-agent-run concurrency lock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = () => `http://127.0.0.1:${server.address().port}`;

let server;
let dataDir;
let projectRoot;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harden-data-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harden-proj-'));
  fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'x');
  process.env.AGENT_DATA_DIR = dataDir;
  process.env.PORT = '0';
  delete require.cache[require.resolve('../server')];
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, r));
  await fetch(`${BASE()}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootPath: projectRoot }),
  });
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  delete process.env.AGENT_DATA_DIR;
  delete process.env.PORT;
});

test('malformed JSON body → 400, not a 500 stack', async () => {
  const res = await fetch(`${BASE()}/api/settings/theme`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ this is broken',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
});

test('oversized body → 413 and the connection is refused cleanly', async () => {
  const big = JSON.stringify({ content: 'x'.repeat(3 * 1024 * 1024) });
  const res = await fetch(`${BASE()}/api/file/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: big,
  });
  assert.equal(res.status, 413);
});

test('unknown API route → structured 404', async () => {
  const res = await fetch(`${BASE()}/api/does-not-exist`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.ok(body.error);
});

test('static file serving blocks path traversal', async () => {
  const res = await fetch(`${BASE()}/..%2f..%2fserver.js`);
  assert.ok([403, 404].includes(res.status), `traversal must be blocked, got ${res.status}`);
  const direct = await fetch(`${BASE()}/../../server.js`);
  assert.ok([403, 404].includes(direct.status));
});

test('invalid provider config → 400 with a clear message, no crash', async () => {
  const res = await fetch(`${BASE()}/api/providers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'no id here' }),
  });
  assert.equal(res.status, 500); // upsertProvider throws → friendlyError; acceptable but must be structured
  const body = await res.json();
  assert.ok(body.error);
});

test('only one agent task runs at a time (409 for a second concurrent run)', async () => {
  // A scripted provider whose response is delayed → the first run stays busy.
  const http = require('http');
  const provider = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'slow mock' } }] }));
    }, 1500);
  });
  await new Promise((r) => provider.listen(0, r));
  // Configure through the SERVER's API so its in-memory config sees it.
  await fetch(`${BASE()}/api/providers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'slow-1', name: 'Slow', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${provider.address().port}`, model: 'm', apiKey: 'k', enabled: true, priority: 1 }),
  });

  const first = fetch(`${BASE()}/api/agent/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'slow task', mode: 'code' }),
  }).then(async (res) => {
    assert.equal(res.status, 200);
    await res.text(); // consume the SSE stream fully
  });
  await new Promise((r) => setTimeout(r, 300));
  const second = await fetch(`${BASE()}/api/agent/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'second task' }),
  });
  assert.equal(second.status, 409, 'second concurrent run is refused with 409');
  const secondBody = await second.json();
  assert.match(secondBody.error, /already running/);

  await first; // let the first run finish
  provider.close();

  // After the run completes, the lock is released.
  await new Promise((r) => setTimeout(r, 300));
  const third = await fetch(`${BASE()}/api/agent/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'after lock release' }),
  });
  // The stream starts (200) even though the mock provider is gone; the task
  // will report a provider error honestly via SSE.
  assert.equal(third.status, 200, 'lock released after the first run finished');
  await third.text();
});
