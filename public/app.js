'use strict';
/**
 * app.js — workstation shell: chat/agent, activity timeline, tasks,
 * providers, memory, settings. Panel views live in panels.js; all business
 * logic (safety gating, routing, diffing, test parsing) lives server-side.
 */

const { api, esc } = window.Panels;

const chatLog = document.getElementById('chat-log');
const activityLog = document.getElementById('activity-log');
const composerInput = document.getElementById('composer-input');
const sendBtn = document.getElementById('send-btn');
const themeSelect = document.getElementById('theme-select');
const projectList = document.getElementById('project-list');
const taskList = document.getElementById('task-list');
const memoryStatus = document.getElementById('memory-status');
const activeProjectChip = document.getElementById('active-project');
const connState = document.getElementById('conn-state');
const providerList = document.getElementById('provider-list');
const modeSelect = document.getElementById('mode-select');
const safetySelect = document.getElementById('safety-select');
const modelChip = document.getElementById('model-chip');

// ---------------------------------------------------------------- helpers

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'msg-user' : 'msg-agent'}`;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  const empty = chatLog.querySelector('.empty-state');
  if (empty) empty.remove();
}

function addCard({ title, body, kind }) {
  const div = document.createElement('div');
  div.className = `card ${kind === 'error' ? 'card-error' : 'card-success'}`;
  const t = document.createElement('div');
  t.className = 'card-title';
  t.textContent = title;
  div.appendChild(t);
  if (body) {
    const pre = document.createElement('pre');
    pre.textContent = body;
    div.appendChild(pre);
  }
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

const STATE_ICONS = {
  UNDERSTAND: '🧠', INSPECT: '🔍', PLAN: '🧭', APPROVAL: '⏸', IMPLEMENT: '✏️',
  RUN: '▶', TEST: '🧪', VERIFY: '✅', FIX: '🔧', COMPLETE: '🏁',
};

function updateStatusBar(settings) {
  const sb = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  sb('sb-project', settings && settings.activeProject ? settings.activeProject.name : 'no project');
  sb('sb-safety', 'safety: ' + (settings ? settings.safetyMode : '—'));
  sb('sb-offline', settings && settings.offline ? 'LOCAL/OFFLINE' : '');
  api('/api/git/status').then(({ status }) => {
    sb('sb-git', status && status.isRepo ? 'git: ' + (status.branch || '?') + (status.clean ? ' (clean)' : ` (${status.staged.length + status.unstaged.length + status.untracked.length} changed)`) : 'git: not a repo');
  }).catch(() => {});
  api('/api/tests/history').then(({ history }) => {
    const last = history && history[0];
    sb('sb-tests', last ? `tests: ${last.ok ? 'PASS' : 'FAIL'} (${last.totals.passed ?? '?'}/${last.totals.failed ?? '?'})` : 'tests: —');
  }).catch(() => {});
}

function addActivity(event) {
  const empty = activityLog.querySelector('.muted');
  if (empty) empty.remove();
  const time = new Date(event.ts || Date.now()).toLocaleTimeString();
  const div = document.createElement('div');
  div.className = 'activity-item';
  const icon = STATE_ICONS[event.state] || '•';
  div.innerHTML = `<span class="activity-time">${esc(time)}</span><span class="activity-state">${icon} ${esc(event.state)}</span>${esc(event.message)}`;
  activityLog.appendChild(div);
  activityLog.scrollTop = activityLog.scrollHeight;
}

// ---------------------------------------------------------------- settings & state

function applyTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  themeSelect.value = theme;
}

async function loadSettings() {
  const settings = await api('/api/settings');
  applyTheme(settings.theme);
  safetySelect.value = settings.safetyMode || 'agent';

  // Offline/local indicator: honest state of cloud availability.
  const offlineChip = document.getElementById('offline-chip');
  if (offlineChip) {
    offlineChip.classList.toggle('hidden', !settings.offline);
  }

  loadAdvancedSettings(settings);

  projectList.innerHTML = '';
  for (const p of settings.projects) {
    const el = document.createElement('div');
    el.className = 'list-item' + (settings.activeProject && settings.activeProject.id === p.id ? ' active' : '');
    el.textContent = p.name;
    el.title = p.rootPath;
    el.onclick = async () => {
      await api('/api/projects', { method: 'POST', body: JSON.stringify(p) });
      loadSettings();
      window.Panels.Explorer.renderTree();
      window.Panels.Git.refresh().catch(() => {});
    };
    projectList.appendChild(el);
  }

  activeProjectChip.textContent = settings.activeProject ? settings.activeProject.name : 'No project';
  activeProjectChip.title = settings.activeProject ? settings.activeProject.rootPath : 'Open a folder to begin';
  updateStatusBar(settings);
}

async function loadProviders() {
  const { providers } = await api('/api/providers');
  providerList.innerHTML = '';
  if (providers.length === 0) {
    providerList.innerHTML = '<div class="muted small">No providers configured.</div>';
    return;
  }
  for (const p of providers) {
    const el = document.createElement('div');
    el.className = 'list-item provider-item';
    const kind = p.local ? '<span class="badge badge-local">LOCAL</span>' : (p.apiKeySet ? '<span class="badge badge-free">FREE-TIER</span>' : '<span class="badge badge-off">NO KEY</span>');
    const health = p.health
      ? (p.health.inCooldown
        ? '<span class="badge status-failed">cooldown</span>'
        : (p.health.healthy ? '<span class="badge status-completed">ok</span>' : '<span class="badge badge-off">untested</span>'))
      : '';
    const latency = p.health && p.health.usage && p.health.usage.lastLatencyMs != null ? `<span class="muted small">${p.health.usage.lastLatencyMs}ms</span>` : '';
    const reqs = p.health && p.health.usage && p.health.usage.requests ? `<span class="muted small">${p.health.usage.requests} req</span>` : '';
    el.innerHTML = `<div>${p.enabled !== false ? '●' : '○'} ${esc(p.name)} ${kind} ${health}</div>
      <div class="small muted">${esc(p.model || 'no model set')} ${latency} ${reqs}</div>`;
    el.title = `${p.baseUrl} — click to test connection`;
    el.onclick = async () => {
      el.innerHTML = `<div>⟳ testing ${esc(p.name)}…</div>`;
      try {
        const r = await api('/api/providers/test', { method: 'POST', body: JSON.stringify({ id: p.id }) });
        alert(r.ok ? `✓ ${p.name} reachable (HTTP ${r.status})` : `✕ ${p.name} not reachable: ${r.error ? (r.error.friendly || r.error) : 'HTTP ' + r.status}`);
      } catch (e) {
        alert(`✕ Test failed: ${e.message}`);
      }
      loadProviders();
    };
    providerList.appendChild(el);
  }
}

async function addProviderFlow() {
  try {
    const { presets } = await api('/api/provider-presets');
    const menu = presets.map((p, i) => `${i + 1}. ${p.name} — key: ${p.keyUrl}`).join('\n');
    const choice = prompt(
      `Choose a free-tier provider (type a number), or "0" for a custom OpenAI-compatible endpoint:\n\n${menu}\n\n0. Custom / other (also used for LM Studio, llama.cpp servers…)`
    );
    if (choice === null) return;
    const idx = parseInt(choice, 10) - 1;
    const preset = presets[idx];

    let baseUrl, model, name;
    if (preset) {
      name = preset.name;
      baseUrl = preset.baseUrl;
      model = prompt(`Model id for ${preset.name} (blank = default ${preset.model}):`, preset.model) || preset.model;
      if (preset.notes) alert(preset.notes);
    } else {
      name = prompt('Provider name:', 'Custom provider') || 'Custom provider';
      baseUrl = prompt('Base URL (OpenAI-compatible, e.g. http://localhost:1234/v1):');
      if (!baseUrl) return;
      model = prompt('Model id:') || '';
    }
    const apiKey = prompt(`API key for ${name} (stored locally, masked after saving):`) || '';
    const id = (preset ? preset.preset : 'custom') + '-' + Date.now().toString(36);
    await api('/api/providers', {
      method: 'POST',
      body: JSON.stringify({ id, name, type: 'openai-compatible', baseUrl, model, apiKey, enabled: true, priority: 50 }),
    });
    loadProviders();
  } catch (e) {
    alert(`Could not add provider: ${e.message}`);
  }
}

async function refreshLocal() {
  try {
    const { detection, provider } = await api('/api/providers/refresh-local', { method: 'POST', body: JSON.stringify({}) });
    if (detection.available) {
      alert(`Ollama detected at ${detection.baseUrl}\nModels: ${detection.models.join(', ') || '(none installed)'}`);
    } else {
      alert(`Ollama is OFFLINE (${detection.error}).\nStart it with: ollama serve\nThe entry was saved and will be used once it responds.`);
    }
    loadProviders();
  } catch (e) {
    alert(`Detection failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------- advanced settings + skills

