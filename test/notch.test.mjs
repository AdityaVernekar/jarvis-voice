// The resting notch icon and its agents list.
import assert from "node:assert/strict";
import test from "node:test";
import { notchAgents, parseFrontApp, RECENT_MS } from "../src/notch.mjs";

const NOW = 1_800_000_000_000;
const row = (session, status, agoMs, extra = {}) => ({ agent: "Codex", agentId: "codex", session, project: "shop", status, updated: NOW - agoMs, lastLine: "Fixed it.", ...extra });

test("lists running agents and recently finished ones, not old idle ones", () => {
  const r = notchAgents([row("a", "working", 2 * 3600_000), row("b", "done", 5 * 60_000), row("c", "done", RECENT_MS + 1), row("d", "idle", 3600_000)], { now: NOW });
  assert.deepEqual(r.rows.map((x) => x.session), ["a", "b"]);
  assert.equal(r.active, 1);
  assert.equal(r.tone, "working");
});

test("waiting comes first and colours the icon", () => {
  const r = notchAgents([row("w1", "working", 1000), row("q", "waiting", 90_000), row("e", "error", 5000)], { now: NOW });
  assert.deepEqual(r.rows.map((x) => x.status), ["waiting", "error", "working"]);
  assert.equal(r.tone, "waiting");
  assert.equal(r.waiting, 1);
  assert.equal(r.active, 3);
});

test("error beats working; nothing running is idle", () => {
  assert.equal(notchAgents([row("a", "working", 1), row("b", "error", 1)], { now: NOW }).tone, "error");
  const empty = notchAgents([], { now: NOW });
  assert.equal(empty.tone, "idle");
  assert.deepEqual(empty.rows, []);
  assert.equal(notchAgents(undefined, { now: NOW }).active, 0);
});

test("caps the list and counts the rest", () => {
  const rows = Array.from({ length: 9 }, (_, i) => row(`s${i}`, "working", i * 1000));
  const r = notchAgents(rows, { now: NOW, max: 6 });
  assert.equal(r.rows.length, 6);
  assert.equal(r.more, 3);
  assert.equal(r.rows[0].session, "s0"); // newest first within a status
});

test("skips rows without an agent or session and trims long lines", () => {
  const r = notchAgents([{ status: "working" }, row("ok", "working", 1, { lastLine: "x".repeat(500) })], { now: NOW });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].lastLine.length, 200);
});

test("reads the frontmost app from lsappinfo output", () => {
  const out = `"iTerm2" ASN:0x0-0x1f01f:\n    bundleID="com.googlecode.iterm2"\n    bundle path="/Applications/iTerm.app"\n    pid = 1234 type="Foreground" flavor=3\n`;
  assert.deepEqual(parseFrontApp(out), { bundleId: "com.googlecode.iterm2", pid: 1234 });
  assert.equal(parseFrontApp(""), null);
  assert.equal(parseFrontApp('bundleID="bad id; rm"'), null);
});
