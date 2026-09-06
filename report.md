# AI SOFTWARE ENGINEERING WORKSTATION — FULL PROJECT REPORT

> Complete engineering report: the journey from the original 1.0 codebase to the
> current 2.0 production build — every change made, how everything works, the
> full project structure, all available tools, live testing results (including
> the first real cloud-LLM runs with Google Gemini), bugs found and fixed along
> the way, and the future improvement roadmap.

---

## 1. EXECUTIVE SUMMARY

This project started as a small, honest, zero-dependency Node.js coding agent
(one agent loop, 6 tools, a basic chat UI, 36 passing tests). It has been
transformed — incrementally, without ever breaking the existing baseline — into
a **local AI Software Engineering Workstation**:

```
Open a project → understand it → accept a task → plan → edit safely
→ show a diff → get approval → run tests → parse failures → fix
→ verify in a browser → report the result honestly
```

| Metric | Before (v1.0) | Now (v2.0) |
|---|---|---|
| Tests passing | 36 | **153** (0 failures, 0 skipped) |
| Registered tools | 6 | **23** (browser tools included when Playwright is present) |
| Agent modes | 1 (always-on agent) | 6 (Ask / Code / Debug / Test / Review / Autonomous) |
| Safety system | none | 5 safety modes + 4 risk levels + approval engine |
| Project understanding | "please list files" | dedicated scanner + cached project map + context engine |
| Test intelligence | raw log dumps | structured parsing for node:test / Jest / pytest / go + history |
| Git | none | status / diff / log + destructive-op protection |
| Browser | none | optional Playwright adapter with real verification |
| Local models | generic endpoint only | dedicated Ollama adapter with detection + model discovery |
| Cloud LLM verified live | never (no key available) | **verified with Google Gemini (live tool-calling runs)** |
| UI | 3-pane chat | 7-tab professional workstation, premium dark/light themes |

The core is still **zero-runtime-dependency** (`"dependencies": {}` in
package.json). Playwright remains an optional capability, installed separately.

---

## 2. THE JOURNEY — PHASE BY PHASE

Every phase followed the discipline: *inspect → plan → modify → test → verify
→ document*. The protected baseline test suite was run before and after every
phase.

### Phase 0 — Audit (no code changed)
Extracted the zip, read every file, ran the baseline suite (36/36), and
produced a report of current architecture, features, providers, agent loop,
security model, UI, memory, tasks, limitations, and technical debt.

### Phase 1 — Provider Manager 2.0
- Rewrote `src/providers.js` around an **adapter architecture**
  (`openai-compatible`, `ollama`) so new provider types plug in without
  touching the router or agent loop.