function loadAdvancedSettings(settings) {
  const s = settings.settings || {};
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value == null ? '' : value;
  };
  set('set-modelStrategy', s.modelStrategy);
  set('set-manualProviderId', s.manualProviderId);
  set('set-offlineMode', s.offlineMode);
  set('set-maxAgents', s.maxAgents);
  set('set-maxParallel', s.maxParallel);
  set('set-reviewerRequired', s.reviewerRequired);
  set('set-checkpointBeforeAutonomous', s.checkpointBeforeAutonomous);
  set('set-testBeforeComplete', s.testBeforeComplete);
  set('set-taskTokenBudget', s.taskTokenBudget);
  set('set-contextBudgetBytes', s.contextBudgetBytes);
  set('set-relevanceThreshold', s.relevanceThreshold);
  set('set-toolResultCharLimit', s.toolResultCharLimit);
  set('set-maxPayloadChars', s.maxPayloadChars);
  set('set-terminalTimeoutMs', s.terminalTimeoutMs);
  set('set-terminalOutputLimit', s.terminalOutputLimit);
  set('set-browserHeadless', s.browserHeadless);
  set('set-browserTimeoutMs', s.browserTimeoutMs);
  set('set-reasoningPreference', s.reasoningPreference);
  set('set-conflictPolicy', s.conflictPolicy);
  set('set-retryWaitMs', s.retryWaitMs);
  set('set-uiRefreshIntervalMs', s.uiRefreshIntervalMs);
}

