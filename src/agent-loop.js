'use strict';
/**
 * agent-loop.js
 *
 * The single agent loop. Both cli.js and server.js call runAgentTask() so
 * there is exactly one implementation of tool-calling, iterative execution,
 * and error recovery — not two competing agent architectures.
 *
 * Emits coarse activity events (workflow state + short summaries) via
 * onActivity(), never raw model reasoning/chain-of-thought.
 */

const { PROVIDER_TOOL_SCHEMAS, toolSchemasFor, executeTool, TOOL_NAMES } = require('./agent-tools');
const { recallProfiles, profilesToSystemMessage, recordProfile } = require('./profiles');
const { resolveMode, getMode } = require('./modes');
const { classifyToolRisk } = require('./risk');
const { skillsToSystemMessage } = require('./skills');
const { agentToSystemMessage } = require('./agents');
const { classifyIntent } = require('./intent');
const activity = require('./activity');

const MAX_ITERATIONS = 12;
const MAX_TOOL_CONTRACT_RETRIES = 2; // corrective retries per step, not counted against MAX_ITERATIONS

const WORKFLOW_STATES = [
  'UNDERSTAND', 'INSPECT', 'PLAN', 'APPROVAL', 'IMPLEMENT', 'RUN', 'TEST', 'VERIFY', 'FIX', 'COMPLETE',
];

const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'run_command', 'git_commit', 'git_add']); // run_tests is read-only-safe (spec 00a730)

/**
 * @param {object} opts
 * @param {string} opts.task - natural-language task description
 * @param {string} opts.projectRoot - absolute path, the sandbox root
 * @param {ProviderRouter} opts.router
 * @param {Array} [opts.history] - prior conversation messages
 * @param {function} [opts.onActivity] - (event) => void, event = {state, message}
 * @param {function} [opts.callFn] - injectable provider call function (for tests/mocking)
 * @param {object} [opts.memory] - optional MemoryStore; enables working-profile recall/record
 * @param {string} [opts.mode] - agent mode ('ask'|'code'|'debug'|'test'|'review'|'autonomous'|'auto');
 *   constrains the declared tool surface AND enforces it server-side. Default 'autonomous'.
 * @param {string} [opts.safetyMode] - global safety mode ('readonly'|'assist'|'edit'|'agent'|'autonomous').
 *   Caps what ANY agent mode may do. Default 'agent'.
 * @param {object} [opts.approvals] - ApprovalStore; required for proposal flows in assist mode
 *   and for HIGH/CRITICAL-risk actions in agent mode.
 * @param {string} [opts.taskId] - links proposals to the task center.
 * @param {function} [opts.shouldCancel] - polled between steps; when true the
 *   run stops cooperatively with status 'cancelled'.
 * @param {Array} [opts.skills] - matched skill objects ({name, instructions})
 *   from the skills engine; injected as ADVISORY system context. Safety rules
 *   always win over skill text.
 */
