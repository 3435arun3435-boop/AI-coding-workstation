'use strict';
/**
 * orchestrator.js
 *
 * Multi-Agent Software Team. Given a set of tasks, it runs a controlled team
 * of agents — each role is an agent MODE over the same, single agent loop —
 * with:
 *   - bounded team size (settings.maxAgents) and bounded parallelism
 *     (settings.maxParallel; default 1 = sequential, the conservative default)
 *   - per-child task records (parent/child in the Task Center)
 *   - file-ownership conflict detection after execution (overlapping changed
 *     files between parallel agents are flagged for review, never silently
 *     merged)
 *   - an integration phase: real test run over the combined changes
 *   - an optional Review agent (settings.reviewerRequired)
 *   - evidence-based verdict from the quality evaluator
 *
 * Isolation note (honest): agents share the project workspace; worktree
 * isolation is planned. With the default sequential execution there are no
 * concurrent writes. When parallelism > 1, conflicts are DETECTED and
 * reported rather than hidden.
 */

const { runAgentTask } = require('./agent-loop');
const { runDebugLoop } = require('./debug-loop');
const { runTests, detectTests } = require('./test-intel');
const { evaluate } = require('./evaluator');
const agentsEngine = require('./agents');

const ROLE_BY_MODE = {
  ask: 'Research',
  plan: 'Planning',
  code: 'Coding',
  debug: 'Debug',
  test: 'Testing',
  review: 'Review',
  autonomous: 'Autonomous',
};

/**
 * Run a team. `tasks` = [{ title, mode? }]. Returns the parent result with a
 * `team` array. Never launches more than settings.maxAgents agents.
 */