async function saveAdvancedSettings() {
  const val = (id) => {
    const el = document.getElementById(id);
    if (el.type === 'checkbox') return el.checked;
    if (el.value === '' || el.value === undefined) return null;
    return el.type === 'number' ? Number(el.value) : el.value;
  };
  try {
    await api('/api/settings/update', {
      method: 'POST',
      body: JSON.stringify({
        modelStrategy: val('set-modelStrategy'),
        manualProviderId: val('set-manualProviderId'),
        offlineMode: val('set-offlineMode'),
        maxAgents: val('set-maxAgents'),
        maxParallel: val('set-maxParallel'),
        reviewerRequired: val('set-reviewerRequired'),
        checkpointBeforeAutonomous: val('set-checkpointBeforeAutonomous'),
        testBeforeComplete: val('set-testBeforeComplete'),
        taskTokenBudget: val('set-taskTokenBudget'),
        contextBudgetBytes: val('set-contextBudgetBytes'),
        relevanceThreshold: val('set-relevanceThreshold'),
        toolResultCharLimit: val('set-toolResultCharLimit'),
        maxPayloadChars: val('set-maxPayloadChars'),
        terminalTimeoutMs: val('set-terminalTimeoutMs'),
        terminalOutputLimit: val('set-terminalOutputLimit'),
        browserHeadless: val('set-browserHeadless'),
        browserTimeoutMs: val('set-browserTimeoutMs'),
        reasoningPreference: val('set-reasoningPreference'),
        conflictPolicy: val('set-conflictPolicy'),
        retryWaitMs: val('set-retryWaitMs'),
        uiRefreshIntervalMs: val('set-uiRefreshIntervalMs'),
      }),
    });
    loadSettings();
  } catch (e) {
    alert(`Could not save settings: ${e.message}`);
  }
}

async function runDoctor() {
  const box = document.getElementById('doctor-report');
  box.innerHTML = '<div class="muted small">Running diagnostics…</div>';
  try {
    const { doctor } = await api('/api/doctor');
    box.innerHTML =
      `<div class="small ${doctor.ok ? '' : 'error-text'}" style="padding:10px 18px">${doctor.ok ? '✓ All critical checks passed' : '✕ Some checks FAILED'} — ${doctor.checks.length} checks</div>` +
      `<div style="padding:0 18px 16px">` +
      doctor.checks.map((c) => `<div class="doctor-check"><span class="status-${c.status}">${c.status}</span> <strong>${esc(c.name)}</strong> <span class="muted small">${esc(c.detail)}</span></div>`).join('') +
      `</div>`;
  } catch (e) {
    box.innerHTML = `<div class="error-text small" style="padding:10px 18px">${esc(e.message)}</div>`;
  }
}

