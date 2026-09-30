import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOME, P } from "./paths.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => Date.now();
export const isDry = () => process.env.JARVIS_DRY_RUN === "1";
export const isEcho = () => process.env.JARVIS_ECHO === "1" || isDry();

// State holds agent messages, so it is private to the user (0700 dirs, 0600 files).
export function ensureDirs() {
  for (const d of [HOME, P.sessions, P.tmp]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

// Strip anything key-shaped from provider error text before it is logged or shown.
export function redact(s) {
  return String(s ?? "")
    .replace(/\b(sk|pk|rk)[-_][A-Za-z0-9*_-]{6,}/g, "[redacted]")
    .replace(/\b(Bearer|key|token)(["':=\s]+)(?=[A-Za-z0-9*._-]*[0-9*])[A-Za-z0-9*._-]{8,}/gi, "$1$2[redacted]");
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Atomic write: concurrent hook processes never see a half-written file.
export function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function log(event) {
  try {
    fs.appendFileSync(P.log, JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
  } catch {}
}

export function echo(line) {
  if (isEcho()) process.stdout.write(line + "\n");
}

export function which(bin) {
  return spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;
}

export function projectName(cwd) {
  if (!cwd) return "Terminal";
  return path.basename(cwd).replace(/[-_]+/g, " ").trim() || "Terminal";
}

export function safeId(s) {
  return String(s ?? "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
}

// Turn markdown-ish agent output into one plain spoken sentence.
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

// --flag value / --switch parsing. `names` lists flags that take a value.
export function parseFlags(args, names = []) {
  const flags = {};
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(args[i]);
    if (m && m[2] !== undefined) flags[m[1]] = m[2];
    else if (m && names.includes(m[1])) flags[m[1]] = args[++i];
    else if (m) flags[m[1]] = true;
    else words.push(args[i]);
  }
  return { flags, words };
}

export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
