'use strict';
/**
 * credentials.js
 *
 * Credential-failure classification for the multi-key pool (§3-§6).
 *
 * Three failure kinds with different pool behavior:
 *   temporary — 429 (per-minute TPM/RPM), Retry-After, 5xx, network, timeout
 *               → bounded cooldown, then the key returns to the pool
 *   exhausted — daily/weekly/monthly quota or credits exhausted
 *               → unavailable until the provider-reported reset time
 *                 (resetAt) or, if unknown, an honest long cooldown with
 *                 quotaState='exhausted' + resetAt='unknown'. NEVER invented.
 *   invalid   — invalid/revoked/unauthorized key
 *               → the credential is disabled until the user re-verifies it;
 *                 never retried automatically
 */

const KINDS = ['temporary', 'exhausted', 'invalid'];

const INVALID_PATTERNS = /invalid api key|invalid_api_key|unauthorized|invalid request header|revoked|credential.*invalid|authentication failed/i;
const EXHAUSTED_PATTERNS = /tokens per day|daily quota|monthly quota|weekly quota|quota exceeded|credits exhausted|exceeded your current quota|billing/i;

/**
 * Classify a provider failure into a credential failure.
 * @returns {{ kind: string, retryAfterHint: string|null, resetAt: string|null, quotaState: string|null }}
 */
function classifyCredentialFailure({ status, text = '', code = null } = {}) {
  const t = String(text || '');
  const out = { kind: 'temporary', retryAfterHint: null, resetAt: null, quotaState: null };

  // Provider body hints first (Groq: "Please try again in 5m22.704s")
  const hintMatch = t.match(/try again in ([\dhms.]+)/i);
  if (hintMatch) out.retryAfterHint = hintMatch[1].replace(/\.+$/, ''); // strip sentence-ending period

  // Invalid credentials (401/403 with auth wording, or explicit codes)
  if (status === 401 || status === 403 || INVALID_PATTERNS.test(t)) {
    out.kind = 'invalid';
    return out;
  }

  // Exhausted quotas — only provider-reported wording counts.
  if (EXHAUSTED_PATTERNS.test(t)) {
    out.kind = 'exhausted';
    out.quotaState = 'exhausted';
    if (out.retryAfterHint) {
      out.resetAt = parseRelativeHint(out.retryAfterHint);
    }
    return out;
  }

  // 429 without explicit quota wording: temporary rate limit (per-minute).
  if (status === 429) {
    if (out.retryAfterHint) out.resetAt = parseRelativeHint(out.retryAfterHint);
    return out;
  }

  // 5xx / network / timeout / unknown: temporary by definition.
  out.quotaState = null;
  return out;
}

/** Convert "5m22.704s" / "1h2m" / "45s" into an absolute ISO reset time. */
function parseRelativeHint(hint) {
  const m = String(hint || '').match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  if (!m) return null;
  const h = Number(m[1]) || 0;
  const min = Number(m[2]) || 0;
  const sec = Number(m[3]) || 0;
  if (!h && !min && !sec) return null;
  return new Date(Date.now() + ((h * 3600 + min * 60 + sec) * 1000)).toISOString();
}

/** Cooldown duration for a classified failure. */
function cooldownFor(classification) {
  if (classification.kind === 'invalid') return Number.POSITIVE_INFINITY;
  if (classification.kind === 'exhausted') {
    if (classification.resetAt) {
      const wait = new Date(classification.resetAt).getTime() - Date.now();
      if (wait > 0) return Math.min(wait, 24 * 3600_000);
    }
    return 6 * 3600_000; // reset unknown — honest long cooldown, re-probed later
  }
  if (classification.retryAfterHint) {
    const resetAt = parseRelativeHint(classification.retryAfterHint);
    if (resetAt) return Math.max(1000, new Date(resetAt).getTime() - Date.now());
  }
  return 60_000; // default temporary cooldown
}

module.exports = { KINDS, classifyCredentialFailure, parseRelativeHint, cooldownFor, INVALID_PATTERNS, EXHAUSTED_PATTERNS };
