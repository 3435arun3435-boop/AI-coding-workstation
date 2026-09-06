'use strict';
// Phase 5 — Test Intelligence: detection, real execution against fixture
// projects, output parsing for the major runners, history, and failure/change
// association.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectTests, runTests, parseTestOutput, associateFailures, TestHistoryStore } = require('../src/test-intel');
const { executeTool } = require('../src/agent-tools');
const { analyzeProject, invalidateProjectCache } = require('../src/project-intel');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeNodeTestProject({ failing = false } = {}) {
  const root = tmpDir('ti-node-');
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'ti-sample',
    scripts: { test: 'node --test' },
  }));
  fs.writeFileSync(path.join(root, 'test', 'a.test.js'), `
    const test = require('node:test');
    const assert = require('node:assert');
    test('passing math', () => { assert.equal(1 + 1, 2); });
  `);
  fs.writeFileSync(path.join(root, 'test', 'b.test.js'), `
    const test = require('node:test');
    const assert = require('node:assert');
    test('failing check', () => { assert.equal(1, ${failing ? '2' : '1'}); });
  `);
  invalidateProjectCache(root);
  return root;
}

// --- detection ---------------------------------------------------------------

test('detectTests finds the node:test setup and full command', () => {
  const root = makeNodeTestProject();
  const d = detectTests(root);
  assert.equal(d.framework, 'node:test');
  assert.equal(d.fullCommand, 'npm test');
  assert.equal(d.hasTests, true);
  assert.ok(d.testFiles.some((f) => f.includes('a.test.js')));
  assert.equal(d.targetTemplate, 'node --test {file}');
});

test('detectTests reports honestly when a project has no tests', () => {
  const root = tmpDir('ti-none-');
  const d = detectTests(root);
  assert.equal(d.hasTests, false);
  assert.equal(d.fullCommand, null);
});

test('targetCommandTemplate maps frameworks to targeted runners', () => {
  assert.equal(require('../src/test-intel').targetCommandTemplate('pytest', 'Python'), 'pytest {file}');
  assert.equal(require('../src/test-intel').targetCommandTemplate('Jest', 'JavaScript'), 'npx jest {file}');
  assert.equal(require('../src/test-intel').targetCommandTemplate('node:test', 'JavaScript'), 'node --test {file}');
});

// --- real runs ---------------------------------------------------------------

test('runTests executes a passing node:test suite and parses TAP totals', async () => {
  const root = makeNodeTestProject();
  const result = await runTests(root);
  assert.equal(result.ok, true);
  assert.equal(result.parsedFormat, 'tap');
  assert.equal(result.totals.failed, 0);
  assert.ok(result.totals.passed >= 2);
  assert.deepEqual(result.failures, []);
});

test('runTests reports structured failures for a failing suite', async () => {
  const root = makeNodeTestProject({ failing: true });
  const result = await runTests(root);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode !== 0, true);
  assert.ok(result.totals.failed >= 1);
  assert.ok(result.failures.length >= 1);
  assert.match(result.failures[0].name, /failing check/);
  assert.ok(result.rawTail.length > 0, 'raw output tail is kept for inspection');
});

test('runTests supports targeted single-file runs', async () => {
  const root = makeNodeTestProject();
  const result = await runTests(root, { target: path.join('test', 'a.test.js') });
  assert.equal(result.ok, true);
  assert.equal(result.totals.passed, 1);
});

test('runTests returns a clear error when no test command exists', async () => {
  const root = tmpDir('ti-empty-');
  const result = await runTests(root);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_test_command');
});

// --- parsing (pure) ----------------------------------------------------------

test('parseTestOutput parses node:test TAP with failure names and messages', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: good test',
    'ok 1 - good test',
    '# Subtest: bad test',
    'not ok 2 - bad test',
    '  ---',
    '  error: |',
    '    expected 1 to be 2',
    '  code: ERR_ASSERTION',
    '  ...',
    '# tests 2',
    '# pass 1',
    '# fail 1',
    '# skipped 0',
  ].join('\n');
  const parsed = parseTestOutput(tap, 1);
  assert.equal(parsed.format, 'tap');
  assert.deepEqual(parsed.totals, { total: 2, passed: 1, failed: 1, skipped: 0 });
  assert.equal(parsed.failures.length, 1);
  assert.equal(parsed.failures[0].name, 'bad test');
  assert.match(parsed.failures[0].message, /expected 1 to be 2/);
});

