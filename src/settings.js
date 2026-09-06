'use strict';
/**
 * settings.js
 *
 * Advanced, persisted, validated settings. Every subsystem that needs user
 * control (model routing strategy, multi-agent limits, checkpoints, offline
 * mode, context budget) reads from here — one source of truth, safe defaults,
 * and honest validation. Unknown keys are rejected; values are type-checked.
 */

const fs = require('fs');
const path = require('path');

const MODEL_STRATEGIES = ['LOCAL_FIRST', 'FREE_CLOUD_FIRST', 'BEST_AVAILABLE', 'CHEAPEST_AVAILABLE', 'MANUAL'];

const DEFAULTS = {
  // AI / model routing
  modelStrategy: 'FREE_CLOUD_FIRST',   // how the router orders providers per task
  manualProviderId: null,              // used only when modelStrategy = 'MANUAL'
  offlineMode: false,                  // true → only LOCAL providers are used
  defaultMode: 'auto',                 // default agent mode for new tasks

  // Agents / team
  maxAgents: 3,                        // upper bound on agents in one team run
  maxParallel: 1,                      // conservative default: sequential
  reviewerRequired: false,             // team runs append a Review agent when true

  // Autonomy / verification
  checkpointBeforeAutonomous: true,    // snapshot before autonomous modifications
  testBeforeComplete: true,            // debug loop must run tests before PASS

  // Context engine
  contextBudgetBytes: 65536,           // bounded context bundle size
  toolResultCharLimit: 4000,           // per-tool-result bound in the conversation
  maxPayloadChars: 24000,              // per-request payload cap (compaction trigger)

  // Budgets
  taskTokenBudget: null,               // null = unlimited; enforced in the agent loop
  maxProviderRetries: null,            // null = router default (bounded by entries)
  retryWaitMs: 15000,                  // spacing between bounded retry passes

  // Terminal
  terminalTimeoutMs: 60000,            // read by /api/terminal/run and run_command
  terminalOutputLimit: 20000,          // chars per stream, truncation noted

  // Browser (read by src/browser.js via configure())
  browserHeadless: true,
  browserTimeoutMs: 30000,
  browserScreenshotOnVerify: true,

  // Memory / Context / UI / Team
  memoryEnabled: true,                 // read by the server when wiring agent runs
  relevanceThreshold: 1,               // min relevance score (read by project-intel)
  activityVerbosity: 'normal',         // 'normal' | 'verbose' (read by the SSE pipe)
  uiRefreshIntervalMs: 8000,           // read by public/app.js at load
  conflictPolicy: 'flag',              // 'flag' | 'block' (read by the orchestrator)
  reasoningPreference: 'balanced',     // 'balanced' | 'quality' | 'speed' (read by model-router)
};

const VALIDATORS = {
  modelStrategy: (v) => MODEL_STRATEGIES.includes(v) || `modelStrategy must be one of: ${MODEL_STRATEGIES.join(', ')}`,
  manualProviderId: (v) => v === null || typeof v === 'string' || 'manualProviderId must be null or a string',
  offlineMode: (v) => typeof v === 'boolean' || 'offlineMode must be a boolean',
  defaultMode: (v) => ['auto', 'ask', 'plan', 'code', 'debug', 'test', 'review', 'autonomous'].includes(v) || 'unknown default mode',
  maxAgents: (v) => (Number.isInteger(v) && v >= 1 && v <= 10) || 'maxAgents must be an integer 1-10',
  maxParallel: (v) => (Number.isInteger(v) && v >= 1 && v <= 10) || 'maxParallel must be an integer 1-10',
  reviewerRequired: (v) => typeof v === 'boolean' || 'reviewerRequired must be a boolean',
  checkpointBeforeAutonomous: (v) => typeof v === 'boolean' || 'checkpointBeforeAutonomous must be a boolean',
  testBeforeComplete: (v) => typeof v === 'boolean' || 'testBeforeComplete must be a boolean',
  contextBudgetBytes: (v) => (Number.isInteger(v) && v >= 4096 && v <= 512 * 1024) || 'contextBudgetBytes must be 4096-524288',
  taskTokenBudget: (v) => v === null || (Number.isInteger(v) && v > 0) || 'taskTokenBudget must be null or a positive integer',
  maxProviderRetries: (v) => v === null || (Number.isInteger(v) && v >= 0) || 'maxProviderRetries must be null or >= 0',
  retryWaitMs: (v) => (Number.isInteger(v) && v >= 1000 && v <= 60000) || 'retryWaitMs must be 1000-60000',
  terminalTimeoutMs: (v) => (Number.isInteger(v) && v >= 2000 && v <= 300000) || 'terminalTimeoutMs must be 2000-300000',
  terminalOutputLimit: (v) => (Number.isInteger(v) && v >= 1000 && v <= 500000) || 'terminalOutputLimit must be 1000-500000',
  browserHeadless: (v) => typeof v === 'boolean' || 'browserHeadless must be a boolean',
  browserTimeoutMs: (v) => (Number.isInteger(v) && v >= 5000 && v <= 120000) || 'browserTimeoutMs must be 5000-120000',
  browserScreenshotOnVerify: (v) => typeof v === 'boolean' || 'browserScreenshotOnVerify must be a boolean',
  memoryEnabled: (v) => typeof v === 'boolean' || 'memoryEnabled must be a boolean',
  relevanceThreshold: (v) => (Number.isInteger(v) && v >= 1 && v <= 50) || 'relevanceThreshold must be 1-50',
  activityVerbosity: (v) => ['normal', 'verbose'].includes(v) || 'activityVerbosity must be normal or verbose',
  uiRefreshIntervalMs: (v) => (Number.isInteger(v) && v >= 2000 && v <= 60000) || 'uiRefreshIntervalMs must be 2000-60000',
  conflictPolicy: (v) => ['flag', 'block'].includes(v) || 'conflictPolicy must be flag or block',
  reasoningPreference: (v) => ['balanced', 'quality', 'speed'].includes(v) || 'reasoningPreference must be balanced, quality, or speed',
  toolResultCharLimit: (v) => (Number.isInteger(v) && v >= 500 && v <= 200000) || 'toolResultCharLimit must be 500-200000',
  maxPayloadChars: (v) => (Number.isInteger(v) && v >= 4000 && v <= 500000) || 'maxPayloadChars must be 4000-500000',
};

class SettingsStore {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'settings.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = { ...structuredClone(DEFAULTS), ...this._load() };
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return {}; // corrupt settings fall back to defaults, never crash the app
    }
  }

  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  all() {
    return { ...this.data };
  }

  get(key) {
    if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`);
    return this.data[key];
  }

  /** Apply a partial update. Unknown keys / bad values throw with the reason. */
  update(patch) {
    const applied = {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`);
      const verdict = VALIDATORS[key](value);
      if (verdict !== true) throw new Error(verdict);
      applied[key] = value;
    }
    Object.assign(this.data, applied);
    this._save();
    return { ...this.data };
  }
}

module.exports = { SettingsStore, DEFAULTS, MODEL_STRATEGIES, VALIDATORS };
