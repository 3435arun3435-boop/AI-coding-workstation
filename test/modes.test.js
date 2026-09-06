'use strict';
// Phase 3 — Agent Modes: mode resolution, tool-surface constraining (declared
// to the model AND enforced at execution), and read-only guarantees.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MODES, MODE_KEYS, resolveAutoMode, resolveMode, getMode, ALL_TOOLS } = require('../src/modes');
const { runAgentTask } = require('../src/agent-loop');
const { ProviderRouter } = require('../src/providers');
const { toolSchemasFor, TOOL_NAMES } = require('../src/agent-tools');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mockRouter() {
  return new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);
}

// ---------------------------------------------------------------------------
test('every mode restricts the tool surface below the full registry', () => {
  for (const key of MODE_KEYS) {
    const mode = MODES[key];
    assert.ok(mode.allowedTools.length > 0, `${key} declares tools`);
    for (const t of mode.allowedTools) {
      // git_* / run_tests land in Phases 5-6; the agent loop filters the
      // declared set down to registered tools, so forward references are safe.
      assert.ok(
        TOOL_NAMES.includes(t) || /^(git_|run_tests)/.test(t),
        `${key} tool ${t} must be registered (or a registered-later Phase 5/6 tool)`
      );
    }
  }
  // Read-only modes must not include mutating/execution tools.
  for (const key of ['ask', 'review']) {
    for (const t of MODES[key].allowedTools) {
      assert.ok(!['write_file', 'edit_file', 'run_command', 'git_commit'].includes(t), `${key} must be read-only (found ${t})`);
    }
    assert.equal(MODES[key].readOnly, true);
  }
  // Test mode may run commands/tests but never edit files.
  for (const t of MODES.test.allowedTools) {
    assert.ok(!['write_file', 'edit_file'].includes(t), 'test mode cannot edit files');
  }
});

test('toolSchemasFor() returns exactly the requested subset', () => {
  const schemas = toolSchemasFor(['read_file', 'list_files']);
  assert.deepEqual(
    schemas.map((s) => s.function.name).sort(),
    ['list_files', 'read_file']
  );
});

test('resolveAutoMode maps task text to sensible modes', () => {
  assert.equal(resolveAutoMode('fix the failing test'), 'debug');
  assert.equal(resolveAutoMode('debug the login crash'), 'debug');
  assert.equal(resolveAutoMode('run the test suite'), 'test');
  assert.equal(resolveAutoMode('review my changes for security issues'), 'review');
  assert.equal(resolveAutoMode('explain how the config module works'), 'ask');
  assert.equal(resolveMode('plan', ''), 'plan');
  assert.equal(resolveAutoMode('add a delete button to the settings page'), 'code');
});

test('resolveMode falls back safely on unknown modes and honors auto', () => {
  assert.equal(resolveMode('ask', ''), 'ask');
  assert.equal(resolveMode('auto', 'fix the bug'), 'debug');
  assert.equal(resolveMode('nonsense-mode', 'anything'), 'autonomous', 'unknown falls back to autonomous (pre-modes behavior)');
  assert.equal(resolveMode(undefined, 'anything'), 'autonomous');
});

// ---------------------------------------------------------------------------
test('agent loop in ask mode: pure chat declares NO tools; inspection tasks keep read-only tools', async () => {
  const projectRoot = tmpDir('modes-ask-');

  // (a) Pure chat intent ("Analyze this project and give me a report") — the
  // output_parse_failed bug scenario: NO tool schemas may be sent at all.
  let chatTools = null;
  const router = mockRouter();
  await runAgentTask({
    task: 'Analyze this project and give me a report', projectRoot, router,
    callFn: async (_e, { tools }) => { chatTools = tools; return { choices: [{ message: { content: 'Report.' } }] }; },
    mode: 'ask',
  });
  assert.deepEqual(chatTools, [], 'chat intent must send zero tool schemas (PART A bug fix)');

  // (b) Explicit inspection targets keep read-only tools available.
  let seenTools = null;
  await runAgentTask({
    task: 'inspect package.json and explain the scripts', projectRoot, router: mockRouter(),
    callFn: async (_e, { tools }) => { seenTools = tools.map((t) => t.function.name); return { choices: [{ message: { content: 'Explained.' } }] }; },
    mode: 'ask',
  });
  assert.ok(seenTools.includes('read_file'));
  assert.ok(!seenTools.includes('write_file'), 'write_file must not be declared in ask mode');
  assert.ok(!seenTools.includes('run_command'), 'run_command must not be declared in ask mode');
});

