// Earpiece for Mac: runs the hub, with a main window (dashboard and settings) and a menu
// bar popover for quick control. Hooks send events to ~/.earpiece/hub.sock through the earpiece-hook shim; this process
// summarises and speaks them. The Node core in ../../src (Resources/core when packaged) does
// the work, so the app and the `earpiece` CLI always behave the same.
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
let tray, popover, win, hub, dash, asks = null, hubError = null;
let quitting = false;
let lib = {};
const SECTIONS = ["overview", "agents", "voice", "quiet", "keys", "activity", "general"];

// App preferences that aren't Earpiece settings (those live in ~/.earpiece/config.json).
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
    if (key === "answerFromCard") {
      // Lives in the shared config (the CLI reads it too). Turning it on or off rewrites the
      // blocking hooks of the agents that are already connected.
      lib.updateConfig({ answerFromCard: Boolean(value) });
      if (!value) asks?.closeAll();
      for (const id of ["claude-code", "codex"]) if (lib.getAdapter(id)?.isInstalled?.()) connectAgents(id);
      return { answerFromCard: Boolean(value) };
    }
    if (key !== "showInDock" && key !== "showCard") throw new Error("unknown preference");
    const next = { ...this.get(), [key]: Boolean(value) };
    fs.mkdirSync(path.dirname(this.file()), { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(next, null, 2));
    if (key === "showInDock") applyDock(next.showInDock);
    if (key === "showCard") {
      asks?.setUi(next.showCard);
      if (!next.showCard) (asks?.closeAll(), cardWin?.hide());
    }
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
    dialog.showErrorBox("Earpiece could not start", String(e?.stack || e));
    app.quit();
  });
}

// The app was called Jarvis Voice before the rename; bring its preferences across once.
function migratePrefs() {
  try {
    const old = path.join(app.getPath("appData"), "Jarvis Voice", "prefs.json");
    if (!fs.existsSync(prefs.file()) && fs.existsSync(old)) {
      fs.mkdirSync(path.dirname(prefs.file()), { recursive: true });
      fs.copyFileSync(old, prefs.file());
    }
  } catch {}
}

