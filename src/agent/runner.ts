import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, ModelInfo, Options, PermissionResult, Query, SDKMessage, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionModeName, RunStatus } from '../chat/protocol';

type PermissionAskInfo = Parameters<CanUseTool>[2];

export interface RunnerOptions {
  cwd: string;
  claudePath: string;
  resume?: string;
  model?: string;
  permissionMode: PermissionModeName;
}

export interface PermissionAsk {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  hasSuggestions: boolean;
  blockedPath?: string;
  decisionReason?: string;
}

export type PermissionAnswer = { decision: 'allow' | 'allowSession' } | { decision: 'deny'; message?: string };

export interface RunnerEvents {
  sessionId(id: string): void;
  status(s: RunStatus): void;
  partial(text: string | null): void;
  message(m: unknown): void;
  permission(ask: PermissionAsk, signal: AbortSignal): Promise<PermissionAnswer>;
  question(questions: unknown[], signal: AbortSignal): Promise<Record<string, string> | null>;
  models(list: ModelInfo[]): void;
  commands(list: SlashCommand[]): void;
  /** The conversation was discarded (/clear); a new session id follows with the next init. */
  reset(): void;
  permissionModeChanged(mode: PermissionModeName): void;
  error(message: string): void;
  /** Queued messages the process never received, so the owner can give them back to the user. */
  dropped(texts: string[]): void;
  exit(): void;
}

const PARTIAL_MS = 50;
const STDERR_KEEP = 40;

export class SessionRunner {
  private readonly opts: RunnerOptions;
  private readonly events: RunnerEvents;

  private q: Query | undefined;
  private inbox: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private inputClosed = false;

  private pending: string[] = [];
  private turnActive = false;
  private initialized = false;
  private pendingAsks = 0;
  private interrupting = false;
  private stderrLines: string[] = [];

  private partialText: string | null = null;
  private partialTimer: NodeJS.Timeout | undefined;
  private lastPartialAt = 0;
  private textBlockIndex: number | undefined;

  private _sessionId: string | undefined;
  private _alive = false;
  private mode: PermissionModeName;
  private model: string | undefined;

