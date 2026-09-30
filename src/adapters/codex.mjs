// Codex CLI adapter: the top-level `notify` command in ~/.codex/config.toml → hub events.
// Codex runs `notify` with a JSON payload as the last argv item after each agent turn.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, updateConfig } from "../config.mjs";
import { log, now, readJson } from "../util.mjs";
import { P } from "../paths.mjs";
import { backup, commandPrefix, isJarvisCommand, quote } from "./install-util.mjs";

const tomlFile = () => path.join(os.homedir(), ".codex", "config.toml");
const MARKER = "# Jarvis voice pings";
const SEEN_MS = 10 * 60_000;

// Reads a TOML `notify = [ ... ]` value starting at lines[idx], single- or multi-line,
// with comments and trailing commas. Returns { end: lastLineIndex, value: string[] | null }.
export function notifySpan(lines, idx) {
  const eq = lines[idx].indexOf("=");
  let depth = 0, started = false, str = null, esc = false, cur = "";
  const value = [];
  for (let li = idx; li < lines.length; li++) {
    const line = li === idx ? lines[idx].slice(eq + 1) : lines[li];
    let comment = false;
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

// Index of the first [table] / [[array]] header, ignoring `[` inside multi-line arrays and strings.
export function firstTableLine(lines) {
  let depth = 0;
  let multi = null; // open ''' or """ string
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!multi && depth === 0 && /^\s*\[/.test(line)) return i;
    let str = null;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const three = line.slice(j, j + 3);
      if (multi) {
        if (three === multi) { multi = null; j += 2; }
        continue;
      }
      if (str) {
        if (str === '"' && ch === "\\") j++;
        else if (ch === str) str = null;
        continue;
      }
      if (three === '"""' || three === "'''") { multi = three; j += 2; }
      else if (ch === '"' || ch === "'") str = ch;
      else if (ch === "#") break;
      else if (ch === "[") depth++;
      else if (ch === "]") depth = Math.max(0, depth - 1);
    }
  }
  return lines.length;
}

// Pure transform of config.toml text, so it can be unit tested.
// Returns { text, chainSaved?: string[], restored?: boolean, message?: string, changed: boolean }.
export function rewriteToml(text, { ours, uninstall = false, chain = false, savedChain = null }) {
  const lines = text ? text.split("\n") : [];
  const topEnd = firstTableLine(lines);
  const notifyLines = lines.slice(0, topEnd).flatMap((l, i) => (/^\s*notify\s*=/.test(l) ? [i] : []));
  if (notifyLines.length > 1)
    return { text, changed: false, message: `! ${tomlFile()} has more than one top-level notify line; left it alone. Fix it, then re-run.` };
  const notifyIdx = notifyLines.length ? notifyLines[0] : -1;
  const span = notifyIdx >= 0 ? notifySpan(lines, notifyIdx) : null;
  const notifyText = span ? lines.slice(notifyIdx, span.end + 1).join("\n") : "";
  let chainSaved = null;

  if (notifyIdx >= 0 && !isJarvisCommand(notifyText)) {
    if (uninstall) return { text, changed: false };
    if (!chain)
      return {
        text,
        changed: false,
        message:
          `! ${tomlFile()} already has a notify command:\n    ${span.value ? JSON.stringify(span.value) : notifyText.trim()}\n` +
          "  Left it alone. Re-run with --chain to keep it AND add Jarvis (Jarvis speaks, then forwards the event to it).",
      };
    if (!span.value)
      return { text, changed: false, message: `! Couldn't parse the existing notify value; left it alone. Replace it manually with:\n    ${ours}` };
    chainSaved = span.value;
  }
  if (notifyIdx >= 0) lines.splice(notifyIdx, span.end - notifyIdx + 1);
  const out = lines.filter((l) => !l.startsWith(MARKER));
  let restored = false;
  if (!uninstall) out.unshift(`${MARKER} (jarvis-voice)`, ours); // top-level keys must precede any [table]
  else if (savedChain?.length) {
    out.unshift(`notify = [${savedChain.map((s) => JSON.stringify(s)).join(", ")}]`);
    restored = true;
  }
  return { text: out.join("\n").replace(/\n*$/, "\n"), chainSaved, restored, changed: true };
}

