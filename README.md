# AI Software Engineering Workstation

A local AI coding agent that behaves like a software engineer, not a chatbot:
project understanding + AI coding + terminal + testing + Git + browser
verification + provider routing + local LLM + memory + autonomous debugging —
in one coherent, **zero-runtime-dependency** Node.js application.

```
Open a project → understand it → accept a task → plan → edit safely
→ show a diff → get approval → run tests → parse failures → fix
→ verify in a browser → report the result honestly
```

---

## Installation

Requires **Node.js 18+** (tested on Node 22).

```bash
npm install   # no-op — the core has zero runtime dependencies
```

**Optional: browser capability (Playwright).** Without it, everything else
works and the Browser panel/tools honestly report "unavailable":

```bash
npm install --no-save playwright
npx playwright install chromium
```

(`--no-save` keeps `package.json` dependency-free; Playwright is an optional
adapter, detected at startup.)

## Starting the app

```bash
npm start
# → http://localhost:3300
```

Data (config, memory, tasks, approvals, test history) is stored under
`~/.coding-agent/` by default. Override with:

```bash
AGENT_DATA_DIR=/path/to/data PORT=4000 npm start
```

## Selecting a project

Click **+ Open Folder** in the sidebar and enter an absolute path, or:

```bash
curl -X POST http://localhost:3300/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"rootPath": "/absolute/path/to/your/project"}'
```

The active project is the sandbox root: every file operation the agent (or
the file editor) performs is confined to it.

## Running an AI coding task

1. Open a project.
2. Pick an **agent mode** (header): `Auto` picks from the task text —
   - **Ask** — read-only investigation and explanation
   - **Code** — implement the requested change, run relevant tests
   - **Debug** — root-cause a failure, minimal fix, verify
   - **Test** — discover/run tests, analyze failures (no code edits)
   - **Review** — correctness/security/quality audit (read-only)
   - **Autonomous** — the full debug loop (investigate → fix → test → verify,
     bounded attempts, engineering report)
3. Pick a **safety mode** (header) — see Security below.
4. Type the task and send. The right panel shows the live activity timeline;
   results appear as cards in the chat.

Modes are enforced server-side: the declared tool surface is filtered per
mode AND non-allowed tools are rejected even if a model insists.

## Provider setup (free-first, legitimate credentials only)

Click **+ Add Provider** — presets for **Groq**, **Google Gemini**, and
**OpenRouter** (all genuine free tiers that require your own free API key —
there is no keyless unlimited LLM API), plus a custom entry for any
OpenAI-compatible endpoint (LM Studio, llama.cpp server, FreeLLMAPI gateway,
etc.).

```bash
curl -X POST http://localhost:3300/api/providers -H 'Content-Type: application/json' -d '{
  "id": "groq-1", "name": "Groq (free tier)", "type": "openai-compatible",
  "baseUrl": "https://api.groq.com/openai/v1", "model": "llama-3.3-70b-versatile",
  "apiKey": "YOUR_FREE_GROQ_KEY", "enabled": true, "priority": 50
}'
```

Fallback: on `429`/`5xx` the router cools an entry down (60s) and tries the
next by priority — bounded, never loops, never bypasses auth/quotas/ToS.
Health, latency, request counts, and token usage (when the provider reports
them) are tracked per provider and shown in the UI.

## Ollama setup (local models, no API key)

```bash
ollama serve                 # start the server (default port 11434)
ollama pull llama3.2         # pull any model
```

Then click **♻ Detect Local (Ollama)** in the UI (or
`POST /api/providers/refresh-local`). When Ollama responds, an
`ollama-local` provider is created, marked **LOCAL**, with its real model
list from `/api/tags` and no API key. When it is offline, the UI says
**OFFLINE** — models are never fabricated. Any llama.cpp-compatible
OpenAI-shaped server can be added as a custom provider the same way.

## How approval / diff works

- Every agent file edit and every HIGH/CRITICAL-risk command can be held as a
  **proposal** with a computed line diff (see safety modes below).
- Pending proposals appear in the **Diff & Approvals** tab and the right
  sidebar: diff preview, risk badge, **Approve / Reject**. Approved file
  changes are applied inside the sandbox (re-checked against the file's
  current content to prevent clobbering) and can be **Reverted** afterwards
  — but only if the file is unchanged since the apply.
- In the CLI, proposals pause the run and ask `Approve? [y/N]` in the
  terminal.
- The agent is paused while a proposal is pending (bounded by a timeout), and
  a rejection is fed back to the model as structured data.

### Safety modes (header dropdown)

| Mode | File edits | Commands / tests | HIGH-risk (npm install, git push…) | CRITICAL (rm -rf, git reset --hard, sudo…) |
|---|---|---|---|---|
| **Read-only** | blocked | blocked | blocked | blocked |
| **Assist** | proposed (diff) | proposed | proposed | proposed |
| **Edit** | applied | proposed | proposed | proposed |
| **Agent** (default) | applied | LOW/MEDIUM run | proposed | proposed |
| **Autonomous** | applied | run | run | proposed |

`git commit` is always a proposal — history is yours. Deleting a running task
via the Tasks panel requests cooperative cancellation; the agent stops
between steps.

## How autonomous debugging works

In **Autonomous** mode (or CLI `--mode autonomous`), the run becomes the full
workflow:

```
UNDERSTAND → INVESTIGATE (read-only pass: observations, root-cause
hypothesis, fix plan)
→ [FIX (focused edit) → TEST (real run, parsed results) → ANALYZE] × ≤3
→ browser verification when a URL is provided (and Playwright is installed)
→ engineering report: PASS / PARTIAL / FAILED / BLOCKED with root cause,
  files changed, test evidence, and remaining issues
```

