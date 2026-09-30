import assert from "node:assert/strict";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

tempHome();
const { plainFirstSentence, parseFlags, projectName, safeId, ago } = await import("../src/util.mjs");
const { endsWithQuestion, normalizeEvent } = await import("../src/hub/events.mjs");

test("plainFirstSentence strips markdown, code and paths", () => {
  const t = "**Done.** Updated `cart.ts` in /Users/me/code/shop/src/cart.ts and more.\n```js\nx\n```";
  assert.equal(plainFirstSentence(t), "Done. Updated cart.ts in cart.ts and more."); // very short first sentences are kept with the next
  assert.equal(plainFirstSentence("Refactored the cart drawer in /a/b/cart.ts, tests pass."), "Refactored the cart drawer in cart.ts, tests pass.");
  assert.ok(plainFirstSentence("word ".repeat(100), 40).length <= 41);
});

test("parseFlags handles values, switches and --k=v", () => {
  const { flags, words } = parseFlags(["--agent", "codex", "--all", "--lang=hi", "hello", "world"], ["agent"]);
  assert.deepEqual(flags, { agent: "codex", all: true, lang: "hi" });
  assert.deepEqual(words, ["hello", "world"]);
});

test("projectName, safeId, ago", () => {
  assert.equal(projectName("/x/checkout-service"), "checkout service");
  assert.equal(projectName(undefined), "Terminal");
  assert.equal(safeId("a/b c"), "a_b_c");
  assert.equal(ago(90_000), "2m");
});

test("normalizeEvent defaults session and validates type", () => {
  const e = normalizeEvent({ type: "turn_end", cwd: "/x/api" }, "aider");
  assert.equal(e.agent, "aider");
  assert.equal(e.session, "/x/api");
  assert.ok(e.at > 0);
  assert.throws(() => normalizeEvent({ type: "nope" }, "a"), /unknown event type/);
});

test("endsWithQuestion", () => {
  assert.ok(endsWithQuestion("Should I migrate it?"));
  assert.ok(endsWithQuestion('Want me to push? "'));
  assert.ok(!endsWithQuestion("Pushed. Why? Because."));
});
