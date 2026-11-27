import * as fsp from 'fs/promises';
import * as path from 'path';
import { parseEntries } from '../chat/transcriptTail';
import { countLineChanges } from './lineDiff';

export interface SessionFileChange {
  path: string;
  original: string | null;
  toolUseIds: string[];
  lastEditTs?: number;
  /** The transcript did not record the file content before the first edit, so `original` is unknown rather than empty. */
  originalUnknown?: boolean;
  /** Lines the session's edits to this file added/removed, summed over every edit. */
  added?: number;
  removed?: number;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DENIED_RE =
  /the user doesn't want to proceed|tool use was rejected|user rejected|user denied|permission for this action was denied|denied by the claude code/i;

export async function readTranscriptEntries(transcriptPath: string): Promise<unknown[]> {
  try {
    return parseEntries(await fsp.readFile(transcriptPath, 'utf8'));
  } catch {
    return [];
  }
}

export function collectSessionEdits(entries: unknown[]): Map<string, SessionFileChange> {
  const changes = new Map<string, SessionFileChange>();
  const pending = new Map<string, { name: string; file?: string }>();

  for (const raw of entries) {
    const entry = raw as any;
    if (!entry || typeof entry !== 'object') continue;
    const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    if (entry.type === 'assistant') {
      for (const block of content) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string' || !EDIT_TOOLS.has(block.name)) continue;
        pending.set(block.id, { name: block.name, file: inputPath(block.input, cwd) });
      }
      continue;
    }
    if (entry.type !== 'user') continue;

    const results = content.filter((b: any) => b?.type === 'tool_result');
    for (const block of results) {
      const info = pending.get(block.tool_use_id);
      if (!info || block.is_error || isDenied(entry, block)) continue;
      const result = resultFor(entry, results.length);
      const file = resultPath(result, cwd) ?? info.file;
      if (!file) continue;
      const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : undefined;
      const counts = editCounts(result);
      const existing = changes.get(file);
      if (existing) {
        existing.toolUseIds.push(block.tool_use_id);
        if (ts && !Number.isNaN(ts)) existing.lastEditTs = ts;
        existing.added = (existing.added ?? 0) + counts.added;
        existing.removed = (existing.removed ?? 0) + counts.removed;
        continue;
      }
      const known = typeof result?.originalFile === 'string';
      changes.set(file, {
        path: file,
        original: known ? result.originalFile : null,
        toolUseIds: [block.tool_use_id],
        lastEditTs: ts && !Number.isNaN(ts) ? ts : undefined,
        originalUnknown: known || isCreate(result) ? undefined : true,
        added: counts.added,
        removed: counts.removed
      });
    }
  }
  return changes;
}

function isCreate(result: any): boolean {
  return result?.type === 'create' || (Array.isArray(result?.structuredPatch) && !result.structuredPatch.length && typeof result?.content === 'string');
}

function editCounts(result: any): { added: number; removed: number } {
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
  const content = typeof result?.content === 'string' ? result.content : undefined;
  if (content !== undefined) return countLineChanges(original ?? '', content);
  if (original !== undefined && typeof result?.oldString === 'string' && typeof result?.newString === 'string') {
    return countLineChanges(result.oldString, result.newString);
  }
  return { added: 0, removed: 0 };
}

function resultFor(entry: any, resultCount: number): any {
  if (resultCount !== 1) return undefined;
  const result = entry.toolUseResult ?? entry.tool_use_result;
  return result && typeof result === 'object' && !Array.isArray(result) ? result : undefined;
}

function inputPath(input: any, cwd: string | undefined): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  return absolute(input.file_path ?? input.notebook_path, cwd);
}

function resultPath(result: any, cwd: string | undefined): string | undefined {
  if (!result) return undefined;
  return absolute(result.filePath ?? result.file_path ?? result.notebook_path, cwd);
}

function absolute(file: unknown, cwd: string | undefined): string | undefined {
  if (typeof file !== 'string' || !file) return undefined;
  if (path.isAbsolute(file)) return path.normalize(file);
  return cwd ? path.resolve(cwd, file) : undefined;
}

function isDenied(entry: any, block: any): boolean {
  const kind = entry.toolDenialKind;
  if (typeof kind === 'string' && kind !== 'interrupted' && kind !== 'cancelled') return true;
  if (entry.permissionDecision?.decision === 'reject') return true;
  const content = block?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? JSON.stringify(content).slice(0, 600) : '';
  return DENIED_RE.test(text.slice(0, 600));
}
