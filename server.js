'use strict';
/**
 * server.js
 *
 * Zero-dependency HTTP server (Node's built-in `http` only). Serves the
 * web UI from /public and exposes the JSON API the UI talks to. Uses the
 * exact same agent-loop / agent-tools / providers modules as cli.js — one
 * shared agent implementation, not two.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const { runAgentTask } = require('./src/agent-loop');
const { ProviderRouter, detectOllama, listModels } = require('./src/providers');
const { ConfigStore, maskProvider, PROVIDER_PRESETS, SAFETY_MODES } = require('./src/config');
const { MemoryStore } = require('./src/memory');
const { TaskStore } = require('./src/tasks');
const { ApprovalStore } = require('./src/approvals');
const { TOOL_NAMES } = require('./src/agent-tools');
const { recallProfiles } = require('./src/profiles');
const { analyzeProject, buildContext } = require('./src/project-intel');
const { detectTests, runTests, TestHistoryStore } = require('./src/test-intel');
const git = require('./src/git');
const { resolveInProject, PathSecurityError } = require('./src/security');
const { classifyCommandRisk } = require('./src/risk');
const { SettingsStore } = require('./src/settings');
const { availableSkills, matchSkills } = require('./src/skills');
const { CheckpointStore } = require('./src/checkpoints');
const { KnowledgeStore } = require('./src/knowledge');
const { runTeam } = require('./src/orchestrator');
const { makeOrderingFn } = require('./src/model-router');
const { runDoctor } = require('./src/doctor');
const { detectSandbox } = require('./src/sandbox');
const agentsEngine = require('./src/agents');
const { classifyIntent } = require('./src/intent');
const { setDefaults: setIntelDefaults } = require('./src/project-intel');
const apiRegistry = require('./src/api-registry');

const MAX_FILE_BYTES = 512 * 1024;
const { MODE_KEYS: AGENT_MODE_KEYS, resolveMode } = require('./src/modes');

const PORT = process.env.PORT || 3300;
const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(require('os').homedir(), '.coding-agent');
const PUBLIC_DIR = path.join(__dirname, 'public');

const config = new ConfigStore(DATA_DIR);
const memory = new MemoryStore(DATA_DIR);
const tasks = new TaskStore(DATA_DIR);
const approvals = new ApprovalStore(DATA_DIR);
const testHistory = new TestHistoryStore(DATA_DIR);
const settings = new SettingsStore(DATA_DIR);

// Crash recovery: tasks left 'running'/'debugging'/etc. by a previous server
// process can never finish — mark them honestly instead of lying forever.
for (const t of tasks.list(200)) {
  if (['queued', 'running', 'waiting_approval', 'testing', 'debugging'].includes(t.status)) {
    tasks.complete(t.id, { status: 'failed', summary: 'Interrupted by a server restart before completion.' });
  }
}
const checkpoints = new CheckpointStore(DATA_DIR);
const knowledge = new KnowledgeStore(DATA_DIR);

// Settings Center 2.0: push the settings that other subsystems read at
// runtime into their modules (context budget, relevance threshold).
function applyRuntimeSettings() {
  setIntelDefaults({
    contextBudgetBytes: settings.get('contextBudgetBytes'),
    relevanceThreshold: settings.get('relevanceThreshold'),
  });
  require('./src/browser').configure({
    headless: settings.get('browserHeadless'),
    defaultTimeoutMs: settings.get('browserTimeoutMs'),
  });
}
applyRuntimeSettings();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const MAX_BODY_BYTES = 2 * 1024 * 1024; // request bodies are small JSON blobs

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    let bytes = 0;
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        settled = true;
        req.pause(); // stop consuming; the dispatcher drains after replying
        const err = new Error(`Request body exceeds the ${MAX_BODY_BYTES}-byte limit`);
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks += c;
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!chunks) return resolve({});
      try {
        resolve(JSON.parse(chunks));
      } catch (e) {
        const err = new Error('Request body is not valid JSON');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function friendlyError(err) {
  // Part 23: plain-language explanations with technical details expandable.
  const message = err && err.message ? err.message : String(err);
  if (/ECONNREFUSED/.test(message)) {
    return { friendly: 'The configured AI provider is not reachable right now.', suggestion: 'Check the provider is running and the base URL is correct.', technical: message };
  }
  if (/ENOENT/.test(message)) {
    return { friendly: 'A file or path referenced was not found.', suggestion: 'Check the project path and try again.', technical: message };
  }
  if (/escapes project root/.test(message)) {
    return { friendly: 'That action was blocked because it tried to reach outside the current project folder.', suggestion: 'Stay within the selected project.', technical: message };
  }
  return { friendly: 'Something went wrong.', suggestion: 'See technical details for more.', technical: message };
}

function getRouter() {
  return new ProviderRouter(config.listProviders());
}

// Long-lived router over a late-binding provider list: cooldown/health/usage
// state survives across requests while the configured entries stay editable.
// The Smart Model Router orders candidates per task via the Settings Center.
const router = new ProviderRouter(() => config.listProviders());
router.setOrdering(makeOrderingFn(settings));

// Merge live router health/usage into the masked provider list for the UI.
function providersWithHealth() {
  const snap = new Map(router.snapshot().map((s) => [s.id, s]));
  return config.listProvidersMasked().map((p) => {
    const s = snap.get(p.id);
    return {
      ...p,
      health: s
        ? {
            healthy: s.healthy,
            inCooldown: s.inCooldown,
            cooldownRemainingMs: s.cooldownRemainingMs,
            lastError: s.lastError,
            lastTestedAt: s.lastTestedAt,
            usage: s.usage,
          }
        : null,
    };
  });
}

// Single-run lock for the agent (one task at a time; concurrent runs → 409).
const activeRun = { active: false };

const routes = {
  'GET /api/health': async (req, res) => sendJSON(res, 200, { ok: true, tools: TOOL_NAMES }),

  'GET /api/settings': async (req, res) => {
    sendJSON(res, 200, {
      theme: config.getTheme(),
      safetyMode: config.getSafetyMode(),
      safetyModes: SAFETY_MODES,
      settings: settings.all(),
      offline: settings.get('offlineMode') || config.listProviders().filter((p) => p.enabled !== false && !p.local).length === 0,
      providers: providersWithHealth(),
      projects: config.listProjects(),
      activeProject: config.getActiveProject(),
    });
  },

  'POST /api/settings/update': async (req, res) => {
    const body = await readBody(req);
    try {
      const updated = settings.update(body);
      applyRuntimeSettings();
      sendJSON(res, 200, { ok: true, settings: updated });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: e.message });
    }
  },

  // Skills engine endpoints.
  'GET /api/skills': async (req, res, parsedUrl) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    try {
      const all = availableSkills(project.rootPath);
      const matched = parsedUrl.query.task ? matchSkills(project.rootPath, parsedUrl.query.task) : [];
      sendJSON(res, 200, {
        ok: true,
        skills: all.map(({ instructions, ...meta }) => meta),
        matched: parsedUrl.query.task ? matched.map(({ instructions, ...meta }) => meta) : undefined,
      });
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: friendlyError(e) });
    }
  },

  // Checkpoint endpoints.
  'GET /api/checkpoints': async (req, res) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    sendJSON(res, 200, { ok: true, checkpoints: checkpoints.list(project.rootPath) });
  },

  'POST /api/checkpoints/create': async (req, res) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    const body = await readBody(req);
    try {
      const record = checkpoints.create(project.rootPath, { label: body.label || 'manual checkpoint', include: Array.isArray(body.include) ? body.include : null });
      sendJSON(res, 200, { ok: true, checkpoint: record });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: e.message });
    }
  },

  'GET /api/checkpoints/compare': async (req, res, parsedUrl) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    try {
      sendJSON(res, 200, { ok: true, comparison: checkpoints.compare(project.rootPath, parsedUrl.query.id) });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: e.message });
    }
  },

  'POST /api/checkpoints/restore': async (req, res) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    const body = await readBody(req);
    if (config.getSafetyMode() === 'readonly') return sendJSON(res, 403, { ok: false, error: 'Safety mode is READ ONLY: restore is disabled.' });
    try {
      sendJSON(res, 200, { ok: true, restore: checkpoints.restore(project.rootPath, body.id) });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: e.message });
    }
  },

  // Doctor 2.0 + sandbox capability.
  'GET /api/doctor': async (req, res) => {
    const project = config.getActiveProject();
    const report = await runDoctor({ projectRoot: project ? project.rootPath : null, dataDir: DATA_DIR, config });
    sendJSON(res, 200, { ok: true, doctor: report });
  },

  'GET /api/sandbox/status': async (req, res) => {
    sendJSON(res, 200, { ok: true, sandbox: await detectSandbox() });
  },

  // Agents engine (WHO): built-in + project-defined specialists.
  'GET /api/agents': async (req, res, parsedUrl) => {
    const project = config.getActiveProject();
    try {
      const all = agentsEngine.availableAgents(project ? project.rootPath : process.cwd());
      const matched = parsedUrl.query.task ? agentsEngine.selectAgents(parsedUrl.query.task, { agents: all }) : [];
      sendJSON(res, 200, {
        ok: true,
        agents: all.map(({ mission, criticalRules, workflow, successMetrics, verification, whenNotToUse, ...meta }) => ({ ...meta, mission })),
        matched: parsedUrl.query.task ? matched.map((a) => ({ id: a.id, label: a.label, division: a.division, mode: a.mode })) : undefined,
      });
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: friendlyError(e) });
    }
  },

  // Free API Hub + public-apis discovery (PART B).
  'GET /api/apis': async (req, res, parsedUrl) => {
    const snapshot = new Map(router.snapshot().map((x) => [x.id, x]));
    const entries = apiRegistry.listRegistryApis().map((api) => {
      // Live health for entries that have a matching configured provider.
      const provider = config.listProviders().find((p) => p.id.startsWith(api.id) || (api.id === 'ollama' && p.type === 'ollama'));
      const health = provider && snapshot.get(provider.id)
        ? { configured: true, enabled: provider.enabled !== false, healthy: snapshot.get(provider.id).healthy, inCooldown: snapshot.get(provider.id).inCooldown, lastError: snapshot.get(provider.id).lastError, usage: snapshot.get(provider.id).usage }
        : { configured: false, health: 'not-configured' };
      return { ...api, health };
    });
    sendJSON(res, 200, { ok: true, apis: entries });
  },

  'GET /api/apis/discover': async (req, res, parsedUrl) => {
    const results = apiRegistry.searchPublicApis({
      q: parsedUrl.query.q,
      category: parsedUrl.query.category,
      capability: parsedUrl.query.capability,
      authType: parsedUrl.query.authType,
      pricingType: parsedUrl.query.pricingType,
      httpsOnly: parsedUrl.query.https === '1',
    });
    sendJSON(res, 200, { ok: true, count: results.length, apis: results, note: 'Metadata only — discovered APIs are never activated without explicit user connection.' });
  },

  'GET /api/apis/recommend': async (req, res, parsedUrl) => {
    if (!parsedUrl.query.capability) return sendJSON(res, 400, { ok: false, error: 'capability query parameter is required' });
    sendJSON(res, 200, { ok: true, capability: parsedUrl.query.capability, recommendations: apiRegistry.recommendForCapability(parsedUrl.query.capability) });
  },

  // Multi-key pool management for a provider (masked output only).
  'POST /api/providers/keys': async (req, res) => {
    const body = await readBody(req);
    if (!body.id || !Array.isArray(body.keys)) return sendJSON(res, 400, { ok: false, error: 'id and keys[] are required' });
    const provider = config.listProviders().find((p) => p.id === body.id);
    if (!provider) return sendJSON(res, 404, { ok: false, error: 'Provider not found' });
    config.upsertProvider({ id: body.id, keys: body.keys.map(String) });
    const updated = config.listProvidersMasked().find((p) => p.id === body.id);
    sendJSON(res, 200, { ok: true, provider: updated });
  },

  // Task resume (PART §0/§8): continue a BLOCKED/failed task from its
  // checkpoint + prior evidence. Work is preserved, never restarted from zero.
  'POST /api/tasks/resume': async (req, res) => {
    const body = await readBody(req);
    const original = body.id ? tasks.get(body.id) : null;
    if (!original) return sendJSON(res, 404, { ok: false, error: 'Task not found' });
    if (!['blocked', 'failed', 'error'].includes(original.status)) {
      return sendJSON(res, 400, { ok: false, error: `Task is ${original.status} — only blocked/failed tasks can be resumed` });
    }
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    const ck = checkpoints.list(project.rootPath).find((c) => c.taskId === original.id) || checkpoints.list(project.rootPath)[0] || null;
    sendJSON(res, 200, {
      ok: true,
      resumePayload: {
        resumeTaskId: original.id,
        task: original.title,
        mode: original.mode || 'autonomous',
        checkpointId: ck ? ck.id : null,
      },
    });
  },

  // Per-key management (PART §23/§25): remove/disable/enable a single
  // pooled credential. Masked output only — raw keys never leave the store.
  'POST /api/providers/keys/remove': async (req, res) => {
    const body = await readBody(req);
    const provider = body.id ? config.listProviders().find((p) => p.id === body.id) : null;
    if (!provider) return sendJSON(res, 404, { ok: false, error: 'Provider not found' });
    const idx = Number(body.index);
    const pool = Array.isArray(provider.keys) ? provider.keys.slice() : (provider.apiKey ? [provider.apiKey] : []);
    if (!Number.isInteger(idx) || idx < 0 || idx >= pool.length) return sendJSON(res, 400, { ok: false, error: 'index out of range' });
    const removed = `...${String(pool[idx]).slice(-4)}`;
    pool.splice(idx, 1);
    config.upsertProvider({ id: provider.id, keys: pool, apiKey: pool[0] || '' });
    sendJSON(res, 200, { ok: true, removed, remaining: config.listProvidersMasked().find((p) => p.id === provider.id).keysMasked || [] });
  },

  'POST /api/providers/keys/toggle': async (req, res) => {
    const body = await readBody(req);
    const provider = body.id ? config.listProviders().find((p) => p.id === body.id) : null;
    if (!provider) return sendJSON(res, 404, { ok: false, error: 'Provider not found' });
    config.upsertProvider({ id: provider.id, enabled: !!body.enabled });
    sendJSON(res, 200, { ok: true, enabled: !!body.enabled });
  },

  'GET /api/providers/keys': async (req, res, parsedUrl) => {
    const provider = parsedUrl.query.id ? config.listProviders().find((p) => p.id === parsedUrl.query.id) : null;
    if (!provider) return sendJSON(res, 404, { ok: false, error: 'Provider not found' });
    const pool = Array.isArray(provider.keys) ? provider.keys : (provider.apiKey ? [provider.apiKey] : []);
    sendJSON(res, 200, {
      ok: true,
      id: provider.id,
      enabled: provider.enabled !== false,
      priority: provider.priority ?? 100,
      keys: pool.map((k, i) => ({ index: i, masked: `...${String(k).slice(-4)}` })),
    });
  },

  // Knowledge base inspection.
  'GET /api/knowledge': async (req, res) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    sendJSON(res, 200, { ok: true, knowledge: knowledge.list(project.rootPath, 30) });
  },

  'POST /api/settings/theme': async (req, res) => {
    const body = await readBody(req);
    config.setTheme(body.theme);
    sendJSON(res, 200, { ok: true, theme: config.getTheme() });
  },

  'POST /api/settings/safety-mode': async (req, res) => {
    const body = await readBody(req);
    try {
      config.setSafetyMode(body.mode);
      sendJSON(res, 200, { ok: true, mode: config.getSafetyMode() });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: e.message });
    }
  },

  'GET /api/providers': async (req, res) => sendJSON(res, 200, { providers: providersWithHealth() }),

  'GET /api/modes': async (req, res) => {
    const { MODES } = require('./src/modes');
    sendJSON(res, 200, { modes: Object.entries(MODES).map(([key, m]) => ({ key, label: m.label, description: m.description, readOnly: !!m.readOnly })) });
  },

  // Browser capability — honest status, never a fake "connected".
  'GET /api/browser/status': async (req, res) => {
    const { browserStatus } = require('./src/browser');
    sendJSON(res, 200, { ok: true, browser: await browserStatus() });
  },

  // One-click browser verification: open a URL, capture console/page/network
  // errors and a screenshot. Requires the optional Playwright capability.
  'POST /api/browser/verify': async (req, res) => {
    const { manager: browserManager, browserStatus } = require('./src/browser');
    const status = await browserStatus();
    if (!status.available) {
      return sendJSON(res, 400, { ok: false, error: `Browser capability unavailable: ${status.detail}` });
    }
    const body = await readBody(req);
    if (!body.url || !/^https?:\/\//i.test(body.url)) {
      return sendJSON(res, 400, { ok: false, error: 'A valid absolute http(s) URL is required' });
    }
    try {
      const nav = await browserManager.navigate(body.url);
      const shot = await browserManager.screenshot({});
      await browserManager.close();
      sendJSON(res, 200, { ok: true, url: nav.url, title: nav.title, errors: nav.errors, screenshot: { encoding: 'base64', data: shot.data, bytes: shot.bytes } });
    } catch (e) {
      await browserManager.close().catch(() => {});
      sendJSON(res, 200, { ok: false, error: e.message });
    }
  },

  'GET /api/tools': async (req, res) => {
    const { TOOL_DEFS } = require('./src/agent-tools');
    sendJSON(res, 200, { tools: TOOL_DEFS.map((t) => ({ name: t.name, description: t.description })) });
  },

  // Probe local model servers (Ollama). Upserts an 'ollama-local' entry that
  // is enabled only when the server actually responds. Never fabricates models.
  'POST /api/providers/refresh-local': async (req, res) => {
    const body = await readBody(req);
    const detection = await detectOllama(body.baseUrl || 'http://localhost:11434');
    const provider = config.ensureOllamaProvider(detection);
    sendJSON(res, 200, { ok: true, detection, provider });
  },

  // Model discovery via the per-type adapter (Ollama /api/tags or /models).
  'GET /api/providers/models': async (req, res, parsedUrl) => {
    const id = parsedUrl.query.id;
    const provider = config.listProviders().find((p) => p.id === id);
    if (!provider) return sendJSON(res, 404, { ok: false, error: 'Provider not found' });
    const result = await listModels(provider, undefined, { force: parsedUrl.query.refresh === '1', cache: true });
    sendJSON(res, 200, { ok: result.ok, id, models: result.models || [], error: result.error || null });
  },

  'GET /api/provider-presets': async (req, res) => sendJSON(res, 200, { presets: PROVIDER_PRESETS }),

  'POST /api/providers': async (req, res) => {
    const body = await readBody(req);
    const saved = config.upsertProvider(body);
    sendJSON(res, 200, { ok: true, provider: saved });
  },

  'POST /api/providers/test': async (req, res) => {
    const body = await readBody(req);
    const provider = config.listProviders().find((p) => p.id === body.id);
    if (!provider) return sendJSON(res, 404, { ok: false, error: 'Provider not found' });
    try {
      // Key-pool aware: test EVERY credential; invalid keys are pruned from
      // the pool automatically (never retried, per §5) and the user is told.
      const poolKeys = Array.isArray(provider.keys) && provider.keys.length
        ? provider.keys
        : (provider.apiKey ? [provider.apiKey] : []);
      if (provider.type === 'tavily') {
        const key = poolKeys[0] || null;
        const r = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: key, query: 'connection test', max_results: 1 }),
          signal: AbortSignal.timeout(15_000),
        });
        sendJSON(res, 200, { ok: r.ok, status: r.status });
        return;
      }
      const perKey = [];
      const validKeys = [];
      for (const k of poolKeys) {
        try {
          const r = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, {
            headers: k ? { Authorization: `Bearer ${k}` } : {},
            signal: AbortSignal.timeout(10_000),
          });
          perKey.push({ masked: `...${String(k).slice(-4)}`, status: r.status, ok: r.ok });
          // Only INVALID credentials are pruned. 429/exhausted keys stay in the
          // pool — they are temporary/exhausted, not broken (per §5).
          if (r.ok || ![401, 403].includes(r.status)) validKeys.push(k);
          else perKey[perKey.length - 1].pruned = 'invalid';
        } catch (e) {
          perKey.push({ masked: `...${String(k).slice(-4)}`, status: 0, ok: false, error: e.message });
        }
      }
      if (poolKeys.length > 0) {
        if (validKeys.length) config.upsertProvider({ id: provider.id, keys: validKeys });
        else config.upsertProvider({ id: provider.id, keys: [], apiKey: '' , enabled: provider.enabled }); // all invalid — pool emptied
      }
      const okAny = validKeys.length > 0;
      sendJSON(res, 200, { ok: okAny, status: okAny ? 200 : (perKey[0] ? perKey[0].status : 0), keys: perKey, pruned: poolKeys.length - validKeys.length });
    } catch (e) {
      sendJSON(res, 200, { ok: false, error: friendlyError(e) });
    }
  },

  'POST /api/projects': async (req, res) => {
    const body = await readBody(req);
    if (!fs.existsSync(body.rootPath) || !fs.statSync(body.rootPath).isDirectory()) {
      return sendJSON(res, 400, { ok: false, error: 'rootPath must be an existing directory' });
    }
    const project = config.addProject(body);
    sendJSON(res, 200, { ok: true, project });
  },

  // Project Intelligence endpoints for the active project.
  'GET /api/project/map': async (req, res, parsedUrl) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    try {
      const map = analyzeProject(project.rootPath, { refresh: parsedUrl.query.refresh === '1' });
      sendJSON(res, 200, { ok: true, project: project.name, map });
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: friendlyError(e) });
    }
  },

  'GET /api/project/context': async (req, res, parsedUrl) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    const task = parsedUrl.query.task;
    if (!task) return sendJSON(res, 400, { ok: false, error: 'task query parameter is required' });
    try {
      sendJSON(res, 200, { ok: true, context: buildContext(project.rootPath, task) });
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: friendlyError(e) });
    }
  },

  // Test Intelligence endpoints.
  'GET /api/tests/detect': async (req, res) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    try {
      sendJSON(res, 200, { ok: true, detection: detectTests(project.rootPath) });
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: friendlyError(e) });
    }
  },

  'POST /api/tests/run': async (req, res) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    const body = await readBody(req);
    try {
      const result = await runTests(project.rootPath, { target: body.target, timeoutMs: body.timeoutMs });
      testHistory.record(result, { project: project.name });
      sendJSON(res, 200, { ok: true, result });
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: friendlyError(e) });
    }
  },

  'GET /api/tests/history': async (req, res) => sendJSON(res, 200, { history: testHistory.list(30) }),

  // Git intelligence endpoints (read-only; commits go through approvals).
  'GET /api/git/status': async (req, res) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    sendJSON(res, 200, { ok: true, status: await git.status(project.rootPath) });
  },

  'GET /api/git/diff': async (req, res, parsedUrl) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    const result = await git.diff(project.rootPath, { staged: parsedUrl.query.staged === '1' });
    if (!result.isRepo) return sendJSON(res, 200, { ok: false, error: result.reason });
    sendJSON(res, 200, { ok: true, staged: result.staged, diff: result.diff, empty: result.empty });
  },

  'GET /api/git/log': async (req, res, parsedUrl) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    const result = await git.log(project.rootPath, { limit: parsedUrl.query.limit });
    if (!result.isRepo) return sendJSON(res, 200, { ok: false, error: result.reason });
    sendJSON(res, 200, { ok: true, commits: result.commits });
  },

  // --- File explorer / editor (sandboxed to the active project root) --------
  'GET /api/files': async (req, res, parsedUrl) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    try {
      const rel = parsedUrl.query.path || '.';
      const abs = resolveInProject(project.rootPath, rel);
      const stat = fs.statSync(abs);
      if (!stat.isDirectory()) return sendJSON(res, 400, { ok: false, error: 'Not a directory' });
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
        .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: e.isDirectory() ? null : fs.statSync(path.join(abs, e.name)).size }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      sendJSON(res, 200, { ok: true, path: rel, entries });
    } catch (e) {
      sendJSON(res, e instanceof PathSecurityError ? 403 : 400, { ok: false, error: e.message });
    }
  },

  'GET /api/file': async (req, res, parsedUrl) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    try {
      const abs = resolveInProject(project.rootPath, String(parsedUrl.query.path || ''));
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return sendJSON(res, 400, { ok: false, error: 'Not a file' });
      if (stat.size > MAX_FILE_BYTES) return sendJSON(res, 400, { ok: false, error: `File too large to view (limit ${MAX_FILE_BYTES} bytes)` });
      sendJSON(res, 200, { ok: true, path: parsedUrl.query.path, bytes: stat.size, content: fs.readFileSync(abs, 'utf8') });
    } catch (e) {
      sendJSON(res, e instanceof PathSecurityError ? 403 : 400, { ok: false, error: e.message });
    }
  },

  // Saving a file goes through the SAME safety gate as agent edits:
  // in assist safety mode it becomes a pending approval with a diff.
  'POST /api/file/save': async (req, res) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    const body = await readBody(req);
    if (!body.path || typeof body.content !== 'string') return sendJSON(res, 400, { ok: false, error: 'path and content are required' });
    const safetyMode = config.getSafetyMode();
    if (safetyMode === 'readonly') return sendJSON(res, 403, { ok: false, error: 'Safety mode is READ ONLY: saving is disabled.' });
    let oldContent = null;
    let abs;
    try {
      abs = resolveInProject(project.rootPath, body.path);
      oldContent = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    } catch (e) {
      return sendJSON(res, e instanceof PathSecurityError ? 403 : 400, { ok: false, error: e.message });
    }
    if (oldContent === body.content) return sendJSON(res, 400, { ok: false, error: 'No changes to save' });
    if (safetyMode === 'assist') {
      const record = approvals.propose({
        type: 'file', projectRoot: project.rootPath, path: body.path,
        oldContent, newContent: body.content,
        risk: { level: 'medium', reason: 'manual edit in the file editor' },
        title: `Editor: ${oldContent === null ? 'create' : 'modify'} ${body.path}`,
      });
      return sendJSON(res, 200, { ok: true, proposed: true, approval: approvals.list().find((r) => r.id === record.id) });
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body.content, 'utf8');
    sendJSON(res, 200, { ok: true, applied: true, path: body.path, bytesWritten: Buffer.byteLength(body.content, 'utf8') });
  },

  // --- Terminal (safety-gated; same risk rules as agent commands) -----------
  'POST /api/terminal/run': async (req, res) => {
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    const body = await readBody(req);
    if (!body.command || typeof body.command !== 'string') return sendJSON(res, 400, { ok: false, error: 'command is required' });
    const safetyMode = config.getSafetyMode();
    if (safetyMode === 'readonly') return sendJSON(res, 403, { ok: false, error: 'Safety mode is READ ONLY: commands are disabled.' });
    const risk = classifyCommandRisk(body.command);
    const needsProposal =
      risk.level === 'critical' ||
      (risk.level === 'high' && safetyMode !== 'autonomous') ||
      safetyMode === 'assist' ||
      safetyMode === 'edit';
    if (needsProposal) {
      const record = approvals.propose({
        type: 'command', projectRoot: project.rootPath, command: body.command,
        risk, title: `Terminal: ${body.command.slice(0, 120)}`,
      });
      return sendJSON(res, 200, { ok: true, proposed: true, risk, approval: approvals.list().find((r) => r.id === record.id) });
    }
    const { execFile } = require('child_process');
    const { sanitizedEnv } = require('./src/exec-env');
    const start = Date.now();
    execFile('/bin/sh', ['-c', body.command], { cwd: project.rootPath, timeout: Math.min(Number(body.timeoutMs) || 60_000, 120_000), maxBuffer: 1024 * 1024, env: sanitizedEnv() }, (error, stdout, stderr) => {
      sendJSON(res, 200, {
        ok: true, applied: true, risk,
        result: {
          command: body.command,
          exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          timedOut: !!(error && error.killed),
          stdout, stderr,
          durationMs: Date.now() - start,
        },
      });
    });
  },

  'GET /api/tasks': async (req, res) => sendJSON(res, 200, { tasks: tasks.list(50) }),

  'GET /api/tasks/detail': async (req, res, parsedUrl) => {
    const record = parsedUrl.query.id ? tasks.get(parsedUrl.query.id) : null;
    if (!record) return sendJSON(res, 404, { ok: false, error: 'Task not found' });
    sendJSON(res, 200, { ok: true, task: record });
  },

  'POST /api/tasks/cancel': async (req, res) => {
    const body = await readBody(req);
    const record = body.id ? tasks.requestCancel(body.id) : null;
    if (!record) return sendJSON(res, 404, { ok: false, error: 'Task not found' });
    sendJSON(res, 200, { ok: true, task: record });
  },

  'POST /api/tasks/retry': async (req, res) => {
    const body = await readBody(req);
    if (!body.id) return sendJSON(res, 400, { ok: false, error: 'id is required' });
    const record = tasks.retry(body.id);
    if (!record) return sendJSON(res, 404, { ok: false, error: 'Task not found' });
    sendJSON(res, 200, { ok: true, task: record });
  },

  // Approval / diff system endpoints.
  'GET /api/approvals': async (req, res, parsedUrl) => {
    const filter = {};
    if (parsedUrl.query.status) filter.status = parsedUrl.query.status;
    if (parsedUrl.query.taskId) filter.taskId = parsedUrl.query.taskId;
    sendJSON(res, 200, { approvals: approvals.list(filter) });
  },

  'GET /api/approvals/detail': async (req, res, parsedUrl) => {
    const record = parsedUrl.query.id ? approvals.get(parsedUrl.query.id) : null;
    if (!record) return sendJSON(res, 404, { ok: false, error: 'Proposal not found' });
    sendJSON(res, 200, { ok: true, approval: approvals.list().find((r) => r.id === record.id) || null, hasFullContent: record.type === 'file' });
  },

  'POST /api/approvals/decide': async (req, res) => {
    const body = await readBody(req);
    try {
      const record = await approvals.decide(body.id, body.decision);
      sendJSON(res, 200, { ok: true, approval: record });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: e.message });
    }
  },

  'POST /api/approvals/revert': async (req, res) => {
    const body = await readBody(req);
    try {
      const record = approvals.revert(body.id);
      sendJSON(res, 200, { ok: true, approval: record });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: e.message });
    }
  },

  'GET /api/memory': async (req, res, parsedUrl) => {
    const category = parsedUrl.query.category;
    if (category) return sendJSON(res, 200, { category, entries: memory.getAll(category) });
    const all = {};
    for (const c of ['global', 'project', 'task', 'agent', 'session']) all[c] = memory.getAll(c);
    sendJSON(res, 200, { memory: all, status: memory.status() });
  },

  'POST /api/memory/clear': async (req, res) => {
    const body = await readBody(req);
    memory.clear(body.category);
    sendJSON(res, 200, { ok: true });
  },

  // Working-profile memory: keyword-matched past-task recall (see src/profiles.js).
  // With ?task=..., returns the profiles that would be recalled for that task.
  // Without it, returns every stored profile (for inspection/debugging).
  'GET /api/memory/profiles': async (req, res, parsedUrl) => {
    const task = parsedUrl.query.task;
    if (task) {
      const matches = recallProfiles(memory, task);
      return sendJSON(res, 200, { task, matches });
    }
    const all = memory.getAll('agent');
    const profiles = Object.entries(all)
      .filter(([k]) => k.startsWith('profile:'))
      .map(([key, entry]) => ({ key, ...entry }));
    sendJSON(res, 200, { profiles });
  },

  'POST /api/agent/run': async (req, res) => {
    const body = await readBody(req);
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    const modeKey = resolveMode(body.mode || settings.get('defaultMode'), body.task);
    if (body.mode && body.mode !== 'auto' && !AGENT_MODE_KEYS.includes(body.mode)) {
      return sendJSON(res, 400, { ok: false, error: `Unknown mode: ${body.mode}. Valid: auto, ${AGENT_MODE_KEYS.join(', ')}` });
    }
    // One agent task at a time — a second concurrent run is refused honestly
    // (cancel or wait for the running task; history keeps full state).
    if (activeRun.active) {
      return sendJSON(res, 409, { ok: false, error: 'Another agent task is already running. Cancel it or wait for it to finish.' });
    }
    activeRun.active = true;

    const routerForTask = router;
    const record = tasks.create({ title: body.task, project: project.name, provider: 'auto', model: 'auto', mode: modeKey });

    // Server-sent events so the UI gets live activity, not just a final blob.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    function emitResumeNote(fn, checkpointId, originalId) {
      const msg = checkpointId
        ? `↪ Resuming from checkpoint ${checkpointId} (task ${String(originalId).slice(0, 8)}) — prior work preserved`
        : '↪ Resuming task — no checkpoint existed, continuing with prior evidence';
      fn({ state: 'PLAN', message: msg, ts: new Date().toISOString() });
    }
    const verbosity = settings.get('activityVerbosity');
    const onActivity = (event) => {
      // Settings → UI → activity verbosity: 'normal' hides tool-level detail
      // noise (INSPECT/RUN single-tool events); 'verbose' shows everything.
      if (verbosity !== 'verbose' && (event.state === 'RUN') && /^Calling /.test(event.message || '')) {
        return;
      }
      res.write(`data: ${JSON.stringify({ type: 'activity', ...event })}\n\n`);
      // Task Center lifecycle: canonical activity events drive both the task
      // status and the panel's live label (PART C).
      const stateToStatus = {
        waiting_approval: 'waiting_approval', running_test: 'testing',
        editing: 'debugging', running_command: 'running', provider_request: 'running',
        thinking: 'running', reading: 'running', searching: 'running', planning: 'running',
        git_running: 'running', browser_running: 'running', retrying: 'running',
      };
      const patch = { lastActivity: { state: event.state, label: event.label || event.message, ts: event.ts, agent: event.agent || null, tool: event.tool || null } };
      if (stateToStatus[event.state]) patch.status = stateToStatus[event.state];
      try {
        tasks.update(record.id, patch);
      } catch {
        /* lifecycle sync is best-effort */
      }
    };

    try {
      // Skills engine (HOW): only task-relevant skills enter the context.
      let matchedSkills = null;
      try {
        matchedSkills = matchSkills(project.rootPath, body.task, { map: null });
      } catch {
        matchedSkills = null;
      }

      // Task resume (§0/§8): continue prior work from its checkpoint and
      // evidence — never restart from zero after a credential switch.
      let resumeAdvisory = null;
      if (body.resumeTaskId) {
        const original = tasks.get(body.resumeTaskId);
        if (original) {
          record.resumedFrom = original.id;
          const ck = checkpoints.list(project.rootPath).find((c) => c.taskId === original.id) || checkpoints.list(project.rootPath)[0] || null;
          resumeAdvisory = {
            role: 'system',
            content:
              'TASK RESUME: this task was previously interrupted by a provider/credential failure. ' +
              'Continue from the checkpoint — do NOT restart from zero. Before re-editing any file, ' +
              'inspect its current state (previous operations may have completed).\n' +
              JSON.stringify({
                originalTask: original.title,
                priorStatus: original.status,
                priorSummary: original.summary,
                filesAlreadyChanged: original.filesChanged,
                checkpoint: ck ? { id: ck.id, files: ck.files.map((f) => f.path) } : null,
                instruction: 'Verify what is already done (tests/files), then continue the remaining work.',
              }, null, 2).slice(0, 4000),
          };
          emitResumeNote(onActivity, ck ? ck.id : null, original.id);
        }
      }

      // Intent routing (PART A): the smallest useful execution path.
      // An explicit engineering mode stays a task; ask/review refine to
      // plain chat when no inspection targets are named.
      const intentInfo = classifyIntent(body.task);
      const effectiveIntent = ['ask', 'review'].includes(modeKey) ? intentInfo.intent : 'task';

      // Chat intent + active project → inject the SMALLEST useful context:
      // a compact project map summary (no tools, no file dumps).
      const chatAdvisories = [];
      if (effectiveIntent === 'chat') {
        try {
          const map = analyzeProject(project.rootPath);
          chatAdvisories.push({
            role: 'system',
            content:
              'PROJECT CONTEXT (auto-generated from the currently open project — you MUST answer using this; do not ask the user for files):\n' +
              JSON.stringify({
                projectType: map.projectType,
                primaryLanguage: map.primaryLanguage,
                frameworks: map.frameworks,
                packageManager: map.packageManager,
                entrypoints: map.entrypoints,
                scripts: map.scripts,
                dependencies: map.dependencies.slice(0, 15),
                testFramework: map.testFramework,
                fileCount: map.fileCount,
                fileTree: map.files.slice(0, 40),
              }, null, 2),
          });
        } catch {
          /* context injection is best-effort */
        }
      }

      // Agents engine (WHO): the smallest useful specialist for this task.
      let selectedAgent = null;
      try {
        selectedAgent = agentsEngine.selectAgents(body.task, { projectRoot: project.rootPath })[0] || null;
      } catch {
        selectedAgent = null;
      }

      const runOpts = {
        task: body.task,
        projectRoot: project.rootPath,
        router: routerForTask,
        onActivity,
        memory,
        safetyMode: config.getSafetyMode(),
        approvals,
        taskId: record.id,
        shouldCancel: () => tasks.isCancelled(record.id),
        skills: matchedSkills && matchedSkills.length ? matchedSkills : null,
        knowledge,
        checkpoints,
        checkpointEnabled: settings.get('checkpointBeforeAutonomous'),
        testBeforeComplete: settings.get('testBeforeComplete'),
        retryPolicy: settings.get('maxProviderRetries') != null ? { passes: settings.get('maxProviderRetries') + 1, waitMs: settings.get('retryWaitMs') } : null,
        tokenBudget: settings.get('taskTokenBudget'),
        agent: body.agent ? selectedAgent : selectedAgent, // auto-selected specialist (body.agent reserved for explicit choice)
        intent: effectiveIntent,
        advisories: resumeAdvisory ? [resumeAdvisory, ...(effectiveIntent === 'chat' ? chatAdvisories : [])] : (effectiveIntent === 'chat' ? chatAdvisories : undefined),
        memory: settings.get('memoryEnabled') ? memory : undefined,
        ctxExtras: {
          terminalTimeoutMs: settings.get('terminalTimeoutMs'),
          terminalOutputLimit: settings.get('terminalOutputLimit'),
          toolResultCharLimit: settings.get('toolResultCharLimit'),
        },
        maxPayloadChars: settings.get('maxPayloadChars'),
      };

      // Autonomous mode = the full debug workflow (investigate → fix → test →
      // verify, bounded); every other mode uses the standard agent loop.
      const result = modeKey === 'autonomous'
        ? await require('./src/debug-loop').runDebugLoop({ ...runOpts, browserUrl: body.browserUrl || null })
        : await runAgentTask({ ...runOpts, mode: modeKey, ctxExtras: runOpts.ctxExtras });

      tasks.complete(record.id, {
        status: result.status,
        filesChanged: result.filesChanged,
        testsRun: result.testsRun,
        summary: result.summary,
        provider: result.provider,
        model: result.model,
        evaluation: result.report && result.report.evaluation,
      });
      res.write(`data: ${JSON.stringify({ type: 'result', ...result, taskId: record.id })}\n\n`);
    } catch (e) {
      const err = friendlyError(e);
      tasks.complete(record.id, { status: 'error', filesChanged: [], testsRun: [], summary: err.friendly });
      res.write(`data: ${JSON.stringify({ type: 'error', ...err })}\n\n`);
    }
    activeRun.active = false;
    res.end();
  },

  // Multi-Agent Software Team: one parent task, bounded child agents.
  'POST /api/team/run': async (req, res) => {
    const body = await readBody(req);
    const project = config.getActiveProject();
    if (!project) return sendJSON(res, 400, { ok: false, error: 'No active project selected' });
    if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
      return sendJSON(res, 400, { ok: false, error: 'tasks array is required (e.g. [{"title":"fix backend","mode":"code"},{"title":"add tests","mode":"test"}])' });
    }
    if (activeRun.active) {
      return sendJSON(res, 409, { ok: false, error: 'Another agent task is already running. Cancel it or wait for it to finish.' });
    }
    activeRun.active = true;

    const record = tasks.create({
      title: body.title || `Team run: ${body.tasks.length} agent(s)`,
      project: project.name,
      provider: 'auto',
      model: 'auto',
      mode: 'team',
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const onActivity = (event) => {
      res.write(`data: ${JSON.stringify({ type: 'activity', ...event })}\n\n`);
    };

    try {
      const result = await runTeam({
        tasks: body.tasks,
        projectRoot: project.rootPath,
        router,
        memory,
        approvals,
        safetyMode: config.getSafetyMode(),
        settings,
        onActivity,
        shouldCancel: () => tasks.isCancelled(record.id),
        createChildTask: (title, mode, role) => tasks.create({ title, project: project.name, mode, parentId: record.id, role }),
        completeChildTask: (childRecord, result2) => {
          tasks.complete(childRecord.id, {
            status: result2.status,
            filesChanged: result2.filesChanged,
            testsRun: result2.testsRun || [],
            summary: result2.summary,
            provider: result2.provider,
            model: result2.model,
          });
        },
      });
      tasks.complete(record.id, { status: result.status, filesChanged: result.filesChanged, testsRun: [], summary: result.summary });
      res.write(`data: ${JSON.stringify({ type: 'result', ...result, taskId: record.id })}\n\n`);
    } catch (e) {
      const err = friendlyError(e);
      tasks.complete(record.id, { status: 'error', filesChanged: [], testsRun: [], summary: err.friendly });
      res.write(`data: ${JSON.stringify({ type: 'error', ...err })}\n\n`);
    }
    activeRun.active = false;
    res.end();
  },
};

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  const abs = path.join(PUBLIC_DIR, filePath);
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(abs);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const key = `${req.method} ${parsedUrl.pathname}`;
  const handler = routes[key];

  if (handler) {
    try {
      await handler(req, res, parsedUrl);
    } catch (e) {
      if (!res.headersSent) {
        if (e.statusCode) req.resume(); // drain an unconsumed body after replying
        sendJSON(res, e.statusCode || 500, { ok: false, error: friendlyError(e) });
      }
    }
    return;
  }

  if (req.method === 'GET') {
    // Unknown API paths get a structured JSON 404, not the static handler.
    if (parsedUrl.pathname.startsWith('/api/')) {
      return sendJSON(res, 404, { ok: false, error: 'Not found' });
    }
    return serveStatic(req, res, parsedUrl.pathname);
  }

  sendJSON(res, 404, { ok: false, error: 'Not found' });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Coding agent server running at http://localhost:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
    console.log(`Safety mode: ${config.getSafetyMode()} — change it in the UI header or POST /api/settings/safety-mode`);
  });

  // Graceful shutdown: stop accepting connections and free the (optional)
  // browser session so no Chromium process is left behind.
  async function shutdown(signal) {
    console.log(`\n${signal} received — shutting down…`);
    server.close();
    try {
      await require('./src/browser').manager.close();
    } catch { /* best effort */ }
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err.message);
  });
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err && err.message ? err.message : String(err));
  });
}

module.exports = { server, config, memory, tasks, approvals, router, activeRun };
