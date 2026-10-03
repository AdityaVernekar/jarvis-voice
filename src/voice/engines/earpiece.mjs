// Earpiece Pro hosted voice: Smallest voices on Earpiece's key, with an OpenAI fallback on the
// server. Only tried when the signed-in user is Pro (see src/pro.mjs); any error falls through to
// the next engine, so the user's own keys and the system voice still work.
import { hosted } from "../../pro.mjs";
import { redact } from "../../util.mjs";
import { ttsLang } from "../../i18n.mjs";

export default {
  id: "earpiece",
  label: "Earpiece Pro voice",
  async speak(text, { cfg, lang, fetch = globalThis.fetch, playBuffer }) {
    const s = cfg.smallest;
    const res = await hosted(
      "tts",
      { text: redact(text).slice(0, 400), voice_id: s.voice, model: s.model, language: ttsLang(lang), speed: s.speed },
      { fetch, timeoutMs: 20_000 },
    );
    const type = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (!/audio/.test(type) || buf.length < 1000) throw new Error(`earpiece tts returned no audio (${buf.length} bytes, ${type})`);
    await playBuffer(buf, /mpeg/.test(type) ? ".mp3" : ".wav");
  },
};
