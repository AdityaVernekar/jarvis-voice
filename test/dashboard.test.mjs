// Main-window helpers that don't need Electron: the key-file writer and the activity feed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { friendlyLog, writeKey } from "../app/main/dashboard.mjs";

test("writeKey replaces one line, keeps the rest, and stays private", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-keys-"));
  const f = path.join(dir, ".env");
  fs.writeFileSync(f, "# mine\nOTHER=1\nexport OPENAI_API_KEY='old'\n");
  writeKey(f, "OPENAI_API_KEY", "sk-new-123456");
  writeKey(f, "SMALLEST_API_KEY", "sm-123456789");
  assert.equal(fs.readFileSync(f, "utf8"), "# mine\nOTHER=1\nOPENAI_API_KEY=sk-new-123456\nSMALLEST_API_KEY=sm-123456789\n");
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  writeKey(f, "OPENAI_API_KEY", "");
  assert.equal(fs.readFileSync(f, "utf8"), "# mine\nOTHER=1\nSMALLEST_API_KEY=sm-123456789\n");
});

test("friendlyLog folds repeats, labels skips and redacts", () => {
  const t = new Date().toISOString();
  const lines = [
    JSON.stringify({ t, spoke: "Done with key sk-abcdef", engine: "say", agent: "codex", project: "api" }),
    ...Array(5).fill(JSON.stringify({ t, warn: "tts_failed", engine: "openai", agent: "codex" })),
    JSON.stringify({ t, skipped: "short_turn", agent: "codex" }),
    "not json",
  ];
  const rows = friendlyLog(lines, (s) => String(s).replace(/sk-\w+/g, "[key]"));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].text, "Done with key [key]");
  assert.equal(rows[1].count, 5);
  assert.equal(rows[1].text, "openai couldn't speak");
  assert.match(rows[2].detail, /shorter than the minimum/);
});
