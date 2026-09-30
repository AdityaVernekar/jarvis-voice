// Smallest.ai Lightning TTS. https://docs.smallest.ai
import { redact } from "../../util.mjs";
import { apiKey } from "../../config.mjs";
import { ttsLang } from "../../i18n.mjs";

const API = "https://api.smallest.ai/waves/v1";

// Voice catalog routes per model. The Pro catalog is not linked from the docs, and the
// documented v3.1 catalog does not include Pro voices.
const VOICE_LISTS = { "lightning_v3.1_pro": "lightning-v3.1-pro", "lightning_v3.1": "lightning-v3.1" };
export const MODELS = Object.keys(VOICE_LISTS);

export default {
  id: "smallest",
  label: "Smallest.ai Lightning",
  keyName: "SMALLEST_API_KEY",
  async speak(text, { cfg, lang, fetch = globalThis.fetch, playBuffer }) {
    const key = apiKey(cfg, "SMALLEST_API_KEY");
    if (!key) throw new Error("no SMALLEST_API_KEY");
    const s = cfg.smallest;
    const res = await fetch(`${API}/tts`, {
      method: "POST",
      signal: AbortSignal.timeout(cfg.smallestTimeoutMs),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "audio/wav" },
      body: JSON.stringify({
        text,
        voice_id: s.voice,
        model: s.model,
        language: ttsLang(lang),
        speed: s.speed,
        sample_rate: s.sampleRate,
        output_format: "wav",
      }),
    });
    // 400 = voice not on this model, 401 = bad key, 403 = usage limit, 429 = another TTS call in flight on the account.
    if (!res.ok) throw new Error(`smallest HTTP ${res.status}: ${redact((await res.text()).slice(0, 200))}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!/audio/.test(res.headers.get("content-type") || "") || buf.length < 2000)
      throw new Error(`smallest returned no audio (${buf.length} bytes, ${res.headers.get("content-type")})`);
    playBuffer(buf, ".wav");
  },
};

export async function fetchVoices(cfg, model, fetch = globalThis.fetch) {
  const key = apiKey(cfg, "SMALLEST_API_KEY");
  if (!key) throw new Error("no SMALLEST_API_KEY (set it in your environment or envFile)");
  const res = await fetch(`${API}/${VOICE_LISTS[model] || "lightning-v3.1"}/get_voices`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`get_voices HTTP ${res.status}`);
  const j = await res.json();
  return (j.voices || []).map((v) => ({
    voiceId: v.voiceId,
    name: v.displayName || v.voiceId,
    model,
    tags: {
      gender: String(v.tags?.gender || ""),
      accent: String(v.tags?.accent || ""),
      age: String(v.tags?.age || ""),
      language: (v.tags?.language || []).map((l) => String(l).toLowerCase()),
    },
  }));
}

// Find a voice id in any catalog. Returns the voice (with its model) or null.
export async function findVoice(cfg, id, fetch = globalThis.fetch) {
  for (const model of MODELS) {
    const v = (await fetchVoices(cfg, model, fetch)).find((x) => x.voiceId === id);
    if (v) return v;
  }
  return null;
}
