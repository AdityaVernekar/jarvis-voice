# Security

## API keys

Earpiece reads `SMALLEST_API_KEY` and `OPENAI_API_KEY` from your environment, from the `envFile` in config, or from `~/.earpiece/.env`, in that order. Keys are only sent to their own provider, are never written to `log.jsonl`, and are never printed; `earpiece status` reports only "found" or "missing".

## What leaves your machine

With keys configured, the tail of each agent's final message (up to 6,000 characters) goes to the summary provider (OpenAI by default), and the one-sentence line goes to the TTS provider. Both are skipped in `EARPIECE_DRY_RUN=1`. Without keys, nothing from your agents leaves your machine (the Mac app's usage stats, below, contain none of it). If your agents work on code you can't send to a third party, leave `OPENAI_API_KEY` unset or set `"ttsProviders": ["say"]`.

## Usage stats

The Mac app sends usage stats a few times a day so we can tell how many people use Earpiece and which features they use: a random install id (made on first launch), the app version, the macOS version, the CPU architecture, your locale, which agents are connected (for example `claude-code`, `codex`), and feature settings and counts: whether Answer from the card, the card, quiet hours and the agent-name prefix are on, the notch icon mode, the spoken language, the first voice engine and the last one used, whether a Smallest or OpenAI key is set (yes or no, never the key), how many agents have their own voice, and how many lines were spoken and skipped today. The stats are anonymous unless you sign in with Google (optional, under General → Account); then they are linked to your account's email and name. It never sends code, prompts, summaries, project names, file paths or API keys, and the stats table has no IP address column (Supabase, which hosts it, keeps request logs with IPs for a short time). Turn it off under General → **Share usage stats**, or launch the app with `EARPIECE_TELEMETRY=0`. The `earpiece` CLI and dev builds (`npm start`) send nothing. The code is [`app/main/telemetry.mjs`](app/main/telemetry.mjs) and [`app/main/auth.mjs`](app/main/auth.mjs). The sign-in session is encrypted with the macOS Keychain (Electron `safeStorage`) before it is saved.

## What Earpiece edits

`earpiece install` edits `~/.claude/settings.json` and `~/.codex/config.toml`, writing a timestamped `.bak-earpiece-*` copy first. `earpiece uninstall` removes only entries that run Earpiece (or the older `jarvis.mjs` and `jarvis-hook`).

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting ("Security" → "Report a vulnerability") instead of a public issue. Expect a reply within a week.
