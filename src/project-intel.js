'use strict';
/**
 * project-intel.js
 *
 * Project Intelligence: scans a project folder once, detects what is actually
 * there (languages, frameworks, package manager, entry points, tests,
 * configuration, docs, git), and builds a cached project map. Also provides
 * task-focused context selection: score project files against a task
 * description and return only the most relevant, size-bounded content.
 *
 * Honesty rule: only report what is actually detected. If something is
 * unknown, it is omitted or marked unknown — never guessed.
 *
 * The cache is keyed by project root and invalidated by a cheap top-level
 * signature (names + mtimes of the root and src/test dirs) or TTL, and can
 * be refreshed explicitly.
 */

const fs = require('fs');
const path = require('path');
const { resolveInProject } = require('./security');

const CACHE_TTL_MS = 30_000;
const MAX_FILES_SCANNED = 8000;
const MAX_SCAN_DEPTH = 8;
const CONTEXT_BYTE_BUDGET = 64 * 1024;
const MAX_FILE_BYTES_IN_CONTEXT = 16 * 1024;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', 'env', 'target', 'vendor', '.pytest_cache',
  '.mypy_cache', '.idea', '.vscode', '.agent',
]);

const LANG_BY_EXT = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.rb': 'Ruby',
  '.php': 'PHP', '.cs': 'C#', '.c': 'C', '.h': 'C', '.cpp': 'C++', '.hpp': 'C++',
  '.swift': 'Swift', '.kt': 'Kotlin', '.sh': 'Shell', '.html': 'HTML', '.css': 'CSS',
  '.scss': 'SCSS', '.sql': 'SQL', '.json': null, '.md': null, '.yml': null, '.yaml': null, '.toml': null,
};

// Framework detection from package.json dependency names (Node ecosystem).
const NODE_FRAMEWORKS = {
  react: 'React', preact: 'Preact', vue: 'Vue', svelte: 'Svelte', angular: 'Angular',
  '@angular/core': 'Angular', next: 'Next.js', nuxt: 'Nuxt', gatsby: 'Gatsby',
  express: 'Express', fastify: 'Fastify', koa: 'Koa', hapi: 'Hapi', '@nestjs/core': 'NestJS',
  electron: 'Electron', 'react-native': 'React Native', astro: 'Astro',
};

const PY_FRAMEWORKS = {
  fastapi: 'FastAPI', flask: 'Flask', django: 'Django', streamlit: 'Streamlit',
  tornado: 'Tornado', pyramid: 'Pyramid',
};

const TEST_FRAMEWORK_HINTS = {
  jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha', 'node:test': 'node:test',
  '@playwright/test': 'Playwright Test', cypress: 'Cypress', pytest: 'pytest',
};

const cache = new Map(); // realRoot -> { analyzedAt, signature, map }

// ---------------------------------------------------------------------------

function analyzeProject(projectRoot, opts = {}) {
  const root = fs.realpathSync(projectRoot);
  const signature = rootSignature(root);
  const hit = cache.get(root);
  if (!opts.refresh && hit && hit.signature === signature && Date.now() - hit.analyzedAt < CACHE_TTL_MS) {
    return { ...hit.map, cached: true };
  }
  const map = buildMap(root);
  cache.set(root, { analyzedAt: Date.now(), signature, map });
  return { ...map, cached: false };
}

function invalidateProjectCache(projectRoot) {
  try {
    cache.delete(fs.realpathSync(projectRoot));
  } catch {
    /* unknown root — nothing cached */
  }
}

function rootSignature(root) {
  // Cheap change signal: names + mtimes of top-level entries and key subdirs.
  const parts = [];
  for (const dir of [root, path.join(root, 'src'), path.join(root, 'test'), path.join(root, 'tests'), path.join(root, 'lib'), path.join(root, 'app')]) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) parts.push(`${path.relative(root, path.join(dir, e.name))}:${e.isDirectory() ? 'd' : Math.floor(fs.statSync(path.join(dir, e.name)).mtimeMs / 1000)}`);
    } catch {
      /* dir absent */
    }
  }
  return parts.join('|');
}

