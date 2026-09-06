'use strict';
/**
 * config.js
 *
 * Persisted application settings: configured providers (with API keys),
 * known projects, UI preferences (theme), and the global safety mode.
 * Secrets are written to disk (there is nowhere else safe to keep them for
 * a local desktop-style app) but are NEVER included in any object returned
 * to the UI or logged — maskProvider() strips them before they leave this
 * module.
 */

const fs = require('fs');
const path = require('path');

// Known free-tier, OpenAI-compatible endpoints as of this writing. These are
// convenience presets only — the app still requires the user's own free API
// key from each provider (there is no such thing as a keyless, unlimited
// LLM API; "free" here means "free tier", not "no signup"). Model IDs and
// free-tier limits can change on the provider's side at any time — if one
// stops working, get a current model id from the provider's own docs.
const PROVIDER_PRESETS = [
  {
    preset: 'groq',
    name: 'Groq (free tier)',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    notes: 'Very fast free tier. Create a free account, then an API key.',
  },
  {
    preset: 'gemini',
    name: 'Google Gemini (free tier)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.6-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    notes: 'Google AI Studio free tier. Model ids change over time — if one stops working, check GET /api/providers/models?id=<your-provider-id> for the current list.',
  },
  {
    preset: 'openrouter',
    name: 'OpenRouter (free models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    keyUrl: 'https://openrouter.ai/keys',
    notes: 'Free account; pick a model id ending in ":free".',
  },
  {
    preset: 'freellmapi',
    name: 'FreeLLMAPI (self-hosted router)',
    baseUrl: 'http://localhost:3001/v1',
    model: 'auto',
    keyUrl: 'https://github.com/tashfeenahmed/freellmapi',
    notes:
      'Not bundled — you run it yourself (Docker/npm), add your own free-tier ' +
      'provider keys inside its dashboard, then point this app at its /v1 ' +
      'endpoint with the unified key it gives you. This app just treats it ' +
      'as another OpenAI-compatible provider.',
  },
];

const SAFETY_MODES = ['readonly', 'assist', 'edit', 'agent', 'autonomous'];
const OLLAMA_PROVIDER_ID = 'ollama-local';

const DEFAULTS = {
  theme: 'system', // 'light' | 'dark' | 'system'
  safetyMode: 'agent', // 'readonly' | 'assist' | 'edit' | 'agent' | 'autonomous'
  providers: [
    // Example of the generic OpenAI-compatible shape. Disabled until the
    // user supplies a real base URL / key. freellmapi (or any other
    // OpenAI-compatible gateway) can be configured the same way — this
    // app does not hard-depend on any single provider or vendor.
    {
      id: 'local-openai-compatible',
      name: 'Local / OpenAI-compatible',
      type: 'openai-compatible',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: '',
      model: '',
      enabled: false,
      priority: 10,
    },
  ],
  projects: [], // { id, name, rootPath }
  activeProjectId: null,
};

