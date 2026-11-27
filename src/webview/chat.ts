import {
  ChatItem,
  CommandOption,
  HostToView,
  PermissionDecision,
  PermissionModeName,
  PermissionRequestView,
  QuestionRequestView,
  RunStatus,
  SessionHeader,
  ViewToHost,
} from '../chat/protocol';
import { renderPermission, renderQuestion } from './cards';
import { button, clear, el, icon } from './dom';
import { ItemHandlers, renderItem, showOlderButton, toolChildren } from './items';
import { renderMarkdown } from './markdown';

interface PersistedState {
  sessionId?: string;
  cwd?: string;
  title?: string;
  draft?: string;
}

interface VsCodeApi {
  postMessage(message: ViewToHost): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const MODES: { value: PermissionModeName; label: string }[] = [
  { value: 'default', label: 'Ask before edits' },
  { value: 'acceptEdits', label: 'Edit automatically' },
  { value: 'plan', label: 'Plan' },
  { value: 'auto', label: 'Auto' },
  { value: 'bypassPermissions', label: 'Bypass permissions' },
];

const STATE_TEXT: Record<RunStatus['state'], string> = {
  idle: 'Idle',
  starting: 'Starting…',
  working: 'Working…',
  waiting: 'Waiting for you',
  error: 'Error',
};

const STATE_ICON: Record<RunStatus['state'], string> = {
  idle: 'circle-outline',
  starting: 'loading codicon-modifier-spin',
  working: 'loading codicon-modifier-spin',
  waiting: 'bell-dot',
  error: 'error',
};

let header: SessionHeader | undefined;
let status: RunStatus = { state: 'idle' };
let permission: PermissionRequestView | undefined;
let question: QuestionRequestView | undefined;
let lastSent = '';
let commands: CommandOption[] = [];
let menuMatches: CommandOption[] = [];
let menuIndex = 0;
let menuQuery: string | undefined;
let menuDismissedFor: string | undefined;
let warmed = false;
let waitingForOlder = false;

const nodes = new Map<string, HTMLElement>();
const orphans = new Set<string>();

function post(message: ViewToHost): void {
  vscode.postMessage(message);
}

const handlers: ItemHandlers = {
  openFile: (path, line) => post({ type: 'openFile', path, line }),
  openDiff: (path) => post({ type: 'openDiff', path }),
  openLink: (href) => post({ type: 'openLink', href }),
};

const root = document.getElementById('root') || document.body.appendChild(el('div', 'chat-root'));
root.classList.add('chat-root');

const headerEl = el('div', 'header');
const scrollEl = el('div', 'scroll');
const columnEl = el('div', 'column');
const olderEl = el('div', 'older');
const listEl = el('div', 'list');
const emptyEl = el('div', 'empty-state');
const partialEl = el('div', 'partial');
const dockEl = el('div', 'dock');
const dockColumn = el('div', 'column');
const cardEl = el('div', 'cards');
const errorEl = el('div', 'banner error');
const composerEl = el('div', 'composer');
const slashMenu = el('div', 'slash-menu');
const input = el('textarea', 'composer-input');
const sendBtn = button('composer-btn', undefined, 'Send (Enter)');
const stopBtn = button('composer-btn stop', undefined, 'Stop');
const modeSelect = el('select', 'picker');
const modelSelect = el('select', 'picker');
const statusTextEl = el('span', 'status-text');
let stateChip: HTMLElement | undefined;

function buildLayout(): void {
  columnEl.append(olderEl, emptyEl, listEl, partialEl);
  emptyEl.hidden = true;
  scrollEl.appendChild(columnEl);

  input.rows = 1;
  input.placeholder = 'Ask Claude to do something…';
  input.value = vscode.getState()?.draft || '';
  sendBtn.appendChild(icon('send'));
  stopBtn.appendChild(icon('debug-stop'));
  stopBtn.hidden = true;

  const inputRow = el('div', 'composer-row');
  inputRow.append(input, sendBtn, stopBtn);

  for (const m of MODES) {
    const o = el('option', undefined, m.label);
    o.value = m.value;
    modeSelect.appendChild(o);
  }
  modeSelect.title = 'Permission mode';
  modelSelect.title = 'Model';

  const toolbar = el('div', 'composer-toolbar');
  toolbar.append(modeSelect, modelSelect, statusTextEl);
  slashMenu.hidden = true;
  slashMenu.setAttribute('role', 'listbox');
  composerEl.append(slashMenu, inputRow, toolbar);

  errorEl.hidden = true;
  dockColumn.append(cardEl, errorEl, composerEl);
  dockEl.appendChild(dockColumn);
  root.append(headerEl, scrollEl, dockEl);
}

function chip(cls: string, iconName: string, text: string, title?: string): HTMLElement {
  const c = el('span', 'chip ' + cls);
  c.appendChild(icon(iconName));
  c.appendChild(el('span', undefined, text));
  if (title) c.title = title;
  return c;
}

function renderHeader(): void {
  clear(headerEl);
  if (!header) return;
  const bar = el('div', 'header-bar');
  const title = el('span', 'header-title', header.title);
  title.title = header.sessionId ? header.title + '\n' + header.sessionId : header.title;
  bar.append(title, chip('project', 'folder', header.projectName, header.cwd));

  if (header.branch) {
    const b = button('chip clickable', undefined, 'Switch branch');
    b.appendChild(icon('git-branch'));
    b.appendChild(el('span', undefined, header.branch));
    b.addEventListener('click', () => post({ type: 'switchBranch' }));
    bar.appendChild(b);
  }
  if (header.entrypoint) bar.appendChild(chip('source', 'plug', header.entrypoint, 'Started from ' + header.entrypoint));

  stateChip = chip('state', STATE_ICON[status.state], STATE_TEXT[status.state]);
  bar.appendChild(stateChip);
  headerEl.appendChild(bar);
  renderEmptyState();

  if (header.readOnly) {
    const banner = el('div', 'banner readonly');
    banner.appendChild(icon('lock'));
    banner.appendChild(el('span', 'banner-text', header.readOnlyReason || 'This session is driven elsewhere.'));
    if (header.canTakeOver) {
      const take = button('btn small primary', 'Take over');
      take.title = 'Stop the other Claude process and continue this session here';
      take.addEventListener('click', () => post({ type: 'takeOver' }));
      banner.appendChild(take);
    }
    headerEl.appendChild(banner);
  }
  syncControls();
}

function syncControls(): void {
  const all = header?.models || [];
  const models = all.filter((m) => m.value !== 'default');
  const wanted = header?.model || '';
  clear(modelSelect);
  const resolvedDefault = all.find((m) => m.value === 'default')?.description?.split(' · ')[0];
  const def = el('option', undefined, resolvedDefault ? `Default (${resolvedDefault})` : 'Default model');
  def.value = '';
  modelSelect.appendChild(def);
  for (const m of models) {
    const o = el('option', undefined, m.label);
    o.value = m.value;
    if (m.description) o.title = m.description;
    modelSelect.appendChild(o);
  }
  if (wanted && !models.some((m) => m.value === wanted)) {
    const o = el('option', undefined, wanted);
    o.value = wanted;
    modelSelect.appendChild(o);
  }
  modelSelect.value = wanted;
  modeSelect.value = header?.permissionMode || 'default';

  const readOnly = !!header?.readOnly;
  if (readOnly) hideSlashMenu();
  input.disabled = readOnly;
  sendBtn.disabled = readOnly;
  modeSelect.disabled = readOnly;
  modelSelect.disabled = readOnly;
  input.placeholder = readOnly ? header?.readOnlyReason || 'Read-only session' : 'Ask Claude to do something…';
  root.classList.toggle('read-only', readOnly);
}

function renderStatus(): void {
  if (stateChip) {
    const i = stateChip.firstElementChild;
    if (i) i.className = 'codicon codicon-' + STATE_ICON[status.state];
    const t = stateChip.lastElementChild;
    if (t) t.textContent = STATE_TEXT[status.state];
    stateChip.className = 'chip state s-' + status.state;
    stateChip.title = status.detail || STATE_TEXT[status.state];
  }
  statusTextEl.textContent = status.detail || STATE_TEXT[status.state];
  statusTextEl.className = 'status-text s-' + status.state;
  const running = status.state === 'working' || status.state === 'waiting' || status.state === 'starting';
  stopBtn.hidden = !running || !!header?.readOnly;
  sendBtn.hidden = !stopBtn.hidden;
}

let stick = true;

function atBottom(): boolean {
  return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 48;
}

function scrollToBottom(): void {
  scrollEl.scrollTop = scrollEl.scrollHeight;
}

function watchScroll(): void {
  scrollEl.addEventListener('scroll', () => (stick = atBottom()));
  if (typeof ResizeObserver === 'undefined') return;
  const observer = new ResizeObserver(() => {
    if (stick) scrollToBottom();
  });
  observer.observe(columnEl);
  observer.observe(dockEl);
}

function containerFor(item: ChatItem): HTMLElement {
  if (item.kind === 'tool' && item.parentToolUseId) {
    const parent = nodes.get(item.parentToolUseId);
    const host = parent && toolChildren(parent);
    if (host) return host;
  }
  return listEl;
}

/** Keeps the first visible row where it is, so content inserted above the viewport does not shift it. */
function takeAnchor(): { id: string; top: number } | undefined {
  const viewTop = scrollEl.getBoundingClientRect().top;
  for (const child of Array.from(listEl.children) as HTMLElement[]) {
    const box = child.getBoundingClientRect();
    if (box.bottom > viewTop && child.dataset.id) return { id: child.dataset.id, top: box.top - viewTop };
  }
  return undefined;
}

function restoreAnchor(anchor: { id: string; top: number }): void {
  const node = nodes.get(anchor.id);
  if (!node || !node.isConnected) return;
  const delta = node.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - anchor.top;
  if (delta) scrollEl.scrollTop += delta;
}

function reparentOrphans(): void {
  for (const id of [...orphans]) {
    const node = nodes.get(id);
    const parentId = node?.dataset.parent;
    if (!node || !parentId) {
      orphans.delete(id);
      continue;
    }
    const parent = nodes.get(parentId);
    const host = parent && toolChildren(parent);
    if (!host) continue;
    node.classList.remove('orphan-child');
    host.appendChild(node);
    orphans.delete(id);
  }
}

function renderEmptyState(): void {
  const show = !listEl.firstChild && !partialEl.firstChild;
  emptyEl.hidden = !show;
  if (!show) return;
  clear(emptyEl);
  const mark = icon('comment-discussion');
  mark.classList.add('empty-icon');
  emptyEl.append(mark, el('div', 'empty-title', header?.projectName ? `New session in ${header.projectName}` : 'New session'));
  emptyEl.appendChild(el('div', 'empty-hint', 'Ask Claude to do something. Enter sends, Shift+Enter adds a line.'));
}

function applyItems(items: ChatItem[]): void {
  const wasStick = stick;
  const anchor = wasStick ? undefined : takeAnchor();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const old = nodes.get(item.id);
    const node = renderItem(item, handlers);
    if (item.kind === 'tool' && item.parentToolUseId) {
      node.dataset.parent = item.parentToolUseId;
      if (containerFor(item) === listEl) {
        node.classList.add('orphan-child');
        orphans.add(item.id);
      }
    }
    if (old) {
      const oldChildren = toolChildren(old);
      const newChildren = toolChildren(node);
      if (oldChildren && newChildren) while (oldChildren.firstChild) newChildren.appendChild(oldChildren.firstChild);
      if (old.classList.contains('open')) {
        node.classList.add('open');
        const chev = node.querySelector('.chev');
        if (chev) chev.className = 'codicon codicon-chevron-down chev';
      }
      const container = containerFor(item);
      if (old.parentElement && old.parentElement !== container) {
        old.remove();
        container.appendChild(node);
      } else {
        old.replaceWith(node);
      }
    } else {
      const container = containerFor(item);
      let anchor: HTMLElement | null = null;
      for (let j = i + 1; j < items.length && !anchor; j++) {
        const next = nodes.get(items[j].id);
        if (next && next.parentElement === container) anchor = next;
      }
      if (anchor) container.insertBefore(node, anchor);
      else container.appendChild(node);
    }
    nodes.set(item.id, node);
  }