async function runAgentTask({ task, projectRoot, router, history = [], onActivity = () => {}, callFn, memory, mode: requestedMode, safetyMode = 'agent', approvals, taskId, shouldCancel, skills, advisories, retryPolicy, agent, tokenBudget, ctxExtras, maxPayloadChars, intent }) {
  const modeKey = resolveMode(requestedMode, task);
  const mode = getMode(modeKey);
  // Effective tool surface = mode tools ∩ registered tools ∩ safety-allowed tools.
  const allowedTools = new Set(mode.allowedTools.filter((t) => TOOL_NAMES.includes(t)));
  if (safetyMode === 'readonly') {
    for (const t of MUTATING_TOOLS) allowedTools.delete(t);
  }
  // Intent routing (PART A): 'chat' sends NO tool schemas — no forced
  // tool-calling, no structured-output parsing, minimal tokens.
  let effectiveIntent = intent || null;
  if (!effectiveIntent && (modeKey === 'ask' || modeKey === 'review')) {
    effectiveIntent = classifyIntent(task).intent === 'task' ? 'tool-chat' : classifyIntent(task).intent;
  }
  const noTools = effectiveIntent === 'chat';
  let toolSchemas = noTools ? [] : (allowedTools.size === TOOL_NAMES.length ? PROVIDER_TOOL_SCHEMAS : toolSchemasFor([...allowedTools]));

  const ctx = { projectRoot, mode: modeKey, safetyMode, approvals, taskId, ...(ctxExtras || {}) };
  // Chat intent: a DIFFERENT system prompt — no tool language at all, so
  // tool-primed models don't hallucinate tool calls without schemas.
  const systemContent = noTools
    ? 'You are a knowledgeable software engineering assistant. Answer in PLAIN TEXT. ' +
      'Do not attempt to call tools or emit JSON tool-call structures. ' +
      'If the answer needs project details you do not have, say exactly what is missing. ' +
      mode.instructions
    : 'You are a local coding agent. You may only call tools from the provided tool list. ' +
      `Available tools: ${Array.from(allowedTools).join(', ')}. Never invent a tool name. ` +
      'Work iteratively: inspect before editing, run tests after changing code, and stop when the task is verifiably complete. ' +
      mode.instructions;
  const messages = [{ role: 'system', content: systemContent }];

  emit(onActivity, 'UNDERSTAND', `Mode: ${mode.label} — ${mode.description}`);

  if (memory) {
    const recalled = recallProfiles(memory, task);
    const profileMsg = profilesToSystemMessage(recalled);
    if (profileMsg) {
      messages.push(profileMsg);
      emit(onActivity, 'PLAN', `Recalled ${recalled.length} similar past task(s) from local working-profile memory`);
    }
  }

  // Agent = WHO: inject the selected specialist's role guidance.
  const agentMsg = agentToSystemMessage(agent);
  if (agentMsg) {
    messages.push(agentMsg);
    emit(onActivity, 'PLAN', `Agent selected: ${agent.label} (${agent.division}, mode ${modeKey})`);
  }

  // Skills engine: inject ONLY task-relevant skills as advisory context.
  const skillMsg = skillsToSystemMessage(skills);
  if (skillMsg) {
    messages.push(skillMsg);
    emit(onActivity, 'PLAN', `Loaded ${skills.length} relevant project skill(s): ${skills.map((s) => s.name).join(', ')}`);
  }

  // Additional advisory context (knowledge base, orchestrator briefings…).
  for (const adv of advisories || []) {
    if (adv && adv.role === 'system' && typeof adv.content === 'string') {
      messages.push(adv);
      emit(onActivity, 'PLAN', adv.label || 'Loaded advisory context');
    }
  }

  messages.push(...history, { role: 'user', content: task });

  const filesChanged = new Set();
  let tokensUsed = 0;
  let payloadCap = maxPayloadChars || 0;
  let compactedOnce = false;
  let parseRecoveryUsed = 0;
  let toolsDroppedForParseRecovery = false;
  const testsRun = [];
  const toolLog = [];
  let lastProvider = null;
  let lastModel = null;

  // Closure over task/memory/lastProvider so every return path records a
  // working profile the same way, without duplicating the call at each
  // return site below.
  function finish({ status, summary, filesChanged, testsRun, toolLog }) {
    const result = {
      status,
      summary,
      mode: modeKey,
      provider: lastProvider,
      model: lastModel,
      filesChanged: Array.from(filesChanged),
      testsRun,
      toolCallCount: toolLog.length,
      toolLog,
      tokensUsed,
    };
    if (memory) {
      try {
        recordProfile(memory, {
          task,
          status,
          summary,
          filesChanged: result.filesChanged,
          provider: lastProvider,
          model: lastModel,
        });
      } catch {
        // Memory recording is best-effort — never fail the task over it.
      }
    }
    return result;
  }

  emit(onActivity, 'UNDERSTAND', `Task received: ${task}`);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (shouldCancel && shouldCancel()) {
      emit(onActivity, 'FIX', 'Cancelled by user');
      return finish({ status: 'cancelled', summary: 'Task cancelled by user.', filesChanged, testsRun, toolLog });
    }
    let routed;
    let contractRetries = 0;
    const providerStart = Date.now();
    let lastCandidate = null;
    // Inner retry loop: ONLY for tool-contract violations (model hallucinated an
    // undeclared tool name and the provider rejected the turn before we got a
    // usable tool_call back). Switching providers won't fix this — it's a model
    // behavior issue — so instead we nudge the model with a corrective reminder
    // and retry the same step, bounded, before giving up gracefully.
    for (;;) {
      try {
        emitActivityEvent(onActivity, activity.makeEvent({ taskId, agent: agent ? agent.label : null, startedAt: providerStart, state: 'provider_request', label: '◉ Contacting provider…', detail: 'provider request' }));
        routed = await router.chat({
          messages: compactMessages(messages, payloadCap),
          tools: toolSchemas,
          orderContext: { mode: modeKey, task },
          retryPolicy,
          onRetry: (provider, hint) => {
            emitActivityEvent(onActivity, activity.makeEvent({ taskId, agent: agent ? agent.label : null, provider, startedAt: providerStart, ...activity.activityForProviderRetry(provider, hint) }));
          },
        }, callFn);
      } catch (e) {
        emit(onActivity, 'FIX', `Provider call threw unexpectedly: ${e.message}`);
        return finish({ status: 'error', summary: `Provider error: ${e.message}`, filesChanged, testsRun, toolLog });
      }

      // PART A recovery: output_parse_failed — the provider could not parse
      // the generation. Bounded recovery: first retry WITHOUT tool schemas
      // (plain chat), then a corrective reminder. Never unbounded, never
      // collapsed into all_providers_failed without attempting recovery.
      if (!routed.ok && routed.outputParseFailed && parseRecoveryUsed < 2) {
        parseRecoveryUsed++;
        if (!toolsDroppedForParseRecovery && !noTools) {
          toolsDroppedForParseRecovery = true;
          toolSchemas = [];
          emit(onActivity, 'FIX', 'Provider could not parse the tool-call output — retrying as plain chat without tool schemas');
        } else {
          emit(onActivity, 'FIX', 'Provider parse failure again — retrying with an explicit plain-text instruction');
          messages.push({
            role: 'system',
            content: 'Your previous response could not be parsed by the provider. Reply in PLAIN TEXT only: no tool calls, no JSON, no special formatting.',
          });
        }
        continue;
      }
      if (!routed.ok && routed.isToolContractViolation && contractRetries < MAX_TOOL_CONTRACT_RETRIES) {
        contractRetries++;
        emit(onActivity, 'FIX', `Model attempted a tool that doesn't exist here — sending a correction and retrying (attempt ${contractRetries})`);
        messages.push({
          role: 'system',
          content: `Reminder: your last response tried to call a tool that is not declared in this request. The ONLY tools available right now are: ${Array.from(allowedTools).join(', ')}. Do not invent tool names or reuse names from other agent frameworks. Try again using only these tools, or reply in plain text if none of them fit.`,
        });
        continue;
      }
      break;
    }

    if (routed.ok) {
      lastProvider = routed.provider || lastProvider;
      lastModel = routed.model || lastModel;
      // Real fallback transitions only — from the router's own fallbackLog.
      const fb = routed.fallbackLog || [];
      for (let fi = 0; fi < fb.length; fi++) {
        const to = fi === fb.length - 1 ? routed.provider : fb[fi + 1].provider;
        if (to) {
          emitActivityEvent(onActivity, activity.makeEvent({
            taskId, agent: agent ? agent.label : null,
            provider: to, startedAt: providerStart,
            ...activity.activityForFallback(fb[fi].provider, to),
          }));
        }
      }
      emitActivityEvent(onActivity, activity.makeEvent({
        taskId, agent: agent ? agent.label : null, provider: routed.provider, model: routed.model,
        startedAt: providerStart,
        state: 'thinking', label: `🧠 Working with ${routed.provider}${routed.model ? ' · ' + routed.model : ''}`, detail: 'provider request completed',
      }));
    }

    if (routed.fallbackLog && routed.fallbackLog.length > 0) {
      for (const f of routed.fallbackLog) {
        if (!f.isToolContractViolation) {
          emit(onActivity, 'FIX', `Provider "${f.provider}" unavailable (${f.status || f.error}); trying next configured provider`);
        }
      }
    }

    if (!routed.ok) {
      if (routed.isToolContractViolation) {
        // Retry budget exhausted — this model keeps hallucinating tool names.
        // Fail this run gracefully with a plain-language explanation instead
        // of an opaque "all providers failed" message (it isn't a provider
        // outage, and switching providers/keys would not have helped).
        const summary =
          `The model repeatedly tried to call tools that don't exist in this app ` +
          `(it may be trained on a different agent framework's tool names). ` +
          `Available tools are: ${Array.from(allowedTools).join(', ')}. Try a different model, or rephrase the task more concretely.`;
        emit(onActivity, 'FIX', summary);
        return finish({ status: 'error', summary, filesChanged, testsRun, toolLog });
      }
      if (routed.lastErrorRequestTooLarge) {
        // Bounded recovery: compact the payload hard and retry the step ONCE.
        if (!compactedOnce) {
          compactedOnce = true;
          payloadCap = Math.max(4000, Math.floor((payloadCap || 60000) / 3));
          emit(onActivity, 'FIX', `Request too large for the provider — compacting context to ~${payloadCap} chars and retrying this step once`);
          continue;
        }
        const advice =
          `The request was still too large after compaction` +
          (routed.lastErrorSizeLimit ? ` (limit ${routed.lastErrorSizeLimit} tokens, requested ${routed.lastErrorSizeRequested || 'more'})` : '') +
          `. Try a shorter task, or use a provider/model with a larger quota.`;
        emit(onActivity, 'FIX', `Request too large for the provider — ${advice}`);
        return finish({ status: 'blocked', summary: `BLOCKED: request too large for the provider. ${advice}`, filesChanged, testsRun, toolLog });
      }
      if (routed.outputParseFailed) {
        // Recovery exhausted: name the real failure and the next action —
        // never the misleading "all_providers_failed".
        const advice =
          'The provider could not parse the model output (output_parse_failed) even after retrying ' +
          'without tool schemas and with plain-text instructions. Try a different provider/model, or rephrase the task.';
        emit(onActivity, 'FIX', advice);
        return finish({ status: 'error', summary: `ERROR: ${advice}`, filesChanged, testsRun, toolLog });
      }
      // Rate-limit honesty: name the quota type and the provider's own wait hint.
      const rl = (routed.fallbackLog || []).find((f) => f.quotaExhausted || f.retryAfterHint);
      if (rl) {
        const advice =
          `RATE_LIMITED: provider "${rl.provider}" ${rl.quotaExhausted ? 'daily/total quota is exhausted' : 'is rate-limited'}` +
          (rl.retryAfterHint ? ` — provider says retry after ${rl.retryAfterHint}` : '') +
          '. Try another provider/model (Settings → AI), enable a local Ollama model, or wait.';
        emit(onActivity, 'FIX', advice);
        return finish({ status: 'blocked', summary: `BLOCKED: ${advice}`, filesChanged, testsRun, toolLog });
      }
      emit(onActivity, 'FIX', `No provider could serve the request: ${routed.error}${routed.lastError ? ` (last error: ${String(routed.lastError).slice(0, 200)})` : ''}`);
      return finish({ status: 'error', summary: `All configured providers failed: ${routed.error}${routed.lastError ? ` — last error: ${String(routed.lastError).slice(0, 300)}` : ''}`, filesChanged, testsRun, toolLog });
    }

    const choice = routed.response && routed.response.choices && routed.response.choices[0];
    const message = choice && choice.message ? choice.message : { content: '' };
    const toolCalls = message.tool_calls || [];

    // Budget manager: track token usage when the provider reports it and stop
    // honestly at the configured task budget — never silent continuation.
    if (routed.response && routed.response.usage) {
      tokensUsed += (Number(routed.response.usage.prompt_tokens) || 0) + (Number(routed.response.usage.completion_tokens) || 0);
    }
    if (tokenBudget && tokensUsed > tokenBudget) {
      emit(onActivity, 'FIX', `BUDGET_EXCEEDED: task token budget ${tokenBudget} reached (used ~${tokensUsed})`);
      return finish({ status: 'blocked', summary: `BUDGET_EXCEEDED: task token budget ${tokenBudget} reached (used ~${tokensUsed}). Raise it in Settings → Autonomy or continue with a smaller task.`, filesChanged, testsRun, toolLog });
    }

    if (toolCalls.length === 0) {
      // Model is done — no more tools to call.
      messages.push(message);
      emit(onActivity, 'COMPLETE', 'Task completed');
      return finish({
        status: 'completed',
        summary: message.content || '(no summary provided)',
        filesChanged,
        testsRun,
        toolLog,
      });
    }

    messages.push(message);

    for (const call of toolCalls) {
      if (shouldCancel && shouldCancel()) {
        emit(onActivity, 'FIX', 'Cancelled by user');
        return finish({ status: 'cancelled', summary: 'Task cancelled by user.', filesChanged, testsRun, toolLog });
      }
      const name = call.function ? call.function.name : call.name;
      const rawArgs = call.function ? call.function.arguments : call.arguments;

      // Tool activity (PART C): canonical state from the real tool + args.
      const toolArgs = parseToolArgs(rawArgs) || {};
      const toolActivity = activity.activityForTool(name, toolArgs);
      if (toolActivity) {
        emitActivityEvent(onActivity, activity.makeEvent({ taskId, agent: agent ? agent.label : null, tool: name, ...toolActivity }));
      } else {
        emit(onActivity, phaseFor(name), `Calling ${name}`);
      }

      // Server-side mode enforcement: the tool surface declared to the model is
      // already filtered, but never trust the model — reject anything outside
      // the mode's allowed set before execution.
      let result;
      if (!allowedTools.has(name)) {
        result = { ok: false, error: 'tool_not_allowed_in_mode', message: `Tool "${name}" is not available in ${mode.label} mode. Allowed: ${Array.from(allowedTools).join(', ')}` };
      } else {
        result = await gateAndExecute(name, rawArgs, ctx, { onActivity, filesChanged });
      }
      toolLog.push({ name, args: rawArgs, ok: result.ok });

      if (result.ok) {
        if (name === 'write_file' || name === 'edit_file') filesChanged.add(safePathFromArgs(rawArgs));
        if ((name === 'run_command' && /test/i.test(safeCommandFromArgs(rawArgs))) || name === 'run_tests') {
          testsRun.push(result.result);
        }
        emit(onActivity, phaseFor(name), summarizeToolResult(name, result.result));
      } else {
        emit(onActivity, 'FIX', `Tool "${name}" failed: ${result.message}`);
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id || undefined,
        name,
        content: boundedToolResult(name, result, ctx),
      });
    }
  }

  emit(onActivity, 'FIX', 'Reached iteration limit without a final answer');
  return finish({
    status: 'incomplete',
    summary: 'Reached the maximum number of tool-calling iterations without completing the task.',
    filesChanged,
    testsRun,
    toolLog,
  });
}

