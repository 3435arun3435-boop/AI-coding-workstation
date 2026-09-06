'use strict';
/**
 * modes.js
 *
 * Agent operating modes. Each mode constrains the agent loop for real:
 *  - allowedTools: the ONLY tools declared to the model AND enforced
 *    server-side (a call for a non-allowed tool is rejected before execution)
 *  - instructions: appended to the system prompt so behavior actually changes
 *  - readOnly: hints the loop/safety layer that no mutation should occur
 *
 * Modes are behavior, not UI decoration — the same underlying agent loop is
 * reused; only its tool surface and instructions change.
 *
 * 'auto' is resolved to a concrete mode from the task text via heuristics;
 * resolution failure defaults to 'code'.
 */

const { classifyIntent } = require('./intent');

const READ_ONLY_TOOLS = [
  'run_tests',
  'list_files',
  'read_file',
  'search_project',
  'get_project_map',
  'find_relevant_files',
  'get_project_context',
  'git_status',
  'git_diff',
  'git_log',
];

const MUTATING_TOOLS = ['write_file', 'edit_file'];
const EXECUTION_TOOLS = ['run_command', 'run_tests', 'git_add', 'git_commit'];

const ALL_TOOLS = [...READ_ONLY_TOOLS, ...MUTATING_TOOLS, ...EXECUTION_TOOLS];

const MODES = {
  ask: {
    label: 'Ask',
    description: 'Read-only investigation and explanation. No file changes, no commands.',
    allowedTools: READ_ONLY_TOOLS,
    readOnly: true,
    instructions:
      'MODE: Ask. Investigate and explain. You may read and search the project, but you must NOT modify any files or run commands. Answer the question directly, citing specific files and line-level facts you found.',
  },
  code: {
    label: 'Code',
    description: 'Implement the requested changes with focused edits, then run relevant tests.',
    allowedTools: ALL_TOOLS,
    readOnly: false,
    instructions:
      'MODE: Code. Implement the requested change. Inspect before editing; make the smallest correct change (edit_file with exact context, not full-file rewrites, unless creating a file); then run the relevant tests to verify and report what you did.',
  },
  debug: {
    label: 'Debug',
    description: 'Investigate a failure, find the root cause, apply a minimal fix, verify.',
    allowedTools: ALL_TOOLS,
    readOnly: false,
    instructions:
      'MODE: Debug. Start from the observed failure (error text, stack trace, failing test). Read the relevant code, form a root-cause hypothesis, verify it against the code, then apply the MINIMAL fix. Re-run the failing test or command to confirm the fix. Report root cause, fix, and verification result.',
  },
  test: {
    label: 'Test',
    description: 'Discover and run tests, analyze failures. Does not modify code.',
    allowedTools: [...READ_ONLY_TOOLS, 'run_command', 'run_tests'],
    readOnly: false,
    instructions:
      'MODE: Test. Discover the project\'s tests, run them, and analyze the results. You must NOT modify project source files. Report pass/fail counts, failing tests with their error messages, and which files are implicated.',
  },
  review: {
    label: 'Review',
    description: 'Review code for correctness, security, and quality. Read-only.',
    allowedTools: READ_ONLY_TOOLS,
    readOnly: true,
    instructions:
      'MODE: Review. Examine the specified code (or recent changes) for correctness, security issues, regressions, and maintainability. Do NOT modify anything. Produce a findings list ordered by severity, each with file, location, problem, and suggested fix.',
  },
  plan: {
    label: 'Plan',
    description: 'Produce a structured, inspectable plan before any execution.',
    allowedTools: READ_ONLY_TOOLS,
    readOnly: true,
    instructions:
      'MODE: Plan. Investigate read-only, then produce a structured plan EXACTLY in this shape:\n' +
      '1. UNDERSTANDING — what was asked, in your own words\n' +
      '2. RELEVANT CONTEXT — files/symbols/tests that matter (from the tools)\n' +
      '3. SKILLS — applicable project skills, if any\n' +
      '4. FILES AFFECTED — every file you intend to change, and why\n' +
      '5. EXPECTED CHANGES — the precise change per file\n' +
      '6. EXPECTED TESTS — how the change will be verified\n' +
      '7. RISKS — what could break, and the rollback approach\n' +
      'Do NOT modify anything. Planning only — execution happens after the plan is accepted.',
  },
  autonomous: {
    label: 'Autonomous',
    description: 'Full workflow: inspect, plan, edit, test, verify — within configured limits.',
    allowedTools: ALL_TOOLS,
    readOnly: false,
    instructions:
      'MODE: Autonomous. Execute the complete task workflow: understand the task, inspect the project, form a plan, make focused changes, run tests, verify the result, and iterate (bounded) until done or blocked. Give a final engineering report: what changed, what was tested, and the verification result. Never claim success without verification.',
  },
};

/** Heuristic AUTO resolution from the task text. Never throws. */
function resolveAutoMode(task) {
  const t = String(task || '').toLowerCase();
  if (/(^|\b)(review|code review|audit)\b/.test(t)) return 'review';
  if (/(^|\b)(debug|fix|broken|fails?|failing|error|crash|bug|regression)\b/.test(t)) return 'debug';
  if (/(^|\b)(test|tests|testing|unit test|coverage)\b/.test(t)) return 'test';
  // Intent routing (PART A) last: pure conversational/report requests are
  // ASK — but only after debug/test/review signals, which are more specific.
  if (classifyIntent(task).intent === 'chat') return 'ask';
  return 'code';
}

/**
 * Resolve a requested mode name to a concrete mode key.
 *  - undefined/null  → defaultMode ('autonomous': exact pre-modes behavior)
 *  - 'auto'          → resolved from the task text
 *  - known mode key  → itself
 *  - anything else   → defaultMode (safe fallback)
 */
function resolveMode(mode, task, defaultMode = 'autonomous') {
  if (mode === 'auto') return resolveAutoMode(task);
  if (mode && MODES[mode]) return mode;
  return defaultMode;
}

function getMode(modeKey) {
  return MODES[modeKey] || MODES.autonomous;
}

module.exports = {
  MODES,
  MODE_KEYS: Object.keys(MODES),
  READ_ONLY_TOOLS,
  MUTATING_TOOLS,
  EXECUTION_TOOLS,
  ALL_TOOLS,
  resolveAutoMode,
  resolveMode,
  getMode,
};
