export type Entrypoint = 'cli' | 'vscode' | 'desktop' | 'sdk' | 'other';

export type SessionState = 'needs-answer' | 'working' | 'idle' | 'ended';

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
  entrypoint: Entrypoint;
  title: string;
  lastPrompt?: string;
  state: SessionState;
  stateDetail?: string;
  stateSince: number;
  lastActivity: number;
  live: boolean;
  pid?: number;
  name?: string;
  gitBranch?: string;
  version?: string;
}

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt?: number;
  entrypoint?: string;
  kind?: string;
  status?: string;
  waitingFor?: string;
  updatedAt?: number;
  statusUpdatedAt?: number;
  name?: string;
  version?: string;
}

export function normalizeEntrypoint(raw: string | undefined): Entrypoint {
  switch (raw) {
    case 'cli':
      return 'cli';
    case 'claude-vscode':
      return 'vscode';
    case 'claude-desktop':
    case 'claude-desktop-3p':
      return 'desktop';
    case 'sdk-ts':
    case 'sdk-py':
    case 'sdk':
      return 'sdk';
    default:
      return raw ? 'other' : 'cli';
  }
}

export function entrypointLabel(e: Entrypoint): string {
  switch (e) {
    case 'cli':
      return 'CLI';
    case 'vscode':
      return 'VS Code';
    case 'desktop':
      return 'Desktop';
    case 'sdk':
      return 'SDK';
    default:
      return 'Other';
  }
}
