'use strict';
// Real-world E2E (§46-47): controlled temporary projects — Node + Git +
// Python — with intentional bugs, real test runners, real file edits,
// checkpoints/rollback, provider failure chains, cancellation, retry, skills,
// and a multi-agent team run. The user's real project is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const { runDebugLoop } = require('../src/debug-loop');
const { runTeam } = require('../src/orchestrator');
const { ProviderRouter } = require('../src/providers');
const { ApprovalStore } = require('../src/approvals');
const { CheckpointStore } = require('../src/checkpoints');
const { KnowledgeStore } = require('../src/knowledge');
const { SettingsStore } = require('../src/settings');
const { evaluate } = require('../src/evaluator');
const { runTests } = require('../src/test-intel');
const { analyzeProject, invalidateProjectCache } = require('../src/project-intel');
const { availableSkills, matchSkills } = require('../src/skills');
const git = require('../src/git');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/**
 * A REAL buggy Node project: calculator's `add` returns a+b-1. The test
 * suite genuinely fails until the bug is fixed. The mock model fixes code
 * THROUGH THE TOOLS (edit_file + run_tests), like a real agent.
 */
function makeBuggyNodeProject({ withSkill = false } = {}) {
  const root = tmpDir('e2e-node-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'e2e@test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: root });
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'calc-e2e', scripts: { test: 'node --test' } }));
  write(path.join(root, 'lib', 'calc.js'), 'function add(a, b) {\n  return a + b - 1; // BUG\n}\nmodule.exports = { add };\n');
  write(path.join(root, 'test', 'calc.test.js'),
    "const test = require('node:test');\nconst assert = require('node:assert');\n" +
    "const { add } = require('../lib/calc');\n" +
    "test('adds numbers', () => { assert.equal(add(2, 3), 5); });\n");
  if (withSkill) {
    write(path.join(root, 'skills', 'calc', 'skill.md'),
      '---\nname: calc-conventions\ndescription: project math conventions\napplicability: calc, add, math\n---\nKeep math functions pure and exported from lib/calc.js.');
  }
  invalidateProjectCache(root);
  return root;
}

/** Mock model that investigates, then fixes through real tools. */
function fixingMockModel() {
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);
  let fixStep = 0;
  let fixCalls = 0;
  const callFn = async (_entry, { messages }) => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const prompt = lastUser ? lastUser.content : '';
    if (/Investigate \(read-only\)/.test(prompt)) {
      return ok('Observed: lib/calc.js add() returns a+b-1. Root cause: stray "-1". Plan: remove it.');
    }
    if (/^Task:/.test(prompt)) { fixCalls++; fixStep = 0; }
    fixStep++;
    if (fixStep === 1) {
      return toolCall('edit_file', { path: 'lib/calc.js', oldText: 'return a + b - 1; // BUG', newText: 'return a + b;' });
    }
    if (fixStep === 2) {
      return toolCall('run_tests', {});
    }
    return ok('Removed the stray -1 in add(); verified with the test suite.');
  };
  return { router, callFn, getFixCalls: () => fixCalls };
}

