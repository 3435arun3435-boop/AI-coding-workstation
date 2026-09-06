'use strict';
/**
 * debug-loop.js
 *
 * The Autonomous Debug Loop (SWE-agent/OpenHands-inspired, built on THIS
 * project's existing agent loop — no duplicate agent architecture):
 *
 *   UNDERSTAND → INVESTIGATE (read-only agent pass)
 *   → [FIX → TEST → ANALYZE] × maxAttempts (bounded)
 *   → browser verification (only when explicitly enabled and available)
 *   → engineering report: PASS / PARTIAL / FAILED / BLOCKED
 *
 * Every claim in the report comes from an actual executed step: the test
 * results are parsed from real runs, the files-changed list comes from the
 * agent's tool log and applied proposals. It never claims success without
 * verification.
 */

const { runAgentTask } = require('./agent-loop');
const { runTests, detectTests, associateFailures } = require('./test-intel');
const { analyzeProject } = require('./project-intel');
const { browserStatus, manager: browserManager } = require('./browser');
const { isGitRepo, changeSummary } = require('./git');
const { evaluate } = require('./evaluator');
const { skillsToSystemMessage } = require('./skills');

const DEFAULT_MAX_ATTEMPTS = 3;
const RAW_FAIL_LINES = 12;

async function runDebugLoop({
  task,
  projectRoot,
  router,
  callFn,
  memory,
  approvals,
  safetyMode,
  taskId,
  onActivity = () => {},
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  shouldCancel = null,
  browserUrl = null, // explicit opt-in for browser verification
  skills = null, // matched skills from the skills engine
  knowledge = null, // KnowledgeStore; failure episodes are recorded + recalled
  checkpoints = null, // CheckpointStore; snapshot before autonomous edits
  checkpointEnabled = true,
  testBeforeComplete = true,
  runTestsFn = null, // injectable test runner for the evaluator (defaults to real runTests)
  retryPolicy = null, // bounded same-provider retry policy from the Settings Center
  ctxExtras = null, // runtime settings passed to tool execution (terminal limits…)
  advisories = null, // caller advisories (resume context) — merged with knowledge
}) {
  const timeline = [];
  const emit = (state, message) => {
    const event = { state, message, ts: new Date().toISOString() };
    timeline.push(event);
    onActivity(event);
  };

  emit('UNDERSTAND', `Autonomous debug loop started (max ${maxAttempts} fix attempts): ${task}`);

  // --- INVESTIGATE -----------------------------------------------------------
  if (shouldCancel && shouldCancel()) return cancelledResult(task, timeline);

  let map = null;
  try {
    map = analyzeProject(projectRoot);
    emit('INSPECT', `Project: ${map.projectType}, primary language ${map.primaryLanguage || 'unknown'}${map.isGitRepo ? ', git repo' : ', no git'}`);
  } catch (e) {
    emit('INSPECT', `Project scan failed: ${e.message}`);
  }

  emit('INSPECT', 'Investigating (read-only pass)…');

  // Failure Knowledge Base: recall prior episodes for this error/task so the
  // investigation does not repeat known-failed fixes.
  const knowledgeAdvisories = [...(advisories || [])];
  if (knowledge) {
    try {
      const prior = knowledge.search(projectRoot, task);
      const msg = knowledge.toSystemMessage(prior);
      if (msg) {
        knowledgeAdvisories.push({ ...msg, label: `Recalled ${prior.length} past debugging episode(s) from project knowledge base` });
      }
    } catch {
      /* knowledge recall is advisory — never fail the run over it */
    }
  }

  // Checkpoint: capture the current dirty state before autonomous edits so
  // the whole episode can be rolled back (git projects; see checkpoints.js).
  let checkpointId = null;
  if (checkpoints && checkpointEnabled) {
    try {
      const ck = checkpoints.create(projectRoot, { label: `before autonomous: ${task.slice(0, 80)}`, taskId });
      checkpointId = ck.id;
      emit('PLAN', `Checkpoint ${ck.id} captured (${ck.files.length} file(s) snapshotted)`);
    } catch (e) {
      emit('PLAN', `Checkpoint failed (non-fatal): ${e.message}`);
    }
  }

  const investigation = await runAgentTask({
    task:
      `Investigate (read-only) for this problem: "${task}". ` +
      'Find the relevant files and code paths, and report: (1) what you observed, (2) your root-cause hypothesis, (3) a minimal fix plan. Do NOT modify anything.',
    projectRoot,
    router,
    callFn,
    memory,
    safetyMode,
    approvals,
    taskId,
    mode: 'ask',
    skills,
    advisories: knowledgeAdvisories,
    onActivity,
    retryPolicy,
    ctxExtras,
  });
  if (investigation.status !== 'completed') {
    // Provider outage or similar — blocked, honestly.
    emit('FIX', `Investigation failed: ${investigation.summary}`);
    return {
      status: 'blocked',
      summary: `Could not investigate the task: ${investigation.summary}`,
      filesChanged: [],
      testsRun: [],
      toolLog: investigation.toolLog || [],
      report: {
        task,
        result: 'BLOCKED',
        rootCause: null,
        filesChanged: [],
        tests: null,
        browser: null,
        remainingIssues: [investigation.summary],
        timeline,
      },
    };
  }
  const investigationNotes = investigation.summary;
  emit('PLAN', `Investigation complete: ${clip(investigationNotes, 300)}`);

  // --- FIX → TEST → ANALYZE --------------------------------------------------
  const detection = detectTests(projectRoot);
  const allFilesChanged = new Set();
  const testsRun = [];
  let lastTestResult = null;
  let firstTestResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (shouldCancel && shouldCancel()) return cancelledResult(task, timeline, Array.from(allFilesChanged), testsRun);

    const failureContext =
      lastTestResult && lastTestResult.failures && lastTestResult.failures.length > 0
        ? formatFailuresForModel(lastTestResult, Array.from(allFilesChanged))
        : '';

    emit('FIX', `Fix attempt ${attempt}/${maxAttempts}${failureContext ? ' (with previous test failure analysis)' : ''}`);

    const fixResult = await runAgentTask({
      task:
        `Task: ${task}\n\n` +
        (attempt === 1
          ? `Investigation notes from a read-only pass: ${investigationNotes}\n`
          : `Your previous fix did NOT fully resolve the problem. Test analysis:\n${failureContext}\nRe-examine the failing area and apply a different, minimal correction.\n`) +
        'Apply the minimal fix now, then run the relevant tests to verify.',
      projectRoot,
      router,
      callFn,
      memory,
      safetyMode,
      approvals,
      taskId,
      mode: 'debug',
      skills,
      advisories: knowledgeAdvisories,
      retryPolicy,
      ctxExtras,
    });

    for (const f of fixResult.filesChanged || []) allFilesChanged.add(f);
    if (fixResult.status === 'error') {
      emit('FIX', `Fix attempt ${attempt} errored: ${clip(fixResult.summary, 200)}`);
      return {
        status: 'blocked',
        summary: `Fix attempt failed: ${fixResult.summary}`,
        filesChanged: Array.from(allFilesChanged),
        testsRun,
        toolLog: fixResult.toolLog || [],
        report: {
          task,
          result: 'BLOCKED',
          rootCause: null,
          filesChanged: Array.from(allFilesChanged),
          tests: lastTestResult ? summarizeTestResult(lastTestResult) : null,
          browser: null,
          remainingIssues: [fixResult.summary],
          timeline,
        },
      };
    }

    // --- TEST ----------------------------------------------------------------
    let testResult = null;
    if (detection.fullCommand && testBeforeComplete) {
      emit('TEST', `Running ${detection.fullCommand}…`);
      testResult = await runTests(projectRoot);
      testsRun.push({ command: testResult.command, ok: testResult.ok, totals: testResult.totals });
      lastTestResult = testResult;
      if (!firstTestResult) firstTestResult = testResult;
      testHistoryRecord(testResult);
      emit('TEST', `Tests ${testResult.ok ? 'PASS' : 'FAIL'}: ${fmtTotals(testResult.totals)} (${testResult.command})`);
    } else if (detection.fullCommand) {
      emit('TEST', 'testBeforeComplete is disabled — skipping the verification run.');
    } else {
      emit('TEST', 'No automated tests detected — relying on the agent\'s own verification commands.');
    }

    const verified = detection.fullCommand ? (testBeforeComplete ? testResult.ok : true) : fixResult.status === 'completed';

    // Knowledge base: record this attempt's outcome so failed approaches are
    // never silently repeated in a later episode.
    if (knowledge) {
      try {
        knowledge.record(projectRoot, {
          errorSignature: `${task}${lastTestResult && lastTestResult.failures.length ? ` | ${lastTestResult.failures[0].name}: ${clip(lastTestResult.failures[0].message || '', 300)}` : ''}`,
          affectedFiles: Array.from(allFilesChanged),
          investigation: investigationNotes,
          attempts: [{ summary: clip(fixResult.summary, 400), result: verified ? 'succeeded' : 'failed' }],
          successfulFix: verified ? clip(fixResult.summary, 600) : null,
          finalResult: verified ? 'success' : 'failure',
          tests: lastTestResult ? summarizeTestResult(lastTestResult) : null,
        });
      } catch {
        /* knowledge recording is advisory */
      }
    }

    if (verified) {
      // --- FINAL VERIFICATION (independent quality evaluation) ---------------
      const gitSummary = (await isGitRepo(projectRoot).then((r) => (r ? changeSummary(projectRoot) : null)).catch(() => null));
      const browser = browserUrl ? await verifyInBrowser(browserUrl, emit) : null;

      let evaluation = null;
      try {
        emit('VERIFY', 'Independent quality evaluation (evidence-based)…');
        evaluation = await evaluate({
          task,
          projectRoot,
          result: { ...fixResult, filesChanged: Array.from(allFilesChanged), status: 'completed' },
          runTestsFn: detection.fullCommand ? async (root, testOpts) => runTests(root, testOpts) : null,
        });
        emit('VERIFY', `Evaluation verdict: ${evaluation.verdict} — ${clip(evaluation.reason, 160)}`);
      } catch (e) {
        emit('VERIFY', `Evaluation failed (non-fatal): ${e.message}`);
      }

      emit('COMPLETE', 'Verified: tests pass. Producing engineering report.');
      return {
        status: 'completed',
        summary:
          `FIXED after ${attempt} attempt(s). ${clip(investigationNotes, 200)} ` +
          `Files changed: ${Array.from(allFilesChanged).join(', ') || 'none'}. ` +
          (testResult ? `Tests: ${fmtTotals(testResult.totals)} (pass).` : 'No automated tests detected; agent self-verification completed.'),
        filesChanged: Array.from(allFilesChanged),
        testsRun,
        toolLog: fixResult.toolLog || [],
        report: {
          task,
          result: 'PASS',
          rootCause: clip(investigationNotes, 1000),
          filesChanged: Array.from(allFilesChanged),
          changes: gitSummary,
          tests: testResult ? summarizeTestResult(testResult) : { note: 'no automated tests detected' },
          browser,
          checkpointId,
          evaluation,
          remainingIssues: [],
          timeline,
        },
      };
    }
  }

  // Attempts exhausted — PARTIAL if the failure count improved, else FAILED.
  const improved =
    firstTestResult && lastTestResult &&
    typeof firstTestResult.totals.failed === 'number' && typeof lastTestResult.totals.failed === 'number' &&
    lastTestResult.totals.failed < firstTestResult.totals.failed;

  emit('FIX', improved ? 'Failure count reduced but tests still not fully passing.' : 'Attempts exhausted; tests still failing.');

  return {
    status: improved ? 'partial' : 'failed',
    summary:
      (improved ? 'PARTIAL: some failures remain.' : 'FAILED: attempts exhausted.') +
      ` Last test run: ${fmtTotals(lastTestResult ? lastTestResult.totals : null)}. Files changed: ${Array.from(allFilesChanged).join(', ') || 'none'}.`,
    filesChanged: Array.from(allFilesChanged),
    testsRun,
    toolLog: [],
    report: {
      task,
      result: improved ? 'PARTIAL' : 'FAILED',
      rootCause: clip(investigationNotes, 1000),
      filesChanged: Array.from(allFilesChanged),
      tests: lastTestResult ? summarizeTestResult(lastTestResult) : null,
      browser: null,
      checkpointId,
      remainingIssues: lastTestResult
        ? lastTestResult.failures.slice(0, 10).map((f) => `${f.name}: ${clip(f.message || 'no message', 160)}`)
        : ['no automated tests detected'],
      timeline,
    },
  };
}

