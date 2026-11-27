import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveClaudeExecutable } from '../agent/claudePath';
import { PermissionAnswer, PermissionAsk, RunnerEvents, SessionRunner } from '../agent/runner';
import { isPidAlive } from '../store';
import { Entrypoint, entrypointLabel, SessionInfo } from '../types';
import { ChatModel, toolTitle } from './chatModel';
import {
  ChatItem,
  HostToView,
  PermissionModeName,
  PermissionRequestView,
  QuestionRequestView,
  QuestionView,
  RunStatus,
  SessionHeader,
  ViewToHost,
} from './protocol';
import { expectedTranscriptPath, findTranscriptPath, TranscriptTail } from './transcriptTail';

export const CHAT_VIEW_TYPE = 'claudeSessions.chat';

const ITEM_FLUSH_MS = 30;
const INITIAL_ITEMS = 300;
const TITLE_MAX = 30;
const BRANCH_THROTTLE_MS = 5000;
const TRANSCRIPT_WAIT_TRIES = 120;

/** What to reopen when adding the project folder restarts the extension host. */
export interface OpenIntent {
  sessionId?: string;
  cwd: string;
}

export interface ChatPanelDeps {
  extensionUri: vscode.Uri;
  claudeDir: () => string;
  claudeCommand: () => string;
  log: vscode.OutputChannel;
  defaultPermissionMode: () => PermissionModeName;
  defaultModel: () => string | undefined;
  idleShutdownMinutes: () => number;
  ensureProjectFolder: (cwd: string, intent: OpenIntent) => Promise<void>;
  openDiff: (sessionId: string, cwd: string, filePath: string) => Promise<void>;
  switchBranch: (cwd: string) => Promise<void>;
  currentBranch: (cwd: string) => Promise<string | undefined>;
  resumeInTerminal: (session: SessionInfo) => void;
}

export interface ActiveChat {
  sessionId?: string;
  cwd: string;
  title: string;
  transcriptPath?: string;
}

export interface ChatPanelInit {
  sessionId?: string;
  cwd: string;
  title: string;
  session?: SessionInfo;
}

interface PendingPermission {
  request: PermissionRequestView;
  resolve: (answer: PermissionAnswer) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

interface PendingQuestion {
  request: QuestionRequestView;
  resolve: (answers: Record<string, string> | null) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

export class ChatPanel implements vscode.Disposable {
  private model = new ChatModel();
  private readonly stateEmitter = new vscode.EventEmitter<void>();
  private readonly viewStateEmitter = new vscode.EventEmitter<void>();
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingItems = new Map<string, ChatItem>();
  private permissionQueue: PendingPermission[] = [];
  private questionQueue: PendingQuestion[] = [];

  private header: SessionHeader;
  private status: RunStatus = { state: 'idle' };
  private session?: SessionInfo;
  private id?: string;
  private tail?: TranscriptTail;
  private transcript?: string;
  private runner?: SessionRunner;
  private starting?: Promise<SessionRunner | undefined>;
  private startedHere = false;
  private ready = false;
  private disposed = false;
  private flushTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private lastActivity = Date.now();
  private branchCheckedAt = 0;
  private seq = 0;

  readonly onDidChangeState = this.stateEmitter.event;
  readonly onDidChangeViewState = this.viewStateEmitter.event;
  readonly onDidDispose = this.disposeEmitter.event;

