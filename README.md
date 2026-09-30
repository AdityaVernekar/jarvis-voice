# jarvis-voice

A voice hub for terminal coding agents. Start a task in Claude Code, another in Codex, walk away, and Jarvis tells you out loud when one of them finishes or needs you:

> "checkout service. Refactored the cart drawer, all tests pass."
>
> "billing needs your permission to use Bash."

It sits between your agents and your speakers. Each agent's hooks send events to one hub. The hub tracks every session, writes a one-sentence summary of what the agent did, and speaks it through the first voice engine that works. Short turns stay silent, duplicate lines are dropped, and quiet hours let only the "I need you" pings through.

Zero dependencies. Node 20 or newer. MIT licensed.

## Why

Running several agents at once turns you into a tab-watcher. You check a terminal, it's still thinking; you go back to something else, and meanwhile another agent has been blocked on a permission prompt for ten minutes. Jarvis removes the checking. You hear about the ones that matter and ignore the rest.

## Install

```bash
git clone https://github.com/AdityaVernekar/jarvis-voice.git
cd jarvis-voice
node bin/jarvis.mjs install        # hooks for Claude Code and Codex, backs up every file it edits
npm link                           # optional: puts `jarvis` on your PATH
jarvis test                        # you should hear Jarvis
```

Restart any running Claude Code or Codex sessions so they pick up the hooks.

Voice and summaries get better with API keys, but both are optional. Put them in your environment or in a `.env` file (see `.env.example`), then point Jarvis at it with `jarvis install --env /path/to/.env`:

