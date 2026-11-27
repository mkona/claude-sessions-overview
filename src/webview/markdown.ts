import { Marked } from 'marked';
import { el, escapeHtml } from './dom';

export interface LinkHandlers {
  openLink(href: string): void;
  openFile(path: string, line?: number): void;
}

const marked = new Marked({ gfm: true, breaks: true, async: false });

marked.use({
  renderer: {
    html: ({ text }) => escapeHtml(text),
    code: ({ text, lang }) => {
      const language = (lang || '').trim().split(/\s+/)[0];
      return (
        '<div class="code-block"><div class="code-head"><span class="code-lang">' +
        escapeHtml(language) +
        '</span><button type="button" class="copy-btn" title="Copy"><span class="codicon codicon-copy"></span></button></div><pre><code>' +
        escapeHtml(text) +
        '</code></pre></div>'
      );
    },
  },
});

export function parseFileRef(raw: string): { path: string; line?: number } | undefined {
  const s = raw.trim();
  if (!s || s.length > 400 || s.startsWith('#') || /\s/.test(s) || /^[A-Za-z][A-Za-z0-9+.-]*:(\/\/|[A-Za-z])/.test(s)) return undefined;
  const m = /^([^:]+?)(?::(\d+))?(?::\d+)?$/.exec(s);
  if (!m) return undefined;
  const path = m[1];
  if (!/^[~./]/.test(path) && !path.includes('/')) return undefined;
  if (!path.includes('/') && !/\.[A-Za-z0-9]{1,8}$/.test(path)) return undefined;
  return { path, line: m[2] ? Number(m[2]) : undefined };
}

function copyText(text: string, btn: HTMLElement): void {
  const done = () => {
    const i = btn.firstElementChild;
    if (!i) return;
    i.className = 'codicon codicon-check';
    setTimeout(() => (i.className = 'codicon codicon-copy'), 1200);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, () => undefined);
    return;
  }
  const ta = el('textarea', 'offscreen');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  done();
}

function wire(root: HTMLElement, h: LinkHandlers): void {
  root.querySelectorAll('.code-block').forEach((block) => {
    const btn = block.querySelector('.copy-btn');
    const code = block.querySelector('code');
    if (btn instanceof HTMLElement && code) btn.addEventListener('click', () => copyText(code.textContent || '', btn));
  });
  root.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    a.setAttribute('href', '#');
    a.classList.add('link');
    const file = /^https?:\/\//i.test(href) ? undefined : parseFileRef(href);
    a.title = href;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (file) h.openFile(file.path, file.line);
      else if (href) h.openLink(href);
    });
  });
  root.querySelectorAll('code').forEach((c) => {
    if (c.closest('pre')) return;
    const text = (c.textContent || '').trim();
    const file = parseFileRef(text);
    if (!file || (!file.path.includes('/') && !/\.[A-Za-z0-9]{1,8}$/.test(file.path))) return;
    c.classList.add('file-ref');
    c.title = 'Open ' + text;
    c.addEventListener('click', () => h.openFile(file.path, file.line));
  });
}

export function renderMarkdown(markdown: string, h: LinkHandlers): HTMLElement {
  const host = el('div', 'md');
  host.innerHTML = marked.parse(markdown) as string;
  wire(host, h);
  return host;
}