function phaseFor(toolName) {
  if (toolName === 'list_files' || toolName === 'read_file' || toolName === 'search_project' || toolName === 'get_project_map' || toolName === 'find_relevant_files' || toolName === 'get_project_context') return 'INSPECT';
  if (toolName === 'write_file' || toolName === 'edit_file') return 'IMPLEMENT';
  if (toolName === 'run_command' || toolName === 'run_tests' || toolName === 'detect_tests') return 'RUN';
  return 'PLAN';
}

function summarizeToolResult(name, result) {
  switch (name) {
    case 'list_files':
      return `Inspected ${result.path} (${result.entries ? result.entries.length : 0} entries)`;
    case 'read_file':
      return `Read ${result.path}`;
    case 'search_project':
      return `Searched project for "${result.query}" — ${result.matches.length} matches`;
    case 'write_file':
      return `Wrote ${result.path} (${result.bytesWritten} bytes)`;
    case 'edit_file':
      return `Edited ${result.path}`;
    case 'run_command':
      return `Ran "${result.command}" (exit ${result.exitCode ?? 'timeout'}, ${result.durationMs}ms)`;
    case 'run_tests': {
      const t = result.totals || {};
      return `Tests ${result.command}: ${t.passed ?? '?'} passed, ${t.failed ?? '?'} failed${result.ok ? '' : ' — FAILURES'}`;
    }
    case 'detect_tests':
      return `Detected tests: framework ${result.framework || 'unknown'}, ${result.testFiles.length} test file(s)`;
    case 'get_project_map':
      return `Analyzed project: ${result.projectType || 'unknown type'}, primary language ${result.primaryLanguage || 'unknown'}${result.cached ? ' (cached)' : ''}`;
    case 'find_relevant_files':
      return `Found ${result.matches.length} relevant file(s) for the task`;
    case 'get_project_context':
      return `Built context: ${result.files.length} relevant file(s), ${result.budgetBytesUsed} bytes`;
    default:
      return `${name} completed`;
  }
}