function buildMap(root) {
  const files = [];
  const dirs = [];
  let scanned = 0;
  walk(root, root, 0, files, dirs, () => scanned++ < MAX_FILES_SCANNED);

  const relFiles = files.map((f) => path.relative(root, f).split(path.sep).join('/'));
  const pkg = readJsonSafe(path.join(root, 'package.json'));

  const languages = detectLanguages(relFiles);
  const packageManager = detectPackageManager(root);
  const frameworks = detectFrameworks(pkg, root, relFiles);
  const testFramework = detectTestFramework(pkg, root, relFiles);
  const entrypoints = detectEntrypoints(root, relFiles);
  const testFiles = relFiles.filter(isTestFile);
  const configFiles = relFiles.filter(isConfigFile);
  const docs = relFiles.filter((f) => /^((README|CONTRIBUTING|CHANGELOG)(\.|$)|docs\/)/i.test(f));
  const buildDirs = dirs.map((d) => path.relative(root, d)).filter((d) => /^(dist|build|out|\.next|target)$/.test(d));
  const isGitRepo = fs.existsSync(path.join(root, '.git'));
  const scripts = pkg ? pkg.scripts || {} : {};

  const projectType = detectProjectType(pkg, root, languages);
  const commands = detectCommands(pkg, scripts, projectType, testFramework, root);

  return {
    root,
    projectType,
    languages,
    primaryLanguage: languages[0] ? languages[0].language : null,
    frameworks,
    packageManager,
    runtime: projectType === 'Node.js' ? (pkg && pkg.engines && pkg.engines.node ? `Node ${pkg.engines.node}` : 'Node.js') : null,
    entrypoints,
    testFramework,
    testFiles: testFiles.slice(0, 100),
    testDirectories: unique(dirs.map((d) => path.relative(root, d)).filter((d) => /^(test|tests|__tests__|spec)$/.test(d))),
    configFiles: configFiles.slice(0, 50),
    docs: docs.slice(0, 50),
    buildDirs,
    isGitRepo,
    scripts: Object.keys(scripts).slice(0, 30),
    dependencies: pkg ? Object.keys(pkg.dependencies || {}).slice(0, 100) : [],
    devDependencies: pkg ? Object.keys(pkg.devDependencies || {}).slice(0, 100) : [],
    commands,
    sourceDirectories: unique(dirs.map((d) => path.relative(root, d)).filter((d) => /^(src|lib|app|server|client)$/.test(d))),
    directoryCount: dirs.length,
    fileCount: relFiles.length,
    files: relFiles.slice(0, 2000), // bounded list for relevance scoring
    directories: dirs.map((d) => path.relative(root, d).split(path.sep).join('/')).slice(0, 500),
    analyzedAt: new Date().toISOString(),
  };
}

function walk(absRoot, dir, depth, files, dirs, budget) {
  if (depth > MAX_SCAN_DEPTH || !budget()) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!budget()) return;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
      if (entry.isDirectory() && entry.name !== '.git') dirs.push(path.join(dir, entry.name));
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      dirs.push(full);
      walk(absRoot, full, depth + 1, files, dirs, budget);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
}

// --- detectors -------------------------------------------------------------

function detectLanguages(relFiles) {
  const counts = new Map();
  for (const f of relFiles) {
    const lang = LANG_BY_EXT[path.extname(f).toLowerCase()];
    if (lang) counts.set(lang, (counts.get(lang) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([language, count]) => ({ language, files: count }));
}

function detectPackageManager(root) {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(root, 'package-lock.json'))) return 'npm';
  if (fs.existsSync(path.join(root, 'deno.json')) || fs.existsSync(path.join(root, 'deno.jsonc'))) return 'deno';
  if (fs.existsSync(path.join(root, 'poetry.lock'))) return 'poetry';
  if (fs.existsSync(path.join(root, 'requirements.txt'))) return 'pip';
  if (fs.existsSync(path.join(root, 'go.mod'))) return 'go modules';
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) return 'cargo';
  return null;
}

function detectFrameworks(pkg, root, relFiles) {
  const found = new Set();
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const dep of Object.keys(deps)) if (NODE_FRAMEWORKS[dep]) found.add(NODE_FRAMEWORKS[dep]);
    if (deps.typescript || relFiles.some((f) => /^tsconfig\.(json)?$/.test(f))) found.add('TypeScript');
  }
  const reqs = ['requirements.txt', 'Pipfile', 'pyproject.toml'];
  for (const req of reqs) {
    const content = readTextSafe(path.join(root, req), 64 * 1024);
    if (!content) continue;
    const lower = content.toLowerCase();
    for (const [mod, name] of Object.entries(PY_FRAMEWORKS)) {
      if (lower.includes(mod)) found.add(name);
    }
  }
  if (fs.existsSync(path.join(root, 'go.mod'))) found.add('Go');
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) found.add('Rust');
  if (fs.existsSync(path.join(root, 'composer.json'))) found.add('PHP (Composer)');
  if (fs.existsSync(path.join(root, 'Dockerfile')) || fs.existsSync(path.join(root, 'docker-compose.yml')) || fs.existsSync(path.join(root, 'docker-compose.yaml'))) found.add('Docker');
  return Array.from(found);
}

