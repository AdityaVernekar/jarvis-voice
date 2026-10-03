// Which editor window has a folder open. A click on a session that runs in Cursor, VS Code and
// friends should bring forward the window that already has the project open, even when the agent
// was started in a subfolder of it (a monorepo opened at its root, `cd app`, then `claude`).
// Handing the editor the subfolder itself would open a second window.
//
// Editors are rows in EDITORS. Each row names a family; each family has one resolver that lists
// the open windows from the editor's own files: [{ open, folders, at }] where `open` is what to
// hand `open -b <bundle>` (a folder or a .code-workspace file) and `folders` are the window's roots.
// To support another editor of a known family, add a row. A new family needs one resolver.
//
// Nothing here runs a command or needs a permission; it only reads files under ~/Library, and a
// missing or half-written file just means "don't know".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Editors we know. `support` is the folder under ~/Library/Application Support that holds the
 * editor's state. `names` match the .app name found in the process tree (origin.mjs builds its
 * terminal list from these rows, so an editor added here is also recognised as an origin).
 * Every VS Code fork sets TERM_PROGRAM=vscode, so that alone only ever means VS Code.
 */
export const EDITORS = [
  { id: "cursor", name: "Cursor", bundle: "com.todesktop.230313mzl4w4u92", family: "vscode", support: "Cursor", names: [/^cursor/i] },
  { id: "windsurf", name: "Windsurf", bundle: "com.exafunction.windsurf", family: "vscode", support: "Windsurf", names: [/^windsurf/i] },
  { id: "vscode-insiders", name: "VS Code Insiders", bundle: "com.microsoft.VSCodeInsiders", family: "vscode", support: "Code - Insiders", names: [/^visual studio code - insiders/i, /^code - insiders$/i] },
  { id: "vscode", name: "VS Code", bundle: "com.microsoft.VSCode", family: "vscode", support: "Code", names: [/^visual studio code/i, /^code$/i], term: ["vscode"] },
  { id: "vscodium", name: "VSCodium", bundle: "com.vscodium", family: "vscode", support: "VSCodium", names: [/^vscodium/i] },
  { id: "trae", name: "Trae", bundle: "com.trae.app", family: "vscode", support: "Trae", names: [/^trae/i] },
  { id: "kiro", name: "Kiro", bundle: "dev.kiro.desktop", family: "vscode", support: "Kiro", names: [/^kiro/i] },
  { id: "void", name: "Void", bundle: "com.voideditor.code", family: "vscode", support: "Void", names: [/^void$/i] },
  { id: "positron", name: "Positron", bundle: "com.rstudio.positron", family: "vscode", support: "Positron", names: [/^positron/i] },
];

/** The row for an origin app ({ id, bundle }), by id first, then by bundle id. */
export function editorFor(app) {
  if (!app) return null;
  const bundle = String(app.bundle || "").toLowerCase();
  return EDITORS.find((e) => e.id === app.id) || (bundle && EDITORS.find((e) => e.bundle.toLowerCase() === bundle)) || null;
}

// ---------- paths ----------

/** A comparable form of a path: absolute, no trailing slash, NFC, symlinks resolved when possible. */
export function normPath(p, { realpath = safeRealpath } = {}) {
  if (typeof p !== "string" || !path.isAbsolute(p) || p.includes("\0")) return null;
  let out = path.resolve(p);
  out = realpath(out) || out;
  out = out.normalize("NFC");
  return out.length > 1 ? out.replace(/\/+$/, "") : out;
}

function safeRealpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** Is `child` the folder `root` or somewhere inside it? Case-insensitive, as macOS volumes usually are. */
export function isWithin(child, root) {
  if (!child || !root) return false;
  const c = child.toLowerCase();
  const r = root.toLowerCase();
  return c === r || c.startsWith(r.endsWith("/") ? r : `${r}/`);
}

