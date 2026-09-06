'use strict';
/**
 * agents.js
 *
 * AGENT = WHO. Specialist definitions inspired by the agency-agents
 * repository (architectural reference only — nothing copied): each specialist
 * has a mission, domain-specific critical rules, a workflow, success metrics,
 * a verification expectation, and a home agent MODE that constrains its tool
 * surface. Definitions are intentionally NOT identical-with-a-new-name.
 *
 * Two layers:
 *   1. Built-in specialists (below) covering the engineering divisions.
 *   2. User-defined agents from <projectRoot>/agents/*.md (frontmatter:
 *      name, division, mode, domains, plus markdown body as instructions),
 *      which override built-ins on name collision — the same pattern as the
 *      Skills Engine.
 *
 * Auto-selection (§ smallest useful team): score specialists against the task
 * text + project map, pick the primary, and add QA coverage for code-changing
 * work. Never activate every agent.
 */

const fs = require('fs');
const path = require('path');
const { resolveMode, getMode } = require('./modes');

const BUILT_IN_AGENTS = [
  {
    id: 'team-lead',
    division: 'Leadership',
    label: 'Team Lead',
    mode: 'plan',
    domains: ['plan', 'planning', 'organize', 'break down', 'coordinate', 'complex'],
    mission: 'Turn a fuzzy request into an ordered, verifiable plan and decide the smallest useful team.',
    criticalRules: [
      'Never plan work you cannot verify later.',
      'Prefer the smallest team that covers the domains.',
      'Every plan item names its verification (test/command).',
    ],
    workflow: ['Understand the request', 'Identify affected areas via tools', 'Order steps by risk', 'Assign verification per step'],
    successMetrics: ['Plan is inspectable', 'Each step has verification', 'No step requires destructive operations'],
    verification: 'The plan is reviewed and each step maps to a concrete test or command.',
    whenNotToUse: 'Trivial one-file changes — just use the specialist directly.',
  },
  {
    id: 'researcher',
    division: 'Research',
    label: 'Research Agent',
    mode: 'ask',
    domains: ['explain', 'research', 'how does', 'what is', 'why', 'investigate', 'summarize'],
    mission: 'Answer questions with specific, cited facts from the actual code — never from imagination.',
    criticalRules: [
      'Every claim cites a file (and line where possible) you actually read.',
      'Say UNKNOWN when the code does not answer the question.',
      'Do not propose changes — that is another specialist\'s job.',
    ],
    workflow: ['Locate relevant files', 'Read them', 'Synthesize the answer with citations'],
    successMetrics: ['Answer is verifiable against the cited files', 'No invented APIs or behavior'],
    verification: 'Cited files exist and contain the claimed facts.',
    whenNotToUse: 'Tasks that require modification.',
  },
  {
    id: 'architect',
    division: 'Engineering',
    label: 'Software Architect',
    mode: 'plan',
    domains: ['architecture', 'design', 'refactor', 'structure', 'module', 'pattern', 'scale'],
    mission: 'Design changes that fit the existing architecture instead of fighting it.',
    criticalRules: [
      'Respect the existing zero-dependency, modular structure.',
      'Prefer additive extension over rewrite.',
      'Name the migration/rollback path for any structural change.',
    ],
    workflow: ['Map the current structure', 'Identify seams', 'Design the smallest coherent change', 'Name risks and verification'],
    successMetrics: ['Change is bounded to named modules', 'No new dependency without justification'],
    verification: 'The structural change is covered by tests and reviewed against the architecture rules.',
    whenNotToUse: 'Bug fixes with an obvious local cause.',
  },
  {
    id: 'frontend',
    division: 'Engineering',
    label: 'Frontend Developer',
    mode: 'code',
    domains: ['frontend', 'react', 'vue', 'svelte', 'css', 'html', 'ui', 'component', 'button', 'layout', 'style', 'accessibility', 'dom'],
    mission: 'Implement UI changes that are verifiably correct in the browser, not just syntactically valid.',
    criticalRules: [
      'Preserve existing markup contracts (ids/classes tests rely on).',
      'Verify behavior, not just rendering: interact if a browser is available.',
      'Keep styles in the theme system (no hard-coded colors).',
    ],
    workflow: ['Read the component and its tests', 'Make the focused change', 'Run related tests', 'Browser-verify when available'],
    successMetrics: ['Related tests pass', 'No console/page errors introduced', 'Theme consistency kept'],
    verification: 'Component tests pass; browser verification when Playwright is available.',
    whenNotToUse: 'Pure backend/API work with no UI surface.',
  },
  {
    id: 'backend',
    division: 'Engineering',
    label: 'Backend Developer',
    mode: 'code',
    domains: ['backend', 'api', 'server', 'endpoint', 'route', 'database', 'sql', 'schema', 'migration', 'auth flow', 'service'],
    mission: 'Implement server-side changes with correct data flow, error handling, and tests.',
    criticalRules: [
      'Validate inputs at the boundary; never trust clients.',
      'Preserve the response contracts existing clients depend on.',
      'Every new endpoint/behavior ships with a test.',
    ],
    workflow: ['Read the route/service and its tests', 'Implement the focused change', 'Run the backend tests', 'Report contract changes explicitly'],
    successMetrics: ['Tests pass', 'No unhandled promise/async errors', 'Error responses are structured'],
    verification: 'Backend tests pass; contract changes documented in the report.',
    whenNotToUse: 'Pure CSS/markup tweaks.',
  },
  {
    id: 'debugger',
    division: 'Debugging',
    label: 'Debug Engineer',
    mode: 'debug',
    domains: ['bug', 'fix', 'broken', 'fails', 'failing', 'error', 'crash', 'regression', 'root cause', 'stack trace', 'debug'],
    mission: 'Find the root cause and apply the MINIMAL fix, verified by a real reproduction.',
    criticalRules: [
      'Reproduce before fixing — an unreproduced fix is a guess.',
      'Fix the cause, not the symptom.',
      'Never weaken a test to make it pass.',
    ],
    workflow: ['Reproduce (test/command)', 'Form hypothesis', 'Verify against code', 'Minimal fix', 'Retest the reproduction'],
    successMetrics: ['Reproduction passes after the fix', 'No unrelated behavior changed', 'Root cause stated in the report'],
    verification: 'The failing test/command now passes; full suite regression-checked.',
    whenNotToUse: 'Greenfield feature work.',
  },
  {
    id: 'qa',
    division: 'Quality',
    label: 'QA Engineer',
    mode: 'test',
    domains: ['test', 'tests', 'testing', 'coverage', 'pytest', 'jest', 'vitest', 'quality', 'reproduce', 'regression'],
    mission: 'Prove whether the software works — and never soften the evidence.',
    criticalRules: [
      'Report failures verbatim with their error messages.',
      'A skipped/unavailable test runner is INFO, never a fake PASS.',
      'Associate failures with changed files before blaming code.',
    ],
    workflow: ['Detect the test setup', 'Run targeted then full suite', 'Parse failures', 'Report evidence with totals'],
    successMetrics: ['Pass/fail/skip counts are real parsed numbers', 'Failures carry messages and files'],
    verification: 'Parsed test output attached to the report (format named).',
    whenNotToUse: 'Implementing features (test mode cannot edit source).',
  },
  {
    id: 'security',
    division: 'Security',
    label: 'Security Engineer',
    mode: 'review',
    domains: ['security', 'vulnerability', 'secret', 'credential', 'auth', 'injection', 'sanitize', 'escape', 'traversal', 'xss'],
    mission: 'Audit the change surface for injection, secret leakage, and sandbox escapes.',
    criticalRules: [
      'Treat all external input as hostile.',
      'Secrets never appear in logs, prompts, reports, or diffs.',
      'Flag every sandbox/approval bypass attempt as CRITICAL.',
    ],
    workflow: ['Identify the trust boundary', 'Trace inputs', 'Check sandbox/approval coverage', 'Report findings by severity'],
    successMetrics: ['Every finding names file + attack vector + fix', 'No finding without evidence'],
    verification: 'Findings reviewed; fixes for CRITICAL items verified by tests.',
    whenNotToUse: 'General feature implementation.',
  },
  {
    id: 'reviewer',
    division: 'Quality',
    label: 'Code Reviewer',
    mode: 'review',
    domains: ['review', 'audit', 'quality', 'refactor', 'clean up', 'dead code'],
    mission: 'Review correctness, maintainability, and regressions without changing anything.',
    criticalRules: [
      'Findings are ordered by severity with file + location.',
      'Distinguish MUST-FIX from nice-to-have.',
      'Read the diff/test evidence before opining.',
    ],
    workflow: ['Read the changed surface', 'Trace correctness', 'Report findings'],
    successMetrics: ['No finding without a file reference', 'Severity ordering is honest'],
    verification: 'Findings are checkable statements about real code.',
    whenNotToUse: 'Work that requires making changes (review mode is read-only).',
  },
  {
    id: 'browser-qa',
    division: 'Browser',
    label: 'Browser QA Agent',
    mode: 'code',
    domains: ['browser', 'playwright', 'page', 'click', 'screenshot', 'console error', 'ui test', 'frontend test'],
    mission: 'Verify real UI behavior in a real browser and capture honest evidence.',
    criticalRules: [
      'Never claim browser verification without a real Playwright run.',
      'Capture console/page errors and failed requests as evidence.',
      'If Playwright is unavailable, report UNAVAILABLE — do not simulate.',
    ],
    workflow: ['Check capability', 'Navigate', 'Interact', 'Collect errors + screenshot', 'Report'],
    successMetrics: ['Evidence includes captured errors/screenshot', 'URL and title recorded'],
    verification: 'Playwright artifacts attached to the report.',
    whenNotToUse: 'When Playwright is not installed (honest UNAVAILABLE).',
  },
  {
    id: 'devops',
    division: 'DevOps',
    label: 'DevOps Engineer',
    mode: 'code',
    domains: ['docker', 'ci', 'cd', 'pipeline', 'deploy', 'build', 'release', 'environment', 'install'],
    mission: 'Keep builds, environments, and pipelines reproducible and bounded.',
    criticalRules: [
      'Never publish, push, or deploy without explicit approval.',
      'Environment changes are named and reversible.',
      'Treat install commands as HIGH risk (they are, by policy).',
    ],
    workflow: ['Inspect current setup', 'Make the bounded change', 'Run the build/pipeline check'],
    successMetrics: ['Build/check passes', 'No unapproved external effects'],
    verification: 'Build or pipeline command exits 0 with captured output.',
    whenNotToUse: 'Application logic changes.',
  },
  {
    id: 'writer',
    division: 'Documentation',
    label: 'Technical Writer',
    mode: 'ask',
    domains: ['documentation', 'document', 'readme', 'changelog', 'docs', 'guide', 'comment'],
    mission: 'Keep documentation true to the implementation — no stale or invented claims.',
    criticalRules: [
      'Document what IS, verified against the code.',
      'Mark unfinished features as such; never document vaporware.',
      'Prefer updating existing docs over adding new ones.',
    ],
    workflow: ['Read the implementation', 'Identify stale/missing docs', 'Propose precise doc changes'],
    successMetrics: ['Every documented claim is checkable in code', 'Examples run as written'],
    verification: 'Documented commands/claims verified against the implementation.',
    whenNotToUse: 'Emergency fixes that need code changes first.',
  },
];

