// The floating card: speak() and the hub leave the last line in card.json for the Mac app.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

const home = tempHome();
const { speak } = await import("../src/voice/speak.mjs");
const { readCard } = await import("../src/card.mjs");
const { setMode } = await import("../src/policy.mjs");
const { processEvent } = await import("../src/hub/hub.mjs");

test("a spoken line leaves a finished card with the agent and project", async () => {
  await speak("Cleaned up the pricing page.", "done", { agent: "codex", project: "shop", session: "s1" });
  const c = readCard();
  assert.equal(c.line, "Cleaned up the pricing page.");
  assert.equal(c.state, "spoken");
  assert.equal(c.agent, "codex");
  assert.equal(c.project, "shop");
  assert.ok(c.id && c.at);
  assert.equal((fs.statSync(path.join(home, "card.json")).mode & 0o777).toString(8), "600");
});

test("quiet mode still shows a silent card, off shows nothing new", async () => {
  setMode("quiet", 10);
  try {
    const r = await speak("Renamed the files.", "done", { agent: "codex", project: "shop" });
    assert.equal(r.skipped, "mode_quiet");
    const c = readCard();
    assert.equal(c.line, "Renamed the files.");
    assert.equal(c.state, "silent");
    assert.equal(c.reason, "mode_quiet");
    setMode("off");
    await speak("Something else.", "done", { agent: "codex" });
    assert.equal(readCard().line, "Renamed the files.", "off means no card either");
  } finally {
    setMode("on");
  }
});

test("quiet mode never speaks, not even for needs you or an error, but keeps their colour", async () => {
  setMode("quiet", 10);
  try {
    for (const kind of ["needs_input", "error"]) {
      const r = await speak(`A ${kind} line.`, kind, { agent: "codex", project: "shop" });
      assert.equal(r.skipped, "mode_quiet", kind);
      const c = readCard();
      assert.equal(c.line, `A ${kind} line.`);
      assert.equal(c.state, "silent");
      assert.equal(c.kind, kind);
    }
  } finally {
    setMode("on");
  }
});

test("a muted agent gets a silent card from the hub", async () => {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ quietHours: null, chimes: false, agents: { mcpish: { enabled: false } } }));
  await processEvent({ agent: "mcpish", type: "turn_end", session: "a", project: "Docs", line: "Docs. Wrote the guide." });
  const c = readCard();
  assert.equal(c.state, "silent");
  assert.equal(c.reason, "agent_disabled");
  assert.equal(c.project, "Docs");
});

test("the card drops the spoken lead-in because it shows the agent and project itself", async () => {
  const { cardPayload } = await import("../src/card.mjs");
  const base = { id: "1", kind: "done", state: "spoken", agent: "codex" };
  assert.equal(cardPayload({ ...base, line: "Codex, shop. Fixed the bug." }, { agentName: "Codex", project: "shop" }).line, "Fixed the bug.");
  assert.equal(cardPayload({ ...base, line: "shop. Fixed the bug." }, { agentName: "Codex", project: "shop" }).line, "Fixed the bug.");
  assert.equal(cardPayload({ ...base, line: "Tests pass. Ship it." }, { agentName: "Codex", project: "shop" }).line, "Tests pass. Ship it.");
  assert.equal(cardPayload({ ...base, line: "Fixed it." }, { agentName: "Codex", project: "shop" }).agentId, "codex");
});
