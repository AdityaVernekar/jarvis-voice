// Take you to the window an agent is running in. The origin comes from origin.mjs (stored on the
// session record). What a click can do depends on the app:
//   iTerm2        the exact tab and split, by session id or tty
//   Terminal.app  the exact tab, by tty
//   Cursor / VS Code / Windsurf … the window that has the session's folder open, even when the
//                 agent runs in a subfolder of it (see editors.mjs); never a new window
//   anything else (ChatGPT running Codex, the Claude app, Ghostty, Warp …)   the app comes forward
// Nothing is typed into any terminal. AppleScript gets the ids and ttys as arguments (`on run
// argv`), never pasted into the script text. The first jump into iTerm2 or Terminal asks for
// macOS Automation permission once.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chooseEditorTarget, editorFor, editorWindows } from "./editors.mjs";

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr || "") })) : resolve(String(stdout || ""))));
  });

const ITERM = `on run argv
  set wantId to item 1 of argv
  set wantTty to item 2 of argv
  tell application id "com.googlecode.iterm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (wantId is not "" and (unique id of s) is wantId) or (wantTty is not "" and (tty of s) is wantTty) then
            select w
            tell t to select
            tell s to select
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

const TERMINAL = `on run argv
  set wantTty to item 1 of argv
  tell application id "com.apple.Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if (tty of t) is wantTty then
          set selected tab of w to t
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

// Apps an agent can live in without a terminal, for sessions that carry no origin.
const AGENT_APPS = {
  "claude-desktop": { bundle: "com.anthropic.claudefordesktop", name: "Claude" },
};
// Names to hand `open -a` when only a label is known.
const OPEN_NAME = { "codex-app": "Codex", "claude-app": "Claude", vscode: "Visual Studio Code" };

const TTY = /^\/dev\/[A-Za-z0-9\/]{1,30}$/;
const GUID = /^[A-Za-z0-9-]{8,64}$/;
const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9.-]{1,120}$/;
const NAME = /^[^\0\/]{1,80}$/;

/** ITERM_SESSION_ID is "w0t1p0:GUID"; AppleScript's `unique id` is the GUID. */
export const itermGuid = (id) => {
  const g = String(id || "").split(":").pop();
  return GUID.test(g) ? g : "";
};

const appPath = (p) => (typeof p === "string" && path.isAbsolute(p) && /\.app$/.test(p) && !p.includes("\0") ? p : null);

/** `open` arguments that bring an app forward, or null when there is nothing safe to open. */
export function activateArgs(app) {
  if (!app) return null;
  if (app.bundle && BUNDLE.test(app.bundle)) return ["-b", app.bundle];
  const p = appPath(app.path);
  if (p) return ["-a", p];
  const name = OPEN_NAME[app.id] || (app.id === "other" ? app.name : null);
  return name && NAME.test(name) ? ["-a", name] : null;
}

/**
 * The steps a click would take, most precise first. Pure, so it can be tested without a Mac.
 * Each step is { how, cmd, args, precision }. For editors, `editorTarget` is what
 * chooseEditorTarget() picked ({ open, why }), or null to only bring the editor forward.
 */
export function jumpPlan({ agent = null, origin = null, cwd = null, editorTarget } = {}) {
  const steps = [];
  const app = origin?.app || null;
  const tabTty = TTY.test(origin?.tabTty || "") ? origin.tabTty : "";
  if (app?.id === "iterm2") {
    // Under tmux the stored iTerm id belongs to whoever started tmux, so only the client's tty counts.
    const guid = origin.tmux ? "" : itermGuid(origin.iterm);
    if (guid || tabTty) steps.push({ how: "iterm2-tab", cmd: "osascript", args: ["-e", ITERM, guid, tabTty], precision: "tab" });
  } else if (app?.id === "terminal" && tabTty) {
    steps.push({ how: "terminal-tab", cmd: "osascript", args: ["-e", TERMINAL, tabTty], precision: "tab" });
  } else if (app?.editor) {
    // Opening a window's root folder (or workspace file) focuses the window that has it open.
    const open = editorTarget === undefined ? cwd : editorTarget?.open;
    const by = activateArgs(app);
    if (by && typeof open === "string" && path.isAbsolute(open) && !open.includes("\0")) steps.push({ how: "editor-window", cmd: "open", args: [...by, open], precision: "window", why: editorTarget?.why || "folder" });
  }
  const bring = activateArgs(app) || (agent && AGENT_APPS[agent] ? ["-b", AGENT_APPS[agent].bundle] : null);
  if (bring) steps.push({ how: "app", cmd: "open", args: bring, precision: "app" });
  return steps;
}

/**
 * Fill in what the plan needs from disk: whether the folder still exists and, for editors, which
 * window to bring forward. Returns the target plus { editorTarget, editorWindows, note }.
 */
export function resolveTarget(target, { exists = fs.existsSync, home, readFile } = {}) {
  const cwd = target?.cwd && path.isAbsolute(target.cwd) ? target.cwd : null;
  const there = cwd && exists(cwd) ? cwd : null;
  const out = { ...target, cwd: there };
  if (cwd && !there) out.note = "folder-missing";
  const app = target?.origin?.app;
  if (app?.editor) {
    const ed = editorFor(app);
    const windows = ed ? editorWindows(ed, { home, readFile }) : [];
    out.editorWindows = windows;
    out.editorTarget = there ? chooseEditorTarget(there, windows, { isRepoRoot: (d) => exists(path.join(d, ".git")) }) : null;
  }
  return out;
}

/**
 * Go there. Resolves to { ok, how, precision, why?, note?, error? }. ok:false means nothing could be
 * opened (the caller shows the dashboard instead). note "folder-missing": the session's folder is gone.
 */
export async function jumpTo(target, { run: runCmd = run, exists = fs.existsSync, home, readFile } = {}) {
  const resolved = resolveTarget(target, { exists, home, readFile });
  const steps = jumpPlan(resolved);
  const note = resolved.note ? { note: resolved.note } : {};
  let lastError = null;
  for (const s of steps) {
    try {
      const out = (await runCmd(s.cmd, s.args)).trim();
      if (s.cmd === "osascript" && out !== "ok") {
        lastError = "That tab is closed.";
        continue;
      }
      return { ok: true, how: s.how, precision: s.precision, ...(s.why ? { why: s.why } : {}), ...note };
    } catch (e) {
      // -1743: the user (or nobody yet) allowed Earpiece to control that app.
      lastError = /-1743|not authori[sz]ed/i.test(`${e.stderr || ""} ${e.message || ""}`) ? "Earpiece isn't allowed to control that app (System Settings → Privacy & Security → Automation)." : e.message;
    }
  }
  return { ok: false, how: "none", precision: "none", error: lastError, ...note };
}
