'use strict';
/**
 * test-intel.js
 *
 * Test Intelligence: detects the project's testing setup, runs tests (full
 * suite or targeted), parses structured results out of real runner output
 * (node:test TAP, Jest/Vitest, pytest, go test — with an honest generic
 * fallback), maintains bounded run history, and associates failures with
 * recently changed files.
 *
 * Never fabricates: if output can't be parsed, the result says so and keeps
 * the raw tail for inspection.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { analyzeProject } = require('./project-intel');
const { sanitizedEnv } = require('./exec-env');

const MAX_COMMAND_MS = 120_000;
const RAW_TAIL_LINES = 40;
const HISTORY_LIMIT = 50;

// ---------------------------------------------------------------------------
// Detection

/**
 * Detect the testing setup for a project. Only reports what is actually
 * found. Returns { framework, testFiles, testDirectories, fullCommand,
 * targetFor(file) as targetTemplate, hasTests }.
 */
function detectTests(projectRoot, map) {
  const m = map || analyzeProject(projectRoot);
  const framework = m.testFramework || null;
  const testFiles = m.testFiles || [];
  const testDirectories = m.testDirectories || [];
  const pkgCommands = m.commands && m.commands.test ? m.commands.test : [];

  let fullCommand = pkgCommands[0] || null;
  if (!fullCommand) {
    if (framework === 'pytest') fullCommand = 'pytest';
    else if (framework === 'go test') fullCommand = 'go test ./...';
    else if (framework === 'cargo test') fullCommand = 'cargo test';
    else if (testFiles.length > 0 && (m.primaryLanguage === 'JavaScript' || m.primaryLanguage === 'TypeScript')) fullCommand = 'node --test';
  }

  const targetTemplate = targetCommandTemplate(framework, m.primaryLanguage);

  return {
    framework,
    testFiles,
    testDirectories,
    fullCommand,
    targetTemplate, // e.g. 'node --test {file}' | 'npx jest {file}' | 'pytest {file}'
    hasTests: testFiles.length > 0 || testDirectories.length > 0 || !!fullCommand,
  };
}

function targetCommandTemplate(framework, primaryLanguage) {
  if (framework === 'pytest') return 'pytest {file}';
  if (framework === 'go test') return 'go test {file}';
  if (framework === 'Jest') return 'npx jest {file}';
  if (framework === 'Vitest') return 'npx vitest run {file}';
  if (framework === 'Mocha') return 'npx mocha {file}';
  if (framework === 'node:test' || framework === 'package.json test script' || (primaryLanguage === 'JavaScript' && framework && framework.startsWith('unknown'))) {
    return 'node --test {file}';
  }
  return primaryLanguage === 'JavaScript' || primaryLanguage === 'TypeScript' ? 'node --test {file}' : null;
}

// ---------------------------------------------------------------------------
// Running

/**
 * Run tests and parse the result. `target` is a relative test file path;
 * when absent the full-suite command is used. Never throws.
 */
async function runTests(projectRoot, opts = {}) {
  const detection = detectTests(projectRoot);
  let command = opts.command;
  if (!command) {
    if (opts.target) {
      command = detection.targetTemplate ? detection.targetTemplate.replace('{file}', opts.target) : null;
    } else {
      command = detection.fullCommand;
    }
  }
  if (!command) {
    return { ok: false, error: 'no_test_command', message: 'No test command could be detected for this project.', detection };
  }

  const timeoutMs = Math.min(Number(opts.timeoutMs) || MAX_COMMAND_MS, MAX_COMMAND_MS);
  const start = Date.now();
  const execution = await new Promise((resolve) => {
    execFile(
      process.platform === 'win32' ? 'cmd' : '/bin/sh',
      process.platform === 'win32' ? ['/c', command] : ['-c', command],
      { cwd: projectRoot, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: sanitizedEnv() },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - start;
        resolve({
          exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          timedOut: !!(error && error.killed),
          stdout: stdout || '',
          stderr: stderr || '',
          durationMs,
        });
      }
    );
  });

  const output = `${execution.stdout}\n${execution.stderr}`;
  const parsed = parseTestOutput(output, execution.exitCode);
  const result = {
    ok: execution.exitCode === 0 && !execution.timedOut,
    command,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    durationMs: execution.durationMs,
    totals: parsed.totals,
    failures: parsed.failures,
    parsedFormat: parsed.format,
    rawTail: output.split('\n').filter((l) => l.trim() !== '').slice(-RAW_TAIL_LINES).join('\n'),
    finishedAt: new Date().toISOString(),
  };
  return result;
}

// ---------------------------------------------------------------------------
// Output parsing

/**
 * Parse runner output into structured results. Recognizes TAP (node:test),
 * Jest/Vitest summaries, pytest, and go test; otherwise 'generic'.
 */
