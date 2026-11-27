import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function prettyPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** Claude reports its cwd and file paths with symlinks resolved; workspace folders may not be. */
export function realPath(p: string): string {
  try {
    return fs.realpathSync.native(path.resolve(p));
  } catch {
    return p;
  }
}
