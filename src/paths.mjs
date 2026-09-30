// Filesystem locations. JARVIS_HOME is read once, at import time.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = path.join(ROOT, "bin", "jarvis.mjs");
export const HOME = process.env.JARVIS_HOME || path.join(os.homedir(), ".jarvis-voice");

export const P = {
  config: path.join(HOME, "config.json"),
  env: path.join(HOME, ".env"),
  mode: path.join(HOME, "mode.json"),
  last: path.join(HOME, "last-spoken.json"),
  flushed: path.join(HOME, "flushed.json"),
  log: path.join(HOME, "log.jsonl"),
  lock: path.join(HOME, "speak.lock"),
  sessions: path.join(HOME, "sessions"),
  tmp: path.join(HOME, "tmp"),
};
