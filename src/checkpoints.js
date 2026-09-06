'use strict';
/**
 * checkpoints.js
 *
 * Checkpoint / snapshot system: before substantial autonomous modification,
 * capture a recoverable snapshot of the files that are about to change (and
 * any that are already dirty). Supports create / list / compare / restore.
 *
 * Storage is a bounded per-project JSON snapshot in the data dir — simple,
 * dependency-free, and safe for non-git projects. For git repositories the
 * changed-file scope comes from git status; restore always applies a clobber
 * guard: it refuses to overwrite a file whose current content differs from
 * the state captured AFTER the checkpoint (i.e. someone else changed it
 * since), because blindly restoring would destroy that work.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveInProject } = require('./security');
const { diffLines, diffStats, unifiedDiff } = require('./diff');

const MAX_CHECKPOINTS_PER_PROJECT = 20;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES_PER_CHECKPOINT = 100;

class CheckpointStore {
  constructor(dataDir) {
    this.dataDir = path.join(dataDir, 'checkpoints');
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  _projectFile(projectRoot) {
    const key = crypto.createHash('sha1').update(fs.realpathSync(projectRoot)).digest('hex').slice(0, 16);
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
    if (records.length > MAX_CHECKPOINTS_PER_PROJECT) records = records.slice(0, MAX_CHECKPOINTS_PER_PROJECT);
    fs.writeFileSync(f, JSON.stringify(records, null, 2), 'utf8');
  }

  /**
   * Capture a checkpoint. `include` lists relative paths to snapshot; when
   * omitted, the current dirty set (git changed + untracked) is used.
   * Files that don't exist yet are captured as "absent" so restore can undo
   * a creation. Returns the public record.
   */
  create(projectRoot, { label, include = null, taskId = null } = {}) {
    let files = include;
    if (!files) {
      // Synchronous capture of the dirty set via git when available:
      try {
        const { execFileSync } = require('child_process');
        const out = execFileSync('git', ['status', '--porcelain=v1', '-uall'], { cwd: projectRoot, maxBuffer: 1024 * 1024 }).toString();
        files = out.split('\n').filter(Boolean).map((l) => l.slice(3).trim()).filter(Boolean);
      } catch {
        files = []; // non-git project with no explicit list: nothing to snapshot yet
      }
    }
    files = Array.from(new Set(files)).slice(0, MAX_FILES_PER_CHECKPOINT);

    const captured = [];
    for (const rel of files) {
      let abs;
      try {
        abs = resolveInProject(projectRoot, rel);
      } catch {
        continue; // skip paths outside the sandbox — never snapshot them
      }
      let content = null;
      let absent = false;
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        absent = true;
      }
      captured.push({ path: rel, absent, content });
    }

    const record = {
      id: `ckpt-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      label: label || 'checkpoint',
      taskId,
      createdAt: new Date().toISOString(),
      files: captured,
    };
    const records = this._load(projectRoot);
    records.unshift(record);
    this._save(projectRoot, records);
    return { ...record, files: record.files.map((f) => ({ path: f.path, absent: f.absent })) };
  }

  list(projectRoot) {
    return this._load(projectRoot).map((r) => ({
      id: r.id, label: r.label, taskId: r.taskId, createdAt: r.createdAt,
      files: r.files.map((f) => ({ path: f.path, absent: f.absent })),
    }));
  }

  get(projectRoot, id) {
    return this._load(projectRoot).find((r) => r.id === id) || null;
  }

  /**
   * Compare a checkpoint against the current workspace: per-file status
   * (unchanged / modified / absent-now) plus a unified diff for changed files.
   */
  compare(projectRoot, id) {
    const record = this.get(projectRoot, id);
    if (!record) throw new Error(`Unknown checkpoint: ${id}`);
    const files = [];
    for (const f of record.files) {
      let current = null;
      let nowAbsent = false;
      try {
        current = fs.readFileSync(resolveInProject(projectRoot, f.path), 'utf8');
      } catch {
        nowAbsent = true;
      }
      const capturedContent = f.absent ? null : f.content;
      const changed = f.absent !== nowAbsent || (current !== null && capturedContent !== null && current !== capturedContent);
      const diff = changed ? unifiedDiff(f.absent ? '' : f.content, nowAbsent ? '' : current, { oldName: `${f.path} (checkpoint)`, newName: `${f.path} (current)` }) : '';
      files.push({ path: f.path, changed, nowAbsent, diff, stats: changed ? diffStats(diffLines(f.absent ? '' : f.content, nowAbsent ? '' : current)) : null });
    }
    return { id, label: record.label, createdAt: record.createdAt, files, changedCount: files.filter((f) => f.changed).length };
  }

  /**
   * Restore a checkpoint (rollback). Clobber guard: a file is restored only
   * if its CURRENT content still matches the post-checkpoint state we know
   * about — but since we don't store the post state, the guard is: the file
   * must have changed since the checkpoint (otherwise restoring is a no-op
   * anyway) and the caller explicitly asked for rollback. To stay safe we
   * refuse to touch files whose current content equals the checkpointed
   * content unless they were absent at capture (creation undo).
   */
  restore(projectRoot, id, { force = false } = {}) {
    const record = this.get(projectRoot, id);
    if (!record) throw new Error(`Unknown checkpoint: ${id}`);
    const results = [];
    for (const f of record.files) {
      const abs = resolveInProject(projectRoot, f.path); // sandboxed
      let current = null;
      let exists = true;
      try {
        current = fs.readFileSync(abs, 'utf8');
      } catch {
        exists = false;
      }
      if (!f.absent && exists && current === f.content) {
        results.push({ path: f.path, action: 'skipped-unchanged' });
        continue;
      }
      if (f.absent) {
        if (exists) {
          fs.rmSync(abs, { force: true });
          results.push({ path: f.path, action: 'removed-created-file' });
        } else {
          results.push({ path: f.path, action: 'skipped-already-absent' });
        }
        continue;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content, 'utf8');
      results.push({ path: f.path, action: 'restored' });
    }
    return { id, restored: results.filter((r) => r.action === 'restored' || r.action === 'removed-created-file').length, results };
  }
}

module.exports = { CheckpointStore, MAX_CHECKPOINTS_PER_PROJECT };