function safePathFromArgs(rawArgs) {
  try {
    const a = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
    return a && a.path ? a.path : 'unknown';
  } catch {
    return 'unknown';
  }
}

function safeCommandFromArgs(rawArgs) {
  try {
    const a = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
    return a && a.command ? a.command : '';
  } catch {
    return '';
  }
}

function emit(onActivity, state, message) {
  onActivity({ state, message, ts: new Date().toISOString() });
}

/** Canonical activity event: full structured payload on the same SSE pipe. */
function emitActivityEvent(onActivity, event) {
  onActivity({ ...event, type: 'activity' });
}

// --- context budget (request-size control) -----------------------------------

const TOOL_RESULT_DEFAULT_LIMIT = 4000;

/**
 * Bound a tool result BEFORE it enters the conversation. The model saw the
 * full result in the turn it was produced; keeping unbounded blobs (a
 * read_file can return 512KB) in every subsequent request causes
 * "Request too large" (HTTP 413) failures on small-TPM providers. The tail
 * is preserved rather than the head — errors and summaries usually live at
 * the end of command output.
 */
function boundedToolResult(name, result, ctx) {
  const limit = Math.max(
    500,
    Math.min(Number(ctx && ctx.toolResultCharLimit) || TOOL_RESULT_DEFAULT_LIMIT, 200_000)
  );
  const payload = JSON.stringify(result.ok ? result.result : { error: result.error, message: result.message });
  if (payload.length <= limit) return payload;
  const omitted = payload.length - limit;
  return (
    payload.slice(payload.length - limit) +
    `\n… [${name}: truncated ${omitted} chars of older content to keep the request within the provider's size limit — re-read a narrower range if you need older content]`
  );
}

