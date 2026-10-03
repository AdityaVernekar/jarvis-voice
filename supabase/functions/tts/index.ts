// Hosted voice for Earpiece Pro: the app sends one short line, this speaks it with our Smallest key
// and returns the audio. Smallest allows one request at a time per account, so a busy or failed call
// retries once and then falls back to OpenAI TTS on our key. Usage is counted per user per month.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CAP = 3000; // hosted lines per user per month; over it the app falls back to the user's own voices
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MODELS = ["lightning_v3.1_pro", "lightning_v3.1"];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// One round trip: PostgREST verifies the user's JWT and pro_status() reads the plan and this month's
// lines. Signed in, Pro and under the cap → the user id; otherwise a ready-made error response.
async function proUser(req: Request): Promise<{ uid: string } | { res: Response }> {
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/pro_status`, {
    method: "POST",
    headers: { apikey: req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY")!, Authorization: req.headers.get("Authorization") || "", "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => null);
  const s = r?.ok ? await r.json() : null;
  if (!s?.uid) return { res: json(401, { error: "sign in to use hosted voice" }) };
  if (!s.pro) return { res: json(402, { error: "hosted voice is part of Earpiece Pro" }) };
  if (s.lines >= CAP) return { res: json(429, { error: "monthly hosted limit reached" }) };
  return { uid: s.uid };
}

async function smallest(b: Record<string, unknown>): Promise<Response> {
  return await fetch("https://api.smallest.ai/waves/v1/tts", {
    method: "POST",
    signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${Deno.env.get("SMALLEST_API_KEY")}`, "Content-Type": "application/json", Accept: "audio/wav" },
    body: JSON.stringify({ ...b, output_format: "wav" }),
  });
}

async function openai(text: string): Promise<Response> {
  return await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "nova", input: text, instructions: "Calm, brief, friendly.", response_format: "mp3" }),
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  // The plan check and reading the body run together: one less wait before the provider call.
  const [who, p] = await Promise.all([proUser(req), (req.json() as Promise<Record<string, unknown>>).catch(() => null)]);
  if ("res" in who) return who.res;
  if (!p || typeof p !== "object") return json(400, { error: "bad json" });
  const text = typeof p.text === "string" ? p.text.trim() : "";
  if (!text || text.length > 400) return json(400, { error: "text must be 1-400 characters" });
  const voice = typeof p.voice_id === "string" && /^[\w-]{1,40}$/.test(p.voice_id) ? p.voice_id : "meher";
  const model = MODELS.includes(String(p.model)) ? String(p.model) : MODELS[0];
  const language = typeof p.language === "string" && /^[\w-]{1,12}$/.test(p.language) ? p.language : "en";
  const speed = Math.min(Math.max(Number(p.speed) || 1, 0.5), 2);

  const body = { text, voice_id: voice, model, language, speed, sample_rate: 24000 };
  let res = await smallest(body).catch(() => null);
  if (res?.status === 429) {
    await new Promise((r) => setTimeout(r, 300));
    res = await smallest(body).catch(() => null);
  }
  let fallback = 0;
  let type = "audio/wav";
  let audio: ArrayBuffer | null = null;
  if (res?.ok && /audio/.test(res.headers.get("content-type") || "")) audio = await res.arrayBuffer();
  if (!audio || audio.byteLength < 2000) {
    const o = await openai(text).catch(() => null);
    if (!o?.ok) return json(502, { error: "voice providers unavailable" });
    audio = await o.arrayBuffer();
    type = "audio/mpeg";
    fallback = 1;
  }

  EdgeRuntime.waitUntil(Promise.resolve(admin.rpc("record_usage", { uid: who.uid, p_lines: 1, p_chars: text.length, p_summaries: 0, p_fallbacks: fallback }))); // counted after the reply, not before
  return new Response(audio, { headers: { "Content-Type": type, "X-Earpiece-Engine": fallback ? "openai" : "smallest" } });
});
