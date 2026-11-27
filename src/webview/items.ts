import { ChatItem } from '../chat/protocol';
import { button, el, icon } from './dom';
import { LinkHandlers, renderMarkdown } from './markdown';

export interface ItemHandlers extends LinkHandlers {
  openDiff(path: string): void;
}

const TOOL_ICONS: Record<string, string> = {
  Read: 'file',
  Write: 'new-file',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'notebook',
  Bash: 'terminal',
  BashOutput: 'terminal',
  KillShell: 'debug-stop',
  Grep: 'search',
  Glob: 'search',
  LS: 'folder-opened',
  WebFetch: 'globe',
  WebSearch: 'search-fuzzy',
  Task: 'hubot',
  Agent: 'hubot',
  TodoWrite: 'checklist',
  ExitPlanMode: 'checklist',
  AskUserQuestion: 'question',
  SlashCommand: 'terminal-bash',
  Skill: 'lightbulb',
};

export function toolIcon(name: string): string {
  if (name.startsWith('mcp__')) return 'plug';
  return TOOL_ICONS[name] || 'tools';
}

function statusIcon(status: string): HTMLElement {
  switch (status) {
    case 'running':
      return icon('loading codicon-modifier-spin', 'tool-state running');
    case 'error':
      return icon('error', 'tool-state error');
    case 'denied':
      return icon('circle-slash', 'tool-state denied');
    default:
      return icon('check', 'tool-state done');
  }
}

export function toolChildren(node: HTMLElement): HTMLElement | null {
  return node.querySelector(':scope > .tool-children');
}

function renderTool(item: Extract<ChatItem, { kind: 'tool' }>, h: ItemHandlers): HTMLElement {
  const root = el('div', 'item tool s-' + item.status);
  const row = el('div', 'tool-row');
  const body = el('div', 'tool-body');

  if (item.detail) body.appendChild(el('pre', 'tool-detail', item.detail));
  if (item.output) body.appendChild(el('pre', 'tool-output', item.output));
  const hasBody = body.childElementCount > 0;

  const chev = icon(hasBody ? 'chevron-right' : 'blank', 'chev');
  row.appendChild(chev);
  row.appendChild(icon(toolIcon(item.name), 'tool-icon'));

  const title = el('span', 'tool-title', item.title);
  if (item.file) {
    title.classList.add('clickable');
    title.title = (item.edit ? 'Open diff: ' : 'Open ') + item.file;
    title.addEventListener('click', (e) => {
      e.stopPropagation();
      if (item.edit) h.openDiff(item.file as string);
      else h.openFile(item.file as string);
    });
  }
  row.appendChild(title);

  if (item.edit && (item.edit.added || item.edit.removed)) {
    const d = el('span', 'tool-edit');
    if (item.edit.added) d.appendChild(el('span', 'added', '+' + item.edit.added));
    if (item.edit.removed) d.appendChild(el('span', 'removed', '−' + item.edit.removed));
    row.appendChild(d);
  }
  row.appendChild(statusIcon(item.status));

  if (hasBody) {
    row.classList.add('expandable');
    row.addEventListener('click', () => {
      const open = root.classList.toggle('open');
      chev.className = 'codicon codicon-chevron-' + (open ? 'down' : 'right') + ' chev';
    });
  }

  root.appendChild(row);
  root.appendChild(body);
  root.appendChild(el('div', 'tool-children'));
  return root;
}

export function renderItem(item: ChatItem, h: ItemHandlers): HTMLElement {
  let node: HTMLElement;
  switch (item.kind) {
    case 'user': {
      node = el('div', 'item user');
      const bubble = el('div', 'bubble', item.text);
      node.appendChild(bubble);
      if (item.images) bubble.appendChild(el('div', 'attachments', item.images + (item.images === 1 ? ' image' : ' images')));
      break;
    }
    case 'assistant': {
      node = el('div', 'item assistant');
      node.appendChild(renderMarkdown(item.markdown, h));
      break;
    }
    case 'thinking': {
      const d = el('details', 'item thinking');
      const s = el('summary');
      s.appendChild(icon('lightbulb'));
      s.appendChild(el('span', undefined, 'Thought process'));
      d.appendChild(s);
      d.appendChild(el('div', 'think', item.text));
      node = d;
      break;
    }
    case 'tool':
      node = renderTool(item, h);
      break;
    default: {
      node = el('div', 'item system level-' + item.level);
      if (item.level !== 'info') node.appendChild(icon(item.level === 'error' ? 'error' : 'warning'));
      node.appendChild(el('span', undefined, item.text));
      break;
    }
  }
  node.dataset.id = item.id;
  return node;
}

export function showOlderButton(count: number, onClick: () => void): HTMLElement {
  const b = button('show-older', 'Show ' + count + ' earlier message' + (count === 1 ? '' : 's'));
  b.prepend(icon('fold-up'));
  b.addEventListener('click', onClick);
  return b;
}
