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
// (`"…/jarvis.mjs", "codex"`). Covers bin/jarvis.mjs and the legacy ./jarvis.mjs.
export const isJarvisCommand = (s) =>
  typeof s === "string" && /jarvis\.mjs["']?(?:\s*,\s*["']|\s+)(?:hook|codex)\b/.test(s);
