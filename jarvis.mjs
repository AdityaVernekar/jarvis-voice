#!/usr/bin/env node
// Jarvis voice — spoken pings for terminal coding agents.
// Zero dependencies. Node >= 20 (uses global fetch).
//
//   jarvis hook                 Claude Code hook entry (reads payload on stdin)
//   jarvis codex '<json>'       Codex CLI `notify` entry (payload as last arg)
//   jarvis run -- <cmd ...>     run any command, speak when a long one finishes
//   jarvis say "text" [--kind done|needs_input|error|info] [--provider smallest|openai|say] [--lang hi]
//   jarvis voices [--gender female] [--accent indian] [--lang hi] [--std]
//   jarvis voice <id>           pick a Smallest voice (checked against the catalog)
//   jarvis lang <code>          spoken language: en | hinglish | hi | ta | mr | …
//   jarvis quiet [minutes]      only "needs input" pings (default 60 min)
//   jarvis off [minutes]        silence everything (default: until `on`)
//   jarvis on                   back to normal
//   jarvis status | test [--provider smallest]

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const HOME = process.env.JARVIS_HOME || path.join(os.homedir(), ".jarvis-voice");
const DRY = process.env.JARVIS_DRY_RUN === "1";
const P = {
  config: path.join(HOME, "config.json"),
  mode: path.join(HOME, "mode.json"),
  last: path.join(HOME, "last-spoken.json"),
  log: path.join(HOME, "log.jsonl"),
  lock: path.join(HOME, "speak.lock"),
  sessions: path.join(HOME, "sessions"),
  tmp: path.join(HOME, "tmp"),
};

const DEFAULTS = {
  envFile: null, // path to a .env containing OPENAI_API_KEY / SMALLEST_API_KEY
  ttsProviders: ["smallest", "openai", "say"], // tried in order until one speaks
  smallest: { model: "lightning_v3.1_pro", voice: "meher", speed: 1.0, sampleRate: 24000 },
  smallestTimeoutMs: 8000,
  speakLanguage: "en", // en | hinglish | hi | ta | mr | … (summaries are written in this language)
  summaryProvider: "openai", // openai | smallest (Electron)
  ttsModel: "gpt-4o-mini-tts",
  voice: "nova", // OpenAI fallback voice (female)
  voiceInstructions:
    "Calm, warm, quietly confident assistant. Brief and clear. Never excited.",
  summaryModel: "gpt-4o-mini",
  sayVoice: "Samantha", // macOS last-resort voice (female; Hindi lines use Lekha)
  minTurnSeconds: 30, // Claude turns / `run` commands shorter than this stay silent
  maxChars: 200,
  quietHours: { start: "23:00", end: "08:00" }, // only needs_input gets through; null to disable
  chimes: true,
  ttsTimeoutMs: 15000,
  summaryTimeoutMs: 6000,
};

const CHIMES = {
  done: "/System/Library/Sounds/Glass.aiff",
  needs_input: "/System/Library/Sounds/Ping.aiff",
  error: "/System/Library/Sounds/Basso.aiff",
  info: null,
};

