// Which editor window a click brings forward. Fixture files stand in for each editor's state, so
// none of this needs a Mac or an editor installed.
import assert from "node:assert/strict";
import test from "node:test";
import { chooseEditorTarget, editorFor, editorWindows, EDITORS, isWithin, normPath, parseJsonc, uriToPath, vscodeWindows } from "../src/hub/editors.mjs";
import { classifyApp } from "../src/hub/origin.mjs";
import { jumpPlan, jumpTo, resolveTarget } from "../src/hub/jump.mjs";

const HOME = "/Users/me";
const CURSOR_DIR = `${HOME}/Library/Application Support/Cursor`;
const CURSOR = { id: "cursor", name: "Cursor", bundle: "com.todesktop.230313mzl4w4u92", editor: true };
const plain = (p) => normPath(p, { realpath: () => null });
const opts = { norm: plain, isRepoRoot: () => false };

function files(map) {
  return (f) => {
    if (!(f in map)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return typeof map[f] === "string" ? map[f] : JSON.stringify(map[f]);
  };
}

const storage = {
  windowsState: {
    lastActiveWindow: { folder: "file:///Users/me/Documents/earpiece", backupPath: "x" },
    openedWindows: [{ folder: "file:///Users/me/shop" }, { folder: "vscode-remote://ssh-remote%2Bbox/home/me/api" }],
  },
};
const backupsNew = {
  folders: [{ folderUri: "file:///Users/me/Documents/earpiece" }, { folderUri: "file:///Users/me/notes%20%26%20docs" }],
  workspaces: [{ id: "abc", configURIPath: "file:///Users/me/mono.code-workspace" }],
  emptyWindows: [{ backupFolder: "123" }],
};
const workspaceFile = `{
  // two roots
  "folders": [
    { "path": "packages/web" },
    { "path": "/Users/me/elsewhere", },
  ],
  "settings": { "x": "a // not a comment" },
}`;

const fixture = files({
  [`${CURSOR_DIR}/User/globalStorage/storage.json`]: storage,
  [`${CURSOR_DIR}/Backups/workspaces.json`]: backupsNew,
  "/Users/me/mono.code-workspace": workspaceFile,
});

test("every editor row is complete and recognised as an origin", () => {
  for (const e of EDITORS) {
    assert.ok(e.id && e.name && e.bundle && e.family && e.support && e.names?.length, e.id);
    const app = classifyApp({ appName: e.names === EDITORS.find((x) => x.id === "vscode").names ? "Visual Studio Code" : e.name, bundle: e.bundle });
    assert.equal(app.editor, true, e.id);
  }
  assert.equal(classifyApp({ appName: "Visual Studio Code - Insiders" }).id, "vscode-insiders");
  assert.equal(classifyApp({ appName: "Visual Studio Code" }).id, "vscode");
  assert.equal(classifyApp({ appName: "Cursor" }).id, "cursor");
  assert.equal(editorFor({ id: "other", bundle: "COM.TODESKTOP.230313MZL4W4U92" }).id, "cursor");
  assert.equal(editorFor({ id: "iterm2", bundle: "com.googlecode.iterm2" }), null);
});

test("reads open windows from both state files, newest first, skipping remote and empty windows", () => {
  const ws = vscodeWindows(CURSOR_DIR, { readFile: fixture });
  const opens = ws.map((w) => w.open);
  assert.equal(opens[0], "/Users/me/Documents/earpiece"); // last active
  assert.ok(opens.includes("/Users/me/shop"));
  assert.ok(opens.includes("/Users/me/notes & docs"));
  assert.ok(opens.includes("/Users/me/mono.code-workspace"));
  assert.ok(!opens.some((o) => o.includes("api")), "remote windows are skipped");
  assert.equal(opens.filter((o) => o === "/Users/me/Documents/earpiece").length, 1, "one entry per window");
  const mono = ws.find((w) => w.open.endsWith(".code-workspace"));
  assert.deepEqual(mono.folders, ["/Users/me/packages/web", "/Users/me/elsewhere"]);
});

test("the older backups format works too", () => {
  const old = files({ [`${CURSOR_DIR}/Backups/workspaces.json`]: { rootURIWorkspaces: [{ id: "1", configURIPath: "file:///Users/me/a.code-workspace" }], folderURIWorkspaces: ["file:///Users/me/b"] }, "/Users/me/a.code-workspace": { folders: [{ uri: "file:///Users/me/c" }] } });
  const ws = vscodeWindows(CURSOR_DIR, { readFile: old });
  assert.deepEqual(ws.map((w) => w.open).sort(), ["/Users/me/a.code-workspace", "/Users/me/b"]);
  assert.deepEqual(ws.find((w) => w.open === "/Users/me/a.code-workspace").folders, ["/Users/me/c"]);
});

test("missing, broken or half-written files mean no windows, not a crash", () => {
  assert.deepEqual(vscodeWindows(CURSOR_DIR, { readFile: files({}) }), []);
  assert.deepEqual(vscodeWindows(CURSOR_DIR, { readFile: files({ [`${CURSOR_DIR}/User/globalStorage/storage.json`]: '{"windowsState": {"openedWin' }) }), []);
  assert.deepEqual(editorWindows({ family: "jetbrains", support: "x" }), []);
});

test("a subfolder of an open window brings that window forward, not a new one", () => {
  const ws = vscodeWindows(CURSOR_DIR, { readFile: fixture });
  assert.deepEqual(chooseEditorTarget("/Users/me/Documents/earpiece/app", ws, opts), { open: "/Users/me/Documents/earpiece", why: "window-root" });
  assert.deepEqual(chooseEditorTarget("/Users/me/Documents/earpiece/landing-page/src", ws, opts), { open: "/Users/me/Documents/earpiece", why: "window-root" });
  assert.deepEqual(chooseEditorTarget("/Users/me/shop", ws, opts), { open: "/Users/me/shop", why: "window" });
  // A root of a multi-root workspace opens the workspace file.
  assert.deepEqual(chooseEditorTarget("/Users/me/packages/web/src", ws, opts), { open: "/Users/me/mono.code-workspace", why: "window-root" });
});

test("the deepest root wins; on a tie the newest window", () => {
  const ws = [
    { open: "/r", folders: ["/r"], at: 3 },
    { open: "/r/app", folders: ["/r/app"], at: 1 },
    { open: "/x.code-workspace", folders: ["/r/app"], at: 2 },
  ];
  assert.equal(chooseEditorTarget("/r/app/src", ws, opts).open, "/x.code-workspace");
  assert.equal(chooseEditorTarget("/r/lib", ws, opts).open, "/r");
});

test("no window holds the folder: a repo root opens, anything else only brings the editor forward", () => {
  assert.deepEqual(chooseEditorTarget("/Users/me/new-repo", [], { norm: plain, isRepoRoot: (d) => d === "/Users/me/new-repo" }), { open: "/Users/me/new-repo", why: "repo-root" });
  assert.equal(chooseEditorTarget("/Users/me/new-repo/src", [], { norm: plain, isRepoRoot: (d) => d === "/Users/me/new-repo" }), null);
  assert.equal(chooseEditorTarget("relative", [], opts), null);
});

test("paths compare without case, trailing slashes or Unicode form getting in the way", () => {
  assert.ok(isWithin("/Users/Me/Shop/app", "/users/me/shop"));
  assert.ok(!isWithin("/Users/me/shop-2", "/Users/me/shop"), "a sibling with the same prefix isn't inside");
  assert.equal(plain("/Users/me/shop/"), "/Users/me/shop");
  const nfd = "/Users/me/café";
  assert.equal(plain(nfd), "/Users/me/café");
  assert.equal(uriToPath("file:///Users/me/caf%C3%A9"), "/Users/me/café");
  assert.equal(uriToPath("vscode-remote://x/y"), null);
  assert.equal(normPath("/a\0b"), null);
});

test("JSON with comments, strings that look like comments, and trailing commas", () => {
  assert.deepEqual(parseJsonc('{"a": "http://x", /* c */ "b": [1,2,],}'), { a: "http://x", b: [1, 2] });
});

test("jumpTo opens the window root for a session started in a subfolder", async () => {
  const seen = [];
  const r = await jumpTo(
    { origin: { app: CURSOR }, cwd: "/Users/me/Documents/earpiece/app" },
    { run: async (c, a) => (seen.push(a), ""), exists: () => true, home: HOME, readFile: fixture },
  );
  assert.deepEqual(seen[0], ["-b", CURSOR.bundle, "/Users/me/Documents/earpiece"]);
  assert.equal(r.precision, "window");
  assert.equal(r.why, "window-root");
});

test("jumpTo never opens a subfolder nobody has open; it brings the editor forward", async () => {
  const seen = [];
  const exists = (p) => !p.endsWith(".git");
  const r = await jumpTo({ origin: { app: CURSOR }, cwd: "/Users/me/random/sub" }, { run: async (c, a) => (seen.push(a), ""), exists, home: HOME, readFile: fixture });
  assert.deepEqual(seen, [["-b", CURSOR.bundle]]);
  assert.equal(r.precision, "app");
});

test("a deleted folder is reported, and the app still comes forward", async () => {
  const r = await jumpTo({ origin: { app: CURSOR }, cwd: "/Users/me/gone" }, { run: async () => "", exists: () => false, home: HOME, readFile: fixture });
  assert.equal(r.ok, true);
  assert.equal(r.note, "folder-missing");
  const t = resolveTarget({ origin: { app: CURSOR }, cwd: "/Users/me/gone" }, { exists: () => false, home: HOME, readFile: fixture });
  assert.equal(t.editorTarget, null);
  assert.deepEqual(jumpPlan(t).map((s) => s.how), ["app"]);
});
