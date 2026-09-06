#!/usr/bin/env node
'use strict';
/**
 * cli.js
 *
 * Command-line entry point. Uses the SAME services as server.js —
 * runAgentTask / runDebugLoop / ProviderRouter / project-intel / test-intel /
 * git / approvals / memory — so there is one implementation of every
 * capability, not a CLI-only duplicate.
 *
 * Usage:
 *   node cli.js run "<task>" [--project <path>] [--mode ask|code|debug|test|review|autonomous|auto]
 *   node cli.js analyze [--project <path>]
 *   node cli.js providers
 *   node cli.js models <providerId>
 *   node cli.js tasks
 *   node cli.js tests [--target <file>]
 *   node cli.js git
 *   node cli.js modes
 *   node cli.js tools
 *   node cli.js doctor
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { runAgentTask } = require('./src/agent-loop');
const { TOOL_NAMES } = require('./src/agent-tools');
const { runDebugLoop } = require('./src/debug-loop');
const { ProviderRouter, detectOllama, listModels } = require('./src/providers');
const { ConfigStore, SAFETY_MODES } = require('./src/config');
const { MemoryStore } = require('./src/memory');
const { TaskStore } = require('./src/tasks');
const { ApprovalStore } = require('./src/approvals');
const { analyzeProject } = require('./src/project-intel');
const { detectTests, runTests } = require('./src/test-intel');
const git = require('./src/git');
const { MODES, MODE_KEYS, resolveMode } = require('./src/modes');
const { browserStatus } = require('./src/browser');
const { availableSkills, matchSkills } = require('./src/skills');
const { SettingsStore } = require('./src/settings');
const { runDoctor } = require('./src/doctor');
const agentsEngine = require('./src/agents');
const { CheckpointStore } = require('./src/checkpoints');
const { KnowledgeStore } = require('./src/knowledge');
const { runTeam } = require('./src/orchestrator');
const { evaluate } = require('./src/evaluator');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { _: [], project: process.cwd() };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--project') opts.project = path.resolve(rest[++i]);
    else if (rest[i] === '--mode') opts.mode = rest[++i];
    else if (rest[i] === '--target') opts.target = rest[++i];
    else if (rest[i] === '--tasks') opts.tasks = rest[++i];
    else if (rest[i] === '--parallel') opts.parallel = rest[++i];
    else if (rest[i] === '--files') opts.files = rest[++i];
    else opts._.push(rest[i]);
  }
  return { command, opts };
}

function services(opts) {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), '.coding-agent');
  const config = new ConfigStore(dataDir);
  const memory = new MemoryStore(dataDir);
  const tasks = new TaskStore(dataDir);
  const approvals = new ApprovalStore(dataDir);
  const settings = new SettingsStore(dataDir);
  const projectRoot = opts && opts.project ? opts.project : process.cwd();
  return { dataDir, config, memory, tasks, approvals, settings, projectRoot };
}

function printProvider({ p, health }) {
  const kind = p.local ? 'LOCAL' : p.apiKeySet ? 'free-tier/key' : 'NO KEY';
  const h = health ? (health.inCooldown ? `cooldown ${Math.ceil(health.cooldownRemainingMs / 1000)}s` : health.healthy ? 'ok' : 'untested') : '';
  const usage = health && health.usage && health.usage.requests ? `${health.usage.requests} req` : '';
  console.log(`  ${p.enabled !== false ? '●' : '○'} ${p.id}  [${kind}]  model: ${p.model || '(none)'}  priority: ${p.priority ?? 100}  ${h} ${usage}`);
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  const s = services(opts);

  switch (command) {
    case 'tools':
      console.log('Registered tools (surface depends on agent mode):');
      for (const name of TOOL_NAMES) console.log(`  - ${name}`);
      return;

    case 'modes':
      console.log('Agent modes:');
      for (const key of MODE_KEYS) console.log(`  ${key.padEnd(12)} ${MODES[key].description}`);
      console.log(`\nSafety modes (config): ${SAFETY_MODES.join(', ')} — current: ${s.config.getSafetyMode()}`);
      return;

    case 'run': {
      const task = opts._.join(' ');
      if (!task) {
        console.error('Usage: node cli.js run "<task description>" [--project <path>] [--mode <mode>]');
        process.exitCode = 1;
        return;
      }
      if (!fs.existsSync(s.projectRoot)) {
        console.error(`Project path does not exist: ${s.projectRoot}`);
        process.exitCode = 1;
        return;
      }
      const modeKey = resolveMode(opts.mode, task);
      const router = new ProviderRouter(s.config.listProviders());
      const record = s.tasks.create({ title: task, project: path.basename(s.projectRoot), mode: modeKey });
      console.log(`Task ${record.id.slice(0, 8)} — mode: ${modeKey} (safety: ${s.config.getSafetyMode()})`);

      const runOpts = {
        task,
        projectRoot: s.projectRoot,
        router,
        memory: s.memory,
        safetyMode: s.config.getSafetyMode(),
        approvals: s.approvals,
        taskId: record.id,
        shouldCancel: () => s.tasks.isCancelled(record.id),
        onActivity: (event) => console.log(`  [${event.state}] ${event.message}`),
      };
      // Interactive approval decisions from the terminal.
      const readline = require('readline');
      s.approvals.on('pending', (proposal) => {
        console.log(`\n  ⏸ APPROVAL NEEDED (risk: ${proposal.risk.level}): ${proposal.title}`);
        if (proposal.diff) console.log(proposal.diff);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('  Approve? [y/N] ', async (answer) => {
          rl.close();
          try {
            const decided = await s.approvals.decide(proposal.id, /^y(es)?$/i.test(answer) ? 'approved' : 'rejected');
            console.log(`  → ${decided.status}`);
          } catch (e) {
            console.log(`  → ${e.message}`);
          }
        });
      });

      const result = modeKey === 'autonomous'
        ? await runDebugLoop(runOpts)
        : await runAgentTask({ ...runOpts, mode: modeKey });

      s.tasks.complete(record.id, {
        status: result.status, filesChanged: result.filesChanged, testsRun: result.testsRun,
        summary: result.summary, provider: result.provider, model: result.model,
      });

      console.log('\n--- Result ---');
      console.log(`Status: ${result.status}${result.report ? ` (${result.report.result})` : ''}`);
      console.log(`Files changed: ${result.filesChanged.join(', ') || '(none)'}`);
      console.log(`Summary: ${result.summary}`);
      process.exitCode = ['error', 'failed', 'blocked'].includes(result.status) ? 1 : 0;
      return;
    }

    case 'analyze': {
      if (!fs.existsSync(s.projectRoot)) {
        console.error(`Project path does not exist: ${s.projectRoot}`);
        process.exitCode = 1;
        return;
      }
      const map = analyzeProject(s.projectRoot, { refresh: true });
      console.log(`Project: ${map.projectType}`);
      console.log(`Languages: ${map.languages.map((l) => `${l.language}(${l.files})`).join(', ') || 'none detected'}`);
      console.log(`Frameworks: ${map.frameworks.join(', ') || 'none detected'}`);
      console.log(`Package manager: ${map.packageManager || 'n/a'}`);
      console.log(`Entry points: ${map.entrypoints.join(', ') || 'none detected'}`);
      console.log(`Tests: ${map.testFramework || 'none detected'} (${map.testFiles.length} files)`);
      console.log(`Git repo: ${map.isGitRepo ? 'yes' : 'no'}`);
      console.log(`Run commands: ${map.commands.run.join(' | ') || 'n/a'}`);
      console.log(`Test commands: ${map.commands.test.join(' | ') || 'n/a'}`);
      console.log(`Files scanned: ${map.fileCount}`);
      return;
    }

    case 'providers': {
      const router = new ProviderRouter(s.config.listProviders());
      const snap = new Map(router.snapshot().map((x) => [x.id, x]));
      const providers = s.config.listProvidersMasked().map((p) => ({ p, health: snap.get(p.id) }));
      console.log('Configured providers (keys are masked; full keys never leave config.json):');
      for (const entry of providers) printProvider(entry);
      const ollama = await detectOllama();
      console.log(`\nOllama at ${ollama.baseUrl}: ${ollama.available ? `AVAILABLE (${ollama.models.length} models)` : 'OFFLINE'} — run 'node cli.js models' after refresh-local in the UI, or configure manually.`);
      return;
    }

    case 'models': {
      const id = opts._[0];
      if (!id) {
        console.error('Usage: node cli.js models <providerId>');
        process.exitCode = 1;
        return;
      }
      const provider = s.config.listProviders().find((p) => p.id === id);
      if (!provider) {
        console.error(`Unknown provider: ${id}`);
        process.exitCode = 1;
        return;
      }
      const result = await listModels(provider);
      if (!result.ok) {
        console.error(`Could not list models: ${result.error}`);
        process.exitCode = 1;
        return;
      }
      console.log(`${id} models:\n  ${result.models.join('\n  ') || '(none)'}`);
      return;
    }

    case 'tasks': {
      const tasks = s.tasks.list(20);
      if (!tasks.length) return console.log('No tasks recorded.');
      for (const t of tasks) {
        console.log(`${t.id.slice(0, 8)}  ${t.status.padEnd(10)} ${t.mode || '-'}  ${t.title.slice(0, 60)}`);
      }
      return;
    }

    case 'tests': {
      const detection = detectTests(s.projectRoot);
      if (!detection.hasTests) {
        console.log('No tests detected for this project.');
        return;
      }
      console.log(`Framework: ${detection.framework || 'unknown'}`);
      console.log(`Running: ${opts.target ? detection.targetTemplate.replace('{file}', opts.target) : detection.fullCommand}…\n`);
      const result = await runTests(s.projectRoot, { target: opts.target });
      const t = result.totals || {};
      console.log(`${result.ok ? 'PASS' : 'FAIL'} (${result.durationMs}ms, exit ${result.exitCode}) — ${t.passed ?? '?'} passed, ${t.failed ?? '?'} failed, ${t.skipped ?? 0} skipped [parsed: ${result.parsedFormat}]`);
      for (const f of result.failures.slice(0, 10)) {
        console.log(`  ✕ ${f.name}${f.file ? ` (${f.file})` : ''}`);
        if (f.message) console.log(`      ${f.message.split('\n')[0].slice(0, 160)}`);
      }
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    case 'git': {
      const st = await git.status(s.projectRoot);
      if (!st.isRepo) return console.log('Not a git repository.');
      console.log(`Branch: ${st.branch}${st.upstream ? ` → ${st.upstream}` : ''}${st.clean ? ' (clean)' : ''}`);
      for (const x of st.staged) console.log(`  staged    ${x.code} ${x.path}`);
      for (const x of st.unstaged) console.log(`  unstaged  ${x.code} ${x.path}`);
      for (const x of st.untracked) console.log(`  untracked ? ${x}`);
      const log = await git.log(s.projectRoot, { limit: 5 });
      console.log('\nRecent commits:');
      for (const c of log.commits) console.log(`  ${c.hash} ${c.subject} (${c.author})`);
      return;
    }

    case 'doctor': {
      console.log('AI WORKSTATION DOCTOR\n');
      const report = await runDoctor({ projectRoot: fs.existsSync(s.projectRoot) ? s.projectRoot : null, dataDir: s.dataDir, config: s.config });
      for (const c of report.checks) {
        console.log(`  ${c.status.padEnd(6)} ${c.name.padEnd(18)} ${c.detail}`);
      }
      console.log(`\n  Overall: ${report.ok ? 'OK (no FAIL checks)' : 'PROBLEMS FOUND'} — ${report.ranAt}`);
      console.log('  Data directory:', s.dataDir);
      if (!report.ok) process.exitCode = 1;
      return;
    }

    case 'skills': {
      const all = availableSkills(s.projectRoot);
      if (!all.length) {
        console.log('No skills found. Add skills/<name>/skill.md to the project (or ~/.coding-agent/skills/).');
        return;
      }
      console.log(`Available skills (${all.length}):`);
      for (const skill of all) {
        console.log(`  🧩 ${skill.name}${skill.modes.length ? ` [${skill.modes.join('/')}]` : ''} — ${skill.description || '(no description)'}`);
      }
      const taskText = opts._.join(' ');
      if (taskText) {
        const matched = matchSkills(s.projectRoot, taskText);
        console.log(`\nMatching "${taskText}": ${matched.length ? matched.map((m) => m.name).join(', ') : 'no relevant skills (nothing forced into context)'}`);
      }
      return;
    }

    case 'agents': {
      const all = agentsEngine.availableAgents(s.projectRoot);
      console.log(`Available specialists (${all.length}) — AGENT = WHO:`);
      for (const a of all) {
        console.log(`  • ${a.label} [${a.division}] mode: ${a.mode} — ${String(a.mission || '').slice(0, 90)}`);
      }
      const taskText = opts._.join(' ');
      if (taskText) {
        const team = agentsEngine.selectAgents(taskText, { agents: all });
        console.log(`
Smallest useful team for "${taskText}": ${team.map((a) => a.label).join(' + ') || 'none'}`);
      }
      return;
    }

    case 'teams': {
      const raw = String(opts.tasks || '').split(';;').map((t) => t.trim()).filter(Boolean);
      if (!raw.length) {
        console.error('Usage: node cli.js teams --tasks "task one;;task two" [--parallel 2] [--project <path>]');
        process.exitCode = 1;
        return;
      }
      if (opts.parallel) s.settings.update({ maxParallel: Number(opts.parallel) });
      const router = new ProviderRouter(s.config.listProviders());
      const result = await runTeam({
        tasks: raw.map((title) => ({ title })),
        projectRoot: s.projectRoot,
        router,
        memory: s.memory,
        approvals: s.approvals,
        safetyMode: s.config.getSafetyMode(),
        settings: s.settings,
        onActivity: (e) => console.log(`  [${e.state}]${e.agent ? ' [' + e.agent + ']' : ''} ${e.message}`),
      });
      console.log(`
Team result: ${result.report.result} — ${result.summary}`);
      for (const member of result.team || []) {
        console.log(`  • [${member.role}] ${member.status} — ${member.title} (files: ${member.filesChanged.join(', ') || 'none'})`);
      }
      process.exitCode = result.status === 'completed' ? 0 : 1;
      return;
    }

    case 'checkpoints': {
      const store = new CheckpointStore(s.dataDir);
      const [sub, id] = opts._;
      if (sub === 'restore' && id) {
        const r = store.restore(s.projectRoot, id);
        console.log(`Restored ${r.restored} file(s) from ${id}:`);
        for (const line of r.results) console.log(`  - ${line.path}: ${line.action}`);
        return;
      }
      if (sub === 'compare' && id) {
        const cmp = store.compare(s.projectRoot, id);
        console.log(`Checkpoint ${id}: ${cmp.changedCount}/${cmp.files.length} file(s) changed since capture`);
        for (const f of cmp.files) console.log(`  - ${f.path}: ${f.changed ? 'CHANGED' : 'unchanged'}`);
        return;
      }
      const list = store.list(s.projectRoot);
      console.log(list.length ? 'Checkpoints (newest first):' : 'No checkpoints for this project yet.');
      for (const c of list) console.log(`  ${c.id}  ${c.createdAt}  ${c.label} (${c.files.length} files)`);
      return;
    }

    case 'settings': {
      if (opts._.length) {
        const patch = {};
        for (const kv of opts._) {
          const eq = kv.indexOf('=');
          const k = kv.slice(0, eq);
          const v = kv.slice(eq + 1);
          if (!k || v === undefined || v === '') { console.error('Expected key=value pairs, e.g. settings modelStrategy=LOCAL_FIRST'); process.exitCode = 1; return; }
          patch[k] = v === 'null' ? null : v === 'true' ? true : v === 'false' ? false : (v !== '' && Number.isFinite(Number(v)) ? Number(v) : v);
        }
        try {
          s.settings.update(patch);
          console.log('Settings updated.');
        } catch (e) { console.error('Rejected:', e.message); process.exitCode = 1; return; }
      }
      for (const [k, v] of Object.entries(s.settings.all())) console.log(`  ${k} = ${JSON.stringify(v)}`);
      return;
    }

    case 'knowledge': {
      const kb = new KnowledgeStore(s.dataDir);
      const episodes = kb.list(s.projectRoot, 20);
      console.log(episodes.length ? `Failure knowledge base (${episodes.length} recent episodes):` : 'No failure knowledge recorded for this project yet.');
      for (const e of episodes) {
        console.log(`  • [${e.finalResult}] ${String(e.errorSignature).slice(0, 90)}`);
        if (e.successfulFix) console.log(`      fix: ${String(e.successfulFix).slice(0, 90)}`);
      }
      return;
    }

    case 'browser': {
      const url = opts._[0];
      const status = await browserStatus();
      console.log(`Browser capability: ${status.available ? 'AVAILABLE' : 'UNAVAILABLE'} — ${status.detail}`);
      if (url) {
        if (!status.available) { process.exitCode = 1; return; }
        const { manager } = require('./src/browser');
        try {
          const nav = await manager.navigate(url);
          console.log(`  title: ${nav.title}`);
          console.log(`  errors: ${nav.errors.totalErrors} (console: ${nav.errors.consoleErrors.length}, page: ${nav.errors.pageErrors.length}, network: ${nav.errors.failedRequests.length})`);
          await manager.close();
        } catch (e) { console.error('  verification failed:', e.message); process.exitCode = 1; }
      }
      return;
    }

    case 'evaluate': {
      const files = String(opts.files || '').split(',').map((f) => f.trim()).filter(Boolean);
      const taskText = opts._.join(' ') || 'unspecified task';
      const verdict = await evaluate({
        task: taskText,
        projectRoot: s.projectRoot,
        result: { status: files.length ? 'completed' : 'error', filesChanged: files, summary: 'CLI evaluation' },
        runTestsFn: (root, o) => runTests(root, o),
      });
      console.log(`Evaluator verdict: ${verdict.verdict}`);
      console.log(`Reason: ${verdict.reason}`);
      process.exitCode = verdict.verdict === 'VERIFIED' ? 0 : 1;
      return;
    }

    default:
      console.log('Usage: node cli.js <command>\n');
      console.log('  run "<task>" [--project <path>] [--mode <mode>]   Run an agent task (same engine as the UI)');
      console.log('  analyze [--project <path>]                        Analyze/scan the project structure');
      console.log('  providers                                          List configured providers with health');
      console.log('  models <providerId>                                List models from a provider');
      console.log('  tasks                                              Show recent task history');
      console.log('  tests [--target <file>]                            Detect and run tests');
      console.log('  git                                                Git status + recent commits');
      console.log('  modes                                              Show agent modes and safety modes');
      console.log('  skills [task text]                                 List project skills; optionally match a task');
      console.log('  tools                                              List registered agent tools');
      console.log('  doctor                                             System diagnostics (Doctor 2.0)');
  console.log('  agents [task]                                      List specialists; optionally select a team');
  console.log('  teams --tasks "a;;b" [--parallel N]                 Run a bounded multi-agent team');
  console.log('  checkpoints [restore|compare <id>]                 List/compare/restore checkpoints');
  console.log('  settings [key=value ...]                           Show or update runtime settings');
  console.log('  knowledge                                          Show failure-knowledge episodes');
  console.log('  browser [url]                                      Browser capability (+ optional verify)');
  console.log('  evaluate --files a.js,b.js [task text]             Evidence-based quality evaluation');
  }
}

main().catch((e) => {
  console.error('Fatal error:', e.message);
  process.exitCode = 1;
});