// ---------- small utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
function ensureDirs() {
  for (const d of [HOME, P.sessions, P.tmp]) fs.mkdirSync(d, { recursive: true });
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function log(event) {
  try {
    fs.appendFileSync(P.log, JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n");
  } catch {}
}
function config() {
  const user = readJson(P.config, {});
  return { ...DEFAULTS, ...user, smallest: { ...DEFAULTS.smallest, ...(user.smallest || {}) } };
}
function updateConfig(patch) {
  const cur = readJson(P.config, {});
  const next = { ...cur, ...patch };
  if (patch.smallest) next.smallest = { ...(cur.smallest || {}), ...patch.smallest };
  writeJson(P.config, next);
  return next;
}
function which(bin) {
  return spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;
}
function apiKey(cfg, name = "OPENAI_API_KEY") {
  if (process.env[name]) return process.env[name];
  const files = [cfg.envFile, path.join(HOME, ".env")].filter(Boolean);
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)\\s*$`);
  for (const f of files) {
    try {
      for (const raw of fs.readFileSync(f, "utf8").split("\n")) {
        const m = raw.match(re);
        if (m) return m[1].replace(/^['"]|['"]$/g, "").trim() || null;
      }
    } catch {}
  }
  return null;
}
function projectName(cwd) {
  if (!cwd) return "Terminal";
  return path.basename(cwd).replace(/[-_]+/g, " ").trim() || "Terminal";
}
function sessionFile(id) {
  return path.join(P.sessions, `${String(id).replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
}

// ---------- text shaping ----------
export function plainFirstSentence(text, max = 160) {
  let t = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[#>*\-+|]+\s*/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/(?:~|\.{1,2})?(?:\/[\w.@-]+){2,}\/?/g, (m) => path.basename(m)) // paths → file name
    .replace(/\s+/g, " ")
    .trim();
  const m = t.match(/^(.{12,}?[.!?])(\s|$)/);
  if (m) t = m[1];
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, "") + ".";
  return t;
}

// ---------- language ----------
const LANG_NAMES = {
  hi: "Hindi", mr: "Marathi", gu: "Gujarati", pa: "Punjabi", bn: "Bengali", or: "Odia",
  ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam", es: "Spanish", fr: "French",
  de: "German", it: "Italian", pt: "Portuguese", ru: "Russian", nl: "Dutch", pl: "Polish",
  ar: "Arabic", zh: "Mandarin Chinese", ja: "Japanese", ko: "Korean", id: "Indonesian",
  ms: "Malay", tr: "Turkish", vi: "Vietnamese", el: "Greek", fi: "Finnish", no: "Norwegian", sv: "Swedish",
};
// Which Unicode script a summary in that language must contain (catches the LLM answering in English/transliteration).
const SCRIPT = {
  hi: /[ऀ-ॿ]/, hinglish: /[ऀ-ॿ]/, mr: /[ऀ-ॿ]/, bn: /[ঀ-৿]/,
  or: /[଀-୿]/, gu: /[઀-૿]/, pa: /[਀-੿]/, ta: /[஀-௿]/,
  te: /[ఀ-౿]/, kn: /[ಀ-೿]/, ml: /[ഀ-ൿ]/, ar: /[؀-ۿ]/,
  ru: /[Ѐ-ӿ]/, el: /[Ͱ-Ͽ]/, zh: /[一-鿿]/, ja: /[぀-ヿ一-鿿]/, ko: /[가-힯]/,
};
function langInstruction(lang) {
  if (!lang || lang === "en") return "Plain spoken English.";
  if (lang === "hinglish")
    return 'Write natural spoken Hinglish, the way an Indian developer talks: Hindi grammar and everyday words in Devanagari script, with technical terms and product or project names kept in English (Latin script). Never write Hindi in Latin letters. Example: "cart drawer का refactor हो गया, सारे tests pass हैं, बस free-shipping bar पर आपका input चाहिए।"';
  const name = LANG_NAMES[lang] || lang;
  const ex = lang === "hi" ? ' Example: "कार्ट ड्रॉअर का काम पूरा हो गया, सारे टेस्ट पास हैं।"' : "";
  return `Write it in simple spoken ${name} using its native script, never Latin transliteration. Keep product names and project names in English.${ex}`;
}
// Language code Smallest's TTS expects for a given speakLanguage.
const ttsLang = (lang) => (lang === "hinglish" ? "hi" : lang || "en");

// Fixed phrases, so non-summary pings match the chosen language too.
const PHRASES = {
  en: {
    waiting: (p) => `${p} is waiting for you.`,
    permission: (p, tool) => `${p} needs your permission to use ${tool}.`,
    attention: (p, msg) => `${p} ${msg}`.replace(/\.*$/, "."),
    runOk: (p, l) => `${p}. ${l} finished.`,
    runFail: (p, l) => `${p}. ${l} failed.`,
    test: "Jarvis online. You'll hear from me when your agents finish or need you.",
  },
  hinglish: {
    waiting: (p) => `${p} आपका wait कर रहा है।`,
    permission: (p, tool) => `${p} को ${tool} use करने की permission चाहिए।`,
    attention: (p) => `${p} को आपकी ज़रूरत है।`,
    runOk: (p, l) => `${p}. ${l} finish हो गया।`,
    runFail: (p, l) => `${p}. ${l} fail हो गया।`,
    test: "Jarvis online है। जब भी आपके agents का काम पूरा होगा या उन्हें आपकी ज़रूरत होगी, मैं बता दूँगी।",
  },
  hi: {
    waiting: (p) => `${p} आपका इंतज़ार कर रहा है।`,
    permission: (p, tool) => `${p} को ${tool} इस्तेमाल करने की अनुमति चाहिए।`,
    attention: (p) => `${p} को आपकी ज़रूरत है।`,
    runOk: (p, l) => `${p}. ${l} पूरा हो गया।`,
    runFail: (p, l) => `${p}. ${l} विफल हो गया।`,
    test: "जार्विस तैयार है। जब आपके एजेंट का काम पूरा होगा या उन्हें आपकी ज़रूरत होगी, मैं बता दूँगी।",
  },
};
function phrase(cfg, name, ...args) {
  const lang = PHRASES[cfg.speakLanguage] ? cfg.speakLanguage : "en";
  const v = PHRASES[lang][name];
  return { text: typeof v === "function" ? v(...args) : v, lang };
}

const LLMS = {
  openai: { url: "https://api.openai.com/v1/chat/completions", key: "OPENAI_API_KEY", model: (cfg) => cfg.summaryModel },
  smallest: { url: "https://api.smallest.ai/waves/v1/chat/completions", key: "SMALLEST_API_KEY", model: () => "electron" },
};
async function chat(provider, cfg, messages) {
  const p = LLMS[provider];
  const key = p && apiKey(cfg, p.key);
  if (!key) throw new Error(`no ${p ? p.key : provider}`);
  const res = await fetch(p.url, {
    method: "POST",
    signal: AbortSignal.timeout(cfg.summaryTimeoutMs),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: p.model(cfg), temperature: 0.3, max_tokens: 160, messages }),
  });
  // Electron answers 403 "not available for your plan" on the base Smallest plan.
  if (!res.ok) throw new Error(`${provider} summary HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const j = await res.json();
  return (j.choices?.[0]?.message?.content || "").trim().replace(/^["“]|["”]$/g, "");
}
async function summarize(text, cfg) {
  const fallback = { line: plainFirstSentence(text) || "Finished.", via: "first-sentence", lang: "en" };
  if (DRY || !text) return fallback;
  const lang = cfg.speakLanguage || "en";
  const order = [...new Set([cfg.summaryProvider, "openai"])].filter((n) => LLMS[n]);
  const system =
    "You turn a coding agent's final message into ONE spoken sentence (max 18 words) for a developer who is away from the screen. Say what got done, and if the agent is asking something or hit a problem, say that. No file paths, code, IDs, URLs, markdown or lists. " +
    langInstruction(lang);
  for (const provider of order) {
    try {
      let line = await chat(provider, cfg, [
        { role: "system", content: system },
        { role: "user", content: String(text).slice(-6000) },
      ]);
      if (!line) continue;
      if (SCRIPT[lang] && !SCRIPT[lang].test(line)) {
        // Small models often answer in romanised Hindi. Ask once for a script rewrite.
        log({ warn: "summary_wrong_script", lang, provider, line });
        const fixed = await chat(provider, cfg, [
          { role: "system", content: `Rewrite the sentence exactly in meaning. ${langInstruction(lang)} Output only the sentence.` },
          { role: "user", content: line },
        ]).catch(() => "");
        if (fixed && SCRIPT[lang].test(fixed)) return { line: fixed, via: `${provider}+rewrite`, lang };
        return { line, via: provider, lang: "en" }; // speak romanised text as English rather than garble it
      }
      return { line, via: provider, lang };
    } catch (e) {
      log({ warn: "summary_failed", provider, error: String(e.message || e) });
    }
  }
  return fallback;
}

// ---------- policy ----------
function inQuietHours(qh, d = new Date()) {
  if (!qh?.start || !qh?.end) return false;
  const mins = (s) => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + (m || 0);
  };
  const cur = d.getHours() * 60 + d.getMinutes();
  const a = mins(qh.start), b = mins(qh.end);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}
function currentMode() {
  const m = readJson(P.mode, { mode: "on" });
  if (m.until && now() > m.until) return "on";
  return m.mode || "on";
}
function policyBlock(kind, cfg) {
  const mode = currentMode();
  if (mode === "off") return "mode_off";
  if (mode === "quiet" && kind !== "needs_input" && kind !== "error") return "mode_quiet";
  if (inQuietHours(cfg.quietHours) && kind !== "needs_input") return "quiet_hours";
  return null;
}

// ---------- cross-process lock so sessions never talk over each other ----------
async function withLock(fn) {
  const deadline = now() + 60_000;
  for (;;) {
    try {
      fs.mkdirSync(P.lock);
      break;
    } catch {
      try {
        if (now() - fs.statSync(P.lock).mtimeMs > 45_000) fs.rmSync(P.lock, { recursive: true, force: true });
      } catch {}
      if (now() > deadline) throw new Error("lock timeout");
      await sleep(200);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(P.lock, { recursive: true, force: true });
  }
}

// ---------- audio ----------
function play(file) {
  return spawnSync("afplay", [file], { stdio: "ignore" }).status === 0;
}
async function ttsOpenAI(text, cfg) {
  const key = apiKey(cfg);
  if (!key) throw new Error("no OPENAI_API_KEY");
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    signal: AbortSignal.timeout(cfg.ttsTimeoutMs),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.ttsModel,
      voice: cfg.voice,
      input: text,
      instructions: cfg.voiceInstructions,
      response_format: "mp3",
    }),
  });
  if (!res.ok) throw new Error(`tts HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const file = path.join(P.tmp, `say-${process.pid}-${now()}.mp3`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  try {
    if (!play(file)) throw new Error("afplay failed");
  } finally {
    fs.rmSync(file, { force: true });
  }
}
async function ttsSmallest(text, cfg, lang) {
  const key = apiKey(cfg, "SMALLEST_API_KEY");
  if (!key) throw new Error("no SMALLEST_API_KEY");
  const s = cfg.smallest;
  const res = await fetch("https://api.smallest.ai/waves/v1/tts", {
    method: "POST",
    signal: AbortSignal.timeout(cfg.smallestTimeoutMs),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "audio/wav" },
    body: JSON.stringify({
      text,
      voice_id: s.voice,
      model: s.model,
      language: ttsLang(lang),
      speed: s.speed,
      sample_rate: s.sampleRate,
      output_format: "wav",
    }),
  });
  // 400 = bad voice/model pairing, 401 = bad key, 403 = usage limit, 429 = another TTS call in flight on this account.
  if (!res.ok) throw new Error(`smallest HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!/audio/.test(res.headers.get("content-type") || "") || buf.length < 2000)
    throw new Error(`smallest returned no audio (${buf.length} bytes, ${res.headers.get("content-type")})`);
  const file = path.join(P.tmp, `say-${process.pid}-${now()}.wav`);
  fs.writeFileSync(file, buf);
  try {
    if (!play(file)) throw new Error("afplay failed");
  } finally {
    fs.rmSync(file, { force: true });
  }
}
function sayFallback(text, cfg, lang) {
  if (!which("say")) throw new Error("no say binary");
  const voice = lang && lang !== "en" && /^(hi|hinglish)$/.test(lang) ? "Lekha" : cfg.sayVoice;
  let r = spawnSync("say", ["-v", voice, text], { stdio: "ignore" });
  if (r.status !== 0) r = spawnSync("say", [text], { stdio: "ignore" });
  if (r.status !== 0) throw new Error("say failed");
}
const ENGINES = {
  smallest: ttsSmallest,
  openai: (text, cfg) => ttsOpenAI(text, cfg),
  say: async (text, cfg, lang) => sayFallback(text, cfg, lang),
};

export async function speak(text, kind = "info", meta = {}) {
  ensureDirs();
  const cfg = config();
  let line = String(text || "").replace(/\s+/g, " ").trim();
  if (!line) return { skipped: "empty" };
  if (line.length > cfg.maxChars) line = plainFirstSentence(line, cfg.maxChars);

  const blocked = policyBlock(kind, cfg);
  if (blocked) {
    log({ skipped: blocked, kind, line, ...meta });
    if (process.env.JARVIS_ECHO === "1") process.stdout.write(`[jarvis:skipped:${blocked}] (jarvis on to reset)\n`);
    return { skipped: blocked };
  }

  return withLock(async () => {
    const last = readJson(P.last, {});
    if (!meta.force && last.line === line && now() - (last.at || 0) < 60_000) {
      log({ skipped: "duplicate", kind, line, ...meta });
      if (process.env.JARVIS_ECHO === "1") process.stdout.write(`[jarvis:skipped:duplicate] said this <60s ago\n`);
      return { skipped: "duplicate" };
    }
    const lang = meta.lang || "en";
    const providers = meta.provider ? [meta.provider] : cfg.ttsProviders;
    let engine = "none";
    let ms = null;
    const failures = [];
    if (DRY) {
      engine = "dry-run";
    } else {
      if (cfg.chimes && CHIMES[kind] && fs.existsSync(CHIMES[kind])) play(CHIMES[kind]);
      for (const name of providers) {
        const fn = ENGINES[name];
        if (!fn) continue;
        const t0 = now();
        try {
          await fn(line, cfg, lang);
          engine = name;
          ms = now() - t0; // includes playback
          break;
        } catch (e) {
          const error = String(e.message || e);
          failures.push(`${name}: ${error}`);
          log({ warn: "tts_failed", engine: name, error });
        }
      }
    }
    writeJson(P.last, { line, at: now(), kind });
    const { provider, ...rest } = meta;
    log({ spoke: line, kind, engine, lang, ms, ...rest });
    if (DRY || process.env.JARVIS_ECHO === "1") {
      for (const f of failures) process.stdout.write(`[jarvis:fallback] ${f}\n`);
      process.stdout.write(`[jarvis:${engine}:${kind}] ${line}\n`);
    }
    return { spoke: line, engine, ms, failures };
  });
}

// ---------- CLI helpers ----------
function parseFlags(args, names) {
  const flags = {};
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const m = /^--([\w-]+)$/.exec(args[i]);
    if (m && names.includes(m[1])) flags[m[1]] = args[++i];
    else if (m) flags[m[1]] = true;
    else words.push(args[i]);
  }
  return { flags, words };
}
const VOICE_LISTS = { lightning_v3_1_pro: "lightning-v3.1-pro", "lightning_v3.1_pro": "lightning-v3.1-pro", "lightning_v3.1": "lightning-v3.1" };
async function fetchVoices(cfg, model) {
  const key = apiKey(cfg, "SMALLEST_API_KEY");
  if (!key) throw new Error("no SMALLEST_API_KEY (add it to the repo .env)");
  // The Pro list lives on an undocumented route; the documented v3.1 list does not include Pro voices.
  const res = await fetch(`https://api.smallest.ai/waves/v1/${VOICE_LISTS[model] || "lightning-v3.1"}/get_voices`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`get_voices HTTP ${res.status}`);
  const j = await res.json();
  return (j.voices || []).map((v) => ({
    voiceId: v.voiceId,
    name: v.displayName || v.voiceId,
    model,
    tags: {
      gender: v.tags?.gender || "",
      accent: v.tags?.accent || "",
      age: v.tags?.age || "",
      language: (v.tags?.language || []).map((l) => String(l).toLowerCase()),
    },
  }));
}
async function listVoices(args) {
  const { flags } = parseFlags(args, ["lang", "gender", "accent"]);
  const cfg = config();
  const model = flags.std ? "lightning_v3.1" : "lightning_v3.1_pro";
  let vs = await fetchVoices(cfg, model);
  if (flags.lang) {
    const want = (LANG_NAMES[flags.lang === "hinglish" ? "hi" : flags.lang] || flags.lang).toLowerCase();
    vs = vs.filter((v) => v.tags.language.includes(want));
  }
  if (flags.gender) vs = vs.filter((v) => v.tags.gender.toLowerCase() === String(flags.gender).toLowerCase());
  if (flags.accent) vs = vs.filter((v) => v.tags.accent.toLowerCase().includes(String(flags.accent).toLowerCase()));
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);
  console.log(`${model}: ${vs.length} voices${vs.length ? "" : " (try without filters, or --std)"}\n`);
  console.log(pad("id", 14) + pad("gender", 8) + pad("accent", 12) + pad("age", 12) + "languages");
  for (const v of vs)
    console.log(
      (v.voiceId === cfg.smallest.voice ? "*" : " ") + pad(v.voiceId, 13) + pad(v.tags.gender, 8) + pad(v.tags.accent, 12) + pad(v.tags.age, 12) + v.tags.language.join(", "),
    );
  console.log(`\n* = current. Set with: jarvis voice <id>`);
}
async function setVoice(id) {
  const cfg = config();
  if (!id) return console.log(`voice: ${cfg.smallest.voice} (${cfg.smallest.model})`);
  for (const model of ["lightning_v3.1_pro", "lightning_v3.1"]) {
    const v = (await fetchVoices(cfg, model)).find((x) => x.voiceId === id);
    if (v) {
      updateConfig({ smallest: { ...cfg.smallest, voice: id, model } });
      console.log(`jarvis: voice → ${id} (${model}; ${v.tags.gender} ${v.tags.accent}; ${v.tags.language.join(", ")})`);
      console.log("  hear it: jarvis test");
      return;
    }
  }
  process.exitCode = 1;
  console.error(`jarvis: no Smallest voice "${id}". See: jarvis voices --gender female`);
}

// ---------- Claude Code ----------
function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return "";
  let buf;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
  } catch {
    return "";
  }
  const lines = buf.toString("utf8").split("\n").reverse();
  for (const l of lines) {
    if (!l.trim()) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    const msg = o.message || o;
    if ((o.type === "assistant" || msg.role === "assistant") && msg.content) {
      const text = Array.isArray(msg.content)
        ? msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
        : String(msg.content);
      if (text.trim()) return text;
    }
  }
  return "";
}

