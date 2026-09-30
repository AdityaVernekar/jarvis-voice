// OpenAI text-to-speech. https://platform.openai.com/docs/guides/text-to-speech
import { redact } from "../../util.mjs";
import { apiKey } from "../../config.mjs";

export default {
  id: "openai",
  label: "OpenAI TTS",
  keyName: "OPENAI_API_KEY",
  async speak(text, { cfg, fetch = globalThis.fetch, playBuffer }) {
    const key = apiKey(cfg, "OPENAI_API_KEY");
    if (!key) throw new Error("no OPENAI_API_KEY");
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      signal: AbortSignal.timeout(cfg.ttsTimeoutMs),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.ttsModel,
        voice: cfg.voice,
        input: text,
        instructions: cfg.voiceInstructions,
        response_format: "mp3",
      }),
    });
    if (!res.ok) throw new Error(`openai HTTP ${res.status}: ${redact((await res.text()).slice(0, 200))}`);
    playBuffer(Buffer.from(await res.arrayBuffer()), ".mp3");
  },
};
