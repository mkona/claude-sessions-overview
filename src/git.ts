import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { prettyPath } from './util';

const run = promisify(execFile);

interface GitRef {
  name?: string;
  commit?: string;
  remote?: string;
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: { HEAD?: GitRef; onDidChange?: vscode.Event<void> };
  getBranches(query: { remote: boolean; pattern?: string; count?: number }): Promise<GitRef[]>;
  checkout(treeish: string): Promise<void>;
}

interface GitApi {
  repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
  openRepository?(uri: vscode.Uri): Promise<GitRepository | null>;
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

async function gitApi(): Promise<GitApi | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return undefined;
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    return exports.getAPI(1);
  } catch {
    return undefined;
  }
}

function containsPath(root: string, target: string): boolean {
  const a = path.resolve(root);
  const b = path.resolve(target);
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

async function findRepository(cwd: string): Promise<GitRepository | undefined> {
  const api = await gitApi();
  if (!api) return undefined;
  const uri = vscode.Uri.file(cwd);
  const direct = api.getRepository(uri);
  if (direct) return direct;
  const known = api.repositories
    .filter((r) => containsPath(r.rootUri.fsPath, cwd))
    .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
  if (known) return known;
  try {
    return (await api.openRepository?.(uri)) || undefined;
  } catch {
    return undefined;
  }
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  const repo = await findRepository(cwd);
  const head = repo?.state.HEAD?.name;
  if (head) return head;
  const name = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!name) return undefined;
  if (name !== 'HEAD') return name;
  const short = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  return short ? `(${short})` : undefined;
}

export async function repositoryRoot(cwd: string): Promise<string | undefined> {
  const repo = await findRepository(cwd);
  if (repo) return repo.rootUri.fsPath;
  return await git(cwd, ['rev-parse', '--show-toplevel']);
}

/** Calls back whenever the repository holding `cwd` changes state (HEAD, branch, working tree). */
export function watchRepository(cwd: string, listener: () => void): vscode.Disposable {
  let inner: vscode.Disposable | undefined;
  let stopped = false;
  void findRepository(cwd).then((repo) => {
    if (stopped || !repo?.state.onDidChange) return;
    inner = repo.state.onDidChange(listener);
  });
  return new vscode.Disposable(() => {
    stopped = true;
    inner?.dispose();
  });
}

export async function switchBranch(cwd: string): Promise<void> {
  const root = await repositoryRoot(cwd);
  if (!root) {
    void vscode.window.showInformationMessage(`${prettyPath(cwd)} is not a git repository.`);
    return;
  }
  try {
    await vscode.commands.executeCommand('git.checkout', vscode.Uri.file(root));
    return;
  } catch {
    // the git extension may not know this repository yet; fall back to our own picker
  }
  const repo = await findRepository(root);
  const branches = repo ? await branchNames(repo) : await localBranchNames(root);
  if (!branches.length) {
    void vscode.window.showInformationMessage(`No local branches found in ${prettyPath(root)}.`);
    return;
  }
  const head = await currentBranch(root);
  const picked = await vscode.window.showQuickPick(
    branches.map((name) => ({ label: name, description: name === head ? 'current' : undefined })),
    { title: `Switch branch in ${path.basename(root)}`, placeHolder: 'Select a branch to check out' },
  );
  if (!picked || picked.label === head) return;
  try {
    if (repo) await repo.checkout(picked.label);
    else await run('git', ['-C', root, 'checkout', picked.label], { timeout: 30_000 });
  } catch (err) {
    void vscode.window.showErrorMessage(`Checkout failed: ${String((err as Error)?.message || err)}`);
  }
}

async function branchNames(repo: GitRepository): Promise<string[]> {
  try {
    const refs = await repo.getBranches({ remote: false });
    return refs.map((r) => r.name).filter((n): n is string => !!n);
  } catch {
    return await localBranchNames(repo.rootUri.fsPath);
  }
}

async function localBranchNames(root: string): Promise<string[]> {
  const out = await git(root, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads']);
  return out ? out.split('\n').filter(Boolean) : [];
}
