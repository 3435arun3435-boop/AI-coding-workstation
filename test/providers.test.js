'use strict';
// Phase 1 — Provider Manager 2.0: adapters, health/usage tracking, late-bound
// routing, model discovery, Ollama detection, and config normalization.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ProviderRouter, listModels, detectOllama } = require('../src/providers');
const { ConfigStore, normalizeProvider, SAFETY_MODES, OLLAMA_PROVIDER_ID } = require('../src/config');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
test('router records usage (requests, latency) on a successful call', async () => {
  const router = new ProviderRouter([{ id: 'p1', enabled: true, priority: 1 }]);
  const result = await router.chat(
    { messages: [] },
    async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
  );
  assert.equal(result.ok, true);
  const snap = router.snapshot().find((s) => s.id === 'p1');
  assert.equal(snap.usage.requests, 1);
  assert.equal(snap.usage.failures, 0);
  assert.equal(snap.usage.tokensPrompt, 10);
  assert.equal(snap.usage.tokensCompletion, 5);
  assert.equal(typeof snap.usage.lastLatencyMs, 'number');
  assert.equal(snap.healthy, true);
});

test('router records failure + fallback counts when falling over to the next provider', async () => {
  const router = new ProviderRouter([
    { id: 'primary', enabled: true, priority: 1 },
    { id: 'secondary', enabled: true, priority: 2 },
  ]);
  const mockCall = async (entry) => {
    if (entry.id === 'primary') {
      const err = new Error('rate limited');
      err.status = 429;
      throw err;
    }
    return { choices: [{ message: { content: 'ok' } }] };
  };
  const result = await router.chat({ messages: [] }, mockCall);
  assert.equal(result.ok, true);
  const primary = router.snapshot().find((s) => s.id === 'primary');
  const secondary = router.snapshot().find((s) => s.id === 'secondary');
  assert.equal(primary.usage.failures, 1);
  assert.equal(primary.usage.fallbacks, 1, 'skipping primary counts as one fallback event');
  assert.equal(primary.healthy, false, 'primary is in cooldown');
  assert.equal(secondary.usage.requests, 1);
  assert.equal(secondary.usage.fallbacks, 0);
});

test('router accepts a late-binding entries function (health survives entry edits)', async () => {
  const providers = [{ id: 'a', enabled: true, priority: 1 }];
  const router = new ProviderRouter(() => providers);
  let servedBy = null;
  const result = await router.chat({ messages: [] }, async (e) => {
    servedBy = e.id;
    return { choices: [{ message: { content: 'ok' } }] };
  });
  assert.equal(result.ok, true);
  assert.equal(servedBy, 'a');
  // Add a new provider after construction — the router must see it.
  providers.push({ id: 'b', enabled: true, priority: 2 });
  assert.equal(router.eligibleEntries().length, 2);
});

test('snapshot() never leaks apiKey material', async () => {
  const router = new ProviderRouter([{ id: 'p', enabled: true, apiKey: 'sk-supersecret' }]);
  await router.chat({ messages: [] }, async () => ({ choices: [{ message: { content: 'x' } }] }));
  const json = JSON.stringify(router.snapshot());
  assert.ok(!json.includes('sk-supersecret'));
});

// ---------------------------------------------------------------------------
test('listModels() reads Ollama /api/tags via the ollama adapter', async () => {
  const mockFetch = async (url) => {
    assert.match(String(url), /\/api\/tags$/);
    return { ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen2.5-coder:7b' }] }) };
  };
  const result = await listModels({ id: 'ollama-local', type: 'ollama', baseUrl: 'http://localhost:11434' }, mockFetch);
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['llama3.2:latest', 'qwen2.5-coder:7b']);
});

test('listModels() reads /models via the openai-compatible adapter with auth header', async () => {
  let seenAuth = null;
  const mockFetch = async (url, opts) => {
    seenAuth = opts && opts.headers ? opts.headers.Authorization : null;
    return { ok: true, json: async () => ({ data: [{ id: 'llama-3.3-70b' }, { id: 'mixtral-8x7b' }] }) };
  };
  const result = await listModels(
    { id: 'groq-1', type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k1' },
    mockFetch
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['llama-3.3-70b', 'mixtral-8x7b']);
  assert.equal(seenAuth, 'Bearer k1');
});

test('listModels() returns ok:false with an error instead of throwing on failure', async () => {
  const mockFetch = async () => {
    throw new Error('connection refused');
  };
  const result = await listModels({ id: 'x', type: 'ollama', baseUrl: 'http://localhost:11434' }, mockFetch);
  assert.equal(result.ok, false);
  assert.match(result.error, /connection refused/);
});

// ---------------------------------------------------------------------------
test('detectOllama() reports available models when the server responds', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ models: [{ name: 'llama3.2:latest' }] }),
  });
  const detection = await detectOllama('http://localhost:11434', mockFetch);
  assert.equal(detection.available, true);
  assert.deepEqual(detection.models, ['llama3.2:latest']);
});

test('detectOllama() reports unavailable (never fabricates) when nothing is listening', async () => {
  const mockFetch = async () => {
    const err = new Error('ECONNREFUSED');
    err.code = 'NETWORK_ERROR';
    throw err;
  };
  const detection = await detectOllama('http://localhost:11434', mockFetch);
  assert.equal(detection.available, false);
  assert.deepEqual(detection.models, []);
});

// ---------------------------------------------------------------------------
test('normalizeProvider() adds additive metadata without inventing capabilities', () => {
  const p = normalizeProvider({ id: 'x', baseUrl: 'http://x' });
  assert.equal(p.type, 'openai-compatible');
  assert.equal(p.local, false);
  assert.equal(p.capabilities, null, 'capabilities stay unknown unless actually provided');
});

test('config stores and validates the safety mode', () => {
  const dataDir = tmpDir('agent-cfg-safety-');
  const store = new ConfigStore(dataDir);
  assert.equal(store.getSafetyMode(), 'agent'); // safe default
  store.setSafetyMode('readonly');
  const reloaded = new ConfigStore(dataDir);
  assert.equal(reloaded.getSafetyMode(), 'readonly');
  assert.throws(() => store.setSafetyMode('yolo'));
  assert.ok(SAFETY_MODES.includes('autonomous'));
});

test('ensureOllamaProvider() enables the local entry only when Ollama responds', () => {
  const dataDir = tmpDir('agent-cfg-ollama-');
  const store = new ConfigStore(dataDir);

  const offline = store.ensureOllamaProvider({ available: false, models: [], baseUrl: 'http://localhost:11434' });
  assert.equal(offline.id, OLLAMA_PROVIDER_ID);
  assert.equal(offline.enabled, false);
  assert.equal(offline.local, true);
  assert.equal(offline.type, 'ollama');
  assert.ok(!('availableModels' in offline), 'no fabricated model list when offline');

  const online = store.ensureOllamaProvider({
    available: true,
    models: ['llama3.2:latest', 'qwen2.5-coder:7b'],
    baseUrl: 'http://localhost:11434',
  });
  assert.equal(online.enabled, true);
  assert.equal(online.model, 'llama3.2:latest');
  assert.deepEqual(online.availableModels, ['llama3.2:latest', 'qwen2.5-coder:7b']);
  assert.equal(online.apiKey, undefined, 'masked provider output never includes raw key material');
});
