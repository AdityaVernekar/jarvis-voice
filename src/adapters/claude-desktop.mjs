// Claude Desktop adapter. Desktop chats and Cowork have no hooks, so Jarvis registers a small
// MCP server (`jarvis mcp`, see src/mcp/server.mjs) in claude_desktop_config.json. Claude calls
// its jarvis_notify tool when it finishes real work or needs you; the server sends hub events.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup, commandPrefix } from "./install-util.mjs";

export const SERVER_KEY = "jarvis-voice";
// "Claude" is the standard app. Other builds (for example ones set up by an organisation) keep
// their own support folder next to it; every one that exists gets the server.
const APP_DIRS = ["Claude", "Claude-3p"];

const supportDir = () => path.join(os.homedir(), "Library", "Application Support");
export const configFiles = () => APP_DIRS.map((d) => path.join(supportDir(), d, "claude_desktop_config.json"));
const presentFiles = () => configFiles().filter((f) => fs.existsSync(path.dirname(f)));
const appName = (file) => path.basename(path.dirname(file));

function read(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export default {
  id: "claude-desktop",
  name: "Claude Desktop",
  // Events arrive already in hub shape from the MCP server.
  toEvents: (e) => [{ ...e, agent: "claude-desktop" }],

  // The desktop app reads this to show the connection state.
  configFile: () => presentFiles()[0] || configFiles()[0],
  configFiles,

  isInstalled() {
    return configFiles().some((f) => {
      try {
        return Boolean(read(f).mcpServers?.[SERVER_KEY]);
      } catch {
        return false;
      }
    });
  },

  install({ node, bin, cmd, uninstall = false }) {
    const files = presentFiles();
    if (!files.length) return uninstall ? [] : ["• Claude Desktop not found; skipped."];
    const prefix = commandPrefix({ cmd, node, bin });
    const entry = { command: prefix[0], args: [...prefix.slice(1), "mcp"] };
    const out = [];
    for (const file of files) {
      let cfg;
      try {
        cfg = read(file);
      } catch {
        out.push(`✗ ${file} is not valid JSON. Fix it first; nothing changed.`);
        continue;
      }
      const cur = cfg.mcpServers?.[SERVER_KEY];
      if (uninstall ? !cur : JSON.stringify(cur) === JSON.stringify(entry)) {
        if (!uninstall) out.push(`✓ ${appName(file)}: Jarvis already connected`);
        continue;
      }
      const b = backup(file);
      cfg.mcpServers = { ...(cfg.mcpServers || {}) };
      if (uninstall) delete cfg.mcpServers[SERVER_KEY];
      else cfg.mcpServers[SERVER_KEY] = entry;
      if (!Object.keys(cfg.mcpServers).length) delete cfg.mcpServers;
      const tmp = `${file}.jarvis-${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
      fs.renameSync(tmp, file);
      out.push(
        `✓ ${appName(file)}: Jarvis MCP server ${uninstall ? "removed from" : "added to"} ${file}${b ? `  (backup: ${path.basename(b)})` : ""}`,
      );
    }
    if (!uninstall && out.some((l) => l.includes("added to"))) out.push("  Quit and reopen Claude Desktop to load it.");
    return out;
  },
};
