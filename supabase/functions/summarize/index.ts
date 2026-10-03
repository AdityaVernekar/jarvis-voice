// Hosted summaries for Earpiece Pro: turns an agent's final message into one spoken sentence with our
// OpenAI key. The prompt is fixed here, so this can't be used as a general-purpose LLM proxy.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CAP = 3000; // same monthly cap as hosted voice: a summary is only useful if a line is spoken
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Keep in sync with SYSTEM in src/summary/summarize.mjs.
const SYSTEM =
  "You turn a coding agent's final message into ONE spoken sentence (max 18 words) for a developer who is away from the screen. " +
  "Say what got done, and if the agent is asking something or hit a problem, say that. No file paths, code, IDs, URLs, markdown or lists. ";

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
  if (!s?.uid) return { res: json(401, { error: "sign in to use hosted summaries" }) };
  if (!s.pro) return { res: json(402, { error: "hosted summaries are part of Earpiece Pro" }) };
  if (s.lines >= CAP) return { res: json(429, { error: "monthly hosted limit reached" }) };
  return { uid: s.uid };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  // The plan check and reading the body run together: one less wait before the provider call.
  const [who, p] = await Promise.all([proUser(req), (req.json() as Promise<Record<string, unknown>>).catch(() => null)]);
  if ("res" in who) return who.res;
  if (!p || typeof p !== "object") return json(400, { error: "bad json" });
  const text = typeof p.text === "string" ? p.text.slice(-6000) : "";
  if (!text.trim()) return json(400, { error: "text is required" });
  // The language rule from the app (e.g. "Answer in Hindi, in Devanagari"). Short, never a second prompt.
  const lang = typeof p.instruction === "string" ? p.instruction.slice(0, 300) : "";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 120,
      messages: [
        { role: "system", content: SYSTEM + lang },
        { role: "user", content: text },
      ],
    }),
  }).catch(() => null);
  if (!res?.ok) return json(502, { error: "summary provider unavailable" });
  const j = await res.json();
  const line = String(j.choices?.[0]?.message?.content || "").trim().replace(/^["“]|["”]$/g, "").slice(0, 400);
  if (!line) return json(502, { error: "empty summary" });

  EdgeRuntime.waitUntil(Promise.resolve(admin.rpc("record_usage", { uid: who.uid, p_lines: 0, p_chars: 0, p_summaries: 1, p_fallbacks: 0 }))); // counted after the reply, not before
  return json(200, { line });
});
