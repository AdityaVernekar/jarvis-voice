// The hub server and the curl shim that hooks call when the desktop app is installed.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { readLog, tempHome } from "./helpers.mjs";

const home = tempHome();
const { startHubServer } = await import("../src/hub/server.mjs");
const { getSession } = await import("../src/hub/sessions.mjs");
const { writeShim } = await import("../src/shim.mjs");
const { isOurCommand } = await import("../src/adapters/install-util.mjs");
const { BIN, P } = await import("../src/paths.mjs");

const spoken = () => readLog(home).filter((e) => e.spoke).map((e) => e.spoke);
const post = (socket, route, body) =>
  new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: route, method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject);
    req.end(typeof body === "string" ? body : JSON.stringify(body));
  });
const hasCurl = spawnSync("sh", ["-c", "command -v curl"]).status === 0;

test("hook payloads sent to the socket are handled in-process", async () => {
  const hub = await startHubServer();
  try {
    assert.equal((fs.statSync(P.socket).mode & 0o777).toString(8), "600");
    const r = await post(P.socket, "/hook/claude-code", { hook_event_name: "Notification", session_id: "h1", cwd: "/x/shop", message: "Claude needs your permission to use Bash" });
    assert.equal(r.status, 202);
    await hub.idle();
    assert.equal(spoken().at(-1), "shop needs your permission to use Bash.");
    assert.equal(getSession("claude-code", "h1").status, "waiting");

    await post(P.socket, "/emit", { agent: "aider", type: "info", project: "docs", line: "Docs rebuilt." });
    await hub.idle();
    assert.equal(spoken().at(-1), "Docs rebuilt.");

    assert.equal((await post(P.socket, "/hook/claude-code", "{not json")).status, 400);
    assert.equal((await post(P.socket, "/hook/..%2Fetc", {})).status, 400);
    assert.equal((await post(P.socket, "/emit", { type: "nope" })).status, 400);
    assert.equal((await post(P.socket, "/nowhere", {})).status, 404);
  } finally {
    await hub.close();
  }
  assert.equal(fs.existsSync(P.socket), false);
});

test("only one hub per socket; a stale socket file is replaced", async () => {
  const a = await startHubServer();
  await assert.rejects(startHubServer(), /already running/);
  await a.close();
  fs.writeFileSync(P.socket, ""); // crash leftover
  const b = await startHubServer();
  await b.close();
});

test("the shim is recognised as an Earpiece hook, so installs replace instead of doubling", () => {
  assert.ok(isOurCommand(`"${home}/bin/earpiece-hook" hook claude-code`));
  assert.ok(isOurCommand(`notify = ["${home}/bin/earpiece-hook", "codex"]`));
  assert.ok(!isOurCommand(`"/usr/local/bin/earpiece-hookup" deploy`));
});

test("shim sends to the hub when it is running", { skip: !hasCurl && "no curl" }, async () => {
  const shim = writeShim({ fallback: ["/nonexistent/node", BIN] }); // fallback unusable: only the socket can speak
  const hub = await startHubServer();
  try {
    // Async spawn: the hub lives in this process, so blocking on the shim would starve it.
    const started = Date.now();
    const child = spawn(shim, ["hook", "claude-code"], { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end(JSON.stringify({ hook_event_name: "Notification", session_id: "h2", cwd: "/x/cart", message: "Claude needs your permission to use Edit" }));
    const code = await new Promise((res) => child.once("exit", res));
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 1500, "shim should not wait for curl's timeout");
    await hub.idle();
    assert.equal(spoken().at(-1), "cart needs your permission to use Edit.");
  } finally {
    await hub.close();
  }
});

test("shim falls back to the core when no hub is running, and always exits 0", () => {
  const env = { ...process.env, EARPIECE_HOME: home, EARPIECE_FOREGROUND: "1" };
  const shim = writeShim({ fallback: [process.execPath, BIN] });
  const r = spawnSync(shim, ["hook", "claude-code"], {
    env,
    input: JSON.stringify({ hook_event_name: "Notification", session_id: "h3", cwd: "/x/admin", message: "Claude needs your permission to use Write" }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(spoken().at(-1), "admin needs your permission to use Write.");
  const forwarded = spawnSync(shim, ["codex", "{}"], { env: { ...env, EARPIECE_FORWARDED: "1" } });
  assert.equal(forwarded.status, 0);
  const broken = writeShim({ fallback: ["/nonexistent/node", BIN] }, path.join(home, "bin", "broken-hook"));
  assert.equal(spawnSync(broken, ["hook"], { input: "{}" }).status, 0);
});
