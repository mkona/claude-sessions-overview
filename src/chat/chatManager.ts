import * as path from 'path';
import * as vscode from 'vscode';
import { SessionInfo } from '../types';
import { realPath } from '../util';
import { ActiveChat, ChatPanel, ChatPanelDeps, CHAT_VIEW_TYPE, chatPanelOptions, chatTabTitle, OpenIntent } from './chatPanel';

export interface ChatManagerDeps extends ChatPanelDeps {
  /** Where the list of open chat tabs is remembered so a window reload can restore them. */
  state?: vscode.Memento;
}

export type { ActiveChat } from './chatPanel';

const RESTORE_TIMEOUT_MS = 20_000;
const RECOVER_GRACE_MS = 1500;
const RECOVER_TAB_WAIT_MS = 8000;
const RECOVER_POLL_MS = 250;
const OPEN_CHATS_KEY = 'claudeSessions.openChats';

export interface SavedChat {
  sessionId?: string;
  cwd: string;
  title: string;
  active?: boolean;
}

export class ChatManager implements vscode.Disposable {
  private readonly panels: ChatPanel[] = [];
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly activeEmitter = new vscode.EventEmitter<ActiveChat | undefined>();
  private readonly ownedEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingRestore: { panel: vscode.WebviewPanel; sessionId: string; timer: NodeJS.Timeout }[] = [];
  private activePanel?: ChatPanel;
  private activeChat?: ActiveChat;
  private ownedKey = '';
  private savedQueue?: SavedChat[];
  private recovery?: Promise<void>;
  private shuttingDown = false;

  readonly onDidChangeActive = this.activeEmitter.event;
  readonly onDidChangeOwned = this.ownedEmitter.event;

