# Jarvis × Smallest.ai: integration plan

Status: plan only, nothing built. Docs read on 2026-09-30 from docs.smallest.ai (llms.txt index, Lightning TTS overview, sync, streaming, voices, v3.1 model card, Electron LLM, Pulse STT overview, concurrency and limits, error reference).

## What Smallest.ai actually offers

Smallest.ai does not have a dedicated translation endpoint. "Voice translation" comes from putting two of their products together. First, an LLM (theirs or ours) writes the spoken line in the target language. Then Lightning TTS speaks it with a voice trained on that language. Here is what matters for Jarvis:

| Product | What it is | Relevance to Jarvis |
|---|---|---|
| **Lightning v3.1** (TTS) | `POST https://api.smallest.ai/waves/v1/tts`, Bearer key, 217 voices, 44.1 kHz, ~200 ms TTFB in-region, `wav`/`mp3`/`pcm` output, speed 0.5–2.0 | Core. A drop-in replacement for the OpenAI voice. |
| **Lightning v3.1 Pro** (TTS) | Same route with `"model": "lightning_v3.1_pro"`, a curated pool covering 31 languages. The Indian voices (`aviraj`, `vyom`, `meher`, `rhea`…) code-switch between English and Hindi natively. | The best fit for a Hinglish Jarvis. |
| **SSE / WebSocket streaming** | `POST /waves/v1/tts/live` (SSE) and `wss://…/tts/live`, first chunk in ~100 ms | Later. A one-sentence ping gains little, and `afplay` can't play a stream. |
| **Electron** (LLM) | OpenAI-compatible `POST /waves/v1/chat/completions`, `"model": "electron"`, 70 languages with strong Indic support, 10 RPM / 3 concurrent on the standard plan, pricing not published | Optional summariser and translator, so a single key covers everything. |
| **Pulse** (STT) | `POST /waves/v1/stt/?model=pulse`, WebSocket live, `north_indic` auto-detects en/hi/gu/mr/bn/or | Deferred. Wispr Flow already covers input. |
| **Voice cloning** | Instant clone from 5–15 s of audio, via API or console | Phase 3: a custom "Jarvis" voice, or Adi's own voice. |

Two limits change the design:

1. **The base plan allows 1 concurrent TTS request per account**, shared across every Smallest model. A second request while one is in flight returns `429`. Jarvis already serialises speech through `speak.lock`, so Jarvis on its own is fine. But if the same key is used anywhere else (Lexsis experiments, n8n), Jarvis will hit 429s. The code must fall back to the next engine immediately and must not queue behind a retry loop.
2. **Voice and model must match.** v3.1 voice IDs only work with `lightning_v3.1`, and Pro IDs only with `lightning_v3.1_pro`. A mismatch returns *the wrong voice or no audio at all*, possibly with a 200 status. So we can't rely on HTTP status alone: an empty or tiny body must count as a failure.

Other constraints: text is capped at ~250 characters (140 is optimal), which our 200-character `maxChars` already respects. Hindi must be in **Devanagari**, because the docs say transliterated Hindi ("aapka kaam ho gaya") degrades quality. Servers are in Mumbai and Oregon with geo-routing, so from India latency should sit near the 200 ms figure rather than the 500–800 ms "far from region" case.

## Proposed behaviour

Jarvis keeps the same triggers, but the voice and language become configurable:

```json
{
  "ttsProviders": ["smallest", "openai", "say"],
  "smallest": {
    "model": "lightning_v3.1_pro",
    "voice": "aviraj",
    "language": "en",
    "speed": 1.05,
    "sampleRate": 24000
  },
  "speakLanguage": "en",
  "summaryProvider": "openai"
}
```

`speakLanguage` is the "translation" switch:

| Value | What the summariser writes | Suggested voice |
|---|---|---|
| `en` (default) | English, as today | Pro `sam` (British male, the closest to the current butler) or `aviraj` |
| `hinglish` | Natural Hindi–English mix, Hindi words in Devanagari and tech terms left in English ("Lexsis storefront का cart refactor हो गया, debounce पर आपका input चाहिए.") | Pro Indian voice, e.g. `aviraj` / `meher`, `language: "hi"` |
| `hi` | Full Hindi in Devanagari | Pro Indian voice or v3.1 `devansh` |
| `ta`, `mr`, `kn`, … | That language in its native script | Picked from `jarvis voices --lang <code>` |

The project name ("lexsis storefront") stays in Latin script inside Hindi lines. Pro Indian voices are built for exactly that code-switch.

Translation happens in the **summary step, not as an extra call**. The existing `gpt-4o-mini` prompt gains one instruction ("reply in {language}, native script, max 18 words"), so the added latency and cost are close to zero. Electron becomes an optional `summaryProvider: "smallest"`, which puts the whole pipeline on one vendor and one key.

## Code changes (all in `jarvis.mjs`, still zero-dependency)