function detectTestFramework(pkg, root, relFiles) {
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const dep of Object.keys(deps)) {
      if (TEST_FRAMEWORK_HINTS[dep]) return TEST_FRAMEWORK_HINTS[dep];
    }
    if (pkg.scripts && /node --test/.test(pkg.scripts.test || '')) return 'node:test';
    if (pkg.scripts && pkg.scripts.test) return 'package.json test script';
  }
  if (relFiles.some((f) => /(^|\/)test_.*\.py$/.test(f) || /(^|\/).*_test\.py$/.test(f))) return 'pytest';
  if (relFiles.some((f) => /\*_test\.go$/.test(f) || /_test\.go$/.test(f))) return 'go test';
  if (relFiles.some(isTestFile)) return 'unknown (test files present)';
  return null;
}

function detectEntrypoints(root, relFiles) {
  const candidates = [
    'index.js', 'server.js', 'app.js', 'main.js', 'cli.js',
    'src/index.js', 'src/server.js', 'src/app.js', 'src/main.js', 'src/main.ts', 'src/index.ts',
    'main.py', 'app.py', 'manage.py', 'src/main.py',
    'main.go', 'src/main.rs', 'index.php', 'public/index.php',
  ];
  return candidates.filter((c) => relFiles.includes(c));
}

function isTestFile(f) {
  return /(^|\/)(test|tests|__tests__|spec)(\/|$)/.test(f) || /\.(test|spec)\.[jt]sx?$/.test(f) || /(^|\/)test_.*\.py$/.test(f) || /(^|\/).*_test\.py$/.test(f) || /_test\.go$/.test(f);
}

function isConfigFile(f) {
  const name = path.basename(f);
  return /^(package\.json|tsconfig.*\.json|jsconfig\.json|vite\.config\..+|webpack\.config\..+|rollup\.config\..+|babel\.config\..+|\.eslintrc.*|eslint\.config\..+|prettier|\.editorconfig|Dockerfile.*|docker-compose.*|\.env(\.example)?|requirements.*\.txt|pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|pom\.xml|build\.gradle.*|composer\.json|Makefile|\.github\/.*\.yml)$/.test(name) || /\/\.github\/.+\.ya?ml$/.test(f);
}

function detectProjectType(pkg, root, languages) {
  const has = (f) => fs.existsSync(path.join(root, f));
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}) };
    if (deps.next) return 'Next.js app';
    if (deps.react || deps['react-dom']) return 'React app';
    if (deps.vue) return 'Vue app';
    if (deps.svelte) return 'Svelte app';
    if (deps.express || deps.fastify || deps.koa) return 'Node.js server';
    if (pkg.bin || pkg.scripts && pkg.scripts.cli) return 'Node.js CLI';
    return 'Node.js';
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('Pipfile')) {
    const reqs = readTextSafe(path.join(root, 'requirements.txt'), 65536) || '';
    const pyproject = readTextSafe(path.join(root, 'pyproject.toml'), 65536) || '';
    if (/fastapi|flask|django/i.test(reqs + pyproject)) return 'Python web app';
    return 'Python';
  }
  if (has('go.mod')) return 'Go';
  if (has('Cargo.toml')) return 'Rust';
  if (has('pom.xml') || has('build.gradle')) return 'Java';
  if (has('composer.json')) return 'PHP';
  const primary = languages[0] && languages[0].language;
  return primary ? `${primary} project` : 'Unknown';
}

function detectCommands(pkg, scripts, projectType, testFramework, root) {
  const run = [];
  const test = [];
  if (pkg && scripts) {
    for (const s of ['dev', 'start', 'serve']) if (scripts[s]) run.push(`npm run ${s}`);
    if (scripts.test) test.push('npm test');
  }
  if (projectType === 'Python' || /Python/.test(projectType || '')) {
    run.push('python main.py');
    test.push('pytest');
  }
  if (projectType === 'Go') {
    run.push('go run .');
    test.push('go test ./...');
  }
  if (projectType === 'Rust') {
    run.push('cargo run');
    test.push('cargo test');
  }
  if (pkg && !scripts.test && testFramework === 'node:test') test.push('node --test');
  return { run: dedupe(run).slice(0, 5), test: dedupe(test).slice(0, 5) };
}

// --- relevance scoring / context engine ------------------------------------

const RELEVANCE_STOPWORDS = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'fix', 'add', 'make', 'sure', 'work', 'works', 'please', 'should', 'would', 'there', 'their', 'about', 'when', 'then']);

function tokenizeForRelevance(text) {
  return Array.from(
    new Set(
      String(text || '')
        .toLowerCase()
        .split(/[^a-z0-9_.-]+/)
        .filter((w) => w.length >= 3 && !RELEVANCE_STOPWORDS.has(w))
    )
  );
}

