'use strict';
/**
 * model-router.js
 *
 * Smart model/provider selection. The ProviderRouter already guarantees
 * bounded, legitimate fallback; this module decides the ORDER candidates are
 * tried in, based on the user's strategy (from the Settings Center) and the
 * task at hand.
 *
 * Strategies:
 *   LOCAL_FIRST       — local providers (Ollama etc.) first
 *   FREE_CLOUD_FIRST  — cloud free-tier providers first, local as fallback
 *   BEST_AVAILABLE    — the user's configured priority order, untouched
 *   CHEAPEST_AVAILABLE— local (free) → free-tier cloud → paid
 *   MANUAL            — only the user's chosen provider; if it fails the task
 *                       reports BLOCKED honestly (no silent re-routing)
 *
 * Honest limitation: provider-level capability metadata is only used when the
 * user actually configured it; the router never invents capabilities.
 */

const { resolveMode, getMode } = require('./modes');

/**
 * Classify the task into a coarse work type (used by tests/UI; ordering below
 * stays provider-level because per-model capability data is often unknown).
 */
function classifyTaskType(task, mode) {
  const modeKey = resolveMode(mode, task);
  return getMode(modeKey).label.toLowerCase();
}

/**
 * Order eligible provider entries for a task. Returns a new sorted array —
 * never mutates the router state. Entries may be key-pool expansions
 * (id like "provider#key2"); base-id comparisons strip that suffix.
 */
function orderEntries(entries, { strategy = 'FREE_CLOUD_FIRST', manualProviderId = null, mode = 'auto', task = '', reasoningPreference = 'balanced' } = {}) {
  const list = [...entries];
  const baseId = (e) => String(e.id).split('#')[0];

  if (strategy === 'MANUAL') {
    if (!manualProviderId) return list; // no manual choice configured → configured order
    const manual = list.filter((e) => baseId(e) === manualProviderId);
    return manual.length ? manual : [];
  }

  const isLocal = (e) => !!e.local;

  if (strategy === 'LOCAL_FIRST') {
    return list.sort((a, b) => Number(isLocal(b)) - Number(isLocal(a)));
  }

  if (strategy === 'FREE_CLOUD_FIRST' || strategy === 'BEST_AVAILABLE') {
    // reasoningPreference is actually read here: 'speed' breaks priority ties
    // by MEASURED latency (usage.lastLatencyMs), 'quality'/'balanced' keep the
    // user's configured priority order.
    const latency = (e) => (e.usage && typeof e.usage.lastLatencyMs === 'number' ? e.usage.lastLatencyMs : Number.MAX_SAFE_INTEGER);
    const tiebreak = reasoningPreference === 'speed' ? (a, b) => latency(a) - latency(b) : (a, b) => 0;
    if (strategy === 'FREE_CLOUD_FIRST') {
      return list.sort((a, b) => Number(isLocal(a)) - Number(isLocal(b)) || (a.priority ?? 100) - (b.priority ?? 100) || tiebreak(a, b));
    }
    return list.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || tiebreak(a, b)); // BEST_AVAILABLE
  }

  if (strategy === 'CHEAPEST_AVAILABLE') {
    const tier = (e) => (isLocal(e) ? 0 : /free/i.test(String(e.name || '')) ? 1 : 2);
    return list.sort((a, b) => tier(a) - tier(b) || (a.priority ?? 100) - (b.priority ?? 100));
  }

  return list;
}

/**
 * The ordering hook installed on the ProviderRouter. Applies offline mode
 * first (only LOCAL providers), then the strategy. If offline mode leaves
 * nothing, an explanatory error is returned via out-param so the failure is
 * honest and specific.
 */
function makeOrderingFn(settingsStore) {
  return (entries, context = {}) => {
    const strategy = settingsStore.get('modelStrategy');
    let list = entries;
    if (settingsStore.get('offlineMode')) {
      list = entries.filter((e) => e.local);
      if (list.length === 0) {
        const err = new Error('Offline mode is enabled but no LOCAL provider (e.g. Ollama) is configured or reachable.');
        err.code = 'OFFLINE_NO_LOCAL_PROVIDER';
        throw err;
      }
    }
    return orderEntries(list, {
      strategy,
      manualProviderId: settingsStore.get('manualProviderId'),
      mode: context.mode,
      task: context.task,
      reasoningPreference: settingsStore.get('reasoningPreference'),
    });
  };
}

module.exports = { classifyTaskType, orderEntries, makeOrderingFn };
