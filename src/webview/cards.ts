import { PermissionDecision, PermissionRequestView, QuestionRequestView } from '../chat/protocol';
import { basename, button, el, icon } from './dom';

const MINI_DIFF_MAX = 32;

function split(text: string): string[] {
  if (!text.length) return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffLines(before: string, after: string): HTMLElement {
  const a = split(before);
  const b = split(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const host = el('div', 'diff-lines');
  const context = 2;
  const ctxStart = Math.max(0, head - context);
  for (let i = ctxStart; i < head; i++) host.appendChild(el('div', 'dl ctx', ' ' + a[i]));
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  let shown = 0;
  let clipped = 0;
  for (const line of removed) {
    if (shown++ < MINI_DIFF_MAX) host.appendChild(el('div', 'dl del', '− ' + line));
    else clipped++;
  }
  for (const line of added) {
    if (shown++ < MINI_DIFF_MAX) host.appendChild(el('div', 'dl add', '+ ' + line));
    else clipped++;
  }
  const ctxEnd = Math.min(a.length, a.length - tail + context);
  for (let i = a.length - tail; i < ctxEnd; i++) host.appendChild(el('div', 'dl ctx', ' ' + a[i]));
  if (clipped) host.appendChild(el('div', 'dl more', '… ' + clipped + ' more changed lines'));
  if (!removed.length && !added.length) host.appendChild(el('div', 'dl more', 'No textual change'));
  return host;
}

export function renderPermission(req: PermissionRequestView, respond: (decision: PermissionDecision, message?: string) => void): HTMLElement {
  const card = el('div', 'card permission');

  const head = el('div', 'card-head');
  head.appendChild(icon('shield'));
  head.appendChild(el('span', 'card-title', req.title));
  head.appendChild(el('span', 'card-tool', req.toolName));
  card.appendChild(head);

  if (req.detail) card.appendChild(el('pre', 'card-detail', req.detail));
  if (req.diff) {
    const d = el('div', 'mini-diff');
    const path = el('div', 'mini-diff-path');
    path.appendChild(icon('file'));
    path.appendChild(el('span', undefined, basename(req.diff.path)));
    d.appendChild(path);
    d.appendChild(diffLines(req.diff.before, req.diff.after));
    card.appendChild(d);
  }

  const reason = el('input', 'reason');
  reason.type = 'text';
  reason.placeholder = 'Tell Claude why (optional)';
  reason.hidden = true;

  const actions = el('div', 'card-actions');
  const allow = button('btn primary', 'Allow');
  allow.addEventListener('click', () => respond('allow'));
  actions.appendChild(allow);
  if (req.canAllowForSession) {
    const session = button('btn', 'Allow for session');
    session.addEventListener('click', () => respond('allowSession'));
    actions.appendChild(session);
  }
  const deny = button('btn', 'Deny');
  deny.addEventListener('click', () => respond('deny', reason.hidden ? undefined : reason.value.trim() || undefined));
  actions.appendChild(deny);
  const why = button('btn ghost', undefined, 'Add a reason');
  why.appendChild(icon('comment'));
  why.addEventListener('click', () => {
    reason.hidden = !reason.hidden;
    if (!reason.hidden) reason.focus();
  });
  actions.appendChild(why);
  actions.appendChild(el('span', 'card-hint', 'Enter to allow · Esc to deny'));
  card.appendChild(actions);
  card.appendChild(reason);

  reason.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      respond('deny', reason.value.trim() || undefined);
    }
  });
  card.dataset.focus = 'allow';
  return card;
}

export function renderQuestion(
  req: QuestionRequestView,
  submit: (answers: Record<string, string> | null) => void
): HTMLElement {
  const card = el('div', 'card question');
  const head = el('div', 'card-head');
  head.appendChild(icon('question'));
  head.appendChild(el('span', 'card-title', req.questions.length > 1 ? req.questions.length + ' questions' : 'Claude is asking'));
  card.appendChild(head);

  const groups: { question: string; read: () => string }[] = [];

  req.questions.forEach((q, qi) => {
    const block = el('div', 'q-block');
    if (q.header) block.appendChild(el('span', 'q-header', q.header));
    block.appendChild(el('div', 'q-text', q.question));
    const list = el('div', 'q-options');
    const name = 'q' + qi;
    const inputs: HTMLInputElement[] = [];
    const labels: string[] = [];

    const addOption = (label: string, description: string | undefined, other: boolean) => {
      const row = el('label', 'q-option' + (other ? ' other' : ''));
      const input = el('input');
      input.type = q.multiSelect ? 'checkbox' : 'radio';
      input.name = name;
      row.appendChild(input);
      const body = el('div', 'q-option-body');
      body.appendChild(el('div', 'q-label', label));
      if (description) body.appendChild(el('div', 'q-desc', description));
      let free: HTMLInputElement | undefined;
      if (other) {
        free = el('input', 'q-free');
        free.type = 'text';
        free.placeholder = 'Something else…';
        free.addEventListener('input', () => {
          if (free && free.value) input.checked = true;
          update();
        });
        free.addEventListener('click', (e) => e.preventDefault());
        body.appendChild(free);
      }
      row.appendChild(body);
      list.appendChild(row);
      inputs.push(input);
      labels.push(label);
      input.addEventListener('change', () => {
        if (other && input.checked && free) free.focus();
        update();
      });
      return free;
    };

    for (const o of q.options) addOption(o.label, o.description, false);
    const free = addOption('Other', undefined, true);

    block.appendChild(list);
    card.appendChild(block);

    const read = () => {
      const picked: string[] = [];
      inputs.forEach((input, i) => {
        if (!input.checked) return;
        if (i === inputs.length - 1) {
          const text = free?.value.trim();
          if (text) picked.push(text);
        } else picked.push(labels[i]);
      });
      return picked.join(', ');
    };
    groups.push({ question: q.question, read });
  });

  const actions = el('div', 'card-actions');
  const send = button('btn primary', 'Submit');
  const dismiss = button('btn', 'Dismiss');
  actions.appendChild(send);
  actions.appendChild(dismiss);
  card.appendChild(actions);

  function update(): void {
    send.disabled = groups.some((g) => !g.read());
  }
  update();

  send.addEventListener('click', () => {
    const answers: Record<string, string> = {};
    for (const g of groups) answers[g.question] = g.read();
    submit(answers);
  });
  dismiss.addEventListener('click', () => submit(null));
  card.dataset.focus = 'first';
  return card;
}
