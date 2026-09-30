// Claude Desktop: the stdio MCP server and the installer that registers it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readLog, tempHome } from "./helpers.mjs";

const home = tempHome();
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-desktop-"));
process.env.HOME = fakeHome; // os.homedir() for the adapter's Library path
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { handleMessage, notifyEvent, TOOLS } = await import("../src/mcp/server.mjs");
const { startHubServer } = await import("../src/hub/server.mjs");
const { getSession } = await import("../src/hub/sessions.mjs");
const desktop = (await import("../src/adapters/claude-desktop.mjs")).default;
const { P } = await import("../src/paths.mjs");

test("initialize returns tools capability and instructions for the model", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.ok(r.result.capabilities.tools);
  assert.match(r.result.instructions, /jarvis_notify/);
  const old = await handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(old.result.protocolVersion, "2025-06-18");
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const list = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["jarvis_notify"]);
  assert.equal((await handleMessage({ jsonrpc: "2.0", id: 4, method: "nope" })).error.code, -32601);
});

test("notify maps status to hub events with the model's own line", () => {
  let ev = notifyEvent({ status: "done", summary: "Drafted the launch email.", topic: "Launch email" });
  assert.equal(ev.type, "turn_end");
  assert.equal(ev.line, "Launch email. Drafted the launch email.");
  assert.equal(ev.session, "launch_email");
  ev = notifyEvent({ status: "needs_input", summary: "Which date should I use?" });
  assert.equal(ev.type, "needs_input");
  assert.equal(ev.line, "Which date should I use?");
  assert.throws(() => notifyEvent({ status: "maybe", summary: "x" }));
  assert.throws(() => notifyEvent({ status: "done", summary: "  " }));
});

test("bad tool arguments come back as a tool error, not a protocol error", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "jarvis_notify", arguments: { status: "done" } } }, { send: async () => {} });
  assert.equal(r.result.isError, true);
});

test("over stdio: a jarvis_notify call is spoken by the running hub", async () => {
  const hub = await startHubServer();
  try {
    const child = spawn(process.execPath, [path.join(ROOT, "bin", "jarvis.mjs"), "mcp"], { env: process.env, stdio: ["pipe", "pipe", "inherit"] });
    const lines = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) (lines.push(JSON.parse(buf.slice(0, i))), (buf = buf.slice(i + 1)));
    });
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jarvis_notify", arguments: { status: "done", summary: "Cleaned up the pricing page.", topic: "Pricing" } } });
    for (let i = 0; i < 100 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 30));
    child.stdin.end();
    assert.equal(lines.length, 2, "only JSON-RPC on stdout");
    assert.equal(lines[1].result.content[0].text, "ok");
    await hub.idle();
    assert.equal(readLog(home).filter((e) => e.spoke).at(-1).spoke, "Pricing. Cleaned up the pricing page.");
    assert.equal(getSession("claude-desktop", "pricing").status, "done");
  } finally {
    await hub.close();
  }
  assert.ok(!fs.existsSync(P.socket));
});

test("installer adds the server to every Claude Desktop config and keeps other servers", () => {
  assert.deepEqual(desktop.install({ cmd: ["/x/jarvis-hook"], uninstall: true }), []);
  assert.match(desktop.install({ cmd: ["/x/jarvis-hook"] })[0], /not found/);

  const std = path.join(fakeHome, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const org = path.join(fakeHome, "Library", "Application Support", "Claude-3p", "claude_desktop_config.json");
  fs.mkdirSync(path.dirname(std), { recursive: true });
  fs.mkdirSync(path.dirname(org), { recursive: true });
  fs.writeFileSync(std, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));

  const out = desktop.install({ cmd: ["/x/jarvis-hook"] });
  assert.ok(out.some((l) => /Reopen|reopen/.test(l)));
  const a = JSON.parse(fs.readFileSync(std, "utf8"));
  assert.deepEqual(a.mcpServers["jarvis-voice"], { command: "/x/jarvis-hook", args: ["mcp"] });
  assert.deepEqual(a.mcpServers.other, { command: "x" });
  assert.equal(a.theme, "dark");
  assert.ok(JSON.parse(fs.readFileSync(org, "utf8")).mcpServers["jarvis-voice"]);
  assert.ok(desktop.isInstalled());

  const again = desktop.install({ cmd: ["/x/jarvis-hook"] });
  assert.ok(again.every((l) => /already connected/.test(l)), "no rewrite, no new backups when nothing changed");

  const node = desktop.install({ node: "/usr/bin/node", bin: "/j/bin/jarvis.mjs" });
  assert.ok(node.length);
  assert.deepEqual(JSON.parse(fs.readFileSync(std, "utf8")).mcpServers["jarvis-voice"].args, ["/j/bin/jarvis.mjs", "mcp"]);

  desktop.install({ cmd: ["/x/jarvis-hook"], uninstall: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(std, "utf8")), { mcpServers: { other: { command: "x" } }, theme: "dark" });
  assert.deepEqual(JSON.parse(fs.readFileSync(org, "utf8")), {});
  assert.ok(!desktop.isInstalled());

  fs.writeFileSync(std, "{ nope");
  assert.match(desktop.install({ cmd: ["/x/jarvis-hook"] })[0], /not valid JSON/);
});