Bounded attempts, cancellation at every phase boundary, and honest statuses —
it reports PARTIAL when the failure count improved, FAILED when attempts are
exhausted, BLOCKED when the provider is unreachable.

## How testing works

The **Test Center** tab detects the framework (`node:test`, Jest, Vitest,
Mocha, pytest, go test — or honestly "unknown"), lists test files, and runs
the suite or a targeted file. Results are parsed into structured totals and
per-test failures with messages, kept in bounded history, and failures are
associated with changed files by evidence. The agent gets the same parsed
results through the `run_tests` tool — never raw log dumps.

## How Git integration works

The **Git** tab (and `git_status` / `git_diff` / `git_log` tools) show branch,
staged/unstaged/untracked changes, the unified diff, and recent commits.
Destructive Git operations (`reset --hard`, `clean -fd`, `push --force`,
`checkout -- .`, rebase…) classify as **CRITICAL** and are always held for
explicit approval — in every safety mode, including Autonomous. Commits go
through the approval system as command proposals.

## Security protections

- **Filesystem sandbox** (`src/security.js`): relative traversal, absolute
  paths, and symlink escapes outside the project root are blocked on every
  file operation, including file-save and screenshot paths.
- **API keys**: stored only in `<dataDir>/config.json`, masked in every API
  response, never logged, never stored in memory, never returned by error
  messages. The memory store rejects secret-like keys at write time.
- **Risk classification** for every tool call and shell command
  (LOW/MEDIUM/HIGH/CRITICAL) with the approval matrix above.
- **Bounded execution**: command and model-request timeouts, capped test
  runs, capped search results, bounded task/approval/memory/history stores.
- **HTTP hardening**: 2 MB request-body limit (413), malformed JSON → 400,
  structured 404s, `X-Content-Type-Options: nosniff`, `no-store`, static
  traversal blocked, one agent task at a time (409 otherwise).
- **Graceful shutdown** frees the browser session; uncaught errors are logged
  without leaking secrets.

## The workstation UI

- **Chat** — tasks, modes, quick actions, result cards
- **Files** — sandboxed explorer tree + viewer/editor (Save respects the
  safety mode; in Assist it becomes a proposal)
- **Diff & Approvals** — pending proposals with diffs, approve/reject,
  history with revert
- **Tests** — detection, run, structured results, history
- **Git** — status, diff, log
- **Browser** — capability status; one-click verification (open URL, collect
  console/page/network errors, screenshot) when Playwright is installed
- **Terminal** — commands in the project root, risk-gated like the agent
- **Providers** — status, latency, usage, local/free badges, connection test,
  Ollama detection
- **Tasks** — lifecycle (running / waiting approval / testing / debugging /
  completed / partial / failed / blocked / cancelled) with cancel + retry
- **Memory** — bounded persistent memory (global/project/task/agent/session),
  working-profile recall of past tasks (keyword overlap — honestly *not*
  vector search), secret-key rejection

## CLI

```
node cli.js run "<task>" [--project <path>] [--mode ask|code|debug|test|review|autonomous|auto]
node cli.js analyze [--project <path>]     # project intelligence report
node cli.js providers                      # configured providers + health
node cli.js models <providerId>            # model discovery (Ollama / OpenAI-compatible)
node cli.js tasks                          # recent task history
node cli.js tests [--target <file>]        # detect + run tests, parsed results
node cli.js git                            # status + recent commits
node cli.js modes                          # agent/safety modes
node cli.js tools                          # registered tools
node cli.js doctor                         # system diagnostics (Node, git, providers, Ollama, Playwright, tests)
```

The CLI uses the exact same services as the server — one engine, not two.

## Testing

```bash
npm test          # full suite: node --test
```

153 tests covering: tool registry/executor sync, security (traversal,
absolute path, symlink escape), provider routing/fallback/cooldown/usage,
model discovery, Ollama detection, project intelligence, agent modes and
tool-surface enforcement, diff engine, risk classification, the approval
store (apply/reject/revert/clobber-guard), the safety gate in every mode,
test intelligence (parsing for node:test/Jest/pytest/go + real runs), git
tools (real temp repos), the autonomous debug loop (real bug, real tests,
bounded attempts, cancellation, BLOCKED reporting), task lifecycle and
cancellation, memory bounds, hardening (413/400/404/traversal/409), the CLI
end-to-end, and a **real-browser UI click-through** when Playwright is
installed (self-skips honestly otherwise).

## Architecture

```
UI (public/)  ──  API (server.js)  ──  Services  ──  Agent engine
                                        │                │
                     project-intel · test-intel · git      agent-loop (+ modes, safety gate)
                     approvals · diff · risk               tools (src/agent-tools.js — single registry)
                     memory · tasks · config               providers (adapter router: cloud + local)
```

Concepts adapted from LiteLLM (provider routing/fallback), Ollama (local
models), OpenHands/SWE-agent (debug loop), Aider (focused edits, repo
awareness), Cline/Roo (modes + approvals), Playwright (browser layer),
Repomix (focused context) — implemented natively, zero-dependency, with no
copied frameworks.

## Known limitations

- No live cloud provider call is made in the test suite (no real keys in
  tests); the HTTP path is covered by the scripted-provider integration runs.
  Test with your own key before trusting it for real work.
- Working-profile memory is keyword overlap, not embeddings.
- Browser verification requires the optional Playwright install; everything
  else degrades gracefully without it.
- The debug loop's browser verification step must be explicitly enabled via
  `browserUrl`; the agent can also drive the browser tools directly.
