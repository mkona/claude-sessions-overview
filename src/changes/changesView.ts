import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ActiveChat } from '../chat/chatManager';
import { findTranscriptPath, TranscriptTail } from '../chat/transcriptTail';
import { prettyPath, realPath } from '../util';
import { countLineChanges } from './lineDiff';
import { collectSessionEdits, readTranscriptEntries, SessionFileChange } from './sessionEdits';
import { emptyUri, ORIGINAL_SCHEME, originalUri, OriginalContentProvider } from './originalContentProvider';

const NO_SESSION = 'Open a session to see its changes';
const NO_CHANGES = 'No file changes in this session yet';
const MAX_WATCHED = 80;

export interface ChangesViewDeps {
  claudeDir: () => string;
  switchBranch: (cwd: string) => Promise<void>;
  currentBranch: (cwd: string) => Promise<string | undefined>;
  watchRepository?: (cwd: string, listener: () => void) => vscode.Disposable;
}

class ChangeItem extends vscode.TreeItem {
  constructor(
    readonly sessionId: string,
    readonly filePath: string,
    readonly order: number,
    /** The session's cwd with symlinks resolved, so file paths from Claude compare directly. */
    cwd: string,
    change: SessionFileChange,
    current: string | null,
  ) {
    super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
    const dir = path.dirname(filePath);
    const rel = path.relative(cwd, realPath(dir));
    const relDir = !rel ? '' : rel.startsWith('..') ? prettyPath(dir) : rel;
    const stat =
      current === null
        ? 'deleted'
        : change.originalUnknown
          ? `+${change.added ?? 0} −${change.removed ?? 0}`
          : change.original === null
            ? 'new'
            : lineStat(change.original, current);
    this.resourceUri = vscode.Uri.file(filePath);
    this.description = relDir ? `${relDir}  ${stat}` : stat;
    this.tooltip = change.originalUnknown
      ? `${filePath}\nThe transcript does not record this file before the session edited it, so the diff shows the whole file.`
      : filePath;
    this.contextValue = 'claudeSessionsChange';
    this.command = { command: 'claudeSessions.changes.openDiff', title: 'Open Session Changes', arguments: [this] };
  }
}

function lineStat(before: string, after: string): string {
  const { added, removed } = countLineChanges(before, after);
  return `+${added} −${removed}`;
}