async function start() {
  migratePrefs();
  if (prefs.get().showInDock === false) app.dock?.hide();
  const [paths, server, sessions, policy, config, adapters, control, shim, util, cards, askLib, originLib] = await Promise.all([
    core("src/paths.mjs"),
    core("src/hub/server.mjs"),
    core("src/hub/sessions.mjs"),
    core("src/policy.mjs"),
    core("src/config.mjs"),
    core("src/adapters/index.mjs"),
    core("src/control.mjs"),
    core("src/shim.mjs"),
    core("src/util.mjs"),
    core("src/card.mjs"),
    core("src/hub/asks.mjs"),
    core("src/hub/origin.mjs"),
  ]);
  lib = { ...paths, ...server, ...sessions, ...policy, ...config, ...adapters, ...control, ...shim, ...util, ...cards, ...askLib, ...originLib };
  lib.ensureDirs();

  // Re-written on every launch, so hooks keep working if the app is moved.
  const shimOpts = { fallback: [process.execPath, path.join(CORE, "bin", "earpiece.mjs")], env: { ELECTRON_RUN_AS_NODE: "1" } };
  lib.shimFile = lib.writeShim(shimOpts);
  // Hooks installed before the rename call bin/jarvis-hook. Keep it current until they're reinstalled.
  const legacyShim = path.join(path.dirname(lib.shimFile), "jarvis-hook");
  if (fs.existsSync(legacyShim)) lib.writeShim(shimOpts, legacyShim);

  try {
    asks = lib.createAsks({ onChange: onAsksChange });
    asks.setUi(prefs.get().showCard !== false);
    hub = await lib.startHubServer({ version: app.getVersion(), onEvent: scheduleRefresh, asks });
  } catch (e) {
    hubError = e.code === "EADDRINUSE" ? "Another Earpiece hub is running (earpiece serve?). Hooks still speak through it." : e.message;
    lib.log({ error: `app hub: ${e.message}` });
  }

  tray = new Tray(trayIcon(false));
  tray.setToolTip("Earpiece");
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
      const target = /(?:earpiece|jarvis)-hook/.test(text) ? "app" : a.isInstalled?.() ? "cli" : null;
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
    const agent = lib.agentConfig(cfg, s.agent).label || a.name;
    const project = s.project || lib.projectName(s.cwd);
    return {
      agent,
      agentId: s.agent,
      session: s.session,
      project,
      status: s.status || "idle",
      updated: s.updated || 0,
      where: s.origin ? lib.describeOrigin(s.origin) : "",
      // The row already shows the agent and project, so drop them from the spoken line.
      // Once you mark it done, the old question is stale; say so instead.
      lastLine: s.status === "done" && s.markedByUser >= (s.updated || 0) - 5 ? "Marked done by you" : lib.stripLeadIn(s.lastLine || "", { agentName: agent, project }),
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
    speaking: lib.isSpeaking(), // audio is playing, not merely "waiting on the TTS API"
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
  tray.setToolTip(waiting ? `Earpiece: ${waiting} waiting on you` : `Earpiece (${s.mode})`);
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
  try {
    cardMtime = fs.statSync(lib.P.card).mtimeMs; // don't replay the last card from before launch
  } catch {}
  setInterval(() => {
    setSpeaking(lib.isSpeaking());
    checkCard();
  }, 250).unref();
  setInterval(refresh, 30_000).unref(); // ages in the popover, mode timers running out
}

// ---------- floating card ----------
// A small dark island under the menu bar showing who spoke and what they said. It never takes
// focus, follows you across Spaces and full-screen apps, and lets clicks through everywhere
// except the card itself. The core writes card.json (see src/card.mjs); we poll its mtime.

const CARD_W = 480;
const CARD_H = 104;
let cardWin = null;
let cardReady = false;
let cardPending = null;
let cardMtime = 0;

function createCardWin() {
  cardWin = new BrowserWindow({
    width: CARD_W,
    height: CARD_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    webPreferences: webPreferences(),
  });
  cardWin.setAlwaysOnTop(true, "status");
  // skipTransformProcessType keeps the Dock icon; without it macOS turns us into an agent app.
  cardWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  cardWin.setIgnoreMouseEvents(true, { forward: true });
  cardWin.loadFile(path.join(APP_ROOT, "renderer", "card.html"));
  lockDown(cardWin);
  cardWin.webContents.once("did-finish-load", () => {
    cardReady = true;
    if (cardPending) sendCard(cardPending);
    cardPending = null;
  });
  cardWin.on("closed", () => ((cardWin = null), (cardReady = false)));
}

function placeCard() {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  cardWin.setBounds({ x: Math.round(workArea.x + (workArea.width - CARD_W) / 2), y: workArea.y + 2, width: CARD_W, height: cardH });
}

function sendCard(c) {
  // A question is taller than a line; the card measures itself and reports back ("size").
  const h = c.ask ? (cardIsAsk ? cardH : ASK_H) : CARD_H;
  cardIsAsk = Boolean(c.ask);
  if (!cardWin.isVisible()) {
    cardH = h;
    placeCard();
    cardWin.setIgnoreMouseEvents(true, { forward: true });
    if (hiddenForFocus) (hiddenForFocus = false, app.show?.());
    cardWin.showInactive();
  } else if (cardH !== h) {
    cardH = h;
    placeCard();
  }
  cardWin.webContents.send("card", c);
}

function deliverCard(payload) {
  if (!cardWin) createCardWin();
  if (!cardReady) cardPending = payload;
  else sendCard(payload);
}

function presentCard(c) {
  if (!c?.line || prefs.get().showCard === false) return;
  // A question is on screen: keep it there. The line is still spoken, just not shown over it.
  if (asks?.size()) return;
  const a = c.agent ? lib.getAdapter(c.agent) : null;
  const agentName = c.agent ? lib.agentConfig(lib.config(), c.agent).label || a?.name || c.agent : "Earpiece";
  deliverCard(lib.cardPayload(c, { agentName, project: c.project }));
}

// ---------- answering from the card ----------
// A blocking hook (see src/hub/asks.mjs) is waiting for you. The oldest question is on the card;
// the rest queue behind it ("+N more"). Nothing is approved unless you click a button.

const ASK_H = 230;
let cardH = CARD_H;
let cardIsAsk = false;
let hiddenForFocus = false;
let lastAnswer = null; // what the card just sent, so onAsksChange can show a one-line confirmation

function agentLabel(id) {
  const a = id ? lib.getAdapter(id) : null;
  return id ? lib.agentConfig(lib.config(), id).label || a?.name || id : "Earpiece";
}

const ARM_MS = 700; // the renderer disables the buttons for this long; the app enforces it too
let shown = { id: null, at: 0 };

function askPayload(list) {
  const a = list[0];
  if (shown.id !== a.id) shown = { id: a.id, at: Date.now() };
  return {
    id: a.id,
    line: a.line,
    kind: "needs_input",
    state: "ask",
    agentId: a.agent,
    agentName: agentLabel(a.agent),
    project: a.project || null,
    more: list.length - 1,
    at: a.at,
    ask: { id: a.id, kind: a.kind, tool: a.tool || null, detail: a.detail || "", why: a.why || "", canAlways: Boolean(a.canAlways), alwaysRule: a.alwaysRule || "", partial: Boolean(a.partial), expiresAt: a.expiresAt },
  };
}

function confirmText(ask, answer) {
  if (ask.kind !== "permission") return "Reply sent";
  const what = ask.tool || "request";
  if (answer.behavior === "deny") return `Denied ${what}`;
  return answer.behavior === "always" ? `Always allowed ${what}` : `Allowed ${what}`;
}

function onAsksChange(list, change) {
  if (prefs.get().showCard === false) return;
  if (list.length) return deliverCard(askPayload(list));
  // The last question just closed.
  releaseCardFocus();
  if (change.type === "answered" && lastAnswer) {
    const { ask, answer } = lastAnswer;
    return deliverCard({ id: `ok-${ask.id}`, line: confirmText(ask, answer), kind: "done", state: "spoken", agentId: ask.agent, agentName: agentLabel(ask.agent), project: ask.project || null, brief: true });
  }
  cardPending = null;
  if (cardWin?.isVisible()) cardWin.webContents.send("card", { state: "clear" });
}

// The reply box needs the keyboard, so the card becomes focusable only while you type in it.
function grabCardFocus() {
  if (!cardWin) return;
  cardWin.setFocusable(true);
  cardWin.focus();
}

function releaseCardFocus() {
  if (!cardWin || cardWin.isFocusable() === false) return;
  cardWin.setFocusable(false);
  // Give the keyboard back to the terminal: hide the app, unless a window of ours is open or a
  // question is still waiting (hiding the app would hide its card too).
  if (process.platform === "darwin" && !asks?.size() && !win?.isVisible() && !popover?.isVisible()) {
    hiddenForFocus = true;
    app.hide();
  }
}

function checkCard() {
  let st;
  try {
    st = fs.statSync(lib.P.card);
  } catch {
    return;
  }
  if (st.mtimeMs === cardMtime) return;
  cardMtime = st.mtimeMs;
  const c = lib.readJson(lib.P.card, null);
  if (c && Date.now() - (c.at || 0) < 30_000) presentCard(c);
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
      lines.push(...a.install({ cmd: [lib.shimFile], chain: true, ask: lib.config().answerFromCard === true }));
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
    { label: "Open Earpiece", click: () => showMain() },
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
    { label: `Earpiece ${app.getVersion()}`, enabled: false },
    { label: "Quit Earpiece", accelerator: "Cmd+Q", click: () => app.quit() },
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
    title: "Earpiece",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 20 },
    vibrancy: "sidebar",
    visualEffectState: "followWindow",
    backgroundColor: process.platform === "darwin" ? "#00000000" : "#f5f5f7",
    webPreferences: webPreferences(),
  });
  win.loadFile(path.join(APP_ROOT, "renderer", "app.html"));
  lockDown(win);
  // Closing the window keeps Earpiece running in the menu bar; ⌘Q quits.
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
      submenu: [{ label: "Earpiece on GitHub", click: () => shell.openExternal("https://github.com/adissocrazy/earpiece") }],
    },
  ]);
}

