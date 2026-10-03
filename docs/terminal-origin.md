# Where is each agent running?

Earpiece works out, for every agent session, which terminal app it runs in, which tab (tty) and, under tmux, which pane. You can see it with `earpiece where` and on each session row in the Mac app. Clicking the card, or **Open** on a session row, uses it to take you back to that window.

```text
$ earpiece where
AGENT         PROJECT             TERMINAL    TTY       TMUX            CLICK LANDS ON
Claude Code   checkout service    iTerm2      ttys004   -               tab
Codex         billing             Ghostty     ttys012   main:2.0        app only
Claude Code   api                 Cursor      ttys010   -               window
Aider         docs-site           ?           -         -               not seen yet
```

`earpiece where --here` describes the shell you are typing in, which is the quickest way to check that detection is right for a given terminal. `--json` prints everything that was found; `--refresh` looks again (and keeps what it knew if the agent has since exited); `--all` includes sessions older than 24 hours.

## How it is found

Every hook already passes through the `earpiece-hook` shim. The shim adds one header with plain shell expansion (no extra processes, so it stays at about 5 ms): the agent's parent pid and these variables, if set: `TERM_PROGRAM`, `__CFBundleIdentifier`, `ITERM_SESSION_ID`, `TERM_SESSION_ID`, `TMUX`, `TMUX_PANE`, `KITTY_WINDOW_ID`, `WEZTERM_PANE`, `VSCODE_GIT_ASKPASS_NODE` and `GHOSTTY_RESOURCES_DIR`. The hub does the slower work once per session, in the background, and stores the answer on the session record.

Signals, most trustworthy first:

1. **The process tree.** `ps` is walked up from the agent. That gives the agent's own process, its controlling tty, and the outermost `.app` it descends from, which is the terminal or editor window.
2. **tmux.** The environment inside tmux describes whichever terminal started the tmux server, often not the one you are looking at. So Earpiece asks tmux for the pane's session, window and tty, then for the clients attached to that session, and takes the most recently active one. Its tty is the tab, and its process tree gives the real terminal app. With no client attached there is no tab to go to.
3. **The environment**, as a fallback, for example when iTerm2's helper process has been reparented and the tree no longer reaches the app.

If a lookup fails (`ps` times out, tmux doesn't answer), the result is marked incomplete, retried on the next hook after about 15 seconds, and never replaces an origin that was found properly. Recording where an agent runs doesn't count as activity, so it doesn't reorder your sessions.

Because every hook is a new shell with a new parent pid, a session is only looked up again when its signals change, the agent process has gone, or 10 minutes have passed. Sessions recorded before you updated show "not seen yet" until that agent sends its next hook.

## What a click can reach

| Terminal | Precision |
| --- | --- |
| iTerm2 | the tab, found by session id or tty |
| Terminal.app | the tab, found by tty |
| VS Code, Cursor, Windsurf, Insiders, VSCodium, Trae, Kiro, Void, Positron | the window (editors can't tell terminals apart from outside) |
| Ghostty, Warp, kitty, WezTerm, Alacritty, others | the app only |
| tmux inside any of the above | the attached client's tab (the pane is not switched) |
| Claude Desktop, the Codex app | the app |

From a terminal, `earpiece jump` goes to the most recent session (`earpiece jump 2` for the second in `earpiece where`, `--agent codex` to pick by agent). `--dry-run` prints the steps it would try without running them. Each step falls back to the next: the exact tab, then the app. If Automation permission was refused, it says so; turn it back on under System Settings → Privacy & Security → Automation.

### Which editor window

An editor is told what to open with `open -b <bundle> <path>`, and handing it a folder that no window has as its root opens a new window. So Earpiece first reads the editor's own record of its windows (`~/Library/Application Support/<editor>/User/globalStorage/storage.json` and `Backups/workspaces.json`, plus the roots of any `.code-workspace` file listed there) and picks:

1. the window whose root holds the session's folder, the deepest root if several do, the most recent window on a tie;
2. otherwise the folder itself if it is a repo root (it has `.git`);
3. otherwise nothing: the editor comes forward without opening anything.

Paths are compared after resolving symlinks, without case and trailing slashes. Remote windows are skipped. Editors are rows in `src/hub/editors.mjs`; each row names a family, and each family has one reader, so another VS Code-based editor is one row. `earpiece jump --dry-run` and `earpiece doctor` show the windows found.

## Privacy and safety

Everything stays on your Mac. The origin is stored in `~/.earpiece/sessions/` and is never sent to a voice or summary API. Every value from the header is checked against a strict pattern before it is used, and values that don't look right are dropped. Jumping passes them to `osascript` as arguments, never as script text.