async function loadAgents() {
  const box = document.getElementById('agents-list');
  try {
    const { agents } = await api('/api/agents');
    box.innerHTML = agents.length
      ? agents.map((a) => `<div class="list-item" title="${esc(a.division)} · mode ${esc(a.mode)} — ${esc(a.mission || '')}">🤖 ${esc(a.label)}</div>`).join('')
      : '<div class="muted small">No specialists.</div>';
  } catch {
    box.innerHTML = '<div class="muted small">Agents unavailable.</div>';
  }
}

async function loadSkills() {
  const box = document.getElementById('skills-list');
  try {
    const { skills } = await api('/api/skills');
    box.innerHTML = skills.length
      ? skills.map((s) => `<div class="list-item" title="${esc(s.description || '')} (source: ${esc(s.source)})">🧩 ${esc(s.name)}</div>`).join('')
      : '<div class="muted small">No skills detected. Add skills/&lt;name&gt;/skill.md to the project.</div>';
  } catch {
    box.innerHTML = '<div class="muted small">Select a project to detect skills.</div>';
  }
}

// ---------------------------------------------------------------- tasks

async function loadTasks() {
  const { tasks } = await api('/api/tasks');
  taskList.innerHTML = '';
  for (const t of tasks.slice(0, 10)) {
    const el = document.createElement('div');
    el.className = 'list-item task-item';
    const verdict = t.evaluation && t.evaluation.verdict;
    const evidenceBadge = verdict ? `<span class="badge ${verdict === 'VERIFIED' ? 'status-completed' : verdict === 'FAILED' ? 'status-failed' : 'badge-off'}">${esc(verdict)}</span>` : '';
    el.innerHTML = `<div>${statusDot(t.status)} ${t.role ? `<span class="badge badge-local">${esc(t.role)}</span> ` : ''}${esc(t.title.slice(0, 34))}</div><div class="small muted">${esc(t.status)}${t.mode ? ` · ${esc(t.mode)}` : ''}${t.parentId ? ' · subtask' : ''} ${evidenceBadge}</div>`;
    el.title = `${t.status} — ${t.summary || '(no summary yet)'} \nClick to cancel if still running.`;
    el.onclick = async () => {
      if (['running', 'waiting_approval', 'testing', 'debugging', 'queued'].includes(t.status)) {
        if (confirm(`Cancel task "${t.title}"?`)) {
          await api('/api/tasks/cancel', { method: 'POST', body: JSON.stringify({ id: t.id }) });
          loadTasks();
        }
      } else if (confirm(`Retry task "${t.title}"?`)) {
        await api('/api/tasks/retry', { method: 'POST', body: JSON.stringify({ id: t.id }) });
        loadTasks();
      }
    };
    taskList.appendChild(el);
  }
}

function statusDot(status) {
  return { completed: '✓', partial: '◐', failed: '✕', blocked: '⊘', cancelled: '⊘', running: '⟳', waiting_approval: '⏸', testing: '🧪', debugging: '🐞', queued: '…' }[status] || '•';
}

// ---------------------------------------------------------------- memory

async function loadMemoryStatus() {
  const { memory, status: memStatus } = await api('/api/memory');
  const total = Object.values(memory).reduce((sum, cat) => sum + Object.keys(cat).length, 0);
  memoryStatus.textContent = `${total} stored item(s) · ${(memStatus.bytes / 1024).toFixed(1)} KB`;
}

// ---------------------------------------------------------------- agent run (SSE)

async function runTask(task) {
  const mode = modeSelect.value;
  addMessage('user', task + (mode !== 'auto' ? `  [mode: ${mode}]` : ''));
  activityLog.innerHTML = '';
  composerInput.value = '';
  sendBtn.disabled = true;

  try {
    const res = await fetch('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, mode }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      addCard({ title: 'Could not start task', body: errBody.error || `HTTP ${res.status}`, kind: 'error' });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        const line = part.replace(/^data: /, '').trim();
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === 'activity') {
          addActivity(event);
        } else if (event.type === 'result') {
          addCard({
            title: resultTitle(event.status),
            body: event.summary,
            kind: ['completed'].includes(event.status) ? 'success' : 'error',
          });
          if (event.provider) {
            modelChip.textContent = `${event.provider}${event.model ? ` / ${event.model}` : ''}`;
            const sbp = document.getElementById('sb-provider');
            if (sbp) sbp.textContent = `provider: ${event.provider}${event.model ? ' / ' + event.model : ''}`;
            const sbt = document.getElementById('sb-tokens');
            if (sbt && typeof event.tokensUsed === 'number') sbt.textContent = `tokens: ~${event.tokensUsed}`;
            modelChip.classList.remove('chip-muted');
          }
          loadTasks();
          window.Panels.Diff.refresh();
        } else if (event.type === 'error') {
          addCard({ title: event.friendly || 'Error', body: `${event.suggestion || ''}\n\n${event.technical || ''}`, kind: 'error' });
        }
      }
    }
  } catch (e) {
    addCard({ title: 'Connection error', body: e.message, kind: 'error' });
  } finally {
    sendBtn.disabled = false;
    loadTasks();
  }
}