  constructor(private readonly deps: ChatManagerDeps) {
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer(CHAT_VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, state) => this.restore(panel, state),
      }),
    );
  }

  active(): ActiveChat | undefined {
    return this.activeChat;
  }

  ownedSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const panel of this.panels) {
      if (panel.owned && panel.sessionId) ids.add(panel.sessionId);
    }
    return ids;
  }

  async open(session: SessionInfo, opts?: { preserveFocus?: boolean }): Promise<void> {
    await this.recovered();
    this.sessions.set(session.sessionId, session);
    const existing = this.panels.find((p) => p.sessionId === session.sessionId);
    if (existing) {
      existing.updateSession(session);
      existing.reveal(opts?.preserveFocus === true);
      this.noteActive(existing);
    } else {
      const panel = ChatPanel.create(
        this.deps,
        { sessionId: session.sessionId, cwd: session.cwd, title: session.title, session },
        opts,
      );
      this.track(panel);
    }
    await this.ensureFolder(session.cwd, { sessionId: session.sessionId, cwd: session.cwd });
  }

  /** Open a chat for a session id that the session store does not (yet) know about. */
  async openById(sessionId: string, cwd: string, title?: string): Promise<void> {
    await this.recovered();
    const known = this.sessions.get(sessionId);
    if (known) {
      await this.open(known);
      return;
    }
    const existing = this.panels.find((p) => p.sessionId === sessionId);
    if (existing) {
      existing.reveal(false);
      this.noteActive(existing);
    } else {
      this.track(ChatPanel.create(this.deps, { sessionId, cwd, title: title || path.basename(cwd) || cwd }));
    }
    await this.ensureFolder(cwd, { sessionId, cwd });
  }

  async newSession(folder: string): Promise<void> {
    await this.recovered();
    // Claude reports file paths and its own cwd resolved through symlinks, so start from the real path.
    const cwd = realPath(folder);
    const title = `New session · ${path.basename(cwd) || cwd}`;
    const reused = this.freshPanel(cwd);
    const panel = reused ?? ChatPanel.create(this.deps, { cwd, title });
    if (reused) {
      panel.reveal(false);
      this.noteActive(panel);
    } else this.track(panel);
    await this.ensureFolder(cwd, { cwd });
    panel.focusComposer();
  }

  updateSessions(sessions: SessionInfo[]): void {
    this.sessions.clear();
    for (const session of sessions) this.sessions.set(session.sessionId, session);
    this.resolveRestores();
    for (const panel of this.panels) {
      panel.updateSession(panel.sessionId ? this.sessions.get(panel.sessionId) : undefined);
    }
    this.syncActive();
    this.fireOwned();
  }

  dispose(): void {
    this.shuttingDown = true;
    for (const entry of this.pendingRestore) {
      clearTimeout(entry.timer);
      entry.panel.dispose();
    }
    this.pendingRestore.length = 0;
    for (const panel of [...this.panels]) panel.dispose();
    this.panels.length = 0;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.activeEmitter.dispose();
    this.ownedEmitter.dispose();
  }

  openChats(): SavedChat[] {
    return this.panels.map((p) => ({ sessionId: p.sessionId, cwd: p.cwd, title: p.info.title, active: p === this.activePanel }));
  }

  /**
   * After the extension host restarts (adding a workspace folder does that), chat tabs from before can stay
   * on screen as dead webviews that VS Code never hands back to the serializer, and background tabs of a
   * reloaded window are only deserialized once clicked. Close every chat tab no panel owns and reopen it.
   */
  async recoverTabs(saved: SavedChat[] = []): Promise<void> {
    this.recovery = this.runRecovery(saved);
    await this.recovery;
  }

  /** Opening a chat while recovery runs would leave the dead tab of that same session on screen. */
  private async recovered(): Promise<void> {
    try {
      await this.recovery;
    } catch {
      /* recovery problems are logged where they happen */
    }
  }

  private async runRecovery(saved: SavedChat[]): Promise<void> {
    await delay(RECOVER_GRACE_MS);
    const stored = this.deps.state?.get<SavedChat[]>(OPEN_CHATS_KEY, []) ?? [];
    const candidates = [...saved, ...stored].filter((c) => c && typeof c.cwd === 'string' && c.cwd.length > 0);
    if (!candidates.length) return;
    // A reloading window restores its editors after the extension host is up, so wait for the tabs.
    for (let waited = 0; waited < RECOVER_TAB_WAIT_MS && !this.chatTabs().length; waited += RECOVER_POLL_MS) await delay(RECOVER_POLL_MS);
    const claimed = new Set([...this.panels.map((p) => chatTabTitle(p.info.title)), ...this.pendingRestore.map((e) => e.panel.title)]);
    const reopen: SavedChat[] = [];
    for (const tab of this.chatTabs()) {
      if (claimed.has(tab.label)) continue;
      const index = candidates.findIndex((c) => chatTabTitle(c.title) === tab.label);
      if (index < 0) continue;
      const [chat] = candidates.splice(index, 1);
      if (!reopen.some((r) => r.sessionId && r.sessionId === chat.sessionId)) reopen.push({ ...chat, active: tab.isActive && tab.group.isActive });
      await vscode.window.tabGroups.close(tab, true);
    }
    reopen.sort((a, b) => Number(!!a.active) - Number(!!b.active));
    for (const chat of reopen) {
      if (chat.sessionId && this.panels.some((p) => p.sessionId === chat.sessionId)) continue;
      const session = chat.sessionId ? this.sessions.get(chat.sessionId) : undefined;
      const panel = ChatPanel.create(
        this.deps,
        { sessionId: chat.sessionId, cwd: chat.cwd, title: session?.title ?? chat.title, session },
        { preserveFocus: !chat.active },
      );
      this.track(panel);
    }
    if (reopen.length) this.deps.log.appendLine(`Reopened ${reopen.length} chat tab(s) after the extension host started.`);
  }

  private chatTabs(): vscode.Tab[] {
    const out: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { viewType?: unknown } | undefined;
        if (typeof input?.viewType === 'string' && input.viewType.endsWith(CHAT_VIEW_TYPE)) out.push(tab);
      }
    }
    return out;
  }

  /** A restored tab for a project that already has an empty chat open is the other half of a host restart. */
  private duplicateOfFresh(sessionId: string | undefined, cwd: string): boolean {
    return !sessionId && !!this.freshPanel(realPath(cwd));
  }

  private freshPanel(cwd: string): ChatPanel | undefined {
    return this.panels.find((p) => p.fresh && realPath(p.cwd) === cwd);
  }

  private track(panel: ChatPanel): void {
    this.panels.push(panel);
    panel.onDidChangeState(() => {
      this.syncActive();
      this.fireOwned();
      this.saveOpenChats();
    });
    panel.onDidChangeViewState(() => {
      if (panel.active) this.noteActive(panel);
    });
    panel.onDidDispose(() => {
      const index = this.panels.indexOf(panel);
      if (index >= 0) this.panels.splice(index, 1);
      if (this.activePanel === panel) {
        this.activePanel = this.panels[this.panels.length - 1];
        this.setActive(this.activePanel?.info);
      }
      this.fireOwned();
      this.saveOpenChats();
    });
    this.noteActive(panel);
    this.fireOwned();
    this.saveOpenChats();
  }

  private saveOpenChats(): void {
    const store = this.deps.state;
    if (!store || this.shuttingDown) return;
    const open: SavedChat[] = this.panels.map((p) => ({ sessionId: p.sessionId, cwd: p.cwd, title: p.info.title }));
    // A reloaded window deserializes background tabs only when they are shown; dropping them from the
    // saved list here would leave them dead on screen, with no way to reopen them later.
    const covered = new Set(open.map((c) => chatTabTitle(c.title)));
    const previous = store.get<SavedChat[]>(OPEN_CHATS_KEY, []) ?? [];
    for (const tab of this.chatTabs()) {
      if (covered.has(tab.label)) continue;
      const kept = previous.find((c) => c && typeof c.cwd === 'string' && chatTabTitle(c.title ?? '') === tab.label);
      if (!kept) continue;
      open.push({ sessionId: kept.sessionId, cwd: kept.cwd, title: kept.title });
      covered.add(tab.label);
    }
    void store.update(OPEN_CHATS_KEY, open);
  }

  private takeSaved(tabTitle: string): SavedChat | undefined {
    if (!this.savedQueue) {
      const stored = this.deps.state?.get<SavedChat[]>(OPEN_CHATS_KEY, []) ?? [];
      this.savedQueue = stored.filter((s) => s && typeof s.cwd === 'string' && s.cwd.length > 0);
    }
    if (!this.savedQueue.length) return undefined;
    const matched = this.savedQueue.findIndex((s) => chatTabTitle(s.title ?? '') === tabTitle);
    if (matched < 0) return undefined;
    const [found] = this.savedQueue.splice(matched, 1);
    return found;
  }

  private async ensureFolder(cwd: string, intent: OpenIntent): Promise<void> {
    try {
      await this.deps.ensureProjectFolder(cwd, intent);
    } catch (err) {
      this.deps.log.appendLine(`chat: could not add ${cwd} to the workspace: ${String(err)}`);
    }
  }

  private noteActive(panel: ChatPanel): void {
    this.activePanel = panel;
    this.setActive(panel.info);
  }

  private syncActive(): void {
    if (this.activePanel) this.setActive(this.activePanel.info);
  }

  private setActive(next: ActiveChat | undefined): void {
    if (sameChat(next, this.activeChat)) return;
    this.activeChat = next;
    this.activeEmitter.fire(next);
  }

  private fireOwned(): void {
    const key = [...this.ownedSessionIds()].sort().join(',');
    if (key === this.ownedKey) return;
    this.ownedKey = key;
    this.ownedEmitter.fire();
  }

  private async restore(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const s = (state ?? {}) as { sessionId?: unknown; cwd?: unknown; title?: unknown };
    const sessionId = typeof s.sessionId === 'string' ? s.sessionId : undefined;
    const cwd = typeof s.cwd === 'string' ? s.cwd : undefined;
    const title = (typeof s.title === 'string' && s.title) || panel.title || 'Claude';
    if (sessionId && this.panels.some((p) => p.sessionId === sessionId)) {
      panel.dispose();
      return;
    }
    if (cwd) {
      if (this.duplicateOfFresh(sessionId, cwd)) {
        panel.dispose();
        return;
      }
      this.adopt(panel, { sessionId, cwd, title, session: sessionId ? this.sessions.get(sessionId) : undefined });
      return;
    }
    const saved = this.takeSaved(panel.title);
    if (saved && !this.panels.some((p) => saved.sessionId && p.sessionId === saved.sessionId)) {
      const id = sessionId ?? saved.sessionId;
      if (this.duplicateOfFresh(id, saved.cwd)) {
        panel.dispose();
        return;
      }
      this.adopt(panel, { sessionId: id, cwd: saved.cwd, title: saved.title || title, session: id ? this.sessions.get(id) : undefined });
      return;
    }
    if (!sessionId) {
      panel.dispose();
      return;
    }
    const known = this.sessions.get(sessionId);
    if (known) {
      this.adopt(panel, { sessionId, cwd: known.cwd, title: known.title, session: known });
      return;
    }
    const entry = {
      panel,
      sessionId,
      timer: setTimeout(() => {
        this.dropRestore(panel);
        panel.dispose();
      }, RESTORE_TIMEOUT_MS),
    };
    this.pendingRestore.push(entry);
    panel.onDidDispose(() => this.dropRestore(panel));
  }

  private resolveRestores(): void {
    for (const entry of [...this.pendingRestore]) {
      const session = this.sessions.get(entry.sessionId);
      if (!session) continue;
      this.dropRestore(entry.panel);
      this.adopt(entry.panel, { sessionId: session.sessionId, cwd: session.cwd, title: session.title, session });
    }
  }

  private dropRestore(panel: vscode.WebviewPanel): void {
    const index = this.pendingRestore.findIndex((e) => e.panel === panel);
    if (index < 0) return;
    clearTimeout(this.pendingRestore[index].timer);
    this.pendingRestore.splice(index, 1);
  }

  private adopt(panel: vscode.WebviewPanel, init: { sessionId?: string; cwd: string; title: string; session?: SessionInfo }): void {
    panel.webview.options = chatPanelOptions(this.deps.extensionUri);
    this.track(new ChatPanel(panel, this.deps, init));
    void this.ensureFolder(init.cwd, { sessionId: init.sessionId, cwd: init.cwd });
  }
}

function sameChat(a: ActiveChat | undefined, b: ActiveChat | undefined): boolean {
  if (!a || !b) return a === b;
  return a.sessionId === b.sessionId && a.cwd === b.cwd && a.title === b.title && a.transcriptPath === b.transcriptPath;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
