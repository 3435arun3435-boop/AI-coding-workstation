'use strict';
/**
 * agent-tools.js
 *
 * THE SINGLE SOURCE OF TRUTH for tools.
 *
 * Every tool is defined ONCE, here, as an entry in TOOL_DEFS. Each entry
 * carries both its provider-facing JSON schema (what gets sent to the LLM)
 * and its executor function (what actually runs). Nothing else in the
 * codebase is allowed to invent a tool name — agent-loop.js and providers.js
 * only ever see tools that come from this file, so "declared tools" and
 * "executable tools" can never drift apart.
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { resolveInProject, PathSecurityError } = require('./security');
const { sanitizedEnv } = require('./exec-env');
const { analyzeProject, findRelevantFiles, buildContext } = require('./project-intel');
const { runTests, detectTests } = require('./test-intel');
const git = require('./git');

const MAX_READ_BYTES = 512 * 1024; // 512KB safety cap per file read
const MAX_COMMAND_MS = 30_000;

// Terminal output limit (Settings Center → Terminal): applied when ctx carries it.
function truncateOutput(text, ctx) {
  const limit = ctx && Number(ctx.terminalOutputLimit);
  const s = String(text || '');
  if (!limit || s.length <= limit) return s;
  return s.slice(0, limit) + `\n… [truncated ${s.length - limit} chars (Settings → Terminal → output limit)]`;
}

/**
 * Each tool: { name, description, parameters (JSON schema), execute(args, ctx) }
 * ctx = { projectRoot }
 */