  reparentOrphans();
  renderEmptyState();
  if (wasStick) scrollToBottom();
  else if (anchor) restoreAnchor(anchor);
}

function renderOlder(count: number): void {
  clear(olderEl);
  if (count <= 0) return;
  olderEl.appendChild(
    showOlderButton(count, () => {
      waitingForOlder = true;
      clear(olderEl);
      olderEl.appendChild(el('div', 'older-loading', 'Loading earlier messages…'));
      post({ type: 'showOlder' });
    })
  );
}

function renderPartial(text: string | null): void {
  const wasStick = stick;
  clear(partialEl);
  if (text) {
    const wrap = el('div', 'item assistant streaming');
    wrap.appendChild(renderMarkdown(text, handlers));
    partialEl.appendChild(wrap);
  }
  renderEmptyState();
  if (wasStick) scrollToBottom();
}

function focusCard(card: HTMLElement): void {
  const active = document.activeElement as HTMLElement | null;
  if (active && (active === input || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
  const target =
    card.dataset.focus === 'allow'
      ? card.querySelector<HTMLElement>('.btn.primary')
      : card.querySelector<HTMLElement>('input, .btn.primary');
  target?.focus();
}

let permissionCard: { id: string; node: HTMLElement } | undefined;
let questionCard: { id: string; node: HTMLElement } | undefined;

function renderCards(): void {
  const fresh: HTMLElement[] = [];
  if (!permission) permissionCard = undefined;
  else if (permissionCard?.id !== permission.id) {
    const req = permission;
    const node = renderPermission(req, (decision: PermissionDecision, message?: string) => {
      post({ type: 'permissionResponse', id: req.id, decision, message });
      permission = undefined;
      renderCards();
    });
    permissionCard = { id: req.id, node };
    fresh.push(node);
  }
  if (!question) questionCard = undefined;
  else if (questionCard?.id !== question.id) {
    const req = question;
    const node = renderQuestion(req, (answers) => {
      post({ type: 'questionResponse', id: req.id, answers });
      question = undefined;
      renderCards();
    });
    questionCard = { id: req.id, node };
    fresh.push(node);
  }

  const wanted = [permissionCard?.node, questionCard?.node].filter(Boolean) as HTMLElement[];
  for (const child of Array.from(cardEl.children)) {
    if (!wanted.includes(child as HTMLElement)) child.remove();
  }
  wanted.forEach((node, i) => {
    if (cardEl.children[i] !== node) cardEl.insertBefore(node, cardEl.children[i] ?? null);
  });
  for (const node of fresh) focusCard(node);
}

function showError(message: string): void {
  clear(errorEl);
  errorEl.appendChild(icon('error'));
  errorEl.appendChild(el('span', 'banner-text', message));
  const close = button('icon-btn', undefined, 'Dismiss');
  close.appendChild(icon('close'));
  close.addEventListener('click', () => (errorEl.hidden = true));
  errorEl.appendChild(close);
  errorEl.hidden = false;
}

function autoGrow(): void {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 240) + 'px';
}

function saveState(): void {
  vscode.setState({ sessionId: header?.sessionId, cwd: header?.cwd, title: header?.title, draft: input.value });
}

function send(): void {
  const text = input.value.trim();
  if (!text || input.disabled) return;
  hideSlashMenu();
  menuDismissedFor = undefined;
  post({ type: 'send', text });
  lastSent = text;
  input.value = '';
  autoGrow();
  saveState();
  scrollToBottom();
}

function slashQuery(): string | undefined {
  const m = /^\/(\S*)$/.exec(input.value);
  if (!m || input.selectionStart !== input.selectionEnd) return undefined;
  return m[1].toLowerCase();
}

function rankCommand(c: CommandOption, q: string): number {
  const name = c.name.toLowerCase();
  if (!q || name.startsWith(q)) return 0;
  if (c.aliases?.some((a) => a.toLowerCase().startsWith(q))) return 1;
  if (name.split(/[:\-_]/).some((part) => part.startsWith(q))) return 2;
  if (name.includes(q)) return 3;
  if (q.length > 2 && c.description.toLowerCase().split(/[^a-z0-9]+/).some((word) => word.startsWith(q))) return 4;
  return -1;
}

function updateSlashMenu(): void {
  const q = slashQuery();
  if (q === undefined || input.disabled || menuDismissedFor === input.value) {
    hideSlashMenu();
    return;
  }
  if (!warmed) {
    warmed = true;
    post({ type: 'warm' });
  }
  const previous = q === menuQuery ? menuMatches[menuIndex]?.name : undefined;
  menuQuery = q;
  menuMatches = commands
    .map((c) => ({ c, rank: rankCommand(c, q) }))
    .filter((r) => r.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.c.name.localeCompare(b.c.name))
    .map((r) => r.c);
  const keep = previous ? menuMatches.findIndex((c) => c.name === previous) : -1;
  menuIndex = keep >= 0 ? keep : 0;
  renderSlashMenu();
}

function renderSlashMenu(): void {
  clear(slashMenu);
  if (!menuMatches.length) {
    slashMenu.appendChild(el('div', 'slash-empty', commands.length ? 'No matching commands' : 'Loading commands…'));
  }
  menuMatches.forEach((c, i) => {
    const row = el('div', 'slash-item' + (i === menuIndex ? ' selected' : ''));
    row.setAttribute('role', 'option');
    const name = el('span', 'slash-name', '/' + c.name);
    row.appendChild(name);
    if (c.argumentHint) row.appendChild(el('span', 'slash-hint', c.argumentHint));
    if (c.description) row.appendChild(el('span', 'slash-desc', c.description));
    row.title = c.description;
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      menuIndex = i;
      acceptCommand(false);
    });
    slashMenu.appendChild(row);
  });
  slashMenu.hidden = false;
  slashMenu.children[menuIndex]?.scrollIntoView({ block: 'nearest' });
}