function parseTestOutput(output, exitCode = 0) {
  const text = String(output || '');

  // TAP (node --test)
  const totalsMatch = text.match(/^# tests (\d+)$/m);
  if (totalsMatch) {
    const grab = (label) => {
      const m = text.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
      return m ? Number(m[1]) : 0;
    };
    const totals = { total: grab('tests'), passed: grab('pass'), failed: grab('fail'), skipped: grab('skipped') };
    const failures = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^not ok \d+ - (.+)$/);
      if (!m) continue;
      failures.push({ name: m[1].trim(), file: null, message: tapFailureMessage(lines, i) });
    }
    return { format: 'tap', totals, failures };
  }

  // Jest / Vitest
  const jestSummary = text.match(/Tests:\s*(?:(\d+)\s*failed(?:,\s*))?(?:(\d+)\s*skipped(?:,\s*))?(\d+)\s*passed(?:,\s*(\d+)\s*total)?/);
  if (jestSummary) {
    const failed = Number(jestSummary[1]) || 0;
    const skipped = Number(jestSummary[2]) || 0;
    const passed = Number(jestSummary[3]) || 0;
    const totals = { total: Number(jestSummary[4]) || passed + failed + skipped, passed, failed, skipped };
    const failures = [];
    let currentFile = null;
    for (const line of text.split('\n')) {
      const fileMatch = line.match(/^FAIL\s+(\S+)/);
      if (fileMatch) {
        currentFile = fileMatch[1];
        continue;
      }
      const dotMatch = line.match(/^\s*●\s+(.+?)\s*$/);
      if (dotMatch && failures.length < 50) {
        failures.push({ name: dotMatch[1], file: currentFile, message: '' });
      }
    }
    return { format: 'jest', totals, failures: failures.slice(0, 50) };
  }

  // pytest
  if (/=+.*?\d+ (?:failed|passed).*?=+/m.test(text) && /\bpytest\b|_{4,} test|FAILED /.test(text)) {
    const failedM = text.match(/(\d+) failed/);
    const passedM = text.match(/(\d+) passed/);
    const failed = failedM ? Number(failedM[1]) : 0;
    const passed = passedM ? Number(passedM[1]) : 0;
    const totals = { total: passed + failed, passed, failed, skipped: 0 };
    const failures = [];
    const re = /^FAILED (.+?)(?: - (.*))?$/gm;
    let m;
    while ((m = re.exec(text)) && failures.length < 50) {
      failures.push({ name: m[1].trim(), file: m[1].split('::')[0], message: (m[2] || '').trim() });
    }
    return { format: 'pytest', totals, failures };
  }

  // go test
  if (/^--- FAIL:/m.test(text)) {
    const failures = [];
    const re = /^--- FAIL: (.+?)(?:\s+\([\d.]+s\))?$/gm;
    let m;
    while ((m = re.exec(text)) && failures.length < 50) {
      failures.push({ name: m[1].trim(), file: null, message: '' });
    }
    const passedMatch = text.match(/^ok\s+\S+/m);
    const totals = { total: failures.length + (passedMatch ? 1 : 0), passed: passedMatch ? 1 : 0, failed: failures.length, skipped: 0 };
    return { format: 'go', totals, failures };
  }

  // Generic fallback — honest: counts unknown.
  return {
    format: 'generic',
    totals: { total: null, passed: null, failed: exitCode === 0 ? 0 : null, skipped: null },
    failures: [],
  };
}

/**
 * Extract a failure message from the TAP YAML block after a `not ok` line:
 * the indented content under `error: |` (or `message:`), up to 6 lines.
 */
function tapFailureMessage(lines, notOkIndex) {
  const messageLines = [];
  let inErrorBlock = false;
  for (let j = notOkIndex + 1; j < lines.length && j < notOkIndex + 30; j++) {
    const line = lines[j];
    if (line.trim() === '...' || /^(not ok|ok |# )/.test(line) || line.startsWith('1..')) break;
    if (/^\s{2}(error|message):\s*\|/.test(line)) {
      inErrorBlock = true;
      continue;
    }
    if (inErrorBlock) {
      if (/^\s{4,}/.test(line)) {
        messageLines.push(line.trim());
        if (messageLines.length >= 6) break;
      } else if (line.trim() !== '') {
        inErrorBlock = false; // a new YAML key at 2-space indent ends the block
      }
    }
  }
  return messageLines.join('\n');
}

// ---------------------------------------------------------------------------
// Failure/change association

/**
 * Associate parsed failures with changed files: marks each failure with
 * related: [changed files that appear in its name/message] and returns a
 * grouped summary. Pure function over strings — no guessing beyond evidence.
 */
function associateFailures(failures, changedFiles = []) {
  const associations = failures.map((f) => {
    const haystack = `${f.name || ''} ${f.file || ''} ${f.message || ''}`;
    const related = changedFiles.filter((c) => haystack.includes(path.basename(c)) || haystack.includes(c));
    return { ...f, related };
  });
  const groups = {};
  for (const f of associations) {
    for (const c of f.related) groups[c] = (groups[c] || 0) + 1;
  }
  return { failures: associations, byChangedFile: groups };
}

// ---------------------------------------------------------------------------
// History (bounded, JSON-backed)

class TestHistoryStore {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'test-history.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this._load();
  }

  _load() {
    if (fs.existsSync(this.filePath)) {
      try {
        this.runs = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      } catch {
        this.runs = [];
      }
    } else {
      this.runs = [];
    }
  }

  _save() {
    if (this.runs.length > HISTORY_LIMIT) this.runs = this.runs.slice(0, HISTORY_LIMIT);
    fs.writeFileSync(this.filePath, JSON.stringify(this.runs, null, 2), 'utf8');
  }

  /** Record a run. Stores the structured result, not the full raw output. */
  record(result, { project } = {}) {
    const entry = {
      id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      project: project || null,
      ok: result.ok,
      command: result.command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      totals: result.totals,
      failures: (result.failures || []).slice(0, 25),
      parsedFormat: result.parsedFormat,
      finishedAt: result.finishedAt,
    };
    this.runs.unshift(entry);
    this._save();
    return entry;
  }

  list(limit = 20) {
    return this.runs.slice(0, limit);
  }

  /** Previous run for regression comparison (second entry = previous state). */
  previous() {
    return this.runs[1] || null;
  }
}

module.exports = {
  detectTests,
  runTests,
  parseTestOutput,
  associateFailures,
  TestHistoryStore,
  targetCommandTemplate,
};