function toolCall(name, args) {
  return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: `t-${Math.random().toString(36).slice(2, 8)}`, function: { name, arguments: JSON.stringify(args) } }] } }] };
}
function ok(content) {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

// --- E2E 1: full autonomous fix with evaluator + checkpoint + knowledge ----------

test('E2E: autonomous debug fixes a real bug, evaluator VERIFIED, checkpoint + knowledge recorded', async () => {
  const root = makeBuggyNodeProject({ withSkill: true });
  const dataDir = tmpDir('e2e-node-data-');
  const { router, callFn } = fixingMockModel();
  const checkpoints = new CheckpointStore(dataDir);
  const knowledge = new KnowledgeStore(dataDir);
  const settings = new SettingsStore(dataDir);

  // Baseline: the suite genuinely fails before the fix.
  const before = await runTests(root);
  assert.equal(before.ok, false, 'intentional bug makes the real suite fail');
  assert.ok(before.totals.failed >= 1);

  const events = [];
  const { matchSkills } = require('../src/skills');
  const result = await runDebugLoop({
    task: 'Fix the calculator: add(2,3) returns 4 instead of 5',
    projectRoot: root,
    router,
    callFn,
    safetyMode: 'autonomous',
    approvals: new ApprovalStore(dataDir),
    checkpoints,
    knowledge,
    settings,
    skills: matchSkills(root, 'Fix the calculator add bug'),
    maxAttempts: 3,
    onActivity: (e) => events.push(e),
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.report.result, 'PASS');
  assert.ok(result.filesChanged.includes(path.join('lib', 'calc.js')));

  // Evidence-based verification (independent evaluator):
  assert.ok(result.report.evaluation, 'evaluator ran');
  assert.equal(result.report.evaluation.verdict, 'VERIFIED');
  assert.match(result.report.evaluation.reason, /tests pass/);

  // Checkpoint was captured before autonomous edits:
  assert.ok(result.report.checkpointId, 'checkpoint id in report');
  assert.ok(checkpoints.list(root).some((c) => c.id === result.report.checkpointId));

  // Skills engine matched the project skill:
  assert.ok(events.some((e) => /calc-conventions/.test(e.message)), 'relevant skill loaded');

  // Knowledge base recorded the episode:
  const episodes = knowledge.list(root);
  assert.ok(episodes.length >= 1);
  assert.equal(episodes[0].finalResult, 'success');

  // Final regression: the suite now passes for real.
  const after = await runTests(root);
  assert.equal(after.ok, true);
});

// --- E2E 2: rollback via checkpoint restore --------------------------------------

test('E2E: checkpoint restore rolls autonomous changes back safely', async () => {
  const root = makeBuggyNodeProject();
  const dataDir = tmpDir('e2e-rollback-data-');
  const { router, callFn } = fixingMockModel();
  const checkpoints = new CheckpointStore(dataDir);

  await runDebugLoop({
    task: 'Fix the calculator add bug',
    projectRoot: root,
    router,
    callFn,
    safetyMode: 'autonomous',
    checkpoints,
    settings: new SettingsStore(dataDir),
  });
  assert.match(fs.readFileSync(path.join(root, 'lib', 'calc.js'), 'utf8'), /return a \+ b;/, 'fix applied');

  // Roll the fix back through the checkpoint.
  const ck = checkpoints.list(root)[0];
  const restore = checkpoints.restore(root, ck.id);
  assert.ok(restore.results.some((r) => r.action === 'restored'));
  assert.match(fs.readFileSync(path.join(root, 'lib', 'calc.js'), 'utf8'), /return a \+ b - 1; \/\/ BUG/, 'rollback restored the buggy original');

  // And the suite fails again — evidence the rollback is real.
  const afterRollback = await runTests(root);
  assert.equal(afterRollback.ok, false);
});

// --- E2E 3: git project — commit proposal approval + revert -----------------------

test('E2E: git workflow — dirty set, approval-gated commit, revert restores state', async () => {
  const root = tmpDir('e2e-git-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'e2e@test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: root });
  write(path.join(root, 'feature.txt'), 'v1\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: root });

  // Checkpoint the CLEAN state BEFORE the (agent-style) edit:
  const checkpoints = new CheckpointStore(tmpDir('e2e-git-ckpt-'));
  const ck = checkpoints.create(root, { include: ['feature.txt'] });
  assert.equal(ck.files.length, 1);

  write(path.join(root, 'feature.txt'), 'v2 — agent edited this\n');
  const summary = await git.changeSummary(root);
  assert.equal(summary.totalChanges, 1);

  // Commit goes through the approval system as a command proposal.
  const approvals = new ApprovalStore(tmpDir('e2e-git-store-'));
  const proposal = approvals.propose({
    type: 'command', projectRoot: root,
    command: 'git add "feature.txt" && git commit -m "update feature"',
    risk: { level: 'high', reason: 'creates a commit' },
  });
  await approvals.decide(proposal.id, 'approved');
  const log = await git.log(root);
  assert.equal(log.commits[0].subject, 'update feature');

  // Roll the file back to the checkpointed state.
  const restore = checkpoints.restore(root, ck.id);
  assert.ok(restore.results.some((r) => r.action === 'restored'));
  assert.equal(fs.readFileSync(path.join(root, 'feature.txt'), 'utf8'), 'v1\n');
});

// --- E2E 4: provider failure chains — key pool fallback + honest BLOCKED ----------

test('E2E: provider failure chain — key fallback works, total failure is honestly BLOCKED', async () => {
  // Chain: provider A (2 keys: dead, alive). Key 1 fails → key 2 serves.
  // Fallback stops at the first success, so provider B is never needed.
  let deadCalls = 0;
  const router = new ProviderRouter([
    { id: 'provA', name: 'A', enabled: true, priority: 1, keys: ['dead-key', 'alive-key'] },
    { id: 'provB', name: 'B', enabled: true, priority: 2, apiKey: 'b' },
  ]);
  const result = await router.chat({ messages: [] }, async (entry) => {
    if (entry.apiKey === 'dead-key') {
      deadCalls++;
      const err = new Error('down');
      err.status = 503;
      throw err;
    }
    return ok('served by A key2');
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'provA#key2');
  assert.equal(deadCalls, 1, 'exactly the dead key was attempted before fallback');

  // Everything fails (all keys of A, then B) → honest all_providers_failed
  // (surfaced as BLOCKED by the loop/evaluator — never a fake success).
  const allDead = new ProviderRouter([
    { id: 'provA', enabled: true, priority: 1, keys: ['dead-1', 'dead-2'] },
    { id: 'provB', enabled: true, priority: 2, apiKey: 'b' },
  ]);
  let attempts = 0;
  const doomed = await allDead.chat({ messages: [] }, async () => {
    attempts++;
    const err = new Error('down');
    err.status = 503;
    throw err;
  });
  assert.equal(doomed.ok, false);
  assert.equal(doomed.error, 'all_providers_failed');
  assert.equal(attempts, 3, 'all keys of A tried, then B, then stopped (bounded)');
  const evaluation = await evaluate({ task: 't', projectRoot: os.tmpdir(), result: { status: 'error', summary: 'all providers failed' } });
  assert.equal(evaluation.verdict, 'BLOCKED');
});

// --- E2E 5: Python project — real analysis (+ pytest run when installed) ----------

test('E2E: real Python project — detection, skills fit, tests run if pytest exists', async () => {
  const root = tmpDir('e2e-py-');
  write(path.join(root, 'requirements.txt'), 'pytest==8.0.0\n');
  write(path.join(root, 'calc.py'), 'def add(a, b):\n    return a + b\n');
  write(path.join(root, 'test_calc.py'), 'from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n');
  invalidateProjectCache(root);

  const map = analyzeProject(root);
  assert.equal(map.projectType, 'Python web app' === map.projectType ? map.projectType : 'Python');
  assert.ok(map.commands.test.some((c) => c.includes('pytest')));

  // Python skills matching against the real map.
  write(path.join(root, 'skills', 'py', 'skill.md'),
    '---\nname: python-style\napplicability: python, pytest\n---\nUse type hints.');
  const matched = matchSkills(root, 'improve the pytest suite', { map });
  assert.ok(matched.some((m) => m.name === 'python-style'));

  const pytestProbe = await new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('pytest', ['--version'], { timeout: 10000 }, (err) => resolve(!err));
  });
  if (!pytestProbe) {
    return test.skip('pytest is not installed on this machine — detection-only E2E (honest skip)');
  }
  const result = await runTests(root);
  assert.equal(result.ok, true, 'real pytest run passes');
  assert.equal(result.parsedFormat, 'pytest');
});

// --- E2E 6: cancellation + retry through the real task lifecycle ------------------

test('E2E: cancellation stops a run cooperatively; retry creates a fresh task', async () => {
  const root = tmpDir('e2e-cancel-');
  write(path.join(root, 'f.txt'), 'x');
  const { TaskStore } = require('../src/tasks');
  const dataDir = tmpDir('e2e-cancel-data-');
  const tasks = new TaskStore(dataDir);
  const record = tasks.create({ title: 'long loop', project: 'e2e', mode: 'code' });

  const { runAgentTask } = require('../src/agent-loop');
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);
  let polls = 0;
  const result = await runAgentTask({
    task: 'loop listing files',
    projectRoot: root,
    router,
    mode: 'code',
    taskId: record.id,
    shouldCancel: () => ++polls > 2,
    callFn: async () => toolCall('list_files', {}),
  });
  assert.equal(result.status, 'cancelled');
  tasks.complete(record.id, { status: 'cancelled', summary: 'cancelled by user' });

  const retried = tasks.retry(record.id);
  assert.notEqual(retried.id, record.id);
  assert.equal(retried.status, 'running');
  assert.equal(tasks.get(record.id).status, 'cancelled');
});