async function runTeam({
  tasks,
  projectRoot,
  router,
  callFn,
  memory,
  approvals,
  safetyMode,
  onActivity = () => {},
  settings, // SettingsStore
  skills = null,
  agents = null, // agent definitions (default: availableAgents(projectRoot))
  depth = 0, // delegation depth guard
  maxAttempts = 3,
  shouldCancel = null,
  createChildTask = null, // (title, mode, role) => task record (Task Center wiring)
  completeChildTask = null, // (record, result) => void
}) {
  const emit = (state, message) => onActivity({ state, message, ts: new Date().toISOString() });

  const maxAgents = settings ? settings.get('maxAgents') : 3;
  const maxParallel = settings ? Math.max(1, Math.min(settings.get('maxParallel'), maxAgents)) : 1;
  const reviewerRequired = settings ? settings.get('reviewerRequired') : false;

  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { status: 'blocked', summary: 'No tasks provided to the orchestrator.', team: [], report: { result: 'BLOCKED', reason: 'no tasks' } };
  }
  if (tasks.length > maxAgents) {
    return {
      status: 'blocked',
      summary: `Refusing to run ${tasks.length} agents: the configured limit is ${maxAgents} (Settings → Agents).`,
      team: [],
      report: { result: 'BLOCKED', reason: 'team size exceeds configured limit' },
    };
  }

  emit('UNDERSTAND', `Team run: ${tasks.length} agent(s), parallelism ${maxParallel} (limit ${maxAgents})`);

  const team = [];
  const completed = [];

  async function runOne(child, index, handoff = null) {
    const allAgents = agents || agentsEngine.availableAgents(projectRoot);
    const selected = child.agent
      ? (allAgents.find((a) => a.id === child.agent || a.label.toLowerCase() === String(child.agent).toLowerCase()) || null)
      : agentsEngine.selectAgents(child.title, { agents: allAgents })[0];
    const agent = selected || null;
    const role = child.role || (agent ? agent.label : ROLE_BY_MODE[child.mode]) || 'Agent';
    const modeKey = child.mode || (agent ? agent.mode : 'code');
    const record = createChildTask ? createChildTask(child.title, modeKey, role) : null;
    emit('UNDERSTAND', `Agent ${index + 1}/${tasks.length} [${role}] starting: ${child.title}`);
    const runOpts = {
      task: child.title,
      projectRoot,
      router,
      callFn,
      memory,
      safetyMode,
      approvals,
      skills,
      agent,
      onActivity: (e) => onActivity({ ...e, agent: role }),
      shouldCancel,
    };
    // Structured handoff (§39): the previous specialist's findings, files,
    // risks, and evidence arrive as data — not as loose chat text.
    if (handoff) runOpts.advisories = [{ ...agentsEngine.handoffToAdvisory(handoff), label: `Handoff received from ${handoff.agent}` }];
    const result = modeKey === 'autonomous'
      ? await runDebugLoop({ ...runOpts, maxAttempts })
      : await runAgentTask({ ...runOpts, mode: modeKey });
    if (completeChildTask && record) completeChildTask(record, result);
    const entry = {
      role,
      mode: modeKey,
      title: child.title,
      taskId: record ? record.id : null,
      status: result.status,
      summary: result.summary,
      filesChanged: result.filesChanged || [],
      provider: result.provider || null,
      model: result.model || null,
      handoff: agentsEngine.buildHandoff(role, child.title, result),
    };
    team.push(entry);
    completed.push(entry);
    emit('COMPLETE', `Agent ${index + 1}/${tasks.length} [${role}] → ${result.status}${result.filesChanged && result.filesChanged.length ? ` (${result.filesChanged.join(', ')})` : ''}`);
    return entry;
  }

  // Bounded worker pool: maxParallel agents at most. Sequential execution
  // (maxParallel === 1, the default) chains structured handoffs between
  // specialists; parallel execution skips handoffs (no reliable ordering).
  let next = 0;
  const lastHandoff = { current: null };
  async function worker() {
    while (next < tasks.length) {
      if (shouldCancel && shouldCancel()) return;
      const index = next++;
      const handoff = maxParallel === 1 ? lastHandoff.current : null;
      const entry = await runOne(tasks[index], index, handoff);
      lastHandoff.current = agentsEngine.buildHandoff(entry.role, entry.title, { status: entry.status, summary: entry.summary, filesChanged: entry.filesChanged, report: {} });
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxParallel, tasks.length) }, () => worker()));

  const cancelled = team.some((t) => t.status === 'cancelled');
  const blocked = team.some((t) => t.status === 'blocked' || t.status === 'error');

  // --- conflict detection (multi-agent safety, §40) ---------------------------
  // Ownership is per FILE: a second writer of the same file is a conflict even
  // when both agents share a role label. Never silently overwrite teammate work.
  const ownership = new Map();
  const conflicts = [];
  for (const entry of team) {
    for (const f of entry.filesChanged) {
      if (ownership.has(f)) {
        conflicts.push({ file: f, agents: [ownership.get(f), entry.role] });
      } else {
        ownership.set(f, entry.role);
      }
    }
  }
  const conflictPolicy = settings ? settings.get('conflictPolicy') : 'flag';
  if (conflicts.length) {
    const detail = conflicts.map((c) => `${c.file} (${c.agents.join(' vs ')})`).join('; ');
    emit('FIX', `File-ownership CONFLICTS detected: ${detail}`);
    if (conflictPolicy === 'block') {
      emit('FIX', 'conflictPolicy=block → the team result is FAILED pending manual review (no silent overwrite).');
      return {
        status: 'failed',
        summary: `Team result: FAILED — file-ownership conflicts (${detail}). conflictPolicy=block: review and re-run.`,
        filesChanged: Array.from(ownership.keys()),
        team,
        conflicts,
        integrationTests: null,
        review: null,
        report: { result: 'FAILED', team, conflicts, integrationTests: null, review: null, reason: 'conflict policy = block' },
      };
    }
    emit('FIX', `conflictPolicy=flag → conflicts are flagged for review: ${detail}`);
  }

  // --- integration: real test run over the combined changes -------------------
  const detection = detectTests(projectRoot);
  let integrationTests = null;
  if (detection.fullCommand) {
    emit('TEST', `Integration: running ${detection.fullCommand}…`);
    const result = await runTests(projectRoot);
    integrationTests = { ok: result.ok, command: result.command, totals: result.totals };
    emit('TEST', `Integration tests ${result.ok ? 'PASS' : 'FAIL'}: ${result.totals.passed}/${(result.totals.passed || 0) + (result.totals.failed || 0)}`);
  }

  // --- optional review agent ---------------------------------------------------
  let review = null;
  if (reviewerRequired && !cancelled && completed.length) {
    emit('VERIFY', 'Review agent auditing the combined changes…');
    const reviewResult = await runAgentTask({
      task:
        `Review the changes made by the team for this combined task set:\n` +
        completed.map((c) => `- [${c.role}] ${c.title} → ${c.status}; files: ${c.filesChanged.join(', ') || 'none'}`).join('\n') +
        '\nReport findings ordered by severity.',
      projectRoot,
      router,
      callFn,
      memory,
      safetyMode,
      approvals,
      mode: 'review',
      skills,
    });
    review = { status: reviewResult.status, summary: reviewResult.summary };
  }

  // --- verdict ------------------------------------------------------------------
  let verdict = 'PARTIAL';
  if (cancelled) verdict = 'BLOCKED';
  else if (blocked) verdict = 'FAILED';
  else if (team.length === tasks.length && team.every((t) => t.status === 'completed')) {
    verdict = integrationTests ? (integrationTests.ok ? 'VERIFIED' : 'FAILED') : 'PARTIAL';
  }

  const parentStatus = cancelled ? 'cancelled' : verdict === 'VERIFIED' ? 'completed' : verdict === 'FAILED' ? 'failed' : verdict === 'BLOCKED' ? 'blocked' : 'partial';

  return {
    status: parentStatus,
    summary:
      `Team result: ${verdict}. ${team.map((t) => `[${t.role}] ${t.status}`).join(', ')}.` +
      (integrationTests ? ` Integration tests: ${integrationTests.ok ? 'PASS' : 'FAIL'}.` : '') +
      (conflicts.length ? ` ${conflicts.length} file-ownership conflict(s) flagged.` : ''),
    filesChanged: Array.from(new Set(team.flatMap((t) => t.filesChanged))),
    team,
    conflicts,
    integrationTests,
    review,
    report: { result: verdict, team, conflicts, integrationTests, review },
  };
}

module.exports = { runTeam, ROLE_BY_MODE };
