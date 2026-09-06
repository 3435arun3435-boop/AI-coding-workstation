'use strict';
// Phase 2 — Project Intelligence: project scanning, framework/entrypoint/test
// detection, caching, relevance scoring, context building, and the new tools.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { analyzeProject, invalidateProjectCache, findRelevantFiles, buildContext, isTestFile } = require('../src/project-intel');
const { executeTool, TOOL_NAMES } = require('../src/agent-tools');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeNodeProject() {
  const root = tmpDir('intel-node-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'sample-api',
    version: '1.0.0',
    scripts: { start: 'node server.js', test: 'node --test test/' },
    dependencies: { express: '^4.19.0' },
    devDependencies: { jest: '^29.0.0' },
  }, null, 2));
  fs.writeFileSync(path.join(root, 'server.js'), 'const express = require("express");\nconst app = express();\napp.get("/health", (req, res) => res.json({ ok: true }));\napp.listen(3000);\n');
  fs.writeFileSync(path.join(root, 'src', 'router.js'), 'function healthRouter() { return "router"; }\nmodule.exports = { healthRouter };\n');
  fs.writeFileSync(path.join(root, 'test', 'router.test.js'), 'const test = require("node:test");\ntest("router", () => {});\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  return root;
}

function makePythonProject() {
  const root = tmpDir('intel-py-');
  fs.writeFileSync(path.join(root, 'requirements.txt'), 'fastapi==0.110.0\nuvicorn==0.29.0\n');
  fs.writeFileSync(path.join(root, 'main.py'), 'from fastapi import FastAPI\napp = FastAPI()\n');
  fs.writeFileSync(path.join(root, 'test_main.py'), 'def test_app():\n    assert True\n');
  return root;
}

// ---------------------------------------------------------------------------
test('analyzes a Node.js project: type, framework, package manager, entry points, tests', () => {
  const root = makeNodeProject();
  invalidateProjectCache(root);
  const map = analyzeProject(root);
  assert.equal(map.projectType, 'Node.js server');
  assert.equal(map.primaryLanguage, 'JavaScript');
  assert.ok(map.frameworks.includes('Express'));
  assert.equal(map.packageManager, 'npm');
  assert.ok(map.entrypoints.includes('server.js'));
  assert.ok(map.entrypoints.includes('src/index.js') === false, 'only entry points that actually exist are listed');
  assert.ok(map.testFiles.some((f) => f.includes('router.test.js')));
  assert.deepEqual(map.testDirectories, ['test']);
  assert.ok(map.scripts.includes('start'));
  assert.ok(map.scripts.includes('test'));
  assert.ok(map.commands.test.includes('npm test'));
  assert.ok(map.commands.run.includes('npm run start'));
  assert.equal(map.isGitRepo, false);
  assert.ok(!('undefined' in map), 'no undefined keys leak into the map');
});

test('analyzes a Python project: FastAPI detection and pytest commands', () => {
  const root = makePythonProject();
  invalidateProjectCache(root);
  const map = analyzeProject(root);
  assert.equal(map.projectType, 'Python web app');
  assert.ok(map.frameworks.includes('FastAPI'));
  assert.ok(map.testFramework === 'pytest');
  assert.ok(map.commands.test.some((c) => c.includes('pytest')));
  assert.ok(map.testFiles.some((f) => f === 'test_main.py'));
});

test('analysis is cached and can be refreshed explicitly', () => {
  const root = makeNodeProject();
  invalidateProjectCache(root);
  const first = analyzeProject(root);
  assert.equal(first.cached, false);
  const second = analyzeProject(root);
  assert.equal(second.cached, true, 'second call within TTL should hit the cache');
  const refreshed = analyzeProject(root, { refresh: true });
  assert.equal(refreshed.cached, false);
});

test('cache is invalidated when the project top level changes', async () => {
  const root = makeNodeProject();
  invalidateProjectCache(root);
  analyzeProject(root);
  // Wait a tick so the mtime signature changes, then modify the project.
  await new Promise((r) => setTimeout(r, 1100));
  fs.writeFileSync(path.join(root, 'new-file.js'), 'x');
  const map = analyzeProject(root);
  assert.equal(map.cached, false, 'changed signature must force a rescan');
  assert.ok(map.files.includes('new-file.js'));
});

test('never fabricates: a project with no package.json reports no npm frameworks', () => {
  const root = tmpDir('intel-empty-');
  invalidateProjectCache(root);
  const map = analyzeProject(root);
  assert.deepEqual(map.frameworks, []);
  assert.equal(map.packageManager, null);
  assert.deepEqual(map.entrypoints, []);
  assert.equal(map.projectType, 'Unknown');
});

test('isTestFile recognizes common conventions', () => {
  assert.ok(isTestFile('test/router.test.js'));
  assert.ok(isTestFile('src/__tests__/a.js'));
  assert.ok(isTestFile('tests/test_main.py'));
  assert.ok(isTestFile('utils_test.go'));
  assert.ok(!isTestFile('src/router.js'));
});

// ---------------------------------------------------------------------------
test('findRelevantFiles ranks files mentioning task keywords', () => {
  const root = makeNodeProject();
  invalidateProjectCache(root);
  const matches = findRelevantFiles(root, 'fix the health endpoint in the express router', { limit: 5 });
  assert.ok(matches.length > 0);
  const paths = matches.map((m) => m.path);
  assert.ok(paths.includes(path.join('src', 'router.js')), 'router.js should rank for a router task');
  assert.ok(paths.includes('server.js'));
});

test('findRelevantFiles returns nothing for a completely unrelated task (no forced matches)', () => {
  const root = makeNodeProject();
  invalidateProjectCache(root);
  const matches = findRelevantFiles(root, 'quantum teleportation protocol calibration');
  assert.deepEqual(matches, []);
});

test('buildContext includes map summary and bounded relevant file contents', () => {
  const root = makeNodeProject();
  invalidateProjectCache(root);
  const ctx = buildContext(root, 'the /health endpoint in router.js is broken');
  assert.equal(ctx.mapSummary.projectType, 'Node.js server');
  assert.ok(ctx.files.length > 0);
  for (const f of ctx.files) {
    assert.ok(typeof f.content === 'string' && f.content.length > 0);
    assert.ok(f.bytes <= 16 * 1024);
  }
  assert.ok(ctx.budgetBytesUsed > 0 && ctx.budgetBytesUsed <= 64 * 1024);
});

// ---------------------------------------------------------------------------
test('new project-intelligence tools are registered and executable', async () => {
  assert.ok(TOOL_NAMES.includes('get_project_map'));
  assert.ok(TOOL_NAMES.includes('find_relevant_files'));
  assert.ok(TOOL_NAMES.includes('get_project_context'));

  const root = makeNodeProject();
  invalidateProjectCache(root);
  const mapResult = await executeTool('get_project_map', '{}', { projectRoot: root });
  assert.equal(mapResult.ok, true);
  assert.equal(mapResult.result.projectType, 'Node.js server');
  assert.ok(!('files' in mapResult.result), 'tool result is a compact summary, not the full file list');

  const findResult = await executeTool('find_relevant_files', { task: 'express router health' }, { projectRoot: root });
  assert.equal(findResult.ok, true);
  assert.ok(findResult.result.matches.length > 0);

  const ctxResult = await executeTool('get_project_context', { task: 'express router health' }, { projectRoot: root });
  assert.equal(ctxResult.ok, true);
  assert.ok(ctxResult.result.files.length > 0);

  const bad = await executeTool('find_relevant_files', '{}', { projectRoot: root });
  assert.equal(bad.ok, false);
});