test('agent loop in ask mode: server-side enforcement blocks a mutating call even if the model insists', async () => {
  const projectRoot = tmpDir('modes-ask-enforce-');
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);
  let turn = 0;
  const mockCall = async () => {
    turn++;
    if (turn === 1) {
      return {
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{ id: 't1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'evil.txt', content: 'nope' }) } }],
          },
        }],
      };
    }
    return { choices: [{ message: { role: 'assistant', content: 'Understood, stopping.' } }] };
  };
  const result = await runAgentTask({ task: 'write a file', projectRoot, router, callFn: mockCall, mode: 'ask' });
  assert.equal(result.status, 'completed');
  assert.ok(!fs.existsSync(path.join(projectRoot, 'evil.txt')), 'write must NOT have executed');
  assert.ok(result.toolLog.some((e) => e.name === 'write_file' && !e.ok), 'the blocked call is recorded as failed');
});

test('agent loop in code mode still has the full tool surface (default parity)', async () => {
  const projectRoot = tmpDir('modes-code-');
  let seenTools = null;
  const mockCall = async (_entry, { tools }) => {
    seenTools = tools.map((t) => t.function.name);
    return { choices: [{ message: { role: 'assistant', content: 'Done.' } }] };
  };
  const result = await runAgentTask({ task: 'implement a feature', projectRoot, router: mockRouter(), callFn: mockCall, mode: 'code' });
  assert.equal(result.status, 'completed');
  assert.ok(seenTools.includes('write_file'));
  assert.ok(seenTools.includes('run_command'));
});

test('agent loop with no mode behaves exactly as before (back-compat: autonomous)', async () => {
  const projectRoot = tmpDir('modes-default-');
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);
  let turn = 0;
  const mockCall = async () => {
    turn++;
    if (turn === 1) {
      return {
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{ id: 't1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'out.txt', content: 'done' }) } }],
          },
        }],
      };
    }
    return { choices: [{ message: { role: 'assistant', content: 'All done.' } }] };
  };
  const result = await runAgentTask({ task: 'write a file', projectRoot, router, callFn: mockCall });
  assert.equal(result.status, 'completed');
  assert.equal(result.mode, 'autonomous');
  assert.ok(fs.existsSync(path.join(projectRoot, 'out.txt')));
});

test('mode instructions are appended to the system prompt', async () => {
  const projectRoot = tmpDir('modes-prompt-');
  let seenSystem = null;
  const mockCall = async (_entry, { messages }) => {
    seenSystem = messages.find((m) => m.role === 'system');
    return { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
  };
  await runAgentTask({ task: 'explain the project', projectRoot, router: mockRouter(), callFn: mockCall, mode: 'ask' });
  assert.match(seenSystem.content, /MODE: Ask/);
  assert.match(seenSystem.content, /must NOT modify any files/);
});

test('activity events carry the mode so the UI can display real state', async () => {
  const projectRoot = tmpDir('modes-activity-');
  const events = [];
  await runAgentTask({
    task: 'explain the project',
    projectRoot,
    router: mockRouter(),
    callFn: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    mode: 'ask',
    onActivity: (e) => events.push(e),
  });
  assert.ok(events.some((e) => /Mode: Ask/.test(e.message)));
});