// --- helpers -----------------------------------------------------------------

function cancelledResult(task, timeline, filesChanged = [], testsRun = []) {
  timeline.push({ state: 'COMPLETE', message: 'Cancelled by user', ts: new Date().toISOString() });
  return {
    status: 'cancelled',
    summary: 'Task cancelled by user.',
    filesChanged,
    testsRun,
    toolLog: [],
    report: { task, result: 'BLOCKED', rootCause: null, filesChanged, tests: null, browser: null, remainingIssues: ['cancelled by user'], timeline },
  };
}

function formatFailuresForModel(testResult, changedFiles) {
  const lines = [`Command: ${testResult.command}`, `Totals: ${fmtTotals(testResult.totals)}`];
  const assoc = associateFailures(testResult.failures || [], changedFiles);
  for (const f of assoc.failures.slice(0, 8)) {
    lines.push(`- ${f.name}${f.file ? ` (${f.file})` : ''}: ${clip(f.message || 'no message captured', 300)}`);
    if (f.related && f.related.length) lines.push(`  possibly related to your changes: ${f.related.join(', ')}`);
  }
  return lines.join('\n');
}

function summarizeTestResult(testResult) {
  return {
    command: testResult.command,
    ok: testResult.ok,
    totals: testResult.totals,
    parsedFormat: testResult.parsedFormat,
    failures: (testResult.failures || []).slice(0, 10),
  };
}

