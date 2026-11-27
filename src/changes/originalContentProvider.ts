import * as vscode from 'vscode';
import type { SessionFileChange } from './sessionEdits';

export const ORIGINAL_SCHEME = 'claude-session-original';

const EMPTY_FRAGMENT = 'empty';

export function originalUri(sessionId: string, filePath: string): vscode.Uri {
  return vscode.Uri.file(filePath).with({ scheme: ORIGINAL_SCHEME, query: sessionId });
}

/** Left/right side for a file the session deleted: always renders as empty. */
export function emptyUri(filePath: string): vscode.Uri {
  return vscode.Uri.file(filePath).with({ scheme: ORIGINAL_SCHEME, query: '', fragment: EMPTY_FRAGMENT });
}

const MAX_SESSIONS = 8;

export class OriginalContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly sessions = new Map<string, Map<string, SessionFileChange>>();

  readonly onDidChange = this.changed.event;

  set(sessionId: string, changes: Map<string, SessionFileChange>): void {
    const previous = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, changes);
    this.evict();
    if (!previous) return;
    const paths = new Set<string>([...previous.keys(), ...changes.keys()]);
    for (const p of paths) {
      if (previous.get(p)?.original !== changes.get(p)?.original) this.changed.fire(originalUri(sessionId, p));
    }
  }

  /** Originals are whole file snapshots, so only the most recently used sessions stay in memory. */
  private evict(): void {
    while (this.sessions.size > MAX_SESSIONS) {
      const [oldest, changes] = this.sessions.entries().next().value as [string, Map<string, SessionFileChange>];
      this.sessions.delete(oldest);
      for (const p of changes.keys()) this.changed.fire(originalUri(oldest, p));
    }
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.fragment === EMPTY_FRAGMENT) return '';
    return this.sessions.get(uri.query)?.get(uri.fsPath)?.original ?? '';
  }

  dispose(): void {
    this.changed.dispose();
    this.sessions.clear();
  }
}
