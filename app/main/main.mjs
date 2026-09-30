// Jarvis Voice for Mac: runs the hub, with a main window (dashboard and settings) and a menu
// bar popover for quick control. Hooks send events to ~/.jarvis-voice/hub.sock through the jarvis-hook shim; this process
// summarises and speaks them. The Node core in ../../src (Resources/core when packaged) does
// the work, so the app and the `jarvis` CLI always behave the same.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDashboard, tidyPath } from "./dashboard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(here, "..");
const CORE = app.isPackaged ? path.join(process.resourcesPath, "core") : path.resolve(APP_ROOT, "..");
const asset = (f) => path.join(APP_ROOT, "build", f);
const core = (rel) => import(pathToFileURL(path.join(CORE, rel)).href);

const DAY = 24 * 3600_000;
let tray, popover, win, hub, dash, hubError = null;
let quitting = false;
let lib = {};
const SECTIONS = ["overview", "agents", "voice", "quiet", "keys", "activity", "general"];

// App preferences that aren't Jarvis settings (those live in ~/.jarvis-voice/config.json).
const prefs = {
  file: () => path.join(app.getPath("userData"), "prefs.json"),
  get() {
    try {
      return JSON.parse(fs.readFileSync(this.file(), "utf8"));
    } catch {
      return {};
    }
  },
  set(key, value) {
    if (key === "openAtLogin") {
      app.setLoginItemSettings({ openAtLogin: Boolean(value) });
      return { openAtLogin: app.getLoginItemSettings().openAtLogin };
    }
    if (key !== "showInDock") throw new Error("unknown preference");
    const next = { ...this.get(), showInDock: Boolean(value) };
    fs.mkdirSync(path.dirname(this.file()), { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(next, null, 2));
    applyDock(next.showInDock);
    return next;
  },
};

function applyDock(show) {
  if (!app.dock) return;
  if (show) app.dock.show().then(() => win?.isVisible() && win.focus());
  else app.dock.hide();
}

// One app instance only. A second launch brings the first one forward.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => showMain());
  app.whenReady().then(start).catch((e) => {
    dialog.showErrorBox("Jarvis Voice could not start", String(e?.stack || e));
    app.quit();
  });
}

async function start() {
  if (prefs.get().showInDock === false) app.dock?.hide();
  const [paths, server, sessions, policy, config, adapters, control, shim, util] = await Promise.all([
    core("src/paths.mjs"),
    core("src/hub/server.mjs"),
    core("src/hub/sessions.mjs"),
    core("src/policy.mjs"),
    core("src/config.mjs"),
    core("src/adapters/index.mjs"),
    core("src/control.mjs"),
    core("src/shim.mjs"),
    core("src/util.mjs"),
  ]);
  lib = { ...paths, ...server, ...sessions, ...policy, ...config, ...adapters, ...control, ...shim, ...util };
  lib.ensureDirs();

  // Re-written on every launch, so hooks keep working if the app is moved.
  lib.shimFile = lib.writeShim({
    fallback: [process.execPath, path.join(CORE, "bin", "jarvis.mjs")],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });

  try {
    hub = await lib.startHubServer({ version: app.getVersion(), onEvent: scheduleRefresh });
  } catch (e) {
    hubError = e.code === "EADDRINUSE" ? "Another Jarvis hub is running (jarvis serve?). Hooks still speak through it." : e.message;
    lib.log({ error: `app hub: ${e.message}` });
  }

  tray = new Tray(trayIcon(false));
  tray.setToolTip("Jarvis Voice");
  tray.on("click", () => togglePopover());
  tray.on("right-click", () => tray.popUpContextMenu(buildMenu()));

  dash = createDashboard({ app, dialog, shell, lib, core, state, hookStatus, connect: connectAgents, disconnect: disconnectAgents, refresh, prefs });
  Menu.setApplicationMenu(appMenu());
  watchState();
  refresh();
  // Started at login: stay in the menu bar. Opened by you: show the window.
  const login = app.getLoginItemSettings();
  if (!(login.wasOpenedAtLogin || login.wasOpenedAsHidden)) showMain();
}

// ---------- state ----------

function hookStatus() {
  return lib
    .listAdapters()
    .filter((a) => a.install && a.configFile)
    .map((a) => {
      let text = "";
      try {
        text = fs.readFileSync(a.configFile(), "utf8");
      } catch {}
      const target = text.includes("jarvis-hook") ? "app" : a.isInstalled?.() ? "cli" : null;
      const present = fs.existsSync(path.dirname(a.configFile()));
      return { id: a.id, name: a.name, target, present };
    });
}

function modeInfo() {
  const m = lib.readJson(lib.P.mode, { mode: "on" });
  const mode = lib.currentMode();
  return { mode, until: mode !== "on" ? m.until || null : null };
}

