# Changelog

## Unreleased

- **Where is each agent running?** Earpiece now works out which terminal app, tab and tmux pane every agent session lives in. New `earpiece where` (`--here` for the shell you're in, `--json`, `--refresh`, `--all`) and a terminal/tty/tmux label on each session row in the Mac app. The shim sends the agent's parent pid and a few terminal variables (no extra processes); the hub walks the process tree and asks tmux which terminal is really attached, once per session, in the background. iTerm2, Terminal.app, VS Code, Cursor, Windsurf, Ghostty, Warp, kitty, WezTerm and Alacritty are recognised. Nothing leaves your Mac. This is step one of clicking the card to jump to the right window; the click isn't wired up yet. See [docs/terminal-origin.md](docs/terminal-origin.md). Existing sessions show "not seen yet" until the agent's next hook.
- **Answer from the card** (off by default; General → "Answer from the card", or `earpiece answers on`). When Claude Code or Codex asks to run a tool, the card shows the command with Allow / Deny (and Always allow on Claude Code, when Claude offers a rule for it), and when a turn ends on a question the card has a reply box whose text goes back to the agent as your next instruction. Buttons wake up after a moment so a stray click can't approve anything, nothing is approved by keyboard, and the card only takes the keyboard while you click into the reply box. Unanswered questions go back to the terminal after about two minutes, or at once with "In terminal", and disappear if you answer in the terminal, send a new prompt, or the hook is killed. Only works with the Mac app running and the card on. Commands too long to read in full show their start and end and can only be denied. It adds blocking `PermissionRequest` and `Stop` hooks (`earpiece ask <agent>`; Codex hooks go in `~/.codex/hooks.json` and must be trusted once with `/hooks`); turning it off removes them. See [docs/answer-from-card.md](docs/answer-from-card.md). Claude Desktop stays notify-only.

- Fix: the floating card and the "speaking" indicator (menu bar icon, wave, Stop button) now follow the audio, not the TTS request. The card used to appear as "speaking" the moment a line reached the speaker and stay that way through a slow or hung voice API (up to 8 s for Smallest, then 15 s for OpenAI). It now appears when audio is about to play; nothing shows while the API is still working. If every voice fails, the line shows as a text card with a "No voice" chip instead of a false "spoken" one, is logged as `voice_failed`, and is not remembered as said, so a retry is not dropped as a duplicate. Stop pressed while the API is still working now prevents the line from playing at all. A "speaking" card left behind by a crashed process stops counting after 60 s. The chime now plays while the request is in flight instead of before it.
- Engines: `ctx.ready()` is new. `playBuffer` calls it for you; an engine that plays audio some other way (like `say`) should `await ctx.ready?.()` right before it starts.

- **Jarvis Voice is now Earpiece** ([earpiece.dev](https://earpiece.dev)). The command is `earpiece`, the home folder is `~/.earpiece`, variables are `EARPIECE_*`, the Claude Desktop tool is `earpiece_notify` and the Mac app is Earpiece.app. Upgrading needs nothing: the first run moves `~/.jarvis-voice` and leaves a link behind, `jarvis` and `JARVIS_*` keep working, and the app brings its settings across. `earpiece install` swaps old hooks, the Codex notify block and the `jarvis-voice` Claude Desktop entry for the new ones without doubling them.
- **Mac app** (`app/`, released as `app-v*`): a Dock and menu bar app that runs the hub. Its window has Overview, Agents, Voice (with a voice browser and previews), Quiet, API Keys, Activity and General; the menu bar popover keeps sessions, On / Quiet / Off, Stop and Test one click away. It is ad-hoc signed; see [docs/desktop-app.md](docs/desktop-app.md).
- **Claude Desktop**: `jarvis mcp` is a stdio MCP server with one tool, `jarvis_notify`, that Claude calls when it finishes real work or needs you. `jarvis install --only claude-desktop` (or Connect in the app) adds it to `claude_desktop_config.json`.
- **Floating card**: the Mac app shows a small card under the menu bar with the agent's logo, name, project and what it said. It also shows, without sound, in quiet mode and quiet hours and for muted agents. You can turn it off or preview it under General. The core writes `~/.jarvis-voice/card.json` for it.
- Agent logos (Claude, OpenAI) in the Agents page, Overview and popover. The marks come from Simple Icons (CC0) and are trademarks of their owners.
- `jarvis_notify` hardening: the server now cleans every summary for speech (it strips markdown and code, reduces URLs to their domain and paths to the file name, drops IDs and secrets, and cuts to 25 words), rejects empty summaries the same way the schema does, ignores repeats within a minute, and throttles more than 5 calls a minute. The tool result now says what happened (queued, or why it wasn't spoken) instead of "ok".
- **Mark done from the app**: sessions that need you, are working or hit an error have a Mark done button in Overview and a ✓ in the menu bar list. Marking one done also drops any queued "needs you" line for it. × forgets a session until the agent speaks again. Session lines no longer repeat the agent and project shown next to them.
- `summaryProvider: "none"` never sends a reply anywhere for a summary.
- Fix: playback no longer blocks the hub while a line is spoken, and Stop mid-line no longer falls through to the next voice provider.
- Hub socket: `jarvis serve` listens on `~/.jarvis-voice/hub.sock` (mode 0600). `jarvis install --hub` points hooks at `~/.jarvis-voice/bin/jarvis-hook`, a small script that posts to the socket with curl (about 5 ms, compared with about 55 ms for a Node start) and falls back to running Jarvis directly when no hub is up. It always exits 0.
- `jarvis install` keeps hooks on that script when they already use it, so re-running it no longer disconnects the app. `--node` switches back.
- `jarvis env <path>` sets where API keys are read from without touching hooks.

## 0.2.2 (2026-09-30)

- Permission and idle alerts you already answered in the terminal are dropped instead of spoken late. Claude Code now also sends `PostToolUse`, which becomes a silent `activity` event; the alert is skipped as `resolved` once the tool it asked about runs, you send a new prompt, or the turn ends. Re-run `jarvis install` to add the hook.
- Secrets are redacted before a line is spoken, logged or sent for a summary: GitHub, Slack, AWS, Google and `sk-` style keys, JWTs, private keys, passwords in URLs, `*_KEY=`/`token:`/`password=` values and long opaque tokens.
- Quiet hours are configurable. `quietHours.allow` lists what may speak at night (`[]` for total silence), and `jarvis quiet-hours 22:00-08:00 [--silent | --allow needs_input,error] | off` sets it. `jarvis status` shows the current window.

## 0.2.1 (2026-09-30)

- Fix: a chained Codex notify wrapper that calls Jarvis back (for example one with `--previous-notify`) no longer causes an endless loop of the same line. Forwarded calls carry `JARVIS_FORWARDED=1`, and each Codex turn is handled once.
- Lines that waited more than 2 minutes for the speaker are dropped instead of read out late. `jarvis off` now also silences lines that were already queued.
- New `jarvis stop` (alias `flush`): stop talking now and drop everything queued.
- A full queue logs `skipped: busy` instead of a lock-timeout error.

## 0.2.0 (2026-09-30)

- Multi-agent hub: adapters turn each agent's hooks into one event format, and a session registry tracks every agent session.
- `jarvis agents` shows what each agent is doing and which ones are waiting on you.
- `jarvis emit` lets any tool send events without writing an adapter.
- Per-agent settings: voice, label, turn threshold, mute.
- Smallest.ai Lightning voices as the default engine, with OpenAI and system voice fallbacks.
- Spoken languages, including Hinglish and Hindi, with a script check on summaries.
- Linux playback and offline voice support.
- Pluggable voice engines and adapters, documented in `docs/`.
- `jarvis install --chain` keeps an existing Codex `notify` command.

## 0.1.0

- Spoken pings for Claude Code and Codex CLI with OpenAI summaries and macOS `say` fallback.
