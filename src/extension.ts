import * as path from 'path';
import * as vscode from 'vscode';
import { WindowCoordinator } from './focus';
import { SessionsPanel } from './panel';
import { defaultClaudeDir, SessionStore, StoreOptions } from './store';
import { SessionInfo } from './types';
import { fetchUsage, UsageSnapshot, usageSummary } from './usage';
import { prettyPath } from './util';

const COLLAPSED_KEY = 'claudeSessions.collapsedProjects';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Claude Sessions');
  const store = new SessionStore();
  const config = () => vscode.workspace.getConfiguration('claudeSessions');
  const claudeDir = () => config().get<string>('claudeDir') || defaultClaudeDir();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'claudeSessions.focusView';
  status.show();

  const coordinator = new WindowCoordinator(
    context.globalStorageUri.fsPath,
    claudeDir,
    () => config().get<string>('claudeCommand') || 'claude',
    log,
  );
  await coordinator.start();

  let current: SessionInfo[] = [];
  let previousStates = new Map<string, string>();
  let timer: NodeJS.Timeout | undefined;
  let loading = false;
  let rerun = false;
  let filter = '';
  let usage: UsageSnapshot | undefined;
  let usageTimer: NodeJS.Timeout | undefined;
  let usageLoading = false;

  const collapsed = (): string[] => context.globalState.get<string[]>(COLLAPSED_KEY, []);

  const panel = new SessionsPanel(context.extensionUri, {
    onOpen: (id) => void openSession(id),
    onFilter: (text) => void setFilter(text),
    onRefreshUsage: () => void refreshUsage(),
    onToggleProject: (cwd, isCollapsed) => {
      const next = collapsed().filter((c) => c !== cwd && c !== '!' + cwd).concat(isCollapsed ? [cwd] : ['!' + cwd]);
      void context.globalState.update(COLLAPSED_KEY, next).then(() => panel.update({ collapsed: next }));
    },
  });
  panel.update({
    groupByProject: config().get<boolean>('groupByProject', true),
    showUsage: config().get<boolean>('showUsage', true),
    collapsed: collapsed(),
  });

  const options = (): StoreOptions => ({
    claudeDir: claudeDir(),
    showEnded: filter ? true : config().get<boolean>('showEnded', true),
    endedMaxAgeMs: (filter ? 365 : config().get<number>('endedMaxAgeDays', 14)) * 86_400_000,
    maxEndedPerProject: filter ? 1000 : config().get<number>('maxEndedPerProject', 8),
  });

  async function refresh(): Promise<void> {
    if (loading) {
      rerun = true;
      return;
    }
    loading = true;
    try {
      do {
        rerun = false;
        current = await store.load(options());
      } while (rerun);
      panel.update({ sessions: current });
      updateStatusBar();
      notifyTransitions();
    } catch (err) {
      log.appendLine(`refresh failed: ${String(err)}`);
    } finally {
      loading = false;
    }
  }

  async function setFilter(text: string): Promise<void> {
    const next = text.trim();
    if (next === filter) return;
    filter = next;
    panel.update({ filter });
    panel.setDescription(filter ? `filter: ${filter}` : undefined);
    void refresh();
  }

  async function refreshUsage(): Promise<void> {
    if (usageLoading || !config().get<boolean>('showUsage', true)) return;
    usageLoading = true;
    try {
      const version = current.find((s) => s.version)?.version ?? '2.1.0';
      usage = await fetchUsage(claudeDir(), version);
      if (usage.error) log.appendLine(usage.error);
      panel.update({ usage });
      updateStatusBar();
    } finally {
      usageLoading = false;
    }
  }

  function scheduleUsage(): void {
    if (usageTimer) clearInterval(usageTimer);
    const minutes = Math.max(0.5, config().get<number>('usageRefreshMinutes', 2));
    usageTimer = setInterval(() => void refreshUsage(), minutes * 60_000);
  }

  function updateStatusBar(): void {
    const live = current.filter((s) => s.live);
    const needs = live.filter((s) => s.state === 'needs-answer').length;
    const working = live.filter((s) => s.state === 'working').length;
    const parts: string[] = [];
    if (needs) parts.push(`$(bell-dot) ${needs}`);
    if (working) parts.push(`$(sync~spin) ${working}`);
    if (!parts.length) parts.push(`$(comment-discussion) ${live.length}`);
    status.text = parts.join('  ');
    const sessionLine = needs
      ? `${needs} Claude session${needs === 1 ? '' : 's'} waiting for your answer`
      : working
        ? `${working} Claude session${working === 1 ? '' : 's'} working`
        : `${live.length} Claude session${live.length === 1 ? '' : 's'} running`;
    status.tooltip = usage && !usage.error && usage.limits.length ? `${sessionLine}\nUsage: ${usageSummary(usage)}` : sessionLine;
    status.backgroundColor = needs ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    panel.setBadge(needs);
  }

  function notifyTransitions(): void {
    const next = new Map<string, string>();
    for (const s of current) next.set(s.sessionId, s.state);
    if (config().get<boolean>('notifyNeedsAnswer', true) && previousStates.size) {
      for (const s of current) {
        if (s.state !== 'needs-answer' || previousStates.get(s.sessionId) === 'needs-answer') continue;
        if (!previousStates.has(s.sessionId)) continue;
        void vscode.window
          .showInformationMessage(`Claude needs your answer: ${s.title} (${path.basename(s.cwd)})`, 'Go to session')
          .then((choice) => {
            if (choice) void coordinator.focusProject(s);
          });
      }
    }
    previousStates = next;
  }

  function schedule(): void {
    if (timer) clearInterval(timer);
    const seconds = Math.max(1, config().get<number>('refreshIntervalSeconds', 3));
    timer = setInterval(() => void refresh(), seconds * 1000);
  }

  const sessionOf = (arg: unknown): SessionInfo | undefined => {
    if (!arg || typeof arg !== 'object') return undefined;
    const a = arg as { sessionId?: string };
    return a.sessionId ? current.find((s) => s.sessionId === a.sessionId) : undefined;
  };

  async function openSession(sessionId: string): Promise<void> {
    const s = current.find((x) => x.sessionId === sessionId);
    if (!s) return;
    if (!s.live && s.entrypoint === 'cli' && !config().get<boolean>('resumeEndedCliSessions', true)) {
      await coordinator.focusProject({ ...s, entrypoint: 'other' });
      return;
    }
    await coordinator.focusProject(s);
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeSessions.panel', panel, { webviewOptions: { retainContextWhenHidden: true } }),
    status,
    log,
    coordinator,
    vscode.commands.registerCommand('claudeSessions.refresh', () => Promise.all([refresh(), refreshUsage()])),
    vscode.commands.registerCommand('claudeSessions.refreshUsage', () => refreshUsage()),
    vscode.commands.registerCommand('claudeSessions.focusView', () => vscode.commands.executeCommand('claudeSessions.panel.focus')),
    vscode.commands.registerCommand('claudeSessions.toggleEnded', async () => {
      await config().update('showEnded', !config().get<boolean>('showEnded', true), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('claudeSessions.toggleGrouping', async () => {
      await config().update('groupByProject', !config().get<boolean>('groupByProject', true), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('claudeSessions.collapseAll', async () => {
      const all = [...new Set(current.map((s) => s.cwd).filter(Boolean))];
      await context.globalState.update(COLLAPSED_KEY, all);
      panel.update({ collapsed: all });
    }),
    vscode.commands.registerCommand('claudeSessions.open', (arg: unknown) => {
      const s = sessionOf(arg);
      if (s) void openSession(s.sessionId);
    }),
    vscode.commands.registerCommand('claudeSessions.openFolderWindow', async (arg: unknown) => {
      const a = (arg ?? {}) as { cwd?: string };
      const cwd = a.cwd ?? sessionOf(arg)?.cwd;
      if (!cwd) return;
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(cwd), { forceNewWindow: true });
    }),
    vscode.commands.registerCommand('claudeSessions.resumeInTerminal', (arg: unknown) => {
      const s = sessionOf(arg);
      if (s) coordinator.resumeInTerminal(s);
    }),
    vscode.commands.registerCommand('claudeSessions.copyId', async (arg: unknown) => {
      const s = sessionOf(arg);
      if (!s) return;
      await vscode.env.clipboard.writeText(s.sessionId);
      void vscode.window.setStatusBarMessage(`Copied ${s.sessionId}`, 2500);
    }),
    vscode.commands.registerCommand('claudeSessions.openTranscript', async (arg: unknown) => {
      const s = sessionOf(arg);
      if (!s?.transcriptPath) return;
      await vscode.window.showTextDocument(vscode.Uri.file(s.transcriptPath), { preview: true });
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeSessions')) return;
      panel.update({
        groupByProject: config().get<boolean>('groupByProject', true),
        showUsage: config().get<boolean>('showUsage', true),
      });
      schedule();
      scheduleUsage();
      void refresh();
      void refreshUsage();
    }),
    { dispose: () => timer && clearInterval(timer) },
    { dispose: () => usageTimer && clearInterval(usageTimer) },
  );

  log.appendLine(`Claude Sessions active. Reading ${prettyPath(claudeDir())}. Window folders: ${(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath).join(', ') || '(none)'}`);
  schedule();
  scheduleUsage();
  await refresh();
  void refreshUsage();
}

export function deactivate(): void {}
