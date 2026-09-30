# Changelog

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