const TOOL_DEFS = [
  {
    name: 'list_files',
    description: 'List files and directories under a path within the project (relative path, default project root).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within the project. Defaults to "."' },
      },
    },
    async execute(args, ctx) {
      const rel = args && typeof args.path === 'string' ? args.path : '.';
      const abs = resolveInProject(ctx.projectRoot, rel);
      const stat = fs.statSync(abs);
      if (!stat.isDirectory()) {
        return { error: `Not a directory: ${rel}` };
      }
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
        .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
      return { path: rel, entries };
    },
  },

  {
    name: 'read_file',
    description: 'Read the text contents of a file within the project.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file' },
      },
      required: ['path'],
    },
    async execute(args, ctx) {
      if (!args || typeof args.path !== 'string') {
        return { error: 'Missing required argument: path' };
      }
      const abs = resolveInProject(ctx.projectRoot, args.path);
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) return { error: `Path is a directory: ${args.path}` };
      if (stat.size > MAX_READ_BYTES) {
        return { error: `File too large to read (${stat.size} bytes, limit ${MAX_READ_BYTES})` };
      }
      const content = fs.readFileSync(abs, 'utf8');
      return { path: args.path, content };
    },
  },

  {
    name: 'write_file',
    description: 'Create or overwrite a file within the project with given content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
    async execute(args, ctx) {
      if (!args || typeof args.path !== 'string' || typeof args.content !== 'string') {
        return { error: 'Missing required arguments: path, content' };
      }
      const abs = resolveInProject(ctx.projectRoot, args.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, args.content, 'utf8');
      return { path: args.path, bytesWritten: Buffer.byteLength(args.content, 'utf8') };
    },
  },

  {
    name: 'edit_file',
    description: 'Replace an exact substring in a file with new text. oldText must match exactly once.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
      },
      required: ['path', 'oldText', 'newText'],
    },
    async execute(args, ctx) {
      if (!args || typeof args.path !== 'string' || typeof args.oldText !== 'string' || typeof args.newText !== 'string') {
        return { error: 'Missing required arguments: path, oldText, newText' };
      }
      const abs = resolveInProject(ctx.projectRoot, args.path);
      const content = fs.readFileSync(abs, 'utf8');
      const occurrences = content.split(args.oldText).length - 1;
      if (occurrences === 0) return { error: 'oldText not found in file' };
      if (occurrences > 1) return { error: `oldText is not unique (${occurrences} matches); include more context` };
      const updated = content.replace(args.oldText, args.newText);
      fs.writeFileSync(abs, updated, 'utf8');
      return { path: args.path, replaced: true };
    },
  },

  {
    name: 'search_project',
    description: 'Search project files for a plain-text substring. Returns matching file paths and line numbers.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string', description: 'Subdirectory to limit search to (optional)' },
      },
      required: ['query'],
    },
    async execute(args, ctx) {
      if (!args || typeof args.query !== 'string' || args.query.length === 0) {
        return { error: 'Missing required argument: query' };
      }
      const startRel = typeof args.path === 'string' ? args.path : '.';
      const startAbs = resolveInProject(ctx.projectRoot, startRel);
      const results = [];
      const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.agent']);
      const MAX_RESULTS = 200;

      function walk(dir) {
        if (results.length >= MAX_RESULTS) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (results.length >= MAX_RESULTS) return;
          if (SKIP_DIRS.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            let text;
            try {
              text = fs.readFileSync(full, 'utf8');
            } catch {
              continue; // binary or unreadable, skip
            }
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(args.query)) {
                results.push({
                  file: path.relative(ctx.projectRoot, full),
                  line: i + 1,
                  text: lines[i].trim().slice(0, 200),
                });
                if (results.length >= MAX_RESULTS) break;
              }
            }
          }
        }
      }
      walk(startAbs);
      return { query: args.query, matches: results, truncated: results.length >= MAX_RESULTS };
    },
  },

  {
    name: 'run_command',
    description: 'Run a shell command inside the project directory. Use for tests, builds, and starting the app.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run, e.g. "npm test"' },
        timeoutMs: { type: 'number', description: 'Optional timeout in ms (default 30000, max 120000)' },
      },
      required: ['command'],
    },
    async execute(args, ctx) {
      if (!args || typeof args.command !== 'string' || args.command.trim() === '') {
        return { error: 'Missing required argument: command' };
      }
      const ctxTimeout = ctx && Number(ctx.terminalTimeoutMs);
      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || ctxTimeout || MAX_COMMAND_MS, 1000), 120_000);
      const start = Date.now();
      return await new Promise((resolve) => {
        execFile(
          process.platform === 'win32' ? 'cmd' : '/bin/sh',
          process.platform === 'win32' ? ['/c', args.command] : ['-c', args.command],
          { cwd: ctx.projectRoot, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024, env: sanitizedEnv() },
          (error, stdout, stderr) => {
            const duration = Date.now() - start;
            if (error && error.killed) {
              resolve({ command: args.command, timedOut: true, durationMs: duration, stdout, stderr });
              return;
            }
            resolve({
              command: args.command,
              exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
              stdout: truncateOutput(stdout, ctx),
              stderr: truncateOutput(stderr, ctx),
              durationMs: duration,
            });
          }
        );
      });
    },
  },

  {
    name: 'get_project_map',
    description: 'Analyze the project and return its structure map: languages, frameworks, package manager, entry points, tests, config files, and suggested run/test commands. Cached; pass refresh:true to rescan.',
    parameters: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Rescan even if a cached analysis exists' },
      },
    },
    async execute(args, ctx) {
      const map = analyzeProject(ctx.projectRoot, { refresh: !!(args && args.refresh) });
      // Keep the tool result compact: the full file list is available via find_relevant_files.
      const { files, directories, ...summary } = map;
      return summary;
    },
  },

  {
    name: 'find_relevant_files',
    description: 'Given a task description, find the project files most relevant to it (scored by path/content keyword overlap). Returns ranked paths with reasons.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task or question to find relevant files for' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['task'],
    },
    async execute(args, ctx) {
      if (!args || typeof args.task !== 'string' || args.task.length === 0) {
        return { error: 'Missing required argument: task' };
      }
      const matches = findRelevantFiles(ctx.projectRoot, args.task, { limit: Number(args.limit) || 10 });
      return { task: args.task, matches };
    },
  },

  {
    name: 'get_project_context',
    description: 'Build a focused context bundle for a task: a project summary plus the contents of the most relevant files (size-bounded). Cheaper than reading many files one by one.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task to build context for' },
      },
      required: ['task'],
    },
    async execute(args, ctx) {
      if (!args || typeof args.task !== 'string' || args.task.length === 0) {
        return { error: 'Missing required argument: task' };
      }
      return buildContext(ctx.projectRoot, args.task);
    },
  },

  {
    name: 'run_tests',
    description: "Run the project's tests (auto-detected command) or a single test file via `path`. Returns structured results: pass/fail/skipped counts, failing test names with error messages. Prefer this over run_command for testing.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional relative path of a test file to run just that file' },
      },
    },
    async execute(args, ctx) {
      const target = args && typeof args.path === 'string' ? args.path : undefined;
      if (target) {
        // Sandbox the target path like every other fs touch — a
        // PathSecurityError propagates so executeTool reports security_violation.
        require('./security').resolveInProject(ctx.projectRoot, target);
      }
      const result = await runTests(ctx.projectRoot, { target });
      if (result.error) return { error: result.message || result.error };
      // Test FAILURES are a normal structured outcome (the model must analyze
      // them), not a tool error — return them as data.
      return result;
    },
  },

  {
    name: 'detect_tests',
    description: 'Detect the project testing setup: framework, test files, test directories, and the commands used to run tests.',
    parameters: { type: 'object', properties: {} },
    async execute(args, ctx) {
      return detectTests(ctx.projectRoot);
    },
  },

  {
    name: 'git_status',
    description: 'Show the git status of the project: current branch, staged files, unstaged changes, untracked files.',
    parameters: { type: 'object', properties: {} },
    async execute(args, ctx) {
      return git.status(ctx.projectRoot);
    },
  },

  {
    name: 'git_diff',
    description: 'Show the unified diff of unstaged changes (or staged with staged:true) in the project.',
    parameters: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Show staged (cached) changes instead of unstaged' },
      },
    },
    async execute(args, ctx) {
      const result = await git.diff(ctx.projectRoot, { staged: !!(args && args.staged) });
      if (!result.isRepo) return { error: result.reason };
      return result;
    },
  },

  {
    name: 'git_log',
    description: 'Show recent commit history (hash, author, date, subject), newest first.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max commits (default 20, max 100)' },
      },
    },
    async execute(args, ctx) {
      const result = await git.log(ctx.projectRoot, { limit: args && args.limit });
      if (!result.isRepo) return { error: result.reason };
      return result;
    },
  },

  {
    name: 'git_commit',
    description: 'Propose a git commit. Creates a commit PROPOSAL that requires explicit user approval — it is never executed automatically. Provide a clear conventional message.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message' },
        files: { type: 'array', items: { type: 'string' }, description: 'Relative file paths to stage; omit to commit already-staged changes' },
      },
      required: ['message'],
    },
    async execute(args, ctx) {
      // In the normal flow the safety gate turns this call into a proposal and
      // the user's approval executes it as a command. If execution ever lands
      // here directly (e.g. missing approval system), refuse — commits are
      // never silent.
      return { error: 'git_commit must go through the approval system: no approval store is available in this context.' };
    },
  },
];