1. **Key lookup gets generalised.** `apiKey(cfg)` becomes `apiKey(cfg, "OPENAI_API_KEY" | "SMALLEST_API_KEY")`. It uses the same search order as now (environment, then `envFile`, then `~/.jarvis-voice/.env`). The key goes in the repo `.env` as `SMALLEST_API_KEY=sk_…` and is never logged.
2. **New engine `ttsSmallest(text, cfg)`.** It POSTs to `/waves/v1/tts` with `{text, voice_id, model, language, speed, sample_rate: 24000, output_format: "wav"}` and the header `Accept: audio/wav`. It writes a temp `.wav`, plays it with `afplay` and deletes it. It throws when the response isn't ok, when the body is under ~1 KB (the silent mismatch case), or when the call takes longer than the timeout (`smallestTimeoutMs: 6000`, shorter than OpenAI's because the service is in-region). WAV was chosen over MP3 because it is the documented default path and needs no decoding.
3. **An engine chain replaces the hard-coded OpenAI call.** `speak()` walks `cfg.ttsProviders` in order and logs each failure with its reason (`401`, `403 usage limit`, `429 busy`, `empty audio`, `timeout`). Every fallback is visible in `jarvis status`. There is no retry on 429: it drops straight to OpenAI, so a ping is never late.
4. **The summariser becomes language-aware.** It takes the `speakLanguage` instruction and, optionally, the Electron endpoint (same OpenAI wire format, so only the base URL, key and model change). If the summary fails, the first-sentence fallback stays in English. We would rather say it plainly than garble it.
5. **Fallback voice per language.** If Smallest and OpenAI both fail on a Hindi line, macOS `say` is given `-v Lekha` (the Hindi system voice) instead of `Daniel`.

New CLI commands:

```bash
jarvis voices [--lang hi] [--pro]     # GET /waves/v1/lightning-v3.1/get_voices, filtered table
jarvis voice aviraj                   # sets smallest.voice and infers model from the catalog tags
jarvis lang hinglish                  # sets speakLanguage (en | hinglish | hi | ta | …)
jarvis test --provider smallest       # forces one engine, prints engine + latency
jarvis status                         # adds: smallestKey found/missing, provider chain, last engine used
```

`jarvis voice` checks the ID against the catalog before saving it. This prevents the mismatch trap at config time instead of during a silent ping.

`install.mjs` needs only one change: the config message reports whether `SMALLEST_API_KEY` was found as well as `OPENAI_API_KEY`.

## Phases

**Phase 1: Smallest as the main voice (about half a day).** This covers the key lookup, `ttsSmallest`, the engine chain, and the `voices`, `voice` and `test --provider` commands, with English only. Done means `jarvis test --provider smallest` speaks in an `aviraj` or `sam` voice on the Mac, and pulling Wi-Fi or breaking the key still falls through to OpenAI, then `say`.

**Phase 2: language and Hinglish (about half a day).** This adds `speakLanguage`, `jarvis lang`, the summary-prompt change, and the Devanagari check. If the summary for `hi` comes back in Latin script, we re-ask once or fall back to English. A pronunciation dictionary covers "Lexsis", "Shopify", "Codex" and project names, if the sync route honours it (see the doc issues below). Done means a real Claude Code turn announces itself in Hinglish without any mispronounced brand names.

**Phase 3: the Jarvis voice itself (optional).** Clone a voice from 5–15 s of clean audio: either a butler read recorded on purpose, or Adi's own voice for demos. That voice's ID is then set as `smallest.voice`. Cloned voices follow the same language-group rules. This needs explicit consent for whoever's voice is used.

**Phase 4 (deferred, belongs with the voice hub).** This means Electron as the default summariser, SSE streaming through a small PCM player, and Pulse STT for a hands-free `jarvis listen` reply loop. None of it helps the terminal ping use case enough yet to justify the complexity.

## Test plan

In the sandbox, once the key arrives: one curl to `/tts` to confirm auth, format and latency. One `get_voices` call to snapshot the live catalog. Deliberately mismatched voice/model to see what actually comes back (the status code and body size, which the "tiny body" check depends on). A Hindi and a Hinglish line, saved as WAV to check the files. A forced 401 (bad key) and a simulated 429 to confirm the chain falls through. Every path is also run with `JARVIS_DRY_RUN=1` and fake payloads, as for v1.

On the Mac, three checks. First, `jarvis test --provider smallest`. Second, `jarvis lang hinglish` followed by a real 30-second-plus Claude Code task. Third, run two agents finishing at the same moment, to confirm the lock plus the one-concurrency limit never produces overlapping or dropped pings.

## Open points and doc issues found

- **Pricing isn't in the docs.** Lightning and Electron both say "contact sales / account manager". Check the console before making Smallest the default, since Jarvis will make a few hundred short calls a day.
- **`pronunciation_dicts` contradicts itself.** The sync page lists it as a normal `/tts` parameter, but the v3.1 model card marks it "WebSocket only". Phase 2 needs a live test.
- **The `language` lists disagree.** The overview says v3.1 accepts 20 codes, including `fr`/`de`, while the sync parameter table lists only the Indic codes plus `es`, and the model card calls those 8 extra codes "routed via English/Hindi voices". For Jarvis, stick to languages with trained voices.
- **Pulse language counts vary between pages:** 31 (21 streaming + 22 pre-recorded) in the index, and 35 (21 + 26) on the overview. This doesn't matter now, but it's worth knowing if Pulse comes in later.
- **One concurrent TTS request per account** is tight if the same key is ever shared with Lexsis product work. Use a separate key or workspace for Jarvis.
