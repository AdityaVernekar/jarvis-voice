// The card and the "speaking" indicator must follow the audio, not the TTS API request.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

const home = tempHome({ quietHours: null, chimes: false, ttsProviders: ["smallest", "openai"] });
process.env.SMALLEST_API_KEY = "test-smallest";
process.env.OPENAI_API_KEY = "test-openai";
delete process.env.EARPIECE_DRY_RUN;
const { speak } = await import("../src/voice/speak.mjs");
const { readCard, isSpeaking, SPEAKING_MAX_MS } = await import("../src/card.mjs");
const { stopSpeaking } = await import("../src/control.mjs");
const { P } = await import("../src/paths.mjs");

const audio = () => new Response(Buffer.alloc(4000, 1), { status: 200, headers: { "content-type": "audio/wav" } });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test("no card and no speaking state while the TTS API is still working", async () => {
  const seen = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const fetch = async () => {
    await gate; // the API is slow
    return audio();
  };
  const playBuffer = async () => seen.push(["playing", readCard()?.state, isSpeaking()]);
  const p = speak("Slow provider line.", "done", { force: true, agent: "codex" }, { fetch, playBuffer });
  await tick(80);
  assert.notEqual(readCard()?.line, "Slow provider line.", "no card while waiting on the API");
  assert.equal(isSpeaking(), false);
  assert.ok(fs.existsSync(P.lock), "the speaker lock is held, which is exactly why it can't drive the indicator");
  release();
  await p;
  assert.deepEqual(seen, [["playing", "speaking", true]], "the card flips to speaking right as audio starts");
  assert.equal(readCard().state, "spoken");
  assert.equal(isSpeaking(), false);
});

test("every voice failing shows a text card, not a 'spoken' one, and is not recorded as said", async () => {
  fs.rmSync(P.last, { force: true });
  const fetch = async () => new Response("nope", { status: 500 });
  const r = await speak("Nobody could say this.", "done", { agent: "codex" }, { fetch, playBuffer: () => {} });
  assert.equal(r.skipped, "voice_failed");
  assert.equal(r.failures.length, 2);
  const c = readCard();
  assert.equal(c.line, "Nobody could say this.");
  assert.equal(c.state, "silent");
  assert.equal(c.reason, "voice_failed");
  assert.equal(fs.existsSync(P.last), false, "a retry within 60s must not be suppressed as a duplicate");
  const log = fs.readFileSync(`${home}/log.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.skipped === "voice_failed"));
  assert.ok(!log.some((e) => e.spoke === "Nobody could say this."));
});

test("Stop pressed while the API is working: nothing plays and no card ever appears", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const fetch = async () => {
    await gate;
    return audio();
  };
  const played = [];
  const p = speak("Stopped before audio.", "done", { force: true }, { fetch, playBuffer: (b, ext) => played.push(ext) });
  await tick(60);
  stopSpeaking();
  release();
  const r = await p;
  assert.equal(r.skipped, "stopped");
  assert.deepEqual(played, []);
  assert.notEqual(readCard()?.line, "Stopped before audio.");
});

test("a 'speaking' card left behind by a dead process stops counting as speaking", () => {
  const at = Date.now();
  assert.equal(isSpeaking({ state: "speaking", at }), true);
  assert.equal(isSpeaking({ state: "speaking", at: at - SPEAKING_MAX_MS - 1 }), false);
  assert.equal(isSpeaking({ state: "spoken", at }), false);
  assert.equal(isSpeaking(null), false);
});
