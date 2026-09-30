// Command-line interface. Every entry point (bin/jarvis.mjs, the legacy ./jarvis.mjs,
// ./install.mjs) ends up in main().
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getAdapter, listAdapters } from "../adapters/index.mjs";
import { agentConfig, apiKey, config, updateConfig } from "../config.mjs";
import { EVENT_TYPES, normalizeEvent } from "../hub/events.mjs";
import { ingest, ingestEvent, runWorker } from "../hub/hub.mjs";
import { listSessions } from "../hub/sessions.mjs";
import { isKnownLang, LANG_NAMES, langLabel, phrase } from "../i18n.mjs";
import { BIN, HOME, P, ROOT } from "../paths.mjs";
import { currentMode, inQuietHours, setMode } from "../policy.mjs";
import { ago, ensureDirs, log, now, parseFlags, projectName, readJson, which } from "../util.mjs";
import { listEngines } from "../voice/engines/index.mjs";
import { fetchVoices, findVoice } from "../voice/engines/smallest.mjs";
import { speak } from "../voice/speak.mjs";

const pkg = readJson(path.join(ROOT, "package.json"), {});

export const HELP = `jarvis-voice ${pkg.version || ""} — spoken pings for terminal coding agents

Setup
  jarvis install [--only claude-code,codex] [--chain] [--env path/.env]
  jarvis uninstall
  jarvis test [--provider smallest|openai|say] [--agent id]

Agents
  jarvis agents [--all] [--json]      every agent session Jarvis has seen, and its state
  jarvis emit --agent <id> --type <type> [--session s] [--project p] [--tool t] [--message m] [--wait] [text…]
                                      send an event from any tool (JSON on stdin also works);
                                      returns at once unless run in a terminal or with --wait
                                      types: ${EVENT_TYPES.join(", ")}
  jarvis run -- <cmd …>               run a command, speak when a long one finishes

Voice
  jarvis say "text" [--kind done|needs_input|error|info] [--provider id] [--lang code]
  jarvis voices [--gender female] [--accent indian] [--lang hi] [--std]
  jarvis voice <id> [--agent id]      pick a Smallest voice (globally or for one agent)
  jarvis lang <code>                  en | hinglish | hi | ta | mr | es | …

Control
  jarvis quiet [minutes]              only "needs you" pings (default 60 min)
  jarvis off [minutes]                silence everything (default: until \`on\`)
  jarvis on
  jarvis stop                         stop talking now and drop every queued line
  jarvis status

Agent entry points (written by \`jarvis install\`)
  jarvis hook [adapter]               Claude Code hooks (payload on stdin)
  jarvis codex '<json>'               Codex CLI notify (payload as last argument)
`;