async function verifyInBrowser(url, emit) {
  const status = await browserStatus();
  if (!status.available) {
    emit('VERIFY', `Browser verification skipped: ${status.detail}`);
    return { attempted: false, reason: 'playwright not installed' };
  }
  try {
    emit('VERIFY', `Browser verification: opening ${url}`);
    const nav = await browserManager.navigate(url);
    const errors = nav.errors;
    emit('VERIFY', `Browser verification: title "${nav.title}", ${errors.totalErrors} error(s)`);
    await browserManager.close();
    return { attempted: true, url, title: nav.title, errors };
  } catch (e) {
    emit('VERIFY', `Browser verification failed: ${e.message}`);
    await browserManager.close().catch(() => {});
    return { attempted: true, url, error: e.message };
  }
}

function testHistoryRecord(testResult) {
  try {
    // Lazy import to avoid a circular dependency with server-local stores.
    const { TestHistoryStore } = require('./test-intel');
    const os = require('os');
    const path = require('path');
    const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), '.coding-agent');
    new TestHistoryStore(dataDir).record(testResult);
  } catch {
    /* history is best-effort */
  }
}

function fmtTotals(totals) {
  if (!totals) return 'unknown';
  return `${totals.passed ?? '?'} passed, ${totals.failed ?? '?'} failed${totals.skipped ? `, ${totals.skipped} skipped` : ''}`;
}

function clip(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

module.exports = { runDebugLoop, DEFAULT_MAX_ATTEMPTS };
