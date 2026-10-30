import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseTranscript, TranscriptMeta } from './transcript';
import { normalizeEntrypoint, RegistryEntry, SessionInfo, SessionState } from './types';

export interface StoreOptions {
  claudeDir: string;
  showEnded: boolean;
  endedMaxAgeMs: number;
  maxEndedPerProject: number;
}

interface CachedTranscript {
  mtimeMs: number;
  size: number;
  meta: TranscriptMeta;
}

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

export function defaultClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

export class SessionStore {
  private transcripts = new Map<string, CachedTranscript>();

  async load(opts: StoreOptions): Promise<SessionInfo[]> {
    const [registry, files] = await Promise.all([this.readRegistry(opts.claudeDir), this.listTranscripts(opts.claudeDir)]);
    const bySession = new Map<string, SessionInfo>();
    const now = Date.now();

    const fileById = new Map(files.map((f) => [f.sessionId, f]));

    for (const reg of registry) {
      const file = fileById.get(reg.sessionId);
      const meta = file ? await this.transcriptMeta(file) : undefined;
      bySession.set(reg.sessionId, this.fromRegistry(reg, meta, file?.path));
    }

    if (opts.showEnded) {
      const perProject = new Map<string, number>();
      const candidates = files
        .filter((f) => !bySession.has(f.sessionId) && now - f.mtimeMs <= opts.endedMaxAgeMs)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const file of candidates) {
        const count = perProject.get(file.projectDir) ?? 0;
        if (count >= opts.maxEndedPerProject) continue;
        const meta = await this.transcriptMeta(file);
        if (!meta.hasUserMessage && !meta.aiTitle && !meta.customTitle) continue;
        perProject.set(file.projectDir, count + 1);
        bySession.set(file.sessionId, this.fromTranscript(file, meta));
      }
    }

    return [...bySession.values()];
  }

  private fromRegistry(reg: RegistryEntry, meta: TranscriptMeta | undefined, transcriptPath?: string): SessionInfo {
    const { state, detail } = deriveLiveState(reg, meta);
    const since = reg.statusUpdatedAt ?? reg.updatedAt ?? reg.startedAt ?? Date.now();
    return {
      sessionId: reg.sessionId,
      cwd: reg.cwd || meta?.cwd || '',
      transcriptPath,
      entrypoint: normalizeEntrypoint(reg.entrypoint ?? meta?.entrypoint),
      title: pickTitle(meta, reg.name),
      lastPrompt: meta?.lastPrompt,
      state,
      stateDetail: detail,
      stateSince: since,
      lastActivity: Math.max(reg.updatedAt ?? 0, meta?.lastTimestamp ?? 0, since),
      live: true,
      pid: reg.pid,
      name: reg.name,
      gitBranch: meta?.gitBranch,
      version: reg.version ?? meta?.version,
    };
  }

  private fromTranscript(file: TranscriptFile, meta: TranscriptMeta): SessionInfo {
    const last = meta.lastTimestamp ?? file.mtimeMs;
    return {
      sessionId: file.sessionId,
      cwd: meta.cwd || decodeProjectDir(file.projectDir),
      transcriptPath: file.path,
      entrypoint: normalizeEntrypoint(meta.entrypoint),
      title: pickTitle(meta),
      lastPrompt: meta.lastPrompt,
      state: 'ended',
      stateSince: last,
      lastActivity: last,
      live: false,
      gitBranch: meta.gitBranch,
      version: meta.version,
    };
  }

  private async readRegistry(claudeDir: string): Promise<RegistryEntry[]> {
    const dir = path.join(claudeDir, 'sessions');
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const out: RegistryEntry[] = [];
    await Promise.all(
      names
        .filter((n) => n.endsWith('.json'))
        .map(async (n) => {
          try {
            const raw = await fsp.readFile(path.join(dir, n), 'utf8');
            const entry = JSON.parse(raw) as RegistryEntry;
            if (typeof entry.pid !== 'number' || typeof entry.sessionId !== 'string') return;
            if (!isPidAlive(entry.pid)) return;
            out.push(entry);
          } catch {
            /* partial write or stale file */
          }
        }),
    );
    return out;
  }

  private async listTranscripts(claudeDir: string): Promise<TranscriptFile[]> {
    const root = path.join(claudeDir, 'projects');
    let projectDirs: string[];
    try {
      projectDirs = await fsp.readdir(root);
    } catch {
      return [];
    }
    const out: TranscriptFile[] = [];
    await Promise.all(
      projectDirs.map(async (projectDir) => {
        const dir = path.join(root, projectDir);
        let names: string[];
        try {
          names = await fsp.readdir(dir);
        } catch {
          return;
        }
        await Promise.all(
          names
            .filter((n) => SESSION_FILE.test(n))
            .map(async (n) => {
              try {
                const st = await fsp.stat(path.join(dir, n));
                if (!st.isFile() || st.size === 0) return;
                out.push({ path: path.join(dir, n), projectDir, sessionId: n.slice(0, -6), mtimeMs: st.mtimeMs, size: st.size });
              } catch {
                /* vanished */
              }
            }),
        );
      }),
    );
    return out;
  }

  private async transcriptMeta(file: TranscriptFile): Promise<TranscriptMeta> {
    const cached = this.transcripts.get(file.path);
    if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) return cached.meta;
    let meta: TranscriptMeta;
    try {
      meta = await parseTranscript(file.path, file.size);
    } catch {
      meta = { pendingQuestion: false, hasUserMessage: false };
    }
    this.transcripts.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, meta });
    return meta;
  }
}

interface TranscriptFile {
  path: string;
  projectDir: string;
  sessionId: string;
  mtimeMs: number;
  size: number;
}

function deriveLiveState(reg: RegistryEntry, meta: TranscriptMeta | undefined): { state: SessionState; detail?: string } {
  switch (reg.status) {
    case 'busy':
      return { state: 'working' };
    case 'needs_input':
    case 'waiting':
      return { state: 'needs-answer', detail: reg.waitingFor };
    case 'stopped':
    case 'exited':
      return { state: 'ended' };
    case 'idle':
    default:
      if (meta?.pendingQuestion) return { state: 'needs-answer', detail: 'question' };
      return { state: 'idle' };
  }
}

function pickTitle(meta: TranscriptMeta | undefined, fallback?: string): string {
  return meta?.customTitle || meta?.aiTitle || meta?.firstPrompt || meta?.lastPrompt || fallback || 'Untitled session';
}

export function decodeProjectDir(encoded: string): string {
  return encoded.replace(/-/g, '/');
}