- Added **model discovery** (`/api/tags` for Ollama, `/models` for OpenAI-
  compatible gateways; Gemini's `models/` id prefix is normalized).
- Added per-provider **health and usage tracking**: requests, failures,
  fallbacks, latency, prompt/completion tokens (when the provider reports
  them) — surfaced in the UI.
- Made the router **late-binding** (accepts a function returning the current
  provider list), so cooldown/health state survives across tasks while the
  provider list stays editable live.
- `detectOllama()` probes `http://localhost:11434/api/tags` and reports
  honestly — offline is offline, models are never fabricated.

### Phase 2 — Project Intelligence
- New `src/project-intel.js`: scans a project once and detects what is
  **actually there** — languages, frameworks (Node + Python ecosystems),
  package manager, entry points, test framework/files/dirs, config files,
  docs, build dirs, git repo — and derives run/test commands.
- **Cached project map** invalidated by a cheap top-level change signature
  (names + mtimes) or TTL, with explicit refresh.
- **Context engine**: scores files against a task description (path matches +
  bounded content scan + entry-point/test priors) and builds a size-bounded
  context bundle (map summary + top files' contents, 64 KB budget).
- New tools: `get_project_map`, `find_relevant_files`, `get_project_context`.

### Phase 3 — Agent Modes
- New `src/modes.js`: six modes. Each mode changes **three real things**: the
  tool surface declared to the model, the system-prompt instructions, and the
  server-side enforcement (a non-allowed tool call is rejected before
  execution even if the model insists). Read-only modes physically cannot
  mutate the project.
- `Auto` resolves from the task text (fix/debug → Debug, test → Test, review
  → Review, explain → Ask, else Code).
- No mode passed = exact pre-modes behavior (back-compat preserved and tested).

### Phase 4 — Diff / Approval / Safety
- New `src/diff.js`: zero-dependency LCS line diffing, stats, git-style
  unified patches, bounded for huge files.
- New `src/risk.js`: LOW / MEDIUM / HIGH / CRITICAL classification for every
  tool call and shell command (destructive git, `rm -rf`, `sudo`, package
  installs, database drops, piped remote scripts, force pushes…).
- New `src/approvals.js`: persistent proposal engine — file diffs and command
  proposals with approve / reject / apply / revert, a **clobber guard**
  (refuses to apply if the file changed since the proposal), sandboxed
  application, bounded history, and `waitForDecision` so the agent pauses
  (bounded) while the user decides. Rejections are fed back to the model as
  structured data.
- The agent loop gained the **safety gate**: the full matrix below.

| Safety mode | File edits | Commands/tests | HIGH risk (npm install, git push…) | CRITICAL (rm -rf, git reset --hard, sudo…) |
|---|---|---|---|---|
| **Read-only** | blocked | blocked | blocked | blocked |
| **Assist** | proposed (diff) | proposed | proposed | proposed |
| **Edit** | applied | proposed | proposed | proposed |
| **Agent** (default) | applied | LOW/MEDIUM run | proposed | proposed |
| **Autonomous** | applied | run | run | proposed |

`git commit` is **always** a proposal — history belongs to the user.

### Phase 5 — Test Intelligence
- New `src/test-intel.js`: framework/test detection, real runs (full suite or
  targeted file), and output **parsing** into structured totals + per-test
  failures with messages for node:test TAP, Jest/Vitest, pytest, and go test —
  with an honest `generic` fallback that admits when it cannot parse.
- Failure↔change association by evidence; bounded run history.
- New tools: `run_tests`, `detect_tests`.

### Phase 6 — Git Intelligence
- New `src/git.js`: repo detection, status parsing (branch, staged, unstaged,
  untracked), unified diff, recent commits, change summary — via the native
  git CLI, no git framework.
- New tools: `git_status`, `git_diff`, `git_log` (read-only) and
  `git_commit` (which can ONLY create an approval proposal — it refuses to
  execute directly).
- Destructive git operations classify as CRITICAL in every safety mode.

### Phase 7 — Browser / Playwright (optional)
- New `src/browser.js`: availability detection, a shared headless Chromium
  session, navigate / click / type / select / content / screenshot, console +
  pageerror + failed-request capture, hard timeouts, idle auto-close, and
  graceful shutdown.
- **Browser tools are registered only when Playwright actually resolves** —
  the UI and the model never see phantom browser capability, and nothing ever
  fakes a browser result.
- Live tests (navigate, interact, screenshot, error capture) run for real
  when Chromium is installed and **honestly self-skip** otherwise.

### Phase 8 — Autonomous Debug Loop
- New `src/debug-loop.js`, built on the same agent loop (no duplicate agent
  architecture):
  ```
  UNDERSTAND → INVESTIGATE (read-only pass: observations, root-cause
  hypothesis, fix plan)
  → [FIX → TEST (real run, parsed) → ANALYZE (failures fed back)] × ≤3
  → optional browser verification
  → engineering report: PASS / PARTIAL / FAILED / BLOCKED
  ```
- Reports include root cause, files changed, real test evidence, and
  remaining issues. PARTIAL is reported when the failure count improved;
  BLOCKED when the provider is unreachable. Cancellation is checked at every
  phase boundary.

### Phase 9 — Task Center + Memory
- `src/tasks.js`: real lifecycle (queued / running / waiting_approval /
  testing / debugging / completed / partial / failed / blocked / cancelled),
  mode + provider/model tracking, attempts, errors, **cooperative
  cancellation** (the runner polls between steps), safe retry (new record,
  history never destroyed), bounded storage.
- `src/memory.js`: bounded per-category storage (500 entries, oldest-first
  eviction) and optional **project scoping**; secret-like keys are still
  rejected at write time.

### Phase 10 — Workstation UI
- Full rebuild into a 7-tab workstation: **Chat, Files, Diff & Approvals,
  Tests, Git, Browser, Terminal**, plus project/file-tree sidebar, task
  center, provider panel with health badges, memory panel, and a live
  activity timeline with timestamps.
- Split into `app.js` (shell: chat, SSE, tasks, providers, memory) and
  `panels.js` (pure view layer) — **all business logic stays server-side**.
- New backend endpoints power it: sandboxed file explorer/editor
  (`/api/files`, `/api/file`, `/api/file/save` — save respects the safety
  mode), risk-gated terminal (`/api/terminal/run`), browser verify, approvals
  API, tests API, git API.
- **UI v2 (this session):** premium dark & light themes — gradient accents,
  glass panels with backdrop blur, pill tabs, gradient primary buttons,
  refined badges/tables/diff colors, custom scrollbars, focus rings,
  micro-animations, flexible layout that fixes composer clipping.

### Phase 11 — CLI + API integration
- `cli.js` now has: `run` (with `--mode`, interactive `Approve? [y/N]`
  prompts, autonomous debug loop), `analyze`, `providers`, `models`, `tasks`,
  `tests`, `git`, `modes`, `tools`, `doctor`.
- The CLI shares **every service** with the server — one engine, no duplicate
  logic.

### Phase 12 — Hardening
- 2 MB request-body limit (413), malformed JSON → 400, structured JSON 404s
  for unknown API paths, static traversal blocked, `nosniff` + `no-store`
  headers, single-agent-run lock (409 for concurrent runs), provider-test
  timeout, graceful shutdown (frees the browser), uncaught-error handlers.
- `src/exec-env.js`: strips `NODE_TEST_CONTEXT` from spawned children so
  nested `node --test` runs behave like normal shell runs.

### Phases 13–14 — Integration testing + documentation
- Full endpoint sweeps against a live server, dogfooding the analyzer on the
  project itself, live SSE runs, and this report + README + CHANGES.

---

## 3. PROJECT STRUCTURE

```
coding-agent-workstation/
├── server.js               HTTP server (zero-dep): static UI + JSON/SSE API,
│                           long-lived provider router, single-run lock,
│                           graceful shutdown
├── cli.js                  CLI: run / analyze / providers / models / tasks /
│                           tests / git / modes / tools / doctor
├── package.json            "dependencies": {} — zero runtime dependencies
│
├── src/
│   ├── agent-loop.js       THE one agent loop: mode resolution, tool surface
│   │                       filtering, safety gate, approval pauses,
│   │                       cancellation, corrective retries for tool-contract
│   │                       violations, activity events
│   ├── agent-tools.js      THE single tool registry (23 tools): schema +
│   │                       executor defined together, browser tools
│   │                       conditionally registered
│   ├── debug-loop.js       Autonomous workflow: investigate → fix → test →
│   │                       analyze × ≤3 → browser verify → report
│   ├── modes.js            Agent modes (tool sets + instructions + enforcement)
│   ├── project-intel.js    Scanner, cached project map, relevance scoring,
│   │                       bounded context builder
│   ├── test-intel.js       Test detection, runner, TAP/Jest/pytest/go parser,
│   │                       failure association, bounded history
│   ├── git.js              Native-git status/diff/log/change summary
│   ├── diff.js             LCS line diff, stats, unified patches
│   ├── risk.js             LOW/MEDIUM/HIGH/CRITICAL classification
│   ├── approvals.js        Proposal store: approve/reject/apply/revert,
│   │                       clobber guard, waitForDecision
│   ├── providers.js        Adapter router: openai-compatible + ollama,
│   │                       health/usage tracking, model discovery,
│   │                       detectOllama, bounded fallback with cooldown
│   ├── config.js           Persisted config (providers masked, projects,
│   │                       theme, safety mode), presets, Ollama entry helper
│   ├── memory.js           Bounded 5-category memory, project scoping,
│   │                       secret-key rejection
│   ├── profiles.js         Working-profile recall of past tasks (keyword
│   │                       overlap — honestly NOT vector search)
│   ├── tasks.js            Task Center: lifecycle, cancel, retry, bounds
│   ├── security.js         Project-root sandbox: traversal / absolute /
│   │                       symlink-escape blocking (unchanged since audit)
│   └── exec-env.js         Child-env sanitizer (nested node:test fix)
│
├── public/
│   ├── index.html          Workstation layout: header (project, mode, safety,
│   │                       model chip, theme) + 7-tab center + sidebars
│   ├── app.js              Shell: chat/SSE, activity timeline, tasks,
│   │                       providers, memory, settings
│   ├── panels.js           View layer: file tree, editor, approvals, tests,
│   │                       git, browser, terminal (no business logic)
│   └── styles.css          UI v2: premium dark + light themes, zero CSS deps
│
└── test/                   153 tests across 15 files (see §9)
```

---

## 4. HOW IT WORKS (REQUEST FLOW)

```
UI (public/) ──HTTP/SSE──▶ server.js routes
                              │
              ┌───────────────┼─────────────────────────┐
              ▼               ▼                         ▼
        /api/agent/run   /api/tests/*, /api/git/*,   /api/providers/*
              │          /api/files/*, /api/approvals      │
              ▼                                           ▼
      agent-loop or debug-loop                    ProviderRouter (adapters)
              │                                           │
      safety gate (risk + safety mode)            cloud (Groq/Gemini/OpenRouter)
              │                                   local (Ollama / llama.cpp)
      tool execution (sandboxed)                          │
              │                                     fallback + cooldown
      project-intel / test-intel / git / approvals
              │
      activity events ──SSE──▶ UI timeline; task lifecycle synced
```

An agent task: the loop sends the conversation + the mode-filtered tool
schemas to the best eligible provider; on failure it cools that provider down
and tries the next (bounded); the model's tool calls pass through the safety
gate (risk × safety mode) before touching the project; tool results return as
structured JSON the model can reason over; the loop stops when the model
answers without tool calls, hits the 12-iteration cap, or is cancelled.

---

## 5. AVAILABLE TOOLS (23)

**Read / inspect (LOW risk)**
| Tool | Purpose |
|---|---|
| `list_files` | list a directory inside the project |
| `read_file` | read a file (512 KB cap) |
| `search_project` | plain-text search across the project (bounded) |
| `get_project_map` | cached project analysis (languages, frameworks, entry points, tests, commands) |
| `find_relevant_files` | rank files relevant to a task, with reasons |
| `get_project_context` | map summary + relevant file contents (64 KB budget) |
| `git_status` | branch, staged/unstaged/untracked |
| `git_diff` | unified diff (unstaged or staged) |
| `git_log` | recent commits |

**Mutation (MEDIUM — gated by safety mode)**
| Tool | Purpose |
|---|---|
| `write_file` | create/overwrite a file (or propose in Assist) |
| `edit_file` | exact-substring replace, unique-match enforced |
| `run_tests` | detect + run tests, structured parsed results |
| `detect_tests` | testing setup report |
| `git_add` | stage files (proposed in Assist/Edit) |

**Execution (risk-classified per command)**
| Tool | Purpose |
|---|---|
| `run_command` | shell command in the project root, timeout, risk-gated |
| `git_commit` | ONLY creates an approval proposal — never silent |

**Browser (registered only when Playwright is installed)**
| Tool | Purpose |
|---|---|
| `browser_navigate` | open a URL; returns title + captured errors |
| `browser_click` / `browser_type` / `browser_select` | interact with pages |
| `browser_screenshot` | PNG to disk (sandboxed path) or base64 |
| `browser_content` | page/element HTML |
| `browser_errors` | console + page + failed-request errors |
| `browser_close` | free the browser session |

---

## 6. PROVIDER SYSTEM + LIVE GEMINI VERIFICATION

**Configured providers (current machine):** Google Gemini (free tier,
`gemini-3.6-flash`, priority 1) + two repaired legacy entries (see §8).
Provider config lives in `~/.coding-agent/config.json` with keys **masked in
every API response** — the raw key never appears in the UI, logs, task
history, or error messages.

**Live verification performed with the real Gemini API key** (first real
cloud-LLM runs in this project's history):

1. **Connection test** — `POST /api/providers/test` → HTTP 200.
2. **Model discovery** — 55 real models listed from
   `generativelanguage.googleapis.com` (`/models` id prefix normalized).
3. **Ask-mode task** — "what is this project and its main modules?" →
   completed with 4 real tool calls (`get_project_map`, `list_files`,
   `read_file README.md`…) and an accurate summary.
4. **Code-mode task** — "create math.js with add(a,b) and math.test.js" →
   Gemini wrote both files through the workstation's sandboxed `write_file`;
   the generated test **passes** (`node --test` → 1/1 PASS).
5. **UI end-to-end** — the task was typed into the real browser composer
   (Playwright-driven): result card "✓ Task completed", model chip updated to
   `gemini-1 / gemini-3.6-flash`, 5 activity events rendered, zero page
   errors.

Usage tracking after runs correctly recorded requests, latency (≈56 ms first
token for the mock; multi-second for real Gemini), and token counts.

---

## 7. AGENT MODES & SAFETY

**Agent modes** — Ask (read-only explain) · Code (implement + test) · Debug
(root cause + minimal fix + verify) · Test (run + analyze, no edits) · Review
(read-only audit) · Autonomous (full debug loop) · Auto (resolved from task
text). Modes constrain the declared tool surface AND are enforced server-side.

**Safety modes** — Read-only / Assist / Edit / Agent (default) / Autonomous
(see the matrix in §2 Phase 4). CRITICAL-risk operations always require
explicit approval in every mode. `git commit` always requires approval.

---

## 8. BUGS FOUND & FIXED DURING LIVE TESTING

This session's live testing (real Gemini + real browser) found and fixed:

1. **Dead model id** — `gemini-2.5-flash` is no longer available to new
   accounts (HTTP 404 from the API, which recommends `gemini-3.6-flash`).
   Fixed the provider entry and the Gemini preset default; the preset note now
   tells users to re-check models via the discovery endpoint.
2. **Opaque provider errors** — failures surfaced only `all_providers_failed`,
   hiding the actual cause. The agent loop now appends the last provider error
   (`…— last error: Provider X returned HTTP 404: …`), which is exactly how
   bug #1 was diagnosed.
3. **Stale provider entries** — the config contained two broken manual
   entries: model id `groq` (a provider name, not a model) and model id
   `Gemini API Key` (the key's *name* pasted into the model field). Both were
   repaired to valid model ids (`llama-3.3-70b-versatile`,
   `gemini-3.6-flash`) without touching stored keys.
4. **`models/` id prefix** — Gemini's OpenAI-compatible `/models` returns ids
   like `models/gemini-3.6-flash`; discovery now strips the prefix so ids are
   directly usable as the chat model value.
5. **Clipped composer** — the layout used `calc(100vh - 53px)`, which broke
   when the header grew; the quick-action row was cut off at 1440×900.
   Fixed with a flex layout (`.app-body { flex: 1; min-height: 0 }`).
6. **Empty summary pill** — an empty project-map summary box rendered before
   the first analysis; `:empty { display: none }` added.

Earlier phases' notable catches (all caught by tests before delivery): the
`--?` regex bug in destructive-git detection, `npm test` missing from the
LOW-risk list, TAP failure-message extraction, the missing file setup in two
tests, commit-command quoting (`git commit -m` message unquoted), and the
nested `node --test` env leak (`NODE_TEST_CONTEXT`).

---

## 9. TESTING — 153 TESTS, ALL PASSING

```
node --test  →  # tests 153  # pass 153  # fail 0  # skipped 0
```

| Suite | What it covers |
|---|---|
| `test.js` (baseline, untouched) | tool registry sync, sandbox escapes, router fallback, memory, tasks, agent loop, tool-contract recovery, profiles |
| `providers.test.js` | usage/latency tracking, fallback counting, late binding, model discovery adapters, Ollama detection, config normalization, safety-mode setting |
| `project-intel.test.js` | Node/Python detection, caching + invalidation, honest no-fabrication, relevance scoring, context budget, new tools |
| `modes.test.js` | tool-surface restriction, server-side enforcement, auto resolution, back-compat, mode instructions, activity events |
| `approvals.test.js` | diff engine, risk classification, propose/approve/reject/revert, clobber guard, sandboxed apply, command capture, safety gate in every mode |
| `test-intel.test.js` | real node:test runs (pass + fail + targeted), TAP/Jest/pytest/go parsing, honest generic fallback, failure association, history, tools |
| `git.test.js` | real temp repos: status/diff/log, change summary, tools, commit-proposal-only guarantee |
| `browser.test.js` + `browser-live.test.js` | honest unavailability, conditional tool registration, real Chromium navigate/click/screenshot/error-capture (self-skips without Playwright) |
| `debug-loop.test.js` | real bug fixed end-to-end (PASS), bounded attempts (FAILED), failure analysis on retry, BLOCKED on provider outage, cancellation, assist-mode approvals |
| `task-center.test.js` | lifecycle statuses, cooperative cancel, retry, bounds, persistence, loop cancellation, memory bounds + scoping |
| `ui-backend.test.js` | file explorer/editor endpoints (sandbox + assist proposals), risk-gated terminal, modes/tools/browser capability endpoints |
| `ui-live.test.js` | REAL Chromium click-through: project load, file tree + viewer, terminal run, real test run via button, approve-applies-to-disk, git honesty, browser capability, live agent task via scripted provider, zero page errors |
| `cli.test.js` | `cli.js run` end-to-end via a mock provider + doctor/modes/tools |
| `hardening.test.js` | 400 malformed JSON, 413 oversized body, JSON 404s, static traversal block, 409 concurrent-run lock |

---

## 10. SECURITY

- **Filesystem sandbox** (`src/security.js`, unchanged since audit): blocks
  relative traversal, absolute escapes, and symlink escapes on every file
  operation — including editor saves, screenshot paths, and test targets.
- **Secrets**: stored only in `~/.coding-agent/config.json`; masked in every
  API response; never in logs, task history, memory, or errors; the memory
  store rejects secret-like keys at write time.
- **Risk classification + approval gates** on every tool call and command.
- **Bounded everything**: command timeouts, capped reads/searches/results,
  bounded task/approval/memory/history stores, 12-iteration agent cap,
  bounded debug-loop attempts, 5-minute approval timeout.
- **HTTP hardening**: body limit, structured errors, single-run lock,
  security headers, graceful shutdown, child-env sanitizer.

---

## 11. FUTURE IMPROVEMENTS (ROADMAP)

**Near-term**
1. **Streaming token output** — stream model text into the chat as it
   generates (SSE already in place; needs provider stream parsing).
2. **Real vector memory** — replace/augment keyword-overlap profiles with
   local embeddings (e.g. via Ollama embeddings) while keeping the honest
   labeling.
3. **Conversation continuity** — multi-turn chat sessions with the agent
   instead of one-shot tasks (history plumbing exists in `runAgentTask`).
4. **Diff review inside the autonomous loop** — optional per-edit approval in
   Autonomous mode for users who want oversight with full automation.
5. **Parallel agent sandboxing** — per-task worktrees (git branches) so two
   tasks can run concurrently without conflicts.

**Mid-term**
6. **MCP-style tool registry** — the registry is already contract-first;
   add an adapter so external MCP servers can contribute tools.
7. **More provider adapters** — Anthropic native API, OpenAI native,
   llama.cpp server health, LM Studio discovery.
8. **Cost estimation** — per-model price tables for estimated session cost
   (usage tracking already records tokens).
9. **Test-center diffing** — flaky-test detection and failure trending from
   the existing history store.
10. **Editor upgrades** — syntax highlighting (lightweight, dependency-free)
    and inline diff gutter.

**Long-term**
11. **Packaging** — single-command installer / Electron-style desktop shell.
12. **Team features** — shared approval queues, audit log export.
13. **Plugin API** — user-contributed tools loaded from a folder with the
    same schema/executor contract and risk declarations.

---

## 12. HOW TO RUN

```bash
npm start                 # → http://localhost:3300
npm test                  # 153 tests
node cli.js doctor        # system check
node cli.js run "fix the failing test" --mode autonomous
```

Optional browser capability: `npm install --no-save playwright && npx
playwright install chromium`.

**Configured right now on this machine:** Google Gemini (free tier) as the
priority-1 provider with a working key, Groq + a second Gemini entry repaired
and ready, Ollama detection wired (offline until `ollama serve` starts), and
Playwright installed with Chromium.

---

## 13. EVOLUTION ROUND 2 (FINAL DIRECTIVE) — NEW SUBSYSTEMS

After the 2.0 build, a second master directive added the remaining architecture
(Phases A–M below). Baseline before: 153/153. Final after: **180/180**.

| Phase | Subsystem | What was built |
|---|---|---|
| A | **Settings Center** (`src/settings.js`) | Persisted, validated settings: model strategy (LOCAL_FIRST / FREE_CLOUD_FIRST / BEST_AVAILABLE / CHEAPEST_AVAILABLE / MANUAL), offline mode, max agents + parallelism (defaults: 3 / 1 — conservative), reviewer-required, checkpoint-before-autonomous, test-before-complete, context budget, task token budget, bounded provider retries. Unknown keys and bad values are rejected. UI: Settings tab. |
| B | **Skills Engine** (`src/skills.js`) | `skills/<name>/skill.md` files (project + global dirs) with frontmatter (name, description, applicability keywords, modes). Only task-relevant skills are matched (keyword + project-framework scoring) and injected as clearly-labeled ADVISORY system context — never forced, never overriding safety. API `/api/skills`, UI Skills panel, CLI `skills` command. This project ships its own `skills/debugging` and `skills/testing`. |
| C | **API Key Pool** (`src/providers.js`) | A provider entry may carry `keys: [k1, k2, …]` — the router expands it into per-key candidates with independent cooldown/health, so a 429 on key 1 rotates to key 2 of the SAME provider before other providers. All keys masked everywhere. |
| D | **Smart Model Router** (`src/model-router.js`) | Strategy-based ordering of eligible candidates, installed on the router as a hook; MANUAL isolates one provider (honest refusal otherwise); offline mode filters to LOCAL providers and refuses with `OFFLINE_NO_LOCAL_PROVIDER` when none exist. |
| E | **Plan mode** (`src/modes.js`) | A 7th agent mode: read-only investigation ending in a structured plan (understanding, context, skills, files affected, expected changes, expected tests, risks). |
| F | **Checkpoint / Snapshot** (`src/checkpoints.js`) | Capture the dirty file set (git status -uall, or explicit list) before autonomous work; list / compare (with diffs) / restore with creation-undo; bounded per project; sandboxed paths. Autonomous runs create one automatically (setting-gated) and report its id. |
| G | **Failure Knowledge Base** (`src/knowledge.js`) | Project-scoped bounded episodes: error signature, affected files, failed attempts ("do NOT repeat"), successful fix, final result. Recalled by keyword overlap into the investigation context. |
| H | **AI Quality Evaluator** (`src/evaluator.js`) | Independent evidence layer: verifies declared files exist and are non-empty, re-runs tests, detects blockers; returns VERIFIED / PARTIAL / FAILED / BLOCKED. Wired into the autonomous loop's final verification and its report. |
| I | **Multi-Agent Orchestrator** (`src/orchestrator.js`) | Team runs: bounded agent count and parallelism (Settings), roles per mode (Research/Coding/Testing/Review…), parent/child task records, file-ownership CONFLICT detection, real integration test run, optional Review agent, evidence-based verdict. API `POST /api/team/run` (SSE). |
| J | **Plugin SDK** (`src/plugins.js`) | Strict-validated runtime tool registration (name/schema/risk/handler) that keeps the registry's declared==executable invariant; the prepared integration point for a future MCP adapter. |
| K | **Sandbox adapter** (`src/sandbox.js`) | Honest Docker detection (AVAILABLE / UNAVAILABLE) and optional in-container execution with the project mounted at /workspace. |
| L | **Doctor 2.0** (`src/doctor.js`) | 12 real checks (Node, npm, Git, data dir writability, disk, project, test framework, skills, providers, Ollama, Playwright, safety mode) with actionable details — shared by CLI `doctor` and `GET /api/doctor`. |
| M | **UI additions** | Settings tab (all of the above), Skills panel, LOCAL/OFFLINE chip, team roles in the task list. CLI: `skills`, Doctor 2.0. |

### Live verification with real providers (this round)

- **Skills**: the workstation detected its own `debugging-discipline` /
  `testing-standards` skills via the CLI; a live autonomous run loaded the
  fixture project's `calc-conventions` skill (activity event: "Loaded 1
  relevant project skill(s)").
- **Checkpoints**: every autonomous run captured a checkpoint id reported in
  the engineering report; restore/rollback verified in E2E tests.
- **Provider failure chain (live)**: Gemini returned 429 (quota exhausted —
  legitimately), the router cooled it down and fell over to Groq; Groq's
  deprecated model id was diagnosed via the surfaced provider error and
  model discovery, fixed to `openai/gpt-oss-120b`; TPM rate limits
  (8000/min) then exposed the need for spaced retries — the bounded retry
  policy (2 extra passes, 15s apart, from Settings) carried the run through.
- **Full live autonomous fix**: a real buggy project was fixed by a real
  cloud model (Groq) through the complete stack — skills matched, checkpoint
  captured, `edit_file` + `run_tests` executed, tests passed, and the
  independent evaluator returned **VERIFIED**. The task record shows
  `completed · autonomous`; the honestly-blocked attempts during quota
  windows are preserved in the task history as evidence of honest reporting.
- **Provider state honesty**: both Gemini entries were left DISABLED after
  their free-tier quota was exhausted during testing (re-enable by setting
  `enabled: true` once quota resets). Groq is enabled with a current model.

### Bugs found & fixed in this round
1. `ckpt is not defined` — typo in the checkpoint activity emit crashed the
   checkpoint block (caught as non-fatal); fixed.
2. Checkpoint dirty-set capture used `git status --porcelain` (shows
   untracked *directories* as `lib/`) and treated the execFile Buffer as a
   string — fixed with `-uall` and `.toString()`.
3. Missing `onActivity` forwarding on the investigation pass (investigation
   events never reached the timeline); fixed.
4. Testing-environment lesson recorded: the server and ad-hoc shell commands
   can observe different sandboxed views of `/tmp`; verification must happen
   within the server's own process context (the `/api/file` endpoint) —
   which is exactly how the false "file not fixed" alarm was resolved.

---

## 14. EVOLUTION ROUND 3 (AGENCY SPECIALISTS) — FINAL DIRECTIVE

Third directive round: AGENT = WHO. Baseline 180/180 → final **195/195**.

| Capability | What was built |
|---|---|
| **Specialist library** (`src/agents.js`) | 12 differentiated built-in specialists across divisions (Team Lead, Research Agent, Software Architect, Frontend Developer, Backend Developer, Debug Engineer, QA Engineer, Security Engineer, Code Reviewer, Browser QA Agent, DevOps Engineer, Technical Writer) — each with its own mission, domain-specific critical rules, workflow, success metrics, verification expectation, and home agent MODE. Inspired by the agency-agents repository (architectural reference only — nothing copied). |
| **User-defined agents** | `<project>/agents/*.md` with frontmatter override built-ins on collision — same extension pattern as Skills. |
| **Auto-selection** | `selectAgents(task)` scores specialists against the task + project map and picks the smallest useful team; code-changing tasks always get QA coverage; security-sensitive tasks get the Security Engineer. Spec §7's own example ("Fix the React login button not working") selects Frontend Developer + Debug Engineer. |
| **Agent → loop integration** | The selected specialist is injected as a labeled ADVISORY system message (AGENT = WHO) alongside skills (HOW); the activity timeline records "Agent selected: …". |
| **Structured handoffs (§39)** | Every specialist emits `{agent, task, findings, files, risks, recommended_next_step, evidence{status, tests, evaluation, checkpoint, provider, model}}`; sequential team runs chain handoffs as system messages — data, not conversation. |
| **Conflict detection (§40)** | Ownership is per FILE (a second writer of the same file is a conflict even with identical role labels); `conflictPolicy` setting: `flag` (default) or `block` (team result FAILED pending review). |
| **Budget manager (§15)** | Task token budget enforced in the agent loop from real provider-reported usage → `BUDGET_EXCEEDED` blocked status; `tokensUsed` in every result. |
| **Rate limits (§36)** | `Retry-After` responses are parsed and respected (bounded retry waits at least the provider's hint, capped 30s); deprecated-model 404s flag the provider (`staleModel`) for the UI. |
| **Model discovery (§37)** | Opt-in 5-minute cache (server API/doctor) with `?refresh=1` force and `cached` flag — repeated reads never hammer providers. |
| **Settings 2.0 (§31)** | Every new setting is READ at runtime: `defaultMode` (server task resolution), `terminalTimeoutMs`/`terminalOutputLimit` (run_command + terminal route), `browserHeadless`/`browserTimeoutMs` (browser adapter `configure()`), `memoryEnabled` (server run wiring), `relevanceThreshold`/`contextBudgetBytes` (context engine via `setDefaults`), `activityVerbosity` (SSE filter), `uiRefreshIntervalMs` (UI refresh), `conflictPolicy` (orchestrator), `reasoningPreference` ('speed' breaks priority ties by measured latency), `retryWaitMs` (bounded retry spacing). |
| **Safety (§30)** | READ_ONLY now permits `run_tests` ("test where safe") while still blocking every mutating tool — verified by tests. |
| **CLI parity (§33)** | New commands: `agents [task]`, `teams --tasks "a;;b" --parallel N`, `checkpoints [restore|compare id]`, `settings [key=value]`, `knowledge`, `browser [url]`, `evaluate --files … [task]`. |
| **UI (§32)** | Agents panel (12 specialists visible), team roles + evaluator verdict badges in the task list, new settings groups (Terminal & Browser, Team & Routing, relevance threshold), LOCAL/OFFLINE chip. |
| **Doctor** | Agents check added (12 specialists, project-defined count). |

### Bugs found & fixed in this round
1. Model cache leaked between tests (cache made opt-in at the API layer).
2. Conflict ownership keyed by role label let same-named agents collide silently — now per-file.
3. `reasoningPreference` body edit landed without the signature param — fixed.
4. Orchestrator conflict early-return referenced later-declared variables — made self-contained.