async function handleClaude(p) {
  const cfg = config();
  const sid = p.session_id || "unknown";
  const sf = sessionFile(sid);
  const s = readJson(sf, {});
  const project = projectName(p.cwd);
  const meta = { src: "claude", session: sid, project };

  if (p.hook_event_name === "Stop" || p.hook_event_name === "SubagentStop") {
    if (p.hook_event_name === "SubagentStop" || p.stop_hook_active) return;
    const secs = s.turnStart ? (now() - s.turnStart) / 1000 : null;
    writeJson(sf, { ...s, turnStart: null, lastStop: now() });
    if (secs !== null && secs < cfg.minTurnSeconds) {
      log({ skipped: "short_turn", secs: Math.round(secs), ...meta });
      return;
    }
    let text = p.last_assistant_message || lastAssistantText(p.transcript_path);
    if (!text) {
      await sleep(400); // transcript can lag the Stop event slightly
      text = lastAssistantText(p.transcript_path);
    }
    const { line, via, lang } = await summarize(text, cfg);
    const r = await speak(`${project}. ${line}`, "done", { ...meta, via, lang, secs: secs && Math.round(secs) });
    if (r.spoke) writeJson(sf, { ...readJson(sf, {}), spokeAfterStop: true });
    return;
  }

  if (p.hook_event_name === "Notification") {
    const msg = String(p.message || "").trim();
    const type = p.notification_type || "";
    const isIdle = type === "idle_prompt" || /waiting for your input/i.test(msg);
    if (isIdle) {
      // If we already announced the finished turn, the idle nag adds nothing.
      if (s.spokeAfterStop) return log({ skipped: "idle_after_done", ...meta });
      writeJson(sf, { ...s, spokeAfterStop: true });
      const w = phrase(cfg, "waiting", project);
      return speak(w.text, "needs_input", { ...meta, lang: w.lang });
    }
    const perm = msg.match(/permission to use (.+?)\.?$/i);
    const ph = perm
      ? phrase(cfg, "permission", project, perm[1])
      : phrase(cfg, "attention", project, msg.replace(/^Claude\s+/i, "") || "needs your attention");
    return speak(ph.text, "needs_input", { ...meta, lang: ph.lang });
  }
}

