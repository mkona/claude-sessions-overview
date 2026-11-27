import { ChatItem } from './protocol';
import { countLineChanges } from '../changes/lineDiff';

const OUTPUT_LIMIT = 4000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SYSTEM_SUBTYPES = new Set(['compact_boundary', 'api_error', 'local_command', 'informational', 'model_consent_fallback']);
const DENIED_RE =
  /the user doesn't want to proceed|tool use was rejected|user rejected|user denied|permission for this action was denied|denied by the claude code/i;
const INTERRUPT_RE = /^\[Request interrupted/;

export class ChatModel {
  private readonly order: string[] = [];
  private readonly byId = new Map<string, ChatItem>();
  private readonly toolInputs = new Map<string, unknown>();
  private cwd: string | undefined;
  private fallbackId = 0;

  /** The cwd the session itself reports, which can differ from the workspace path (symlinks). */
  sessionCwd(): string | undefined {
    return this.cwd;
  }

  items(): ChatItem[] {
    const out: ChatItem[] = [];
    for (const id of this.order) {
      const item = this.byId.get(id);
      if (item) out.push(item);
    }
    return out;
  }

  ingest(entry: unknown): ChatItem[] {
    try {
      return this.ingestEntry(entry as any);
    } catch {
      return [];
    }
  }

  private ingestEntry(entry: any): ChatItem[] {
    if (!entry || typeof entry !== 'object') return [];
    if (typeof entry.cwd === 'string' && entry.cwd) this.cwd = entry.cwd;
    if (entry.isSidechain) return [];
    switch (entry.type) {
      case 'user':
        return this.ingestUser(entry);
      case 'assistant':
        return this.ingestAssistant(entry);
      case 'system':
        return this.ingestSystem(entry);
      default:
        return [];
    }
  }

  private ingestUser(entry: any): ChatItem[] {
    const content = entry.message?.content;
    const blocks: any[] = Array.isArray(content) ? content : [];
    const results = blocks.filter((b) => b?.type === 'tool_result');
    if (results.length) return this.applyToolResults(entry, results);
    if (entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return [];

    const raw = typeof content === 'string' ? content : blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n');
    const images = blocks.filter((b) => b?.type === 'image').length;
    const id = this.idFor(entry);
    const ts = timestamp(entry);
    const changed: ChatItem[] = [];

    if (INTERRUPT_RE.test(raw.trim())) return this.collect(changed, { kind: 'system', id, text: 'Interrupted', level: 'info' });

    const command = parseCommand(raw);
    if (command) this.collect(changed, { kind: 'user', id, text: command, ts });
    const stdout = parseLocalStdout(raw);
    if (stdout) this.collect(changed, { kind: 'system', id: `${id}:out`, text: stdout, level: 'info' });
    if (command || stdout) return changed;

    const text = cleanText(raw);
    if (!text && !images) return [];
    return this.collect(changed, { kind: 'user', id, text, images: images || undefined, ts });
  }

  private ingestAssistant(entry: any): ChatItem[] {
    const content = entry.message?.content;
    const id = this.idFor(entry);
    if (entry.isApiErrorMessage) {
      const text = blockText(content).trim() || 'API error';
      return this.collect([], { kind: 'system', id, text, level: 'error' });
    }
    if (!Array.isArray(content)) return [];
    const parentToolUseId = typeof entry.parent_tool_use_id === 'string' ? entry.parent_tool_use_id : undefined;
    const ts = timestamp(entry);
    const changed: ChatItem[] = [];

    content.forEach((block: any, index: number) => {
      if (!block || typeof block !== 'object') return;
      if (block.type === 'text') {
        if (parentToolUseId) return;
        const markdown = String(block.text ?? '').trim();
        if (markdown) this.collect(changed, { kind: 'assistant', id: `${id}:${index}`, markdown, ts });
        return;
      }
      if (block.type === 'thinking') {
        if (parentToolUseId) return;
        const text = String(block.thinking ?? '').trim();
        if (text) this.collect(changed, { kind: 'thinking', id: `${id}:${index}`, text });
        return;
      }
      if (block.type !== 'tool_use') return;
      const toolId = typeof block.id === 'string' && block.id ? block.id : `${id}:${index}`;
      this.toolInputs.set(toolId, block.input);
      const name = String(block.name ?? 'tool');
      const { title, detail, file } = toolTitle(name, block.input, this.cwd);
      const previous = this.byId.get(toolId);
      const done = previous?.kind === 'tool' && previous.status !== 'running' ? previous : undefined;
      this.collect(changed, {
        kind: 'tool',
        id: toolId,
        name,
        title,
        detail,
        status: done?.status ?? 'running',
        output: done?.output,
        file: done?.file ?? file,
        edit: done?.edit,
        parentToolUseId
      });
    });
    return changed;
  }

  private ingestSystem(entry: any): ChatItem[] {
    const subtype = String(entry.subtype ?? '');
    if (!SYSTEM_SUBTYPES.has(subtype)) return [];
    const id = this.idFor(entry);
    if (subtype === 'compact_boundary') return this.collect([], { kind: 'system', id, text: 'Conversation compacted', level: 'info' });
    if (subtype === 'api_error') {
      const message = typeof entry.error?.message === 'string' ? entry.error.message : typeof entry.content === 'string' ? entry.content : '';
      return this.collect([], { kind: 'system', id, text: message ? `API error: ${message}` : 'API error', level: 'error' });
    }
    if (subtype === 'local_command') {
      // The command itself is already rendered from its user entry; only its output is new.
      const stdout = parseLocalStdout(typeof entry.content === 'string' ? entry.content : '');
      if (!stdout) return [];
      return this.collect([], { kind: 'system', id, text: stdout, level: 'info' });
    }
    const text = typeof entry.content === 'string' ? cleanText(entry.content) : '';
    if (!text) return [];
    return this.collect([], { kind: 'system', id, text, level: level(entry.level) });
  }

  private applyToolResults(entry: any, results: any[]): ChatItem[] {
    const changed: ChatItem[] = [];
    for (const block of results) {
      const toolId = block?.tool_use_id;
      const previous = typeof toolId === 'string' ? this.byId.get(toolId) : undefined;
      if (!previous || previous.kind !== 'tool') continue;
      const result = resultFor(entry, results.length);
      const output = truncate(stripAnsi(blockText(block.content)).trim(), OUTPUT_LIMIT);
      const edit = computeEdit(previous.name, this.toolInputs.get(toolId), result);
      this.collect(changed, {
        ...previous,
        status: isDenied(entry, block) ? 'denied' : block.is_error ? 'error' : 'done',
        output: output || previous.output,
        file: resultPath(result) ?? previous.file,
        edit: edit ?? previous.edit
      });
    }
    return changed;
  }

  private collect(changed: ChatItem[], item: ChatItem): ChatItem[] {
    const existing = this.byId.get(item.id);
    if (!existing) this.order.push(item.id);
    else if (JSON.stringify(existing) === JSON.stringify(item)) return changed;
    this.byId.set(item.id, item);
    changed.push(item);
    return changed;
  }

  private idFor(entry: any): string {
    if (typeof entry.uuid === 'string' && entry.uuid) return entry.uuid;
    if (typeof entry.message?.id === 'string' && entry.message.id) return entry.message.id;
    return `local-${++this.fallbackId}`;
  }
}

export function toolTitle(name: string, input: any, cwd?: string): { title: string; detail?: string; file?: string } {
  const inp = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const file = typeof inp.file_path === 'string' ? inp.file_path : typeof inp.notebook_path === 'string' ? inp.notebook_path : undefined;
      if (!file) return { title: name };
      return { title: `${name} ${relative(file, cwd)}`, file };
    }
    case 'Bash': {
      const command = typeof inp.command === 'string' ? inp.command : '';
      return { title: command ? `Run \`${oneLine(command, 90)}\`` : 'Run command', detail: command || undefined };
    }
    case 'Grep':
      return { title: `Search \`${oneLine(String(inp.pattern ?? ''), 60)}\``, detail: joinDetail([inp.path, inp.glob, inp.output_mode]) };
    case 'Glob':
      return { title: `Search \`${oneLine(String(inp.pattern ?? ''), 60)}\``, detail: joinDetail([inp.path]) };
    case 'WebFetch': {
      const url = String(inp.url ?? '');
      return { title: `Fetch ${hostOf(url) || oneLine(url, 60)}`, detail: joinDetail([url, inp.prompt]) };
    }
    case 'WebSearch':
      return { title: `Web search \`${oneLine(String(inp.query ?? ''), 70)}\`` };
    case 'Task':
    case 'Agent': {
      const description = oneLine(String(inp.description ?? inp.subagent_type ?? ''), 70);
      return { title: description ? `Agent: ${description}` : 'Agent', detail: truncate(String(inp.prompt ?? ''), 2000) || undefined };
    }
    case 'TodoWrite':
      return { title: 'Update todos', detail: todoDetail(inp.todos) };
    case 'Skill':
      return { title: `Skill: ${oneLine(String(inp.skill ?? ''), 60)}`, detail: truncate(String(inp.args ?? ''), 2000) || undefined };
    default:
      break;
  }
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    if (parts.length >= 3) return { title: `${parts[1]}: ${parts.slice(2).join('__')}`, detail: inputDetail(inp) };
  }
  return { title: name, detail: inputDetail(inp) };
}

