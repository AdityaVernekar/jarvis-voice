# Changelog

## Unreleased

- **Mac app** (`app/`, released as `app-v*`): a Dock and menu bar app that runs the hub. Its window has Overview, Agents, Voice (with a voice browser and previews), Quiet, API Keys, Activity and General; the menu bar popover keeps sessions, On / Quiet / Off, Stop and Test one click away. It is ad-hoc signed; see [docs/desktop-app.md](docs/desktop-app.md).
- **Claude Desktop**: `jarvis mcp` is a stdio MCP server with one tool, `jarvis_notify`, that Claude calls when it finishes real work or needs you. `jarvis install --only claude-desktop` (or Connect in the app) adds it to `claude_desktop_config.json`.
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
