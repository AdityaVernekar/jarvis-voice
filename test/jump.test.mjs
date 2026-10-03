// Click the card → the agent's window. Only the plan and the fallbacks run here; the AppleScript
// itself needs a Mac.
import assert from "node:assert/strict";
import test from "node:test";
import { activateArgs, itermGuid, jumpPlan, jumpTo } from "../src/hub/jump.mjs";
import { isTitleTurn } from "../src/adapters/codex.mjs";

const ITERM = { id: "iterm2", name: "iTerm2", bundle: "com.googlecode.iterm2", editor: false };
const TERMINAL = { id: "terminal", name: "Terminal", bundle: "com.apple.Terminal", editor: false };
const CURSOR = { id: "cursor", name: "Cursor", bundle: "com.todesktop.230313mzl4w4u92", editor: true };

test("iTerm2: the exact session by GUID, ids passed as arguments, then the app", () => {
  const steps = jumpPlan({ origin: { app: ITERM, iterm: "w0t1p0:3F2A0C1E-1111-2222-3333-444455556666", tabTty: "/dev/ttys004" } });
  assert.deepEqual(steps.map((s) => s.how), ["iterm2-tab", "app"]);
  const [cmd, args] = [steps[0].cmd, steps[0].args];
  assert.equal(cmd, "osascript");
  assert.equal(args[0], "-e");
  assert.match(args[1], /on run argv/);
  assert.ok(!args[1].includes("3F2A0C1E"), "the id is never pasted into the script");
  assert.deepEqual(args.slice(2), ["3F2A0C1E-1111-2222-3333-444455556666", "/dev/ttys004"]);
  assert.deepEqual(steps[1].args, ["-b", "com.googlecode.iterm2"]);
});

test("iTerm2 under tmux ignores the stale session id and uses the client's tty", () => {
  const steps = jumpPlan({ origin: { app: ITERM, iterm: "w0t0p0:AAAAAAAA-0000", tabTty: "/dev/ttys009", tmux: { session: "main" } } });
  assert.deepEqual(steps[0].args.slice(2), ["", "/dev/ttys009"]);
});

test("Terminal.app: the tab by tty; a bad tty is never passed on", () => {
  assert.deepEqual(jumpPlan({ origin: { app: TERMINAL, tabTty: "/dev/ttys002" } })[0].args.slice(2), ["/dev/ttys002"]);
  assert.deepEqual(jumpPlan({ origin: { app: TERMINAL, tabTty: "/dev/ttys002; rm -rf ~" } }).map((s) => s.how), ["app"]);
});

test("editors open the session's folder, which focuses the window that has it", () => {
  const steps = jumpPlan({ origin: { app: CURSOR }, cwd: "/Users/me/shop" });
  assert.equal(steps[0].how, "editor-window");
  assert.deepEqual(steps[0].args, ["-b", CURSOR.bundle, "/Users/me/shop"]);
  assert.deepEqual(jumpPlan({ origin: { app: CURSOR }, cwd: "relative/dir" }).map((s) => s.how), ["app"]);
});

test("apps without a bundle id come forward by path or name; Claude Desktop sessions without an origin too", () => {
  assert.deepEqual(activateArgs({ id: "other", name: "ChatGPT", bundle: null, path: "/Applications/ChatGPT.app" }), ["-a", "/Applications/ChatGPT.app"]);
  assert.deepEqual(activateArgs({ id: "other", name: "ChatGPT", bundle: null }), ["-a", "ChatGPT"]);
  assert.deepEqual(activateArgs({ id: "codex-app", name: "Codex app", bundle: null }), ["-a", "Codex"]);
  assert.equal(activateArgs({ id: "other", name: "../../evil", bundle: null }), null);
  assert.deepEqual(jumpPlan({ agent: "claude-desktop" })[0].args, ["-b", "com.anthropic.claudefordesktop"]);
  assert.deepEqual(jumpPlan({ agent: "codex" }), []);
});

test("itermGuid takes the part after the colon and rejects junk", () => {
  assert.equal(itermGuid("w0t1p0:ABCDEF12-3456"), "ABCDEF12-3456");
  assert.equal(itermGuid("w0t1p0:\" & do shell script \"x"), "");
});

test("jumpTo falls back from a closed tab to the app, and reports when nothing works", async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(cmd);
    return cmd === "osascript" ? "missing\n" : "";
  };
  const r = await jumpTo({ origin: { app: TERMINAL, tabTty: "/dev/ttys002" } }, { run });
  assert.deepEqual(r, { ok: true, how: "app", precision: "app" });
  assert.deepEqual(calls, ["osascript", "open"]);

  const denied = async () => {
    throw Object.assign(new Error("failed"), { stderr: "execution error: Not authorized to send Apple events to Terminal. (-1743)" });
  };
  const r2 = await jumpTo({ origin: { app: TERMINAL, tabTty: "/dev/ttys002" } }, { run: denied });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /Automation/);
  assert.equal((await jumpTo({ agent: "codex" }, { run })).ok, false);
});

test("a missing folder isn't opened (it would make a new editor window)", async () => {
  const seen = [];
  await jumpTo({ origin: { app: CURSOR }, cwd: "/gone" }, { run: async (c, a) => (seen.push(a), ""), exists: () => false });
  assert.deepEqual(seen, [["-b", CURSOR.bundle]]);
});

test("Codex's thread-title turn is not an update", () => {
  assert.equal(isTitleTurn('{"title":"Fix the checkout retry"}'), true);
  assert.equal(isTitleTurn(' {"title": "x"} '), true);
  assert.equal(isTitleTurn('{"title":"x","body":"y"}'), false);
  assert.equal(isTitleTurn("Fixed the title bug."), false);
  assert.equal(isTitleTurn("{not json}"), false);
});
