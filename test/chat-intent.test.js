'use strict';
// PART A regression tests — the reported chat bug:
//   "Analyze this project and give me a report" → Groq HTTP 400
//   code: output_parse_failed ("Parsing failed. The model generated output
//   that could not be parsed") → wrongly collapsed into all_providers_failed.
//
// Fix under test: intent routing (chat = no tool schemas at all) + bounded
// parse-failure recovery (retry without tools → corrective plain-text retry →
// provider fallback) + actionable final errors.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { classifyIntent } = require('../src/intent');
const { runAgentTask } = require('../src/agent-loop');
const { ProviderRouter } = require('../src/providers');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
const ok = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });

function parseFailureError() {
  const err = new Error(
    'Provider groq returned HTTP 400: {"error":{"message":"Parsing failed. The model generated output that could not be parsed. Please adjust your prompt.","code":"output_parse_failed","failed_generation":"Search for .test."}}'
  );
  err.status = 400;
  err.outputParseFailed = true;
  return err;
}

// --- classifier ---------------------------------------------------------------

test('intent: the exact reported request classifies as plain chat', () => {
  const { intent, reason } = classifyIntent('Analyze this project and give me a report.');
  assert.equal(intent, 'chat');
  assert.match(reason, /conversational|smallest/);
});

test('intent: the spec examples classify correctly', () => {
  assert.equal(classifyIntent('Analyze the project and inspect the package.json and test files.').intent, 'tool-chat');
  assert.equal(classifyIntent('Fix the failing authentication tests and verify the fix.').intent, 'task');
  assert.equal(classifyIntent('what does the server do?').intent, 'chat');
  assert.equal(classifyIntent('run the tests and show me the results').intent, 'tool-chat');
  assert.equal(classifyIntent('refactor the auth module and update its tests').intent, 'task');
});

// --- normal chat: NO tools sent at all -----------------------------------------

test('chat intent: plain completion path, zero tool schemas, no tool loop', async () => {
  const root = tmpDir('chat-plain-');
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);
  let sawTools = null;
  let calls = 0;
  const result = await runAgentTask({
    task: 'Analyze this project and give me a report.',
    projectRoot: root,
    router,
    intent: 'chat',
    callFn: async (_e, { tools }) => {
      calls++;
      sawTools = tools;
      return ok('Project report: a zero-dependency Node workstation.');
    },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(sawTools, [], 'normal chat sends no tool schemas');
  assert.equal(calls, 1, 'single provider request — no tool loop');
});

// --- parse-failure recovery ------------------------------------------------------

test('parse recovery: tool-assisted request failing with output_parse_failed retries WITHOUT tools and succeeds', async () => {
  const root = tmpDir('chat-recover-');
  const router = new ProviderRouter([{ id: 'groq-like', enabled: true, priority: 1 }]);
  const attempts = [];
  const result = await runAgentTask({
    task: 'inspect package.json and summarize it',
    projectRoot: root,
    router,
    intent: 'tool-chat',
    callFn: async (_e, { tools }) => {
      attempts.push({ tools: tools.map((t) => t.function.name) });
      if (attempts.length === 1) throw parseFailureError(); // tools declared → provider parse failure
      return ok('package.json declares the workstation scripts.');
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0].tools.length > 0, 'first attempt had tools');
  assert.deepEqual(attempts[1].tools, [], 'recovery retried as plain chat without tool schemas');
});

test('parse recovery: bounded — two recovery attempts then an actionable error (never all_providers_failed)', async () => {
  const root = tmpDir('chat-exhaust-');
  const router = new ProviderRouter([{ id: 'groq-like', enabled: true, priority: 1 }]);
  let calls = 0;
  const result = await runAgentTask({
    task: 'inspect the project and report',
    projectRoot: root,
    router,
    intent: 'tool-chat',
    callFn: async () => {
      calls++;
      if (calls <= 2) throw parseFailureError();
      return ok('final');
    },
  });
  // calls: 1 (tools) → recovery 1 (no tools, parse fail) → recovery 2 (plain-text reminder) → success
  assert.equal(result.status, 'completed');
  assert.equal(calls, 3, 'bounded recovery: initial + 2 attempts');

  // Always-failing provider → actionable BLOCKED-style error, not all_providers_failed
  const router2 = new ProviderRouter([{ id: 'bad', enabled: true, priority: 1 }]);
  const hopeless = await runAgentTask({
    task: 'inspect the project and report',
    projectRoot: root,
    router: router2,
    intent: 'tool-chat',
    callFn: async () => { throw parseFailureError(); },
  });
  assert.equal(hopeless.status, 'error');
  assert.match(hopeless.summary, /output_parse_failed|parse/i);
  assert.ok(!hopeless.summary.includes('all_providers_failed'), 'the parse failure is named, not masked');
});

test('parse recovery: provider fallback works after a parse failure (no cooldown poisoning)', async () => {
  const root = tmpDir('chat-fallback-');
  const router = new ProviderRouter([
    { id: 'parse-broken', enabled: true, priority: 1 },
    { id: 'healthy', enabled: true, priority: 2 },
  ]);
  const servedBy = [];
  const result = await runAgentTask({
    task: 'inspect package.json and report',
    projectRoot: root,
    router,
    intent: 'tool-chat',
    callFn: async (entry, { tools }) => {
      servedBy.push(entry.id);
      if (entry.id === 'parse-broken') throw parseFailureError();
      assert.equal(tools.length > 0, true, 'healthy provider still gets tools for a tool-chat request');
      return ok('served by the healthy provider');
    },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(servedBy, ['parse-broken', 'healthy'], 'fell over to the next provider after the parse failure');
  // And the broken provider is NOT poisoned into cooldown (parse failures are not health issues):
  const snap = router.snapshot().find((s) => s.id === 'parse-broken');
  assert.equal(snap.inCooldown, false);
});

test('413 protection still works alongside the new recovery (no regression)', async () => {
  const root = tmpDir('chat-413-');
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);
  let calls = 0;
  const result = await runAgentTask({
    task: 'read the big file',
    projectRoot: root,
    router,
    maxPayloadChars: 60000,
    callFn: async (_e, { messages }) => {
      calls++;
      if (calls === 1) {
        const err = new Error('HTTP 413: Request too large ... Limit 8000, Requested 8007');
        err.status = 413;
        err.requestTooLarge = true;
        err.sizeLimit = 8000;
        err.sizeRequested = 8007;
        throw err;
      }
      return ok('served after compaction');
    },
  });
  assert.equal(result.status, 'completed', '413 compaction-recovery is intact');
});
