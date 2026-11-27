import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

const POLL_MS = 750;
const NEWLINE = 0x0a;

export class TranscriptTail {
  private offset = 0;
  private partial = Buffer.alloc(0);
  private timer: ReturnType<typeof setInterval> | undefined;
  private watcher: fs.FSWatcher | undefined;
  private reading = false;
  private again = false;
  private disposed = false;

  constructor(
    private readonly filePath: string,
    private readonly onEntries: (entries: unknown[]) => void,
    private readonly onError?: (e: unknown) => void
  ) {}

  start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => {
      this.ensureWatcher();
      void this.read();
    }, POLL_MS);
    this.ensureWatcher();
    void this.read();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.closeWatcher();
  }

  private ensureWatcher(): void {
    if (this.watcher || this.disposed) return;
    const dir = path.dirname(this.filePath);
    const name = path.basename(this.filePath);
    try {
      const watcher = fs.watch(dir, (_event, changed) => {
        if (!changed || changed === name) void this.read();
      });
      watcher.on('error', () => this.closeWatcher());
      this.watcher = watcher;
    } catch {
      // directory may not exist yet; polling retries
    }
  }

  private closeWatcher(): void {
    try {
      this.watcher?.close();
    } catch {
      // ignore
    }
    this.watcher = undefined;
  }

  private async read(): Promise<void> {
    if (this.disposed) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.again = false;
        await this.readOnce();
      } while (this.again && !this.disposed);
    } finally {
      this.reading = false;
    }
  }

  private async readOnce(): Promise<void> {
    let size: number;
    try {
      size = (await fsp.stat(this.filePath)).size;
    } catch {
      return;
    }
    if (size < this.offset) {
      this.offset = 0;
      this.partial = Buffer.alloc(0);
    }
    if (size === this.offset) return;

    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(this.filePath, 'r');
    } catch (e) {
      this.onError?.(e);
      return;
    }
    try {
      const buf = Buffer.alloc(size - this.offset);
      const { bytesRead } = await handle.read(buf, 0, buf.length, this.offset);
      if (bytesRead <= 0) return;
      this.offset += bytesRead;
      const chunk = Buffer.concat([this.partial, buf.subarray(0, bytesRead)]);
      const lastNewline = chunk.lastIndexOf(NEWLINE);
      if (lastNewline < 0) {
        this.partial = chunk;
        return;
      }
      this.partial = Buffer.from(chunk.subarray(lastNewline + 1));
      const entries = parseEntries(chunk.toString('utf8', 0, lastNewline));
      if (entries.length) this.onEntries(entries);
    } catch (e) {
      this.onError?.(e);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}

export function parseEntries(text: string): unknown[] {
  const entries: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // partially flushed or corrupt line
    }
  }
  return entries;
}

export function expectedTranscriptPath(claudeDir: string, cwd: string, sessionId: string): string {
  return path.join(claudeDir, 'projects', encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

export async function findTranscriptPath(claudeDir: string, cwd: string, sessionId: string): Promise<string | undefined> {
  const expected = expectedTranscriptPath(claudeDir, cwd, sessionId);
  if (await exists(expected)) return expected;
  const projects = path.join(claudeDir, 'projects');
  let dirs: string[];
  try {
    dirs = await fsp.readdir(projects);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}