  constructor(opts: RunnerOptions, events: RunnerEvents) {
    this.opts = opts;
    this.events = events;
    this.mode = opts.permissionMode;
    this.model = opts.model;
    this._sessionId = opts.resume;
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  get alive(): boolean {
    return this._alive;
  }

  get busy(): boolean {
    return this.turnActive || this.pending.length > 0;
  }

  /** Starts the Claude process without sending anything, so its commands are known before the first prompt. */
  warm(): void {
    if (this.q) return;
    this.start();
    this.reportTurnStatus();
  }

  send(text: string): void {
    if (!text.trim()) return;
    this.pending.push(text);
    if (!this.q) this.start();
    this.flush();
  }

  async interrupt(): Promise<void> {
    this.pending = [];
    if (!this.q || !this.turnActive) return;
    this.interrupting = true;
    try {
      await this.q.interrupt();
    } catch (err) {
      this.interrupting = false;
      this.events.error(describe(err));
    }
  }

  async setPermissionMode(mode: PermissionModeName): Promise<void> {
    this.mode = mode;
    if (!this.q) {
      this.events.permissionModeChanged(mode);
      return;
    }
    try {
      const res = await this.q.setPermissionMode(mode);
      const applied = (res?.mode as PermissionModeName | undefined) ?? mode;
      this.mode = applied;
      this.events.permissionModeChanged(applied);
    } catch (err) {
      this.events.error(describe(err));
    }
  }

  async setModel(model: string | undefined): Promise<void> {
    this.model = model;
    if (!this.q) return;
    try {
      await this.q.setModel(model);
    } catch (err) {
      this.events.error(describe(err));
    }
  }

  dispose(): void {
    this.pending = [];
    this.clearPartial();
    this.closeInput();
    const q = this.q;
    this.q = undefined;
    if (q) {
      try {
        q.close();
      } catch {
        /* already gone */
      }
    }
    this.finish();
  }

  private start(): void {
    this.inbox = [];
    this.inputClosed = false;
    this.initialized = false;
    this.turnActive = false;
    this.pendingAsks = 0;
    this.interrupting = false;
    this.stderrLines = [];
    this._alive = true;
    this.events.status({ state: 'starting' });

    const options: Options = {
      cwd: this.opts.cwd,
      pathToClaudeCodeExecutable: this.opts.claudePath,
      includePartialMessages: true,
      permissionMode: this.mode,
      env: childEnv(),
      canUseTool: (toolName, input, info) => this.onCanUseTool(toolName, input, info),
      stderr: (data) => this.onStderr(data)
    };
    if (this.opts.resume || this._sessionId) options.resume = this._sessionId ?? this.opts.resume;
    if (this.model) options.model = this.model;
    if (this.mode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;

    try {
      this.q = query({ prompt: this.input(), options });
    } catch (err) {
      this.fail(describe(err));
      return;
    }
    void this.consume(this.q);
    void this.askCatalog(this.q);
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = this.inbox.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.inputClosed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private closeInput(): void {
    this.inputClosed = true;
    this.wake?.();
    this.wake = undefined;
  }

  private flush(): void {
    if (!this.q || this.turnActive) return;
    const text = this.pending.shift();
    if (text === undefined) return;
    this.turnActive = true;
    this.inbox.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this._sessionId ?? ''
    } as SDKUserMessage);
    this.wake?.();
    this.wake = undefined;
    this.reportTurnStatus();
  }

  private reportTurnStatus(): void {
    if (this.pendingAsks > 0) this.events.status({ state: 'waiting' });
    else if (this.turnActive) this.events.status({ state: this.initialized ? 'working' : 'starting' });
    else this.events.status({ state: 'idle' });
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const message of q) {
        if (this.q !== q) break;
        this.handle(message);
      }
      if (this.q === q) {
        this.q = undefined;
        this.finish();
      }
    } catch (err) {
      if (this.q !== q) return;
      this.q = undefined;
      this.fail(describe(err));
    }
  }

  private handle(m: SDKMessage): void {
    switch (m.type) {
      case 'system':
        this.handleSystem(m);
        return;
      case 'stream_event':
        this.handleStreamEvent(m.event as unknown);
        return;
      case 'assistant':
        this.clearPartial();
        this.events.message(m);
        return;
      case 'user':
        this.events.message(m);
        return;
      case 'result':
        this.handleResult(m);
        return;
      case 'conversation_reset':
        this.clearPartial();
        this.events.reset();
        return;
      default:
        return;
    }
  }

  private handleSystem(m: Extract<SDKMessage, { type: 'system' }>): void {
    if (m.subtype === 'init') {
      this.initialized = true;
      if (m.session_id) {
        this._sessionId = m.session_id;
        this.events.sessionId(m.session_id);
      }
      this.applyMode(m.permissionMode);
      this.reportTurnStatus();
      return;
    }
    if (m.subtype === 'status' && m.permissionMode) this.applyMode(m.permissionMode);
    if (m.subtype === 'commands_changed' && Array.isArray(m.commands)) this.events.commands(m.commands);
  }

  private applyMode(mode: string | undefined): void {
    if (!mode || !isPermissionModeName(mode) || mode === this.mode) return;
    this.mode = mode;
    this.events.permissionModeChanged(mode);
  }

  private handleResult(m: Extract<SDKMessage, { type: 'result' }>): void {
    this.clearPartial();
    this.turnActive = false;
    const failed = m.subtype !== 'success' || ('is_error' in m && m.is_error === true);
    if (this.interrupting) {
      this.interrupting = false;
      this.events.status({ state: 'idle' });
    } else if (failed) {
      const detail = resultText(m) || m.subtype;
      this.events.error(detail);
      this.events.status({ state: 'error', detail });
    } else {
      this.events.status({ state: 'idle' });
    }
    this.flush();
  }

  private handleStreamEvent(event: unknown): void {
    const ev = event as { type?: string; index?: number; content_block?: { type?: string }; delta?: { type?: string; text?: string } };
    if (!ev || typeof ev.type !== 'string') return;
    if (ev.type === 'content_block_start') {
      if (ev.content_block?.type === 'text') {
        this.textBlockIndex = ev.index;
        this.partialText = '';
      }
      return;
    }
    if (ev.type === 'content_block_delta') {
      if (ev.delta?.type !== 'text_delta' || typeof ev.delta.text !== 'string') return;
      if (ev.index !== undefined && this.textBlockIndex !== undefined && ev.index !== this.textBlockIndex) return;
      this.partialText = (this.partialText ?? '') + ev.delta.text;
      this.schedulePartial();
      return;
    }
    if (ev.type === 'content_block_stop' && (ev.index === undefined || ev.index === this.textBlockIndex)) {
      this.textBlockIndex = undefined;
      this.clearPartial();
    }
  }

  private schedulePartial(): void {
    if (this.partialTimer) return;
    const wait = Math.max(0, PARTIAL_MS - (Date.now() - this.lastPartialAt));
    this.partialTimer = setTimeout(() => {
      this.partialTimer = undefined;
      if (this.partialText === null) return;
      this.lastPartialAt = Date.now();
      this.events.partial(this.partialText);
    }, wait);
  }

  private clearPartial(): void {
    if (this.partialTimer) {
      clearTimeout(this.partialTimer);
      this.partialTimer = undefined;
    }
    if (this.partialText === null) return;
    this.partialText = null;
    this.textBlockIndex = undefined;
    this.events.partial(null);
  }

  private async onCanUseTool(toolName: string, input: Record<string, unknown>, info: PermissionAskInfo): Promise<PermissionResult> {
    this.pendingAsks++;
    this.reportTurnStatus();
    try {
      if (toolName === 'AskUserQuestion') return await this.askQuestion(input, info.signal);
      const ask: PermissionAsk = {
        toolName,
        input,
        toolUseId: info.toolUseID,
        hasSuggestions: (info.suggestions?.length ?? 0) > 0,
        blockedPath: info.blockedPath,
        decisionReason: info.decisionReason
      };
      const answer = await this.events.permission(ask, info.signal);
      if (answer.decision === 'deny') return { behavior: 'deny', message: answer.message || 'User denied' };
      if (answer.decision === 'allowSession') return { behavior: 'allow', updatedInput: input, updatedPermissions: info.suggestions };
      return { behavior: 'allow', updatedInput: input };
    } catch (err) {
      return { behavior: 'deny', message: describe(err) };
    } finally {
      this.pendingAsks--;
      this.reportTurnStatus();
    }
  }

  private async askQuestion(input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const questions = Array.isArray(input.questions) ? (input.questions as unknown[]) : [];
    const answers = await this.events.question(questions, signal);
    if (!answers) return { behavior: 'deny', message: 'User dismissed the question' };
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  }

  private async askCatalog(q: Query): Promise<void> {
    try {
      const [models, commands] = await Promise.all([q.supportedModels(), q.supportedCommands()]);
      if (this.q !== q) return;
      this.events.models(models);
      this.events.commands(commands);
    } catch {
      /* the process went away before it answered */
    }
  }

  private onStderr(data: string): void {
    for (const line of data.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) this.stderrLines.push(trimmed);
    }
    if (this.stderrLines.length > STDERR_KEEP) this.stderrLines = this.stderrLines.slice(-STDERR_KEEP);
  }

  private fail(message: string): void {
    const detail = [message, this.stderrLines.slice(-5).join('\n')].filter(Boolean).join('\n');
    this.clearPartial();
    this.events.error(detail);
    this.events.status({ state: 'error', detail: message });
    this.finish();
  }

  private finish(): void {
    if (!this._alive) return;
    this._alive = false;
    this.turnActive = false;
    this.initialized = false;
    const undelivered = this.pending;
    this.pending = [];
    this.closeInput();
    if (undelivered.length) this.events.dropped(undelivered);
    this.events.exit();
  }
}

export function childEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDECODE;
  return env;
}

function isPermissionModeName(mode: string): mode is PermissionModeName {
  return mode === 'default' || mode === 'acceptEdits' || mode === 'plan' || mode === 'auto' || mode === 'bypassPermissions';
}

function resultText(m: Extract<SDKMessage, { type: 'result' }>): string {
  const withResult = m as { result?: unknown };
  return typeof withResult.result === 'string' ? withResult.result : '';
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
