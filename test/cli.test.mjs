import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-cli-"));
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ quietHours: null, chimes: false }));
const env = { ...process.env, JARVIS_HOME: home, JARVIS_DRY_RUN: "1", JARVIS_FOREGROUND: "1", HOME: home };
delete env.SMALLEST_API_KEY;
delete env.OPENAI_API_KEY;

const jarvis = (args, input, entry = "bin/jarvis.mjs") =>
  spawnSync(process.execPath, [path.join(ROOT, entry), ...args], { env, input, encoding: "utf8" });

test("help lists the hub commands", () => {
  const r = jarvis(["help"]);
  assert.equal(r.status, 0);
  for (const c of ["agents", "emit", "install", "voice <id> [--agent id]"]) assert.ok(r.stdout.includes(c), c);
});

test("unknown commands exit non-zero", () => {
  assert.equal(jarvis(["nope"]).status, 2);
});

test("emit + agents", () => {
  let r = jarvis(["emit", "--agent", "aider", "--type", "turn_end", "--project", "docs", "--duration", "90", "Rebuilt the docs."]);
  assert.equal(r.status, 0, r.stderr);
  r = jarvis(["agents", "--json"]);
  const s = JSON.parse(r.stdout);
  assert.equal(s[0].agent, "aider");
  assert.equal(s[0].lastLine, "docs. Rebuilt the docs.");
  assert.match(jarvis(["agents"]).stdout, /Aider\s+docs/);
});

test("emit reads a JSON event on stdin", () => {
  const r = jarvis(["emit"], JSON.stringify({ agent: "ci", type: "error", project: "api", line: "API build failed." }));
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(jarvis(["agents", "--json"]).stdout).find((x) => x.agent === "ci");
  assert.equal(s.status, "error");
});

test("legacy ./jarvis.mjs hook and codex entry points still work and never fail", () => {
  let r = jarvis(["hook"], JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "L1", cwd: "/x/legacy" }), "jarvis.mjs");
  assert.equal(r.status, 0);
  r = jarvis(["codex", JSON.stringify({ type: "agent-turn-complete", "thread-id": "c1", cwd: "/x/pay", "last-assistant-message": "Paid." })], "", "jarvis.mjs");
  assert.equal(r.status, 0);
  r = jarvis(["hook"], "not json", "jarvis.mjs");
  assert.equal(r.status, 0);
  const s = JSON.parse(jarvis(["agents", "--json"]).stdout);
  assert.ok(s.find((x) => x.agent === "claude-code" && x.session === "L1" && x.status === "working"));
  assert.ok(s.find((x) => x.agent === "codex" && x.session === "c1"));
});

test("install and uninstall round-trip in a fake HOME", () => {
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "o3"\n');
  let r = jarvis(["install"], "", "install.mjs");
  assert.equal(r.status, 0, r.stderr);
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.match(settings.hooks.Stop[0].hooks[0].command, /bin\/jarvis\.mjs" hook claude-code$/);
  assert.match(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /bin\/jarvis\.mjs", "codex"\]/);
  r = jarvis(["uninstall"]);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")), {});
  assert.equal(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), 'model = "o3"\n');
});