function state() {
  const cfg = lib.config();
  const rows = lib.listSessions({ sinceMs: DAY }).map((s) => {
    const a = lib.getAdapter(s.agent);
    return {
      agent: lib.agentConfig(cfg, s.agent).label || a.name,
      project: s.project || lib.projectName(s.cwd),
      status: s.status || "idle",
      updated: s.updated || 0,
      lastLine: s.lastLine || "",
    };
  });
  const order = { waiting: 0, error: 1, working: 2, done: 3, idle: 4 };
  rows.sort((a, b) => order[a.status] - order[b.status] || b.updated - a.updated);
  return {
    version: app.getVersion(),
    sessions: rows,
    ...modeInfo(),
    quietHours: cfg.quietHours || null,
    quietNow: lib.inQuietHours(cfg.quietHours),
    hub: hub ? { ok: true } : { ok: false, error: hubError },
    hooks: hookStatus(),
    speaking: fs.existsSync(lib.P.lock),
    openAtLogin: app.getLoginItemSettings().openAtLogin,
  };
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 120);
}

function refresh() {
  if (!tray) return;
  const s = state();
  const waiting = s.sessions.filter((r) => r.status === "waiting").length;
  tray.setTitle(waiting ? String(waiting) : "", { fontType: "monospacedDigit" });
  tray.setToolTip(waiting ? `Jarvis Voice: ${waiting} waiting on you` : `Jarvis Voice (${s.mode})`);
  setSpeaking(s.speaking);
  popover?.webContents.send("state", s);
  win?.webContents.send("state", s);
}

let speakingShown = false;
function setSpeaking(on) {
  if (on === speakingShown) return;
  speakingShown = on;
  tray.setImage(trayIcon(on));
}

function trayIcon(speaking) {
  const img = nativeImage.createFromPath(asset(speaking ? "traySpeakingTemplate.png" : "trayTemplate.png"));
  img.setTemplateImage(true);
  return img;
}

function watchState() {
  for (const dir of [lib.P.sessions, lib.HOME]) {
    try {
      fs.watch(dir, { persistent: false }, scheduleRefresh);
    } catch {}
  }
  // The lock dir appears while a line plays; polling it is cheaper than watching every event.
  setInterval(() => setSpeaking(fs.existsSync(lib.P.lock)), 400).unref();
  setInterval(refresh, 30_000).unref(); // ages in the popover, mode timers running out
}

// ---------- actions ----------

function setMode(mode, minutes = 0) {
  lib.setMode(mode, minutes);
  if (mode === "off") lib.stopSpeaking();
  refresh();
}

function connectAgents(only) {
  const lines = [];
  for (const a of lib.listAdapters()) {
    if (!a.install || (only && a.id !== only)) continue;
    try {
      // chain: keep any existing Codex notify command and forward to it.
      lines.push(...a.install({ cmd: [lib.shimFile], chain: true }));
    } catch (e) {
      lines.push(`✗ ${a.name}: ${e.message}`);
    }
  }
  refresh();
  const restart = only === "claude-desktop" ? "" : "\n\nRestart any open Claude Code or Codex sessions so they pick up the hooks.";
  return tidy(lines) + restart;
}

function disconnectAgents(only) {
  const lines = [];
  for (const a of lib.listAdapters()) {
    if (!a.install || (only && a.id !== only)) continue;
    try {
      lines.push(...a.install({ cmd: [lib.shimFile], uninstall: true }));
    } catch (e) {
      lines.push(`✗ ${a.name}: ${e.message}`);
    }
  }
  refresh();
  return tidy(lines) || "Nothing to remove.";
}

// Installer lines carry full paths and backup names; the popover only needs the gist.
function tidy(lines) {
  return lines
    .map((l) => tidyPath(l).replace(/\s+\(backup: [^)]*\)/, ""))
    .join("\n");
}

async function testVoice() {
  const { speak } = await core("src/voice/speak.mjs");
  const { phrase } = await core("src/i18n.mjs");
  const ph = phrase(lib.config(), "test");
  return speak(ph.text, "done", { src: "app-test", force: true, lang: ph.lang });
}

function buildMenu() {
  const { mode } = modeInfo();
  return Menu.buildFromTemplate([
    { label: "Open Jarvis Voice", click: () => showMain() },
    { type: "separator" },
    { label: "On", type: "radio", checked: mode === "on", click: () => setMode("on") },
    { label: "Quiet for 1 hour", sublabel: "only “needs you” pings", type: "radio", checked: mode === "quiet", click: () => setMode("quiet", 60) },
    { label: "Off", type: "radio", checked: mode === "off", click: () => setMode("off") },
    { type: "separator" },
    { label: "Stop talking now", click: () => (lib.stopSpeaking(), refresh()) },
    { label: "Test voice", click: () => testVoice() },
    { type: "separator" },
    { label: "Agents…", click: () => showMain("agents") },
    { label: "Settings…", click: () => showMain("voice") },
    { label: "Activity", click: () => showMain("activity") },
    { type: "separator" },
    { label: `Jarvis Voice ${app.getVersion()}`, enabled: false },
    { label: "Quit Jarvis Voice", accelerator: "Cmd+Q", click: () => app.quit() },
  ]);
}

// ---------- popover ----------

