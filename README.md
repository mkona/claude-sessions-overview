# Claude Sessions

Every Claude Code session on this machine — CLI, VS Code extension, Desktop and SDK, across all projects — in one VS Code window, with a chat tab you can talk in.

## The one-window layout

| Where | What |
| --- | --- |
| Primary sidebar | **Sessions**: every session on the machine, grouped by project. Hover a project header for **+** to start a session there. |
| Editor area | A **chat tab** per session. Resume any session from any project, send prompts, answer permission prompts and questions. |
| Secondary sidebar | **Session Changes**: the files the active session edited. Click one for a native diff against the content before the session touched it. |

Because this is a normal workbench window, everything else in VS Code keeps working on those files: git, search, SCM, compare, remote/SFTP extensions, your keybindings. Each session's project folder is added to the window as a workspace folder so those features can see it (turn that off with `claudeSessions.addProjectToWorkspace`).

Set `claudeSessions.openIn` to `projectWindow` to get the pre-0.5 behavior back: clicking a session focuses the VS Code window that has that project open instead of opening a chat tab. The **Open in Project Window** and **Focus Project Window** context-menu items do that for a single session either way.

## What you see in the sidebar

Sessions are grouped by project folder. Each row shows the session title and its state:

| Icon | State | Meaning |
| --- | --- | --- |
| bell (yellow) | `needs answer · 2m` | Claude is waiting for you (permission, question, or input) |
| spinner (blue) | `working · 5m` | Claude is running a turn |
| check (green) | `done 12m ago` | Session is alive and idle since that time |
| hollow circle | `ended 3h ago` | Process is gone; transcript still on disk |

A **here** badge marks sessions whose Claude process this window runs; the open chat tab's session is highlighted. The status bar shows how many sessions need an answer (yellow) or are working, and clicking it jumps to the first one.

Right-click a session for: Go to Session, Resume in Terminal Here, Open in Project Window, Focus Project Window, Open Transcript File, Copy Session ID. Click a project header to collapse or expand it; the toolbar has Collapse All.

## The chat tab

- Markdown answers, thinking blocks, and one compact row per tool call (expand for its output). Edit and Write rows show `+a −b` and open a diff.
- Permission prompts appear above the composer with a before/after diff: **Allow**, **Allow for session**, **Deny** (with an optional reason). Enter allows, Escape denies.
- Questions from Claude render as a card with options and a free-text "Other".
- Composer: Enter sends, Shift+Enter is a newline, Up arrow in an empty box recalls your last message, Stop interrupts the turn.
- Under the composer: permission mode and model pickers, plus the live status.
- A session that is running somewhere else (a terminal, the Claude Code extension, Desktop) opens read-only with a banner and an **Open in terminal** button. It unlocks by itself once that process stops.
- The branch chip in the header switches branches through git.

The Claude process starts when you send the first message, resumes the session by id, and shuts down after `claudeSessions.idleShutdownMinutes` of quiet (or when you close the tab).

## Session Changes

The secondary sidebar lists the files the active chat's session edited, with the line counts and the folder each one is in. Clicking a file diffs the current file against its content before the session's first edit of it. The toolbar has Open All (a multi-file diff), Switch Branch, Show Source Control and Refresh. For some files the transcript does not record the pre-edit content; those are diffed against an empty file and say so in the tooltip.

## Where the data comes from

- `~/.claude/sessions/*.json`: live registry written by Claude Code (pid, cwd, status, entrypoint).
- `~/.claude/projects/*/<session>.jsonl`: transcripts, used for the chat history, titles, last activity, edited files and ended sessions.
- `~/.claude/ide/*.lock`: hints about which folders are open in VS Code.

Set `claudeSessions.claudeDir` if your Claude config lives elsewhere, and `claudeSessions.claudeCommand` if `claude` is not on your PATH.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `claudeSessions.openIn` | `thisWindow` | Clicking a session opens a chat tab here, or focuses the project's window. |
| `claudeSessions.addProjectToWorkspace` | `true` | Add a session's project folder to this window as a workspace folder. |
| `claudeSessions.defaultPermissionMode` | `default` | Permission mode new chats start in. |
| `claudeSessions.defaultModel` | `` | Model new chats start with; empty uses the CLI default. |
| `claudeSessions.idleShutdownMinutes` | `20` | Stop a chat's Claude process after this many idle minutes (0 = never). |
| `claudeSessions.claudeCommand` | `claude` | The Claude CLI used for chats and for resuming in a terminal. |
| `claudeSessions.refreshIntervalSeconds` | `3` | How often session state is re-read. |
| `claudeSessions.notifyNeedsAnswer` | `true` | Notify when a session starts waiting for an answer. |
| `claudeSessions.showUsage` | `true` | Show the usage block at the top of the sidebar. |

The rest (`showEnded`, `endedMaxAgeDays`, `maxEndedPerProject`, `groupByProject`, `resumeEndedCliSessions`, `usageRefreshMinutes`, `claudeDir`) control the sidebar list itself.

## Usage block

The first row shows your rate limits: `5h` session window, `7d` weekly window, and any model-scoped weekly limit (for example `Fable`), each with a bar, percent and reset time. Data comes from the same endpoint Claude Code's `/usage` uses, authenticated with the login Claude Code already stores (macOS Keychain, or `~/.claude/.credentials.json`). Refreshes every `claudeSessions.usageRefreshMinutes` (default 2); click any usage row to refresh now. Hide it with `claudeSessions.showUsage`.

## Search

The search box sits at the top of the panel. Type to filter live (Cmd/Ctrl+F inside the panel focuses it, Escape clears). It matches sessions (title, last prompt, session id, source, state, branch) and projects (folder name or path); a matching project shows all of its sessions. While a filter is active the view scans a full year of history with no per-project cap, so old sessions are findable.

## Build

```
npm install
npm run package      # produces claude-sessions-overview-<version>.vsix
code --install-extension claude-sessions-overview-*.vsix
```
