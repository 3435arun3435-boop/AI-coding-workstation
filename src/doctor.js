'use strict';
/**
 * doctor.js
 *
 * Doctor 2.0 — comprehensive, honest self-diagnostics shared by the CLI and
 * the API/UI. Every check reports PASS / WARN / INFO / FAIL with an actionable
 * detail line. Nothing is fabricated: a check that cannot run says so.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');
const { detectOllama } = require('./providers');
const { browserStatus } = require('./browser');
const { detectTests } = require('./test-intel');
const { availableSkills } = require('./skills');
const { availableAgents } = require('./agents');

function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), error });
    });
  });
}

async function runDoctor({ projectRoot = null, dataDir = null, config = null } = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  // Runtime
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 18;
  add('Node', nodeOk ? 'PASS' : 'FAIL', process.version);
  const npm = await run('npm', ['--version']);
  add('npm', npm.ok ? 'PASS' : 'WARN', npm.ok ? `v${npm.stdout}` : 'npm not found (some test commands will not work)');

  // Git
  const gitCheck = await run('git', ['--version']);
  add('Git', gitCheck.ok ? 'PASS' : 'WARN', gitCheck.ok ? gitCheck.stdout : 'git not found (git tools will report honestly)');

  // Data dir writability
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, '.doctor-probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    add('Data directory', 'PASS', `${dataDir} (writable)`);
  } catch (e) {
    add('Data directory', 'FAIL', `${dataDir}: ${e.message}`);
  }

  // Disk space (best effort)
  try {
    const statfs = fs.statfsSync(dataDir);
    const freeGb = (statfs.bsize * statfs.bavail) / 1024 ** 3;
    add('Disk space', freeGb > 1 ? 'PASS' : 'WARN', `${freeGb.toFixed(1)} GB free`);
  } catch {
    add('Disk space', 'INFO', 'could not determine free space');
  }

  // Project
  if (projectRoot) {
    const exists = fs.existsSync(projectRoot);
    add('Project access', exists ? 'PASS' : 'FAIL', projectRoot);
    if (exists) {
      const detection = detectTests(projectRoot);
      add('Test framework', detection.hasTests ? 'PASS' : 'INFO', detection.fullCommand || 'no tests detected');
      const skills = availableSkills(projectRoot, path.join(dataDir || '', 'skills'));
      add('Skills', skills.length ? 'PASS' : 'INFO', `${skills.length} skill.md file(s) available (${skills.map((s) => s.name).join(', ') || 'add skills/<name>/skill.md'})`);
      const agents = availableAgents(projectRoot);
      const customAgents = agents.filter((a) => a.custom).length;
      add('Agents', agents.length ? 'PASS' : 'WARN', `${agents.length} specialists (${customAgents} project-defined) — ${agents.slice(0, 4).map((a) => a.label).join(', ')}`);
    }
  } else {
    add('Project access', 'INFO', 'no active project selected');
  }

  // Providers
  const providers = config ? config.listProviders() : [];
  const enabled = providers.filter((p) => p.enabled !== false);
  add('Cloud providers', enabled.filter((p) => !p.local).length ? 'PASS' : 'INFO', `${enabled.filter((p) => !p.local).length} enabled cloud / ${providers.length} configured`);

  // Local AI
  const ollama = await detectOllama();
  add('Ollama', ollama.available ? 'PASS' : 'INFO', ollama.available ? `${ollama.models.length} model(s): ${ollama.models.slice(0, 4).join(', ')}` : `offline at ${ollama.baseUrl} — start with: ollama serve`);

  // Browser capability
  const browser = await browserStatus();
  add('Playwright', browser.available ? 'PASS' : 'INFO', browser.available ? (browser.browserRunning ? 'browser session active' : 'installed; browser tools enabled') : 'not installed (optional): npm i --no-save playwright && npx playwright install chromium');

  // Safety
  if (config) add('Safety mode', 'INFO', config.getSafetyMode());

  return { checks, ok: checks.every((c) => c.status !== 'FAIL'), ranAt: new Date().toISOString() };
}

module.exports = { runDoctor };
