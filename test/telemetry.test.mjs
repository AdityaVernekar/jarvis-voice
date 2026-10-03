// Anonymous usage stats: what is sent, and that opting out sends nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { createTelemetry, enabled, ENDPOINT, KEY } from "../app/main/telemetry.mjs";

const INFO = { version: "0.4.0", osVersion: "15.1.0", arch: "arm64", locale: "en-US", agents: ["claude-code", "codex"] };

function setup(prefs = {}, { ok = true, fail = false } = {}) {
  const calls = [];
  const saved = [];
  const t = createTelemetry({
    getPrefs: () => prefs,
    saveInstallId: (id) => (saved.push(id), (prefs.installId = id)),
    info: () => INFO,
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      if (fail) throw new Error("offline");
      return { ok };
    },
  });
  return { t, calls, saved };
}

test("sends only the documented fields, to the pings table with the publishable key", async () => {
  const { t, calls } = setup({ installId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(await t.ping(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].opts.headers.apikey, KEY);
  assert.match(KEY, /^sb_publishable_/); // never a secret / service_role key
  assert.deepEqual(JSON.parse(calls[0].opts.body), {
    install_id: "11111111-1111-4111-8111-111111111111",
    app_version: "0.4.0",
    macos_version: "15.1.0",
    arch: "arm64",
    locale: "en-US",
    agents: ["claude-code", "codex"],
  });
});

test("makes a random install id once and reuses it", async () => {
  const { t, calls, saved } = setup({});
  await t.ping();
  await t.ping();
  assert.equal(saved.length, 1);
  assert.match(saved[0], /^[0-9a-f-]{36}$/);
  const ids = calls.map((c) => JSON.parse(c.opts.body).install_id);
  assert.deepEqual(ids, [saved[0], saved[0]]);
});

test("opted out: nothing is sent and no id is made", async () => {
  const { t, calls, saved } = setup({ shareStats: false });
  assert.equal(await t.ping(), false);
  assert.equal(calls.length, 0);
  assert.equal(saved.length, 0);
  assert.equal(enabled(undefined, { EARPIECE_TELEMETRY: "0" }), false);
  assert.equal(enabled(undefined, {}), true);
});

test("network failures and same-day repeats (409) are swallowed", async () => {
  assert.equal(await setup({}, { fail: true }).t.ping(), false);
  assert.equal(await setup({}, { ok: false }).t.ping(), false);
});
