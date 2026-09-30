// Claude Code adapter: hooks in ~/.claude/settings.json → hub events.
// Hook docs: https://docs.anthropic.com/en/docs/claude-code/hooks
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sleep } from "../util.mjs";
import { backup, isJarvisCommand, quote } from "./install-util.mjs";

const HOOK_EVENTS = ["UserPromptSubmit", "Stop", "Notification"];
const settingsFile = () => path.join(os.homedir(), ".claude", "settings.json");

// Read the tail of the transcript and return the last assistant text block.
export function lastAssistantText(transcriptPath) {
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
  for (const l of buf.toString("utf8").split("\n").reverse()) {
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

export default {
  id: "claude-code",
  name: "Claude Code",

  toEvents(p) {
    const base = { agent: "claude-code", session: p.session_id || "unknown", cwd: p.cwd };
    switch (p.hook_event_name) {
      case "UserPromptSubmit":
        return [{ ...base, type: "turn_start" }];
      case "Stop":
        if (p.stop_hook_active) return []; // a Stop hook is already continuing the turn
        return [{ ...base, type: "turn_end", text: p.last_assistant_message || "", transcriptPath: p.transcript_path }];
      case "Notification": {
        const msg = String(p.message || "").trim();
        if (p.notification_type === "idle_prompt" || /waiting for your input/i.test(msg)) return [{ ...base, type: "idle" }];
        const perm = msg.match(/permission to use (.+?)\.?$/i);
        if (perm) return [{ ...base, type: "needs_input", tool: perm[1] }];
        return [{ ...base, type: "needs_input", message: msg.replace(/^Claude\s+/i, "") || "needs your attention" }];
      }
      default:
        return []; // SubagentStop, PreToolUse, … are ignored
    }
  },

  // Runs in the background worker, never in the hook process.
  async enrich(ev) {
    if (ev.type !== "turn_end" || ev.text || !ev.transcriptPath) return ev;
    let text = lastAssistantText(ev.transcriptPath);
    if (!text) {
      await sleep(400); // the transcript can lag the Stop event slightly
      text = lastAssistantText(ev.transcriptPath);
    }
    return { ...ev, text };
  },

  isInstalled() {
    try {
      return isJarvisCommand(fs.readFileSync(settingsFile(), "utf8").replace(/\\"/g, '"'));
    } catch {
      return false;
    }
  },

  install({ node, bin, uninstall = false }) {
    const file = settingsFile();
    if (uninstall && !fs.existsSync(file)) return [];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let settings = {};
    if (fs.existsSync(file)) {
      try {
        settings = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return [`✗ ${file} is not valid JSON. Fix it first; nothing changed.`];
      }
    }
    const b = backup(file);
    const cmd = `${quote(node)} ${quote(bin)} hook claude-code`;
    settings.hooks ||= {};
    for (const ev of HOOK_EVENTS) {
      const groups = (settings.hooks[ev] || [])
        .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isJarvisCommand(h.command)) }))
        .filter((g) => g.hooks.length);
      if (!uninstall) groups.push({ hooks: [{ type: "command", command: cmd, timeout: 10 }] });
      if (groups.length) settings.hooks[ev] = groups;
      else delete settings.hooks[ev];
    }
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    const tmp = `${file}.jarvis-${process.pid}.tmp`; // atomic: a running Claude Code never reads half a file
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
    fs.renameSync(tmp, file);
    return [`✓ Claude Code hooks ${uninstall ? "removed from" : "added to"} ${file}${b ? `  (backup: ${path.basename(b)})` : ""}`];
  },
};
