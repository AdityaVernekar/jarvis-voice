// Marking a session done or forgetting it from the app.
import assert from "node:assert/strict";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

tempHome();
const { updateSession, getSession, setSessionStatus, forgetSession } = await import("../src/hub/sessions.mjs");
const { processEvent } = await import("../src/hub/hub.mjs");
const { stripLeadIn } = await import("../src/card.mjs");

test("mark done turns a waiting session done", () => {
  updateSession("claude-desktop", "t1", { status: "waiting", project: "Earpiece MCP test" });
  setSessionStatus("claude-desktop", "t1", "done");
  const s = getSession("claude-desktop", "t1");
  assert.equal(s.status, "done");
  assert.ok(s.markedByUser);
});

test("only done or idle, and only sessions that exist", () => {
  assert.throws(() => setSessionStatus("claude-desktop", "t1", "working"), /status must be/);
  assert.throws(() => setSessionStatus("claude-desktop", "nope", "done"), /no such session/);
});

test("marking done drops a needs-you line that was still queued", async () => {
  const at = Date.now() - 1000;
  updateSession("codex", "q1", { status: "waiting", activeAt: at - 1000 });
  setSessionStatus("codex", "q1", "done");
  const r = await processEvent({ v: 1, type: "needs_input", agent: "codex", session: "q1", at, text: "Needs approval." });
  assert.equal(r.skipped, "resolved");
});

test("forget removes the session file", () => {
  updateSession("codex", "f1", { status: "error" });
  forgetSession("codex", "f1");
  assert.equal(getSession("codex", "f1"), null);
});

test("the row's line drops the agent and project lead-in", () => {
  assert.equal(stripLeadIn("Claude, Earpiece MCP test. Which option do you want?", { agentName: "Claude Desktop", project: "Earpiece MCP test" }), "Which option do you want?");
  assert.equal(stripLeadIn("Tests pass. Ship it.", { agentName: "Codex", project: "shop" }), "Tests pass. Ship it.");
});