// Derived, authoritative views. Everything else in the app must use these.
// Browser tools are registered ONLY when the Playwright package actually
// resolves, so the declared tool surface can never include phantom browser
// capability ("Experimental/Unavailable" is represented by absence + the
// /api/browser/status report, never by tools that would fake results).

const BROWSER_TOOLS = [];

try {
  const { manager: browserManager, loadPlaywright } = require('./browser');
  if (loadPlaywright()) {
    const wrap = (fn) => async (args, ctx) => {
      try {
        return await fn(args, ctx);
      } catch (e) {
        return { error: e && e.message ? e.message : String(e), code: e && e.code };
      }
    };
    BROWSER_TOOLS.push(
      {
        name: 'browser_navigate',
        description: 'Open a URL in the headless browser (Playwright). Returns title, URL, and captured console/page/network errors.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Absolute http(s) URL to open' },
            timeoutMs: { type: 'number' },
          },
          required: ['url'],
        },
        async execute(args) {
          if (!args || typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url)) {
            return { error: 'A valid absolute http(s) URL is required' };
          }
          return wrap((a) => browserManager.navigate(a.url, { timeoutMs: a.timeoutMs }))(args);
        },
      },
      {
        name: 'browser_click',
        description: 'Click an element in the open page by CSS selector.',
        parameters: { type: 'object', properties: { selector: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['selector'] },
        async execute(args) {
          if (!args || typeof args.selector !== 'string') return { error: 'Missing required argument: selector' };
          return wrap((a) => browserManager.click(a.selector, { timeoutMs: a.timeoutMs }))(args);
        },
      },
      {
        name: 'browser_type',
        description: 'Type text into an input element (replaces existing content) by CSS selector.',
        parameters: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector', 'text'] },
        async execute(args) {
          if (!args || typeof args.selector !== 'string' || typeof args.text !== 'string') return { error: 'Missing required arguments: selector, text' };
          return wrap((a) => browserManager.type(a.selector, a.text))(args);
        },
      },
      {
        name: 'browser_select',
        description: 'Select an option in a <select> element by value.',
        parameters: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] },
        async execute(args) {
          if (!args || typeof args.selector !== 'string' || typeof args.value !== 'string') return { error: 'Missing required arguments: selector, value' };
          return wrap((a) => browserManager.select(a.selector, a.value))(args);
        },
      },
      {
        name: 'browser_screenshot',
        description: 'Capture a PNG screenshot of the open page. With `path` (relative to project) it is saved to disk; otherwise returned as base64.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative file path inside the project' }, fullPage: { type: 'boolean' } } },
        async execute(args, ctx) {
          let targetPath;
          if (args && typeof args.path === 'string' && args.path.trim() !== '') {
            targetPath = resolveInProject(ctx.projectRoot, args.path); // sandboxed
          }
          return wrap((a) => browserManager.screenshot({ path: targetPath, fullPage: !!(a && a.fullPage) }))(args);
        },
      },
      {
        name: 'browser_content',
        description: 'Read the HTML content of the open page or of a selector within it.',
        parameters: { type: 'object', properties: { selector: { type: 'string' } } },
        async execute(args) {
          return wrap((a) => browserManager.content({ selector: a && a.selector }))(args);
        },
      },
      {
        name: 'browser_errors',
        description: 'List captured console errors, page errors, and failed network requests for the open page.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return wrap(() => browserManager.errors())({});
        },
      },
      {
        name: 'browser_close',
        description: 'Close the browser session and free its resources.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return wrap(() => browserManager.close())({});
        },
      }
    );
    TOOL_DEFS.push(...BROWSER_TOOLS);
  }
} catch {
  // Browser tool registration must never break the rest of the app.
}

