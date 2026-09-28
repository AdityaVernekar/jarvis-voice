---
title: Jarvis Voice MCP — Build Plan
type: lexsis
created: 2026-09-28
updated: 2026-09-28
tags: [ai, tooling, mcp, draft]
sources: []
---

# Jarvis Voice MCP — Build Plan

> [!note] Scope change, 2026-09-28
> v1 is **terminal only**: Claude Code and Codex CLI via hooks/`notify`, plus a `jarvis run` wrapper for any command. It's shipped as `jarvis.mjs` + `install.mjs`; see `README.md`. The desktop-app MCP/skill (Surface 1 below) and the multi-app "hub" are deferred until the terminal version has been used for real.

## Goal

Claude should tell Adi, out loud, when work finishes, when it is blocked on him, and when something fails. He should never have to watch the window. Input stays as it is today (Wispr Flow dictating into the chat box). This project covers only the output side: short spoken pings and one-line summaries, never full responses.

Decisions locked on 2026-09-28:

| Question | Decision |
|---|---|
| Voice engine | OpenAI TTS (`gpt-4o-mini-tts`) with fallback to macOS `say` |
| Surfaces | Claude desktop app (MCP + skill) and Claude Code (MCP + hooks) |
| Chattiness | Pings plus a one-to-two-line summary; never read the full reply |

## Architecture

One small Node/TypeScript package, `tools/jarvis-voice/`, that matches the repo's existing stack (Node ≥20, ESM, strict TS). It ships a single binary with three entry points that share one core:

```
jarvis-voice mcp      # stdio MCP server (desktop app + Claude Code)
jarvis-voice say "…"  # CLI, used by hooks and for manual testing
jarvis-voice hook     # reads a Claude Code hook payload from stdin, decides whether to speak
```

```
tools/jarvis-voice/
├── PLAN.md
├── package.json
├── src/
│   ├── core/
│   │   ├── speak.ts        # policy → engine → playback
│   │   ├── policy.ts       # mode, quiet hours, dedupe, length cap, cooldown
│   │   ├── queue.ts        # cross-process playback lock so sessions never talk over each other
│   │   ├── engines/
│   │   │   ├── openai.ts   # gpt-4o-mini-tts → mp3 → cache
│   │   │   └── say.ts      # macOS `say` fallback
│   │   └── state.ts        # ~/.jarvis-voice/state.json (mode, last-spoken per session)
│   ├── mcp.ts              # MCP tool definitions
│   ├── hook.ts             # Stop / Notification / UserPromptSubmit handling
│   └── cli.ts
├── skill/SKILL.md          # "when to speak" rules for the desktop app
└── tests/
tools/start-jarvis-voice-mcp.sh   # sources .env, execs `jarvis-voice mcp` (same pattern as the other start-*-mcp.sh)
```

The MCP server must run on the Mac host, not inside the desktop app's Linux sandbox, because only the host has speakers. Local stdio servers in the desktop config already run on the host, so this works as long as it's registered as a local MCP server.

## MCP Tools

Keep the surface small. The tool descriptions are what make Claude call these at the right moments, so treat them as product copy. It's the same lesson as the Lexsis MCP.

| Tool | Args | Behaviour |
|---|---|---|
| `speak` | `text` (≤ 200 chars), `kind`: `done` \| `needs_input` \| `error` \| `info`, `session_label?` | Returns right away (`{queued: true}` or `{skipped: reason}`); audio plays in the background. |
| `voice_mode` | `mode`: `on` \| `urgent_only` \| `off`, `for_minutes?` | Lets Adi say "Jarvis, go quiet for an hour" through Wispr. `urgent_only` keeps only `needs_input` and `error` pings. |
| `voice_status` | none | Current mode, engine health, and last line spoken. Useful for debugging. |

`kind` does two jobs. It drives policy (what gets through `urgent_only`), and it adds a short leading chime per kind (`afplay` on bundled sounds), so Adi can tell "done" from "need you" before a word is spoken.

## Speaking Policy

The policy layer is what keeps this from getting annoying. It is enforced in code, not left to the model:

- Hard cap of 200 characters. Longer text is cut at a sentence boundary.
- Dedupe: the same text within 60 seconds is skipped.
- Cooldown per session: at most one `info` ping every 2 minutes. `needs_input` and `error` always go through.
- Quiet hours, configurable, default 23:00–08:00: only `needs_input` gets through.
- `voice_mode` expiry is stored in state, so "quiet for an hour" survives server restarts.
- Cross-process queue: multiple Claude sessions each start their own MCP process, so playback takes a lock file in `~/.jarvis-voice/`. That keeps two agents from talking over each other.

## Voice Engine

