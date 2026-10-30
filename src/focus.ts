import { execFile } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { isPidAlive } from './store';
import { SessionInfo } from './types';

interface WindowRecord {
  pid: number;
  folders: string[];
  workspaceFile?: string;
  updatedAt: number;
}

interface Handoff {
  ts: number;
  session: SessionInfo;
}

const HANDOFF_TTL_MS = 20_000;

export class WindowCoordinator implements vscode.Disposable {
  private readonly windowsDir: string;
  private readonly handoffPath: string;
  private readonly disposables: vscode.Disposable[] = [];
  private watcher?: fs.FSWatcher;
  private heartbeat?: NodeJS.Timeout;
  private handling = false;

  constructor(
    storageDir: string,
    private readonly claudeDir: () => string,
    private readonly resumeCommand: () => string,
    private readonly log: vscode.OutputChannel,
  ) {
    this.windowsDir = path.join(storageDir, 'windows');
    this.handoffPath = path.join(storageDir, 'handoff.json');
  }

  async start(): Promise<void> {
    await fsp.mkdir(this.windowsDir, { recursive: true });
    await this.writeRecord();
    this.heartbeat = setInterval(() => void this.writeRecord(), 30_000);
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void this.writeRecord()));
    try {
      this.watcher = fs.watch(path.dirname(this.handoffPath), (_event, name) => {
        if (name === path.basename(this.handoffPath)) void this.consumeHandoff();
      });
    } catch (err) {
      this.log.appendLine(`handoff watcher failed: ${String(err)}`);
    }
    setTimeout(() => void this.consumeHandoff(), 1500);
  }

  dispose(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.watcher?.close();
    for (const d of this.disposables) d.dispose();
    void fsp.rm(this.recordPath(process.pid), { force: true });
  }

  private recordPath(pid: number): string {
    return path.join(this.windowsDir, `${pid}.json`);
  }

  private currentFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  }

  private async writeRecord(): Promise<void> {
    const rec: WindowRecord = {
      pid: process.pid,
      folders: this.currentFolders(),
      workspaceFile: vscode.workspace.workspaceFile?.scheme === 'file' ? vscode.workspace.workspaceFile.fsPath : undefined,
      updatedAt: Date.now(),
    };
    try {
      const tmp = this.recordPath(process.pid) + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(rec));
      await fsp.rename(tmp, this.recordPath(process.pid));
    } catch (err) {
      this.log.appendLine(`window record write failed: ${String(err)}`);
    }
  }

  private async readWindows(): Promise<WindowRecord[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.windowsDir);
    } catch {
      return [];
    }
    const out: WindowRecord[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const file = path.join(this.windowsDir, n);
      try {
        const rec = JSON.parse(await fsp.readFile(file, 'utf8')) as WindowRecord;
        if (!isPidAlive(rec.pid)) {
          await fsp.rm(file, { force: true });
          continue;
        }
        out.push(rec);
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  /** Windows known from Claude's own IDE lock files (covers windows where this extension is not active yet). */
  private async readIdeLockFolders(): Promise<string[]> {
    const dir = path.join(this.claudeDir(), 'ide');
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const folders: string[] = [];
    for (const n of names) {
      if (!n.endsWith('.lock')) continue;
      try {
        const lock = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'));
        if (typeof lock.ideName === 'string' && !/visual studio code/i.test(lock.ideName)) continue;
        if (typeof lock.pid === 'number' && !isPidAlive(lock.pid)) continue;
        if (Array.isArray(lock.workspaceFolders)) folders.push(...lock.workspaceFolders.filter((f: unknown) => typeof f === 'string'));
      } catch {
        /* ignore */
      }
    }
    return folders;
  }

  async focusProject(session: SessionInfo): Promise<void> {
    const target = await this.findTarget(session.cwd);
    if (target && target.pid === process.pid) {
      await this.openInThisWindow(session);
      return;
    }
    await this.writeHandoff(session);
    if (target) {
      const uri = vscode.Uri.file(target.workspaceFile ?? target.folder);
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
      return;
    }
    const ideFolder = bestFolderMatch(await this.readIdeLockFolders(), session.cwd);
    const folder = ideFolder ?? session.cwd;
    if (!folder) {
      void vscode.window.showWarningMessage('This session has no known project folder.');
      return;
    }
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
  }

  private async findTarget(cwd: string): Promise<{ pid: number; folder: string; workspaceFile?: string } | undefined> {
    if (!cwd) return undefined;
    const windows = await this.readWindows();
    let best: { pid: number; folder: string; workspaceFile?: string } | undefined;
    for (const w of windows) {
      const folder = bestFolderMatch(w.folders, cwd);
      if (!folder) continue;
      if (!best || folder.length > best.folder.length || (folder.length === best.folder.length && w.pid === process.pid)) {
        best = { pid: w.pid, folder, workspaceFile: w.workspaceFile };
      }
    }
    return best;
  }

  private async writeHandoff(session: SessionInfo): Promise<void> {
    const payload: Handoff = { ts: Date.now(), session };
    await fsp.writeFile(this.handoffPath, JSON.stringify(payload));
  }

  private async consumeHandoff(): Promise<void> {
    if (this.handling) return;
    this.handling = true;
    try {
      let handoff: Handoff;
      try {
        handoff = JSON.parse(await fsp.readFile(this.handoffPath, 'utf8')) as Handoff;
      } catch {
        return;
      }
      if (Date.now() - handoff.ts > HANDOFF_TTL_MS) return;
      if (!bestFolderMatch(this.currentFolders(), handoff.session.cwd)) return;
      const claimed = `${this.handoffPath}.${process.pid}.claimed`;
      try {
        await fsp.rename(this.handoffPath, claimed);
      } catch {
        return;
      }
      await fsp.rm(claimed, { force: true });
      await this.openInThisWindow(handoff.session);
    } finally {
      this.handling = false;
    }
  }

  async openInThisWindow(session: SessionInfo): Promise<void> {
    if (session.entrypoint === 'vscode') {
      const commands = await vscode.commands.getCommands(true);
      if (commands.includes('claude-vscode.editor.open')) {
        await vscode.commands.executeCommand('claude-vscode.editor.open', session.sessionId);
        return;
      }
      void vscode.window.showInformationMessage('Claude Code extension is not installed in this window; cannot open the session.');
      return;
    }
    if (session.live && session.pid) {
      const terminal = await this.findTerminalForPid(session.pid);
      if (terminal) {
        terminal.show();
        return;
      }
      void vscode.window.showInformationMessage(`“${session.title}” runs in a terminal outside this window (pid ${session.pid}).`);
      return;
    }
    if (session.entrypoint === 'cli') {
      this.resumeInTerminal(session);
      return;
    }
    void vscode.window.showInformationMessage(`“${session.title}” was a ${session.entrypoint} session; project window focused.`);
  }

  resumeInTerminal(session: SessionInfo): void {
    const terminal = vscode.window.createTerminal({
      name: `Claude: ${session.title.slice(0, 40)}`,
      cwd: session.cwd || undefined,
    });
    terminal.show();
    terminal.sendText(`${this.resumeCommand()} --resume ${session.sessionId}`);
  }

  private async findTerminalForPid(pid: number): Promise<vscode.Terminal | undefined> {
    const ancestors = await parentPids(pid, 4);
    for (const t of vscode.window.terminals) {
      const shellPid = await t.processId;
      if (shellPid && ancestors.includes(shellPid)) return t;
    }
    return undefined;
  }
}

function bestFolderMatch(folders: string[], cwd: string): string | undefined {
  if (!cwd) return undefined;
  const norm = (p: string) => path.resolve(p).replace(/\/+$/, '');
  const c = norm(cwd);
  let best: string | undefined;
  for (const f of folders) {
    const nf = norm(f);
    if (c === nf || c.startsWith(nf + path.sep)) {
      if (!best || nf.length > best.length) best = f;
    }
  }
  return best;
}

async function parentPids(pid: number, depth: number): Promise<number[]> {
  const chain: number[] = [];
  let current = pid;
  for (let i = 0; i < depth; i++) {
    const ppid = await parentPid(current);
    if (!ppid || ppid <= 1) break;
    chain.push(ppid);
    current = ppid;
  }
  return chain;
}

function parentPid(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'ppid=', '-p', String(pid)], (err, stdout) => {
      if (err) return resolve(undefined);
      const n = parseInt(stdout.trim(), 10);
      resolve(Number.isFinite(n) ? n : undefined);
    });
  });
}
