// Earpiece Pro: hosted voice and summaries are tried first only for a signed-in Pro user, and any
// failure falls back to the user's own chain.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

const home = tempHome({ quietHours: null, chimes: false, ttsProviders: ["smallest", "say"] });
process.env.SMALLEST_API_KEY = "test-smallest";
process.env.OPENAI_API_KEY = "test-openai";
delete process.env.EARPIECE_DRY_RUN;
const { speak } = await import("../src/voice/speak.mjs");
const { summarize } = await import("../src/summary/summarize.mjs");
const { config } = await import("../src/config.mjs");
const { proToken, FUNCTIONS } = await import("../src/pro.mjs");

const account = path.join(home, "account.json");
const setAccount = (a) => (a ? fs.writeFileSync(account, JSON.stringify(a)) : fs.rmSync(account, { force: true }));
const pro = (extra = {}) => ({ plan: "pro", access_token: "user-jwt", expires_at: Math.floor(Date.now() / 1000) + 3600, ...extra });
const audio = (type) => new Response(Buffer.alloc(4000, 1), { status: 200, headers: { "content-type": type } });

test("proToken: only a Pro account with an unexpired token counts", () => {
  setAccount(null);
  assert.equal(proToken(), null);
  setAccount(pro({ plan: "free" }));
  assert.equal(proToken(), null);
  setAccount(pro({ expires_at: Math.floor(Date.now() / 1000) + 10 })); // expires within 30 s
  assert.equal(proToken(), null);
  setAccount(pro());
  assert.equal(proToken(), "user-jwt");
});

test("Pro: hosted voice speaks first, with the user's token and voice settings", async () => {
  setAccount(pro());
  const calls = [];
  const played = [];
  const fetch = async (url, init) => (calls.push({ url, init }), audio("audio/mpeg"));
  const r = await speak("Pro line one.", "done", { force: true }, { fetch, playBuffer: (b, ext) => played.push(ext) });
  assert.equal(r.engine, "earpiece");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${FUNCTIONS}/tts`);
  assert.equal(calls[0].init.headers.Authorization, "Bearer user-jwt");
  assert.equal(JSON.parse(calls[0].init.body).voice_id, "meher");
  assert.deepEqual(played, [".mp3"]); // the server's OpenAI fallback returns mp3
});

test("Pro over the cap (429) or lapsed (402): falls through to the user's own Smallest key", async () => {
  setAccount(pro());
  for (const status of [429, 402]) {
    const urls = [];
    const fetch = async (url) => (urls.push(url), url.startsWith(FUNCTIONS) ? new Response("{}", { status }) : audio("audio/wav"));
    const r = await speak(`Fallback line ${status}.`, "done", { force: true }, { fetch, playBuffer: () => {} });
    assert.equal(r.engine, "smallest");
    assert.equal(urls[0], `${FUNCTIONS}/tts`);
    assert.match(urls[1], /smallest\.ai/);
  }
});

test("Free or signed out: the hosted voice is never called", async () => {
  setAccount(pro({ plan: "free" }));
  const urls = [];
  const fetch = async (url) => (urls.push(url), audio("audio/wav"));
  const r = await speak("Free line.", "done", { force: true }, { fetch, playBuffer: () => {} });
  assert.equal(r.engine, "smallest");
  assert.ok(!urls.some((u) => u.startsWith(FUNCTIONS)));
});

test("summaries: hosted for Pro, the user's own OpenAI key when hosted fails, nothing hosted for Free", async () => {
  const cfg = { ...config(), summaryProvider: "openai" };
  setAccount(pro());
  let urls = [];
  let fetch = async (url) => (urls.push(url), new Response(JSON.stringify({ line: "Refactored the cart, tests pass." }), { status: 200 }));
  let s = await summarize("Long agent message about the cart refactor.", cfg, { fetch });
  assert.deepEqual([s.line, s.via], ["Refactored the cart, tests pass.", "earpiece"]);
  assert.equal(urls[0], `${FUNCTIONS}/summarize`);

  urls = [];
  fetch = async (url) =>
    (urls.push(url),
    url.startsWith(FUNCTIONS)
      ? new Response("{}", { status: 502 })
      : new Response(JSON.stringify({ choices: [{ message: { content: "Own key summary." } }] }), { status: 200 }));
  s = await summarize("Another message.", cfg, { fetch });
  assert.deepEqual([s.line, s.via], ["Own key summary.", "openai"]);

  setAccount(null);
  urls = [];
  s = await summarize("Third message.", cfg, { fetch });
  assert.ok(!urls.some((u) => u.startsWith(FUNCTIONS)));
});
