import assert from "node:assert/strict";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

tempHome();
const { phrase, SCRIPT, isKnownLang, ttsLang } = await import("../src/i18n.mjs");
const { inQuietHours, policyBlock, setMode, currentMode } = await import("../src/policy.mjs");
const { agentConfig, config } = await import("../src/config.mjs");

test("phrases fall back to English", () => {
  assert.equal(phrase({ speakLanguage: "en" }, "waiting", "api").text, "api is waiting for you.");
  const h = phrase({ speakLanguage: "hinglish" }, "waiting", "api");
  assert.ok(SCRIPT.hinglish.test(h.text));
  assert.equal(phrase({ speakLanguage: "ta" }, "waiting", "api").lang, "en");
  assert.ok(isKnownLang("hinglish") && isKnownLang("ta") && !isKnownLang("xx"));
  assert.equal(ttsLang("hinglish"), "hi");
});

test("quiet hours wrap midnight", () => {
  const qh = { start: "23:00", end: "08:00" };
  const at = (h, m = 0) => new Date(2026, 0, 1, h, m);
  assert.ok(inQuietHours(qh, at(23, 30)));
  assert.ok(inQuietHours(qh, at(7, 59)));
  assert.ok(!inQuietHours(qh, at(8)));
  assert.ok(!inQuietHours(null, at(2)));
});

test("modes gate kinds", () => {
  const cfg = { quietHours: null };
  setMode("quiet", 10);
  assert.equal(currentMode(), "quiet");
  assert.equal(policyBlock("done", cfg), "mode_quiet");
  assert.equal(policyBlock("needs_input", cfg), null);
  setMode("off");
  assert.equal(policyBlock("needs_input", cfg), "mode_off");
  setMode("on");
  assert.equal(policyBlock("done", cfg), null);
  assert.equal(policyBlock("done", { quietHours: { start: "00:00", end: "23:59" } }, new Date(2026, 0, 1, 12)), "quiet_hours");
});

test("agentConfig applies per-agent overrides", () => {
  const base = { ...config(), agents: { codex: { voice: "v2", minTurnSeconds: 0, enabled: false, label: "Cx" } } };
  const c = agentConfig(base, "codex");
  assert.equal(c.smallest.voice, "v2");
  assert.equal(c.minTurnSeconds, 0);
  assert.equal(c.enabled, false);
  assert.equal(c.label, "Cx");
  const d = agentConfig(base, "claude-code");
  assert.equal(d.smallest.voice, "meher");
  assert.equal(d.enabled, true);
});
