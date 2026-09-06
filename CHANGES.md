# Changes

## 2.0.0 — AI Software Engineering Workstation (production build)

Evolved from the 1.x single-loop agent into a full workstation. Every phase
was implemented incrementally with the full test suite run before and after
(baseline 36/36 → final 153/153). No existing test was deleted or weakened;
the 1.x behavior is preserved (a task with no mode and no approvals behaves
exactly as before).

### Provider Manager 2.0
- **`src/providers.js`** — adapter layer (`openai-compatible`, `ollama`),
  model discovery (`/api/tags` for Ollama, `/models` for the rest), per-entry
  health + usage tracking (requests, failures, fallbacks, latency, tokens
  when reported), `snapshot()` for the UI, late-binding entries (cooldowns
  survive across requests while the provider list stays editable),
  `detectOllama()` with honest offline reporting.
- **`src/config.js`** — additive provider normalization (`type`, `local`,
  `capabilities` — unknown stays null, never invented), `safetyMode`
  setting, `ensureOllamaProvider()` (enabled only when actually reachable).

### Project Intelligence
- **`src/project-intel.js` (new)** — project scanner (languages, frameworks,
  package manager, entry points, tests, config, docs, git), cached project
  map with change-signature invalidation, relevance scoring for tasks, and a
  size-bounded context builder. New tools: `get_project_map`,
  `find_relevant_files`, `get_project_context`.

### Agent Modes
- **`src/modes.js` (new)** — ask / code / debug / test / review / autonomous
  (+ `auto` resolution from task text). Modes change the declared tool
  surface, append real instructions to the system prompt, and are enforced
  server-side (non-allowed tools are rejected before execution even if the
  model insists).

### Diff / Approval / Safety
- **`src/diff.js` (new)** — zero-dependency LCS line diff, stats, unified
  patch output, bounded for huge files.
- **`src/risk.js` (new)** — LOW/MEDIUM/HIGH/CRITICAL classification for tools
  and shell commands (destructive git, rm -rf, sudo, package installs,
  database drops, piped remote scripts…).