function computeEdit(name: string, input: any, result: any): { added: number; removed: number } | undefined {
  if (!EDIT_TOOLS.has(name)) return undefined;
  const patch = result?.structuredPatch;
  if (Array.isArray(patch) && patch.length) {
    let added = 0;
    let removed = 0;
    for (const hunk of patch) {
      for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) {
        if (typeof line !== 'string') continue;
        if (line[0] === '+') added++;
        else if (line[0] === '-') removed++;
      }
    }
    return { added, removed };
  }
  const original = typeof result?.originalFile === 'string' ? result.originalFile : undefined;
  const content = typeof result?.content === 'string' ? result.content : typeof input?.content === 'string' ? input.content : undefined;
  if (original !== undefined && content !== undefined) return countLineChanges(original, content);
  if (typeof result?.oldString === 'string' && typeof result?.newString === 'string') return countLineChanges(result.oldString, result.newString);
  if (typeof input?.old_string === 'string' && typeof input?.new_string === 'string') return countLineChanges(input.old_string, input.new_string);
  if (content !== undefined) return { added: content ? content.replace(/\n$/, '').split('\n').length : 0, removed: 0 };
  return undefined;
}

function resultFor(entry: any, resultCount: number): any {
  if (resultCount !== 1) return undefined;
  const result = entry.toolUseResult ?? entry.tool_use_result;
  return result && typeof result === 'object' && !Array.isArray(result) ? result : undefined;
}