/**
 * Compact the conversation so a single request stays under the provider's
 * per-request size cap. Strategy (never silently lose the essentials):
 *   - system messages are ALWAYS kept
 *   - the newest messages are kept (most recent context wins)
 *   - the oldest non-system messages are dropped first, with a tombstone so
 *     the model knows history was compacted (honesty over illusion)
 */
function compactMessages(messages, maxChars) {
  const estimate = (msgs) => msgs.reduce((n, m) => n + String(m.content || '').length + 24, 0);
  if (!maxChars || estimate(messages) <= maxChars) return messages;

  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  const kept = [];
  let used = estimate(system) + 64;
  const tombstone = {
    role: 'system',
    content: '[context compacted: older conversation turns were dropped to fit the provider request-size limit; the task description and recent work remain below]',
  };
  for (let i = rest.length - 1; i >= 0; i--) {
    const size = String(rest[i].content || '').length + 24;
    if (used + size > maxChars) break;
    kept.unshift(rest[i]);
    used += size;
  }
  return [...system, tombstone, ...kept];
}

// --- safety gate ------------------------------------------------------------

function parseToolArgs(rawArgs) {
  try {
    if (typeof rawArgs === 'string') return rawArgs.trim() === '' ? {} : JSON.parse(rawArgs);
    return rawArgs || {};
  } catch {
    return null;
  }
}

