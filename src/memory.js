'use strict';
/**
 * memory.js
 *
 * Persistent memory, stored as JSON on disk under <dataDir>/memory.json.
 * Categories: global, project, task, agent, session.
 *
 * Never stores API keys, passwords, tokens, or secrets — any key/value pair
 * whose key name looks secret-like is rejected at write time.
 */

const fs = require('fs');
const path = require('path');

const SECRET_KEY_PATTERN = /(api[_-]?key|password|secret|token|credential)/i;
const CATEGORIES = ['global', 'project', 'task', 'agent', 'session'];
const MAX_ENTRIES_PER_CATEGORY = 500;

class MemoryStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'memory.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this._load();
  }

  _load() {
    if (fs.existsSync(this.filePath)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      } catch {
        this.data = this._empty();
      }
    } else {
      this.data = this._empty();
    }
    for (const c of CATEGORIES) {
      if (!this.data[c]) this.data[c] = {};
    }
  }

  _empty() {
    return Object.fromEntries(CATEGORIES.map((c) => [c, {}]));
  }

  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  _assertCategory(category) {
    if (!CATEGORIES.includes(category)) {
      throw new Error(`Unknown memory category: ${category}. Valid: ${CATEGORIES.join(', ')}`);
    }
  }

  /**
   * Store a value. Keys that look secret-like are rejected. Bounded: when a
   * category exceeds MAX_ENTRIES_PER_CATEGORY, the OLDEST entries (first
   * inserted) are evicted. Optional `scope` namespaces the key (e.g. a
   * project id) so different projects don't overwrite each other.
   */
  set(category, key, value, { scope } = {}) {
    this._assertCategory(category);
    const fullKey = scope ? `${scope}::${key}` : key;
    if (SECRET_KEY_PATTERN.test(fullKey)) {
      throw new Error(`Refusing to store secret-like key in memory: ${key}`);
    }
    const bucket = this.data[category];
    // Re-insert to move the key to the end (marks it as most recently written).
    delete bucket[fullKey];
    bucket[fullKey] = value;
    const keys = Object.keys(bucket);
    if (keys.length > MAX_ENTRIES_PER_CATEGORY) {
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES_PER_CATEGORY)) delete bucket[k];
    }
    this._save();
    return true;
  }

  get(category, key, { scope } = {}) {
    this._assertCategory(category);
    return this.data[category][scope ? `${scope}::${key}` : key];
  }

  getAll(category, { scope } = {}) {
    this._assertCategory(category);
    const bucket = this.data[category];
    if (!scope) return { ...bucket };
    const out = {};
    const prefix = `${scope}::`;
    for (const [k, v] of Object.entries(bucket)) {
      if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
    }
    return out;
  }

  delete(category, key) {
    this._assertCategory(category);
    delete this.data[category][key];
    this._save();
    return true;
  }

  clear(category) {
    if (category) {
      this._assertCategory(category);
      this.data[category] = {};
    } else {
      this.data = this._empty();
    }
    this._save();
    return true;
  }

  search(term) {
    const lower = term.toLowerCase();
    const hits = [];
    for (const cat of CATEGORIES) {
      for (const [k, v] of Object.entries(this.data[cat])) {
        const asString = `${k} ${JSON.stringify(v)}`.toLowerCase();
        if (asString.includes(lower)) hits.push({ category: cat, key: k, value: v });
      }
    }
    return hits;
  }

  status() {
    const bytes = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
    const counts = Object.fromEntries(CATEGORIES.map((c) => [c, Object.keys(this.data[c]).length]));
    return { path: this.filePath, bytes, counts };
  }
}

module.exports = { MemoryStore, CATEGORIES, SECRET_KEY_PATTERN };
