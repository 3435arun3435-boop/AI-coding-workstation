'use strict';
/**
 * intent.js
 *
 * Chat intent routing (PART A): pick the SMALLEST execution path for a task.
 *
 *   chat      — plain conversational answer/report. NO tool schemas are sent
 *               to the provider at all: no forced tool-calling, no structured
 *               output parsing, minimal token usage. (This is what makes
 *               "Analyze this project and give me a report" reliable on
 *               providers like Groq, whose tool-call JSON parser can reject
 *               ordinary generation with `output_parse_failed`.)
 *   tool-chat — read-only inspection is genuinely wanted (named files, "run
 *               the tests", "show me"). Read-only tools only.
 *   task      — engineering work that modifies the project (fix/implement/
 *               refactor/…). Full agent loop with the mode's tool surface.
 *
 * The classifier is keyword-based and honest about being a heuristic: the
 * explicit `mode` chosen by the user always wins over the guess (an explicit
 * Ask/Code/Debug pick in the UI is honored; intent only refines ASK/AUTO).
 */

const TOOL_CHAT_PATTERNS = [
  /\b(inspect|show|list|read|open|find|search|look at|check)\b[^.?!]*\b(file|files|folder|directory|package\.json|module|src\/|test|tests|config|code)\b/i,
  /\b(package\.json|tsconfig|readme|changelog|src\/[\w./-]+|[\w-]+\.(js|ts|py|go|json|md))\b/i,
  /\brun\b[^.?!]*\b(tests?|build|lint)\b/i,
  /\bwhat files\b|\bwhich files\b|\bproject structure\b|\bfile tree\b|\blist the (files|modules|tests)\b/i,
];

const TASK_PATTERNS = [
  /\b(fix|repair|patch|implement|add|create|write|build|refactor|update|change|modify|delete|remove|migrate|optimize)\b[^.?!]*\b(code|function|bug|test|tests|feature|endpoint|module|file|class|api|component|button|page|panel|dialog|menu|form|input|layout|style|screen|view|settings|ui)\b/i,
  /\b(failing|broken) tests?\b/i,
  /\bmake (it|the) (work|pass)\b/i,
];

const CHAT_PATTERNS = [
  /\b(analyze|analyse|analysis|summar(y|ize|ise)|report|overview|explain|describe|review|what is|what does|how does|why|tell me about|give me a report)\b/i,
];

/**
 * Classify the execution intent for a task.
 * @returns {{ intent: 'chat'|'tool-chat'|'task', reason: string }}
 */
const MODIFY_VERB = /\b(fix|repair|patch|implement|add|create|write|build|refactor|update|change|modify|delete|remove|migrate|optimize)\b/i;

function classifyIntent(task) {
  const t = String(task || '');

  for (const re of TASK_PATTERNS) {
    if (re.test(t)) return { intent: 'task', reason: `engineering verbs detected (${re})` };
  }
  // A modification verb with an unrecognized object is still engineering
  // work — the safer interpretation for a coding workstation.
  if (MODIFY_VERB.test(t)) return { intent: 'task', reason: 'modification verb present' };
  for (const re of TOOL_CHAT_PATTERNS) {
    if (re.test(t)) return { intent: 'tool-chat', reason: `explicit inspection targets detected` };
  }
  for (const re of CHAT_PATTERNS) {
    if (re.test(t)) return { intent: 'chat', reason: 'conversational/report request without inspection targets' };
  }
  // No signals at all: a plain question is the smallest useful path.
  return { intent: 'chat', reason: 'no tool/engineering signals — smallest path is plain chat' };
}

module.exports = { classifyIntent };
