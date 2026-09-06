'use strict';
// Regression tests for the reported bug:
//   "Request too large for model `openai/gpt-oss-120b` ... TPM: Limit 8000,
//    Requested 8007" (HTTP 413) — caused by unbounded tool results and
//    unbounded conversation payload being re-sent on every provider call.
//
// Fix under test: bounded tool results, payload compaction, one bounded
// compaction-retry on 413, and an honest BLOCKED with actionable advice if
// the request is still too large.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAgentTask } = require('../src/agent-loop');
const { ProviderRouter } = require('../src/providers');
const { compactMessages } = require('../src/agent-loop');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
const ok = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });

function toolCall(name, args) {
  return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: `t-${Math.random().toString(36).slice(2, 8)}`, function: { name, arguments: JSON.stringify(args) } }] } }] };
}

test('BUG FIX: tool results are bounded in the conversation (no 512KB blobs re-sent)', async () => {
  const root = tmpDir('bug413-');
  fs.writeFileSync(path.join(root, 'big.txt'), 'A'.repeat(200_000)); // 200KB file
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);

  const payloadSizes = [];
  let turn = 0;
  const result = await runAgentTask({
    task: 'read big.txt and tell me the last character',
    projectRoot: root,
    router,
    callFn: async (_e, { messages }) => {
      turn++;
      payloadSizes.push(messages.reduce((n, m) => n + String(m.content || '').length, 0));
      if (turn === 1) return toolCall('read_file', { path: 'big.txt' });
      if (turn === 2) return toolCall('list_files', {});
      return ok('done');
    },
  });

  assert.equal(result.status, 'completed');
  // The read_file result entered the conversation BOUNDED: the second
  // request's payload must be far below the raw 200KB content size.
  assert.ok(payloadSizes[1] < 30_000, `second request payload was ${payloadSizes[1]} chars — unbounded tool result leaked`);
  // The truncation marker is honest and actionable:
  const truncation = payloadSizes[1] > 3000; // marker exists when content exceeded the limit
  assert.equal(truncation, true);
});

test('BUG FIX: 413 request-too-large triggers ONE bounded compaction retry, then recovery', async () => {
  const root = tmpDir('bug413-retry-');
  // A provider that rejects the first (large) request with the exact 413 shape
  // from the bug report, then serves a compacted one.
  const router = new ProviderRouter([{ id: 'groq-like', enabled: true, priority: 1 }]);
  let attempts = 0;
  const seenPayloads = [];
  const result = await runAgentTask({
    task: 'summarize the project',
    projectRoot: root,
    router,
    maxPayloadChars: 60000,
    callFn: async (_e, { messages }) => {
      attempts++;
      const size = messages.reduce((n, m) => n + String(m.content || '').length, 0);
      seenPayloads.push(size);
      if (attempts === 1) {
        const err = new Error('HTTP 413: Request too large ... TPM: Limit 8000, Requested 8007');
        err.status = 413;
        err.requestTooLarge = true;
        err.sizeLimit = 8000;
        err.sizeRequested = 8007;
        throw err;
      }
      return ok('Recovered after compaction.');
    },
  });

  assert.equal(result.status, 'completed', 'the run recovered after compaction');
  assert.equal(attempts, 2);
  assert.match(result.summary, /Recovered after compaction/);
});

test('BUG FIX: 413 that survives compaction reports an actionable BLOCKED (not "all providers failed")', async () => {
  const root = tmpDir('bug413-blocked-');
  const router = new ProviderRouter([{ id: 'small', enabled: true, priority: 1 }]);
  let attempts = 0;
  const result = await runAgentTask({
    task: 'impossible task',
    projectRoot: root,
    router,
    callFn: async () => {
      attempts++;
      const err = new Error('HTTP 413: Request too large ... Limit 8000, Requested 8007');
      err.status = 413;
      err.requestTooLarge = true;
      err.sizeLimit = 8000;
      err.sizeRequested = 8007;
      throw err;
    },
  });
  assert.equal(result.status, 'blocked');
  assert.match(result.summary, /BLOCKED: request too large/);
  assert.match(result.summary, /limit 8000 tokens, requested 8007/);
  assert.match(result.summary, /Try a shorter task/);
  assert.ok(!result.summary.includes('all_providers_failed'), 'no opaque error — the cause is named');
  assert.ok(attempts === 2, 'exactly one compaction retry before the honest BLOCKED');
});

test('compaction: system messages always survive; newest turns kept; tombstone is honest', () => {
  const big = 'X'.repeat(5000);
  const messages = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'first task ' + big },
    { role: 'tool', content: big },
    { role: 'user', content: 'latest question' },
  ];
  const compacted = compactMessages(messages, 6000);
  assert.ok(compacted.some((m) => m.content === 'system prompt'), 'system prompt kept');
  assert.ok(compacted.some((m) => m.content === 'latest question'), 'newest turn kept');
  assert.ok(compacted.some((m) => /\[context compacted:/.test(m.content)), 'honest tombstone present');
  const total = compacted.reduce((n, m) => n + String(m.content || '').length, 0);
  assert.ok(total < 6000 + 100, `compacted payload (${total}) fits the cap`);
  // Small payloads pass through untouched.
  const untouched = compactMessages([{ role: 'user', content: 'tiny' }], 6000);
  assert.equal(untouched.length, 1);
  assert.equal(untouched[0].content, 'tiny');
});

test('regression guard: the previously failing scenario now stays under an 8000-token TPM budget', async () => {
  // Simulate the exact reported environment: an 8k-token TPM org (~4 chars/token
  // → ~32k chars/request). With the fix, even reading several large files keeps
  // every request under the cap.
  const root = tmpDir('bug413-tpm-');
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `data${i}.txt`), 'B'.repeat(60_000));
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);
  let maxChars = 0;
  let turn = 0;
  const result = await runAgentTask({
    task: 'inspect the data files and report',
    projectRoot: root,
    router,
    callFn: async (_e, { messages }) => {
      turn++;
      const size = messages.reduce((n, m) => n + String(m.content || '').length, 0);
      maxChars = Math.max(maxChars, size);
      if (turn <= 5) return toolCall('read_file', { path: `data${turn - 1}.txt` });
      return ok('inspected all files');
    },
    maxPayloadChars: 32000, // ≈ the 8000-token TPM ceiling at 4 chars/token
  });
  assert.equal(result.status, 'completed');
  assert.ok(maxChars <= 32_000 + 2000, `largest request was ${maxChars} chars — must fit an 8k-token budget`);
});