| Key | Used for | Without it |
| --- | --- | --- |
| `SMALLEST_API_KEY` | [Smallest.ai](https://smallest.ai) Lightning voices, including Indian languages | falls through to OpenAI or the system voice |
| `OPENAI_API_KEY` | one-sentence summaries (gpt-4o-mini) and OpenAI TTS | first sentence of the agent's message, system voice |

Keys are read at call time and never written to logs. With an OpenAI key, the tail of each agent's final message (up to 6,000 characters) is sent to OpenAI to write the summary; leave the key unset if your code can't leave your machine. [SECURITY.md](SECURITY.md) has the details.

## Agents

| Agent | How it connects | Events |
| --- | --- | --- |
| Claude Code | `UserPromptSubmit`, `Stop` and `Notification` hooks in `~/.claude/settings.json` | turn start/end, permission prompts, idle |
| Codex CLI | top-level `notify` in `~/.codex/config.toml` | turn end |
| Anything else | `jarvis emit` or `jarvis run` | whatever you send |

If Codex already has a `notify` command, the installer leaves it alone and tells you. `jarvis install --chain` keeps your command and adds Jarvis in front of it; `jarvis uninstall` puts yours back. The chain is safe with wrappers that call their own "previous notify" command, even when that command is Jarvis: each Codex turn is spoken once.

Any tool that can run a shell command can talk to the hub:

```bash
jarvis emit --agent aider --type turn_start --project docs-site
jarvis emit --agent aider --type turn_end   --project docs-site "Rewrote the navigation and fixed three broken links."
jarvis emit --agent my-bot --type needs_input --message "wants you to review the migration"
echo '{"agent":"ci","type":"error","project":"api","line":"API build failed on main."}' | jarvis emit
jarvis run -- npm test             # speaks when a long command finishes or fails
```

To add first-class support for another agent, write an adapter. It is one small file; see [docs/adapters.md](docs/adapters.md).

## See every agent at once

```text
$ jarvis agents
STATUS    AGENT         PROJECT               AGE   LAST
● working Claude Code   checkout service      12s
◆ waiting Codex         billing               3m    billing. Should I also migrate the invoices table?
◆ waiting Claude Code   api                   8m    api needs your permission to use Bash.
✓ done    Aider         docs-site             21m   docs-site. Rewrote the navigation and fixed three broken links.

1 working, 2 waiting on you, 4 total
```

`jarvis agents --all` includes sessions older than 24 hours; `--json` is for scripts and status bars.

## Commands

```text
jarvis install [--only claude-code,codex] [--chain] [--env path/.env]
jarvis uninstall
jarvis test [--provider smallest|openai|say] [--agent id]
jarvis agents [--all] [--json]
jarvis emit --agent <id> --type <turn_start|turn_end|needs_input|idle|error|info> [text…]
jarvis run -- <command …>
jarvis say "text" [--kind done|needs_input|error|info] [--provider id] [--lang code]
jarvis voices [--gender female] [--accent indian] [--lang hi] [--std]
jarvis voice <id> [--agent id]
jarvis lang <en|hinglish|hi|ta|mr|es|…>
jarvis quiet [minutes]     # only "needs you" pings, default 60 min
jarvis off [minutes]       # silence, default until `jarvis on`
jarvis on
jarvis stop                # stop talking now and drop every queued line
jarvis status
```

## A different voice per agent

When two agents share your speakers, it helps to hear which one is talking.

```bash
jarvis voices --gender female         # browse the Smallest catalog
jarvis voice <voice-id> --agent codex  # Codex gets its own voice
```

Or in `~/.jarvis-voice/config.json`:

```json
{
  "announceAgent": true,
  "agents": {
    "claude-code": { "label": "Claude" },
    "codex": { "voice": "<voice-id>", "minTurnSeconds": 0 },
    "aider": { "enabled": false }
  }
}
```

With `announceAgent` on, lines start with the agent name: "Codex, billing. Migrated the invoices table."

## Languages

`jarvis lang hinglish` makes summaries sound the way many Indian developers talk: Hindi in Devanagari with technical words left in English. `jarvis lang hi`, `ta`, `mr`, `es`, `fr` and about 30 others work too. Jarvis checks that the summary came back in the right script and asks for a rewrite once if it didn't. `jarvis voices --lang hi` lists voices trained on a language.

## Configuration

Everything lives in `~/.jarvis-voice/` (override with `JARVIS_HOME`): `config.json`, a session registry, and `log.jsonl`. The full list of settings is in [docs/configuration.md](docs/configuration.md); a starting point is in [examples/config.example.json](examples/config.example.json).

## How it works

```text
Claude Code hook ─┐
Codex notify ─────┼─► adapter ─► hub ─► session registry ─► jarvis agents
jarvis emit/run ──┘                └─► worker ─► summary ─► voice engine chain ─► speaker
```

Hooks return within milliseconds. Transcript reads, LLM calls and audio all happen in a detached worker, so Jarvis never slows an agent down. Only one line plays at a time across all agents. [docs/architecture.md](docs/architecture.md) has the details, and [docs/engines.md](docs/engines.md) covers adding a voice engine.

## Platform support

macOS works out of the box (`afplay`, `say`). On Linux, install one of `paplay`, `aplay`, `ffplay` or `mpg123` for playback and `espeak-ng` or `spd-say` for the offline voice. Windows is untested; WSL with PulseAudio should work.

## Known limits

- Codex's `notify` only fires at the end of a turn and sends no start time, so every Codex turn is announced. Set `agents.codex.minTurnSeconds` or use `jarvis quiet` if that's too chatty. Codex approval prompts don't trigger a ping yet.
- The installer records the path of the Node binary it ran with. If you switch Node versions with nvm, run `jarvis install` again.
- Smallest's Electron LLM (`"summaryProvider": "smallest"`) isn't available on every plan. When it returns 403, Jarvis uses OpenAI for the summary.
- Smallest allows one TTS request at a time per account. Jarvis already serialises its own speech, but another app using the same key can cause a fallback to the next engine.

## Troubleshooting

- **It keeps repeating a line, or is reading out old ones.** Run `jarvis stop` to go silent and clear the queue, then `jarvis on`. `jarvis status` shows the last few log entries and why lines were skipped. If you're on a version before this fix and use `--chain`, update and re-run `jarvis install --chain`.
- **Nothing is spoken.** Run `jarvis status` and check `mode`, `quietHoursNow` and the keys. Then run `jarvis test --provider say` to rule out the network.
- **A line arrives late or not at all while several agents are busy.** Lines are dropped once they've waited 2 minutes, so you never hear stale news. The log shows `skipped: stale` or `skipped: busy`.

## Contributing

Adapters for more agents (Aider, Cursor CLI, Gemini CLI, OpenCode, Goose), more voice engines and more languages are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Run the tests with `npm test`.

## License

[MIT](LICENSE)
