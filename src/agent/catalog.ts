import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import * as os from 'os';
import * as vscode from 'vscode';
import type { CommandOption, ModelOption } from '../chat/protocol';
import { childEnv } from './runner';

const STATE_KEY = 'claudeSessions.catalog';
const MAX_PROJECTS = 40;
const PROBE_TIMEOUT_MS = 20_000;

interface StoredCatalog {
  models?: ModelOption[];
  builtins?: CommandOption[];
  projects?: [string, CommandOption[]][];
}

/**
 * Models and slash commands known to the Claude CLI, cached across reloads so a chat tab can show them
 * before its own Claude process has started. Running sessions keep it current.
 */
export class ClaudeCatalog implements vscode.Disposable {
  private models: ModelOption[];
  private builtins: CommandOption[];
  private readonly projects: Map<string, CommandOption[]>;
  private probing?: Promise<void>;
  /** Fires with the project whose commands changed, or undefined when the models or built-in commands did. */
  private readonly emitter = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly state: vscode.Memento,
    private readonly log: vscode.OutputChannel,
  ) {
    const stored = state.get<StoredCatalog>(STATE_KEY) ?? {};
    this.models = Array.isArray(stored.models) ? stored.models : [];
    this.builtins = Array.isArray(stored.builtins) ? stored.builtins : [];
    this.projects = new Map(Array.isArray(stored.projects) ? stored.projects : []);
  }

  modelOptions(): ModelOption[] {
    return this.models;
  }

  commandsFor(cwd: string): CommandOption[] {
    return this.projects.get(cwd) ?? this.builtins;
  }

  setModels(list: ModelInfo[]): void {
    const models = toModelOptions(list);
    if (!models.length || sameJson(models, this.models)) return;
    this.models = models;
    this.save();
    this.emitter.fire(undefined);
  }

  setCommands(cwd: string, list: SlashCommand[]): void {
    const commands = toCommandOptions(list);
    const builtins = toCommandOptions(list.filter((c) => c.builtin));
    if (builtins.length && !sameJson(builtins, this.builtins)) {
      this.builtins = builtins;
      this.emitter.fire(undefined);
    }
    const previous = this.projects.get(cwd);
    this.projects.delete(cwd);
    this.projects.set(cwd, commands);
    while (this.projects.size > MAX_PROJECTS) this.projects.delete(this.projects.keys().next().value as string);
    this.save();
    if (!previous || !sameJson(previous, commands)) this.emitter.fire(cwd);
  }

  /** Asks a bare Claude process (no settings, hooks or plugins) for the lists when nothing is cached yet. */
  ensureLoaded(claudePath: () => Promise<string | undefined>): Promise<void> {
    if (this.models.length && this.builtins.length) return Promise.resolve();
    if (!this.probing) {
      this.probing = (async () => {
        const exe = await claudePath();
        if (!exe) return;
        const started = Date.now();
        try {
          const { models, commands } = await probe(exe);
          if (!this.models.length) this.setModels(models);
          const builtins = toCommandOptions(commands.filter((c) => c.builtin));
          if (!this.builtins.length && builtins.length) {
            this.builtins = builtins;
            this.save();
            this.emitter.fire(undefined);
          }
          this.log.appendLine(`Loaded ${models.length} models and ${builtins.length} commands in ${Date.now() - started} ms.`);
        } catch (err) {
          this.log.appendLine(`Could not list Claude models and commands: ${err instanceof Error ? err.message : String(err)}`);
        }
      })().finally(() => (this.probing = undefined));
    }
    return this.probing;
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private save(): void {
    const stored: StoredCatalog = { models: this.models, builtins: this.builtins, projects: [...this.projects] };
    void this.state.update(STATE_KEY, stored);
  }
}

export function toModelOptions(list: ModelInfo[]): ModelOption[] {
  return list
    .filter((m) => m && typeof m.value === 'string' && m.value)
    .map((m) => ({ value: m.value, label: m.displayName || m.value, description: m.description || undefined }));
}

export function toCommandOptions(list: SlashCommand[]): CommandOption[] {
  const seen = new Set<string>();
  const out: CommandOption[] = [];
  for (const c of list) {
    if (!c || typeof c.name !== 'string' || !c.name || c.name.startsWith('__') || seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({
      name: c.name,
      description: c.description || '',
      argumentHint: c.argumentHint || undefined,
      aliases: c.aliases?.length ? c.aliases : undefined,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function probe(claudePath: string): Promise<{ models: ModelInfo[]; commands: SlashCommand[] }> {
  let release: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (release = resolve));
  async function* noPrompt(): AsyncGenerator<SDKUserMessage> {
    await closed;
  }
  const q = query({
    prompt: noPrompt(),
    options: { cwd: os.tmpdir(), pathToClaudeCodeExecutable: claudePath, settingSources: [], env: childEnv() },
  });
  const drained = (async () => {
    try {
      for await (const _ of q) {
        /* nothing is sent, so nothing worth reading comes back */
      }
    } catch {
      /* closed below */
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${PROBE_TIMEOUT_MS / 1000}s`)), PROBE_TIMEOUT_MS);
    });
    const [models, commands] = await Promise.race([Promise.all([q.supportedModels(), q.supportedCommands()]), timeout]);
    return { models, commands };
  } finally {
    if (timer) clearTimeout(timer);
    release();
    try {
      q.close();
    } catch {
      /* already gone */
    }
    void drained;
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
