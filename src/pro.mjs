// Earpiece Pro in the core: hosted voice and summaries on Earpiece's own keys. The Mac app signs
// in and keeps ~/.earpiece/account.json fresh (a short-lived access token and the plan); this file
// only reads it. The server checks the plan and the monthly cap on every call, so "Pro" here only
// decides whether a request is worth making. Without the file (CLI only, signed out, Free) nothing
// changes: the user's own keys and the system voice work as before.
import { P } from "./paths.mjs";
import { readJson, redact } from "./util.mjs";

export const FUNCTIONS = "https://xqlcwdmgikqbicwvgfbj.supabase.co/functions/v1";
// Publishable key: identifies the project to the Supabase gateway. The user's token is what counts.
const KEY = "sb_publishable_EH82KH93ZvUQAN_yHprfAA_Y2dIbyVX";

/** The signed-in Pro user's access token, or null (signed out, Free, or expiring within 30 s). */
export function proToken(now = Date.now()) {
  const a = readJson(P.account, null);
  if (!a || a.plan !== "pro" || typeof a.access_token !== "string") return null;
  if (!(Number(a.expires_at) * 1000 > now + 30_000)) return null;
  return a.access_token;
}

/** POST to a hosted function as the signed-in user. Throws on any failure so callers fall back. */
export async function hosted(name, body, { fetch = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const token = proToken();
  if (!token) throw new Error("not signed in to Earpiece Pro");
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // 402 = not Pro, 429 = monthly cap reached, 502 = providers down. All fall back the same way.
  if (!res.ok) throw new Error(`earpiece ${name} HTTP ${res.status}: ${redact((await res.text()).slice(0, 120))}`);
  return res;
}
