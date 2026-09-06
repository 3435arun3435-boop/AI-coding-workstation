'use strict';
/**
 * tasks.js
 *
 * Task Center: persistent task history with a real lifecycle.
 *
 * Statuses: queued | running | waiting_approval | testing | debugging |
 *           completed | partial | failed | blocked | cancelled
 *
 * Tracks task id, project, mode, provider/model used, start/end, duration,
 * files changed, tests run, errors, attempts, and a final summary. Supports
 * cancellation (cooperative: the agent loop checks between steps) and safe
 * retry (creates a fresh record copying title/mode/project). JSON-backed,
 * bounded, survives restarts.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATUSES = [
  'queued', 'running', 'waiting_approval', 'testing', 'debugging',
  'completed', 'partial', 'failed', 'blocked', 'cancelled',
];
const MAX_RECORDS = 200;

class TaskStore {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'tasks.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this._load();
  }

  _load() {
    if (fs.existsSync(this.filePath)) {
      try {
        this.tasks = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      } catch {
        this.tasks = [];
      }
    } else {
      this.tasks = [];
    }
  }

  _save() {
    if (this.tasks.length > MAX_RECORDS) this.tasks = this.tasks.slice(0, MAX_RECORDS);
    fs.writeFileSync(this.filePath, JSON.stringify(this.tasks, null, 2), 'utf8');
  }

  create({ title, project, provider, model, mode, parentId = null, role = null }) {
    const record = {
      id: crypto.randomUUID(),
      title,
      project,
      provider: provider || null,
      model: model || null,
      mode: mode || null,
      parentId: parentId || null,
      role: role || null,
      startTime: new Date().toISOString(),
      endTime: null,
      durationMs: null,
      status: 'running',
      filesChanged: [],
      testsRun: [],
      errors: [],
      attempts: 1,
      summary: null,
      cancelRequested: false,
    };
    this.tasks.unshift(record);
    this._save();
    return record;
  }

  /** Partial update for lifecycle transitions. Returns the updated record. */
  update(id, patch) {
    const record = this.tasks.find((t) => t.id === id);
    if (!record) return null;
    if (patch.status && !STATUSES.includes(patch.status)) throw new Error(`Invalid task status: ${patch.status}`);
    Object.assign(record, patch);
    this._save();
    return record;
  }

  complete(id, { status, filesChanged, testsRun, summary, provider, model, errors, attempts, evaluation }) {
    const record = this.tasks.find((t) => t.id === id);
    if (!record) return null;
    record.endTime = new Date().toISOString();
    record.durationMs = new Date(record.endTime) - new Date(record.startTime);
    record.status = status;
    record.filesChanged = filesChanged || [];
    record.testsRun = testsRun || [];
    record.summary = summary;
    if (provider) record.provider = provider;
    if (model) record.model = model;
    if (errors) record.errors = errors;
    if (attempts) record.attempts = attempts;
    if (evaluation) record.evaluation = evaluation;
    record.cancelRequested = false;
    this._save();
    return record;
  }

  /** Cooperative cancellation: the runner polls isCancelled between steps. */
  requestCancel(id) {
    const record = this.tasks.find((t) => t.id === id);
    if (!record) return null;
    if (['completed', 'failed', 'cancelled', 'blocked', 'partial'].includes(record.status)) {
      return record; // already finished — nothing to cancel
    }
    record.cancelRequested = true;
    this._save();
    return record;
  }

  isCancelled(id) {
    const record = this.tasks.find((t) => t.id === id);
    return !!(record && record.cancelRequested);
  }

  /** Safe retry: a NEW record with the same task parameters. Never destroys history. */
  retry(id) {
    const original = this.tasks.find((t) => t.id === id);
    if (!original) return null;
    return this.create({ title: original.title, project: original.project, provider: original.provider, model: original.model, mode: original.mode });
  }

  list(limit = 50, { status } = {}) {
    let out = this.tasks;
    if (status) out = out.filter((t) => t.status === status);
    return out.slice(0, limit);
  }

  get(id) {
    return this.tasks.find((t) => t.id === id) || null;
  }
}

module.exports = { TaskStore, STATUSES };