function resultTitle(status) {
  return {
    completed: '✓ Task completed',
    partial: '◐ Task partially fixed',
    failed: '✕ Task failed',
    blocked: '⊘ Task blocked',
    cancelled: '⊘ Task cancelled',
    error: '✕ Task error',
    incomplete: '… Task incomplete',
  }[status] || `Task ${status}`;
}

// ---------------------------------------------------------------- wiring

sendBtn.onclick = () => {
  const task = composerInput.value.trim();
  if (task) runTask(task);
};

composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendBtn.click();
});

document.querySelectorAll('[data-quick]').forEach((btn) => {
  btn.onclick = () => runTask(btn.dataset.quick);
});

themeSelect.onchange = async () => {
  applyTheme(themeSelect.value);
  await api('/api/settings/theme', { method: 'POST', body: JSON.stringify({ theme: themeSelect.value }) });
};

safetySelect.onchange = async () => {
  try {
    await api('/api/settings/safety-mode', { method: 'POST', body: JSON.stringify({ mode: safetySelect.value }) });
  } catch (e) {
    alert(`Could not change safety mode: ${e.message}`);
    loadSettings();
  }
};

document.getElementById('add-project-btn').onclick = async () => {
  const rootPath = prompt('Enter the absolute path to your project folder:');
  if (!rootPath) return;
  try {
    await api('/api/projects', { method: 'POST', body: JSON.stringify({ rootPath }) });
    loadSettings();
    window.Panels.Explorer.renderTree();
  } catch (e) {
    alert(`Could not add project: ${e.message}`);
  }
};

document.getElementById('analyze-btn').onclick = () => window.Panels.analyzeProject();
document.getElementById('add-provider-btn').onclick = addProviderFlow;
document.getElementById('refresh-local-btn').onclick = refreshLocal;
document.getElementById('memory-clear-btn').onclick = async () => {
  if (!confirm('Clear ALL local memory (tasks/learned profiles stay in files; this clears in-store entries)?')) return;
  await api('/api/memory/clear', { method: 'POST', body: JSON.stringify({}) });
  loadMemoryStatus();
};

document.getElementById('file-save-btn').onclick = () => window.Panels.Files.save();
document.getElementById('diff-refresh-btn').onclick = () => window.Panels.Diff.refresh();
document.getElementById('tests-run-btn').onclick = () => window.Panels.Tests.run();
document.getElementById('git-refresh-btn').onclick = () => window.Panels.Git.refresh();
document.getElementById('browser-check-btn').onclick = () => window.Panels.Browser.refresh();
document.getElementById('browser-go-btn').onclick = () => window.Panels.Browser.open();
document.getElementById('terminal-run-btn').onclick = () => window.Panels.Terminal.run();
document.getElementById('settings-save-btn').onclick = saveAdvancedSettings;
document.getElementById('doctor-btn').onclick = runDoctor;
document.getElementById('terminal-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') window.Panels.Terminal.run();
});
document.getElementById('git-diff-mode').onchange = () => window.Panels.Git.refreshDiff();

async function checkHealth() {
  try {
    await api('/api/health');
    connState.textContent = '● connected';
    connState.className = 'chip';
  } catch {
    connState.textContent = '● offline';
    connState.className = 'chip chip-muted';
  }
}

// ---------------------------------------------------------------- boot

window.Panels.initTabs();
checkHealth();
loadSettings().then((settings) => {
  window.Panels.Explorer.renderTree().catch(() => {});
  loadSkills();
  loadAgents();
  const interval = settings && settings.settings ? settings.settings.uiRefreshIntervalMs : 8000;
  clearInterval(window.__wsRefresh);
  window.__wsRefresh = setInterval(() => {
    loadTasks();
    window.Panels.Diff.refresh().catch(() => {});
  }, interval);
});
loadProviders();
loadTasks();
loadMemoryStatus();
window.Panels.Diff.refresh().catch(() => {});
// periodic refresh interval is configured from Settings → UI (set after loadSettings)
