export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function icon(name: string, cls?: string): HTMLSpanElement {
  return el('span', 'codicon codicon-' + name + (cls ? ' ' + cls : ''));
}

export function button(cls: string, text?: string, title?: string): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  if (title) b.title = title;
  return b;
}

export function clear(e: Element): void {
  while (e.firstChild) e.removeChild(e.firstChild);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

export function prettyPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~');
}