function resultPath(result: any): string | undefined {
  const file = result?.filePath ?? result?.file_path;
  return typeof file === 'string' && file ? file : undefined;
}

function isDenied(entry: any, block: any): boolean {
  const kind = entry.toolDenialKind;
  if (typeof kind === 'string' && kind !== 'interrupted' && kind !== 'cancelled') return true;
  if (entry.permissionDecision?.decision === 'reject') return true;
  return DENIED_RE.test(blockText(block?.content).slice(0, 600));
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: any) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : block?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

function cleanText(raw: string): string {
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, '')
    .replace(/<skill-format>[\s\S]*?<\/skill-format>/g, '')
    .replace(/<pasted_content[^>]*>|<\/pasted_content>/g, '')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, '')
    .trim();
}

function parseCommand(raw: string): string | undefined {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(raw)?.[1]?.trim();
  if (!name) return undefined;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim();
  const slug = name.startsWith('/') ? name : `/${name}`;
  return args ? `${slug} ${args}` : slug;
}

function parseLocalStdout(raw: string): string | undefined {
  const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(raw)?.[1];
  const text = out ? stripAnsi(out).trim() : '';
  return text ? truncate(text, OUTPUT_LIMIT) : undefined;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function level(raw: unknown): 'info' | 'warning' | 'error' {
  if (raw === 'error') return 'error';
  if (raw === 'warning' || raw === 'warn') return 'warning';
  return 'info';
}

function timestamp(entry: any): number | undefined {
  if (typeof entry.timestamp !== 'string') return undefined;
  const ts = Date.parse(entry.timestamp);
  return Number.isNaN(ts) ? undefined : ts;
}

function relative(file: string, cwd: string | undefined): string {
  if (!cwd) return file;
  if (file === cwd) return '.';
  return file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file;
}

function hostOf(url: string): string | undefined {
  return /^https?:\/\/([^/?#]+)/i.exec(url)?.[1];
}

function oneLine(text: string, limit: number): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), limit);
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function joinDetail(parts: unknown[]): string | undefined {
  const detail = parts
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .join('\n')
    .trim();
  return detail ? truncate(detail, 2000) : undefined;
}

function todoDetail(todos: unknown): string | undefined {
  if (!Array.isArray(todos)) return undefined;
  const lines = todos
    .map((todo: any) => {
      const text = typeof todo?.content === 'string' ? todo.content : '';
      if (!text) return '';
      const mark = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '▸' : '○';
      return `${mark} ${text}`;
    })
    .filter(Boolean);
  return lines.length ? truncate(lines.join('\n'), 2000) : undefined;
}

function inputDetail(input: any): string | undefined {
  try {
    const json = JSON.stringify(input);
    if (!json || json === '{}') return undefined;
    return truncate(json, 1000);
  } catch {
    return undefined;
  }
}
