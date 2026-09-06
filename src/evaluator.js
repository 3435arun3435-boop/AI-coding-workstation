'use strict';
/**
 * evaluator.js
 *
 * AI Quality Evaluator: the independent verification layer. After an agent
 * claims completion, this module checks EVIDENCE — not the agent's final
 * message:
 *   - declared file changes actually exist on disk (and are non-empty)
 *   - approvals that were applied have real results
 *   - test evidence: real runs with parsed results (when the project has tests)
 *   - git state (changed files present) when in a repo
 *   - blocker detection (provider errors, cancellations)
 *
 * Verdicts: VERIFIED (all evidence supports success) | PARTIAL (something
 * changed and evidence is incomplete but not contradicting) | FAILED
 * (evidence contradicts success) | BLOCKED (could not even attempt).
 *
 * The evaluator never fabricates evidence it did not check.
 */

const fs = require('fs');
const path = require('path');
const { resolveInProject } = require('./security');
const { detectTests } = require('./test-intel');

async function evaluate({ task, projectRoot, result, runTestsFn = null } = {}) {
  const evidence = {
    files: { checked: 0, existing: 0, empty: [], missing: [] },
    tests: null,
    blockers: [],
    git: null,
  };

  // --- blockers -------------------------------------------------------------
  if (!result || result.status === 'error') {
    evidence.blockers.push(result && result.summary ? result.summary : 'agent returned an error');
    return { verdict: 'BLOCKED', evidence, reason: evidence.blockers[0] };
  }
  if (result.status === 'cancelled') {
    evidence.blockers.push('task was cancelled');
    return { verdict: 'BLOCKED', evidence, reason: 'task was cancelled before completion' };
  }
  if (result.status === 'blocked') {
    evidence.blockers.push(result.summary || 'task blocked');
    return { verdict: 'BLOCKED', evidence, reason: evidence.blockers[0] };
  }

  // --- file evidence --------------------------------------------------------
  const filesChanged = (result.filesChanged || []).filter(Boolean);
  for (const rel of filesChanged) {
    evidence.files.checked += 1;
    try {
      const abs = resolveInProject(projectRoot, rel);
      const stat = fs.statSync(abs);
      if (stat.isFile() && stat.size > 0) evidence.files.existing += 1;
      else if (stat.isFile()) evidence.files.empty.push(rel);
      else evidence.files.missing.push(rel); // directory — not a real file change
    } catch {
      evidence.files.missing.push(rel);
    }
  }

  // --- test evidence --------------------------------------------------------
  const detection = detectTests(projectRoot);
  if (detection.fullCommand) {
    if (runTestsFn) {
      try {
        const testResult = await runTestsFn(projectRoot, {});
        evidence.tests = {
          ran: true,
          ok: testResult.ok,
          command: testResult.command,
          totals: testResult.totals,
          parsedFormat: testResult.parsedFormat,
        };
      } catch (e) {
        evidence.tests = { ran: false, error: e.message };
      }
    } else {
      evidence.tests = { ran: false, reason: 'no test runner was provided to the evaluator' };
    }
  } else {
    evidence.tests = { ran: false, reason: 'no automated tests detected in this project' };
  }

  // --- verdict ----------------------------------------------------------------
  const filesDeclared = filesChanged.length > 0;
  const filesVerified = evidence.files.checked > 0 && evidence.files.existing === evidence.files.checked;
  const testsOk = evidence.tests && evidence.tests.ran && evidence.tests.ok;
  const testsFailed = evidence.tests && evidence.tests.ran && !evidence.tests.ok;
  const noTestsPossible = evidence.tests && evidence.tests.ran === false && /no automated tests/.test(evidence.tests.reason || '');

  if (filesDeclared && !filesVerified) {
    return {
      verdict: 'FAILED',
      evidence,
      reason: `declared file changes are not all real: missing [${evidence.files.missing.join(', ')}]${evidence.files.empty.length ? `, empty [${evidence.files.empty.join(', ')}]` : ''}`,
    };
  }
  if (testsFailed) {
    return {
      verdict: 'FAILED',
      evidence,
      reason: `tests fail after the changes: ${evidence.tests.totals ? `${evidence.tests.totals.failed} failed` : 'failure reported'}`,
    };
  }
  if (testsOk && (!filesDeclared || filesVerified)) {
    return { verdict: 'VERIFIED', evidence, reason: `files verified (${evidence.files.existing}/${evidence.files.checked}) and tests pass (${evidence.tests.totals.passed} passed)` };
  }
  if (noTestsPossible) {
    if (!filesDeclared) {
      return { verdict: 'PARTIAL', evidence, reason: 'no files changed and no tests exist — evidence is thin; treat the agent summary as unverified' };
    }
    if (filesVerified) {
      return {
        verdict: 'PARTIAL',
        evidence,
        reason: `file changes verified on disk (${evidence.files.existing}/${evidence.files.checked}) but the project has no automated tests, so functional verification was not possible`,
      };
    }
  }
  if (evidence.tests && evidence.tests.ran === false) {
    return { verdict: 'PARTIAL', evidence, reason: evidence.tests.reason || 'test evidence unavailable' };
  }
  return { verdict: 'PARTIAL', evidence, reason: 'incomplete evidence for a VERIFIED verdict' };
}

module.exports = { evaluate };
