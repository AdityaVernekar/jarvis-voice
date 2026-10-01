// Earpiece was Jarvis Voice before 0.3. Old installs must keep working and be cleaned up, never doubled.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.mjs";

tempHome();
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-rename-home-"));
process.env.HOME = fakeHome;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { migrateHome } = await import("../src/paths.mjs");
const { isOurCommand } = await import("../src/adapters/install-util.mjs");
const { rewriteToml } = await import("../src/adapters/codex.mjs");
const desktop = (await import("../src/adapters/claude-desktop.mjs")).default;

test("JARVIS_* variables still work and EARPIECE_* wins when both are set", () => {
  const code = `const { HOME } = await import(${JSON.stringify(path.join(ROOT, "src/paths.mjs"))}); console.log(HOME, process.env.EARPIECE_DRY_RUN);`;
  const env = { ...process.env, JARVIS_HOME: "/tmp/old-home", JARVIS_DRY_RUN: "1" };
  delete env.EARPIECE_HOME;
  delete env.EARPIECE_DRY_RUN;
  let r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "/tmp/old-home 1");
  r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...env, EARPIECE_HOME: "/tmp/new-home" }, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "/tmp/new-home 1");
});

test("~/.jarvis-voice moves to ~/.earpiece once and leaves a symlink behind", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-mig-"));
  const from = path.join(base, ".jarvis-voice");
  const to = path.join(base, ".earpiece");
  fs.mkdirSync(path.join(from, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(from, "config.json"), '{"voice":"echo"}');
  assert.equal(migrateHome({ from, to }), true);
  assert.equal(fs.readFileSync(path.join(to, "config.json"), "utf8"), '{"voice":"echo"}');
  assert.ok(fs.lstatSync(from).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(from, "config.json"), "utf8"), '{"voice":"echo"}', "old paths still resolve");
  assert.equal(migrateHome({ from, to }), false, "second run is a no-op");
  const fresh = path.join(base, "nothing-here");
  assert.equal(migrateHome({ from: fresh, to: path.join(base, ".other") }), false);
});

test("hooks written under either name count as ours", () => {
  assert.ok(isOurCommand('"/Users/a/.jarvis-voice/bin/jarvis-hook" hook claude-code'));
  assert.ok(isOurCommand('"/Users/a/.earpiece/bin/earpiece-hook" hook claude-code'));
  assert.ok(isOurCommand('notify = ["/usr/bin/node", "/x/bin/earpiece.mjs", "codex"]'));
  assert.ok(!isOurCommand('notify = ["/x/earpiece-hook-helper", "--notify"]'));
});

test("re-installing Codex over an old Jarvis block replaces it", () => {
  const old = '# Jarvis voice pings (jarvis-voice)\nnotify = ["/x/.jarvis-voice/bin/jarvis-hook", "codex"]\nmodel = "o3"\n';
  const ours = 'notify = ["/x/.earpiece/bin/earpiece-hook", "codex"]';
  const r = rewriteToml(old, { ours });
  assert.equal(r.text, `# Earpiece voice pings (earpiece)\n${ours}\nmodel = "o3"\n`);
  assert.ok(!/Jarvis|jarvis/.test(r.text));
});

test("Claude Desktop: install swaps the old jarvis-voice server for earpiece, keeps others", () => {
  const dir = path.join(fakeHome, "Library", "Application Support", "Claude");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "claude_desktop_config.json");
  const other = { command: "npx", args: ["other"] };
  const entry = { command: "/x/earpiece-hook", args: ["mcp"] };
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { "jarvis-voice": { command: "/x/jarvis-hook", args: ["mcp"] }, other } }));
  desktop.install({ cmd: ["/x/earpiece-hook"] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers, { other, earpiece: entry });
  // Same entry already there but the old one came back: still cleaned up.
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { "jarvis-voice": {}, earpiece: entry } }));
  desktop.install({ cmd: ["/x/earpiece-hook"] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers, { earpiece: entry });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { "jarvis-voice": {}, earpiece: entry, other } }));
  desktop.install({ cmd: ["/x/earpiece-hook"], uninstall: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers, { other });
});

test("the old jarvis command and root jarvis.mjs still run the CLI", () => {
  for (const bin of ["bin/jarvis.mjs", "jarvis.mjs", "bin/earpiece.mjs"]) {
    const r = spawnSync(process.execPath, [path.join(ROOT, bin), "help"], { env: process.env, encoding: "utf8" });
    assert.equal(r.status, 0, bin);
    assert.match(r.stdout, /earpiece/, bin);
  }
});