/**
 * Score project files against a task description. Signals:
 *  - task words appearing in the file path (strong)
 *  - task words appearing in the file's content (bounded scan of candidates)
 *  - entry points / tests / config get a small prior
 * Returns [{ path, score, reasons }] sorted by score, top `limit`.
 */
function findRelevantFiles(projectRoot, task, opts = {}) {
  const map = opts.map || analyzeProject(projectRoot);
  const root = map.root;
  const words = tokenizeForRelevance(task);
  if (words.length === 0) return [];

  const candidates = map.files.filter((f) => !isTestFile(f) || words.some((w) => f.toLowerCase().includes(w))).slice(0, 800);
  const scored = [];
  for (const f of candidates) {
    const lowerPath = f.toLowerCase();
    let score = 0;
    const reasons = [];
    for (const w of words) {
      if (lowerPath.includes(w)) {
        score += 5;
        reasons.push(`path contains "${w}"`);
      }
    }
    // Priors only boost files that already matched the task — a file that
    // matches nothing is never force-ranked into the results.
    if (score > 0) {
      if (map.entrypoints.includes(f)) {
        score += 2;
        reasons.push('entry point');
      }
      if (isTestFile(f)) {
        score += 1;
        reasons.push('test file');
      }
    }
    scored.push({ path: f, score, reasons });
  }

  // Content pass over the top path-scored candidates (bounded).
  scored.sort((a, b) => b.score - a.score);
  for (const item of scored.slice(0, 150)) {
    const content = readTextSafe(path.join(root, item.path), 256 * 1024);
    if (!content) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      for (const w of words) {
        if (line.includes(w)) {
          item.score += 1;
          item.reasons.push(`line ${i + 1} mentions "${w}"`);
          break;
        }
      }
    }
  }

  const threshold = Math.max(1, Number(opts.relevanceThreshold) || runtimeDefaults.relevanceThreshold);
  return scored
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit || 10)
    .map(({ path: p, score, reasons }) => ({ path: p, score, reasons: dedupe(reasons).slice(0, 5) }));
}

/**
 * Build a focused model context: trimmed project map + the most relevant
 * files' contents within a byte budget. Only what exists is included.
 */
function buildContext(projectRoot, task, opts = {}) {
  const map = opts.map || analyzeProject(projectRoot);
  const relevant = findRelevantFiles(projectRoot, task, { map, limit: opts.fileLimit || 6, relevanceThreshold: opts.relevanceThreshold });
  const files = [];
  let budget = Number(opts.contextBudgetBytes) || runtimeDefaults.contextBudgetBytes;
  const root = map.root;
  for (const item of relevant) {
    if (budget <= 0) break;
    const content = readTextSafe(path.join(root, item.path), MAX_FILE_BYTES_IN_CONTEXT);
    if (content == null) continue;
    const take = content.slice(0, Math.min(content.length, budget, MAX_FILE_BYTES_IN_CONTEXT));
    files.push({ path: item.path, score: item.score, bytes: Buffer.byteLength(take), truncated: take.length < content.length, content: take });
    budget -= Buffer.byteLength(take);
  }
  return {
    mapSummary: {
      projectType: map.projectType,
      primaryLanguage: map.primaryLanguage,
      frameworks: map.frameworks,
      packageManager: map.packageManager,
      entrypoints: map.entrypoints,
      testFramework: map.testFramework,
      commands: map.commands,
      isGitRepo: map.isGitRepo,
      fileCount: map.fileCount,
    },
    relevantFiles: relevant,
    files,
    budgetBytesUsed: (Number(opts.contextBudgetBytes) || runtimeDefaults.contextBudgetBytes) - Math.max(budget, 0),
  };
}

// --- helpers ----------------------------------------------------------------

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readTextSafe(p, maxBytes) {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function unique(arr) {
  return Array.from(new Set(arr));
}

function dedupe(arr) {
  return Array.from(new Set(arr));
}

/**
 * Runtime-configurable defaults (Settings Center → Context). The server
 * applies these at boot and on settings updates so the context engine and
 * relevance threshold actually follow user configuration.
 */
const runtimeDefaults = { contextBudgetBytes: CONTEXT_BYTE_BUDGET, relevanceThreshold: 1 };

function setDefaults({ contextBudgetBytes, relevanceThreshold } = {}) {
  if (Number.isInteger(contextBudgetBytes)) runtimeDefaults.contextBudgetBytes = contextBudgetBytes;
  if (Number.isInteger(relevanceThreshold)) runtimeDefaults.relevanceThreshold = relevanceThreshold;
}

function getDefaults() {
  return { ...runtimeDefaults };
}

module.exports = {
  analyzeProject,
  invalidateProjectCache,
  findRelevantFiles,
  buildContext,
  isTestFile,
  tokenizeForRelevance,
  setDefaults,
  getDefaults,
  CACHE_TTL_MS,
};
