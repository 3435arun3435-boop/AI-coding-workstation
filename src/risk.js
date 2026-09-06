'use strict';
/**
 * risk.js
 *
 * Risk classification for tools and shell commands, used by the approval
 * gate. Levels (per spec):
 *   LOW      — read-only operations
 *   MEDIUM   — source modifications, ordinary project commands
 *   HIGH     — package/system modification, destructive git ops, deletions
 *   CRITICAL — clearly destructive/irreversible operations (rm -rf, sudo,
 *              hard resets, database drops, piping remote scripts to shell)
 *
 * Defaults are conservative for anything that matches a dangerous pattern
 * and MEDIUM for ordinary commands (running tests/builds stays frictionless
 * in normal safety modes while genuinely destructive things never run
 * without explicit approval).
 */

const LEVELS = ['low', 'medium', 'high', 'critical'];

// Ordered: first match wins. Regexes run against the full command string.
const COMMAND_RULES = [
  { level: 'critical', re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\*)(\s|$)/, reason: 'recursive/forced delete at a broad path' },
  { level: 'critical', re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/, reason: 'forced recursive delete' },
  { level: 'critical', re: /\b(sudo|su)\s/, reason: 'superuser elevation' },
  { level: 'critical', re: /\bdd\s+if=/, reason: 'raw disk write' },
  { level: 'critical', re: /\bmkfs|\bdiskutil\s+erase/, reason: 'filesystem format' },
  { level: 'critical', re: /\bgit\s+reset\s+--hard/, reason: 'git hard reset discards changes' },
  { level: 'critical', re: /\bgit\s+clean\s+-[a-zA-Z]*[fdx]/, reason: 'git clean discards untracked files' },
  { level: 'critical', re: /\bgit\s+push\s+(--force|--force-with-lease|-f)\b/, reason: 'force push rewrites remote history' },
  { level: 'critical', re: /\bgit\s+(checkout|restore)\s*-{0,2}\s*\.?\s*(\.)(\s|$)/, reason: 'discards working-tree changes' },
  { level: 'critical', re: /\b(drop\s+(database|table)|truncate\s+table)\b/i, reason: 'destructive database operation' },
  { level: 'critical', re: /\b(shutdown|reboot|halt|poweroff)\b/, reason: 'system power operation' },
  { level: 'critical', re: /\bkill\s+-9\s+1\b|\bkillall\b/, reason: 'process termination outside the project' },
  { level: 'critical', re: /(curl|wget)[^|]*\|\s*(ba)?sh\b/, reason: 'pipes a remote script into a shell' },
  { level: 'critical', re: /\bchmod\s+-R\s+777\b/, reason: 'grants world-writable access recursively' },
  { level: 'critical', re: /\bnpm\s+publish\b/, reason: 'publishes a package publicly' },

  { level: 'high', re: /\brm\b/, reason: 'deletes files' },
  { level: 'high', re: /\b(npm|yarn|pnpm)\s+(install|i|add|remove|update|upgrade)\b/, reason: 'modifies package dependencies' },
  { level: 'high', re: /\bpip3?\s+install\b/, reason: 'modifies python dependencies' },
  { level: 'high', re: /\bgit\s+push\b/, reason: 'pushes to a remote' },
  { level: 'high', re: /\bgit\s+commit\b/, reason: 'creates a commit' },
  { level: 'high', re: /\bgit\s+branch\s+-D\b|\bgit\s+rebase\b|\bgit\s+cherry-pick\b/, reason: 'rewrites local branch state' },
  { level: 'high', re: /\b(git\s+)?(checkout|restore)\b/, reason: 'changes working tree state' },  { level: 'high', re: /\bkill\s+-9\b/, reason: 'force-kills a process' },
  { level: 'high', re: /\bdocker\s+(system\s+prune|rm|rmi)\b/, reason: 'removes docker resources' },
  { level: 'high', re: /\bdropdb\b|\bcreatedb\b|\bmysql\b|\bpsql\b/, reason: 'direct database client' },
  { level: 'high', re: /\bmv\b.*(\.git|node_modules)\b/, reason: 'moves protected paths' },

  { level: 'medium', re: /\bgit\s+(add|stash|switch|tag)\b/, reason: 'stages or stashes changes' },
  { level: 'medium', re: /\b(mkdir|cp|mv|touch|tee)\b/, reason: 'creates or moves files' },
  { level: 'medium', re: /\b(npm|yarn|pnpm)\s+(run|exec)\b/, reason: 'runs a package script' },
  { level: 'medium', re: /\b(git\s+)?init\b/, reason: 'initializes a repository' },
];

const LOW_GIT = /\bgit\s+(status|log|diff|show|branch|remote|config\s+--get|rev-parse)\b/;
const LOW_GENERIC = /\b(ls|cat|head|tail|grep|find|which|whoami|pwd|echo|node\s+--version|node\s+--test|python3?\s+--version|npm\s+test|npm\s+run\s+test|npx\s+vitest\s+run|npx\s+jest)\b/;

/**
 * Classify a shell command. Returns { level, reason }.
 */
function classifyCommandRisk(command) {
  const cmd = String(command || '');
  for (const rule of COMMAND_RULES) {
    if (rule.re.test(cmd)) return { level: rule.level, reason: rule.reason };
  }
  if (LOW_GIT.test(cmd)) return { level: 'low', reason: 'read-only git query' };
  if (LOW_GENERIC.test(cmd)) return { level: 'low', reason: 'read-only command' };
  return { level: 'medium', reason: 'arbitrary shell command' };
}

/**
 * Classify a tool call. Returns { level, reason }.
 * args is the parsed argument object (may be undefined).
 */
function classifyToolRisk(tool, args = {}) {
  switch (tool) {
    case 'list_files':
    case 'read_file':
    case 'search_project':
    case 'get_project_map':
    case 'find_relevant_files':
    case 'get_project_context':
    case 'git_status':
    case 'git_diff':
    case 'git_log':
      return { level: 'low', reason: 'read-only operation' };
    case 'write_file':
    case 'edit_file':
      return { level: 'medium', reason: 'modifies project files' };
    case 'run_command':
      return classifyCommandRisk(args.command);
    case 'run_tests':
      return { level: 'medium', reason: 'executes the project test suite' };
    case 'git_commit':
      return { level: 'high', reason: 'creates a git commit' };
    case 'git_add':
      return { level: 'medium', reason: 'stages files' };
    default:
      return { level: 'medium', reason: 'unclassified tool' };
  }
}

module.exports = { classifyCommandRisk, classifyToolRisk, COMMAND_RULES, LEVELS };