function createPopover() {
  popover = new BrowserWindow({
    width: 360,
    height: 480,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    vibrancy: "popover",
    visualEffectState: "active",
    webPreferences: webPreferences(),
  });
  popover.loadFile(path.join(APP_ROOT, "renderer", "popover.html"));
  // Hide on click-away like any menu bar popover. The main window is always one click away.
  popover.on("blur", () => {
    if (!popover.webContents.isDevToolsOpened()) popover.hide();
  });
  lockDown(popover);
}

function showPopover() {
  if (!tray) return;
  if (!popover) createPopover();
  const b = tray.getBounds();
  const { workArea } = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const [w] = popover.getSize();
  const x = Math.round(Math.min(Math.max(b.x + b.width / 2 - w / 2, workArea.x + 8), workArea.x + workArea.width - w - 8));
  const y = Math.round(b.y + b.height + 4 > workArea.y ? b.y + b.height + 4 : workArea.y + 4);
  popover.setPosition(x, y, false);
  popover.show();
  popover.focus();
  popover.webContents.send("state", state());
}

function togglePopover() {
  if (popover?.isVisible()) popover.hide();
  else showPopover();
}

// ---------- main window ----------

const webPreferences = () => ({
  preload: path.join(APP_ROOT, "preload", "preload.cjs"),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
});

function lockDown(w) {
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (e) => e.preventDefault());
}

function createMain() {
  win = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 820,
    minHeight: 540,
    show: false,
    title: "Jarvis Voice",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 20 },
    vibrancy: "sidebar",
    visualEffectState: "followWindow",
    backgroundColor: process.platform === "darwin" ? "#00000000" : "#f5f5f7",
    webPreferences: webPreferences(),
  });
  win.loadFile(path.join(APP_ROOT, "renderer", "app.html"));
  lockDown(win);
  // Closing the window keeps Jarvis running in the menu bar; ⌘Q quits.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.once("ready-to-show", () => win.show());
}

function showMain(section) {
  if (!win) createMain();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
  }
  win.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
  popover?.hide();
  if (section && SECTIONS.includes(section)) {
    const go = () => win.webContents.send("navigate", section);
    if (win.webContents.isLoading()) win.webContents.once("did-finish-load", go);
    else go();
  }
}

function appMenu() {
  const go = (section, key) => ({ label: section[0].toUpperCase() + section.slice(1), accelerator: `Cmd+${key}`, click: () => showMain(section) });
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { label: "Check for Updates…", click: () => showMain("general") },
        { type: "separator" },
        { label: "Settings…", accelerator: "Cmd+,", click: () => showMain("voice") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { label: `Quit ${app.name}`, accelerator: "Cmd+Q", click: () => app.quit() },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        ...SECTIONS.map((s, i) => go(s, i + 1)),
        { type: "separator" },
        ...(app.isPackaged ? [] : [{ role: "reload" }, { role: "toggleDevTools" }]),
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Voice",
      submenu: [
        { label: "Stop Talking", accelerator: "Cmd+.", click: () => (lib.stopSpeaking(), refresh()) },
        { label: "Test Voice", accelerator: "Cmd+T", click: () => testVoice() },
        { type: "separator" },
        { label: "On", click: () => setMode("on") },
        { label: "Quiet for 1 Hour", click: () => setMode("quiet", 60) },
        { label: "Off", click: () => setMode("off") },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "Jarvis Voice on GitHub", click: () => shell.openExternal("https://github.com/AdityaVernekar/jarvis-voice") }],
    },
  ]);
}

// ---------- IPC ----------
// The renderers get these and nothing else (see preload.cjs). Arguments are checked here.

ipcMain.handle("state", () => state());
ipcMain.handle("set-mode", (_e, mode, minutes) => {
  if (!["on", "quiet", "off"].includes(mode)) return;
  setMode(mode, Math.min(Math.max(Number(minutes) || 0, 0), 24 * 60));
});
ipcMain.handle("stop", () => (lib.stopSpeaking(), refresh()));
ipcMain.handle("connect", () => connectAgents());
ipcMain.handle("test-voice", () => testVoice().then((r) => ({ engine: r?.engine || "none", skipped: r?.skipped || null })));
ipcMain.handle("open", (_e, what) => {
  if (what === "log") return shell.openPath(lib.P.log);
  if (what === "config") return shell.openPath(lib.P.config);
});
ipcMain.handle("menu", () => tray.popUpContextMenu(buildMenu()));
ipcMain.handle("hide", () => popover?.hide());
ipcMain.handle("show-main", (_e, section) => showMain(section));
ipcMain.handle("dash", async (e, name, args) => {
  try {
    return { ok: true, value: await dash.action(BrowserWindow.fromWebContents(e.sender), String(name), args && typeof args === "object" ? args : {}) };
  } catch (err) {
    if (!err.user) lib.log({ error: `app ${name}: ${err.message}` });
    return { ok: false, error: lib.redact(tidyPath(err.message)) };
  }
});

app.on("activate", () => showMain()); // dock icon clicked
app.on("before-quit", async (e) => {
  quitting = true;
  if (!hub) return;
  e.preventDefault();
  const h = hub;
  hub = null;
  await h.close().catch(() => {});
  app.quit();
});
app.on("window-all-closed", () => {}); // keeps running in the menu bar