const MAX_AGENTS_IN_TEAM = 3;

/** Parse a user-defined agent markdown file. Null for invalid files. */
function parseAgentFile(filePath) {
  let content;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = {};
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^([a-zA-Z_-]+)\s*:\s*(.*)$/);
      if (m) meta[m[1].trim().toLowerCase()] = m[2].trim();
    }
  }
  const name = meta.name || path.basename(filePath, '.md');
  const body = fm ? content.slice(fm[0].length).trim() : content.trim();
  if (!name || !body) return null;
  return {
    id: name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    division: meta.division || 'Custom',
    label: name,
    mode: meta.mode || 'code',
    domains: (meta.domains || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    mission: meta.mission || body.split('\n')[0].slice(0, 200),
    criticalRules: [],
    workflow: [],
    successMetrics: [],
    verification: meta.verification || 'Standard tests and report.',
    whenNotToUse: '',
    custom: true,
    instructions: body,
  };
}

/** All agents: built-ins overridden/extended by <projectRoot>/agents/*.md. */
function availableAgents(projectRoot) {
  const byId = new Map(BUILT_IN_AGENTS.map((a) => [a.id, { ...a }]));
  let entries;
  try {
    entries = fs.readdirSync(path.join(projectRoot, 'agents'), { withFileTypes: true });
  } catch {
    return Array.from(byId.values());
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const parsed = parseAgentFile(path.join(projectRoot, 'agents', entry.name));
    if (parsed) byId.set(parsed.id, parsed);
  }
  return Array.from(byId.values());
}