function hideSlashMenu(): void {
  menuQuery = undefined;
  if (slashMenu.hidden) return;
  slashMenu.hidden = true;
  clear(slashMenu);
}

function moveSlashSelection(delta: number): void {
  if (!menuMatches.length) return;
  menuIndex = (menuIndex + delta + menuMatches.length) % menuMatches.length;
  renderSlashMenu();
}

function needsArguments(c: CommandOption): boolean {
  const hint = c.argumentHint?.trim();
  return !!hint && !hint.startsWith('[') && !/optional/i.test(hint);
}

/** Completes the highlighted command; with `run`, one that needs no arguments (or is typed out in full) is sent straight away. */
function acceptCommand(run: boolean): void {
  const c = menuMatches[menuIndex];
  if (!c) return;
  hideSlashMenu();
  if (run && (!needsArguments(c) || input.value === '/' + c.name)) {
    input.value = '/' + c.name;
    send();
    return;
  }
  input.value = '/' + c.name + ' ';
  input.setSelectionRange(input.value.length, input.value.length);
  input.focus();
  autoGrow();
  saveState();
}

function wireComposer(): void {
  input.addEventListener('input', () => {
    autoGrow();
    saveState();
    updateSlashMenu();
  });
  input.addEventListener('blur', hideSlashMenu);
  input.addEventListener('click', updateSlashMenu);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (!slashMenu.hidden) {
      const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveSlashSelection(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        menuDismissedFor = input.value;
        hideSlashMenu();
        return;
      }
      if ((e.key === 'Tab' || e.key === 'Enter') && plain && menuMatches.length) {
        e.preventDefault();
        acceptCommand(e.key === 'Enter');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === 'ArrowUp' && !input.value && lastSent) {
      e.preventDefault();
      input.value = lastSent;
      autoGrow();
      saveState();
    }
  });
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => post({ type: 'interrupt' }));
  modeSelect.addEventListener('change', () => post({ type: 'setPermissionMode', mode: modeSelect.value as PermissionModeName }));
  modelSelect.addEventListener('change', () => post({ type: 'setModel', model: modelSelect.value }));

  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
    if (permission) {
      if (e.key === 'Escape') {
        e.preventDefault();
        post({ type: 'permissionResponse', id: permission.id, decision: 'deny' });
        permission = undefined;
        renderCards();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        post({ type: 'permissionResponse', id: permission.id, decision: 'allow' });
        permission = undefined;
        renderCards();
        return;
      }
    }
    if (question && e.key === 'Escape') {
      e.preventDefault();
      post({ type: 'questionResponse', id: question.id, answers: null });
      question = undefined;
      renderCards();
    }
  });
}

