'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TOOL_DEFS, TOOL_NAMES, PROVIDER_TOOL_SCHEMAS, executeTool } = require('../src/agent-tools');
const { resolveInProject, PathSecurityError } = require('../src/security');
const { ProviderRouter } = require('../src/providers');
const { MemoryStore } = require('../src/memory');
const { TaskStore } = require('../src/tasks');
const { runAgentTask } = require('../src/agent-loop');
const { ConfigStore } = require('../src/config');
const { recallProfiles, profilesToSystemMessage, recordProfile, tokenize } = require('../src/profiles');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
test('declared provider tools exactly match executable tools (no drift, no hallucinated tools)', () => {
  const declaredNames = PROVIDER_TOOL_SCHEMAS.map((t) => t.function.name).sort();
  const executableNames = TOOL_NAMES.slice().sort();
  assert.deepEqual(declaredNames, executableNames);
  assert.equal(TOOL_DEFS.length, declaredNames.length);
});

// ---------------------------------------------------------------------------
test('calling an unknown/hallucinated tool returns a graceful error, never throws', async () => {
  const projectRoot = tmpDir('agent-proj-');
  const result = await executeTool('repo_browser.print_tree', '{}', { projectRoot });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unknown_tool');
  assert.match(result.message, /not registered/);
});

// ---------------------------------------------------------------------------
test('malformed tool JSON arguments are handled without crashing', async () => {
  const projectRoot = tmpDir('agent-proj-');
  const result = await executeTool('read_file', '{ this is not json', { projectRoot });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'malformed_arguments');
});

// ---------------------------------------------------------------------------
test('missing required arguments are handled gracefully', async () => {
  const projectRoot = tmpDir('agent-proj-');
  const result = await executeTool('read_file', {}, { projectRoot });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_arguments');
});

// ---------------------------------------------------------------------------
test('write_file then read_file round-trips within the project', async () => {
  const projectRoot = tmpDir('agent-proj-');
  const write = await executeTool('write_file', { path: 'hello.txt', content: 'hi there' }, { projectRoot });
  assert.equal(write.ok, true);
  const read = await executeTool('read_file', { path: 'hello.txt' }, { projectRoot });
  assert.equal(read.ok, true);
  assert.equal(read.result.content, 'hi there');
});

// ---------------------------------------------------------------------------
test('edit_file requires a unique match and rejects ambiguous/absent oldText', async () => {
  const projectRoot = tmpDir('agent-proj-');
  await executeTool('write_file', { path: 'f.txt', content: 'foo foo bar' }, { projectRoot });
  const ambiguous = await executeTool('edit_file', { path: 'f.txt', oldText: 'foo', newText: 'baz' }, { projectRoot });
  assert.equal(ambiguous.ok, false);
  const absent = await executeTool('edit_file', { path: 'f.txt', oldText: 'zzz', newText: 'baz' }, { projectRoot });
  assert.equal(absent.ok, false);
  const good = await executeTool('edit_file', { path: 'f.txt', oldText: 'bar', newText: 'baz' }, { projectRoot });
  assert.equal(good.ok, true);
});

// ---------------------------------------------------------------------------
test('security: relative path traversal outside project root is blocked', () => {
  const projectRoot = tmpDir('agent-proj-');
  assert.throws(() => resolveInProject(projectRoot, '../../etc/passwd'), PathSecurityError);
});

test('security: absolute path escape outside project root is blocked', () => {
  const projectRoot = tmpDir('agent-proj-');
  assert.throws(() => resolveInProject(projectRoot, '/etc/passwd'), PathSecurityError);
});

test('security: symlink pointing outside the project root is blocked', () => {
  const projectRoot = tmpDir('agent-proj-');
  const outside = tmpDir('agent-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.symlinkSync(outside, path.join(projectRoot, 'escape-link'));
  assert.throws(() => resolveInProject(projectRoot, 'escape-link/secret.txt'), PathSecurityError);
});

test('security violation surfaces as a structured tool error, not a crash', async () => {
  const projectRoot = tmpDir('agent-proj-');
  const result = await executeTool('read_file', { path: '../../etc/passwd' }, { projectRoot });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'security_violation');
});

