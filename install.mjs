#!/usr/bin/env node
// Installs Jarvis voice hooks for Claude Code and Codex CLI.
//   node install.mjs                 install (backs up every file it touches)
//   node install.mjs --uninstall     remove Jarvis entries
//   node install.mjs --env /path/.env   where OPENAI_API_KEY lives (optional)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const JARVIS = path.join(here, "jarvis.mjs");
const HOME = os.homedir();
const JHOME = process.env.JARVIS_HOME || path.join(HOME, ".jarvis-voice");
const uninstall = process.argv.includes("--uninstall");
const chain = process.argv.includes("--chain");

// Reads a TOML `notify = [ ... ]` value starting at lines[idx], single- or multi-line,
// with comments and trailing commas. Returns { end: lastLineIndex, value: string[] | null }.
function notifySpan(lines, idx) {
  const eq = lines[idx].indexOf("=");
  let depth = 0, started = false, str = null, esc = false, cur = "", comment = false;
  const value = [];
  for (let li = idx; li < lines.length; li++) {
    const line = li === idx ? lines[idx].slice(eq + 1) : lines[li];
    comment = false;
    for (const ch of line) {
      if (comment) break;
      if (str) {
        if (str === '"' && esc) { cur += ch; esc = false; continue; }
        if (str === '"' && ch === "\\") { esc = true; cur += ch; continue; }
        if (ch === str) {
          value.push(str === '"' ? JSON.parse(`"${cur}"`) : cur);
          str = null; cur = "";
        } else cur += ch;
        continue;
      }
      if (ch === "#") comment = true;
      else if (ch === '"' || ch === "'") str = ch;
      else if (ch === "[") { depth++; started = true; }
      else if (ch === "]") {
        depth--;
        if (started && depth === 0) return { end: li, value: value.length ? value : null };
      } else if (!started && !/\s/.test(ch)) return { end: li, value: null }; // not an array
    }
    if (!started && li > idx) break;
  }
  return { end: idx, value: null };
}
const envArg = (() => {
  const i = process.argv.indexOf("--env");
  return i > 0 ? path.resolve(process.argv[i + 1]) : null;
})();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const q = (s) => `"${s.replace(/"/g, '\\"')}"`;
const HOOK_CMD = `${q(process.execPath)} ${q(JARVIS)} hook`;
const isJarvis = (s) => typeof s === "string" && s.includes("jarvis.mjs");

function backup(file) {
  if (fs.existsSync(file)) {
    const b = `${file}.bak-jarvis-${stamp}`;
    fs.copyFileSync(file, b);
    return b;
  }
  return null;
}

// ---------- Claude Code: ~/.claude/settings.json ----------
function claude() {
  const file = path.join(HOME, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.error(`✗ ${file} is not valid JSON — fix it first, nothing changed.`);
      return;
    }
  }
  const b = backup(file);
  settings.hooks ||= {};
  for (const ev of ["UserPromptSubmit", "Stop", "Notification"]) {
    const groups = (settings.hooks[ev] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isJarvis(h.command)) }))
      .filter((g) => g.hooks.length);
    if (!uninstall) groups.push({ hooks: [{ type: "command", command: HOOK_CMD, timeout: 10 }] });
    if (groups.length) settings.hooks[ev] = groups;
    else delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  console.log(`✓ Claude Code hooks ${uninstall ? "removed from" : "added to"} ${file}${b ? `  (backup: ${path.basename(b)})` : ""}`);
}

// ---------- Codex CLI: ~/.codex/config.toml (top-level `notify`) ----------
function codex() {
  const file = path.join(HOME, ".codex", "config.toml");
  const exists = fs.existsSync(file);
  if (!exists && uninstall) return;
  const lines = exists ? fs.readFileSync(file, "utf8").split("\n") : [];
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const topEnd = firstTable === -1 ? lines.length : firstTable;
  const notifyIdx = lines.slice(0, topEnd).findIndex((l) => /^\s*notify\s*=/.test(l));
  const span = notifyIdx >= 0 ? notifySpan(lines, notifyIdx) : null; // multi-line arrays too
  const notifyText = span ? lines.slice(notifyIdx, span.end + 1).join("\n") : "";
  const ours = `notify = [${q(process.execPath)}, ${q(JARVIS)}, "codex"]`;

  const cfgFile = path.join(JHOME, "config.json");
  const jcfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : {};
  const saveCfg = () => {
    fs.mkdirSync(JHOME, { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify(jcfg, null, 2) + "\n");
  };

  if (notifyIdx >= 0 && !isJarvis(notifyText)) {
    if (uninstall) return;
    const arr = span.value;
    if (!chain) {
      console.log(
        `! ${file} already has a notify command:\n    ${arr ? JSON.stringify(arr) : notifyText.trim()}\n` +
          `  Left it alone. Re-run with --chain to keep it AND add Jarvis (Jarvis speaks, then forwards the event to it).`,
      );
      return;
    }
    if (!arr) {
      console.log(`! Couldn't parse the existing notify value; left it alone:\n${notifyText}\n  Replace it manually with:\n    ${ours}`);
      return;
    }
    jcfg.codexChain = arr;
    saveCfg();
    console.log(`• Kept your existing Codex notify (${arr.join(" ")}); Jarvis will forward events to it.`);
  }
  const b = backup(file);
  if (notifyIdx >= 0) lines.splice(notifyIdx, span.end - notifyIdx + 1);
  let out = lines.filter((l) => !l.startsWith("# Jarvis voice pings"));
  // Top-level keys must come before any [table], so insert at the very top.
  if (!uninstall) out.unshift("# Jarvis voice pings (tools/jarvis-voice)", ours);
  else if (jcfg.codexChain) {
    // Put the user's original notify back.
    out.unshift(`notify = [${jcfg.codexChain.map((s) => JSON.stringify(s)).join(", ")}]`);
    delete jcfg.codexChain;
    saveCfg();
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join("\n").replace(/\n*$/, "\n"));
  console.log(`✓ Codex notify ${uninstall ? "removed from" : "added to"} ${file}${b ? `  (backup: ${path.basename(b)})` : ""}`);
}

// ---------- Jarvis config ----------
function jarvisConfig() {
  if (uninstall) return;
  fs.mkdirSync(JHOME, { recursive: true });
  const file = path.join(JHOME, "config.json");
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const guess = [envArg, path.resolve(here, "..", "..", ".env")].find((f) => f && fs.existsSync(f));
  if (guess && !cfg.envFile) cfg.envFile = guess;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`✓ Jarvis config at ${file}${cfg.envFile ? ` (reads OPENAI_API_KEY from ${cfg.envFile})` : " (no key file; will use macOS say)"}`);
}

claude();
codex();
jarvisConfig();
if (!uninstall) {
  console.log(`\nNext:\n  node ${q(JARVIS)} test      # you should hear Jarvis\n  alias jarvis='node ${q(JARVIS)}'   # add to ~/.zshrc\n  Restart any running Claude Code / Codex sessions.`);
}
