'use strict';
// Phase 8 — Autonomous Debug Loop, end to end with a REAL failing test in a
// REAL temp project and a scripted mock model: investigate → fix → test →
// verify → engineering report. Also: bounded attempts, cancellation, and
// honest BLOCKED reporting.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runDebugLoop } = require('../src/debug-loop');
const { ProviderRouter } = require('../src/providers');
const { ApprovalStore } = require('../src/approvals');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Fixture: a Node project whose calculator has a real bug (returns 0 for
 * add). Includes a REAL node:test suite that fails until the bug is fixed.
 */
function makeBuggyProject() {
  const root = tmpDir('debug-fixture-');
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'calc', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(root, 'lib', 'calc.js'), 'function add(a, b) {\n  return 0; // BUG: should be a + b\n}\nmodule.exports = { add };\n');
  fs.writeFileSync(path.join(root, 'test', 'calc.test.js'),
    "const test = require('node:test');\nconst assert = require('node:assert');\n" +
    "const { add } = require('../lib/calc');\n" +
    "test('adds numbers', () => { assert.equal(add(2, 3), 5); });\n");
  return root;
}

function mockModel({ fixOnAttempt, noToolFix = false }) {
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);
  let fixCalls = 0;
  let fixStep = 0;
  const seenPrompts = [];
  const callFn = async (_entry, { messages }) => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const prompt = lastUser ? lastUser.content : '';
    if (seenPrompts.length < 50) seenPrompts.push(prompt);

    if (/Investigate \(read-only\)/.test(prompt)) {
      return { choices: [{ message: { role: 'assistant', content: 'Observed: lib/calc.js add() returns 0 instead of a+b. Root cause: the addition was replaced by a literal 0. Plan: change `return 0;` to `return a + b;`.' } }] };
    }
    if (/^Task:/.test(prompt)) {
      fixCalls++;
      fixStep = 0;
    }
    fixStep++;

    // A "fix" that never touches anything (for bounded-attempts testing).
    if (noToolFix || fixCalls < fixOnAttempt) {
      return { choices: [{ message: { role: 'assistant', content: 'Checked the code but made no change.' } }] };
    }

    // Real fix flow, like a model would do it: edit_file → run_tests → report.
    if (fixStep === 1) {
      return {
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{ id: `e${fixCalls}`, function: { name: 'edit_file', arguments: JSON.stringify({ path: 'lib/calc.js', oldText: 'return 0;', newText: 'return a + b;' }) } }],
          },
        }],
      };
    }
    if (fixStep === 2) {
      return {
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{ id: `t${fixCalls}`, function: { name: 'run_tests', arguments: '{}' } }],
          },
        }],
      };
    }
    return { choices: [{ message: { role: 'assistant', content: 'Fixed add() to return a + b and verified with the test suite.' } }] };
  };
  return { router, callFn, getFixCalls: () => fixCalls, seenPrompts };
}

let fixProjectRoot = null;