// ---------------------------------------------------------------------------
test('search_project finds matches by substring across files', async () => {
  const projectRoot = tmpDir('agent-proj-');
  await executeTool('write_file', { path: 'a.js', content: 'const TODO = 1;\nconsole.log(TODO);' }, { projectRoot });
  const result = await executeTool('search_project', { query: 'TODO' }, { projectRoot });
  assert.equal(result.ok, true);
  assert.equal(result.result.matches.length, 2);
});

// ---------------------------------------------------------------------------
test('run_command executes within project cwd and reports exit code', async () => {
  const projectRoot = tmpDir('agent-proj-');
  const result = await executeTool('run_command', { command: 'echo hello-from-sandbox' }, { projectRoot });
  assert.equal(result.ok, true);
  assert.equal(result.result.exitCode, 0);
  assert.match(result.result.stdout, /hello-from-sandbox/);
});

test('run_command reports non-zero exit code without throwing', async () => {
  const projectRoot = tmpDir('agent-proj-');
  const result = await executeTool('run_command', { command: 'exit 7' }, { projectRoot });
  assert.equal(result.ok, true);
  assert.equal(result.result.exitCode, 7);
});

// ---------------------------------------------------------------------------
test('provider router falls over to the next configured provider on 429', async () => {
  const router = new ProviderRouter([
    { id: 'primary', name: 'Primary', enabled: true, priority: 1, model: 'm1' },
    { id: 'secondary', name: 'Secondary', enabled: true, priority: 2, model: 'm2' },
  ]);

  let calls = 0;
  const mockCall = async (entry) => {
    calls++;
    if (entry.id === 'primary') {
      const err = new Error('rate limited');
      err.status = 429;
      throw err;
    }
    return { choices: [{ message: { content: 'ok from secondary' } }] };
  };

  const result = await router.chat({ messages: [], tools: [] }, mockCall);
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'secondary');
  assert.equal(calls, 2);
  assert.equal(result.fallbackLog.length, 1);
});

test('provider router does not retry on a non-retryable error (e.g. bad request)', async () => {
  const router = new ProviderRouter([
    { id: 'primary', name: 'Primary', enabled: true, priority: 1, model: 'm1' },
    { id: 'secondary', name: 'Secondary', enabled: true, priority: 2, model: 'm2' },
  ]);

  let calls = 0;
  const mockCall = async (entry) => {
    calls++;
    const err = new Error('bad request');
    err.status = 400;
    throw err;
  };

  const result = await router.chat({ messages: [], tools: [] }, mockCall);
  assert.equal(result.ok, false);
  assert.equal(calls, 1); // never burns through the second key for a non-retryable error
});

test('provider router never loops beyond the number of eligible configured providers', async () => {
  const router = new ProviderRouter([
    { id: 'a', enabled: true, priority: 1 },
    { id: 'b', enabled: true, priority: 2 },
    { id: 'c', enabled: true, priority: 3 },
  ]);
  let calls = 0;
  const mockCall = async () => {
    calls++;
    const err = new Error('down');
    err.status = 503;
    throw err;
  };
  const result = await router.chat({ messages: [] }, mockCall);
  assert.equal(result.ok, false);
  assert.equal(calls, 3);
});

test('disabled providers are never selected', async () => {
  const router = new ProviderRouter([
    { id: 'off', enabled: false, priority: 1 },
    { id: 'on', enabled: true, priority: 2 },
  ]);
  const mockCall = async (entry) => ({ choices: [{ message: { content: `served by ${entry.id}` } }] });
  const result = await router.chat({ messages: [] }, mockCall);
  assert.equal(result.provider, 'on');
});

