'use strict';
// Phase 9 — Task Center + Memory: lifecycle statuses, cooperative
// cancellation, retry, bounded history, and memory bounds/scoping.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TaskStore, STATUSES } = require('../src/tasks');
const { MemoryStore } = require('../src/memory');
const { runAgentTask } = require('../src/agent-loop');
const { ProviderRouter } = require('../src/providers');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- task center -------------------------------------------------------------

test('task store supports the full lifecycle statuses', () => {
  const store = new TaskStore(tmpDir('tc-'));
  for (const s of ['queued', 'waiting_approval', 'testing', 'debugging', 'partial', 'blocked', 'cancelled']) {
    assert.ok(STATUSES.includes(s), `${s} is a valid status`);
  }
  const rec = store.create({ title: 'T', project: 'p', mode: 'debug' });
  assert.equal(rec.status, 'running');
  store.update(rec.id, { status: 'waiting_approval' });
  store.update(rec.id, { status: 'debugging', attempts: 2 });
  store.complete(rec.id, { status: 'partial', summary: 'some failures remain', attempts: 2 });
  const done = store.get(rec.id);
  assert.equal(done.status, 'partial');
  assert.equal(done.attempts, 2);
  assert.ok(done.durationMs >= 0);
  assert.throws(() => store.update(rec.id, { status: 'yolo' }));
});

test('task cancellation is cooperative: requestCancel flags, runner completes it', () => {
  const store = new TaskStore(tmpDir('tc-cancel-'));
  const rec = store.create({ title: 'long task', project: 'p' });
  assert.equal(store.isCancelled(rec.id), false);
  store.requestCancel(rec.id);
  assert.equal(store.isCancelled(rec.id), true);
  assert.equal(store.get(rec.id).cancelRequested, true);
  // Completing clears the flag and sets final status.
  store.complete(rec.id, { status: 'cancelled', summary: 'cancelled by user' });
  assert.equal(store.isCancelled(rec.id), false);
  // Cancelling a finished task is a no-op on status.
  const again = store.requestCancel(rec.id);
  assert.equal(again.status, 'cancelled');
});

test('task retry creates a NEW record and never destroys history', () => {
  const store = new TaskStore(tmpDir('tc-retry-'));
  const rec = store.create({ title: 'fix bug', project: 'demo', mode: 'debug' });
  store.complete(rec.id, { status: 'failed', summary: 'nope' });
  const retried = store.retry(rec.id);
  assert.notEqual(retried.id, rec.id);
  assert.equal(retried.title, 'fix bug');
  assert.equal(retried.mode, 'debug');
  assert.equal(retried.status, 'running');
  assert.equal(store.get(rec.id).status, 'failed', 'original record untouched');
});

test('task history is bounded', () => {
  const store = new TaskStore(tmpDir('tc-bound-'));
  for (let i = 0; i < 260; i++) store.create({ title: `t${i}`, project: 'p' });
  assert.ok(store.list(1000).length <= 200);
});

test('task store persists across restart with new fields', () => {
  const dataDir = tmpDir('tc-persist-');
  const s1 = new TaskStore(dataDir);
  const rec = s1.create({ title: 'T', project: 'p', mode: 'code', provider: 'groq-1', model: 'm' });
  s1.update(rec.id, { status: 'testing' });
  const s2 = new TaskStore(dataDir);
  const loaded = s2.get(rec.id);
  assert.equal(loaded.mode, 'code');
  assert.equal(loaded.provider, 'groq-1');
  assert.equal(loaded.status, 'testing');
  assert.ok(Array.isArray(loaded.errors));
});

// --- agent loop cancellation ---------------------------------------------------

test('agent loop stops cooperatively when shouldCancel fires', async () => {
  const projectRoot = tmpDir('loop-cancel-');
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);
  let calls = 0;
  const mockCall = async () => {
    calls++;
    return {
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [{ id: `x${calls}`, function: { name: 'list_files', arguments: '{}' } }],
        },
      }],
    };
  };
  let polls = 0;
  const result = await runAgentTask({
    task: 'loop',
    projectRoot,
    router,
    callFn: mockCall,
    shouldCancel: () => ++polls > 2, // allow the first turn, then cancel
  });
  assert.equal(result.status, 'cancelled');
  assert.match(result.summary, /cancelled/i);
  assert.ok(calls < 12, 'stopped well before the iteration cap');
});

// --- memory bounds & scoping -----------------------------------------------------

test('memory is bounded per category with oldest-first eviction', () => {
  const store = new MemoryStore(tmpDir('mem-bound-'));
  for (let i = 0; i < 520; i++) store.set('session', `k${i}`, i);
  const all = store.getAll('session');
  assert.ok(Object.keys(all).length <= 500);
  assert.equal(all.k519, 519, 'newest entries survive');
  assert.equal(all.k0, undefined, 'oldest entries evicted');
});

test('memory scope namespaces keys per project without collisions', () => {
  const store = new MemoryStore(tmpDir('mem-scope-'));
  store.set('project', 'framework', 'express', { scope: 'projA' });
  store.set('project', 'framework', 'fastapi', { scope: 'projB' });
  store.set('project', 'global-thing', 'shared');
  assert.equal(store.get('project', 'framework', { scope: 'projA' }), 'express');
  assert.equal(store.get('project', 'framework', { scope: 'projB' }), 'fastapi');
  const a = store.getAll('project', { scope: 'projA' });
  assert.deepEqual(a, { framework: 'express' }, 'scoped getAll strips the prefix and excludes others');
  const everything = store.getAll('project');
  assert.equal(everything['projA::framework'], 'express');
});

test('memory still refuses secret-like keys (with or without scope)', () => {
  const store = new MemoryStore(tmpDir('mem-secret-'));
  assert.throws(() => store.set('global', 'apiKey', 'x'));
  assert.throws(() => store.set('global', 'password', 'x', { scope: 'p1' }));
});
