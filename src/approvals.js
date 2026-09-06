'use strict';
/**
 * approvals.js
 *
 * The approval engine: every meaningful AI modification can be held as a
 * proposal with a computed diff, shown to the user, then approved / rejected
 * / reverted. File proposals are applied inside the project-root sandbox and
 * guard against clobbering a file that changed since the proposal was made;
 * command proposals are executed with a timeout when approved.
 *
 * The store persists to <dataDir>/approvals.json (bounded) and is an
 * EventEmitter emitting 'pending' and 'decided' events.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { sanitizedEnv } = require('./exec-env');
const { resolveInProject } = require('./security');
const { diffLines, diffStats, unifiedDiff } = require('./diff');

const MAX_RECORDS = 200;
const DEFAULT_DECISION_TIMEOUT_MS = 300_000; // 5 min, then the agent moves on
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_BUFFER = 5 * 1024 * 1024;

class ApprovalStore extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'approvals.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this._load();
  }

  _load() {
    if (fs.existsSync(this.filePath)) {
      try {
        this.records = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      } catch {
        this.records = [];
      }
    } else {
      this.records = [];
    }
  }

  _save() {
    if (this.records.length > MAX_RECORDS) this.records = this.records.slice(0, MAX_RECORDS);
    fs.writeFileSync(this.filePath, JSON.stringify(this.records, null, 2), 'utf8');
  }

  /**
   * Create a pending proposal and compute its diff.
   *  - type 'file': path, oldContent (null for create), newContent, projectRoot
   *  - type 'command': command, projectRoot, timeoutMs
   * Returns the record (with oldContent/newContent kept for apply/revert).
   */
  propose({ type, taskId, projectRoot, path: filePath, oldContent, newContent, command, timeoutMs, risk, title }) {
    if (type !== 'file' && type !== 'command') throw new Error(`Unknown proposal type: ${type}`);
    if (type === 'file' && (!filePath || typeof newContent !== 'string')) throw new Error('File proposal requires path and newContent');
    if (type === 'command' && (!command || typeof command !== 'string')) throw new Error('Command proposal requires command');

    let diff = null;
    let stats = null;
    if (type === 'file') {
      const ops = diffLines(oldContent ?? '', newContent);
      stats = diffStats(ops);
      if (oldContent === null) {
        stats = { ...stats, created: true };
        diff = unifiedDiff('', newContent, { oldName: '/dev/null', newName: filePath });
      } else {
        diff = unifiedDiff(oldContent, newContent, { oldName: filePath, newName: filePath });
      }
      if (oldContent === newContent) throw new Error('Refusing to propose a no-op change (content is identical)');
    }

    const record = {
      id: `prop-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      type,
      taskId: taskId || null,
      projectRoot,
      path: filePath || null,
      command: command || null,
      oldContent: type === 'file' ? oldContent : undefined,
      newContent: type === 'file' ? newContent : undefined,
      diff,
      stats,
      risk: risk || { level: type === 'command' ? 'medium' : 'medium', reason: '' },
      title:
        title ||
        (type === 'file'
          ? `${oldContent === null ? 'Create' : 'Modify'} ${filePath}`
          : `Run command: ${command}`),
      timeoutMs: timeoutMs || DEFAULT_DECISION_TIMEOUT_MS,
      status: 'pending',
      createdAt: new Date().toISOString(),
      decidedAt: null,
      decidedBy: null,
      appliedAt: null,
      result: null,
      error: null,
    };
    this.records.unshift(record);
    this._save();
    this.emit('pending', publicRecord(record));
    return record;
  }

  get(id) {
    return this.records.find((r) => r.id === id) || null;
  }

  list(filter = {}) {
    let out = this.records;
    if (filter.status) out = out.filter((r) => r.status === filter.status);
    if (filter.taskId) out = out.filter((r) => r.taskId === filter.taskId);
    return out.map(publicRecord);
  }

  /**
   * Decide a pending proposal. 'approved' applies it immediately (file writes
   * synchronously; commands execute and capture output). Emits 'decided' with
   * the public record. Returns the updated record.
   */
  async decide(id, decision, decidedBy = 'user') {
    const record = this.get(id);
    if (!record) throw new Error(`Unknown proposal: ${id}`);
    if (record.status !== 'pending') throw new Error(`Proposal ${id} is already ${record.status}`);
    if (decision !== 'approved' && decision !== 'rejected') throw new Error(`Invalid decision: ${decision}`);

    record.decidedAt = new Date().toISOString();
    record.decidedBy = decidedBy;

    if (decision === 'rejected') {
      record.status = 'rejected';
      this._save();
      this.emit('decided', publicRecord(record));
      return publicRecord(record);
    }

    try {
      record.result = record.type === 'file' ? this._applyFile(record) : await this._applyCommand(record);
      record.status = 'applied';
      record.appliedAt = new Date().toISOString();
    } catch (e) {
      record.status = 'apply_failed';
      record.error = e && e.message ? e.message : String(e);
    }
    this._save();
    this.emit('decided', publicRecord(record));
    return publicRecord(record);
  }

  _applyFile(record) {
    const abs = resolveInProject(record.projectRoot, record.path);
    if (record.oldContent !== null && record.oldContent !== undefined) {
      let current = null;
      try {
        current = fs.readFileSync(abs, 'utf8');
      } catch {
        current = null;
      }
      if (current !== record.oldContent) {
        throw new Error('File changed since the proposal was created — re-review before applying');
      }
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, record.newContent, 'utf8');
    return { path: record.path, bytesWritten: Buffer.byteLength(record.newContent, 'utf8') };
  }

  async _applyCommand(record) {
    const timeoutMs = Math.min(Number(record.timeoutMs) || DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS);
    const start = Date.now();
    return await new Promise((resolve) => {
      execFile(
        process.platform === 'win32' ? 'cmd' : '/bin/sh',
        process.platform === 'win32' ? ['/c', record.command] : ['-c', record.command],
        { cwd: record.projectRoot, timeout: timeoutMs, maxBuffer: MAX_COMMAND_BUFFER, env: sanitizedEnv() },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - start;
          if (error && error.killed) {
            resolve({ command: record.command, timedOut: true, durationMs, stdout, stderr });
            return;
          }
          resolve({
            command: record.command,
            exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
            stdout,
            stderr,
            durationMs,
          });
        }
      );
    });
  }

  /**
   * Wait until a pending proposal is decided (or the timeout elapses).
   * Resolves 'approved' | 'rejected' | 'timeout'.
   */
  waitForDecision(id, timeoutMs) {
    const record = this.get(id);
    if (!record) return Promise.resolve('rejected');
    if (record.status !== 'pending') return Promise.resolve(record.status === 'applied' || record.status === 'apply_failed' ? 'approved' : 'rejected');
    const effectiveTimeout = Math.min(Number(timeoutMs) || record.timeoutMs, Number(timeoutMs) || record.timeoutMs);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.removeListener('decided', onDecided);
          resolve('timeout');
        }
      }, effectiveTimeout);
      const onDecided = (pub) => {
        if (pub.id !== id || settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(pub.status === 'applied' || pub.status === 'apply_failed' ? 'approved' : 'rejected');
      };
      this.on('decided', onDecided);
    });
  }

  /**
   * Revert an applied file proposal: restores the old content, but only if
   * the file still exactly matches what was applied. Never touches commands.
   */
  revert(id) {
    const record = this.get(id);
    if (!record) throw new Error(`Unknown proposal: ${id}`);
    if (record.status !== 'applied') throw new Error(`Only applied proposals can be reverted (this one is ${record.status})`);
    if (record.type !== 'file') throw new Error('Command proposals cannot be reverted — undo the effect manually');

    const abs = resolveInProject(record.projectRoot, record.path);
    let current = null;
    try {
      current = fs.readFileSync(abs, 'utf8');
    } catch {
      current = null;
    }
    if (current !== record.newContent) {
      throw new Error('File has changed since the proposal was applied — automatic revert is unsafe');
    }
    if (record.oldContent === null || record.oldContent === undefined) {
      fs.rmSync(abs, { force: true }); // the proposal created the file; revert removes it
    } else {
      fs.writeFileSync(abs, record.oldContent, 'utf8');
    }
    record.status = 'reverted';
    record.decidedAt = new Date().toISOString();
    this._save();
    return publicRecord(record);
  }
}

/** Strip bulky content fields for transport/storage of lists and events. */
function publicRecord(record) {
  const { oldContent, newContent, ...rest } = record;
  return { ...rest, oldContentBytes: oldContent == null ? 0 : Buffer.byteLength(String(oldContent)), newContentBytes: newContent == null ? 0 : Buffer.byteLength(String(newContent)) };
}

module.exports = { ApprovalStore, DEFAULT_DECISION_TIMEOUT_MS };
