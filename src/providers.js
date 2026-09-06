'use strict';
/**
 * providers.js
 *
 * Generic OpenAI-compatible chat-completions client, plus a legitimate
 * fallback router across user-configured providers/keys, with an adapter
 * layer so new provider types (e.g. local Ollama, llama.cpp-style servers)
 * plug in without rewriting the router or the agent loop.
 *
 * Router rules (per spec):
 *  - only rotates among providers/keys the user has explicitly configured
 *  - never retries indefinitely (bounded attempts = number of eligible entries)
 *  - on 429/5xx/network error, marks that entry in cooldown and tries the
 *    next eligible one, recording the switch
 *  - never attempts to bypass a provider's auth, quota, or ToS
 *
 * Each entry can carry metadata:
 *  - type: 'openai-compatible' (default) | 'ollama'
 *  - local: true for local/no-key providers (Ollama, llama.cpp servers)
 *  - capabilities: { coding, reasoning, toolCalling, vision, contextLength }
 *    (unknown fields are rendered as "unknown", never invented)
 *
 * Usage/health tracking: the router records requests, failures, fallbacks,
 * latency, and token counts (when the provider reports usage) per entry and
 * exposes them via snapshot().
 */

const DEFAULT_COOLDOWN_MS = 60_000;
const MODEL_CACHE_TTL_MS = 5 * 60_000;
const modelCache = new Map(); // key 2192 { at, result }
const MODEL_LIST_TIMEOUT_MS = 5_000;
const OLLAMA_DETECT_TIMEOUT_MS = 1_500;

class ProviderRouter {
  /**
   * @param {Array|Function} entries - provider entries, OR a zero-arg function
   *   returning the current entries (late-binding, so the router always routes
   *   over what is currently configured — used by server.js so cooldown/health
   *   state survives while the provider list can still be edited live).
   */
  constructor(entries = []) {
    this._entriesSource = entries;
    this.state = new Map(); // id -> { cooldownUntil, retryCount, lastError, lastTestedAt, healthy, usage }
  }

  /**
   * Materialize the current entries, attaching per-entry runtime state.
   * Key pool: an entry with a `keys` array (multiple legitimate keys for the
   * same provider) expands into one candidate per key — each with its OWN
   * cooldown/health state — so a 429 on key 1 rotates to key 2 of the same
   * provider before any other provider is tried.
   */
  entries() {
    const list = typeof this._entriesSource === 'function' ? this._entriesSource() : this._entriesSource;
    const expanded = [];
    for (const e of list || []) {
      if (Array.isArray(e.keys) && e.keys.length > 0) {
        e.keys.forEach((key, i) => {
          expanded.push({ ...e, keys: undefined, apiKey: key, id: i === 0 ? e.id : `${e.id}#key${i + 1}`, name: i === 0 ? e.name : `${e.name} (key ${i + 1})` });
        });
      } else {
        expanded.push({ ...e, keys: undefined });
      }
    }
    return expanded.map((e) => {
      const s = this.state.get(e.id) || {
        cooldownUntil: 0,
        retryCount: 0,
        lastError: null,
        lastTestedAt: null,
        healthy: true,
        usage: { requests: 0, failures: 0, fallbacks: 0, totalLatencyMs: 0, lastLatencyMs: null, tokensPrompt: 0, tokensCompletion: 0, lastUsedAt: null },
      };
      this.state.set(e.id, s);
      return { ...e, ...s, usage: { ...s.usage } };
    });
  }

  eligibleEntries(orderContext) {
    const now = Date.now();
    const filtered = this.entries()
      .filter((e) => e.enabled !== false && e.cooldownUntil <= now)
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    if (this.orderFn) return this.orderFn(filtered, orderContext || {});
    return filtered;
  }

  /**
   * Install a strategy/ordering hook (see model-router.js). It receives the
   * priority-sorted eligible entries plus the per-task order context and must
   * return the final candidate order. May throw to refuse routing honestly
   * (e.g. offline mode with no local provider).
   */
  setOrdering(fn) {
    this.orderFn = fn;
  }

  _raw(id) {
    if (!this.state.has(id)) this.entries(); // ensure state exists
    if (!this.state.has(id)) this.state.set(id, {
      cooldownUntil: 0, retryCount: 0, lastError: null, lastTestedAt: null, healthy: true,
      usage: { requests: 0, failures: 0, fallbacks: 0, totalLatencyMs: 0, lastLatencyMs: null, tokensPrompt: 0, tokensCompletion: 0, lastUsedAt: null },
    });
    return this.state.get(id);
  }

  markCooldown(id, ms = DEFAULT_COOLDOWN_MS, error) {
    const s = this._raw(id);
    s.cooldownUntil = Date.now() + ms;
    s.retryCount += 1;
    s.lastError = error ? String(error.message || error) : null;
    s.healthy = false;
  }

  markHealthy(id) {
    const s = this._raw(id);
    s.healthy = true;
    s.lastError = null;
    s.lastTestedAt = new Date().toISOString();
  }

