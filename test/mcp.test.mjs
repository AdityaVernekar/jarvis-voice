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
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-desktop-"));
process.env.HOME = fakeHome; // os.homedir() for the adapter's Library path
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { handleMessage, notifyEvent, speakable, resetLimits, LIMITS, TOOLS } = await import("../src/mcp/server.mjs");
const { setMode } = await import("../src/policy.mjs");
const { startHubServer } = await import("../src/hub/server.mjs");
const { getSession } = await import("../src/hub/sessions.mjs");
const desktop = (await import("../src/adapters/claude-desktop.mjs")).default;
const { P } = await import("../src/paths.mjs");

test("initialize returns tools capability and instructions for the model", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.ok(r.result.capabilities.tools);
  assert.match(r.result.instructions, /earpiece_notify/);
  const old = await handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(old.result.protocolVersion, "2025-06-18");
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const list = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["earpiece_notify"]);
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
  const r = await handleMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "earpiece_notify", arguments: { status: "done" } } }, { send: async () => {} });
  assert.equal(r.result.isError, true);
});

const call = (id, args) => handleMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "earpiece_notify", arguments: args } }, { send: async () => "hub" });
const text = (r) => r.result.content[0].text;

test("schema and server agree that summary must be non-empty", async () => {
  const summary = TOOLS[0].inputSchema.properties.summary;
  assert.equal(summary.minLength, 1);
  assert.deepEqual(TOOLS[0].inputSchema.required, ["status", "summary"]);
  resetLimits();
  for (const args of [{ status: "done" }, { status: "done", summary: "" }, { status: "done", summary: "   " }, { status: "done", summary: 42 }]) {
    const r = await call(9, args);
    assert.equal(r.result.isError, true);
    assert.match(text(r), /summary is required/);
  }
  const code = await call(9, { status: "done", summary: "```js\nconsole.log(1)\n```" });
  assert.equal(code.result.isError, true);
  assert.match(text(code), /plain speech/);
});

test("summaries are cleaned for speech: no markdown, code, URLs, paths or IDs", () => {
  assert.equal(speakable("Drafted the launch email."), "Drafted the launch email.");
  assert.equal(
    speakable("**Done!** Updated `src/app.js` and ~/code/api/server.ts, see https://www.github.com/foo/bar/pull/12."),
    "Done! Updated app.js and server.ts, see github.com.",
  );
  assert.equal(speakable("Pushed 9d879d1a to /Users/me/work/repo/notes.md"), "Pushed to notes.md");
  assert.equal(speakable("Ran job 3f2b1c9e-1111-2222-3333-444455556666 fine."), "Ran job fine.");
  assert.equal(speakable("[the docs](https://x.dev/a) are updated"), "the docs are updated");
  assert.equal(speakable("## Summary\n- Built the page\n- Pushed it"), "Summary. Built the page. Pushed it");
  assert.equal(speakable("Works 24/7 and/or on call."), "Works 24/7 and/or on call.");
  assert.equal(speakable("Key sk-abc123def456ghi789jkl012mno345pqr is set."), "Key is set.");
  const long = "I finished refactoring the pricing page, updated the checkout flow, wrote four new tests, fixed the flaky login spec, and bumped every dependency to the latest versions today.";
  const cut = speakable(long);
  assert.ok(cut.split(" ").length <= 25, cut);
  assert.match(cut, /\.$/);
  assert.equal(speakable("Fixed the login bug in the auth flow. Then I also went on to update a lot of other things that nobody asked for at all today."), "Fixed the login bug in the auth flow.");
});

test("the tool result says what happened instead of just ok", async () => {
  resetLimits();
  let r = await call(10, { status: "done", summary: "Built the **landing** page, see https://example.com/x", topic: "Landing" });
  assert.equal(r.result.isError, undefined);
  assert.match(text(r), /^Queued to speak: "Landing\. Built the landing page, see example\.com"/);
  assert.match(text(r), /cleaned up for speech/);
  r = await call(11, { status: "done", summary: "Sorted the invoices." });
  assert.match(text(r), /Tip: pass a short "topic"/);
  setMode("off");
  try {
    r = await call(12, { status: "done", summary: "Renamed the files.", topic: "Files" });
    assert.match(text(r), /^Not spoken now: Earpiece is switched off/);
  } finally {
    setMode("on");
  }
});

