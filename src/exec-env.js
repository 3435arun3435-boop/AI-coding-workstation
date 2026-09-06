'use strict';
/**
 * exec-env.js
 *
 * Child-process environment sanitization. When this app's own test suite
 * runs under `node --test`, the runner sets NODE_TEST_CONTEXT in our
 * process — any nested `node --test` we spawn would then attach to the
 * ancestor runner and its output would never reach our stdout. Strip
 * node:test's coordination variables so spawned commands behave as if run
 * from a normal shell.
 */

const NESTED_TEST_ENV_VARS = ['NODE_TEST_CONTEXT', 'NODE_TEST_RUNNER'];

function sanitizedEnv(extra) {
  const env = { ...process.env };
  for (const key of NESTED_TEST_ENV_VARS) delete env[key];
  return extra ? { ...env, ...extra } : env;
}

module.exports = { sanitizedEnv, NESTED_TEST_ENV_VARS };