  /**
   * Send a chat-completion request, falling over to the next eligible
   * configured provider on failure. `callFn` defaults to the real HTTP
   * call but can be swapped out in tests.
   */
  /**
   * Send a chat-completion request with bounded fallback. `retryPolicy`
   * ({ passes, waitMs }) enables spaced same-provider retries for TRANSIENT
   * failures (429/5xx/network): after all candidates fail retryably, cooldowns
   * are shortened to waitMs and another pass runs — bounded passes, always
   * waiting between them, never hammering (§ retry within bounded policy).
   */
  async chat({ messages, tools, orderContext, retryPolicy }, callFn = callOpenAICompatible) {
    const passes = retryPolicy ? Math.max(1, Math.min(Number(retryPolicy.passes) || 1, 3)) : 1;
    const waitMs = retryPolicy ? Math.max(1000, Math.min(Number(retryPolicy.waitMs) || 5000, 30000)) : 5000;
    for (let pass = 0; pass < passes; pass++) {
      const result = await this._chatOnce({ messages, tools, orderContext }, callFn);
      if (result.ok || pass === passes - 1) return result;
      const hadTransient = (result.fallbackLog || []).some((f) => f.retryable);
      if (!hadTransient) return result;
      // Shorten transient-failure cooldowns to the retry spacing, wait, retry.
      // If the provider sent Retry-After, respect the LARGEST hint (capped 30s).
      const hintMs = Math.max(0, ...(result.fallbackLog || []).map((f) => f.retryAfterMs || 0));
      const effectiveWait = Math.min(Math.max(waitMs, hintMs), 30000);
      for (const f of result.fallbackLog) {
        if (f.retryable) {
          const s = this._raw(f.provider);
          s.cooldownUntil = Date.now() + effectiveWait;
        }
        if (f.staleModel) {
          this._raw(f.provider).staleModel = true;
        }
      }
      await new Promise((r) => setTimeout(r, effectiveWait));
    }
  }

  async _chatOnce({ messages, tools, orderContext }, callFn) {
    let candidates;
    try {
      candidates = this.eligibleEntries(orderContext);
    } catch (e) {
      // Ordering hook refused (e.g. offline mode without a local provider) —
      // fail honestly with the specific reason.
      return { ok: false, error: e.code || 'routing_refused', message: e.message, fallbackLog: [] };
    }
    if (candidates.length === 0) {
      return { ok: false, error: 'no_eligible_provider', fallbackLog: [] };
    }

    const fallbackLog = [];
    let lastErr = null;

    for (const entry of candidates) {
      const s = this._raw(entry.id);
      s.usage.requests += 1;
      const start = Date.now();
      try {
        const response = await callFn(entry, { messages, tools });
        const latency = Date.now() - start;
        s.usage.totalLatencyMs += latency;
        s.usage.lastLatencyMs = latency;
        s.usage.lastUsedAt = new Date().toISOString();
        if (response && response.usage) {
          s.usage.tokensPrompt += Number(response.usage.prompt_tokens) || 0;
          s.usage.tokensCompletion += Number(response.usage.completion_tokens) || 0;
        }
        // Any earlier skipped candidate was a fallback event.
        for (const f of fallbackLog) {
          const fs = this._raw(f.provider);
          fs.usage.fallbacks += 1;
        }
        this.markHealthy(entry.id);
        return { ok: true, response, provider: entry.id, model: entry.model, latencyMs: latency, fallbackLog };
      } catch (err) {
        const status = err && err.status;
        const retryable = status === 429 || (status >= 500 && status < 600) || err.code === 'NETWORK_ERROR';
        fallbackLog.push({ provider: entry.id, error: err.message, status: status || null, retryable, isToolContractViolation: !!err.isToolContractViolation, retryAfterMs: err.retryAfterMs || null, staleModel: !!err.staleModel, requestTooLarge: !!err.requestTooLarge, sizeLimit: err.sizeLimit || null, sizeRequested: err.sizeRequested || null });
        s.usage.failures += 1;
        s.usage.lastLatencyMs = Date.now() - start;
        if (err.staleModel) s.staleModel = true;
        lastErr = err;
        if (retryable) {
          this.markCooldown(entry.id, DEFAULT_COOLDOWN_MS, err);
          continue; // try next eligible provider — bounded by candidates.length
        }
        // Non-retryable (e.g. bad request, invalid model) — stop, don't burn through keys pointlessly
        break;
      }
    }

    return {
      ok: false,
      error: 'all_providers_failed',
      lastError: lastErr ? lastErr.message : null,
      lastErrorRequestTooLarge: !!(lastErr && lastErr.requestTooLarge),
      lastErrorSizeLimit: (lastErr && lastErr.sizeLimit) || null,
      lastErrorSizeRequested: (lastErr && lastErr.sizeRequested) || null,
      isToolContractViolation: !!(lastErr && lastErr.isToolContractViolation),
      fallbackLog,
    };
  }