// ---------------------------------------------------------------------------
test('memory persists across store re-instantiation (simulated restart)', () => {
  const dataDir = tmpDir('agent-mem-');
  const store1 = new MemoryStore(dataDir);
  store1.set('project', 'framework', 'express');
  const store2 = new MemoryStore(dataDir); // simulates app restart
  assert.equal(store2.get('project', 'framework'), 'express');
});

test('memory refuses to store secret-like keys', () => {
  const dataDir = tmpDir('agent-mem-');
  const store = new MemoryStore(dataDir);
  assert.throws(() => store.set('global', 'apiKey', 'sk-12345'));
  assert.throws(() => store.set('global', 'user_password', 'hunter2'));
});

test('memory clear() respects category scoping', () => {
  const dataDir = tmpDir('agent-mem-');
  const store = new MemoryStore(dataDir);
  store.set('project', 'a', 1);
  store.set('global', 'b', 2);
  store.clear('project');
  assert.deepEqual(store.getAll('project'), {});
  assert.deepEqual(store.getAll('global'), { b: 2 });
});

// ---------------------------------------------------------------------------
test('task history persists and can be completed with results', () => {
  const dataDir = tmpDir('agent-tasks-');
  const store = new TaskStore(dataDir);
  const rec = store.create({ title: 'Fix bug', project: 'demo', provider: 'auto', model: 'auto' });
  assert.equal(rec.status, 'running');
  store.complete(rec.id, { status: 'completed', filesChanged: ['a.js'], testsRun: [], summary: 'Done' });
  const reloaded = new TaskStore(dataDir); // simulate restart
  const found = reloaded.get(rec.id);
  assert.equal(found.status, 'completed');
  assert.deepEqual(found.filesChanged, ['a.js']);
});

// ---------------------------------------------------------------------------
test('config store rejects a project path outside the filesystem / masks provider keys', () => {
  const dataDir = tmpDir('agent-cfg-');
  const store = new ConfigStore(dataDir);
  const saved = store.upsertProvider({ id: 'p1', name: 'Test', baseUrl: 'http://x', apiKey: 'sk-supersecret', model: 'm' });
  assert.equal(saved.apiKey, undefined);
  assert.equal(saved.apiKeySet, true);
  assert.match(saved.apiKeyMasked, /\*+cret$/);
});

// ---------------------------------------------------------------------------
test('agent loop: runs tool calls, records files changed, and stops on completion', async () => {
  const projectRoot = tmpDir('agent-loop-');
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);

  let turn = 0;
  const mockCall = async () => {
    turn++;
    if (turn === 1) {
      return {
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{ id: 't1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'out.txt', content: 'done' }) } }],
          },
        }],
      };
    }
    return { choices: [{ message: { role: 'assistant', content: 'All done.' } }] };
  };

  const activityEvents = [];
  const result = await runAgentTask({
    task: 'write a file',
    projectRoot,
    router,
    onActivity: (e) => activityEvents.push(e),
    callFn: mockCall,
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.filesChanged, ['out.txt']);
  assert.ok(fs.existsSync(path.join(projectRoot, 'out.txt')));
  assert.ok(activityEvents.some((e) => e.state === 'COMPLETE'));
});

test('agent loop recovers from a hallucinated tool call instead of crashing', async () => {
  const projectRoot = tmpDir('agent-loop-');
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);

  let turn = 0;
  const mockCall = async () => {
    turn++;
    if (turn === 1) {
      return {
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{ id: 't1', function: { name: 'repo_browser.print_tree', arguments: '{}' } }],
          },
        }],
      };
    }
    return { choices: [{ message: { role: 'assistant', content: 'Recovered and finished.' } }] };
  };

  const result = await runAgentTask({ task: 'do something', projectRoot, router, callFn: mockCall });
  assert.equal(result.status, 'completed');
});