/**
 * Decide how a tool call proceeds under the current safety mode, then either
 * execute it, hold it as a pending proposal (awaiting the user's decision),
 * or block it. Never throws — mirrors executeTool's structured-result style.
 *
 * Rules (safetyMode → action):
 *   readonly   — mutating tools blocked outright
 *   assist     — file changes AND commands held as proposals
 *   edit       — file changes apply; commands held as proposals
 *   agent      — LOW/MEDIUM commands + file changes apply; HIGH/CRITICAL proposed
 *   autonomous — additionally allows HIGH commands; CRITICAL still proposed
 *   git_commit — always proposed (history is the user's)
 */
async function gateAndExecute(name, rawArgs, ctx, { onActivity, filesChanged }) {
  const args = parseToolArgs(rawArgs);
  const risk = classifyToolRisk(name, args || {});
  const sm = ctx.safetyMode;
  const isFile = name === 'write_file' || name === 'edit_file';
  const isCommand = name === 'run_command' || name === 'run_tests';

  if (isFile || isCommand || name === 'git_commit' || name === 'git_add') {
    if (sm === 'readonly' && name !== 'run_tests') {
      return { ok: false, error: 'blocked_by_safety_mode', message: `Safety mode is READ ONLY: "${name}" was not executed.` };
    }

    let needsProposal;
    if (isFile || name === 'run_tests') needsProposal = sm === 'assist';
    else if (name === 'git_commit') needsProposal = true;
    else if (name === 'git_add') needsProposal = sm === 'assist' || sm === 'edit';
    else needsProposal = sm === 'assist' || sm === 'edit' || risk.level === 'critical' || (risk.level === 'high' && sm !== 'autonomous');

    if (needsProposal) {
      return await proposeAndAwait(name, args, ctx, risk, { onActivity, filesChanged });
    }
  }

  return executeTool(name, rawArgs, ctx);
}

/**
 * Hold an action as a pending approval, wait for the user's decision, and
 * synthesize the tool result from the applied proposal. The agent is paused
 * (bounded by the proposal's timeout) while the user decides.
 */
