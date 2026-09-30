# Voice engines

Jarvis tries each engine in `ttsProviders` (default `["smallest", "openai", "say"]`) until one plays the line.

| Engine | Needs | Notes |
| --- | --- | --- |
| `smallest` | `SMALLEST_API_KEY` | Lightning v3.1 and v3.1 Pro voices, strong on Indian languages. `jarvis voices` lists them. One request at a time per account. |
| `openai` | `OPENAI_API_KEY` | `gpt-4o-mini-tts` with `voice` and `voiceInstructions` from config. |
| `say` | nothing | macOS `say` (Hindi lines use Lekha), else `espeak-ng`, `espeak` or `spd-say`. |

## Adding an engine

Create `src/voice/engines/<id>.mjs`:

```js
export default {
  id: "my-tts",
  label: "My TTS",
  keyName: "MY_TTS_API_KEY", // optional, for status output
  // Throw on any failure so the chain moves on to the next engine.
  async speak(text, { cfg, lang, fetch, playBuffer }) {
    const key = apiKey(cfg, "MY_TTS_API_KEY");
    if (!key) throw new Error("no MY_TTS_API_KEY");
    const res = await fetch("https://…", { signal: AbortSignal.timeout(10_000), /* … */ });
    if (!res.ok) throw new Error(`my-tts HTTP ${res.status}`);
    playBuffer(Buffer.from(await res.arrayBuffer()), ".mp3");
  },
};
```

`lang` is the spoken language code (`en`, `hi`, `ta`, …). Use the injected `fetch` and `playBuffer` rather than globals so tests can stub them. Register the engine in `src/voice/engines/index.mjs`, then add it to `ttsProviders`.

Never log request headers or keys. Error messages may include a short slice of the response body, which is fine for these APIs, but check that yours doesn't echo credentials back.
