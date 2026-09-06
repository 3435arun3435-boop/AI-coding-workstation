'use strict';
/**
 * knowledge.js
 *
 * Failure Knowledge Base: bounded, project-scoped memory of what was tried
 * against an error and what actually worked. When a similar error appears
 * later, prior knowledge is retrieved and injected into the investigation —
 * so the agent never blindly repeats a failed fix.
 *
 * Matching is honest: keyword overlap between the stored error signature and
 * the new error text (NOT semantic search). Records store the error
 * signature, affected files, the attempted fixes with their outcomes, the
 * successful fix, and the final test evidence.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tokenizeForRelevance } = require('./project-intel');

const MAX_RECORDS_PER_PROJECT = 100;

class KnowledgeStore {
  constructor(dataDir) {
    this.dataDir = path.join(dataDir, 'knowledge');
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  _projectFile(projectRoot) {
    let key;
    try {
      key = crypto.createHash('sha1').update(fs.realpathSync(projectRoot)).digest('hex').slice(0, 16);
    } catch {
      key = 'unknown';
    }
    return path.join(this.dataDir, `${key}.json`);
  }

  _load(projectRoot) {
    const f = this._projectFile(projectRoot);
    if (!fs.existsSync(f)) return [];
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return [];
    }
  }

  _save(projectRoot, records) {
    const f = this._projectFile(projectRoot);
    if (records.length > MAX_RECORDS_PER_PROJECT) records = records.slice(0, MAX_RECORDS_PER_PROJECT);
    fs.writeFileSync(f, JSON.stringify(records, null, 2), 'utf8');
  }

  /**
   * Record a debugging episode. `attempts` is [{summary, result}] in order
   * ('failed' | 'succeeded' | 'skipped'). The record is bounded.
   */
  record(projectRoot, { errorSignature, affectedFiles = [], investigation = '', attempts = [], successfulFix = null, finalResult = 'unknown', tests = null }) {
    const record = {
      id: `kb-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      createdAt: new Date().toISOString(),
      errorSignature: String(errorSignature || '').slice(0, 2000),
      affectedFiles: affectedFiles.slice(0, 20),
      investigation: String(investigation || '').slice(0, 2000),
      attempts: attempts.slice(0, 10).map((a) => ({ summary: String(a.summary || '').slice(0, 500), result: a.result })),
      successfulFix: successfulFix ? String(successfulFix).slice(0, 1000) : null,
      finalResult,
      tests,
    };
    const records = this._load(projectRoot);
    records.unshift(record);
    this._save(projectRoot, records);
    return record;
  }

  list(projectRoot, limit = 20) {
    return this._load(projectRoot).slice(0, limit);
  }

  /**
   * Retrieve prior knowledge relevant to an error text. Scores by token
   * overlap between the error text and stored signatures/affected files.
   * Zero-overlap records are never returned (no forced matches).
   */
  search(projectRoot, errorText, limit = 2) {
    const words = new Set(tokenizeForRelevance(errorText));
    if (words.size === 0) return [];
    const scored = [];
    for (const r of this._load(projectRoot)) {
      const sigWords = new Set(tokenizeForRelevance(`${r.errorSignature} ${r.affectedFiles.join(' ')}`));
      let score = 0;
      for (const w of sigWords) if (words.has(w)) score += 1;
      if (score > 0) scored.push({ record: r, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.record);
  }

  /** Render retrieved knowledge as an advisory system message (or null). */
  toSystemMessage(records) {
    if (!records || records.length === 0) return null;
    const blocks = records.map((r) => {
      const failed = r.attempts.filter((a) => a.result === 'failed').map((a) => `  - FAILED attempt: ${a.summary}`);
      return (
        `### Past debugging episode (${r.createdAt}) — final result: ${r.finalResult}\n` +
        `Error signature: ${r.errorSignature.slice(0, 300)}\n` +
        `Affected files: ${r.affectedFiles.join(', ') || 'unknown'}\n` +
        (failed.length ? `${failed.join('\n')}\nDo NOT repeat these failed approaches.\n` : '') +
        (r.successfulFix ? `Successful fix: ${r.successfulFix}\n` : '')
      );
    });
    return {
      role: 'system',
      content:
        'Failure-knowledge base (keyword-matched past debugging episodes from THIS project — advisory only):\n' +
        blocks.join('\n'),
    };
  }
}

module.exports = { KnowledgeStore };
