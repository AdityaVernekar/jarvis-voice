// Regression: a chained Codex notify wrapper that calls Earpiece back must not start a loop.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "earpiece.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stand-in for a notify wrapper (like a desktop app's) that runs its --previous-notify command.
function makeHome(dropEnv) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-loop-"));
  const wrapper = path.join(home, "wrapper.mjs");
  fs.writeFileSync(
    wrapper,
    `import { spawnSync } from "node:child_process"; import fs from "node:fs";
const args = process.argv.slice(2); const prev = JSON.parse(args[args.indexOf("--previous-notify") + 1]);
fs.appendFileSync(${JSON.stringify(path.join(home, "calls"))}, "x");
const env = { ...process.env }; ${dropEnv ? "delete env.EARPIECE_FORWARDED; delete env.JARVIS_FORWARDED;" : ""}
spawnSync(prev[0], [...prev.slice(1), args.at(-1)], { env, stdio: "ignore" });`,
  );
  const chain = [process.execPath, wrapper, "--previous-notify", JSON.stringify([process.execPath, BIN, "codex"])];
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ quietHours: null, chimes: false, codexChain: chain }));
  return home;
}

for (const dropEnv of [false, true]) {
  test(`codex notify through a wrapper that calls Earpiece back speaks once${dropEnv ? " (wrapper drops env)" : ""}`, async () => {
    const home = makeHome(dropEnv);
    const env = { ...process.env, EARPIECE_HOME: home, EARPIECE_DRY_RUN: "1", EARPIECE_FOREGROUND: "1", HOME: home };
    delete env.EARPIECE_FORWARDED;
    delete env.JARVIS_FORWARDED;
    delete env.OPENAI_API_KEY;
    delete env.SMALLEST_API_KEY;
    const payload = JSON.stringify({ type: "agent-turn-complete", "thread-id": "t9", "turn-id": "u1", cwd: "/x/wiki", "last-assistant-message": "Checked the founders." });
    assert.equal(spawnSync(process.execPath, [BIN, "codex", payload], { env }).status, 0);
    await sleep(2500);
    const log = fs.readFileSync(path.join(home, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(log.filter((e) => e.spoke).length, 1);
    assert.equal(fs.readFileSync(path.join(home, "calls"), "utf8"), "x", "wrapper ran exactly once");
    assert.ok(log.some((e) => e.skipped === (dropEnv ? "duplicate_turn" : "forwarded_echo")));
  });
}
