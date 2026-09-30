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