test('agent loop reports incomplete instead of hanging when iteration limit is hit', async () => {
  const projectRoot = tmpDir('agent-loop-');
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);
  const mockCall = async () => ({
    choices: [{
      message: {
        role: 'assistant',
        tool_calls: [{ id: 'x', function: { name: 'list_files', arguments: '{}' } }],
      },
    }],
  });
  const result = await runAgentTask({ task: 'loop forever', projectRoot, router, callFn: mockCall });
  assert.equal(result.status, 'incomplete');
});

// ---------------------------------------------------------------------------
// Reproduces the exact originally-reported bug: the PROVIDER (not a lenient
// pass-through) rejects the turn with a 400 because the model asked for an
// undeclared tool ("repo_browser.print_tree" / "not in request.tools"). This
// never reaches executeTool() at all — it has to be caught at the router/
// agent-loop level. Expect a corrective retry, then success once the model
// behaves.
test('agent loop recovers from a genuine provider-side tool-contract 400 (the originally reported bug)', async () => {
  const projectRoot = tmpDir('agent-loop-');
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);

  let call = 0;
  const mockCall = async () => {
    call++;
    if (call === 1) {
      const err = new Error(
        `Provider mock returned HTTP 400: {"error":{"message":"Tool call validation failed: tool call validation failed: attempted to call tool 'repo_browser.print_tree' which was not in request.tools","type":"invalid_request_error","code":"tool_use_failed"}}`
      );
      err.status = 400;
      err.isToolContractViolation = true;
      throw err;
    }
    return { choices: [{ message: { role: 'assistant', content: 'Recovered after correction.' } }] };
  };

  const result = await runAgentTask({ task: 'inspect the repo', projectRoot, router, callFn: mockCall });
  assert.equal(result.status, 'completed');
  assert.equal(result.summary, 'Recovered after correction.');
  assert.equal(call, 2, 'expected exactly one corrective retry before the model behaved');
});

test('agent loop gives up gracefully (not "all providers failed") when a model keeps hallucinating tools', async () => {
  const projectRoot = tmpDir('agent-loop-');
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);

  let call = 0;
  const mockCall = async () => {
    call++;
    const err = new Error(`attempted to call tool 'shell.run' which was not in request.tools`);
    err.status = 400;
    err.isToolContractViolation = true;
    throw err;
  };

  const result = await runAgentTask({ task: 'do something', projectRoot, router, callFn: mockCall });
  assert.equal(result.status, 'error');
  assert.match(result.summary, /repeatedly tried to call tools that don't exist/);
  assert.equal(call, 3, 'expected 1 initial attempt + 2 corrective retries, then stop (not an infinite loop)');
});

test('a genuine provider outage (500) still falls over to the next configured provider, unaffected by the tool-contract fix', async () => {
  const projectRoot = tmpDir('agent-loop-');
  const router = new ProviderRouter([
    { id: 'flaky', enabled: true, priority: 1 },
    { id: 'backup', enabled: true, priority: 2 },
  ]);
  const mockCall = async (entry) => {
    if (entry.id === 'flaky') {
      const err = new Error('Provider flaky returned HTTP 503');
      err.status = 503;
      throw err;
    }
    return { choices: [{ message: { role: 'assistant', content: 'Served by backup.' } }] };
  };
  const result = await runAgentTask({ task: 'x', projectRoot, router, callFn: mockCall });
  assert.equal(result.status, 'completed');
  assert.equal(result.summary, 'Served by backup.');
});

// ---------------------------------------------------------------------------
// Working-profile memory (src/profiles.js) — keyword-matched recall of past
// tasks. Deliberately simple (word overlap, not embeddings/vector search) —
// these tests check exactly that behavior, nothing fancier.

