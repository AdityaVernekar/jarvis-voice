// Optional sign-in with Google, through Supabase Auth. The app opens the browser on Supabase's
// authorize page, Google sends you back to earpiece://auth?code=…, and the code is swapped for a
// session (PKCE, so the code alone is useless to anything else that sees the link). Signing in
// only links your usage stats to your account; every feature works without it.
//
// No Electron imports here: main.mjs passes in what it needs, so the logic can be tested in Node.
import crypto from "node:crypto";
import { KEY, SUPABASE } from "./telemetry.mjs";

export const REDIRECT = "earpiece://auth";
const PENDING_MS = 10 * 60_000; // a sign-in left open in the browser longer than this is dropped
const REFRESH_EARLY_S = 60;

const b64url = (buf) => buf.toString("base64url");
export const challengeFor = (verifier) => b64url(crypto.createHash("sha256").update(verifier).digest());

// load() → stored session or null; save(session | null) persists it (encrypted by main.mjs).
export function createAuth({ load, save, openExternal, fetch = globalThis.fetch, now = Date.now }) {
  let pending = null; // { verifier, at }

  async function token(grant, body) {
    const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=${grant}`, {
      method: "POST",
      headers: { apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error(j.error_description || j.msg || `sign-in failed (HTTP ${res.status})`);
    const m = j.user?.user_metadata || {};
    const session = {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: j.expires_at || Math.floor(now() / 1000) + (j.expires_in || 3600),
      user: { email: j.user?.email || null, name: m.full_name || m.name || null },
    };
    save(session);
    return session;
  }

  return {
    user: () => load()?.user || null,

    signIn() {
      const verifier = b64url(crypto.randomBytes(32));
      pending = { verifier, at: now() };
      const q = new URLSearchParams({ provider: "google", redirect_to: REDIRECT, code_challenge: challengeFor(verifier), code_challenge_method: "s256" });
      openExternal(`${SUPABASE}/auth/v1/authorize?${q}`);
    },

    // The earpiece:// link from the browser. Anything that isn't the answer to our own pending
    // sign-in is ignored, so another app can't sign you into someone else's account.
    async handleCallback(url) {
      let u;
      try {
        u = new URL(url);
      } catch {
        return null;
      }
      if (`${u.protocol}//${u.host}` !== REDIRECT || !pending || now() - pending.at > PENDING_MS) return null;
      const { verifier } = pending;
      pending = null;
      const err = u.searchParams.get("error_description") || u.searchParams.get("error");
      if (err) throw new Error(err);
      const code = u.searchParams.get("code");
      if (!code) return null;
      return (await token("pkce", { auth_code: code, code_verifier: verifier })).user;
    },

    // A valid access token, refreshed when it's about to expire, or null when signed out.
    async accessToken() {
      const s = load();
      if (!s) return null;
      if (s.expires_at - REFRESH_EARLY_S > now() / 1000) return s.access_token;
      try {
        return (await token("refresh_token", { refresh_token: s.refresh_token })).access_token;
      } catch (e) {
        if (/HTTP 4|invalid|not found|revoked/i.test(e.message)) save(null); // refresh token is dead
        return null; // offline: keep the session and try again later
      }
    },

    async signOut() {
      const s = load();
      save(null);
      if (s)
        await fetch(`${SUPABASE}/auth/v1/logout`, {
          method: "POST",
          headers: { apikey: KEY, Authorization: `Bearer ${s.access_token}` },
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
    },
  };
}
