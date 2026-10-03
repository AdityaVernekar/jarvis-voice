# Security

## API keys

Earpiece reads `SMALLEST_API_KEY` and `OPENAI_API_KEY` from your environment, from the `envFile` in config, or from `~/.earpiece/.env`, in that order. Keys are only sent to their own provider, are never written to `log.jsonl`, and are never printed; `earpiece status` reports only "found" or "missing".

## What leaves your machine

With keys configured, the tail of each agent's final message (up to 6,000 characters) goes to the summary provider (OpenAI by default), and the one-sentence line goes to the TTS provider. Both are skipped in `EARPIECE_DRY_RUN=1`. Without keys, nothing from your agents leaves your machine (the Mac app's usage stats, below, contain none of it). If your agents work on code you can't send to a third party, leave `OPENAI_API_KEY` unset or set `"ttsProviders": ["say"]`.

## Usage stats

The Mac app sends anonymous usage stats a few times a day so we can tell how many people use Earpiece: a random install id (made on first launch, not tied to you or your Mac), the app version, the macOS version, the CPU architecture, your locale, and which agents are connected (for example `claude-code`, `codex`). It never sends code, prompts, summaries, project names, file paths or API keys, and the stats table has no IP address column (Supabase, which hosts it, keeps request logs with IPs for a short time). Turn it off under General → **Share anonymous usage stats**, or launch the app with `EARPIECE_TELEMETRY=0`. The `earpiece` CLI and dev builds (`npm start`) send nothing. The code is [`app/main/telemetry.mjs`](app/main/telemetry.mjs).

## What Earpiece edits

`earpiece install` edits `~/.claude/settings.json` and `~/.codex/config.toml`, writing a timestamped `.bak-earpiece-*` copy first. `earpiece uninstall` removes only entries that run Earpiece (or the older `jarvis.mjs` and `jarvis-hook`).

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting ("Security" → "Report a vulnerability") instead of a public issue. Expect a reply within a week.