// --- E2E 7: multi-agent team on a real project -------------------------------------

test('E2E: multi-agent team — parallel coding + testing agents, integration verdict', async () => {
  const root = makeBuggyNodeProject();
  const dataDir = tmpDir('e2e-team-data-');
  // Pre-fix the bug so integration tests can pass after the coding agent works.
  write(path.join(root, 'lib', 'calc.js'), 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n');
  write(path.join(root, 'lib', 'extra.js'), 'module.exports = {};\n');

  const { SettingsStore: S } = require('../src/settings');
  const settings = new S(dataDir);
  settings.update({ maxAgents: 3, maxParallel: 2 });

  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);
  let childCounter = 0;
  const stepByTitle = new Map();
  const callFn = async (_e, { messages }) => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const title = lastUser ? lastUser.content : '';
    const step = (stepByTitle.get(title) || 0) + 1;
    stepByTitle.set(title, step);
    if (/agent A/.test(title) && step === 1) {
      return toolCall('write_file', { path: 'lib/feature-a.js', content: 'module.exports.a = 1;\n' });
    }
    if (/agent B/.test(title) && step === 1) {
      return toolCall('write_file', { path: 'lib/feature-b.js', content: 'module.exports.b = 2;\n' });
    }
    return ok('done');
  };

  const result = await runTeam({
    tasks: [
      { title: 'agent A: build feature a', mode: 'code' },
      { title: 'agent B: build feature b', mode: 'code' },
    ],
    projectRoot: root,
    router,
    settings,
    safetyMode: 'autonomous',
    callFn,
    createChildTask: (title, mode, role) => ({ id: `child-${++childCounter}`, title, mode, role }),
    completeChildTask: () => {},
  });

  assert.equal(result.team.length, 2);
  assert.ok(fs.existsSync(path.join(root, 'lib', 'feature-a.js')), 'agent A really wrote its file');
  assert.ok(fs.existsSync(path.join(root, 'lib', 'feature-b.js')), 'agent B really wrote its file');
  assert.deepEqual(result.conflicts, [], 'disjoint file ownership → no conflicts');
  assert.ok(result.integrationTests, 'integration test run over combined changes');
  assert.equal(result.integrationTests.ok, true);
  assert.equal(result.report.result, 'VERIFIED', 'real integration suite passes over both agents\' work');
});
