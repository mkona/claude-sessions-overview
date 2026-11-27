import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const PENDING_KEY = 'claudeSessions.pendingOpen';
const PENDING_TTL_MS = 60_000;
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

export type EnsureResult = 'present' | 'added' | 'restarting' | 'skipped';

interface PendingOpen {
  ts: number;
  value: unknown;
}

let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

function canonical(p: string): string {
  let out = path.resolve(p);
  try {
    out = fs.realpathSync.native(out);
  } catch {
    // path may not exist (yet); compare the resolved form
  }
  if (out.length > 1 && out.endsWith(path.sep)) out = out.slice(0, -1);
  return CASE_INSENSITIVE ? out.toLowerCase() : out;
}

function folderContains(folder: string, target: string): boolean {
  const a = canonical(folder);
  const b = canonical(target);
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

function existingFolder(cwd: string): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.some((f) => f.uri.scheme === 'file' && folderContains(f.uri.fsPath, cwd));
}

export async function ensureProjectFolder(
  cwd: string,
  context: vscode.ExtensionContext,
  opts: { enabled: boolean; pendingOpen?: unknown },
): Promise<EnsureResult> {
  if (existingFolder(cwd)) return 'present';
  if (!opts.enabled) return 'skipped';
  return await serialize(async () => {
    if (existingFolder(cwd)) return 'present';
    const uri = vscode.Uri.file(path.resolve(cwd));
    const folders = vscode.workspace.workspaceFolders ?? [];
    // VS Code restarts the extension host both when the first folder is added and when a
    // single-folder window becomes multi-root, so anything we need afterwards goes to globalState.
    if (folders.length <= 1) {
      if (opts.pendingOpen !== undefined) {
        await context.globalState.update(PENDING_KEY, { ts: Date.now(), value: opts.pendingOpen } satisfies PendingOpen);
      }
      const ok = vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri });
      if (!ok) {
        await context.globalState.update(PENDING_KEY, undefined);
        return 'skipped';
      }
      return 'restarting';
    }
    const changed = waitForChange(uri);
    if (!vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri })) {
      changed.cancel();
      return 'skipped';
    }
    await changed.done;
    return 'added';
  });
}

function waitForChange(uri: vscode.Uri): { done: Promise<void>; cancel: () => void } {
  let sub: vscode.Disposable | undefined;
  let timer: NodeJS.Timeout | undefined;
  let finish: (() => void) | undefined;
  const settle = () => {
    sub?.dispose();
    if (timer) clearTimeout(timer);
    finish?.();
  };
  const done = new Promise<void>((resolve) => {
    finish = resolve;
    sub = vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      if (e.added.some((f) => f.uri.toString() === uri.toString())) settle();
    });
    timer = setTimeout(settle, 3000);
  });
  return { done, cancel: settle };
}

export function takePendingOpen(context: vscode.ExtensionContext): unknown | undefined {
  const pending = context.globalState.get<PendingOpen>(PENDING_KEY);
  if (pending === undefined) return undefined;
  void context.globalState.update(PENDING_KEY, undefined);
  if (!pending || typeof pending.ts !== 'number' || Date.now() - pending.ts > PENDING_TTL_MS) return undefined;
  return pending.value;
}
