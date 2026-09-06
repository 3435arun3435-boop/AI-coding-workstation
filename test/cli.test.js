'use strict';
// Phase 11 — CLI end-to-end: `node cli.js run` against a scripted mock
// provider, through the real config/approval stores, plus doctor/modes smoke
// checks. The CLI and server share every service; this proves the shared
// engine works from a cold CLI process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('cli run completes a task via a configured mock provider', async () => {
  const dataDir = tmpDir('cli-e2e-data-');
  const projectRoot = tmpDir('cli-e2e-proj-');
  fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'hello\n');

  // Scripted OpenAI-compatible provider.
  const provider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'CLI run works.' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise((r) => provider.listen(0, r));

  // Configure the provider in the CLI's data dir using the SAME ConfigStore.
  const { ConfigStore } = require('../src/config');
  const config = new ConfigStore(dataDir);
  config.upsertProvider({ id: 'mock-1', name: 'Mock', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${provider.address().port}`, model: 'mock-model', apiKey: 'k', enabled: true, priority: 1 });

  const result = await new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'run', 'explain the project', '--project', projectRoot, '--mode', 'ask'], {
      env: { ...process.env, AGENT_DATA_DIR: dataDir },
      timeout: 30000,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });

  provider.close();
  assert.match(result.stdout, /Mode: Ask/, 'mode banner is printed');
  assert.match(result.stdout, /Status: completed/);
  assert.match(result.stdout, /CLI run works\./);
  assert.ok(!result.error, `no failure: ${result.stderr}`);
  assert.equal(result.error, null);

  // The task was recorded in the shared TaskStore.
  const { TaskStore } = require('../src/tasks');
  const tasks = new TaskStore(dataDir);
  const record = tasks.list(1)[0];
  assert.equal(record.mode, 'ask');
  assert.equal(record.status, 'completed');
  assert.equal(record.provider, 'mock-1', 'provider used is recorded');
});

test('cli doctor/modes/tools run cleanly without a project', async () => {
  const dataDir = tmpDir('cli-doctor-data-');
  for (const args of [['doctor'], ['modes'], ['tools']]) {
    const result = await new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { env: { ...process.env, AGENT_DATA_DIR: dataDir }, timeout: 30000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
    assert.ok(!result.error, `${args[0]} failed: ${result.stderr}`);
    assert.ok(result.stdout.length > 10, `${args[0]} prints output`);
  }
});