  static create(deps: ChatPanelDeps, init: ChatPanelInit, opts?: { preserveFocus?: boolean }): ChatPanel {
    const panel = vscode.window.createWebviewPanel(
      CHAT_VIEW_TYPE,
      tabTitle(init.title),
      { viewColumn: vscode.ViewColumn.One, preserveFocus: opts?.preserveFocus === true },
      chatPanelOptions(deps.extensionUri),
    );
    return new ChatPanel(panel, deps, init);
  }

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: ChatPanelDeps,
    init: ChatPanelInit,
  ) {
    this.id = init.sessionId;
    this.session = init.session;
    this.header = {
      sessionId: init.sessionId,
      title: init.title,
      cwd: init.cwd,
      projectName: path.basename(init.cwd) || init.cwd,
      entrypoint: entrypointLabel(init.session?.entrypoint ?? 'sdk'),
      branch: init.session?.gitBranch,
      readOnly: false,
      models: [],
      model: deps.defaultModel(),
      permissionMode: deps.defaultPermissionMode(),
    };
    this.refreshReadOnly();

    panel.webview.options = chatPanelOptions(deps.extensionUri);
    panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, 'media', 'claude.svg');
    panel.title = tabTitle(init.title);
    panel.webview.html = this.html();

    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg as ViewToHost)),
      panel.onDidChangeViewState(() => this.viewStateEmitter.fire()),
      panel.onDidDispose(() => this.dispose()),
    );

    void this.initTranscript();
    void this.refreshBranch();
  }

  get cwd(): string {
    return this.header.cwd;
  }

  get sessionId(): string | undefined {
    return this.id;
  }

  get owned(): boolean {
    return this.startedHere;
  }

  get active(): boolean {
    return !this.disposed && this.panel.active;
  }

  /** A chat tab that has no session yet and nothing in it, so another "new session" can reuse it. */
  get fresh(): boolean {
    return !this.disposed && !this.id && !this.runner && this.model.items().length === 0;
  }

  get info(): ActiveChat {
    return { sessionId: this.id, cwd: this.cwd, title: this.header.title, transcriptPath: this.transcript };
  }

  reveal(preserveFocus = false): void {
    this.panel.reveal(vscode.ViewColumn.One, preserveFocus);
  }

  focusComposer(): void {
    this.post({ type: 'focusComposer' });
  }

  updateSession(session: SessionInfo | undefined): void {
    if (this.disposed) return;
    if (session) {
      this.session = session;
      if (!this.tail && session.transcriptPath) this.startTail(session.transcriptPath);
      this.setTitle(session.title);
    } else if (this.session?.live) {
      this.session = { ...this.session, live: false, state: 'ended' };
    }
    this.refreshEntrypoint();
    this.refreshReadOnly();
    void this.refreshBranch();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const pending of this.permissionQueue) {
      pending.signal.removeEventListener('abort', pending.onAbort);
      pending.resolve({ decision: 'deny', message: 'Chat closed' });
    }
    this.permissionQueue = [];
    for (const pending of this.questionQueue) {
      pending.signal.removeEventListener('abort', pending.onAbort);
      pending.resolve(null);
    }
    this.questionQueue = [];
    this.tail?.dispose();
    this.tail = undefined;
    this.runner?.dispose();
    this.runner = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.panel.dispose();
    this.disposeEmitter.fire();
    this.stateEmitter.dispose();
    this.viewStateEmitter.dispose();
    this.disposeEmitter.dispose();
  }

  private onMessage(msg: ViewToHost): void {
    if (!msg || typeof msg.type !== 'string' || this.disposed) return;
    switch (msg.type) {
      case 'ready':
        this.onReady();
        return;
      case 'send':
        void this.handleSend(msg.text);
        return;
      case 'interrupt':
        void this.runner?.interrupt();
        this.touch();
        return;
      case 'setPermissionMode':
        this.header.permissionMode = msg.mode;
        this.postHeader();
        void this.runner?.setPermissionMode(msg.mode);
        return;
      case 'setModel': {
        const model = msg.model || undefined;
        this.header.model = model;
        this.postHeader();
        void this.runner?.setModel(model);
        return;
      }
      case 'permissionResponse':
        this.answerPermission(msg.id, msg.decision, msg.message);
        return;
      case 'questionResponse':
        this.answerQuestion(msg.id, msg.answers);
        return;
      case 'openFile':
        void this.openFile(msg.path, msg.line);
        return;
      case 'openDiff':
        void this.openDiff(msg.path);
        return;
      case 'openLink':
        if (/^https?:\/\//i.test(msg.href)) void vscode.env.openExternal(vscode.Uri.parse(msg.href));
        return;
      case 'switchBranch':
        void this.handleSwitchBranch();
        return;
      case 'openInTerminal':
        this.openInTerminal();
        return;
      case 'takeOver':
        void this.takeOver();
        return;
      case 'showOlder':
        this.post({ type: 'items', items: this.model.items() });
        return;
      default:
        return;
    }
  }

  private onReady(): void {
    this.ready = true;
    this.pendingItems.clear();
    const all = this.model.items();
    const hiddenOlder = Math.max(0, all.length - INITIAL_ITEMS);
    this.post({ type: 'init', header: this.header, items: all.slice(hiddenOlder), hiddenOlder, status: this.status });
    const permission = this.permissionQueue[0];
    if (permission) this.post({ type: 'permission', request: permission.request });
    const question = this.questionQueue[0];
    if (question) this.post({ type: 'question', request: question.request });
  }

  private async handleSend(text: string): Promise<void> {
    if (!text || !text.trim()) return;
    if (this.header.readOnly) {
      this.post({ type: 'error', message: this.header.readOnlyReason ?? 'This session is read-only.' });
      return;
    }
    const runner = await this.ensureRunner();
    if (!runner) return;
    this.touch();
    runner.send(text);
  }

  private ensureRunner(): Promise<SessionRunner | undefined> {
    if (this.runner) return Promise.resolve(this.runner);
    if (!this.starting) {
      const pending = this.createRunner();
      this.starting = pending;
      void pending.catch(() => undefined).then(() => (this.starting = undefined));
    }
    return this.starting;
  }

  private async createRunner(): Promise<SessionRunner | undefined> {
    const command = this.deps.claudeCommand();
    const claudePath = await resolveClaudeExecutable(command);
    if (this.disposed) return undefined;
    if (!claudePath) {
      const message = `Claude CLI not found (tried “${command}”). Set claudeSessions.claudeCommand to the full path.`;
      this.post({ type: 'error', message });
      this.setStatus({ state: 'error', detail: 'Claude CLI not found' });
      this.deps.log.appendLine(`chat: ${message}`);
      return undefined;
    }
    this.setStatus({ state: 'starting' });
    const runner = new SessionRunner(
      { cwd: this.cwd, claudePath, resume: this.id, model: this.header.model, permissionMode: this.header.permissionMode },
      this.runnerEvents(),
    );
    this.runner = runner;
    this.startedHere = true;
    this.refreshEntrypoint();
    this.refreshReadOnly();
    this.stateEmitter.fire();
    this.scheduleIdleCheck();
    return runner;
  }

  private runnerEvents(): RunnerEvents {
    return {
      sessionId: (id) => this.bindSessionId(id),
      status: (s) => this.setStatus(s),
      partial: (text) => {
        this.touch();
        this.post({ type: 'partial', text });
      },
      message: (m) => this.ingest([m]),
      permission: (ask, signal) => this.askPermission(ask, signal),
      question: (questions, signal) => this.askQuestion(questions, signal),
      models: (list) => {
        this.header.models = list;
        this.postHeader();
      },
      permissionModeChanged: (mode) => {
        this.header.permissionMode = mode;
        this.postHeader();
      },
      error: (message) => {
        this.deps.log.appendLine(`chat ${this.id ?? this.cwd}: ${message}`);
        this.post({ type: 'error', message });
      },
      dropped: (texts) => this.post({ type: 'restoreDraft', text: texts.join('\n\n') }),
      exit: () => {
        this.runner = undefined;
        this.releaseOwnership();
        this.post({ type: 'partial', text: null });
        this.stateEmitter.fire();
      },
    };
  }

  private bindSessionId(id: string): void {
    if (!id || this.disposed) return;
    if (this.id === id) {
      if (!this.tail) void this.startTailFor(id);
      return;
    }
    this.id = id;
    this.header.sessionId = id;
    this.postHeader();
    this.stateEmitter.fire();
    void this.startTailFor(id);
  }

  private async initTranscript(): Promise<void> {
    const given = this.session?.transcriptPath;
    if (given && (await exists(given))) {
      this.startTail(given);
      return;
    }
    if (this.id) await this.startTailFor(this.id);
  }

  private async startTailFor(sessionId: string): Promise<void> {
    const dir = this.deps.claudeDir();
    const expected = expectedTranscriptPath(dir, this.cwd, sessionId);
    if (!(await exists(expected))) {
      const found = await findTranscriptPath(dir, this.cwd, sessionId).catch(() => undefined);
      if (this.disposed || this.tail) return;
      if (found) {
        this.startTail(found);
        return;
      }
    }
    if (this.disposed || this.tail) return;
    this.startTail(expected);
    for (let i = 0; i < TRANSCRIPT_WAIT_TRIES; i++) {
      if (this.disposed || this.transcript !== expected) return;
      if (await exists(expected)) return;
      const found = await findTranscriptPath(dir, this.cwd, sessionId).catch(() => undefined);
      if (this.disposed || this.transcript !== expected) return;
      if (found && found !== expected) {
        this.startTail(found);
        return;
      }
      await delay(500);
    }
  }

  private startTail(file: string): void {
    if (this.disposed || (this.tail && this.transcript === file)) return;
    // A different transcript replays from the start, so anything shown already would end up below it.
    const replace = this.transcript !== undefined && this.transcript !== file && this.model.items().length > 0;
    this.tail?.dispose();
    this.transcript = file;
    if (replace) this.resetItems();
    this.tail = new TranscriptTail(
      file,
      (entries) => this.ingest(entries),
      (err) => this.deps.log.appendLine(`chat transcript ${file}: ${String(err)}`),
    );
    this.tail.start();
    this.stateEmitter.fire();
  }

  private resetItems(): void {
    this.model = new ChatModel();
    this.pendingItems.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.ready) this.post({ type: 'init', header: this.header, items: [], hiddenOlder: 0, status: this.status });
  }

  private ingest(entries: unknown[]): void {
    if (this.disposed || !entries.length) return;
    const changed: ChatItem[] = [];
    for (const entry of entries) {
      const title = titleFromEntry(entry);
      if (title) this.setTitle(title);
      try {
        for (const item of this.model.ingest(entry)) changed.push(item);
      } catch (err) {
        this.deps.log.appendLine(`chat ingest failed: ${String(err)}`);
      }
    }
    if (changed.length) this.queueItems(changed);
  }

  private queueItems(items: ChatItem[]): void {
    for (const item of items) this.pendingItems.set(item.id, item);
    if (!this.ready || this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushItems(), ITEM_FLUSH_MS);
  }

  private flushItems(): void {
    this.flushTimer = undefined;
    if (this.disposed || !this.ready || !this.pendingItems.size) return;
    const items = [...this.pendingItems.values()];
    this.pendingItems.clear();
    this.post({ type: 'items', items });
  }

  private askPermission(ask: PermissionAsk, signal: AbortSignal): Promise<PermissionAnswer> {
    return new Promise<PermissionAnswer>((resolve) => {
      if (this.disposed || signal.aborted) {
        resolve({ decision: 'deny', message: 'Cancelled' });
        return;
      }
      const pending: PendingPermission = {
        request: this.permissionView(ask.toolUseId ?? `perm-${++this.seq}`, ask),
        resolve,
        signal,
        onAbort: () => {},
      };
      pending.onAbort = () => {
        this.dropPermission(pending);
        resolve({ decision: 'deny', message: 'Cancelled' });
      };
      signal.addEventListener('abort', pending.onAbort, { once: true });
      this.permissionQueue.push(pending);
      this.touch();
      if (this.permissionQueue.length === 1) this.post({ type: 'permission', request: pending.request });
    });
  }

  private answerPermission(id: string, decision: 'allow' | 'allowSession' | 'deny', message?: string): void {
    const index = this.permissionQueue.findIndex((p) => p.request.id === id);
    if (index < 0) return;
    const [pending] = this.permissionQueue.splice(index, 1);
    pending.signal.removeEventListener('abort', pending.onAbort);
    pending.resolve(decision === 'deny' ? { decision, message } : { decision });
    this.touch();
    this.showNextPermission();
  }

  private dropPermission(pending: PendingPermission): void {
    const index = this.permissionQueue.indexOf(pending);
    if (index < 0) return;
    this.permissionQueue.splice(index, 1);
    pending.signal.removeEventListener('abort', pending.onAbort);
    if (index === 0) this.showNextPermission();
  }

  private showNextPermission(): void {
    this.post({ type: 'permission', request: this.permissionQueue[0]?.request ?? null });
  }

  private askQuestion(questions: unknown[], signal: AbortSignal): Promise<Record<string, string> | null> {
    return new Promise<Record<string, string> | null>((resolve) => {
      if (this.disposed || signal.aborted) {
        resolve(null);
        return;
      }
      const pending: PendingQuestion = {
        request: { id: `ask-${++this.seq}`, questions: questionViews(questions) },
        resolve,
        signal,
        onAbort: () => {},
      };
      pending.onAbort = () => {
        this.dropQuestion(pending);
        resolve(null);
      };
      signal.addEventListener('abort', pending.onAbort, { once: true });
      this.questionQueue.push(pending);
      this.touch();
      if (this.questionQueue.length === 1) this.post({ type: 'question', request: pending.request });
    });
  }

  private answerQuestion(id: string, answers: Record<string, string> | null): void {
    const index = this.questionQueue.findIndex((q) => q.request.id === id);
    if (index < 0) return;
    const [pending] = this.questionQueue.splice(index, 1);
    pending.signal.removeEventListener('abort', pending.onAbort);
    pending.resolve(answers);
    this.touch();
    this.post({ type: 'question', request: this.questionQueue[0]?.request ?? null });
  }

  private dropQuestion(pending: PendingQuestion): void {
    const index = this.questionQueue.indexOf(pending);
    if (index < 0) return;
    this.questionQueue.splice(index, 1);
    pending.signal.removeEventListener('abort', pending.onAbort);
    if (index === 0) this.post({ type: 'question', request: this.questionQueue[0]?.request ?? null });
  }

  private permissionView(id: string, ask: PermissionAsk): PermissionRequestView {
    const info = safeToolTitle(ask.toolName, ask.input, this.model.sessionCwd() ?? this.cwd);
    const diff = permissionDiff(ask);
    return {
      id,
      toolName: ask.toolName,
      title: info.title,
      detail: info.detail ?? ask.decisionReason ?? (diff ? undefined : describeInput(ask.input)),
      diff,
      canAllowForSession: ask.hasSuggestions,
    };
  }

  private setStatus(status: RunStatus): void {
    this.status = status;
    this.touch();
    this.post({ type: 'status', status });
  }

  private setTitle(title: string): void {
    if (!title || title === this.header.title) return;
    this.header.title = title;
    if (!this.disposed) this.panel.title = tabTitle(title);
    this.postHeader();
    this.stateEmitter.fire();
  }

  private refreshEntrypoint(): void {
    const label = this.startedHere ? 'This window' : entrypointLabel(this.session?.entrypoint ?? 'sdk');
    if (label === this.header.entrypoint) return;
    this.header.entrypoint = label;
    this.postHeader();
  }

  private refreshReadOnly(): void {
    const next = this.computeReadOnly();
    const canTakeOver = next.canTakeOver === true;
    if (next.readOnly === this.header.readOnly && next.reason === this.header.readOnlyReason && canTakeOver === !!this.header.canTakeOver) return;
    this.header.readOnly = next.readOnly;
    this.header.readOnlyReason = next.reason;
    this.header.canTakeOver = canTakeOver;
    this.postHeader();
  }

  private computeReadOnly(): { readOnly: boolean; reason?: string; canTakeOver?: boolean } {
    if (!dirExists(this.cwd)) return { readOnly: true, reason: 'Project folder not found' };
    const session = this.session;
    if (session?.live && session.state !== 'ended' && !this.startedHere && (!session.pid || isPidAlive(session.pid))) {
      const where = liveElsewhereReason(session.entrypoint);
      return { readOnly: true, reason: session.pid ? `${where} · pid ${session.pid}` : where, canTakeOver: true };
    }
    return { readOnly: false };
  }

  private async takeOver(): Promise<void> {
    const session = this.session;
    if (!session?.live || this.startedHere) return;
    const pid = session.pid;
    const choice = await vscode.window.showWarningMessage(
      pid ? `Stop the other Claude process for “${this.header.title}” and continue here?` : `Continue “${this.header.title}” in this window?`,
      {
        modal: true,
        detail: pid
          ? `${liveElsewhereReason(session.entrypoint)} (pid ${pid}). Its window or terminal stays open; only that claude process is stopped, which interrupts anything it is doing right now.`
          : `${liveElsewhereReason(session.entrypoint)}. If it is in fact still running, both would write to the same session.`,
      },
      'Take Over',
    );
    if (choice !== 'Take Over' || this.disposed) return;
    const stopped = !pid || (await signalAndWait(pid, 'SIGTERM', 5000)) || (await signalAndWait(pid, 'SIGKILL', 2000));
    if (this.disposed) return;
    if (!stopped) {
      this.post({ type: 'error', message: `Could not stop the Claude process (pid ${pid}).` });
      return;
    }
    this.deps.log.appendLine(`chat ${this.id}: took over${pid ? ` from pid ${pid}` : ''}`);
    this.session = { ...session, live: false, state: 'ended', pid: undefined };
    this.refreshEntrypoint();
    this.refreshReadOnly();
    this.post({ type: 'focusComposer' });
  }

  private async refreshBranch(): Promise<void> {
    if (this.disposed || !dirExists(this.cwd)) return;
    const now = Date.now();
    if (now - this.branchCheckedAt < BRANCH_THROTTLE_MS) return;
    this.branchCheckedAt = now;
    try {
      const branch = await this.deps.currentBranch(this.cwd);
      if (this.disposed || branch === this.header.branch) return;
      this.header.branch = branch;
      this.postHeader();
    } catch (err) {
      this.deps.log.appendLine(`chat branch ${this.cwd}: ${String(err)}`);
    }
  }

  private async handleSwitchBranch(): Promise<void> {
    try {
      await this.deps.switchBranch(this.cwd);
    } catch (err) {
      this.post({ type: 'error', message: `Could not switch branch: ${String(err)}` });
      return;
    }
    this.branchCheckedAt = 0;
    await this.refreshBranch();
  }

  private openInTerminal(): void {
    const session = this.session;
    if (!session && !this.id) {
      void vscode.window.showInformationMessage('This chat has no session yet — send a message first.');
      return;
    }
    this.deps.resumeInTerminal(
      session ?? {
        sessionId: this.id ?? '',
        cwd: this.cwd,
        entrypoint: 'cli',
        title: this.header.title,
        state: 'ended',
        stateSince: Date.now(),
        lastActivity: Date.now(),
        live: false,
      },
    );
  }

  private async openDiff(filePath: string): Promise<void> {
    const abs = this.absolute(filePath);
    if (!this.id) {
      await this.openFile(filePath);
      return;
    }
    try {
      await this.deps.openDiff(this.id, this.cwd, abs);
    } catch (err) {
      this.deps.log.appendLine(`chat openDiff ${abs}: ${String(err)}`);
      await this.openFile(filePath);
    }
  }

  private async openFile(target: string, line?: number): Promise<void> {
    let file = target;
    let at = line;
    const match = /^(.*?):(\d+)(?::\d+)?$/.exec(file);
    if (match && !fs.existsSync(this.absolute(file))) {
      file = match[1];
      at = Number(match[2]);
    }
    const uri = vscode.Uri.file(this.absolute(file));
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const selection = at && at > 0 ? new vscode.Range(at - 1, 0, at - 1, 0) : undefined;
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two, preview: true, selection });
    } catch (err) {
      this.post({ type: 'error', message: `Could not open ${file}: ${String(err)}` });
    }
  }

  private absolute(p: string): string {
    return path.isAbsolute(p) ? p : path.join(this.cwd, p);
  }

  private touch(): void {
    this.lastActivity = Date.now();
    this.scheduleIdleCheck();
  }

  private scheduleIdleCheck(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const minutes = this.deps.idleShutdownMinutes();
    if (!this.runner || !(minutes > 0)) return;
    this.idleTimer = setTimeout(() => this.idleCheck(), minutes * 60_000);
  }

  private idleCheck(): void {
    this.idleTimer = undefined;
    const runner = this.runner;
    const minutes = this.deps.idleShutdownMinutes();
    if (this.disposed || !runner || !(minutes > 0)) return;
    const quietFor = Date.now() - this.lastActivity;
    if (runner.busy || this.permissionQueue.length || this.questionQueue.length || quietFor < minutes * 60_000) {
      this.idleTimer = setTimeout(() => this.idleCheck(), Math.max(30_000, minutes * 60_000 - quietFor));
      return;
    }
    this.deps.log.appendLine(`chat: idle shutdown of ${this.id ?? this.cwd} after ${minutes} min`);
    runner.dispose();
    this.runner = undefined;
    this.releaseOwnership();
    this.stateEmitter.fire();
  }

  /** No process of ours is running any more, so this window no longer owns the session. */
  private releaseOwnership(): void {
    if (!this.startedHere || this.disposed) return;
    this.startedHere = false;
    this.refreshEntrypoint();
    this.refreshReadOnly();
  }

  private postHeader(): void {
    this.post({ type: 'header', header: this.header });
  }

  private post(msg: HostToView): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(msg);
  }

  private html(): string {
    const webview = this.panel.webview;
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, ...p));
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('media', 'codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('media', 'chat.css')}">
<title>Claude</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri('dist', 'webview', 'chat.js')}"></script>
</body>
</html>`;
  }
}

export function chatPanelOptions(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media'), vscode.Uri.joinPath(extensionUri, 'dist')],
  };
}

export function chatTabTitle(title: string): string {
  return tabTitle(title);
}

function tabTitle(title: string): string {
  const clean = (title || 'Claude').replace(/\s+/g, ' ').trim();
  return clean.length > TITLE_MAX ? clean.slice(0, TITLE_MAX - 1) + '…' : clean;
}

function liveElsewhereReason(entrypoint: Entrypoint): string {
  switch (entrypoint) {
    case 'cli':
      return 'Running in a terminal (CLI)';
    case 'vscode':
      return 'Open in the Claude Code extension';
    case 'desktop':
      return 'Running in Claude Desktop';
    case 'sdk':
      return 'Running in an SDK session';
    default:
      return 'Running outside this window';
  }
}

function titleFromEntry(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const e = entry as { type?: unknown; aiTitle?: unknown; customTitle?: unknown };
  if (e.type === 'custom-title' && typeof e.customTitle === 'string') return e.customTitle;
  if (e.type === 'ai-title' && typeof e.aiTitle === 'string') return e.aiTitle;
  return undefined;
}

function safeToolTitle(name: string, input: unknown, cwd: string): { title: string; detail?: string; file?: string } {
  try {
    return toolTitle(name, input, cwd);
  } catch {
    return { title: name };
  }
}

function permissionDiff(ask: PermissionAsk): { path: string; before: string; after: string } | undefined {
  const input = (ask.input ?? {}) as Record<string, unknown>;
  const file = str(input.file_path) || str(input.notebook_path);
  if (!file) return undefined;
  switch (ask.toolName) {
    case 'Edit':
      return { path: file, before: str(input.old_string), after: str(input.new_string) };
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
      return {
        path: file,
        before: edits.map((e) => str(e?.old_string)).join('\n'),
        after: edits.map((e) => str(e?.new_string)).join('\n'),
      };
    }
    case 'Write':
      return { path: file, before: readFileSafe(file), after: str(input.content) };
    case 'NotebookEdit':
      return { path: file, before: str(input.old_source), after: str(input.new_source) };
    default:
      return undefined;
  }
}

function describeInput(input: unknown): string | undefined {
  try {
    const json = JSON.stringify(input, null, 2);
    if (!json || json === '{}') return undefined;
    return json.length > 4000 ? json.slice(0, 4000) + '\n…' : json;
  } catch {
    return undefined;
  }
}

function questionViews(questions: unknown[]): QuestionView[] {
  const out: QuestionView[] = [];
  for (const raw of questions ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const q = raw as Record<string, unknown>;
    const header = str(q.header) || undefined;
    const options: { label: string; description?: string }[] = [];
    for (const option of Array.isArray(q.options) ? q.options : []) {
      if (typeof option === 'string') {
        options.push({ label: option });
        continue;
      }
      if (!option || typeof option !== 'object') continue;
      const o = option as Record<string, unknown>;
      const label = str(o.label) || str(o.name) || str(o.value);
      if (label) options.push({ label, description: str(o.description) || undefined });
    }
    out.push({ question: str(q.question) || header || 'Question', header, multiSelect: q.multiSelect === true, options });
  }
  return out;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readFileSafe(file: string): string {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 2_000_000) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function dirExists(p: string): boolean {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function signalAndWait(pid: number, signal: NodeJS.Signals, timeoutMs: number): Promise<boolean> {
  try {
    process.kill(pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await delay(150);
  }
  return !isPidAlive(pid);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
