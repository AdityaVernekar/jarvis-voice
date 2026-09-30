// Every test file runs in its own process (node --test), so setting JARVIS_HOME here,
// before any src module is imported, isolates it from the real ~/.jarvis-voice.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tempHome(config = { quietHours: null, chimes: false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-test-"));
  process.env.JARVIS_HOME = dir;
  process.env.JARVIS_DRY_RUN = "1";
  process.env.JARVIS_FOREGROUND = "1";
  delete process.env.JARVIS_ECHO;
  delete process.env.SMALLEST_API_KEY;
  delete process.env.OPENAI_API_KEY;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  return dir;
}

export const readLog = (dir) =>
  fs.existsSync(path.join(dir, "log.jsonl"))
    ? fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
