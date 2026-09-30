# Security

## API keys

Jarvis reads `SMALLEST_API_KEY` and `OPENAI_API_KEY` from your environment, from the `envFile` in config, or from `~/.jarvis-voice/.env`, in that order. Keys are only sent to their own provider, are never written to `log.jsonl`, and are never printed; `jarvis status` reports only "found" or "missing".

## What leaves your machine

With keys configured, the tail of each agent's final message (up to 6,000 characters) goes to the summary provider (OpenAI by default), and the one-sentence line goes to the TTS provider. Both are skipped in `JARVIS_DRY_RUN=1`. Without keys, nothing leaves your machine. If your agents work on code you can't send to a third party, leave `OPENAI_API_KEY` unset or set `"ttsProviders": ["say"]`.

## What Jarvis edits

`jarvis install` edits `~/.claude/settings.json` and `~/.codex/config.toml`, writing a timestamped `.bak-jarvis-*` copy first. `jarvis uninstall` removes only entries that run `jarvis.mjs`.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting ("Security" → "Report a vulnerability") instead of a public issue. Expect a reply within a week.
