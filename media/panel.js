(function () {
  const vscode = acquireVsCodeApi();
  const q = document.getElementById('q');
  const clearBtn = document.getElementById('clear');
  const usageEl = document.getElementById('usage');
  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');

  let state = { sessions: [], usage: undefined, groupByProject: true, showUsage: true, collapsed: [], filter: '' };
  let filterTimer;

  const STATE_ORDER = { 'needs-answer': 0, working: 1, idle: 2, ended: 3 };
  const SOURCE = { cli: 'CLI', vscode: 'VS Code', desktop: 'Desktop', sdk: 'SDK', other: 'Other' };

  function ago(ms, now) {
    const s = Math.round(Math.max(0, now - ms) / 1000);
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.round(h / 24);
    if (d < 7) return d + 'd ago';
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function shortAgo(ms, now) {
    const s = Math.round(Math.max(0, now - ms) / 1000);
    if (s < 45) return 'now';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h';
    const d = Math.round(h / 24);
    if (d < 7) return d + 'd';
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function stateLabel(s, now) {
    switch (s.state) {
      case 'needs-answer': return 'needs answer · ' + shortAgo(s.stateSince, now);
      case 'working': return 'working · ' + shortAgo(s.stateSince, now);
      case 'idle': return 'done ' + ago(s.stateSince, now);
      default: return 'ended ' + ago(s.stateSince, now);
    }
  }
  function stateIcon(state) {
    switch (state) {
      case 'needs-answer': return 'codicon-bell-dot c-warn';
      case 'working': return 'codicon-sync codicon-modifier-spin c-blue';
      case 'idle': return 'codicon-pass c-green';
      default: return 'codicon-circle-outline c-dim';
    }
  }
  function resetText(resetsAt, now) {
    if (!resetsAt) return '';
    const diff = resetsAt - now;
    if (diff <= 0) return 'resets now';
    const totalMin = Math.round(diff / 60000);
    if (totalMin < 60) return 'resets in ' + totalMin + 'm';
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h < 24) return 'resets in ' + h + 'h ' + String(m).padStart(2, '0') + 'm';
    const d = new Date(resetsAt);
    return 'resets ' + d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  function usageColor(l) {
    if (l.severity === 'critical' || l.percent >= 90) return 'c-red';
    if (l.severity === 'warning' || l.percent >= 70) return 'c-yellow';
    return 'c-green';
  }
  function basename(p) {
    const parts = p.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || p;
  }
  function prettyPath(p) {
    return p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~');
  }

  function tokens() {
    return q.value.toLowerCase().split(/\s+/).filter(Boolean);
  }
  function matches(hay, toks) {
    const h = hay.toLowerCase();
    return toks.every((t) => h.includes(t));
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function isCollapsed(cwd, hasLive, filtering) {
    if (filtering) return false;
    if (state.collapsed.includes(cwd)) return true;
    if (state.collapsed.includes('!' + cwd)) return false;
    return !hasLive;
  }

  function renderUsage(now) {
    usageEl.innerHTML = '';
    if (!state.showUsage || tokens().length) return;
    const u = state.usage;
    const head = el('div', 'row project');
    head.title = u ? 'Fetched ' + ago(u.fetchedAt, now) + '. Click to refresh.' : 'Loading usage…';
    head.appendChild(el('span', 'codicon codicon-dashboard'));
    head.appendChild(el('span', 'title', 'Usage'));
    const summary = !u ? 'loading…' : u.error ? u.error : u.limits.map((l) => l.label + ' ' + Math.round(l.percent) + '%').join(' · ');
    head.appendChild(el('span', 'desc', summary));
    head.addEventListener('click', () => vscode.postMessage({ type: 'refreshUsage' }));
    usageEl.appendChild(head);
    if (!u || u.error) return;
    for (const l of u.limits) {
      const row = el('div', 'row limit session ' + usageColor(l));
      row.title = l.label + ': ' + l.percent.toFixed(1) + '% used' + (l.resetsAt ? '\nResets ' + new Date(l.resetsAt).toLocaleString() : '') + (l.limitDollars != null ? '\n$' + (l.usedDollars || 0).toFixed(2) + ' of $' + l.limitDollars.toFixed(2) : '') + (l.isActive ? '\nCurrently the binding limit' : '');
      row.appendChild(el('span', 'label', l.label));
      const bar = el('span', 'bar');
      const fill = el('span');
      fill.style.width = Math.max(0, Math.min(100, l.percent)) + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(el('span', 'pct', Math.round(l.percent) + '%'));
      row.appendChild(el('span', 'reset', resetText(l.resetsAt, now)));
      usageEl.appendChild(row);
    }
    usageEl.appendChild(el('div', 'section-gap'));
  }

  function sessionRow(s, now, showProject) {
    const row = el('div', 'row session');
    row.tabIndex = 0;
    row.setAttribute('role', 'treeitem');
    row.dataset.vscodeContext = JSON.stringify({ webviewSection: 'session', sessionId: s.sessionId, preventDefaultContextMenuItems: true });
    row.appendChild(el('span', 'codicon ' + stateIcon(s.state)));
    row.appendChild(el('span', 'title', s.title));
    let desc = stateLabel(s, now) + ' · ' + (SOURCE[s.entrypoint] || s.entrypoint);
    if (showProject) desc += ' · ' + basename(s.cwd);
    row.appendChild(el('span', 'desc', desc));
    row.title = [
      s.title,
      stateLabel(s, now) + (s.stateDetail ? ' (' + s.stateDetail + ')' : ''),
      prettyPath(s.cwd) + (s.gitBranch && s.gitBranch !== 'HEAD' ? '  ⎇ ' + s.gitBranch : ''),
      (SOURCE[s.entrypoint] || s.entrypoint) + (s.live && s.pid ? ' · pid ' + s.pid : '') + (s.version ? ' · v' + s.version : ''),
      s.lastPrompt && s.lastPrompt !== s.title ? 'Last prompt: ' + s.lastPrompt : '',
      s.sessionId,
    ].filter(Boolean).join('\n');
    const open = () => vscode.postMessage({ type: 'open', sessionId: s.sessionId });
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    return row;
  }

  function render() {
    const now = Date.now();
    const toks = tokens();
    const filtering = toks.length > 0;
    clearBtn.hidden = !q.value;
    renderUsage(now);
    listEl.innerHTML = '';
    listEl.classList.toggle('flat', !state.groupByProject);

    const groups = new Map();
    for (const s of state.sessions) {
      const cwd = s.cwd || '(unknown)';
      if (filtering) {
        const projHit = matches(basename(cwd) + ' ' + prettyPath(cwd), toks);
        const sessHit = matches([s.title, s.lastPrompt || '', s.sessionId, SOURCE[s.entrypoint] || '', s.state, s.gitBranch || ''].join(' '), toks);
        if (!projHit && !sessHit) continue;
      }
      if (!groups.has(cwd)) groups.set(cwd, []);
      groups.get(cwd).push(s);
    }
    const sortSessions = (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.lastActivity - a.lastActivity;

    let total = 0;
    if (!state.groupByProject) {
      const all = [].concat(...groups.values()).sort(sortSessions);
      for (const s of all) listEl.appendChild(sessionRow(s, now, true));
      total = all.length;
    } else {
      const projects = [...groups.entries()].map(([cwd, list]) => ({ cwd, sessions: list.sort(sortSessions) }));
      projects.sort((a, b) => sortSessions(a.sessions[0], b.sessions[0]));
      for (const p of projects) {
        const live = p.sessions.filter((s) => s.live);
        const needs = live.filter((s) => s.state === 'needs-answer').length;
        const working = live.filter((s) => s.state === 'working').length;
        const collapsed = isCollapsed(p.cwd, live.length > 0, filtering);
        const head = el('div', 'row project');
        head.tabIndex = 0;
        head.dataset.vscodeContext = JSON.stringify({ webviewSection: 'project', cwd: p.cwd, preventDefaultContextMenuItems: true });
        head.appendChild(el('span', 'twistie codicon ' + (collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down')));
        head.appendChild(el('span', 'codicon ' + (needs ? 'codicon-folder-active c-warn' : working ? 'codicon-folder-active c-blue' : 'codicon-folder')));
        head.appendChild(el('span', 'title', basename(p.cwd)));
        const parts = [];
        if (needs) parts.push(needs + (needs === 1 ? ' needs answer' : ' need answer'));
        if (working) parts.push(working + ' working');
        if (!parts.length) parts.push(live.length ? live.length + ' idle' : p.sessions.length + ' past');
        head.appendChild(el('span', 'desc', parts.join(' · ')));
        head.title = prettyPath(p.cwd);
        const toggle = () => {
          const next = !isCollapsed(p.cwd, live.length > 0, filtering);
          state.collapsed = state.collapsed.filter((c) => c !== p.cwd && c !== '!' + p.cwd).concat(next ? [p.cwd] : ['!' + p.cwd]);
          vscode.postMessage({ type: 'toggleProject', cwd: p.cwd, collapsed: next });
          render();
        };
        head.addEventListener('click', toggle);
        head.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
        listEl.appendChild(head);
        if (!collapsed) for (const s of p.sessions) listEl.appendChild(sessionRow(s, now, false));
        total += p.sessions.length;
      }
    }
    emptyEl.hidden = total > 0;
    emptyEl.textContent = filtering ? 'No sessions or projects match “' + q.value.trim() + '”.' : 'No Claude sessions found.';
  }

  q.addEventListener('input', () => {
    render();
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => vscode.postMessage({ type: 'filter', text: q.value }), 200);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && q.value) {
      q.value = '';
      q.dispatchEvent(new Event('input'));
    }
  });
  clearBtn.addEventListener('click', () => {
    q.value = '';
    q.dispatchEvent(new Event('input'));
    q.focus();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      q.focus();
      q.select();
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'state') return;
    state = msg;
    if (document.activeElement !== q && q.value !== state.filter) q.value = state.filter;
    render();
  });

  setInterval(render, 30000);
  vscode.postMessage({ type: 'ready' });
})();