test("duplicates and runaway loops are not spoken", async () => {
  resetLimits();
  const args = { status: "done", summary: "Updated the report.", topic: "Report" };
  assert.match(text(await call(20, args)), /^Queued/);
  assert.match(text(await call(21, { ...args, summary: "Updated the report!" })), /same update/);
  assert.match(text(await call(22, { ...args, status: "needs_input", summary: "Updated the report?" })), /^Queued/, "a different status is a different update");
  for (let i = 0; i < LIMITS.maxCalls - 2; i++) assert.match(text(await call(30 + i, { ...args, summary: `Step ${i} done.` })), /^Queued/);
  const r = await call(40, { ...args, summary: "One more thing done." });
  assert.equal(r.result.isError, undefined, "throttling is not a tool error");
  assert.match(text(r), /Call earpiece_notify once/);
  resetLimits();
});

test("over stdio: an earpiece_notify call is spoken by the running hub", async () => {
  const hub = await startHubServer();
  try {
    const child = spawn(process.execPath, [path.join(ROOT, "bin", "earpiece.mjs"), "mcp"], { env: process.env, stdio: ["pipe", "pipe", "inherit"] });
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
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "earpiece_notify", arguments: { status: "done", summary: "Cleaned up the pricing page.", topic: "Pricing" } } });
    for (let i = 0; i < 100 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 30));
    child.stdin.end();
    assert.equal(lines.length, 2, "only JSON-RPC on stdout");
    assert.equal(lines[1].result.content[0].text, 'Queued to speak: "Pricing. Cleaned up the pricing page."');
    await hub.idle();
    assert.equal(readLog(home).filter((e) => e.spoke).at(-1).spoke, "Pricing. Cleaned up the pricing page.");
    assert.equal(getSession("claude-desktop", "pricing").status, "done");
  } finally {
    await hub.close();
  }
  assert.ok(!fs.existsSync(P.socket));
});

test("installer adds the server to every Claude Desktop config and keeps other servers", () => {
  assert.deepEqual(desktop.install({ cmd: ["/x/earpiece-hook"], uninstall: true }), []);
  assert.match(desktop.install({ cmd: ["/x/earpiece-hook"] })[0], /not found/);

  const std = path.join(fakeHome, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const org = path.join(fakeHome, "Library", "Application Support", "Claude-3p", "claude_desktop_config.json");
  fs.mkdirSync(path.dirname(std), { recursive: true });
  fs.mkdirSync(path.dirname(org), { recursive: true });
  fs.writeFileSync(std, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));

  const out = desktop.install({ cmd: ["/x/earpiece-hook"] });
  assert.ok(out.some((l) => /Reopen|reopen/.test(l)));
  const a = JSON.parse(fs.readFileSync(std, "utf8"));
  assert.deepEqual(a.mcpServers["earpiece"], { command: "/x/earpiece-hook", args: ["mcp"] });
  assert.deepEqual(a.mcpServers.other, { command: "x" });
  assert.equal(a.theme, "dark");
  assert.ok(JSON.parse(fs.readFileSync(org, "utf8")).mcpServers["earpiece"]);
  assert.ok(desktop.isInstalled());

  const again = desktop.install({ cmd: ["/x/earpiece-hook"] });
  assert.ok(again.every((l) => /already connected/.test(l)), "no rewrite, no new backups when nothing changed");

  const node = desktop.install({ node: "/usr/bin/node", bin: "/j/bin/earpiece.mjs" });
  assert.ok(node.length);
  assert.deepEqual(JSON.parse(fs.readFileSync(std, "utf8")).mcpServers["earpiece"].args, ["/j/bin/earpiece.mjs", "mcp"]);

  desktop.install({ cmd: ["/x/earpiece-hook"], uninstall: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(std, "utf8")), { mcpServers: { other: { command: "x" } }, theme: "dark" });
  assert.deepEqual(JSON.parse(fs.readFileSync(org, "utf8")), {});
  assert.ok(!desktop.isInstalled());

  fs.writeFileSync(std, "{ nope");
  assert.match(desktop.install({ cmd: ["/x/earpiece-hook"] })[0], /not valid JSON/);
});
