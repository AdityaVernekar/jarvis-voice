// Optional Google sign-in: PKCE, which links are accepted, refresh and sign-out.
import assert from "node:assert/strict";
import test from "node:test";
import { challengeFor, createAuth, REDIRECT } from "../app/main/auth.mjs";
import { SUPABASE } from "../app/main/telemetry.mjs";

const TOKEN_REPLY = { access_token: "at1", refresh_token: "rt1", expires_in: 3600, user: { email: "dev@example.com", user_metadata: { full_name: "Dev" } } };

function setup({ reply = TOKEN_REPLY, status = 200, fail = false, session = null, t = 1_000_000 } = {}) {
  let stored = session;
  const calls = [];
  const opened = [];
  const clock = { t };
  const auth = createAuth({
    load: () => stored,
    save: (s) => (stored = s),
    openExternal: (url) => opened.push(url),
    now: () => clock.t,
    fetch: async (url, opts) => {
      calls.push({ url, body: opts.body && JSON.parse(opts.body), headers: opts.headers });
      if (fail) throw new TypeError("fetch failed");
      return { ok: status < 400, status, json: async () => reply };
    },
  });
  return { auth, calls, opened, clock, stored: () => stored };
}

test("PKCE challenge matches RFC 7636 appendix B", () => {
  assert.equal(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("sign in: opens Google via Supabase, swaps the code with the matching verifier, stores the session", async () => {
  const { auth, calls, opened, stored } = setup();
  auth.signIn();
  const u = new URL(opened[0]);
  assert.equal(`${u.origin}${u.pathname}`, `${SUPABASE}/auth/v1/authorize`);
  assert.equal(u.searchParams.get("provider"), "google");
  assert.equal(u.searchParams.get("redirect_to"), REDIRECT);
  assert.equal(u.searchParams.get("code_challenge_method"), "s256");

  const user = await auth.handleCallback("earpiece://auth?code=abc");
  assert.deepEqual(user, { email: "dev@example.com", name: "Dev" });
  assert.match(calls[0].url, /grant_type=pkce$/);
  assert.equal(calls[0].body.auth_code, "abc");
  assert.equal(challengeFor(calls[0].body.code_verifier), u.searchParams.get("code_challenge"));
  assert.equal(stored().access_token, "at1");
  assert.deepEqual(auth.user(), { email: "dev@example.com", name: "Dev" });
});

test("links that aren't the answer to our own pending sign-in are ignored", async () => {
  const { auth, calls, clock } = setup();
  assert.equal(await auth.handleCallback("earpiece://auth?code=abc"), null); // nothing pending
  auth.signIn();
  assert.equal(await auth.handleCallback("earpiece://other?code=abc"), null);
  assert.equal(await auth.handleCallback("https://auth?code=abc"), null);
  assert.equal(await auth.handleCallback("not a url"), null);
  clock.t += 11 * 60_000; // left open too long
  assert.equal(await auth.handleCallback("earpiece://auth?code=abc"), null);
  assert.equal(calls.length, 0);
});

test("a pending sign-in is used once, and errors from the browser are reported", async () => {
  const { auth } = setup();
  auth.signIn();
  await assert.rejects(auth.handleCallback("earpiece://auth?error=access_denied&error_description=User+cancelled"), /User cancelled/);
  assert.equal(await auth.handleCallback("earpiece://auth?code=abc"), null);
});

test("access token: reused while fresh, refreshed near expiry, dropped when the refresh token is dead", async () => {
  const fresh = { access_token: "old", refresh_token: "rt0", expires_at: 1000 + 3600, user: {} };
  let s = setup({ session: fresh, t: 1000 * 1000 });
  assert.equal(await s.auth.accessToken(), "old");
  assert.equal(s.calls.length, 0);

  s = setup({ session: { ...fresh, expires_at: 1000 + 30 }, t: 1000 * 1000 });
  assert.equal(await s.auth.accessToken(), "at1");
  assert.match(s.calls[0].url, /grant_type=refresh_token$/);
  assert.equal(s.calls[0].body.refresh_token, "rt0");

  s = setup({ session: { ...fresh, expires_at: 0 }, status: 400, reply: { error_description: "Invalid Refresh Token: Refresh Token Not Found" } });
  assert.equal(await s.auth.accessToken(), null);
  assert.equal(s.stored(), null);

  s = setup({ session: { ...fresh, expires_at: 0 }, fail: true }); // offline: keep the session
  assert.equal(await s.auth.accessToken(), null);
  assert.ok(s.stored());

  assert.equal(await setup().auth.accessToken(), null); // signed out
});

test("sign out clears the session even when the network is down", async () => {
  const { auth, stored } = setup({ session: { access_token: "a", refresh_token: "r", expires_at: 9e9, user: {} }, fail: true });
  await auth.signOut();
  assert.equal(stored(), null);
  assert.equal(auth.user(), null);
});