OpenAI first: `gpt-4o-mini-tts`, with an `instructions` field for the persona (calm, dry, brief, British-butler energy) and a fixed voice. The mp3 is played through `afplay`. Common fixed phrases ("Need your input", "Done") are cached by hash in `~/.jarvis-voice/cache/`, so they play instantly and cost nothing after the first time.

Fallback: `say -v Daniel` (or whichever voice Adi picks) when there's no key, the network is down, the API fails, or it takes more than 4 seconds. The fallback is silent in the sense that it never raises an error to the agent. It just logs the failure to `~/.jarvis-voice/log.jsonl`.

The API key comes from the repo `.env` through the start script and is never hardcoded. Only the short spoken line leaves the machine, never the full transcript.

## Surface 1: Desktop App (MCP + Skill)

The desktop app has no hooks, so the trigger is instruction-following. The skill (`skill/SKILL.md`, installed as a saved user skill so it's always available, plus a canonical copy in `agent-kit/skills/jarvis-voice/`) gives these rules:

1. Call `speak(kind: "needs_input")` right before any `AskUserQuestion`, or before any turn that ends with a question to Adi.
2. Call `speak(kind: "done")` as the last tool call before the final message of any task that took more than a few tool calls. The line names the deliverable, e.g. "Landing page draft is ready, two warnings."
3. Call `speak(kind: "error")` when a task can't continue.
4. Don't speak for quick back-and-forth chat.
5. Lines are written for the ear: no file paths, no IDs, no markdown, under 20 words.

Known limit: this is best-effort. Claude will sometimes forget. We'll measure how often in Phase 3 and tighten the tool description if it's too low.

## Surface 2: Claude Code (MCP + Hooks)

Hooks make the pings reliable. They go in user-level `~/.claude/settings.json`, so they work in every project, not just this repo:

- **`UserPromptSubmit`**: record the turn start time per session in state.
- **`Stop`**: if the turn took 45 seconds or longer and the agent didn't already call `speak` this turn, read the last assistant message from `transcript_path`. Squeeze it into one spoken line (first try the first sentence with markdown stripped; if that's still over 20 words, one `gpt-4o-mini` call to compress it), then speak it with `kind: done`.
- **`Notification`**: fires when Claude Code needs permission or is idle waiting. Speak `needs_input` using the payload's message.

Hooks and the MCP share the "already spoke this turn" state, so there's never a double announcement.

## Build Phases

| Phase | Scope | Done when |
|---|---|---|
| 1. Core + CLI | engines, fallback, policy, queue, `jarvis-voice say` | `say "test"` speaks through OpenAI; with Wi-Fi off it falls back to `say`; two parallel calls play one after the other |
| 2. MCP server | `speak`, `voice_mode`, `voice_status`; start script; registered in desktop config and Claude Code | Claude in both surfaces can call `speak` and Adi hears it |
| 3. Desktop skill | SKILL.md, saved as a user skill + agent-kit copy, `tools/agent-kit sync` | Across 10 real tasks, the done/needs-input ping fires on at least 8 |
| 4. Claude Code hooks | `hook` entry point, settings snippet, dedupe with the MCP | Long tasks announce themselves; short ones stay silent; no double pings |
| 5. Polish | kind chimes, phrase cache, quiet hours, persona tuning | Adi keeps it on for a full workday without muting it |

Phases 1–2 are about half a day. Phases 3–4 are another half day, mostly spent tuning.

## Test Plan

- **Engine:** OpenAI path, missing key, network off, a slow response (over 4 s), and an invalid voice name. Each case must end in audio, never an error thrown back to the agent.
- **Policy:** 500-character input gets cut, the same line twice is deduped, the `info` cooldown works, quiet hours work, and `urgent_only` drops `done`.
- **Concurrency:** three sessions calling `speak` at the same moment play in order, and a stale lock (crashed process) is recovered after 30 seconds.
- **Hooks:** a short turn stays silent, a long turn is announced, `speak` followed by `Stop` gives one ping only, and a `Notification` payload is spoken.
- **Desktop app:** 10 real tasks (including one Lexsis page build that ends in an approval question); log the hit rate of the pings.

## Risks and Open Questions

- **Desktop reliability** depends on the model following the skill. If the hit rate stays low, the fallback idea is a tiny menu-bar watcher that tails the desktop app's session transcripts and speaks when a turn ends. It's heavier, so we only build it if needed.
- **Desktop config path:** this build runs as `Claude-3p`. Before Phase 2, confirm which `claude_desktop_config.json` it reads local MCP servers from.
- **Two-way voice** (Claude listening without Wispr) is out of scope for v1. Wispr already covers input well.
- **Proactive briefings** (e.g. a spoken morning summary from Minimi through a scheduled task) are a natural v2 once `speak` exists.