class ConfigStore {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'config.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this._load();
  }

  _load() {
    if (fs.existsSync(this.filePath)) {
      try {
        this.data = { ...structuredClone(DEFAULTS), ...JSON.parse(fs.readFileSync(this.filePath, 'utf8')) };
      } catch {
        this.data = structuredClone(DEFAULTS);
      }
    } else {
      this.data = structuredClone(DEFAULTS);
      this._save();
    }
    this.data.providers = this.data.providers.map(normalizeProvider);
  }

  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  getTheme() {
    return this.data.theme;
  }

  setTheme(theme) {
    if (!['light', 'dark', 'system'].includes(theme)) throw new Error('Invalid theme');
    this.data.theme = theme;
    this._save();
  }

  // Global safety mode (see src/modes.js / agent-loop gating):
  //   readonly   — no mutating tools at all
  //   assist     — file changes become pending proposals, commands need approval
  //   edit       — file changes applied, commands need approval
  //   agent      — approved tools execute; HIGH/CRITICAL-risk needs approval
  //   autonomous — full workflow within configured limits; CRITICAL still gated
  getSafetyMode() {
    return this.data.safetyMode || 'agent';
  }

  setSafetyMode(mode) {
    if (!SAFETY_MODES.includes(mode)) throw new Error(`Invalid safety mode: ${mode}`);
    this.data.safetyMode = mode;
    this._save();
  }

  listProviders() {
    return this.data.providers;
  }

  listProvidersMasked() {
    return this.data.providers.map(maskProvider);
  }

  upsertProvider(provider) {
    if (!provider.id) throw new Error('Provider requires an id');
    const idx = this.data.providers.findIndex((p) => p.id === provider.id);
    if (idx >= 0) this.data.providers[idx] = normalizeProvider({ ...this.data.providers[idx], ...provider });
    else this.data.providers.push(normalizeProvider({ enabled: true, priority: 100, ...provider }));
    this._save();
    return maskProvider(this.data.providers.find((p) => p.id === provider.id));
  }

  removeProvider(id) {
    this.data.providers = this.data.providers.filter((p) => p.id !== id);
    this._save();
  }

  /**
   * Ensure a provider entry for a local Ollama server exists (id
   * 'ollama-local'). It is enabled only when the server actually responded;
   * the model is set from detected models when available. Never fabricated:
   * call it with the result of detectOllama().
   */
  ensureOllamaProvider(detection, extra = {}) {
    const current = this.data.providers.find((p) => p.id === OLLAMA_PROVIDER_ID);
    const model = (detection.models && detection.models[0]) || (current && current.model) || '';
    const record = normalizeProvider({
      id: OLLAMA_PROVIDER_ID,
      name: 'Ollama (local)',
      type: 'ollama',
      baseUrl: detection.baseUrl,
      apiKey: current ? current.apiKey : '',
      model,
      enabled: !!detection.available,
      local: true,
      priority: 90, // after cloud free tiers by default; user can reprioritize
      ...extra,
      ...(detection.available && detection.models && detection.models.length
        ? { availableModels: detection.models }
        : {}),
    });
    const idx = this.data.providers.findIndex((p) => p.id === OLLAMA_PROVIDER_ID);
    if (idx >= 0) this.data.providers[idx] = { ...this.data.providers[idx], ...record };
    else this.data.providers.push(record);
    this._save();
    return maskProvider(this.data.providers.find((p) => p.id === OLLAMA_PROVIDER_ID));
  }

  listProjects() {
    return this.data.projects;
  }

  addProject(project) {
    if (!project.rootPath) throw new Error('Project requires rootPath');
    const id = project.id || require('crypto').randomUUID();
    const record = { id, name: project.name || path.basename(project.rootPath), rootPath: project.rootPath };
    this.data.projects = this.data.projects.filter((p) => p.rootPath !== record.rootPath);
    this.data.projects.unshift(record);
    this.data.activeProjectId = id;
    this._save();
    return record;
  }

  getActiveProject() {
    return this.data.projects.find((p) => p.id === this.data.activeProjectId) || null;
  }

  setActiveProject(id) {
    if (!this.data.projects.find((p) => p.id === id)) throw new Error('Unknown project id');
    this.data.activeProjectId = id;
    this._save();
  }
}

/** Additive normalization: every provider has type/local/capabilities fields. */
function normalizeProvider(p) {
  if (!p || typeof p !== 'object') return p;
  return {
    ...p,
    type: p.type || 'openai-compatible',
    local: !!p.local,
    capabilities: p.capabilities || null, // null = unknown; never invented
  };
}

function maskProvider(p) {
  if (!p) return p;
  const { apiKey, keys, ...rest } = p;
  const maskOne = (k) => `${'*'.repeat(Math.max(String(k).length - 4, 0))}${String(k).slice(-4)}`;
  return {
    ...rest,
    apiKeySet: Boolean(apiKey),
    apiKeyMasked: apiKey ? maskOne(apiKey) : '',
    // Key pool: multiple legitimate keys for the same provider, each masked.
    keysMasked: Array.isArray(keys) ? keys.map(maskOne) : undefined,
  };
}

module.exports = {
  ConfigStore,
  DEFAULTS,
  maskProvider,
  normalizeProvider,
  PROVIDER_PRESETS,
  SAFETY_MODES,
  OLLAMA_PROVIDER_ID,
};