function onMessage(message: HostToView): void {
  switch (message.type) {
    case 'init':
      header = message.header;
      status = message.status;
      nodes.clear();
      orphans.clear();
      clear(listEl);
      stick = true;
      renderHeader();
      renderStatus();
      renderOlder(message.hiddenOlder);
      applyItems(message.items);
      scrollToBottom();
      saveState();
      break;
    case 'items':
      if (waitingForOlder) {
        waitingForOlder = false;
        clear(olderEl);
      }
      applyItems(message.items);
      break;
    case 'header':
      header = message.header;
      renderHeader();
      renderStatus();
      saveState();
      break;
    case 'status':
      status = message.status;
      renderStatus();
      break;
    case 'partial':
      renderPartial(message.text);
      break;
    case 'permission':
      permission = message.request || undefined;
      renderCards();
      break;
    case 'question':
      question = message.request || undefined;
      renderCards();
      break;
    case 'error':
      showError(message.message);
      break;
    case 'restoreDraft':
      input.value = input.value.trim() ? message.text + '\n\n' + input.value : message.text;
      autoGrow();
      saveState();
      input.focus();
      break;
    case 'focusComposer':
      input.focus();
      break;
    case 'commands':
      commands = message.commands;
      if (!slashMenu.hidden) updateSlashMenu();
      break;
  }
}

buildLayout();
wireComposer();
watchScroll();
autoGrow();
renderStatus();
window.addEventListener('message', (e: MessageEvent<HostToView>) => onMessage(e.data));
post({ type: 'ready' });
