'use strict';
/**
 * profiles.js
 *
 * "Working profiles": a small, honest, keyword-matched memory of past
 * completed tasks, stored in MemoryStore's existing 'agent' category
 * (key prefix "profile:"). Before a new task starts, the agent loop looks
 * up past profiles whose keywords overlap with the new task and surfaces
 * them as prior context. After a task finishes, a compact profile is saved.
 *
 * This is deliberately simple — plain-word overlap scoring on a JSON file,
 * not a vector database or embedding search. It is inspired by Ruflo's
 * idea of agents remembering and learning from past sessions, but it is
 * NOT Ruflo's AgentDB/HNSW vector memory, which is a separate, much larger
 * Rust-based system this project does not bundle. No claim of semantic
 * search accuracy is made — only "these past tasks share some of the same
 * words as this one."
 *
 * Nothing secret is ever stored here: only task text, file paths, provider
 * id, model id, and a short status/summary — the same shape MemoryStore
 * already enforces (it rejects any key that looks secret-like).
 */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'your',
  'have', 'has', 'had', 'are', 'was', 'were', 'will', 'would', 'should',
  'could', 'when', 'then', 'than', 'them', 'they', 'what', 'which', 'while',
  'about', 'again', 'file', 'files', 'project', 'code',
  'you', 'not', 'but', 'can', 'all', 'use', 'new', 'one', 'two', 'via',
  'per', 'its', 'let', 'get', 'set', 'run', 'out', 'now', 'add', 'own',
]);

function tokenize(text) {
  return Array.from(
    new Set(
      String(text || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    )
  );
}

/**
 * Look up past working profiles whose task keywords overlap with the new
 * task. Returns up to `limit` matches, highest overlap first, ties broken
 * by recency. Overlap score 0 is never returned (no forced matches).
 */
function recallProfiles(memory, task, limit = 3) {
  const taskWords = tokenize(task);
  if (taskWords.length === 0) return [];
  const all = memory.getAll('agent');
  const scored = [];
  for (const [key, entry] of Object.entries(all)) {
    if (!key.startsWith('profile:') || !entry || !Array.isArray(entry.keywords)) continue;
    const overlap = entry.keywords.filter((w) => taskWords.includes(w));
    if (overlap.length === 0) continue;
    scored.push({ key, entry, score: overlap.length });
  }
  scored.sort((a, b) => b.score - a.score || (b.entry.ts || '').localeCompare(a.entry.ts || ''));
  return scored.slice(0, limit).map((s) => s.entry);
}

/**
 * Render recalled profiles as a short, clearly-labeled system message.
 * Returns null if there is nothing to add.
 */
function profilesToSystemMessage(profiles) {
  if (!profiles || profiles.length === 0) return null;
  const lines = profiles.map(
    (p) =>
      `- (${p.status}) "${p.task}" — files: ${p.filesChanged.length ? p.filesChanged.join(', ') : 'none'}; ${p.summary ? p.summary.slice(0, 160) : ''}`
  );
  return {
    role: 'system',
    content:
      'Working-profile memory (keyword-matched from past local tasks — a shared word count, not verified relevance; use only if actually applicable, otherwise ignore):\n' +
      lines.join('\n'),
  };
}

/**
 * Save a compact profile after a task finishes. Only called for
 * 'completed' or 'error' outcomes worth remembering — callers decide.
 */
function recordProfile(memory, { task, status, summary, filesChanged, provider, model }) {
  const id = `profile:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  memory.set('agent', id, {
    task: String(task || '').slice(0, 300),
    keywords: tokenize(task),
    status,
    summary: String(summary || '').slice(0, 400),
    filesChanged: Array.isArray(filesChanged) ? filesChanged.slice(0, 20) : [],
    provider: provider || null,
    model: model || null,
    ts: new Date().toISOString(),
  });
  return id;
}

module.exports = { recallProfiles, profilesToSystemMessage, recordProfile, tokenize };