// Hooks pipe a small payload and close stdin. The timeout covers callers that leave it open.
async function readStdin(timeoutMs = 3000) {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let data = "";
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

const parseJson = (s) => {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
};

const pad = (s, n) => String(s ?? "").slice(0, n - 1).padEnd(n);

// ---------- commands ----------

async function cmdEmit(rest) {
  const { flags, words } = parseFlags(rest, ["agent", "type", "session", "project", "tool", "message", "line", "cwd", "duration"]);
  let ev = {};
  if (!process.stdin.isTTY && !flags.type) ev = parseJson(await readStdin(1000));
  const agent = flags.agent || ev.agent || "cli";
  ev = {
    ...ev,
    agent,
    type: flags.type || ev.type || "info",
    cwd: flags.cwd || ev.cwd || process.cwd(),
    ...(flags.session ? { session: flags.session } : {}),
    ...(flags.project ? { project: flags.project } : {}),
    ...(flags.tool ? { tool: flags.tool } : {}),
    ...(flags.message ? { message: flags.message } : {}),
    ...(flags.line ? { line: flags.line } : {}),
    ...(flags.duration ? { durationMs: Number(flags.duration) * 1000 } : {}),
  };
  if (words.length) ev.text = words.join(" ");
  if (!EVENT_TYPES.includes(ev.type)) {
    process.exitCode = 2;
    return console.error(`jarvis: unknown --type "${ev.type}" (expected ${EVENT_TYPES.join(", ")})`);
  }
  // `emit` takes hub-shaped events (no adapter translation), even for agents that have an adapter.
  // From a terminal it waits and prints the line; from a hook or script it hands off to the
  // background worker and returns at once. --wait / --background override.
  const interactive = Boolean(process.stdout.isTTY);
  if (interactive) process.env.JARVIS_ECHO = "1";
  const foreground = flags.wait ? true : flags.background ? false : interactive || process.env.JARVIS_FOREGROUND === "1";
  return ingestEvent(normalizeEvent(ev, agent), { foreground });
}

async function cmdRun(rest) {
  const args = rest[0] === "--" ? rest.slice(1) : rest;
  if (!args.length) return console.error("usage: jarvis run -- <command …>");
  const cfg = agentConfig(config(), "run");
  const start = now();
  const r = spawnSync(args[0], args.slice(1), { stdio: "inherit" });
  const durationMs = now() - start;
  const code = r.status ?? 1;
  const label = args.slice(0, 2).map((a) => path.basename(a)).join(" ");
  const project = projectName(process.cwd());
  const ph = phrase(cfg, code === 0 ? "runOk" : "runFail", project, label);
  if (durationMs >= cfg.minTurnSeconds * 1000) {
    if (process.stdout.isTTY) process.env.JARVIS_ECHO = "1";
    await ingestEvent(normalizeEvent({
      agent: "run",
      type: code === 0 ? "turn_end" : "error",
      session: `${project}:${label}`,
      project,
      cwd: process.cwd(),
      line: ph.text,
      lang: ph.lang,
      durationMs,
    }), { foreground: true });
  }
  process.exitCode = code;
}

async function cmdVoices(rest) {
  const { flags } = parseFlags(rest, ["lang", "gender", "accent"]);
  const cfg = config();
  const model = flags.std ? "lightning_v3.1" : "lightning_v3.1_pro";
  let vs = await fetchVoices(cfg, model);
  if (flags.lang) {
    const want = (LANG_NAMES[flags.lang === "hinglish" ? "hi" : flags.lang] || flags.lang).toLowerCase();
    vs = vs.filter((v) => v.tags.language.includes(want));
  }
  if (flags.gender) vs = vs.filter((v) => v.tags.gender.toLowerCase() === String(flags.gender).toLowerCase());
  if (flags.accent) vs = vs.filter((v) => v.tags.accent.toLowerCase().includes(String(flags.accent).toLowerCase()));
  console.log(`${model}: ${vs.length} voices${vs.length ? "" : " (try without filters, or --std)"}\n`);
  console.log(" " + pad("id", 13) + pad("gender", 8) + pad("accent", 12) + pad("age", 12) + "languages");
  for (const v of vs)
    console.log(
      (v.voiceId === cfg.smallest.voice ? "*" : " ") + pad(v.voiceId, 13) + pad(v.tags.gender, 8) + pad(v.tags.accent, 12) + pad(v.tags.age, 12) + v.tags.language.join(", "),
    );
  console.log(`\n* = current. Set with: jarvis voice <id> [--agent codex]`);
}

async function cmdVoice(rest) {
  const { flags, words } = parseFlags(rest, ["agent"]);
  const id = words[0];
  const cfg = config();
  if (!id) {
    console.log(`voice: ${cfg.smallest.voice} (${cfg.smallest.model})`);
    for (const [a, o] of Object.entries(cfg.agents)) if (o.voice) console.log(`  ${a}: ${o.voice}${o.model ? ` (${o.model})` : ""}`);
    return;
  }
  const v = await findVoice(cfg, id);
  if (!v) {
    process.exitCode = 1;
    return console.error(`jarvis: no Smallest voice "${id}". See: jarvis voices --gender female`);
  }
  if (flags.agent) updateConfig({ agents: { [flags.agent]: { ...(cfg.agents[flags.agent] || {}), voice: id, model: v.model } } });
  else updateConfig({ smallest: { ...cfg.smallest, voice: id, model: v.model } });
  console.log(`jarvis: ${flags.agent ? `${flags.agent} voice` : "voice"} → ${id} (${v.model}; ${v.tags.gender} ${v.tags.accent}; ${v.tags.language.join(", ")})`);
  console.log(`  hear it: jarvis test${flags.agent ? ` --agent ${flags.agent}` : ""}`);
}

async function cmdLang(rest) {
  const code = (rest[0] || "").toLowerCase();
  if (!code) return console.log(`speakLanguage: ${config().speakLanguage}   (en | hinglish | hi | ta | mr | kn | …)`);
  if (!isKnownLang(code)) {
    process.exitCode = 1;
    return console.error(`jarvis: unknown language "${code}". Try en, hinglish, hi, ta, te, kn, ml, mr, gu, bn, pa, or, es, fr, de …`);
  }
  updateConfig({ speakLanguage: code });
  const cfg = config();
  console.log(`jarvis: summaries now spoken in ${langLabel(code)}`);
  if (code !== "en" && code !== "hinglish" && apiKey(cfg, "SMALLEST_API_KEY")) {
    const v = (await fetchVoices(cfg, cfg.smallest.model).catch(() => [])).find((x) => x.voiceId === cfg.smallest.voice);
    const want = (LANG_NAMES[code] || "").toLowerCase();
    if (v && want && !v.tags.language.includes(want))
      console.log(`  ! voice "${cfg.smallest.voice}" isn't trained on ${LANG_NAMES[code]}. Pick one: jarvis voices --lang ${code}`);
  }
}

function cmdAgents(rest) {
  const { flags } = parseFlags(rest, []);
  const sessions = listSessions({ sinceMs: flags.all ? null : 24 * 3600_000 });
  if (flags.json) return console.log(JSON.stringify(sessions, null, 2));
  if (!sessions.length)
    return console.log(`No agent activity${flags.all ? "" : " in the last 24 h"}. Run \`jarvis install\`, then start Claude Code or Codex.`);
  const icon = { working: "●", waiting: "◆", done: "✓", error: "✗", idle: "○" };
  console.log(pad("STATUS", 10) + pad("AGENT", 14) + pad("PROJECT", 22) + pad("AGE", 6) + "LAST");
  for (const s of sessions) {
    const name = agentConfig(config(), s.agent).label || getAdapter(s.agent).name;
    const st = s.status || "idle";
    console.log(
      pad(`${icon[st] || " "} ${st}`, 10) + pad(name, 14) + pad(s.project || projectName(s.cwd), 22) + pad(ago(now() - (s.updated || 0)), 6) + (s.lastLine || "").slice(0, 70),
    );
  }
  const waiting = sessions.filter((s) => s.status === "waiting").length;
  const working = sessions.filter((s) => s.status === "working").length;
  console.log(`\n${working} working, ${waiting} waiting on you, ${sessions.length} total`);
}

// Silence what's playing and throw away everything queued. Lines already waiting for the
// speaker see the flush marker and drop themselves; stray workers and players are killed.
function cmdStop() {
  fs.writeFileSync(P.flushed, JSON.stringify({ at: now() }), { mode: 0o600 });
  let jobs = 0;
  for (const f of fs.existsSync(P.tmp) ? fs.readdirSync(P.tmp) : []) {
    if (!f.startsWith("job-")) continue;
    fs.rmSync(path.join(P.tmp, f), { force: true });
    jobs++;
  }
  const killed = [];
  if (process.platform !== "win32" && which("pkill")) {
    const kill = (pattern) => spawnSync("pkill", ["-f", pattern], { stdio: "ignore" }).status === 0;
    if (kill(`${BIN} _worker`) | kill(`jarvis.mjs _worker`)) killed.push("queued workers");
    if (kill(P.tmp)) killed.push("playback");
  }
  fs.rmSync(P.lock, { recursive: true, force: true });
  console.log(`jarvis: stopped. Cleared ${jobs} queued job${jobs === 1 ? "" : "s"}${killed.length ? `, killed ${killed.join(" and ")}` : ""}.`);
}

function cmdStatus() {
  const cfg = config();
  const all = fs.existsSync(P.log) ? fs.readFileSync(P.log, "utf8").trim().split("\n").filter(Boolean) : [];
  const lastSpoke = all
    .map((l) => parseJson(l))
    .reverse()
    .find((e) => e.spoke);
  const status = {
    mode: currentMode(),
    quietHoursNow: inQuietHours(cfg.quietHours),
    engines: cfg.ttsProviders.join(" → "),
    smallestKey: apiKey(cfg, "SMALLEST_API_KEY") ? "found" : "missing",
    openaiKey: apiKey(cfg, "OPENAI_API_KEY") ? "found" : "missing",
    smallestVoice: `${cfg.smallest.voice} (${cfg.smallest.model})`,
    speakLanguage: cfg.speakLanguage,
    summaryProvider: cfg.summaryProvider,
    adapters: Object.fromEntries(listAdapters().map((a) => [a.id, a.isInstalled?.() ? "installed" : "not installed"])),
    agentOverrides: cfg.agents,
    lastEngine: lastSpoke ? `${lastSpoke.engine}${lastSpoke.ms ? ` (${lastSpoke.ms} ms)` : ""}` : null,
    audioPlayer: ["afplay", "paplay", "aplay", "ffplay"].find(which) || null,
    home: HOME,
  };
  console.log(JSON.stringify(status, null, 2));
  console.log("\nlast events:\n" + all.slice(-8).join("\n"));
  console.log(`\navailable engines: ${listEngines().map((e) => e.id).join(", ")}`);
}

async function cmdTest(rest) {
  const { flags } = parseFlags(rest, ["provider", "agent"]);
  process.env.JARVIS_ECHO = "1";
  const cfg = flags.agent ? agentConfig(config(), flags.agent) : config();
  const ph = phrase(cfg, "test");
  const r = await speak(ph.text, "done", { src: "test", force: true, provider: flags.provider, lang: ph.lang, ...(flags.agent ? { agent: flags.agent } : {}) });
  if (r.ms) console.log(`  (${r.engine}, ${(r.ms / 1000).toFixed(1)} s including playback)`);
  if (r.engine === "none") process.exitCode = 1;
}

function cmdInstall(rest, uninstall = false) {
  const { flags } = parseFlags(rest, ["only", "env"]);
  uninstall ||= Boolean(flags.uninstall);
  ensureDirs();
  const only = flags.only ? String(flags.only).split(",").map((s) => s.trim()) : null;
  const opts = { node: process.execPath, bin: BIN, uninstall, chain: Boolean(flags.chain) };
  for (const a of listAdapters()) {
    if (!a.install || (only && !only.includes(a.id))) continue;
    try {
      for (const m of a.install(opts)) console.log(m);
    } catch (e) {
      console.log(`✗ ${a.name}: ${e.message}`);
    }
  }
  if (uninstall) return console.log("\nJarvis hooks removed. Your settings in ~/.jarvis-voice were kept.");

  // Where API keys live: --env, else a .env next to this checkout. ~/.jarvis-voice/.env and the
  // environment are always read too (see apiKey()).
  const cfgNow = readJson(P.config, {});
  const guess = [flags.env, path.join(ROOT, ".env")]
    .filter(Boolean)
    .map((f) => path.resolve(f))
    .find((f) => fs.existsSync(f));
  if (flags.env && !fs.existsSync(path.resolve(flags.env))) console.log(`! --env ${flags.env} not found; ignoring`);
  if (guess && (flags.env || !cfgNow.envFile)) updateConfig({ envFile: guess });
  const cfg = config();
  const keys = ["SMALLEST_API_KEY", "OPENAI_API_KEY"].filter((k) => apiKey(cfg, k));
  console.log(`✓ Jarvis config at ${P.config}${cfg.envFile ? ` (keys from ${cfg.envFile})` : ""}`);
  console.log(`  keys found: ${keys.length ? keys.join(", ") : "none — Jarvis will use your system voice"}`);
  console.log(`\nNext:\n  jarvis test          # you should hear Jarvis\n  jarvis agents        # see every agent session\n  Restart running Claude Code / Codex sessions so they pick up the hooks.`);
  if (!process.env.PATH?.split(":").some((d) => fs.existsSync(path.join(d, "jarvis"))))
    console.log(`\n  No \`jarvis\` on PATH yet. Either \`npm link\` in ${ROOT}, or:\n  alias jarvis='node "${BIN}"'`);
}

// ---------- dispatch ----------

export async function main(argv) {
  ensureDirs();
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "hook": {
      // Claude Code (and any hook-style agent) sends its payload on stdin.
      const agent = rest[0] && !rest[0].startsWith("-") ? rest[0] : "claude-code";
      return ingest(agent, parseJson(await readStdin()));
    }
    case "codex": {
      const raw = rest[rest.length - 1] || "{}";
      const payload = parseJson(raw);
      const codex = getAdapter("codex");
      // Called back by a chained notify wrapper: this turn was already handled.
      if (process.env.JARVIS_FORWARDED === "1") return log({ skipped: "forwarded_echo", agent: "codex" });
      if (codex.firstSeen && !codex.firstSeen(payload, raw)) return log({ skipped: "duplicate_turn", agent: "codex" });
      codex.forward?.(raw);
      return ingest("codex", payload);
    }
    case "_worker":
      return runWorker(rest[0]);
    case "emit":
      return cmdEmit(rest);
    case "run":
      return cmdRun(rest);
    case "say": {
      const { flags, words } = parseFlags(rest, ["kind", "provider", "lang", "agent"]);
      process.env.JARVIS_ECHO = "1";
      const lang = flags.lang || (/[^\x00-\x7F]/.test(words.join(" ")) ? config().speakLanguage : "en");
      return speak(words.join(" "), flags.kind || "info", { src: "cli", provider: flags.provider, lang, ...(flags.agent ? { agent: flags.agent } : {}) });
    }
    case "voices":
      return cmdVoices(rest);
    case "voice":
      return cmdVoice(rest);
    case "lang":
      return cmdLang(rest);
    case "agents":
    case "ls":
      return cmdAgents(rest);
    case "quiet":
    case "off": {
      const mins = Number(rest[0]) || (cmd === "quiet" ? 60 : 0);
      setMode(cmd, mins);
      return console.log(`jarvis: ${cmd}${mins ? ` for ${mins} min` : " until `jarvis on`"}`);
    }
    case "on":
      setMode("on");
      return console.log("jarvis: on");
    case "status":
      return cmdStatus();
    case "stop":
    case "flush":
      return cmdStop();
    case "test":
      return cmdTest(rest);
    case "install":
      return cmdInstall(rest);
    case "uninstall":
      return cmdInstall(rest, true);
    case "version":
    case "--version":
    case "-v":
      return console.log(pkg.version || "unknown");
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return process.stdout.write(HELP);
    default:
      // stderr only: if this ever runs from a hook, stdout could be fed back to the agent.
      process.exitCode = 2;
      console.error(`jarvis: unknown command "${cmd}". Run \`jarvis help\`.`);
  }
}

// Shared by every entry file. Hook paths never fail the agent because of a voice problem.
export function run(argv = process.argv.slice(2)) {
  const hookPath = ["hook", "codex", "_worker"].includes(argv[0]);
  return main(argv).catch((e) => {
    log({ error: String(e?.stack || e), cmd: argv[0] });
    if (hookPath) process.exitCode = 0;
    else {
      console.error(`jarvis: ${e?.message || e}`);
      process.exitCode = 1;
    }
  });
}
