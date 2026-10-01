# Security

## API keys

Earpiece reads `SMALLEST_API_KEY` and `OPENAI_API_KEY` from your environment, from the `envFile` in config, or from `~/.earpiece/.env`, in that order. Keys are only sent to their own provider, are never written to `log.jsonl`, and are never printed; `earpiece status` reports only "found" or "missing".

## What leaves your machine

With keys configured, the tail of each agent's final message (up to 6,000 characters) goes to the summary provider (OpenAI by default), and the one-sentence line goes to the TTS provider. Both are skipped in `EARPIECE_DRY_RUN=1`. Without keys, nothing leaves your machine. If your agents work on code you can't send to a third party, leave `OPENAI_API_KEY` unset or set `"ttsProviders": ["say"]`.

## What Earpiece edits

`earpiece install` edits `~/.claude/settings.json` and `~/.codex/config.toml`, writing a timestamped `.bak-earpiece-*` copy first. `earpiece uninstall` removes only entries that run Earpiece (or the older `jarvis.mjs` and `jarvis-hook`).

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting ("Security" → "Report a vulnerability") instead of a public issue. Expect a reply within a week.