test('parseTestOutput parses Jest summaries and failure blocks', () => {
  const out = [
    'FAIL src/app.test.js',
    '  ● calculator › adds numbers',
    '    expect(received).toBe(expected)',
    '',
    'Test Suites: 1 failed, 1 total',
    'Tests:       1 failed, 3 passed, 4 total',
  ].join('\n');
  const parsed = parseTestOutput(out, 1);
  assert.equal(parsed.format, 'jest');
  assert.deepEqual(parsed.totals, { total: 4, passed: 3, failed: 1, skipped: 0 });
  assert.ok(parsed.failures.length >= 1);
  assert.ok(parsed.failures.some((f) => /calculator/.test(f.name)));
});

test('parseTestOutput parses pytest summaries', () => {
  const out = [
    'tests/test_a.py F.',
    '=================================== FAILURES ===================================',
    '================================ short summary =================================',
    'FAILED tests/test_a.py::test_broken - assert 1 == 2',
    '========================= 1 failed, 2 passed in 0.05s =========================',
  ].join('\n');
  const parsed = parseTestOutput(out, 1);
  assert.equal(parsed.format, 'pytest');
  assert.deepEqual(parsed.totals, { total: 3, passed: 2, failed: 1, skipped: 0 });
  assert.equal(parsed.failures[0].file, 'tests/test_a.py');
  assert.match(parsed.failures[0].message, /assert 1 == 2/);
});

test('parseTestOutput parses go test failures', () => {
  const out = ['--- FAIL: TestDivide (0.00s)', '    math_test.go:12: divide by zero', 'FAIL', 'FAIL example.com/pkg 0.2s'].join('\n');
  const parsed = parseTestOutput(out, 1);
  assert.equal(parsed.format, 'go');
  assert.equal(parsed.totals.failed, 1);
  assert.equal(parsed.failures[0].name, 'TestDivide');
});

test('parseTestOutput is honest about unparsable output (generic)', () => {
  const parsed = parseTestOutput('some random build output\nno test markers here', 1);
  assert.equal(parsed.format, 'generic');
  assert.equal(parsed.totals.passed, null);
  assert.deepEqual(parsed.failures, []);
});

// --- association ---------------------------------------------------------------

test('associateFailures links failures to changed files by evidence', () => {
  const { failures, byChangedFile } = associateFailures(
    [
      { name: 'router test', file: 'src/router.js', message: 'health endpoint broken' },
      { name: 'unrelated', file: null, message: 'nothing here' },
    ],
    ['src/router.js', 'package.json']
  );
  assert.deepEqual(failures[0].related, ['src/router.js']);
  assert.deepEqual(failures[1].related, []);
  assert.equal(byChangedFile['src/router.js'], 1);
  assert.equal(byChangedFile['package.json'], undefined, 'no forced association without evidence');
});

// --- history -------------------------------------------------------------------

test('TestHistoryStore records, lists, and is bounded', () => {
  const store = new TestHistoryStore(tmpDir('ti-hist-'));
  for (let i = 0; i < 60; i++) {
    store.record({ ok: true, command: 'npm test', exitCode: 0, timedOut: false, durationMs: 10, totals: { total: 1, passed: 1, failed: 0, skipped: 0 }, failures: [], parsedFormat: 'tap', finishedAt: new Date().toISOString() });
  }
  assert.ok(store.list(100).length <= 50, 'history is bounded at 50 runs');
  assert.equal(store.list()[0].ok, true);
});

// --- tools ---------------------------------------------------------------------

test('run_tests tool executes and returns structured results', async () => {
  const root = makeNodeTestProject();
  const result = await executeTool('run_tests', '{}', { projectRoot: root });
  assert.equal(result.ok, true);
  assert.equal(result.result.parsedFormat, 'tap');
  assert.equal(result.result.totals.failed, 0);
});

test('run_tests tool rejects paths that escape the project', async () => {
  const root = makeNodeTestProject();
  const result = await executeTool('run_tests', { path: '../../etc/passwd' }, { projectRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'security_violation');
});

test('detect_tests tool is registered and reports the setup', async () => {
  const root = makeNodeTestProject();
  const result = await executeTool('detect_tests', '{}', { projectRoot: root });
  assert.equal(result.ok, true);
  assert.equal(result.result.framework, 'node:test');
});