const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

const PROVIDER_TOOL_SCHEMAS = TOOL_DEFS.map((t) => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
}));

/** Provider schemas for a subset of tools (agent modes constrain the surface). */
function toolSchemasFor(toolNames) {
  const set = new Set(toolNames);
  return TOOL_DEFS.filter((t) => set.has(t.name)).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

const EXECUTORS = Object.fromEntries(TOOL_DEFS.map((t) => [t.name, t.execute]));

/**
 * Execute a tool call safely. Never throws — always returns a structured
 * result so the agent loop can recover instead of crashing.
 */
async function executeTool(name, rawArgs, ctx) {
  if (!Object.prototype.hasOwnProperty.call(EXECUTORS, name)) {
    return { ok: false, error: `unknown_tool`, message: `Tool "${name}" is not registered. Available tools: ${TOOL_NAMES.join(', ')}` };
  }

  let args = rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      args = rawArgs.trim() === '' ? {} : JSON.parse(rawArgs);
    } catch (e) {
      return { ok: false, error: 'malformed_arguments', message: `Could not parse arguments as JSON: ${e.message}` };
    }
  }
  if (args && typeof args !== 'object') {
    return { ok: false, error: 'malformed_arguments', message: 'Arguments must be a JSON object' };
  }

  try {
    const result = await EXECUTORS[name](args || {}, ctx);
    if (result && result.error) {
      return { ok: false, error: 'invalid_arguments', message: result.error };
    }
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PathSecurityError) {
      return { ok: false, error: 'security_violation', message: e.message };
    }
    if (e && e.code === 'ENOENT') {
      return { ok: false, error: 'not_found', message: e.message };
    }
    return { ok: false, error: 'execution_error', message: e && e.message ? e.message : String(e) };
  }
}

module.exports = {
  TOOL_DEFS,
  TOOL_NAMES,
  PROVIDER_TOOL_SCHEMAS,
  toolSchemasFor,
  executeTool,
};
