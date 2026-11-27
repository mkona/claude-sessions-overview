import { execFile } from 'child_process';
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
const PROCESS_SNAPSHOT_MS = 5000;
/** A registry file records startedAt right after its process starts, so a bigger gap means another process holds the pid. */
const PROCESS_START_SLACK_MS = 120_000;

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

/**
 * Claude leaves ~/.claude/sessions/<pid>.json behind when it is killed or crashes, and pids are recycled
 * within a day on a busy machine, so a pid that answers signals is not proof that the session still runs:
 * it can be an unrelated process or an unreaped zombie. Process start times tell the two apart.
 */
class ProcessStarts {
  private starts?: Map<number, number>;
  private at = 0;
  private pending?: Promise<Map<number, number> | undefined>;

  async read(maxAgeMs = PROCESS_SNAPSHOT_MS): Promise<Map<number, number> | undefined> {
    if (this.starts && Date.now() - this.at < maxAgeMs) return this.starts;
    if (!this.pending) {
      this.pending = listProcessStarts().then((starts) => {
        this.pending = undefined;
        if (starts) {
          this.starts = starts;
          this.at = Date.now();
        }
        return starts;
      });
    }
    return this.pending;
  }
}

function listProcessStarts(): Promise<Map<number, number> | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,state=,lstart='], { timeout: 4000, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err || !stdout) {
        resolve(undefined);
        return;
      }
      const starts = new Map<number, number>();
      for (const line of stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(\S+)\s+(\S.*\S)\s*$/.exec(line);
        if (!m || m[2].includes('Z')) continue;
        const started = Date.parse(m[3]);
        if (!Number.isNaN(started)) starts.set(Number(m[1]), started);
      }
      resolve(starts.size ? starts : undefined);
    });
  });
}

function processRuns(entry: RegistryEntry, starts: Map<number, number> | undefined): boolean {
  if (!starts) return isPidAlive(entry.pid);
  const started = starts.get(entry.pid);
  if (started === undefined) return false;
  if (!entry.startedAt) return true;
  return Math.abs(entry.startedAt - started) <= PROCESS_START_SLACK_MS;
}

export class SessionStore {
  private transcripts = new Map<string, CachedTranscript>();
  private processes = new ProcessStarts();

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
      live: state !== 'ended',
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
    const found: RegistryEntry[] = [];
    await Promise.all(
      names
        .filter((n) => n.endsWith('.json'))
        .map(async (n) => {
          try {
            const raw = await fsp.readFile(path.join(dir, n), 'utf8');
            const entry = JSON.parse(raw) as RegistryEntry;
            if (typeof entry.pid !== 'number' || typeof entry.sessionId !== 'string') return;
            if (!isPidAlive(entry.pid)) return;
            found.push(entry);
          } catch {
            /* partial write or stale file */
          }
        }),
    );
    if (!found.length) return found;
    let starts = await this.processes.read();
    // A session that started since the last snapshot would look stale, so look again before dropping it.
    if (starts && found.some((entry) => !starts?.has(entry.pid))) starts = await this.processes.read(1000);
    return found.filter((entry) => processRuns(entry, starts));
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
