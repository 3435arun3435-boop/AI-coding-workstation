'use strict';
/**
 * sandbox.js — optional Docker/sandbox execution adapter.
 *
 * Honest capability detection: when Docker is not installed or not running,
 * everything reports UNAVAILABLE — the system never pretends sandboxing
 * exists. When available, commands can optionally be executed inside a
 * container with the project mounted read-write at /workspace.
 */

const { execFile } = require('child_process');
const { sanitizedEnv } = require('./exec-env');

const DETECT_TIMEOUT_MS = 5_000;
const EXEC_TIMEOUT_MS = 120_000;

let cached = undefined; // undefined = not probed yet

/** Detect Docker availability. Never throws; caches the probe result. */
function detectSandbox(force = false) {
  return new Promise((resolve) => {
    if (cached !== undefined && !force) return resolve(cached);
    execFile('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: DETECT_TIMEOUT_MS, env: sanitizedEnv() }, (error, stdout) => {
      cached = error
        ? { available: false, detail: 'Docker is not installed or the daemon is not running. Optional sandboxed execution is UNAVAILABLE.' }
        : { available: true, detail: `Docker ${stdout.trim()} detected; sandboxed execution AVAILABLE (project mounts at /workspace).` };
      resolve(cached);
    });
  });
}

/**
 * Run a shell command inside a sandboxed container. Returns a structured
 * result; when Docker is unavailable, returns ok:false with the honest
 * reason — the caller decides whether to fall back to normal (risk-gated)
 * execution.
 */
async function runInSandbox(projectRoot, command, { image = 'node:22-bookworm-slim', timeoutMs = EXEC_TIMEOUT_MS } = {}) {
  const status = await detectSandbox();
  if (!status.available) {
    return { ok: false, sandboxed: false, error: status.detail };
  }
  const start = Date.now();
  return await new Promise((resolve) => {
    execFile(
      'docker',
      ['run', '--rm', '-v', `${projectRoot}:/workspace`, '-w', '/workspace', image, '/bin/sh', '-c', command],
      { timeout: Math.min(Number(timeoutMs) || EXEC_TIMEOUT_MS, EXEC_TIMEOUT_MS), maxBuffer: 8 * 1024 * 1024, env: sanitizedEnv() },
      (error, stdout, stderr) => {
        resolve({
          ok: !error || (typeof error.code === 'number' && error.code !== 0 ? true : false),
          sandboxed: true,
          image,
          exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          timedOut: !!(error && error.killed),
          stdout: stdout || '',
          stderr: stderr || '',
          durationMs: Date.now() - start,
        });
      }
    );
  });
}

module.exports = { detectSandbox, runInSandbox };