test('tokenize() lowercases, strips punctuation, and drops short/stopword tokens', () => {
  const words = tokenize('Fix the Login.js authentication bug and re-run tests!');
  assert.ok(words.includes('login'));
  assert.ok(words.includes('authentication'));
  assert.ok(words.includes('bug'));
  assert.ok(!words.includes('the'), 'stopword "the" should be dropped');
  assert.ok(!words.includes('and'), 'stopword "and" should be dropped');
  assert.ok(!words.includes('js'), 'fragments shorter than 4 chars should be dropped');
});

test('recordProfile() writes a profile entry to memory under the "agent" category with a "profile:" key', () => {
  const dataDir = tmpDir('profiles-record-');
  const memory = new MemoryStore(dataDir);
  const id = recordProfile(memory, {
    task: 'Fix the failing authentication test',
    status: 'completed',
    summary: 'Patched a null check in auth.js; tests now pass.',
    filesChanged: ['auth.js'],
    provider: 'groq-1',
    model: 'llama-3.3-70b-versatile',
  });
  assert.match(id, /^profile:/);
  const stored = memory.get('agent', id);
  assert.equal(stored.status, 'completed');
  assert.equal(stored.provider, 'groq-1');
  assert.deepEqual(stored.filesChanged, ['auth.js']);
  assert.ok(stored.keywords.includes('authentication'));
  assert.ok(stored.ts, 'expected a timestamp to be recorded');
});

test('recallProfiles() only returns profiles that actually share keywords with the new task, ranked by overlap', () => {
  const dataDir = tmpDir('profiles-recall-');
  const memory = new MemoryStore(dataDir);
  recordProfile(memory, {
    task: 'Fix the failing authentication login test',
    status: 'completed',
    summary: 'Fixed auth.',
    filesChanged: ['auth.js'],
    provider: 'p1',
    model: 'm1',
  });
  recordProfile(memory, {
    task: 'Refactor the database migration scripts',
    status: 'completed',
    summary: 'Refactored migrations.',
    filesChanged: ['migrate.js'],
    provider: 'p1',
    model: 'm1',
  });

  const matches = recallProfiles(memory, 'Add a new login authentication flow');
  assert.equal(matches.length, 1, 'only the authentication profile shares keywords with this task');
  assert.equal(matches[0].summary, 'Fixed auth.');

  const noMatches = recallProfiles(memory, 'Completely unrelated topic about pizza toppings');
  assert.equal(noMatches.length, 0, 'no stored profile shares keywords, so nothing should be forced in');
});

test('recallProfiles() respects the limit and ranks higher word-overlap first', () => {
  const dataDir = tmpDir('profiles-limit-');
  const memory = new MemoryStore(dataDir);
  recordProfile(memory, { task: 'fix login bug in authentication module', status: 'completed', summary: 'a', filesChanged: [], provider: null, model: null });
  recordProfile(memory, { task: 'fix login authentication session bug', status: 'completed', summary: 'b', filesChanged: [], provider: null, model: null });
  recordProfile(memory, { task: 'unrelated database indexing task', status: 'completed', summary: 'c', filesChanged: [], provider: null, model: null });

  const matches = recallProfiles(memory, 'fix login authentication session bug again', 1);
  assert.equal(matches.length, 1, 'limit=1 should cap the results');
  assert.equal(matches[0].summary, 'b', 'the profile with more shared keywords should rank first');
});

test('profilesToSystemMessage() returns null for no matches and a labeled system message otherwise', () => {
  assert.equal(profilesToSystemMessage([]), null);
  assert.equal(profilesToSystemMessage(null), null);
  const msg = profilesToSystemMessage([
    { status: 'completed', task: 'fix auth bug', filesChanged: ['auth.js'], summary: 'Patched auth.' },
  ]);
  assert.equal(msg.role, 'system');
  assert.match(msg.content, /Working-profile memory/);
  assert.match(msg.content, /keyword-matched/i, 'must be honest about the matching method, not claim semantic search');
  assert.match(msg.content, /auth\.js/);
});