// ---------- Codex CLI ----------
async function handleCodex(p) {
  if (p.type && p.type !== "agent-turn-complete") return;
  const cfg = config();
  const project = projectName(p.cwd || process.cwd());
  const text = p["last-assistant-message"] || p.last_assistant_message || "";
  const { line, via, lang } = await summarize(text, cfg);
  const kind = /\?\s*$/.test(text.trim()) ? "needs_input" : "done";
  return speak(`${project}. ${line}`, kind, { src: "codex", project, via, lang, thread: p["thread-id"] || p["turn-id"] });
}

// ---------- detach so hooks never slow the agent down ----------
function detach(kindTag, payload) {
  ensureDirs();
  const file = path.join(P.tmp, `job-${process.pid}-${now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ kindTag, payload }));
  if (process.env.JARVIS_FOREGROUND === "1") return runJob(file);
  spawn(process.execPath, [SELF, "_worker", file], { detached: true, stdio: "ignore", env: process.env }).unref();
}
async function runJob(file) {
  const { kindTag, payload } = readJson(file, {});
  fs.rmSync(file, { force: true });
  try {
    if (kindTag === "claude") await handleClaude(payload);
    else if (kindTag === "codex") await handleCodex(payload);
  } catch (e) {
    log({ error: String(e.stack || e) });
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

// ---------- CLI ----------
async function main(argv) {
  ensureDirs();
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "hook": {
      let p = {};
      try {
        p = JSON.parse((await readStdin()) || "{}");
      } catch {}
      if (p.hook_event_name === "UserPromptSubmit") {
        const sf = sessionFile(p.session_id || "unknown");
        writeJson(sf, { ...readJson(sf, {}), turnStart: now(), spokeAfterStop: false });
        return;
      }
      if (["Stop", "Notification"].includes(p.hook_event_name)) detach("claude", p);
      return;
    }
    case "codex": {
      const raw = rest[rest.length - 1] || "{}";
      let p = {};
      try {
        p = JSON.parse(raw);
      } catch {}
      // Forward to the user's original Codex notify command, if the installer chained one.
      const chain = config().codexChain;
      if (Array.isArray(chain) && chain.length && !chain.some((a) => String(a).includes("jarvis.mjs"))) {
        try {
          spawn(chain[0], [...chain.slice(1), raw], { detached: true, stdio: "ignore" })
            .on("error", (e) => log({ warn: "codex_chain_failed", error: String(e.message || e) }))
            .unref();
        } catch (e) {
          log({ warn: "codex_chain_failed", error: String(e.message || e) });
        }
      }
      return detach("codex", p);
    }
    case "_worker":
      return runJob(rest[0]);
    case "say": {
      const { flags, words } = parseFlags(rest, ["kind", "provider", "lang"]);
      process.env.JARVIS_ECHO = "1";
      const lang = flags.lang || (/[^\x00-\x7F]/.test(words.join(" ")) ? config().speakLanguage : "en");
      return speak(words.join(" "), flags.kind || "info", { src: "cli", provider: flags.provider, lang });
    }
    case "voices":
      return listVoices(rest);
    case "voice":
      return setVoice(rest[0]);
    case "lang": {
      const code = (rest[0] || "").toLowerCase();
      if (!code) return console.log(`speakLanguage: ${config().speakLanguage}   (en | hinglish | hi | ta | mr | kn | …)`);
      if (code !== "en" && code !== "hinglish" && !LANG_NAMES[code])
        return console.error(`jarvis: unknown language "${code}". Try en, hinglish, hi, ta, te, kn, ml, mr, gu, bn, pa, or, es, fr, de …`);
      updateConfig({ speakLanguage: code });
      const cfg = config();
      console.log(`jarvis: summaries now spoken in ${code === "hinglish" ? "Hinglish" : LANG_NAMES[code] || "English"}`);
      if (code !== "en" && code !== "hinglish") {
        const v = (await fetchVoices(cfg, cfg.smallest.model).catch(() => [])).find((x) => x.voiceId === cfg.smallest.voice);
        const want = (LANG_NAMES[code] || "").toLowerCase();
        if (v && want && !v.tags.language.includes(want))
          console.log(`  ! voice "${cfg.smallest.voice}" isn't trained on ${LANG_NAMES[code]}. Pick one: jarvis voices --lang ${code}`);
      }
      return;
    }
    case "run": {
      const args = rest[0] === "--" ? rest.slice(1) : rest;
      if (!args.length) return console.error("usage: jarvis run -- <command ...>");
      const cfg = config();
      const start = now();
      const r = spawnSync(args[0], args.slice(1), { stdio: "inherit" });
      const secs = (now() - start) / 1000;
      const code = r.status ?? 1;
      if (secs >= cfg.minTurnSeconds) {
        const label = args.slice(0, 2).map((a) => path.basename(a)).join(" ");
        const project = projectName(process.cwd());
        const ph = phrase(cfg, code === 0 ? "runOk" : "runFail", project, label);
        await speak(ph.text, code === 0 ? "done" : "error", { src: "run", code, secs: Math.round(secs), lang: ph.lang });
      }
      process.exitCode = code;
      return;
    }
    case "quiet":
    case "off": {
      const mins = Number(rest[0]) || (cmd === "quiet" ? 60 : 0);
      writeJson(P.mode, { mode: cmd, until: mins ? now() + mins * 60_000 : null });
      return console.log(`jarvis: ${cmd}${mins ? ` for ${mins} min` : " until `jarvis on`"}`);
    }
    case "on":
      writeJson(P.mode, { mode: "on" });
      return console.log("jarvis: on");
    case "status": {
      const cfg = config();
      const all = fs.existsSync(P.log) ? fs.readFileSync(P.log, "utf8").trim().split("\n") : [];
      const logs = all.slice(-8);
      const lastSpoke = all.map((l) => { try { return JSON.parse(l); } catch { return {}; } }).reverse().find((e) => e.spoke);
      console.log(
        JSON.stringify(
          {
            mode: currentMode(),
            quietHoursNow: inQuietHours(cfg.quietHours),
            providers: cfg.ttsProviders.join(" → "),
            smallestKey: apiKey(cfg, "SMALLEST_API_KEY") ? "found" : "missing",
            smallestVoice: `${cfg.smallest.voice} (${cfg.smallest.model})`,
            speakLanguage: cfg.speakLanguage,
            summaryProvider: cfg.summaryProvider,
            openaiKey: apiKey(cfg) ? "found" : "missing",
            lastEngine: lastSpoke ? `${lastSpoke.engine}${lastSpoke.ms ? ` (${lastSpoke.ms} ms)` : ""}` : null,
            afplay: which("afplay"),
            say: which("say"),
            home: HOME,
          },
          null,
          2,
        ),
      );
      console.log("\nlast events:\n" + logs.join("\n"));
      return;
    }
    case "test": {
      const { flags } = parseFlags(rest, ["provider"]);
      process.env.JARVIS_ECHO = "1";
      const ph = phrase(config(), "test");
      const r = await speak(ph.text, "done", { src: "test", force: true, provider: flags.provider, lang: ph.lang });
      if (r.ms) console.log(`  (${r.engine}, ${(r.ms / 1000).toFixed(1)} s including playback)`);
      if (r.engine === "none") process.exitCode = 1;
      return;
    }
    default:
      console.log(fs.readFileSync(SELF, "utf8").split("\n").slice(1, 15).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).catch((e) => {
    log({ error: String(e.stack || e) });
    process.exitCode = 0; // never break the agent because of a voice problem
  });
}