export default {
  id: "codex",
  name: "Codex",

  toEvents(p) {
    if (p.type && p.type !== "agent-turn-complete") return [];
    return [
      {
        agent: "codex",
        session: p["thread-id"] || p.thread_id || p["turn-id"] || "codex",
        cwd: p.cwd || process.cwd(),
        type: "turn_end",
        text: p["last-assistant-message"] || p.last_assistant_message || "",
      },
    ];
  },

  // Forward the raw payload to the user's original notify command, if the installer chained one.
  // The chained command may itself call Jarvis again (e.g. a wrapper whose --previous-notify is
  // Jarvis). JARVIS_FORWARDED=1 marks that call so it neither speaks nor forwards a second time;
  // firstSeen() below catches wrappers that drop the environment.
  forward(raw) {
    if (process.env.JARVIS_FORWARDED === "1") return false;
    const chain = config().codexChain;
    if (!Array.isArray(chain) || !chain.length) return false;
    // A chain that runs Jarvis directly would only loop. (A wrapper that calls Jarvis later is
    // fine: the env flag and firstSeen() stop the echo.)
    if (chain.slice(0, 2).some((a) => /jarvis\.mjs$/.test(String(a)))) return false;
    try {
      spawn(chain[0], [...chain.slice(1), raw], { detached: true, stdio: "ignore", env: { ...process.env, JARVIS_FORWARDED: "1" } })
        .on("error", (e) => log({ warn: "codex_chain_failed", error: String(e.message || e) }))
        .unref();
      return true;
    } catch (e) {
      log({ warn: "codex_chain_failed", error: String(e.message || e) });
      return false;
    }
  },

  // True the first time a given Codex turn is seen in the last 10 minutes. The marker file is
  // created with O_EXCL, so two processes racing on the same turn can't both win.
  firstSeen(payload, raw) {
    const id = payload["turn-id"] || payload.turn_id;
    const key = crypto
      .createHash("sha1")
      .update(id ? `turn:${payload["thread-id"] || payload.thread_id || ""}:${id}` : `raw:${raw}`)
      .digest("hex")
      .slice(0, 16);
    const file = path.join(P.tmp, `seen-codex-${key}`);
    try {
      if (now() - fs.statSync(file).mtimeMs > SEEN_MS) fs.rmSync(file, { force: true });
    } catch {}
    try {
      fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if (e.code === "EEXIST") return false;
      return true; // can't record it; better to speak once too often than never
    }
  },

  configFile: tomlFile, // the file install() edits; the desktop app reads it to show hook status

  isInstalled() {
    try {
      return isJarvisCommand(fs.readFileSync(tomlFile(), "utf8"));
    } catch {
      return false;
    }
  },

  install({ node, bin, cmd, uninstall = false, chain = false }) {
    const file = tomlFile();
    const exists = fs.existsSync(file);
    if (!exists && uninstall) return [];
    const ours = `notify = [${[...commandPrefix({ cmd, node, bin }), "codex"].map(quote).join(", ")}]`;
    const savedChain = readJson(P.config, {}).codexChain || null;
    const r = rewriteToml(exists ? fs.readFileSync(file, "utf8") : "", { ours, uninstall, chain, savedChain });
    const msgs = r.message ? [r.message] : [];
    if (!r.changed) return msgs;
    if (r.chainSaved) {
      updateConfig({ codexChain: r.chainSaved });
      msgs.push(`• Kept your existing Codex notify (${r.chainSaved.join(" ")}); Jarvis will forward events to it.`);
    }
    if (r.restored) updateConfig({ codexChain: null });
    const b = backup(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, r.text);
    msgs.push(`✓ Codex notify ${uninstall ? "removed from" : "added to"} ${file}${b ? `  (backup: ${path.basename(b)})` : ""}`);
    return msgs;
  },
};