async function readCurrent(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

export class ChangesView implements vscode.Disposable, vscode.TreeDataProvider<ChangeItem> {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly provider = new OriginalContentProvider();
  private readonly changed = new vscode.EventEmitter<ChangeItem | undefined>();
  private readonly view: vscode.TreeView<ChangeItem>;
  private watchers: vscode.Disposable[] = [];
  private watched = new Set<string>();
  private chat: ActiveChat | undefined;
  private tail: TranscriptTail | undefined;
  private entries: unknown[] = [];
  private seen = new Set<string>();
  private nodes: ChangeItem[] = [];
  private branch: string | undefined;
  private repoWatch: vscode.Disposable | undefined;
  private generation = 0;
  private timer: NodeJS.Timeout | undefined;

  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    context: vscode.ExtensionContext,
    private readonly deps: ChangesViewDeps,
  ) {
    this.view = vscode.window.createTreeView('claudeSessions.changes', { treeDataProvider: this, showCollapseAll: false });
    this.view.message = NO_SESSION;
    this.disposables.push(
      this.view,
      this.provider,
      this.changed,
      vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, this.provider),
      vscode.commands.registerCommand('claudeSessions.changes.openAll', () => void this.openAll()),
      vscode.commands.registerCommand('claudeSessions.changes.refresh', () => void this.reload()),
      vscode.commands.registerCommand('claudeSessions.changes.switchBranch', () => void this.switchBranch()),
      vscode.commands.registerCommand('claudeSessions.changes.openScm', () => void vscode.commands.executeCommand('workbench.view.scm')),
      vscode.commands.registerCommand('claudeSessions.changes.openFile', (item?: ChangeItem) => void this.openFile(item)),
      vscode.commands.registerCommand('claudeSessions.changes.openDiff', (item?: ChangeItem) => void this.openItem(item)),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.watched.has(doc.uri.fsPath)) this.schedule(300);
      }),
    );
    void vscode.commands.executeCommand('setContext', 'claudeSessions.changes.hasSession', false);
    context.subscriptions.push(this);
  }

  getTreeItem(item: ChangeItem): vscode.TreeItem {
    return item;
  }

  getChildren(item?: ChangeItem): ChangeItem[] {
    return item ? [] : this.nodes;
  }

  setActive(chat: ActiveChat | undefined): void {
    const previous = this.chat;
    this.chat = chat;
    void vscode.commands.executeCommand('setContext', 'claudeSessions.changes.hasSession', !!chat);
    const same = !!chat && !!previous && chat.cwd === previous.cwd && chat.sessionId === previous.sessionId;
    if (chat?.cwd !== previous?.cwd) {
      this.branch = undefined;
      this.repoWatch?.dispose();
      this.repoWatch = chat && this.deps.watchRepository ? this.deps.watchRepository(chat.cwd, () => this.updateHeader()) : undefined;
    }
    this.updateHeader();
    if (same) return;
    this.stopFollowing();
    this.nodes = [];
    this.changed.fire(undefined);
    this.view.message = chat ? NO_CHANGES : NO_SESSION;
    if (chat) void this.reload();
  }

  async openDiff(sessionId: string, cwd: string, filePath: string): Promise<void> {
    const abs = path.isAbsolute(filePath) ? path.normalize(filePath) : path.join(cwd, filePath);
    await this.ensureOriginals(sessionId, cwd);
    const current = await readCurrent(abs);
    const right = current === null ? emptyUri(abs) : vscode.Uri.file(abs);
    await vscode.commands.executeCommand('vscode.diff', originalUri(sessionId, abs), right, `${path.basename(abs)} (session changes)`, {
      viewColumn: vscode.ViewColumn.Two,
      preserveFocus: true,
      preview: true,
    });
  }

  dispose(): void {
    this.stopFollowing();
    this.repoWatch?.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  private stopFollowing(): void {
    this.generation++;
    this.tail?.dispose();
    this.tail = undefined;
    this.entries = [];
    this.seen.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.unwatch();
  }

  private async reload(): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    this.tail?.dispose();
    this.tail = undefined;
    this.entries = [];
    this.seen.clear();
    const generation = ++this.generation;
    if (!chat.sessionId) {
      this.setNodes([], generation);
      return;
    }
    let transcriptPath = chat.transcriptPath;
    if (!transcriptPath) transcriptPath = await findTranscriptPath(this.deps.claudeDir(), chat.cwd, chat.sessionId);
    if (generation !== this.generation) return;
    if (!transcriptPath) {
      this.setNodes([], generation);
      return;
    }
    this.tail = new TranscriptTail(
      transcriptPath,
      (entries) => {
        if (generation !== this.generation) return;
        this.add(entries);
        this.schedule(500);
      },
      () => undefined,
    );
    this.tail.start();
  }

  private add(entries: unknown[]): void {
    for (const entry of entries) {
      const uuid = (entry as { uuid?: unknown } | null)?.uuid;
      if (typeof uuid === 'string') {
        if (this.seen.has(uuid)) continue;
        this.seen.add(uuid);
      }
      this.entries.push(entry);
    }
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.recompute();
    }, delay);
  }

  private async recompute(): Promise<void> {
    const chat = this.chat;
    const generation = this.generation;
    if (!chat?.sessionId) return;
    const changes = collectSessionEdits(this.entries);
    this.provider.set(chat.sessionId, changes);
    const nodes: ChangeItem[] = [];
    const base = realPath(chat.cwd);
    for (const [filePath, change] of changes) {
      const current = await readCurrent(filePath);
      if (current === change.original) continue;
      nodes.push(new ChangeItem(chat.sessionId, filePath, change.lastEditTs ?? 0, base, change, current));
    }
    if (generation !== this.generation) return;
    nodes.sort((a, b) => b.order - a.order || a.filePath.localeCompare(b.filePath));
    this.setNodes(nodes, generation);
    this.watch([...changes.keys()]);
  }

  private setNodes(nodes: ChangeItem[], generation: number): void {
    if (generation !== this.generation) return;
    this.nodes = nodes;
    this.view.message = nodes.length ? undefined : this.chat ? NO_CHANGES : NO_SESSION;
    this.changed.fire(undefined);
  }

  private updateHeader(): void {
    const chat = this.chat;
    this.view.title = chat ? truncate(chat.title, 30) : 'Changes';
    this.view.description = chat ? this.branch : undefined;
    if (chat) void this.refreshBranch(chat);
  }

  private async refreshBranch(chat: ActiveChat): Promise<void> {
    const branch = await this.deps.currentBranch(chat.cwd);
    if (this.chat?.cwd !== chat.cwd) return;
    this.branch = branch;
    this.view.description = branch;
  }

  private async ensureOriginals(sessionId: string, cwd: string): Promise<void> {
    if (this.provider.has(sessionId)) return;
    const transcriptPath = await findTranscriptPath(this.deps.claudeDir(), cwd, sessionId);
    if (!transcriptPath) return;
    try {
      this.provider.set(sessionId, collectSessionEdits(await readTranscriptEntries(transcriptPath)));
    } catch {
      this.provider.set(sessionId, new Map());
    }
  }

  private async openItem(item?: ChangeItem): Promise<void> {
    if (!item) return await this.openAll();
    await this.openDiff(item.sessionId, this.chat?.cwd ?? path.dirname(item.filePath), item.filePath);
  }

  private async openFile(item?: ChangeItem): Promise<void> {
    if (!item) return;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.filePath));
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two, preview: true });
    } catch (err) {
      void vscode.window.showErrorMessage(`Cannot open ${prettyPath(item.filePath)}: ${String((err as Error)?.message || err)}`);
    }
  }

  private async openAll(): Promise<void> {
    const chat = this.chat;
    if (!chat?.sessionId || !this.nodes.length) {
      void vscode.window.showInformationMessage(NO_CHANGES);
      return;
    }
    const sessionId = chat.sessionId;
    const resources = this.nodes.map((n) => {
      const file = vscode.Uri.file(n.filePath);
      return [file, originalUri(sessionId, n.filePath), file];
    });
    await vscode.commands.executeCommand('vscode.changes', `${truncate(chat.title, 40)} (session changes)`, resources);
  }

  private async switchBranch(): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    await this.deps.switchBranch(chat.cwd);
    this.updateHeader();
    this.schedule(300);
  }

  private watch(paths: string[]): void {
    const next = paths.slice(0, MAX_WATCHED);
    if (next.length === this.watched.size && next.every((p) => this.watched.has(p))) return;
    this.unwatch();
    for (const p of next) {
      this.watched.add(p);
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(p)), path.basename(p)));
      const onChange = () => this.schedule(300);
      this.watchers.push(watcher, watcher.onDidChange(onChange), watcher.onDidCreate(onChange), watcher.onDidDelete(onChange));
    }
  }

  private unwatch(): void {
    for (const d of this.watchers.splice(0)) d.dispose();
    this.watched.clear();
  }
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean || 'Changes';
}
