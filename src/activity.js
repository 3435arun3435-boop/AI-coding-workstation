'use strict';
/**
 * activity.js
 *
 * THE canonical activity state model (PART C). One vocabulary shared by the
 * agent loop, the task center, and the UI — no second competing system.
 *
 * Canonical states:
 *   queued, planning, thinking, reading, searching, editing,
 *   waiting_approval, running_command, running_test, browser_running,
 *   git_running, provider_request, retrying, completed, failed, blocked,
 *   cancelled
 *
 * Rules:
 *   - Only information that actually exists is exposed (tool name, real
 *     provider/model, real fallback events). No percentages, no fake progress.
 *   - Terminal states (completed/failed/blocked/cancelled) always resolve an
 *     activity — no permanent spinner.
 *   - Icons are a UI concern mirrored here so every consumer renders
 *     consistently; reduced-motion handling stays in CSS.
 */

const STATES = [
  'idle', 'queued', 'planning', 'thinking', 'reading', 'searching', 'editing',
  'waiting_approval', 'running_command', 'running_test', 'browser_running',
  'git_running', 'provider_request', 'retrying', 'completed', 'failed',
  'blocked', 'cancelled',
];

const ICONS = {
  queued: '⏳', planning: '🧭', thinking: '🧠', reading: '📖', searching: '🔎',
  editing: '✏️', waiting_approval: '⏸', running_command: '▶', running_test: '🧪',
  browser_running: '🌐', git_running: '⎇', provider_request: '◉', retrying: '↻',
  completed: '✓', failed: '✕', blocked: '⚠', cancelled: '■',
};

const TERMINAL_STATES = new Set(['completed', 'failed', 'blocked', 'cancelled']);

/** Map a tool name + parsed args to a canonical activity. Real args only. */
function activityForTool(name, args = {}) {
  const short = (p) => String(p || '').split('/').pop() || p;
  switch (name) {
    case 'read_file': return { state: 'reading', label: `📖 Reading ${short(args.path)}`, detail: args.path ? `read_file: ${args.path}` : null };
    case 'list_files': return { state: 'reading', label: `📁 Listing ${args.path || '.'}`, detail: null };
    case 'search_project': return { state: 'searching', label: `🔎 Searching project${args.query ? ` for “${String(args.query).slice(0, 40)}”` : ''}`, detail: args.query || null };
    case 'get_project_map': return { state: 'planning', label: '🗺️ Analyzing project structure', detail: null };
    case 'find_relevant_files': return { state: 'searching', label: '🔎 Finding relevant files', detail: null };
    case 'get_project_context': return { state: 'planning', label: '🧩 Building task context', detail: null };
    case 'write_file': return { state: 'editing', label: `✏️ Writing ${short(args.path)}`, detail: args.path || null };
    case 'edit_file': return { state: 'editing', label: `✏️ Editing ${short(args.path)}`, detail: args.path || null };
    case 'run_command': return { state: 'running_command', label: `▶ ${String(args.command || '').slice(0, 60)}`, detail: args.command || null };
    case 'run_tests': return { state: 'running_test', label: `🧪 Running test suite${args.path ? ` (${args.path})` : ''}`, detail: null };
    case 'detect_tests': return { state: 'running_test', label: '🧪 Detecting test setup', detail: null };
    case 'git_status': return { state: 'git_running', label: '⎇ Checking git status', detail: null };
    case 'git_diff': return { state: 'git_running', label: '⎇ Reading git diff', detail: null };
    case 'git_log': return { state: 'git_running', label: '⎇ Reading commit history', detail: null };
    case 'git_commit': return { state: 'git_running', label: '⎇ Proposing commit (needs approval)', detail: null };
    case 'git_add': return { state: 'git_running', label: '⎇ Staging files', detail: null };
    case 'browser_navigate': return { state: 'browser_running', label: `🌐 Opening ${String(args.url || '').slice(0, 50)}`, detail: args.url || null };
    case 'browser_click': return { state: 'browser_running', label: `🌐 Clicking ${short(args.selector)}`, detail: null };
    case 'browser_type': return { state: 'browser_running', label: `🌐 Typing into ${short(args.selector)}`, detail: null };
    case 'browser_screenshot': return { state: 'browser_running', label: '🌐 Capturing screenshot', detail: null };
    case 'browser_errors': return { state: 'browser_running', label: '🌐 Collecting page errors', detail: null };
    case 'browser_close': return { state: 'browser_running', label: '🌐 Closing browser', detail: null };
    default: return null;
  }
}

/** Provider activity: only real provider/model values from the call. */
function activityForProviderStart(provider, model) {
  return {
    state: 'provider_request',
    label: `◉ ${provider || 'provider'}${model ? ` · ${model}` : ''}`,
    detail: 'provider request',
  };
}

function activityForProviderRetry(provider, hint) {
  return {
    state: 'retrying',
    label: `↻ Retrying ${provider || 'provider'}`,
    detail: hint ? `provider asked to retry after ${hint}` : 'bounded retry',
  };
}

function activityForFallback(from, to) {
  return {
    state: 'provider_request',
    label: `↪ Falling back: ${from} → ${to}`,
    detail: 'provider fallback (bounded)',
  };
}

/** Approval is a real state — never shown as "working". */
function activityWaitingApproval(detail) {
  return { state: 'waiting_approval', label: `⏸ Waiting for approval${detail ? ` — ${detail}` : ''}`, detail: detail || null };
}

/** Build a full activity event. Only existing fields are attached. */
function makeEvent({ taskId, agent, tool, provider, model, startedAt, ...activity }) {
  const event = {
    taskId: taskId || null,
    agent: agent || null,
    state: activity.state,
    label: activity.label,
    icon: ICONS[activity.state] || '•',
    ts: new Date().toISOString(),
  };
  if (activity.detail) event.detail = activity.detail;
  if (tool) event.tool = tool;
  if (provider) event.provider = provider;
  if (model) event.model = model;
  if (startedAt) event.elapsedMs = Date.now() - startedAt;
  return event;
}

module.exports = {
  STATES,
  ICONS,
  TERMINAL_STATES,
  activityForTool,
  activityForProviderStart,
  activityForProviderRetry,
  activityForFallback,
  activityWaitingApproval,
  makeEvent,
};