async function proposeAndAwait(name, args, ctx, risk, { onActivity, filesChanged }) {
  if (!ctx.approvals) {
    return { ok: false, error: 'approval_unavailable', message: 'This action requires user approval, but no approval system is available in this context.' };
  }

  const proposalInput = buildProposalInput(name, args, ctx);
  if (!proposalInput) {
    // Invalid edit (oldText missing/ambiguous, missing args…): let the real
    // executor produce its normal structured error for the model to correct.
    return executeTool(name, typeof args === 'object' ? JSON.stringify(args) : args, ctx);
  }

  let record;
  try {
    record = ctx.approvals.propose({ ...proposalInput, risk, taskId: ctx.taskId });
  } catch (e) {
    return { ok: false, error: 'proposal_failed', message: e && e.message ? e.message : String(e) };
  }

  emit(onActivity, 'APPROVAL', `Proposal ${record.id} needs approval (risk: ${risk.level}): ${record.title}`);

  const decision = await ctx.approvals.waitForDecision(record.id);
  if (decision !== 'approved') {
    const message =
      decision === 'rejected'
        ? 'The user rejected this proposal. Do not retry the exact same change — adjust it or explain and stop.'
        : 'Timed out waiting for user approval. The proposal stays pending in the approval queue.';
    return { ok: false, error: decision === 'rejected' ? 'proposal_rejected' : 'proposal_timeout', message };
  }

  const updated = ctx.approvals.get(record.id);
  if (updated.status === 'apply_failed') {
    return { ok: false, error: 'apply_failed', message: updated.error };
  }
  if (filesChanged && updated.path) filesChanged.add(updated.path);
  return { ok: true, result: { ...(updated.result || {}), approved: true, proposalId: updated.id } };
}

/**
 * Build the proposal payload for a gated action. Returns null when the
 * action is invalid in a way the normal executor should report (e.g. a bad
 * edit_file oldText) — no proposal is created for those.
 */
function buildProposalInput(name, args, ctx) {
  const { resolveInProject } = require('./security');
  const fs = require('fs');

  if (name === 'write_file') {
    if (!args || typeof args.path !== 'string' || typeof args.content !== 'string') return null;
    let oldContent = null;
    try {
      oldContent = fs.readFileSync(resolveInProject(ctx.projectRoot, args.path), 'utf8');
    } catch {
      oldContent = null; // new file
    }
    return { type: 'file', projectRoot: ctx.projectRoot, path: args.path, oldContent, newContent: args.content };
  }

  if (name === 'edit_file') {
    if (!args || typeof args.path !== 'string' || typeof args.oldText !== 'string' || typeof args.newText !== 'string') return null;
    let oldContent;
    try {
      oldContent = fs.readFileSync(resolveInProject(ctx.projectRoot, args.path), 'utf8');
    } catch {
      return null; // unreadable → let executeTool report the real error
    }
    const occurrences = oldContent.split(args.oldText).length - 1;
    if (occurrences !== 1) return null; // ambiguous/absent → executor error, no proposal
    return { type: 'file', projectRoot: ctx.projectRoot, path: args.path, oldContent, newContent: oldContent.replace(args.oldText, args.newText) };
  }

  if (name === 'run_command' || name === 'run_tests') {
    if (!args || typeof args.command !== 'string' || !args.command.trim()) return null;
    return { type: 'command', projectRoot: ctx.projectRoot, command: args.command, timeoutMs: Number(args.timeoutMs) || undefined };
  }

  if (name === 'git_commit') {
    if (!args || typeof args.message !== 'string' || !args.message.trim()) return null;
    const files = Array.isArray(args.files) ? args.files : [];
    const messageQ = JSON.stringify(args.message);
    const command = files.length
      ? `git add ${files.map((f) => JSON.stringify(f)).join(' ')} && git commit -m ${messageQ}`
      : `git commit -m ${messageQ}`;
    return { type: 'command', projectRoot: ctx.projectRoot, command };
  }

  if (name === 'git_add') {
    if (!args || !Array.isArray(args.files) || args.files.length === 0) return null;
    return { type: 'command', projectRoot: ctx.projectRoot, command: `git add ${args.files.map((f) => JSON.stringify(f)).join(' ')}` };
  }

  return null;
}

module.exports = { runAgentTask, WORKFLOW_STATES, MAX_ITERATIONS, compactMessages };