test('runAgentTask() records a working profile after completing, and a later similar task recalls it', async () => {
  const projectRoot = tmpDir('agent-loop-profiles-');
  const dataDir = tmpDir('agent-loop-profiles-mem-');
  const memory = new MemoryStore(dataDir);
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);

  const firstCall = async () => ({
    choices: [{ message: { role: 'assistant', content: 'Fixed the login authentication bug in auth.js.' } }],
  });
  const first = await runAgentTask({ task: 'fix the login authentication bug', projectRoot, router, callFn: firstCall, memory });
  assert.equal(first.status, 'completed');

  const stored = Object.entries(memory.getAll('agent')).filter(([k]) => k.startsWith('profile:'));
  assert.equal(stored.length, 1, 'expected exactly one profile to be recorded');
  assert.equal(stored[0][1].task, 'fix the login authentication bug');
  assert.equal(stored[0][1].provider, 'mock');

  // Second, similar task: the recalled profile should be injected as a system
  // message BEFORE the model is called, so capture what the agent loop sent.
  let seenMessages;
  const secondCall = async (_entry, { messages }) => {
    seenMessages = messages;
    return { choices: [{ message: { role: 'assistant', content: 'Done.' } }] };
  };
  await runAgentTask({ task: 'add a new login authentication flow', projectRoot, router, callFn: secondCall, memory });
  const recallMsg = seenMessages.find((m) => m.role === 'system' && /Working-profile memory/.test(m.content));
  assert.ok(recallMsg, 'expected the second, similar task to recall the first profile as a system message');
  assert.match(recallMsg.content, /login authentication bug/);
});

test('runAgentTask() works exactly as before when no memory is passed (feature is fully optional)', async () => {
  const projectRoot = tmpDir('agent-loop-no-memory-');
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);
  const mockCall = async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  const result = await runAgentTask({ task: 'no memory passed here', projectRoot, router, callFn: mockCall });
  assert.equal(result.status, 'completed');
});

// ---------------------------------------------------------------------------
// GET /api/memory/profiles — real HTTP request against a real, running
// instance of server.js (not just calling the module functions directly).

test('GET /api/memory/profiles returns recalled matches for ?task=... and all profiles with no query', async () => {
  const dataDir = tmpDir('server-profiles-');
  const prevDataDir = process.env.AGENT_DATA_DIR;
  const prevPort = process.env.PORT;
  process.env.AGENT_DATA_DIR = dataDir;
  process.env.PORT = '0'; // OS-assigned free port
  delete require.cache[require.resolve('../server')];
  const { server, memory: serverMemory } = require('../server');

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  recordProfile(serverMemory, {
    task: 'fix the login authentication bug',
    status: 'completed',
    summary: 'Patched auth.js.',
    filesChanged: ['auth.js'],
    provider: 'mock',
    model: 'mock-model',
  });

  try {
    const withTask = await fetch(`http://127.0.0.1:${port}/api/memory/profiles?task=${encodeURIComponent('add login authentication')}`);
    assert.equal(withTask.status, 200);
    const withTaskBody = await withTask.json();
    assert.equal(withTaskBody.matches.length, 1);
    assert.equal(withTaskBody.matches[0].summary, 'Patched auth.js.');

    const noTask = await fetch(`http://127.0.0.1:${port}/api/memory/profiles`);
    assert.equal(noTask.status, 200);
    const noTaskBody = await noTask.json();
    assert.equal(noTaskBody.profiles.length, 1);
    assert.match(noTaskBody.profiles[0].key, /^profile:/);

    const irrelevant = await fetch(`http://127.0.0.1:${port}/api/memory/profiles?task=${encodeURIComponent('pizza toppings')}`);
    const irrelevantBody = await irrelevant.json();
    assert.equal(irrelevantBody.matches.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (prevDataDir === undefined) delete process.env.AGENT_DATA_DIR;
    else process.env.AGENT_DATA_DIR = prevDataDir;
    if (prevPort === undefined) delete process.env.PORT;
    else process.env.PORT = prevPort;
  }
});
