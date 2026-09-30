import assert from "node:assert/strict";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

tempHome({ quietHours: null, chimes: false, ttsProviders: ["smallest", "openai"] });
process.env.SMALLEST_API_KEY = "test-smallest";
process.env.OPENAI_API_KEY = "test-openai";
delete process.env.JARVIS_DRY_RUN; // exercise the engine chain with stubbed fetch and playback
const { speak } = await import("../src/voice/speak.mjs");
const { findVoice } = await import("../src/voice/engines/smallest.mjs");
const { config } = await import("../src/config.mjs");

const audio = (type) => new Response(Buffer.alloc(4000, 1), { status: 200, headers: { "content-type": type } });

test("smallest speaks when it returns audio", async () => {
  const calls = [];
  const played = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return audio("audio/wav");
  };
  const r = await speak("Hello there.", "done", { force: true, lang: "hi" }, { fetch, playBuffer: (b, ext) => played.push(ext) });
  assert.equal(r.engine, "smallest");
  assert.deepEqual(played, [".wav"]);
  assert.match(calls[0].url, /smallest\.ai\/waves\/v1\/tts$/);
  assert.equal(calls[0].body.voice_id, "meher");
  assert.equal(calls[0].body.language, "hi");
});

test("a Smallest 400 falls through to OpenAI and the key never reaches the log", async () => {
  const fetch = async (url) =>
    url.includes("smallest") ? new Response('{"error":"voice not found"}', { status: 400 }) : audio("audio/mpeg");
  const played = [];
  const r = await speak("Second line.", "done", { force: true }, { fetch, playBuffer: (b, ext) => played.push(ext) });
  assert.equal(r.engine, "openai");
  assert.match(r.failures[0], /smallest HTTP 400/);
  assert.deepEqual(played, [".mp3"]);
  const fs = await import("node:fs");
  const log = fs.readFileSync(`${process.env.JARVIS_HOME}/log.jsonl`, "utf8");
  assert.ok(!log.includes("test-smallest") && !log.includes("test-openai"));
});

test("every engine failing returns engine none", async () => {
  const fetch = async () => new Response("nope", { status: 500 });
  const r = await speak("Third line.", "done", { force: true }, { fetch, playBuffer: () => {} });
  assert.equal(r.engine, "none");
  assert.equal(r.failures.length, 2);
});

test("findVoice searches every catalog", async () => {
  const fetch = async (url) =>
    new Response(JSON.stringify({ voices: url.includes("pro") ? [] : [{ voiceId: "v1", tags: { gender: "female", language: ["Hindi"] } }] }), { status: 200 });
  const v = await findVoice(config(), "v1", fetch);
  assert.equal(v.model, "lightning_v3.1");
  assert.deepEqual(v.tags.language, ["hindi"]);
});

test("Stop mid-line doesn't fall through and replay the line on the next engine", async () => {
  const { stopSpeaking } = await import("../src/control.mjs");
  const played = [];
  const fetch = async () => audio("audio/wav");
  // The player is killed by Stop, which surfaces as a failed engine.
  const playBuffer = async (b, ext) => {
    played.push(ext);
    stopSpeaking();
    throw new Error("player exited 143");
  };
  const r = await speak("Stop me.", "done", { force: true }, { fetch, playBuffer });
  assert.equal(r.skipped, "stopped");
  assert.deepEqual(played, [".wav"], "OpenAI never ran");
});

test("playback is async: the event loop keeps running while a line plays", async () => {
  const { run } = await import("../src/voice/play.mjs");
  let ticks = 0;
  const t = setInterval(() => ticks++, 10);
  const ok = await run("sleep", ["0.3"]);
  clearInterval(t);
  assert.equal(ok, true);
  assert.ok(ticks >= 10, `timers ran during playback (${ticks})`);
});

test("summaryProvider none never calls an LLM", async () => {
  const { summarize } = await import("../src/summary/summarize.mjs");
  let called = 0;
  const s = await summarize("Shipped the new checkout. Tests pass.", { ...config(), summaryProvider: "none" }, { fetch: async () => (called++, audio("x")) });
  assert.equal(called, 0);
  assert.equal(s.via, "first-sentence");
  assert.equal(s.line, "Shipped the new checkout.");
});
