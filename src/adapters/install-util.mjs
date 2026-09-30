// Shared helpers for adapters that edit an agent's own config file.
import fs from "node:fs";

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// Copies file to file.bak-jarvis-<timestamp>. Returns the backup path, or null if file didn't exist.
export function backup(file) {
  if (!fs.existsSync(file)) return null;
  const b = `${file}.bak-jarvis-${stamp()}`;
  fs.copyFileSync(file, b);
  return b;
}

export const quote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// Only commands Jarvis wrote count as ours: a jarvis.mjs path followed by one of our hook
// subcommands, either as a shell command (`"…/jarvis.mjs" hook`) or a TOML/JSON array
// (`"…/jarvis.mjs", "codex"`). Covers bin/jarvis.mjs, the legacy ./jarvis.mjs and the
// desktop app's jarvis-hook shim, so switching between them replaces the hook, never doubles it.
export const isJarvisCommand = (s) =>
  typeof s === "string" && /(?:jarvis\.mjs|jarvis-hook)["']?(?:\s*,\s*["']|\s+)(?:hook|codex)\b/.test(s);

// The command prefix hooks run: [node, bin/jarvis.mjs] for the CLI, [shim] for the app.
export const commandPrefix = ({ cmd, node, bin }) => (cmd?.length ? cmd : [node, bin]);