test('debug loop fixes a real bug and reports PASS with evidence', async () => {
  fixProjectRoot = makeBuggyProject();
  const { router, callFn } = mockModel({ fixOnAttempt: 1 });

  const events = [];
  const result = await runDebugLoop({
    task: 'Fix the calculator: add(2,3) returns 0 instead of 5',
    projectRoot: fixProjectRoot,
    router,
    callFn,
    safetyMode: 'autonomous',
    maxAttempts: 3,
    onActivity: (e) => events.push(e),
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.report.result, 'PASS');
  assert.ok(result.report.rootCause.includes('calc'), 'root cause from the investigation is included');
  assert.ok(result.filesChanged.includes(path.join('lib', 'calc.js')));
  assert.ok(result.report.tests, 'report includes real test evidence');
  assert.equal(result.report.tests.ok, true);
  assert.equal(result.report.tests.totals.failed, 0);
  assert.ok(fs.readFileSync(path.join(fixProjectRoot, 'lib', 'calc.js'), 'utf8').includes('return a + b;'));
  // The loop really emitted the phase events:
  for (const state of ['UNDERSTAND', 'INSPECT', 'PLAN', 'FIX', 'TEST', 'COMPLETE']) {
    assert.ok(events.some((e) => e.state === state), `timeline should include ${state}`);
  }
});

test('debug loop is bounded: exhausting attempts yields FAILED with failure analysis, not an infinite loop', async () => {
  fixProjectRoot = makeBuggyProject();
  const { router, callFn, getFixCalls } = mockModel({ fixOnAttempt: 99, noToolFix: true }); // never fixes

  const result = await runDebugLoop({
    task: 'Fix the calculator add bug',
    projectRoot: fixProjectRoot,
    router,
    callFn,
    safetyMode: 'autonomous',
    maxAttempts: 2,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.report.result, 'FAILED');
  assert.ok(getFixCalls() <= 2, 'exactly maxAttempts fix attempts, no more');
  assert.ok(result.report.remainingIssues.length >= 1, 'remaining issues are reported');
  assert.ok(result.report.tests.ok === false, 'the failing evidence is real');
});

test('debug loop: fix attempt 2 receives the previous failures as analysis', async () => {
  fixProjectRoot = makeBuggyProject();
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);
  let fixCalls = 0;
  let fixStep = 0;
  const prompts = [];
  const callFn = async (_entry, { messages }) => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const prompt = lastUser ? lastUser.content : '';
    prompts.push(prompt);
    if (/Investigate \(read-only\)/.test(prompt)) {
      return { choices: [{ message: { role: 'assistant', content: 'Hypothesis: broken add in lib/calc.js.' } }] };
    }
    if (/^Task:/.test(prompt)) {
      fixCalls++;
      fixStep = 0;
    }
    fixStep++;

    if (fixCalls === 1) {
      // First attempt: honestly does nothing → tests still fail.
      return { choices: [{ message: { role: 'assistant', content: 'No change this attempt.' } }] };
    }
    // Second attempt: real fix via tools.
    if (fixStep === 1) {
      return {
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{ id: 'e2', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'lib/calc.js', oldText: 'return 0;', newText: 'return a + b;' }) } }],
          },
        }],
      };
    }
    if (fixStep === 2) {
      return {
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{ id: 't2', function: { name: 'run_tests', arguments: '{}' } }],
          },
        }],
      };
    }
    return { choices: [{ message: { role: 'assistant', content: 'Fixed and verified.' } }] };
  };

  const result = await runDebugLoop({
    task: 'Fix the calculator add bug',
    projectRoot: fixProjectRoot,
    router,
    callFn,
    safetyMode: 'autonomous',
    maxAttempts: 3,
  });

  assert.equal(result.status, 'completed');
  const secondFixPrompt = prompts.find((p) => /did NOT fully resolve/.test(p));
  assert.ok(secondFixPrompt, 'attempt 2+ includes the failure analysis context');
  assert.match(secondFixPrompt, /Totals:/);
  assert.match(secondFixPrompt, /adds numbers/, 'failing test name is included');
});

test('debug loop reports BLOCKED honestly when the provider fails', async () => {
  fixProjectRoot = makeBuggyProject();
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);
  const callFn = async () => {
    const err = new Error('all providers failed');
    err.status = 503;
    throw err;
  };
  const result = await runDebugLoop({
    task: 'Fix the calculator add bug',
    projectRoot: fixProjectRoot,
    router,
    callFn,
    safetyMode: 'autonomous',
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.report.result, 'BLOCKED');
  assert.deepEqual(result.filesChanged, []);
});

test('debug loop respects cancellation between attempts', async () => {
  fixProjectRoot = makeBuggyProject();
  const { router, callFn } = mockModel({ fixOnAttempt: 1 });
  let cancelled = false;
  const result = await runDebugLoop({
    task: 'Fix the calculator add bug',
    projectRoot: fixProjectRoot,
    router,
    callFn,
    safetyMode: 'autonomous',
    maxAttempts: 3,
    shouldCancel: () => cancelled,
  });
  // cancel was never set → completed normally
  assert.equal(result.status, 'completed');

  // Now a run cancelled before it starts.
  const result2 = await runDebugLoop({
    task: 'Fix the calculator add bug',
    projectRoot: makeBuggyProject(),
    router,
    callFn,
    safetyMode: 'autonomous',
    shouldCancel: () => true,
  });
  assert.equal(result2.status, 'cancelled');
});

test('debug loop works with the approval system (assist mode proposes the fix)', async () => {
  fixProjectRoot = makeBuggyProject();
  const { router, callFn } = mockModel({ fixOnAttempt: 1 });
  const approvals = new ApprovalStore(tmpDir('debug-approval-store-'));

  const runPromise = runDebugLoop({
    task: 'Fix the calculator add bug',
    projectRoot: fixProjectRoot,
    router,
    callFn,
    safetyMode: 'assist',
    approvals,
    maxAttempts: 3,
  });

  // Approve file proposals as they arrive (simulating the user).
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 30));
    const pending = approvals.list({ status: 'pending' });
    for (const p of pending) await approvals.decide(p.id, 'approved');
    const decided = approvals.list().filter((r) => r.status !== 'pending');
    if (decided.length > 0) {
      // Once the fix proposal was approved, we can stop the approval loop.
      if (decided.some((r) => r.path && r.path.includes('calc'))) break;
    }
  }
  // Approve anything still pending (test commands etc.)
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 30));
    const pending = approvals.list({ status: 'pending' });
    if (pending.length === 0) break;
    for (const p of pending) await approvals.decide(p.id, 'approved');
  }

  const result = await runPromise;
  assert.equal(result.status, 'completed');
  assert.ok(fs.readFileSync(path.join(fixProjectRoot, 'lib', 'calc.js'), 'utf8').includes('return a + b;'));
});