- **`src/approvals.js` (new)** — persistent proposal store: file diffs and
  command proposals, approve/reject/apply/revert, clobber guard ("file
  changed since proposal"), sandboxed application, bounded history,
  `waitForDecision` so the agent pauses for a bounded time.
- **`src/agent-loop.js`** — safety gate: per-safety-mode matrix (readonly →
  assist → edit → agent → autonomous), CRITICAL always gated, `git commit`
  always proposed, cooperative cancellation via `shouldCancel`.

### Test Intelligence
- **`src/test-intel.js` (new)** — framework/test detection, real runs
  (full suite or targeted file), output parsing for node:test TAP, Jest,
  pytest, go test (honest `generic` fallback), failure↔change association,
  bounded run history. New tools: `run_tests`, `detect_tests`.

### Git Intelligence
- **`src/git.js` (new)** — repo detection, status parsing, diff, log, change
  summary via the native git CLI. New tools: `git_status`, `git_diff`,
  `git_log`, plus `git_commit` which can ONLY create an approval proposal.

### Browser (optional)
- **`src/browser.js` (new)** — Playwright adapter: availability detection,
  shared headless session, navigate/click/type/select/content/screenshot,
  console + pageerror + failed-request capture, hard timeouts, idle close.
  Browser tools are registered ONLY when Playwright resolves — the UI and
  model never see phantom browser capability.

### Autonomous Debug Loop
- **`src/debug-loop.js` (new)** — investigate (read-only agent pass) →
  [fix → test → analyze] × bounded attempts → optional browser verification
  → engineering report (PASS/PARTIAL/FAILED/BLOCKED with root cause, files,
  test evidence, remaining issues). Wired to Autonomous mode on the server.

### Task Center + Memory
- **`src/tasks.js`** — real lifecycle (queued/running/waiting_approval/
  testing/debugging/completed/partial/failed/blocked/cancelled), mode +
  provider/model tracking, attempts, errors, cooperative cancel, safe retry,
  bounded history.
- **`src/memory.js`** — bounded per-category storage with oldest-first
  eviction and optional project scoping; secret-key rejection retained.

### UI (public/)
- Full workstation: tabbed panels (Chat, Files, Diff & Approvals, Tests, Git,
  Browser, Terminal), file explorer + editor, activity timeline with
  timestamps, approval cards with diffs, provider health/latency/local-free
  badges, task lifecycle with cancel/retry, mode + safety selectors, browser
  verification with screenshot, risk-gated terminal. Split into `app.js`
  (shell) + `panels.js` (views) — all business logic stays server-side.

### Server
- New endpoints: project map/context, tests detect/run/history, git
  status/diff/log, approvals (list/decide/revert), file explorer/editor
  (sandboxed), terminal (risk-gated), browser status/verify, modes, tools,
  provider refresh-local + model discovery, task detail/cancel/retry,
  safety-mode setting.
- Hardening: 2 MB body limit (413), malformed JSON → 400, structured JSON
  404s for unknown API paths, static traversal blocked, `nosniff`/`no-store`
  headers, single-agent-run lock (409), provider-test timeout, graceful
  shutdown (frees the browser), uncaught error handlers.

### CLI
- `run` (with `--mode`, interactive approval prompts, autonomous debug loop),
  `analyze`, `providers`, `models`, `tasks`, `tests`, `git`, `modes`, `tools`,
  `doctor` — all sharing the server's services.

### Tests
36 → **153** tests. New suites: providers, project-intel, modes, approvals,
test-intel, git, browser (+ live), debug-loop, task-center, ui-backend,
ui-live (real Playwright click-through of the whole UI), cli, hardening.

## 1.1.0 / 1.0.0
See git-less history in this file's earlier entries: zero-dependency base
build (tool registry, sandbox, provider router, memory, tasks, UI, CLI) and
the working-profile memory + free-tier presets + provider UI release.

## 2.1.0 — Evolution round: skills, key pool, model router, checkpoints, knowledge, evaluator, multi-agent

Final directive implementation on top of 2.0 (baseline 153/153 → 180/180):

- **Settings Center** (`src/settings.js`) — validated persisted settings
  (model strategy, offline mode, team limits, autonomy/verification toggles,
  budgets), Settings tab in the UI, `POST /api/settings/update`.
- **Skills Engine** (`src/skills.js`) — `skill.md` scanning (project +
  global), honest keyword matching, advisory-only injection into agent runs;
  `/api/skills`, UI Skills panel, CLI `skills`. This repo ships two skills.
- **Provider key pool** (`src/providers.js`) — `keys: []` per provider
  expands to per-key candidates with independent cooldowns; masked in config
  output.
- **Smart Model Router** (`src/model-router.js`) — strategy ordering hook on
  the router (LOCAL_FIRST / FREE_CLOUD_FIRST / BEST_AVAILABLE /
  CHEAPEST_AVAILABLE / MANUAL), offline-mode refusal with a specific error.
- **Plan mode** (`src/modes.js`) — read-only mode producing a structured
  inspectable plan.
- **Checkpoints** (`src/checkpoints.js`) — bounded snapshots
  (create/list/compare/restore) with creation-undo and clobber-safe restore;
  automatic before autonomous runs (setting-gated), checkpoint id in reports.
- **Failure Knowledge Base** (`src/knowledge.js`) — bounded project-scoped
  debugging episodes recalled into investigations ("do NOT repeat failed
  fixes"); `/api/knowledge`.
- **AI Quality Evaluator** (`src/evaluator.js`) — evidence-based
  VERIFIED/PARTIAL/FAILED/BLOCKED verdicts (files on disk + re-run tests +
  blockers); wired into autonomous runs.
- **Multi-Agent Orchestrator** (`src/orchestrator.js`) — bounded teams
  (maxAgents/maxParallel from Settings), roles, parent/child tasks, conflict
  detection, integration tests, optional reviewer; `POST /api/team/run`.
- **Plugin SDK** (`src/plugins.js`) — validated runtime tool registration
  keeping the registry invariant; MCP adapter integration point (honestly
  declared as preparation, not a protocol implementation).
- **Sandbox adapter** (`src/sandbox.js`) — honest Docker detection +
  optional in-container execution.
- **Doctor 2.0** (`src/doctor.js`) — 12 shared checks via `GET /api/doctor`
  and CLI `doctor`; **CLI `skills`** command.
- Bug fixes: checkpoint capture (`-uall` + Buffer.toString), checkpoint emit
  typo, investigation `onActivity` forwarding; router gained a bounded
  spaced-retry policy for transient 429/5xx (Settings `maxProviderRetries`).

## 2.2.0 — Agency specialists: AGENT = WHO

- **`src/agents.js` (new)** — 12 differentiated built-in specialists (mission,
  critical rules, workflow, success metrics, verification, home mode),
  user-defined `agents/*.md` override layer, smallest-useful-team auto-
  selection, structured handoffs (`buildHandoff`/`handoffToAdvisory`).
  Inspired by the agency-agents repository (architectural reference only).
- **Agent loop** — specialist advisory injection + activity event; task token
  budget enforcement (`BUDGET_EXCEEDED`); `tokensUsed` in results; READ_ONLY
  safety mode now permits `run_tests` (spec: "test where safe").
- **Orchestrator** — per-file ownership conflict detection with
  `conflictPolicy` flag/block; sequential handoff chaining; agent-definition
  roles and modes; handoff records on every team member.
- **Providers** — `Retry-After` parsing honored by bounded retries;
  stale/deprecated-model 404 flagging; opt-in model-discovery cache
  (5-minute TTL, `refresh=1` force, `cached` flag in the API).
- **Model router** — `reasoningPreference` setting ('speed' tiebreaks by
  measured latency).
- **Settings Center 2.0** — terminal timeout/output limit, browser
  headless/timeout, memory toggle, relevance threshold, activity verbosity,
  UI refresh interval, conflict policy, retry wait — ALL read at runtime
  (server boot + `POST /api/settings/update` re-apply module defaults).
- **Doctor** — Agents check. **CLI** — `agents`, `teams`, `checkpoints`,
  `settings`, `knowledge`, `browser`, `evaluate`. **UI** — Agents panel,
  evaluator verdict badges, new settings fields.
- Tests 180 → **195** (`test/agency.test.js`, 15 new).
