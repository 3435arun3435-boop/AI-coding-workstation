'use strict';
/**
 * git.js
 *
 * Git intelligence via the native `git` CLI (no git framework dependency).
 * Read-only operations: repo detection, branch, status, diff, log.
 *
 * Destructive git operations (reset --hard, clean, force push, checkout
 * discard, rebase…) are NEVER executed by this module. The tool-level gate
 * classifies any such command as CRITICAL and holds it for explicit user
 * approval, and commits go through the approval system as proposals —
 * this module deliberately exposes no way to bypass that.
 */

const { execFile } = require('child_process');
const { sanitizedEnv } = require('./exec-env');

const MAX_OUTPUT_BYTES = 512 * 1024;

function git(root, args, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: root, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, env: sanitizedEnv() },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          const e = new Error(stderr || error.message);
          e.exitCode = typeof error.code === 'number' ? error.code : 1;
          reject(e);
          return;
        }
        resolve({ stdout: stdout || '', stderr: stderr || '', exitCode: error ? 1 : 0 });
      }
    );
  });
}

/** True only when the path is inside a git work tree. Never throws. */
async function isGitRepo(root) {
  try {
    const { stdout } = await git(root, ['rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Parse `git status --porcelain=v1 -b` into structured state.
 * Returns { isRepo, branch, upstream, ahead, behind, staged, unstaged, untracked, clean }.
 */
async function status(root) {
  const isRepo = await isGitRepo(root);
  if (!isRepo) return { isRepo: false, reason: 'not a git repository' };

  const { stdout } = await git(root, ['status', '--porcelain=v1', '-b']);
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  const result = { isRepo: true, branch: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], clean: false };

  for (const line of lines) {
    if (line.startsWith('##')) {
      const header = line.slice(2).trim();
      const [branchPart, ...rest] = header.split(/\s+\[/);
      const [branch, upstreamPart] = branchPart.split('...');
      result.branch = branch || null;
      result.upstream = upstreamPart || null;
      const info = rest.join(' ');
      const ahead = info.match(/ahead (\d+)/);
      const behind = info.match(/behind (\d+)/);
      result.ahead = ahead ? Number(ahead[1]) : 0;
      result.behind = behind ? Number(behind[1]) : 0;
      continue;
    }
    const x = line[0]; // staged status
    const y = line[1]; // unstaged status
    const filePath = line.slice(3);
    if (x === '?' && y === '?') {
      result.untracked.push(filePath);
      continue;
    }
    if (x !== ' ' && x !== '?') result.staged.push({ code: x, path: filePath });
    if (y !== ' ' && y !== '?') result.unstaged.push({ code: y, path: filePath });
  }
  result.clean = result.staged.length === 0 && result.unstaged.length === 0 && result.untracked.length === 0;
  return result;
}

/** Unified diff text for unstaged (default) or staged changes. */
async function diff(root, { staged = false } = {}) {
  const isRepo = await isGitRepo(root);
  if (!isRepo) return { isRepo: false, diff: null, reason: 'not a git repository' };
  const args = staged ? ['diff', '--staged'] : ['diff'];
  const { stdout } = await git(root, args);
  return { isRepo: true, staged, diff: stdout, empty: stdout.trim() === '' };
}

/** Recent commits, newest first. */
async function log(root, { limit = 20 } = {}) {
  const isRepo = await isGitRepo(root);
  if (!isRepo) return { isRepo: false, commits: null, reason: 'not a git repository' };
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const { stdout } = await git(root, ['log', `--max-count=${n}`, '--pretty=format:%H%x09%an%x09%aI%x09%s']);
  const commits = stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => {
      const [hash, author, date, ...subject] = line.split('\t');
      return { hash: (hash || '').slice(0, 12), fullHash: hash, author, date, subject: subject.join('\t') };
    });
  return { isRepo: true, commits };
}

/**
 * Change summary used by reports: what changed relative to HEAD, grouped.
 */
async function changeSummary(root) {
  const st = await status(root);
  if (!st.isRepo) return st;
  const changedFiles = [
    ...st.staged.map((s) => s.path),
    ...st.unstaged.map((s) => s.path),
    ...st.untracked,
  ];
  return {
    isRepo: true,
    branch: st.branch,
    totalChanges: changedFiles.length,
    stagedCount: st.staged.length,
    unstagedCount: st.unstaged.length,
    untrackedCount: st.untracked.length,
    changedFiles: Array.from(new Set(changedFiles)).slice(0, 100),
  };
}

module.exports = { isGitRepo, status, diff, log, changeSummary };
