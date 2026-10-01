# Contributing

Thanks for helping. Earpiece is small on purpose, so a few ground rules keep it that way.

## Setup

```bash
git clone https://github.com/adissocrazy/earpiece.git
cd earpiece
npm test                        # node --test, no install step
EARPIECE_HOME=$(mktemp -d) EARPIECE_DRY_RUN=1 EARPIECE_FOREGROUND=1 node bin/earpiece.mjs emit --agent demo --type turn_end "It works."
```

`EARPIECE_DRY_RUN=1` skips the network and audio and prints what would be said. Point `EARPIECE_HOME` at a temp directory so you don't touch your real config or sessions.

## Rules

- No runtime dependencies. Node 20+ built-ins only (`fetch`, `node:test`, `node:child_process`).
- Hooks must stay fast. Anything slower than reading a small file belongs in the worker (`processEvent` / adapter `enrich`).
- Never break the agent. Hook entry points swallow errors and log them to `~/.earpiece/log.jsonl`.
- Installers back up before editing, never overwrite settings they didn't write, and can undo themselves.
- Never log or print API keys, and never commit a `.env`.

## Good first contributions

- An adapter for another agent (Aider, Cursor CLI, Gemini CLI, OpenCode, Goose). See [docs/adapters.md](docs/adapters.md).
- A voice engine (ElevenLabs, Piper, Kokoro, Windows SAPI). See [docs/engines.md](docs/engines.md).
- Phrases for another language in `src/i18n.mjs`.
- Playback and offline voices on Linux and Windows.

## Pull requests

Keep them focused, add a test for new behaviour, run `npm test`, and add a line to `CHANGELOG.md` under "Unreleased". If you capture real hook payloads for tests, remove paths, names and message contents that aren't yours to share.

By contributing you agree that your work is released under the [MIT License](LICENSE) and that you'll follow the [Code of Conduct](CODE_OF_CONDUCT.md).
