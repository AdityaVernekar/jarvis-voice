# Jarvis Voice

Spoken pings for terminal coding agents. When Claude Code or Codex CLI finishes a long task or needs you, Jarvis says so out loud, e.g. *"lexsis storefront. I refactored the cart code and need your input on debounce timing."* It works in any terminal (Terminal, iTerm, Warp, Ghostty, VS Code, Cursor) because it hooks into the agents, not the terminal.

Input stays yours: dictate replies with Wispr Flow as usual.

## What it does

| Situation | What you hear |
|---|---|
| Claude Code turn finishes after ≥ 30 s | Chime + project name + one-sentence summary |
| Claude Code needs permission | Chime + "<project> needs your permission to use Bash." |
| Claude Code idle, waiting on you (and hasn't already announced) | "<project> is waiting for you." |
| Codex CLI turn finishes | Chime + project name + summary (a "needs input" chime if it ended on a question) |
| `jarvis run -- <cmd>` takes ≥ 30 s | "<project>. npm test finished." / "…failed." |

Quick turns stay silent. The same line twice within 60 s is skipped. Multiple sessions queue up instead of talking over each other. Quiet hours (23:00–08:00) let only "needs input" through.

Voice: OpenAI `gpt-4o-mini-tts`. Summaries: `gpt-4o-mini`. If there's no key, no network or an API error, it falls back to the macOS `say` voice. Only the short summary input and the spoken line are sent to OpenAI.

## Install (macOS, Node ≥ 20)

```bash
cd tools/jarvis-voice
node install.mjs                  # or: node install.mjs --env /path/to/.env
echo "alias jarvis='node $(pwd)/jarvis.mjs'" >> ~/.zshrc && source ~/.zshrc
jarvis test                       # you should hear Jarvis
```

The installer adds hooks to `~/.claude/settings.json` and a `notify` line to `~/.codex/config.toml`, backing up both first. It never overwrites an existing Codex `notify` by default. Re-run with `--chain` to keep yours: Jarvis takes the slot, speaks, then forwards the same event to your original command, and `--uninstall` puts the original back.

Paste the setup lines one at a time (or open a new tab after adding the alias). zsh reads a multi-line paste as one block, so `jarvis` isn't defined yet when that line is checked. Restart running agent sessions afterwards. To remove everything: `node install.mjs --uninstall`.

The key is read from `OPENAI_API_KEY` in the environment, then from the `envFile` in `~/.jarvis-voice/config.json`, then from `~/.jarvis-voice/.env`.

## Everyday commands

```bash
jarvis quiet 60     # only "needs input" pings for an hour
jarvis off          # silence until `jarvis on`
jarvis on
jarvis status       # mode, key found, last events
jarvis say "text" --kind done|needs_input|error|info
jarvis run -- npm run build
```

## Config (`~/.jarvis-voice/config.json`)

```json
{
  "voice": "onyx",
  "voiceInstructions": "Calm, dry, quietly confident British butler.",
  "sayVoice": "Daniel",
  "minTurnSeconds": 30,
  "quietHours": { "start": "23:00", "end": "08:00" },
  "chimes": true
}
```

Logs go to `~/.jarvis-voice/log.jsonl`. Every spoken, skipped or failed event is logged with the reason, so `jarvis status` tells you why something did or didn't speak.

## 5-minute Mac check

1. `jarvis test`: you hear a Glass chime, then the OpenAI voice. (If you only hear the robotic voice, run `jarvis status` and check `openaiKey`.)
2. Wi-Fi off, then `jarvis say hello`: you hear the macOS `say` voice.
3. In Claude Code, ask for something quick ("what's 2+2"): silence.
4. Ask for something that takes over 30 s: chime and summary when it finishes.
5. Trigger a permission prompt (e.g. a Bash command in default mode): "needs your permission".
6. In Codex CLI, run any task: a summary when the turn completes.
7. `jarvis quiet 5`, then repeat step 4: silence. `jarvis on` to restore.

## Known limits

- Codex's `notify` only fires on turn completion and sends no start time, so every Codex turn is announced (use `jarvis quiet` if that's too chatty). Codex approval prompts don't trigger a ping.
- The installer pins the Node binary path it ran with. If you switch Node versions with nvm, re-run `node install.mjs`.
- macOS only for audio (`afplay`/`say`). On other systems it logs what it would have said.
