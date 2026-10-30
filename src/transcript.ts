import * as fsp from 'fs/promises';

export interface TranscriptMeta {
  sessionId?: string;
  cwd?: string;
  entrypoint?: string;
  gitBranch?: string;
  version?: string;
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  firstPrompt?: string;
  lastTimestamp?: number;
  pendingQuestion: boolean;
  hasUserMessage: boolean;
}

const HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 512 * 1024;
const CHUNK = 64 * 1024;

export async function parseTranscript(file: string, size: number): Promise<TranscriptMeta> {
  const meta: TranscriptMeta = { pendingQuestion: false, hasUserMessage: false };
  const fh = await fsp.open(file, 'r');
  try {
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      for (const line of buf.toString('utf8').split('\n')) handleLine(meta, line, true);
      return meta;
    }
    await readHead(fh, meta);
    const tail = Buffer.alloc(TAIL_BYTES);
    await fh.read(tail, 0, TAIL_BYTES, size - TAIL_BYTES);
    const lines = tail.toString('utf8').split('\n');
    lines.shift();
    for (const line of lines) handleLine(meta, line, false);
    return meta;
  } finally {
    await fh.close();
  }
}

async function readHead(fh: fsp.FileHandle, meta: TranscriptMeta): Promise<void> {
  let offset = 0;
  let rest = '';
  const buf = Buffer.alloc(CHUNK);
  while (offset < HEAD_BYTES) {
    const { bytesRead } = await fh.read(buf, 0, CHUNK, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
    rest += buf.toString('utf8', 0, bytesRead);
    const parts = rest.split('\n');
    rest = parts.pop() ?? '';
    for (const line of parts) handleLine(meta, line, true);
    if (meta.cwd && meta.entrypoint && meta.firstPrompt && (meta.aiTitle || meta.customTitle)) break;
  }
}

function handleLine(meta: TranscriptMeta, line: string, headPhase: boolean): void {
  if (!line || line[0] !== '{') return;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  if (!obj || typeof obj !== 'object') return;

  if (typeof obj.sessionId === 'string' && !meta.sessionId) meta.sessionId = obj.sessionId;
  if (typeof obj.cwd === 'string' && !meta.cwd) meta.cwd = obj.cwd;
  if (typeof obj.entrypoint === 'string') meta.entrypoint = obj.entrypoint;
  if (typeof obj.gitBranch === 'string') meta.gitBranch = obj.gitBranch;
  if (typeof obj.version === 'string') meta.version = obj.version;
  if (typeof obj.timestamp === 'string') {
    const t = Date.parse(obj.timestamp);
    if (!Number.isNaN(t) && (!meta.lastTimestamp || t > meta.lastTimestamp)) meta.lastTimestamp = t;
  }

  switch (obj.type) {
    case 'custom-title':
      if (typeof obj.customTitle === 'string') meta.customTitle = obj.customTitle;
      return;
    case 'ai-title':
      if (typeof obj.aiTitle === 'string') meta.aiTitle = obj.aiTitle;
      return;
    case 'last-prompt':
      if (typeof obj.lastPrompt === 'string') meta.lastPrompt = obj.lastPrompt;
      return;
    case 'user': {
      if (obj.isSidechain) return;
      const content = obj.message?.content;
      if (hasToolResult(content) || obj.isMeta) {
        if (meta.pendingQuestion && hasToolResult(content)) meta.pendingQuestion = false;
        return;
      }
      const text = promptText(content);
      if (text) {
        meta.hasUserMessage = true;
        meta.pendingQuestion = false;
        if (headPhase && !meta.firstPrompt) meta.firstPrompt = text;
      }
      return;
    }
    case 'assistant': {
      if (obj.isSidechain) return;
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use' && block.name === 'AskUserQuestion') meta.pendingQuestion = true;
          else if (block?.type === 'tool_use') meta.pendingQuestion = false;
        }
      }
      return;
    }
    default:
      return;
  }
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((b) => b?.type === 'tool_result');
}

function promptText(content: unknown): string | undefined {
  let raw: string | undefined;
  if (typeof content === 'string') raw = content;
  else if (Array.isArray(content)) {
    raw = content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
  }
  if (!raw) return undefined;
  return cleanPrompt(raw);
}

export function cleanPrompt(raw: string): string | undefined {
  let text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content[^>]*>|<\/pasted_content>/g, '')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, '')
    .trim();
  if (!text || text.startsWith('<') || text.startsWith('[Request interrupted')) return undefined;
  text = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  if (!text) return undefined;
  return text.length > 100 ? text.slice(0, 97) + '…' : text;
}
