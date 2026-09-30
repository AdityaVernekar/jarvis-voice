// 0.2.2: answered alerts are dropped, secrets are redacted, quiet hours can be fully silent.
import assert from "node:assert/strict";
import test from "node:test";
import { readLog, tempHome } from "./helpers.mjs";

const home = tempHome();
const { redact } = await import("../src/util.mjs");
const { ingest, ingestEvent, processEvent, answered } = await import("../src/hub/hub.mjs");
const { getSession, updateSession } = await import("../src/hub/sessions.mjs");
const { normalizeEvent } = await import("../src/hub/events.mjs");
const { policyBlock, quietAllows } = await import("../src/policy.mjs");
const { speak } = await import("../src/voice/speak.mjs");
const { default: claude } = await import("../src/adapters/claude-code.mjs");

const spoken = () => readLog(home).filter((e) => e.spoke).map((e) => e.spoke);
const hook = (event, extra = {}) => ingest("claude-code", { hook_event_name: event, session_id: "r1", cwd: "/x/api", ...extra });
const permission = (tool, at) => normalizeEvent({ type: "needs_input", tool, project: "api", session: "r1", at }, "claude-code");

test("redact removes common secret shapes and leaves prose alone", () => {
  const cases = [
    "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
    "github_pat_" + "11ABCDEFG0123456789_abcdefghijklmnop",
    "AKIA" + "IOSFODNN7EXAMPLE",
    "xoxb-" + "123456789012-abcdefghij",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "sk-" + "proj-abcdef123456",
    "a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0",
  ];
  for (const s of cases) assert.equal(redact(`token is ${s} ok`).includes(s), false, s);
  assert.equal(redact("OPENAI_API_KEY=abcd1234efgh"), "OPENAI_API_KEY=[redacted]");
  assert.equal(redact('"password": "hunter22"'), '"password": "[redacted]"');
  assert.equal(redact("postgres://admin:s3cret@db.local/app"), "postgres://[redacted]@db.local/app");
  const prose = "Refactored the checkout drawer and fixed 3 failing tests in the payments module.";
  assert.equal(redact(prose), prose);
});

test("speak never says a secret out loud", async () => {
  await speak("api. Set GITHUB_TOKEN=ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 in CI.", "info", { force: true });
  assert.equal(spoken().at(-1), "api. Set GITHUB_TOKEN=[redacted] in CI.");
});

test("a permission alert answered in the terminal is not spoken", async () => {
  const t = Date.now();
  const n = spoken().length;
  updateSession("claude-code", "r1", { activeAt: t + 500, activeTool: "Bash" });
  const r = await processEvent(permission("Bash", t));
  assert.equal(r.skipped, "resolved");
  assert.equal(spoken().length, n);
});

test("activity from a different tool does not drop the alert", async () => {
  const t = Date.now() + 10_000;
  updateSession("claude-code", "r1", { activeAt: t + 500, activeTool: "Read" });
  await processEvent(permission("Bash", t));
  assert.equal(spoken().at(-1), "api needs your permission to use Bash.");
});

test("a new prompt resolves any pending alert", () => {
  const ev = { at: 1000, tool: "Bash" };
  assert.equal(answered(ev, { activeAt: 2000, activeTool: null }), true);
  assert.equal(answered(ev, { activeAt: 900, activeTool: null }), false);
  assert.equal(answered(ev, {}), false);
});

test("PostToolUse is recorded as activity, never spoken, and clears waiting", async () => {
  await hook("Notification", { message: "Claude needs your permission to use Edit", session_id: "r2" });
  assert.equal(getSession("claude-code", "r2").status, "waiting");
  const n = spoken().length;
  const r = await hook("PostToolUse", { tool_name: "Edit", session_id: "r2" });
  assert.equal(r[0].type, "activity");
  assert.equal(readLog(home).some((e) => e.type === "activity"), false);
  assert.equal(spoken().length, n);
  const s = getSession("claude-code", "r2");
  assert.deepEqual([s.status, s.activeTool], ["working", "Edit"]);
  assert.deepEqual(claude.toEvents({ hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash" }).map((e) => [e.type, e.tool]), [["activity", "Bash"]]);
});

test("quiet hours: default lets needs_input through, allow [] is fully silent", () => {
  const noon = new Date(2026, 0, 1, 12, 0);
  const allDay = { start: "00:00", end: "23:59" };
  assert.equal(policyBlock("needs_input", { quietHours: allDay }, noon), null);
  assert.equal(policyBlock("done", { quietHours: allDay }, noon), "quiet_hours");
  assert.equal(policyBlock("needs_input", { quietHours: { ...allDay, allow: [] } }, noon), "quiet_hours");
  assert.equal(policyBlock("error", { quietHours: { ...allDay, allow: ["error"] } }, noon), null);
  assert.equal(quietAllows({ allow: [] }, "needs_input"), false);
});
