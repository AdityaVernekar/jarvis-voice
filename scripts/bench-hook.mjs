#!/usr/bin/env node
// How long does one hook call cost the agent? Compares the curl shim talking to a running hub
// with the fallback that starts the core itself. Uses a throwaway EARPIECE_HOME and dry-run audio.
//   node scripts/bench-hook.mjs [--runs 40] [--electron "/Applications/Earpiece.app/Contents/MacOS/Earpiece"]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const runs = Number(opt("--runs", 40));
const electron = opt("--electron", null);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-bench-"));
process.env.EARPIECE_HOME = home;
process.env.EARPIECE_DRY_RUN = "1";
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ quietHours: null, chimes: false }));
const { BIN } = await import("../src/paths.mjs");
const { writeShim } = await import("../src/shim.mjs");

const payload = JSON.stringify({ hook_event_name: "PostToolUse", session_id: "bench", cwd: "/x/bench", tool_name: "Bash" });
const env = { ...process.env, EARPIECE_HOME: home, EARPIECE_DRY_RUN: "1" };

function time(shim) {
  const ms = [];
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    const r = spawnSync(shim, ["hook", "claude-code"], { input: payload, env });
    if (r.status !== 0) throw new Error(`shim exited ${r.status}`);
    ms.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  ms.sort((a, b) => a - b);
  const q = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))].toFixed(1);
  return `p50 ${q(0.5)} ms   p95 ${q(0.95)} ms   max ${ms.at(-1).toFixed(1)} ms`;
}

const results = [];
// The hub runs in its own process, like the desktop app. (Running it here would deadlock:
// spawnSync blocks the event loop the server needs.)
const hub = spawn(process.execPath, [BIN, "serve"], { env, stdio: "ignore" });
const sock = path.join(home, "hub.sock");
for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
results.push(["curl → running hub", time(writeShim({ fallback: ["/nonexistent", BIN] }))]);
hub.kill();
await new Promise((r) => hub.once("exit", r));
fs.rmSync(sock, { force: true });
results.push(["fallback: node", time(writeShim({ fallback: [process.execPath, BIN] }))]);
if (electron)
  results.push(["fallback: Electron as node", time(writeShim({ fallback: [electron, BIN], env: { ELECTRON_RUN_AS_NODE: "1" } }))]);

console.log(`${runs} PostToolUse hook calls each\n`);
for (const [name, r] of results) console.log(`${name.padEnd(28)} ${r}`);
fs.rmSync(home, { recursive: true, force: true });
