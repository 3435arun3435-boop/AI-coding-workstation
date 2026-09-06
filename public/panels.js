'use strict';
/**
 * panels.js
 *
 * View-layer only: each panel renders backend state from the API and sends
 * user intents back as API calls. No business logic lives here — safety
 * gating, risk classification, diff generation, test parsing, and provider
 * routing all happen server-side; the UI only displays what the backend
 * reports.
 */

const Panels = (() => {
  async function api(path, opts) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
    return body;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------------------------------------------------------- tabs
  function initTabs() {
    document.querySelectorAll('#tab-bar .tab').forEach((tab) => {
      tab.onclick = () => {
        document.querySelectorAll('#tab-bar .tab').forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
        tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
        document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab.dataset.tab));
        if (tab.dataset.tab === 'diff') Diff.refresh();
        if (tab.dataset.tab === 'tests') Tests.refresh();
        if (tab.dataset.tab === 'git') Git.refresh();
        if (tab.dataset.tab === 'browser') Browser.refresh();
      };
    });
  }

  // ---------------------------------------------------------------- explorer + file editor
  const Explorer = {
    expanded: new Set(),

    async renderTree() {
      const tree = document.getElementById('file-tree');
      tree.innerHTML = '<div class="muted small">Loading…</div>';
      try {
        await this.renderDir('.', tree, 0);
      } catch (e) {
        tree.innerHTML = `<div class="muted small">${esc(e.message)}</div>`;
      }
    },

    async renderDir(rel, container, depth) {
      const { entries } = await api(`/api/files?path=${encodeURIComponent(rel)}`);
      container.innerHTML = '';
      for (const entry of entries) {
        const item = document.createElement('div');
        item.className = 'tree-item';
        item.style.paddingLeft = `${8 + depth * 14}px`;
        if (entry.type === 'dir') {
          const open = this.expanded.has(`${rel}/${entry.name}`);
          item.innerHTML = `<span class="twist">${open ? '▾' : '▸'}</span>📁 ${esc(entry.name)}`;
          item.onclick = async () => {
            const key = `${rel}/${entry.name}`;
            if (this.expanded.has(key)) {
              this.expanded.delete(key);
              item.querySelector('.twist').textContent = '▸';
              const child = item.nextElementSibling;
              if (child && child.classList.contains('tree-children')) child.remove();
            } else {
              this.expanded.add(key);
              item.querySelector('.twist').textContent = '▾';
              const childBox = document.createElement('div');
              childBox.className = 'tree-children';
              item.after(childBox);
              try {
                await this.renderDir(key, childBox, depth + 1);
              } catch (e) {
                childBox.innerHTML = `<div class="muted small">${esc(e.message)}</div>`;
              }
            }
          };
          container.appendChild(item);
        } else {
          item.innerHTML = `📄 ${esc(entry.name)}`;
          item.onclick = () => Files.open(`${rel === '.' ? '' : rel + '/'}${entry.name}`);
          container.appendChild(item);
        }
      }
    },
  };

  const Files = {
    currentPath: null,

    async open(relPath) {
      this.currentPath = relPath;
      const viewer = document.getElementById('file-viewer');
      document.getElementById('file-viewer-path').textContent = relPath;
      try {
        const { content } = await api(`/api/file?path=${encodeURIComponent(relPath)}`);
        viewer.value = content;
        viewer.removeAttribute('readonly');
        document.getElementById('file-save-btn').classList.remove('hidden');
      } catch (e) {
        viewer.value = `Could not open file: ${e.message}`;
        viewer.setAttribute('readonly', 'readonly');
        document.getElementById('file-save-btn').classList.add('hidden');
      }
    },

    async save() {
      if (!this.currentPath) return;
      try {
        const res = await api('/api/file/save', {
          method: 'POST',
          body: JSON.stringify({ path: this.currentPath, content: document.getElementById('file-viewer').value }),
        });
        if (res.proposed) {
          alert(`Safety mode is Assist: your edit was saved as a pending approval (#${res.approval.id}). Open the Diff & Approvals tab to apply it.`);
          Diff.refresh();
        } else if (res.applied) {
          document.getElementById('file-viewer-path').textContent = `${this.currentPath} — saved (${res.bytesWritten} bytes)`;
        }
      } catch (e) {
        alert(`Save failed: ${e.message}`);
      }
    },
  };

  // ---------------------------------------------------------------- diff & approvals
  const Diff = {
    async refresh() {
      const pendingBox = document.getElementById('pending-approvals');
      const historyBox = document.getElementById('approval-history');
      try {
        const [{ approvals: pending }, { approvals: all }] = await Promise.all([
          api('/api/approvals?status=pending'),
          api('/api/approvals'),
        ]);
        const history = all.filter((a) => a.status !== 'pending').slice(0, 20);
        document.getElementById('approval-count').textContent = String(pending.length);
        document.getElementById('approval-count').classList.toggle('hidden', pending.length === 0);

        pendingBox.innerHTML = pending.length ? '' : '<div class="muted small">No pending approvals.</div>';
        for (const a of pending) pendingBox.appendChild(this.card(a, true));

        historyBox.innerHTML = history.length ? '' : '<div class="muted small">No decisions yet.</div>';
        for (const a of history) historyBox.appendChild(this.card(a, false));
        Mini.render(all);
      } catch (e) {
        pendingBox.innerHTML = `<div class="muted small">${esc(e.message)}</div>`;
        historyBox.innerHTML = '';
      }
    },

    card(a, actionable) {
      const el = document.createElement('div');
      el.className = `approval-card risk-${a.risk && a.risk.level}`;
      const riskBadge = a.risk ? `<span class="badge risk-${a.risk.level}">${esc(a.risk.level.toUpperCase())}</span>` : '';
      const statusBadge = actionable ? '' : `<span class="badge status-${a.status}">${esc(a.status)}</span>`;
      const meta = a.type === 'file' ? `📄 ${esc(a.path)}` : `⌨ ${esc(a.command)}`;
      const buttons = actionable
        ? `<div class="approval-actions">
             <button class="btn btn-primary" data-act="approve" data-id="${a.id}">✓ Approve</button>
             <button class="btn" data-act="reject" data-id="${a.id}">✕ Reject</button>
           </div>`
        : (a.status === 'applied' && a.type === 'file'
          ? `<div class="approval-actions"><button class="btn" data-act="revert" data-id="${a.id}">↩ Revert</button></div>`
          : '');
      el.innerHTML = `
        <div class="approval-head">${riskBadge}${statusBadge}<strong>${esc(a.title)}</strong> <span class="muted small">${esc(a.createdAt || '')}</span></div>
        <div class="muted small">${meta}${a.taskId ? ` · task ${esc(a.taskId.slice(0, 8))}` : ''}</div>
        ${a.diff ? `<pre class="diff-view">${esc(a.diff)}</pre>` : '<div class="muted small">Command proposal — output will be captured on approval.</div>'}
        ${a.error ? `<div class="small error-text">Error: ${esc(a.error)}</div>` : ''}
        ${buttons}`;
      if (actionable) {
        el.querySelector('[data-act="approve"]').onclick = () => this.decide(a.id, 'approved');
        el.querySelector('[data-act="reject"]').onclick = () => this.decide(a.id, 'rejected');
      } else {
        const rev = el.querySelector('[data-act="revert"]');
        if (rev) rev.onclick = async () => {
          try {
            await api('/api/approvals/revert', { method: 'POST', body: JSON.stringify({ id: a.id }) });
            this.refresh();
          } catch (e) {
            alert(`Revert failed: ${e.message}`);
          }
        };
      }
      return el;
    },

    async decide(id, decision) {
      try {
        await api('/api/approvals/decide', { method: 'POST', body: JSON.stringify({ id, decision }) });
        this.refresh();
      } catch (e) {
        alert(`Could not ${decision.slice(0, -2)}: ${e.message}`);
        this.refresh();
      }
    },
  };

  const Mini = {
    render(all) {
      const box = document.getElementById('approval-mini');
      const pending = (all || []).filter((a) => a.status === 'pending');
      if (!pending.length) {
        box.textContent = 'None.';
        box.classList.add('muted');
        return;
      }
      box.classList.remove('muted');
      box.innerHTML = pending.map((a) => `<div class="approval-mini-item">• ${esc(a.title)}</div>`).join('');
    },
  };

  // ---------------------------------------------------------------- tests
  const Tests = {
    async refresh() {
      try {
        const { detection } = await api('/api/tests/detect');
        document.getElementById('tests-detect').innerHTML = detection.hasTests
          ? `Framework: <strong>${esc(detection.framework || 'unknown')}</strong> · ${detection.testFiles.length} test file(s) · full command: <code>${esc(detection.fullCommand)}</code>`
          : 'No tests detected in this project.';
        const { history } = await api('/api/tests/history');
        const box = document.getElementById('tests-history');
        box.innerHTML = history.length
          ? `<table class="table"><tr><th>When</th><th>Command</th><th>Result</th><th>P/F/S</th></tr>${history.slice(0, 10).map((h) =>
              `<tr><td>${esc((h.finishedAt || '').slice(0, 19))}</td><td><code>${esc(h.command)}</code></td><td>${h.ok ? '<span class="badge status-completed">PASS</span>' : '<span class="badge status-failed">FAIL</span>'}</td><td>${esc(`${h.totals.passed ?? '?'}/${h.totals.failed ?? '?'}/${h.totals.skipped ?? 0}`)}</td></tr>`).join('')}</table>`
          : '<div class="muted">No runs recorded yet.</div>';
      } catch (e) {
        document.getElementById('tests-detect').textContent = e.message;
      }
    },

    async run() {
      const out = document.getElementById('tests-result');
      out.innerHTML = '<div class="muted small">Running tests…</div>';
      try {
        const { result } = await api('/api/tests/run', { method: 'POST', body: JSON.stringify({}) });
        const t = result.totals || {};
        const failures = result.failures || [];
        out.innerHTML = `
          <div class="test-summary ${result.ok ? 'pass' : 'fail'}">
            ${result.ok ? '✓ PASS' : '✕ FAIL'} — ${esc(result.command)} (exit ${result.exitCode}, ${result.durationMs}ms)
            <span class="small">· ${esc(`${t.passed ?? '?'} passed, ${t.failed ?? '?'} failed, ${t.skipped ?? 0} skipped`)} · parsed as ${esc(result.parsedFormat)}</span>
          </div>
          ${failures.length ? `<div class="failures">${failures.map((f) => `<div class="failure"><strong>${esc(f.name)}</strong>${f.file ? ` <span class="muted small">${esc(f.file)}</span>` : ''}<pre>${esc(f.message || 'no message captured')}</pre></div>`).join('')}</div>` : ''}
          ${result.parsedFormat === 'generic' && !result.ok ? `<pre class="diff-view">${esc(result.rawTail || '')}</pre>` : ''}`;
        this.refresh();
      } catch (e) {
        out.innerHTML = `<div class="error-text small">${esc(e.message)}</div>`;
      }
    },
  };

  // ---------------------------------------------------------------- git
  const Git = {
    async refresh() {
      const statusBox = document.getElementById('git-status');
      const diffBox = document.getElementById('git-diff');
      const logBox = document.getElementById('git-log');
      try {
        const { status } = await api('/api/git/status');
        if (!status.isRepo) {
          statusBox.innerHTML = '<div class="muted small">Not a git repository.</div>';
          diffBox.textContent = '—';
          logBox.textContent = '—';
          return;
        }
        const chip = (n, label) => (n ? `<span class="badge">${n} ${label}</span>` : '');
        statusBox.innerHTML = `
          <div>Branch: <strong>${esc(status.branch || '?')}</strong>${status.upstream ? ` → ${esc(status.upstream)}` : ''} ${status.clean ? '<span class="badge status-completed">clean</span>' : ''}</div>
          <div class="small">${chip(status.staged.length, 'staged')} ${chip(status.unstaged.length, 'unstaged')} ${chip(status.untracked.length, 'untracked')}</div>
          <ul class="small">${[...status.staged.map((s) => `<li><code>${esc(s.code)}</code> ${esc(s.path)}</li>`),
            ...status.unstaged.map((s) => `<li><code>${esc(s.code)}</code> ${esc(s.path)}</li>`),
            ...status.untracked.map((u) => `<li><code>??</code> ${esc(u)}</li>`)].join('') || '<li class="muted">No changes.</li>'}</ul>`;

        await this.refreshDiff();
        const { commits } = await api('/api/git/log?limit=15');
        logBox.innerHTML = commits.length
          ? commits.map((c) => `<div class="commit"><code>${esc(c.hash)}</code> ${esc(c.subject)} <span class="muted small">${esc(c.author)}, ${esc((c.date || '').slice(0, 10))}</span></div>`).join('')
          : '<div class="muted">No commits.</div>';
      } catch (e) {
        statusBox.innerHTML = `<div class="muted small">${esc(e.message)}</div>`;
      }
    },

    async refreshDiff() {
      const mode = document.getElementById('git-diff-mode').value;
      try {
        const { diff, empty } = await api(`/api/git/diff?staged=${mode === 'staged' ? '1' : '0'}`);
        document.getElementById('git-diff').textContent = empty ? 'No changes.' : diff;
      } catch (e) {
        document.getElementById('git-diff').textContent = e.message;
      }
    },
  };

  // ---------------------------------------------------------------- browser
  const Browser = {
    async refresh() {
      const box = document.getElementById('browser-status');
      try {
        const { browser } = await api('/api/browser/status');
        box.innerHTML = browser.available
          ? `<div><span class="badge status-completed">AVAILABLE</span> Playwright detected ${browser.browserRunning ? '· browser running' : ''}</div>
             <div class="muted small">${esc(browser.detail)}</div>`
          : `<div><span class="badge status-failed">UNAVAILABLE</span> <span class="muted small">Browser tools are disabled — the agent will not fake browser results.</span></div>
             <div class="muted small">${esc(browser.detail)}</div>`;
      } catch (e) {
        box.innerHTML = `<div class="muted small">${esc(e.message)}</div>`;
      }
    },

    async open() {
      const urlInput = document.getElementById('browser-url');
      const report = document.getElementById('browser-report');
      const img = document.getElementById('browser-screenshot');
      const url = urlInput.value.trim();
      if (!url) return;
      report.innerHTML = '<div class="muted small">Opening page and collecting console/page/network errors…</div>';
      img.classList.add('hidden');
      try {
        const r = await api('/api/browser/verify', { method: 'POST', body: JSON.stringify({ url }) });
        if (!r.ok) {
          report.innerHTML = `<div class="error-text small">Verification failed: ${esc(r.error)}</div>`;
          return;
        }
        const e = r.errors;
        report.innerHTML = `
          <div><strong>${esc(r.title)}</strong> — <span class="muted small">${esc(r.url)}</span></div>
          <div class="small ${e.totalErrors ? 'error-text' : ''}">${e.totalErrors} error(s): ${e.consoleErrors.length} console · ${e.pageErrors.length} page · ${e.failedRequests.length} network</div>
          ${e.consoleErrors.length ? `<ul class="small">${e.consoleErrors.map((c) => `<li>console: ${esc(c.text)}</li>`).join('')}</ul>` : ''}
          ${e.pageErrors.length ? `<ul class="small">${e.pageErrors.map((c) => `<li>page error: ${esc(c.text)}</li>`).join('')}</ul>` : ''}
          ${e.failedRequests.length ? `<ul class="small">${e.failedRequests.map((c) => `<li>request failed: ${esc(c.url)} (${esc(c.failure || '')})</li>`).join('')}</ul>` : ''}`;
        if (r.screenshot && r.screenshot.data) {
          img.src = `data:image/png;base64,${r.screenshot.data}`;
          img.classList.remove('hidden');
        }
      } catch (err) {
        report.innerHTML = `<div class="error-text small">${esc(err.message)}</div>`;
      }
    },
  };

  // ---------------------------------------------------------------- terminal
  const Terminal = {
    async run() {
      const input = document.getElementById('terminal-input');
      const out = document.getElementById('terminal-output');
      const command = input.value.trim();
      if (!command) return;
      out.textContent = `$ ${command}\nRunning…`;
      try {
        const res = await api('/api/terminal/run', { method: 'POST', body: JSON.stringify({ command }) });
        if (res.proposed) {
          out.textContent = `$ ${command}\n⚠ ${res.risk.level.toUpperCase()} risk — held for approval (#${res.approval.id}). Open Diff & Approvals to decide.`;
          Diff.refresh();
          return;
        }
        const r = res.result;
        out.textContent = `$ ${r.command}\nexit ${r.exitCode}${r.timedOut ? ' (TIMED OUT)' : ''} · ${r.durationMs}ms\n\n--- stdout ---\n${r.stdout || '(empty)'}\n--- stderr ---\n${r.stderr || '(empty)'}`;
      } catch (e) {
        out.textContent = `$ ${command}\n✕ ${e.message}`;
      }
    },
  };

  // ---------------------------------------------------------------- project map
  async function analyzeProject() {
    const box = document.getElementById('project-map-summary');
    box.textContent = 'Analyzing…';
    try {
      const { map } = await api('/api/project/map?refresh=1');
      box.innerHTML =
        `${esc(map.projectType)} · ${esc(map.primaryLanguage || '?')}` +
        `${map.frameworks.length ? ` · ${esc(map.frameworks.join(', '))}` : ''}` +
        `${map.packageManager ? ` · ${esc(map.packageManager)}` : ''}` +
        `${map.isGitRepo ? ' · git' : ''}` +
        `<br><span class="muted">${esc(String(map.fileCount))} files · tests: ${esc(map.testFramework || 'none detected')}</span>`;
    } catch (e) {
      box.textContent = e.message;
    }
  }

  return { initTabs, Explorer, Files, Diff, Tests, Git, Browser, Terminal, analyzeProject, api, esc };
})();

window.Panels = Panels;
