import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { constants as fsConstants } from 'fs';

const cache = new Map<string, string | undefined>();

function extraDirs(): string[] {
  const home = os.homedir();
  return [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return false;
    await fsp.access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstExecutable(dirs: string[], name: string): Promise<string | undefined> {
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function shellLookup(command: string): Promise<string | undefined> {
  const shell = process.env.SHELL;
  if (!shell) return Promise.resolve(undefined);
  const quoted = `'${command.replace(/'/g, `'\\''`)}'`;
  return new Promise((resolve) => {
    execFile(shell, ['-lc', `command -v ${quoted}`], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      const found = stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('/'));
      resolve(found);
    });
  });
}

async function resolve(command: string): Promise<string | undefined> {
  const cmd = command.trim() || 'claude';

  if (path.isAbsolute(cmd)) return (await isExecutableFile(cmd)) ? cmd : undefined;
  if (cmd.includes(path.sep)) {
    const abs = path.resolve(cmd);
    if (await isExecutableFile(abs)) return abs;
  }

  const name = path.basename(cmd);
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  const fromPath = await firstExecutable(pathDirs, name);
  if (fromPath) return fromPath;

  const fromExtra = await firstExecutable(extraDirs(), name);
  if (fromExtra) return fromExtra;

  const fromShell = await shellLookup(cmd);
  if (fromShell && (await isExecutableFile(fromShell))) return fromShell;
  return undefined;
}

export async function resolveClaudeExecutable(command: string): Promise<string | undefined> {
  const key = command.trim() || 'claude';
  if (cache.has(key)) return cache.get(key);
  const resolved = await resolve(key);
  cache.set(key, resolved);
  return resolved;
}