// ---------- IPC ----------
// The renderers get these and nothing else (see preload.cjs). Arguments are checked here.

ipcMain.handle("state", () => state());
// Mark a session done (or idle), or forget it. Only sessions that exist can be touched.
ipcMain.handle("session", (_e, action, agent, session) => {
  const a = String(agent || "");
  const id = String(session || "");
  if (!lib.getSession(a, id)) return { ok: false, error: "That session is gone." };
  try {
    if (action === "done") lib.setSessionStatus(a, id, "done");
    else if (action === "forget") lib.forgetSession(a, id);
    else return { ok: false, error: "unknown action" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
  refresh();
  return { ok: true };
});
ipcMain.handle("card", (e, action, value) => {
  if (!cardWin || e.sender !== cardWin.webContents) return;
  if (action === "hidden") {
    if (asks?.size()) return; // a stale "hidden" from a card that was replaced by a question
    cardWin.hide();
    releaseCardFocus();
  }
  else if (action === "hover") cardWin.setIgnoreMouseEvents(!value, { forward: true });
  else if (action === "stop") (lib.stopSpeaking(), refresh());
  else if (action === "open") showMain("overview");
  else if (action === "focus") (value ? grabCardFocus() : releaseCardFocus());
  else if (action === "size") {
    const h = Math.min(Math.max(Math.round(Number(value)) || CARD_H, CARD_H), 460);
    if (cardIsAsk && h !== cardH) ((cardH = h), cardWin.isVisible() && placeCard());
  } else if (action === "defer") asks?.cancel(String(value), "deferred"); // "answer in the terminal instead"
});
// The card's answer to a question. Only the card window may send it, and the shape is checked
// again in asks.answer() (unknown id, "always" when it isn't offered, empty reply).
ipcMain.handle("ask-answer", (e, id, answer) => {
  if (!cardWin || e.sender !== cardWin.webContents || !asks) return { ok: false, error: "not available" };
  const ask = asks.get(String(id));
  if (!ask) return { ok: false, error: "That question is gone." };
  // Only the question on screen, and only once it has been there a moment, can be answered.
  if (shown.id !== ask.id || Date.now() - shown.at < ARM_MS) return { ok: false, error: "Wait a moment, then try again." };
  const given = answer && typeof answer === "object" ? answer : {};
  // asks.answer() calls onAsksChange before it returns; that is where the confirmation is shown.
  lastAnswer = { ask, answer: { behavior: String(given.behavior || "") } };
  try {
    asks.answer(ask.id, given);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    lastAnswer = null;
  }
});
ipcMain.handle("card-preview", () =>
  presentCard({ id: `preview-${Date.now()}`, line: "Codex, shop. Fixed the checkout bug and all tests pass.", kind: "done", state: "spoken", agent: "codex", project: "shop" }),
);
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
