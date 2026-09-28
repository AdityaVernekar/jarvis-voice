#!/usr/bin/env node
// Jarvis voice — spoken pings for terminal coding agents.
// Zero dependencies. Node >= 20 (uses global fetch).
//
//   jarvis hook                 Claude Code hook entry (reads payload on stdin)
//   jarvis codex '<json>'       Codex CLI `notify` entry (payload as last arg)
//   jarvis run -- <cmd ...>     run any command, speak when a long one finishes
//   jarvis say "text" [--kind done|needs_input|error|info]
//   jarvis quiet [minutes]      only "needs input" pings (default 60 min)
//   jarvis off [minutes]        silence everything (default: until `on`)
//   jarvis on                   back to normal
//   jarvis status | test

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
  envFile: null, // path to a .env containing OPENAI_API_KEY
  ttsModel: "gpt-4o-mini-tts",
  voice: "onyx",
  voiceInstructions:
    "Calm, dry, quietly confident British butler. Brief and warm. Never excited.",
  summaryModel: "gpt-4o-mini",
  sayVoice: "Daniel", // macOS fallback voice
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
  return { ...DEFAULTS, ...readJson(P.config, {}) };
}
function which(bin) {
  return spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;
}
function apiKey(cfg) {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const files = [cfg.envFile, path.join(HOME, ".env")].filter(Boolean);
  for (const f of files) {
    try {
      for (const raw of fs.readFileSync(f, "utf8").split("\n")) {
        const m = raw.match(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*)\s*$/);
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

async function summarize(text, cfg) {
  const fallback = plainFirstSentence(text) || "Finished.";
  const key = apiKey(cfg);
  if (!key || DRY || !text) return { line: fallback, via: "first-sentence" };
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(cfg.summaryTimeoutMs),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.summaryModel,
        temperature: 0.3,
        max_tokens: 60,
        messages: [
          {
            role: "system",
            content:
              "You turn a coding agent's final message into ONE spoken sentence (max 18 words) for a developer who is away from the screen. Say what got done, and if the agent is asking something or hit a problem, say that. No file paths, code, IDs, URLs, markdown or lists. Plain spoken English.",
          },
          { role: "user", content: String(text).slice(-6000) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`summary HTTP ${res.status}`);
    const j = await res.json();
    const line = j.choices?.[0]?.message?.content?.trim();
    return line ? { line, via: "llm" } : { line: fallback, via: "first-sentence" };
  } catch (e) {
    log({ warn: "summary_failed", error: String(e.message || e) });
    return { line: fallback, via: "first-sentence" };
  }
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
function sayFallback(text, cfg) {
  if (!which("say")) return false;
  let r = spawnSync("say", ["-v", cfg.sayVoice, text], { stdio: "ignore" });
  if (r.status !== 0) r = spawnSync("say", [text], { stdio: "ignore" });
  return r.status === 0;
}

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
    let engine = "none";
    if (DRY) {
      engine = "dry-run";
    } else {
      if (cfg.chimes && CHIMES[kind] && fs.existsSync(CHIMES[kind])) play(CHIMES[kind]);
      try {
        await ttsOpenAI(line, cfg);
        engine = "openai";
      } catch (e) {
        log({ warn: "tts_failed", error: String(e.message || e) });
        engine = sayFallback(line, cfg) ? "say" : "none";
      }
    }
    writeJson(P.last, { line, at: now(), kind });
    log({ spoke: line, kind, engine, ...meta });
    if (DRY || process.env.JARVIS_ECHO === "1") process.stdout.write(`[jarvis:${engine}:${kind}] ${line}\n`);
    return { spoke: line, engine };
  });
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
    const { line, via } = await summarize(text, cfg);
    const r = await speak(`${project}. ${line}`, "done", { ...meta, via, secs: secs && Math.round(secs) });
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
      return speak(`${project} is waiting for you.`, "needs_input", meta);
    }
    const spoken = msg.replace(/^Claude\s+/i, "") || "needs your attention";
    return speak(`${project} ${spoken}`.replace(/\.*$/, "."), "needs_input", meta);
  }
}

// ---------- Codex CLI ----------
async function handleCodex(p) {
  if (p.type && p.type !== "agent-turn-complete") return;
  const cfg = config();
  const project = projectName(p.cwd || process.cwd());
  const text = p["last-assistant-message"] || p.last_assistant_message || "";
  const { line, via } = await summarize(text, cfg);
  const kind = /\?\s*$/.test(text.trim()) ? "needs_input" : "done";
  return speak(`${project}. ${line}`, kind, { src: "codex", project, via, thread: p["thread-id"] || p["turn-id"] });
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
      const ki = rest.indexOf("--kind");
      const kind = ki >= 0 ? rest[ki + 1] : "info";
      const words = ki >= 0 ? rest.filter((_, i) => i !== ki && i !== ki + 1) : rest;
      process.env.JARVIS_ECHO = "1";
      return speak(words.join(" "), kind, { src: "cli" });
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
        await speak(
          code === 0 ? `${project}. ${label} finished.` : `${project}. ${label} failed.`,
          code === 0 ? "done" : "error",
          { src: "run", code, secs: Math.round(secs) },
        );
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
      const logs = (fs.existsSync(P.log) ? fs.readFileSync(P.log, "utf8").trim().split("\n") : []).slice(-8);
      console.log(
        JSON.stringify(
          {
            mode: currentMode(),
            quietHoursNow: inQuietHours(cfg.quietHours),
            openaiKey: apiKey(cfg) ? "found" : "missing (falls back to macOS say)",
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
    case "test":
      process.env.JARVIS_ECHO = "1";
      return speak("Jarvis online. You'll hear from me when your agents finish or need you.", "done", { src: "test", force: true });
    default:
      console.log(fs.readFileSync(SELF, "utf8").split("\n").slice(1, 14).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).catch((e) => {
    log({ error: String(e.stack || e) });
    process.exitCode = 0; // never break the agent because of a voice problem
  });
}
