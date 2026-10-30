import * as vscode from 'vscode';
import { SessionInfo } from './types';
import { UsageSnapshot } from './usage';

export interface PanelState {
  sessions: SessionInfo[];
  usage?: UsageSnapshot;
  groupByProject: boolean;
  showUsage: boolean;
  collapsed: string[];
  filter: string;
}

export interface PanelEvents {
  onOpen(sessionId: string): void;
  onFilter(text: string): void;
  onRefreshUsage(): void;
  onToggleProject(cwd: string, collapsed: boolean): void;
}

export class SessionsPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private state: PanelState = { sessions: [], groupByProject: true, showUsage: true, collapsed: [], filter: '' };
  private lastSent = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly events: PanelEvents,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => {
      switch (msg?.type) {
        case 'ready':
          this.lastSent = '';
          this.push();
          return;
        case 'open':
          if (typeof msg.sessionId === 'string') this.events.onOpen(msg.sessionId);
          return;
        case 'filter':
          if (typeof msg.text === 'string') this.events.onFilter(msg.text);
          return;
        case 'refreshUsage':
          this.events.onRefreshUsage();
          return;
        case 'toggleProject':
          if (typeof msg.cwd === 'string') this.events.onToggleProject(msg.cwd, Boolean(msg.collapsed));
          return;
        default:
          return;
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.lastSent = '';
        this.push();
      }
    });
  }

  update(partial: Partial<PanelState>): void {
    Object.assign(this.state, partial);
    this.push();
  }

  setBadge(count: number): void {
    if (this.view) this.view.badge = count ? { value: count, tooltip: `${count} waiting for answer` } : undefined;
  }

  setDescription(text: string | undefined): void {
    if (this.view) this.view.description = text;
  }

  private push(): void {
    if (!this.view) return;
    const payload = JSON.stringify({ type: 'state', ...this.state });
    if (payload === this.lastSent) return;
    this.lastSent = payload;
    void this.view.webview.postMessage(JSON.parse(payload));
  }

  private html(webview: vscode.Webview): string {
    const media = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', ...p));
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${media('panel.css')}">
<title>Claude Sessions</title>
</head>
<body>
<div class="search" id="searchWrap">
  <span class="codicon codicon-search"></span>
  <input id="q" type="text" placeholder="Search sessions and projects" spellcheck="false" autocomplete="off">
  <button id="clear" class="icon-btn codicon codicon-close" title="Clear search" hidden></button>
</div>
<div id="usage"></div>
<div id="list" role="tree"></div>
<div id="empty" class="empty" hidden></div>
<script nonce="${nonce}" src="${media('panel.js')}"></script>
</body>
</html>`;
  }
}
