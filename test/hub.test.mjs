import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { readLog, tempHome } from "./helpers.mjs";

const home = tempHome({ quietHours: null, chimes: false, agents: { muted: { enabled: false }, codex: { label: "Cx" } } });
const { ingest, ingestEvent } = await import("../src/hub/hub.mjs");
const { getSession, listSessions, updateSession } = await import("../src/hub/sessions.mjs");
const { normalizeEvent } = await import("../src/hub/events.mjs");

const spoken = () => readLog(home).filter((e) => e.spoke).map((e) => e.spoke);
const claude = (event, extra = {}) => ingest("claude-code", { hook_event_name: event, session_id: "s1", cwd: "/x/checkout-service", ...extra });

test("short Claude turns stay silent; long ones are summarised", async () => {
  await claude("UserPromptSubmit");
  assert.equal(getSession("claude-code", "s1").status, "working");
  await claude("Stop", { last_assistant_message: "Done quickly." });
  assert.equal(getSession("claude-code", "s1").status, "done");
  assert.equal(spoken().length, 0);
  assert.ok(readLog(home).some((e) => e.skipped === "short_turn"));

  await claude("UserPromptSubmit");
  updateSession("claude-code", "s1", { turnStart: Date.now() - 120_000 });
  await claude("Stop", { last_assistant_message: "Refactored the cart drawer. More detail here." });
  assert.equal(spoken().at(-1), "checkout service. Refactored the cart drawer.");
  assert.equal(getSession("claude-code", "s1").lastDurationMs >= 120_000, true);
});

test("idle after an announced turn is not repeated", async () => {
  const before = spoken().length;
  await claude("Notification", { message: "Claude is waiting for your input" });
  assert.equal(spoken().length, before);
  assert.equal(getSession("claude-code", "s1").status, "done");
});

test("permission prompts speak and mark the session waiting", async () => {
  await ingest("claude-code", { hook_event_name: "Notification", session_id: "s2", cwd: "/x/api", message: "Claude needs your permission to use Bash" });
  assert.equal(spoken().at(-1), "api needs your permission to use Bash.");
  assert.equal(getSession("claude-code", "s2").status, "waiting");
});

test("codex turns always speak, a question marks the session waiting, labels prefix the line", async () => {
  await ingest("codex", { type: "agent-turn-complete", "thread-id": "t1", cwd: "/x/billing", "last-assistant-message": "Should I migrate invoices?" });
  assert.equal(spoken().at(-1), "Cx, billing. Should I migrate invoices?");
  assert.equal(getSession("codex", "t1").status, "waiting");
});

test("generic agents, disabled agents and exact lines", async () => {
  await ingestEvent(normalizeEvent({ type: "turn_end", project: "docs", line: "Docs rebuilt.", durationMs: 60_000 }, "aider"));
  assert.equal(spoken().at(-1), "Docs rebuilt.");
  const n = spoken().length;
  await ingestEvent(normalizeEvent({ type: "turn_end", project: "p", line: "Should not speak.", durationMs: 60_000 }, "muted"));
  assert.equal(spoken().length, n);
  assert.equal(getSession("muted", "p").status, "done");
  assert.ok(readLog(home).some((e) => e.skipped === "agent_disabled"));
});

test("duplicate lines within a minute are dropped", async () => {
  const ev = () => normalizeEvent({ type: "info", project: "x", line: "Same line." }, "aider");
  await ingestEvent(ev());
  await ingestEvent(ev());
  assert.equal(spoken().filter((l) => l === "Same line.").length, 1);
});

test("listSessions sorts by recency and ignores foreign files", () => {
  fs.writeFileSync(path.join(home, "sessions", "legacy.json"), JSON.stringify({ turnStart: 1 }));
  const all = listSessions();
  assert.ok(all.length >= 4);
  assert.ok(all.every((s) => s.agent));
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].updated >= all[i].updated);
});

test("queued lines are dropped when stale, flushed, or muted while waiting", async () => {
  const { speak } = await import("../src/voice/speak.mjs");
  const { P } = await import("../src/paths.mjs");
  assert.equal((await speak("Old news one.", "done", { queuedAt: Date.now() - 5 * 60_000 })).skipped, "stale");
  fs.writeFileSync(P.flushed, JSON.stringify({ at: Date.now() }));
  assert.equal((await speak("Flushed one.", "done", { queuedAt: Date.now() - 1000 })).skipped, "flushed");
  assert.ok((await speak("Fresh one.", "done", { queuedAt: Date.now() + 5 })).spoke);
});