/** A file:// URI to a path, or null for anything else (remote windows, untitled workspaces). */
export function uriToPath(uri) {
  if (typeof uri !== "string" || !/^file:\/\//i.test(uri)) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

// ---------- the VS Code family ----------

/** JSON with comments and trailing commas, as .code-workspace files are written. */
export function parseJsonc(text) {
  const s = String(text || "");
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") out += s[++i] ?? "";
      else if (ch === '"') inStr = false;
    } else if (ch === '"') (inStr = true), (out += ch);
    else if (ch === "/" && s[i + 1] === "/") while (i < s.length && s[i] !== "\n") i++;
    else if (ch === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** The root folders of a .code-workspace file. */
export function workspaceFolders(file, readFile) {
  let ws;
  try {
    ws = parseJsonc(readFile(file));
  } catch {
    return [];
  }
  const dir = path.dirname(file);
  const out = [];
  for (const f of Array.isArray(ws?.folders) ? ws.folders : []) {
    const p = typeof f?.path === "string" ? path.resolve(dir, f.path) : uriToPath(f?.uri);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Windows from one editor's saved state, newest first. Two files, because neither is enough alone:
 * User/globalStorage/storage.json has `windowsState` (the windows to restore, written when the
 * editor quits) and Backups/workspaces.json gets every window as it opens.
 */
export function vscodeWindows(supportDir, { readFile = (f) => fs.readFileSync(f, "utf8") } = {}) {
  const read = (f) => {
    try {
      return JSON.parse(readFile(f));
    } catch {
      return null;
    }
  };
  const found = [];
  const add = (entry, at) => {
    if (!entry) return;
    const folder = uriToPath(entry.folder || entry.folderUri || (typeof entry === "string" ? entry : null));
    const wsFile = uriToPath(entry.workspace?.configPath || entry.workspaceIdentifier?.configURIPath || entry.configURIPath || entry.configPath);
    if (folder) found.push({ open: folder, folders: [folder], at });
    else if (wsFile && /\.code-workspace$/i.test(wsFile)) found.push({ open: wsFile, folders: workspaceFolders(wsFile, readFile), at });
  };

  const state = read(path.join(supportDir, "User", "globalStorage", "storage.json"))?.windowsState;
  // The last active window first, so it wins a tie.
  add(state?.lastActiveWindow, 3);
  for (const w of Array.isArray(state?.openedWindows) ? state.openedWindows : []) add(w, 2);
  const backups = read(path.join(supportDir, "Backups", "workspaces.json"));
  for (const f of [...(backups?.folders || []), ...(backups?.folderWorkspaceInfos || []), ...(backups?.folderURIWorkspaces || [])]) add(typeof f === "string" ? f : f?.folderUri ? { folder: f.folderUri } : f, 1);
  for (const w of [...(backups?.workspaces || []), ...(backups?.rootURIWorkspaces || [])]) add(w, 1);

  // One entry per thing to open, keeping the best `at`.
  const byOpen = new Map();
  for (const w of found) {
    const k = w.open.toLowerCase();
    if (!byOpen.has(k) || byOpen.get(k).at < w.at) byOpen.set(k, w);
  }
  return [...byOpen.values()].sort((a, b) => b.at - a.at);
}

const RESOLVERS = { vscode: vscodeWindows };

/** The open (or recently open) windows of an editor row. */
export function editorWindows(editor, { home = os.homedir(), readFile } = {}) {
  const resolve = editor && RESOLVERS[editor.family];
  if (!resolve) return [];
  const dir = path.join(home, "Library", "Application Support", editor.support);
  return resolve(dir, readFile ? { readFile } : {});
}

// ---------- choosing ----------

/**
 * What to open so the editor brings the right window forward, or null to only bring the editor
 * to the front. Returns { open, why }.
 *   1. the window whose root holds `cwd`, the deepest root if several do (newest on a tie)
 *   2. else `cwd` itself if it is a repo root (that is how a window would have been opened)
 *   3. else nothing: never open a subfolder as a new window
 */
export function chooseEditorTarget(cwd, windows, { norm = normPath, isRepoRoot = (d) => fs.existsSync(path.join(d, ".git")) } = {}) {
  const here = norm(cwd);
  if (!here) return null;
  let best = null;
  for (const w of windows || []) {
    for (const f of w.folders || []) {
      const root = norm(f);
      if (!root || !isWithin(here, root)) continue;
      if (!best || root.length > best.depth || (root.length === best.depth && w.at > best.at)) best = { open: w.open, depth: root.length, at: w.at, root };
    }
  }
  if (best) return { open: best.open, why: best.root.toLowerCase() === here.toLowerCase() ? "window" : "window-root" };
  if (isRepoRoot(here)) return { open: here, why: "repo-root" };
  return null;
}