  /** Health + usage snapshot for the UI/API. Never includes API keys. */
  snapshot() {
    return this.entries().map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type || 'openai-compatible',
      local: !!e.local,
      enabled: e.enabled !== false,
      priority: e.priority ?? 100,
      model: e.model || null,
      healthy: e.healthy,
      inCooldown: e.cooldownUntil > Date.now(),
      cooldownRemainingMs: Math.max(0, e.cooldownUntil - Date.now()),
      lastError: e.lastError,
      staleModel: !!e.staleModel,
      lastTestedAt: e.lastTestedAt,
      retryCount: e.retryCount,
      usage: e.usage,
    }));
  }
}

/**
 * List model ids available from a provider. Uses the per-type adapter:
 *  - ollama: GET <baseUrl>/api/tags (no auth needed, local)
 *  - openai-compatible: GET <baseUrl>/models (Bearer auth if a key is set)
 * Never throws; returns { ok, models|error }.
 */
async function listModels(entry, fetchFn = fetch, { force = false, cache = false } = {}) {
  const type = entry.type || 'openai-compatible';
  const base = String(entry.baseUrl || '').replace(/\/$/, '');
  const cacheKey = `${type}:${base}`;
  const finish = (result) => {
    if (cache && result.ok) modelCache.set(cacheKey, { at: Date.now(), result });
    return result;
  };
  try {
    // Discovery cache (§37): when the caller opts in (server API, doctor),
    // results are cached for 5 minutes so repeated reads never hammer the
    // provider. force bypasses for explicit refresh.
    const hit = modelCache.get(cacheKey);
    if (!force && hit && Date.now() - hit.at < MODEL_CACHE_TTL_MS) {
      return { ...hit.result, cached: true };
    }
    if (type === 'ollama') {
      const res = await withTimeout(fetchFn(`${base}/api/tags`), MODEL_LIST_TIMEOUT_MS);
      if (!res.ok) return finish({ ok: false, error: `HTTP ${res.status}` });
      const body = await res.json();
      const models = (body.models || []).map((m) => m.name).filter(Boolean);
      return finish({ ok: true, models });
    }
    const res = await withTimeout(
      fetchFn(`${base}/models`, entry.apiKey ? { headers: { Authorization: `Bearer ${entry.apiKey}` } } : {}),
      MODEL_LIST_TIMEOUT_MS
    );
    if (!res.ok) return finish({ ok: false, error: `HTTP ${res.status}` });
    const body = await res.json();
    const data = body.data || body.models || [];
    // Some gateways (e.g. Gemini's OpenAI-compatible layer) return ids like
    // "models/gemini-2.5-flash" — strip the prefix so the id is directly
    // usable as the chat `model` value. Same model, cleaned display.
    const models = data.map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
    return finish({ ok: true, models });
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * Probe a local Ollama server. Returns { available, models, baseUrl }.
 * Only reports what is actually detected — never fabricates models.
 */
async function detectOllama(baseUrl = 'http://localhost:11434', fetchFn = fetch) {
  try {
    const res = await withTimeout(fetchFn(`${baseUrl.replace(/\/$/, '')}/api/tags`), OLLAMA_DETECT_TIMEOUT_MS);
    if (!res.ok) return { available: false, models: [], baseUrl, error: `HTTP ${res.status}` };
    const body = await res.json();
    const models = (body.models || []).map((m) => m.name).filter(Boolean);
    return { available: true, models, baseUrl };
  } catch (e) {
    return { available: false, models: [], baseUrl, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Real network call to an OpenAI-compatible /chat/completions endpoint.
 * Works for cloud providers and for local servers (Ollama exposes the same
 * shape at /v1; llama.cpp servers expose it too). Not used in tests (no
 * network egress there) — tests inject a mock callFn.
 */
async function callOpenAICompatible(entry, { messages, tools }) {
  const url = `${entry.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(entry.apiKey ? { Authorization: `Bearer ${entry.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: entry.model, messages, tools }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Provider ${entry.id} returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    err.status = res.status;
    // Rate-limit handling (spec 00a736): respect the provider's Retry-After hint.
    const retryAfter = res.headers && res.headers.get('retry-after');
    if (retryAfter) {
      const secs = Number(retryAfter);
      err.retryAfterMs = Number.isFinite(secs) ? secs * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()) || null;
    }
    // Stale/deprecated model detection (spec 00a737): a 404 naming the model.
    if (res.status === 404 && /does not exist|no longer available|deprecat/i.test(text)) {
      err.staleModel = true;
    }
    // The model called a tool name that wasn't in the `tools` array we sent
    // (e.g. it hallucinated a tool from a different agent framework, like
    // "repo_browser.print_tree"). Some OpenAI-compatible providers validate
    // this server-side and reject the whole turn with a 400 before we ever
    // see a tool_call. That's a MODEL/prompt problem, not a provider outage —
    // switching to another configured provider/key won't fix it, but retrying
    // the same step with a corrective reminder often will. Tag it so the
    // router and agent loop can tell the two apart.
    err.isToolContractViolation = res.status === 400 && /not in request\.tools|tool call validation failed|which was not in request/i.test(text);
    throw err;
  }
  return res.json();
}

module.exports = {
  ProviderRouter,
  callOpenAICompatible,
  listModels,
  detectOllama,
  DEFAULT_COOLDOWN_MS,
};
