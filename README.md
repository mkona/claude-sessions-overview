# Claude Sessions

One sidebar with every Claude Code session on this machine: CLI, VS Code extension, Desktop and SDK, across all projects.

## What you see

Sessions are grouped by project folder. Each row shows the session title and its state:

| Icon | State | Meaning |
| --- | --- | --- |
| bell (yellow) | `needs answer · 2m` | Claude is waiting for you (permission, question, or input) |
| spinner (blue) | `working · 5m` | Claude is running a turn |
| check (green) | `done 12m ago` | Session is alive and idle since that time |
| hollow circle | `ended 3h ago` | Process is gone; transcript still on disk |

The status bar shows a count of sessions needing an answer (yellow) or working. The view badge shows the needs-answer count.

## Clicking a session

- Focuses the VS Code window that has that project open (or opens the folder if no window has it).
- VS Code extension sessions are opened in the Claude Code panel there.
- Live CLI sessions: the terminal running them is revealed when it lives in that window.
- Ended CLI sessions: a terminal opens with `claude --resume <id>` (disable with `claudeSessions.resumeEndedCliSessions`).

Right-click a session for: Go to Session, Resume in Terminal Here, Focus Project Window, Open Transcript File, Copy Session ID. Click a project header to collapse or expand it; the toolbar has Collapse All.

## Where the data comes from

- `~/.claude/sessions/*.json`: live registry written by Claude Code (pid, cwd, status, entrypoint).
- `~/.claude/projects/*/<session>.jsonl`: transcripts, used for titles, last activity, and ended sessions.
- `~/.claude/ide/*.lock`: hints about which folders are open in VS Code.

Set `claudeSessions.claudeDir` if your Claude config lives elsewhere.

## Build

```
npm install
npm run package      # produces claude-sessions-overview-<version>.vsix
code --install-extension claude-sessions-overview-*.vsix
```

## Usage block

The first row shows your rate limits: `5h` session window, `7d` weekly window, and any model-scoped weekly limit (for example `Fable`), each with a bar, percent and reset time. Data comes from the same endpoint Claude Code's `/usage` uses, authenticated with the login Claude Code already stores (macOS Keychain, or `~/.claude/.credentials.json`). Refreshes every `claudeSessions.usageRefreshMinutes` (default 2); click any usage row to refresh now. Hide it with `claudeSessions.showUsage`.

## Search

The search box sits at the top of the panel. Type to filter live (Cmd/Ctrl+F inside the panel focuses it, Escape clears). It matches sessions (title, last prompt, session id, source, state, branch) and projects (folder name or path); a matching project shows all of its sessions. While a filter is active the view scans a full year of history with no per-project cap, so old sessions are findable.
