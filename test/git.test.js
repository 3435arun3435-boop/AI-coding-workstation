'use strict';
// Phase 6 — Git Intelligence: real temp-repo checks for status/diff/log,
// repo detection, tool registration, and the approval path for commits.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const git = require('../src/git');
const { executeTool } = require('../src/agent-tools');
const { classifyCommandRisk } = require('../src/risk');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeGitProject() {
  const root = tmpDir('git-proj-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), '# Sample\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'initial commit'], { cwd: root });
  return root;
}

// ---------------------------------------------------------------------------
test('isGitRepo detects repositories and non-repositories', async () => {
  const repo = makeGitProject();
  const plain = tmpDir('git-plain-');
  assert.equal(await git.isGitRepo(repo), true);
  assert.equal(await git.isGitRepo(plain), false);
});

test('status reports branch, clean state, then staged/unstaged/untracked changes', async () => {
  const root = makeGitProject();
  const clean = await git.status(root);
  assert.equal(clean.isRepo, true);
  assert.ok(clean.branch && clean.branch.length > 0);
  assert.equal(clean.clean, true);

  fs.writeFileSync(path.join(root, 'README.md'), '# Sample\n\nchanged\n');
  fs.writeFileSync(path.join(root, 'staged.txt'), 'to be staged\n');
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'new\n');
  execFileSync('git', ['add', 'staged.txt'], { cwd: root });

  const dirty = await git.status(root);
  assert.equal(dirty.clean, false);
  assert.ok(dirty.staged.some((s) => s.path === 'staged.txt'));
  assert.ok(dirty.unstaged.some((s) => s.path === 'README.md'));
  assert.deepEqual(dirty.untracked, ['untracked.txt']);
});

test('diff returns unified diff text for unstaged and staged changes', async () => {
  const root = makeGitProject();
  fs.writeFileSync(path.join(root, 'README.md'), '# Sample\n\nmodified\n');
  const unstaged = await git.diff(root);
  assert.equal(unstaged.isRepo, true);
  assert.match(unstaged.diff, /diff --git a\/README\.md/);
  assert.match(unstaged.diff, /\+modified/);

  execFileSync('git', ['add', '.'], { cwd: root });
  const unstagedAfter = await git.diff(root);
  assert.equal(unstagedAfter.empty, true);
  const staged = await git.diff(root, { staged: true });
  assert.match(staged.diff, /\+modified/);
});

test('log returns recent commits newest first with author and subject', async () => {
  const root = makeGitProject();
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'second commit'], { cwd: root });
  const result = await git.log(root, { limit: 5 });
  assert.equal(result.isRepo, true);
  assert.ok(result.commits.length >= 2);
  assert.equal(result.commits[0].subject, 'second commit');
  assert.equal(result.commits[1].subject, 'initial commit');
  assert.equal(result.commits[0].author, 'Test User');
});

test('changeSummary groups changes and lists changed files', async () => {
  const root = makeGitProject();
  fs.writeFileSync(path.join(root, 'a.js'), 'x');
  const summary = await git.changeSummary(root);
  assert.equal(summary.isRepo, true);
  assert.equal(summary.totalChanges, 1);
  assert.deepEqual(summary.changedFiles, ['a.js']);
});

test('non-repo paths report honestly instead of throwing', async () => {
  const plain = tmpDir('git-plain-');
  const st = await git.status(plain);
  assert.equal(st.isRepo, false);
  const lg = await git.log(plain);
  assert.equal(lg.isRepo, false);
  const df = await git.diff(plain);
  assert.equal(df.isRepo, false);
});

// ---------------------------------------------------------------------------
test('git tools are registered and return structured results', async () => {
  const root = makeGitProject();
  const st = await executeTool('git_status', '{}', { projectRoot: root });
  assert.equal(st.ok, true);
  assert.equal(st.result.isRepo, true);

  fs.writeFileSync(path.join(root, 'README.md'), '# Sample\n\nchanged\n');
  const df = await executeTool('git_diff', '{}', { projectRoot: root });
  assert.equal(df.ok, true);
  assert.match(df.result.diff, /README\.md/);

  const lg = await executeTool('git_log', '{}', { projectRoot: root });
  assert.equal(lg.ok, true);
  assert.ok(lg.result.commits.length >= 1);

  const plain = tmpDir('git-plain-');
  const stPlain = await executeTool('git_status', '{}', { projectRoot: plain });
  assert.equal(stPlain.ok, true);
  assert.equal(stPlain.result.isRepo, false);
});

test('git_commit tool NEVER executes directly — it must go through approvals', async () => {
  const root = makeGitProject();
  const result = await executeTool('git_commit', { message: 'should not happen' }, { projectRoot: root });
  assert.equal(result.ok, false);
  assert.match(result.message || result.error, /approval/);
  // And nothing was committed:
  const lg = await git.log(root);
  assert.equal(lg.commits.length, 1, 'repo still has only the initial commit');
});

test('agent loop in code mode proposes a git commit and applies it on approval', async () => {
  const root = makeGitProject();
  const { runAgentTask } = require('../src/agent-loop');
  const { ProviderRouter } = require('../src/providers');
  const { ApprovalStore } = require('../src/approvals');
  const approvals = new ApprovalStore(tmpDir('git-commit-store-'));
  const router = new ProviderRouter([{ id: 'mock', enabled: true, priority: 1 }]);

  let turn = 0;
  const mockCall = async () => {
    turn++;
    if (turn === 1) {
      fs.writeFileSync(path.join(root, 'feature.txt'), 'new feature\n');
      return {
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{ id: 't1', function: { name: 'git_commit', arguments: JSON.stringify({ message: 'add feature', files: ['feature.txt'] }) } }],
          },
        }],
      };
    }
    return { choices: [{ message: { role: 'assistant', content: 'Commit proposed and approved.' } }] };
  };

  const runPromise = runAgentTask({
    task: 'commit the feature', projectRoot: root, router, callFn: mockCall,
    safetyMode: 'autonomous', approvals, approvals2: undefined, mode: 'code',
  });
  await new Promise((r) => setTimeout(r, 40));
  const pending = approvals.list({ status: 'pending' });
  assert.equal(pending.length, 1, 'commit must be held as a pending proposal');
  assert.equal(pending[0].type, 'command');
  await approvals.decide(pending[0].id, 'approved');
  await runPromise;

  const lg = await git.log(root);
  assert.equal(lg.commits[0].subject, 'add feature', 'approved commit was executed');
});

test('destructive git commands classify as CRITICAL (never silently runnable)', () => {
  for (const cmd of ['git reset --hard', 'git clean -fd', 'git push --force origin main', 'git checkout -- .']) {
    assert.equal(classifyCommandRisk(cmd).level, 'critical', cmd);
  }
});