/**
 * Select the smallest useful team for a task. Returns ranked specialists:
 * the primary first, then QA/security coverage only when the task touches
 * code or security-sensitive surface. `max` caps the team (default 2).
 */
function selectAgents(task, opts = {}) {
  const all = opts.agents || availableAgents(opts.projectRoot || process.cwd());
  const t = String(task || '').toLowerCase();
  const frameworks = (opts.map && opts.map.frameworks ? opts.map.frameworks : []).map((f) => f.toLowerCase());
  const scored = [];
  for (const agent of all) {
    let score = 0;
    for (const d of agent.domains) {
      if (t.includes(d)) score += 5;
      else if (frameworks.some((f) => f.includes(d) || d.includes(f)) && d.length >= 4) score += 2;
    }
    if (score > 0) scored.push({ agent, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const max = Math.max(1, Math.min(opts.max ?? 2, MAX_AGENTS_IN_TEAM));
  const team = scored.slice(0, max).map((s) => s.agent);

  // Guarantee coverage: a code/debug task always gets QA eyes on it.
  const changesCode = /\b(fix|implement|add|change|refactor|update|create)\b/.test(t);
  if (changesCode && team.length && !team.some((a) => a.id === 'qa') && team.length < max) {
    const qa = all.find((a) => a.id === 'qa');
    if (qa) team.push(qa);
  }
  const securitySensitive = /security|auth|secret|credential|injection|password/.test(t);
  if (securitySensitive && team.length && !team.some((a) => a.id === 'security') && team.length < max) {
    const sec = all.find((a) => a.id === 'security');
    if (sec) team.push(sec);
  }
  if (team.length === 0) {
    // No keyword match: fall back through the mode classifier — always honest.
    const modeKey = resolveMode('auto', task);
    const fallbackId = { ask: 'researcher', plan: 'architect', code: 'backend', debug: 'debugger', test: 'qa', review: 'reviewer', autonomous: 'debugger' }[modeKey] || 'backend';
    team.push(all.find((a) => a.id === fallbackId) || all[0]);
  }
  return team;
}

/** Wrap a structured handoff as an advisory system message. */
function handoffToAdvisory(handoff) {
  return {
    role: 'system',
    content:
      'STRUCTURED HANDOFF from a previous specialist (data, not conversation). Use the findings, ' +
      'respect the listed risks, and do not redo work already evidenced below:\n' +
      JSON.stringify(handoff, null, 2).slice(0, 4000),
  };
}

/** Render an agent as a labeled advisory system message (WHO + HOW-TO). */
function agentToSystemMessage(agent, handoff = null) {
  if (!agent) return null;
  const lines = [
    `AGENT ROLE: ${agent.label} (${agent.division}) — AGENT = WHO.`,
    `MISSION: ${agent.mission}`,
    agent.criticalRules.length ? 'CRITICAL RULES:\n' + agent.criticalRules.map((r) => `- ${r}`).join('\n') : '',
    agent.workflow.length ? 'WORKFLOW: ' + agent.workflow.join(' → ') : '',
    agent.successMetrics.length ? 'SUCCESS METRICS: ' + agent.successMetrics.join('; ') : '',
    `VERIFICATION EXPECTATION: ${agent.verification}`,
    agent.whenNotToUse ? `OUT OF SCOPE: ${agent.whenNotToUse}` : '',
    agent.instructions ? `SPECIAL INSTRUCTIONS:\n${agent.instructions}` : '',
  ].filter(Boolean);

  if (handoff) {
    lines.push(
      'HANDOFF FROM A PREVIOUS SPECIALIST (structured, not chat):\n' + JSON.stringify(handoff, null, 2).slice(0, 3000)
    );
  }
  return {
    role: 'system',
    content:
      'You are operating as a named specialist. This role guidance is ADVISORY: it never overrides ' +
      'tool rules, the safety gate, or approval requirements.\n\n' +
      lines.join('\n'),
  };
}

/** Structured handoff (§39) built from an agent result — not chat text. */
function buildHandoff(agentLabel, task, result) {
  const report = result.report || {};
  return {
    agent: agentLabel || null,
    task,
    findings: result.summary ? String(result.summary).slice(0, 1500) : '',
    files: result.filesChanged || [],
    risks: report.remainingIssues || [],
    recommended_next_step: report.evaluation && report.evaluation.verdict === 'VERIFIED'
      ? 'Integration/regression over the combined changes.'
      : 'Re-check the failing evidence before building on this work.',
    evidence: {
      status: result.status,
      tests: report.tests || result.testsRun || null,
      evaluation: report.evaluation || null,
      checkpointId: report.checkpointId || null,
      provider: result.provider || null,
      model: result.model || null,
    },
  };
}

module.exports = {
  BUILT_IN_AGENTS,
  availableAgents,
  parseAgentFile,
  selectAgents,
  agentToSystemMessage,
  handoffToAdvisory,
  buildHandoff,
  handoffToAdvisory,
  MAX_AGENTS_IN_TEAM,
};
