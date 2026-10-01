// Every test file runs in its own process (node --test), so setting EARPIECE_HOME here,
// before any src module is imported, isolates it from the real ~/.earpiece.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tempHome(config = { quietHours: null, chimes: false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-test-"));
  process.env.EARPIECE_HOME = dir;
  process.env.EARPIECE_DRY_RUN = "1";
  process.env.EARPIECE_FOREGROUND = "1";
  delete process.env.EARPIECE_ECHO;
  delete process.env.SMALLEST_API_KEY;
  delete process.env.OPENAI_API_KEY;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  return dir;
}

export const readLog = (dir) =>
  fs.existsSync(path.join(dir, "log.jsonl"))
    ? fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
