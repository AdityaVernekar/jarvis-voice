// Capture the real card renderer with sample data, without starting the hub or touching agents.
// Run from the repository root:
//   app/node_modules/.bin/electron scripts/capture-notch-states.mjs
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { notchAgents } from "../src/notch.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "docs/notch-states");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-state-capture-"));
app.setPath("userData", path.join(scratch, "profile"));
app.commandLine.appendSwitch("force-device-scale-factor", "2");
app.dock?.hide();
app.on("window-all-closed", () => {}); // the overview uses a new window after the card window

const now = Date.now();
const row = (agentId, agent, session, project, status, minutes, lastLine) =>
  ({ agentId, agent, session, project, status, updated: now - minutes * 60_000, lastLine });
const rows = [
  row("claude-code", "Claude Code", "demo-1", "checkout", "waiting", 1, "May I run the test suite?"),
  row("codex", "Codex", "demo-2", "dashboard", "working", 0, "Updating the navigation."),
  row("codex", "Codex", "demo-3", "docs", "done", 5, "Updated the setup guide."),
];
const agents = { ...notchAgents(rows, { now }), mode: "on", rest: true, now };
const card = {
  id: "demo-update", agentId: "codex", agentName: "Codex", project: "dashboard",
  session: "demo-2", kind: "done", state: "spoken",
  line: "Fixed the navigation and added regression coverage. All checks pass.",
};
const permission = {
  ...card, id: "demo-permission", agentId: "claude-code", agentName: "Claude Code",
  project: "checkout", kind: "needs_input", state: "ask", line: "May I run the test suite?", more: 0,
  ask: {
    id: "demo-permission", kind: "permission", tool: "Bash", detail: "npm test",
    why: "Check the checkout changes before continuing.",
    canAlways: true, alwaysRule: "Bash(npm test)", expiresAt: now + 115_000,
  },
};
const question = {
  ...card, id: "demo-question", kind: "needs_input", state: "ask",
  line: "Should the export include completed tasks, or only active tasks?",
  ask: { id: "demo-question", kind: "question", expiresAt: now + 115_000 },
};
const scenarios = [];
const add = (id, title, view, description, extra = {}) => scenarios.push({ id, title, view, description, ...extra });
add("01-resting", "1. Resting notch", "rest", "Active count on the left, status on the right, with the MacBook camera area kept clear in the centre.", { agents: { ...agents, tone: "working", waiting: 0, active: 3 } });
add("02-agents", "2. Agents list", "list", "Click the notch to see your agents and their status. Click a row to go to that agent.");
add("03-permission", "3. Permission request", "open", "Review a tool request and choose Allow, Deny or In terminal. Always allow appears only when offered.", { card: permission });
add("04-reply", "4. Text reply", "open", "Read the agent's question and send your reply directly from the notch.", { card: question });

const fixtureSource = `
const events = {};
window.earpiece = {
  card: async () => {}, setMode: async () => {}, answer: async () => ({ ok: true }),
  ...Object.fromEntries(["Card", "Geom", "Agents", "Rest", "Pointer"].map(name => ["on" + name, fn => events[name] = fn])),
};
window.captureState = async (spec, geom, agentData) => {
  events.Geom(geom);
  events.Agents(spec.agents || agentData);
  events.Pointer(true);
  if (spec.card) events.Card(spec.card);
  await new Promise(requestAnimationFrame);
  setView(spec.view, true);
  if (spec.view === "open" && spec.card?.ask) {
    arm(true);
    clearTimeout(armTimer);
  }
  // Freeze the actual CSS animation at a repeatable frame for a static reference.
  for (const animation of document.getAnimations()) {
    if (animation.effect?.target?.id === "timerBar") { animation.currentTime = 25_000; animation.pause(); }
    else if (animation.constructor.name === "CSSTransition") animation.finish();
    else { animation.currentTime = 300; animation.pause(); }
  }
  await new Promise(requestAnimationFrame);
  const bounds = document.getElementById("card").getBoundingClientRect();
  return {
    view: document.getElementById("card").dataset.view,
    width: bounds.width, height: bounds.height,
    visibleButtons: [...document.querySelectorAll("button")].filter(b => {
      if (!b.getBoundingClientRect().width) return false;
      for (let node = b; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      }
      return true;
    }).map(b => ({ text: b.textContent.trim() || b.title, disabled: b.disabled })),
  };
};
`;
const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function capture() {
  fs.mkdirSync(output, { recursive: true });
  const rendererFiles = ["card.html", "card.css", "card.js", "logos.js"];
  const source = {};
  for (const name of rendererFiles) {
    const bytes = fs.readFileSync(path.join(root, "app/renderer", name));
    source[name] = crypto.createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(path.join(scratch, name), name === "card.html" ? bytes.toString().replace('<script src="logos.js">', '<script src="fixture.js"></script><script src="logos.js">') : bytes);
  }
  fs.writeFileSync(path.join(scratch, "fixture.js"), fixtureSource);
  const win = new BrowserWindow({
    width: 480, height: 560, show: false, frame: false, roundedCorners: false,
    transparent: true, hasShadow: false, focusable: false, skipTaskbar: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const records = [];
  for (const display of ["notch"]) {
    fs.mkdirSync(path.join(output, display), { recursive: true });
    const geom = { notch: display === "notch", notchW: 204, notchH: 33 };
    for (const spec of scenarios) {
      await win.loadFile(path.join(scratch, "card.html"));
      const measured = await win.webContents.executeJavaScript(`captureState(${JSON.stringify(spec)}, ${JSON.stringify(geom)}, ${JSON.stringify(agents)})`);
      if (measured.view !== spec.view) throw new Error(`Wrong view for ${spec.id}: ${measured.view}`);
      if (measured.height > 520) throw new Error(`Clipped card: ${spec.id} (${measured.height}px)`);
      const image = await win.webContents.capturePage({ x: 0, y: 0, width: 480, height: Math.max(80, Math.ceil(measured.height) + 36) }, { stayHidden: true, stayAwake: true });
      const pixels = image.getSize();
      const bitmap = image.toBitmap();
      let cornerMaxAlphaDifference = 0;
      if (measured.width === 460) {
        for (let y = 0; y < 10; y++) {
          for (let x = 0; x < pixels.width / 2; x++) {
            const left = bitmap[(y * pixels.width + x) * 4 + 3];
            const right = bitmap[(y * pixels.width + pixels.width - 1 - x) * 4 + 3];
            cornerMaxAlphaDifference = Math.max(cornerMaxAlphaDifference, Math.abs(left - right));
          }
        }
        if (cornerMaxAlphaDifference > 8) throw new Error(`Asymmetric top corners: ${spec.id}`);
      }
      const filename = `${display}/${spec.id}.png`;
      fs.writeFileSync(path.join(output, filename), image.toPNG());
      records.push({ id: spec.id, title: spec.title, view: spec.view, description: spec.description, display, filename, ...measured, pixels, cornerMaxAlphaDifference });
      console.log(`Captured ${filename}`);
    }
  }
  win.destroy();
  const manifest = {
    generatedAt: new Date().toISOString(), rendererSourceSha256: source,
    method: "Actual Electron card renderer with isolated sample fixtures; not live agent sessions. Native compositor clipping is not captured by capturePage.",
    scope: "Four essential views, MacBook notch only", records,
  };
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeGallery();
  await captureOverview();
  console.log(`Saved ${records.length} screenshots and the gallery to ${output}`);
}

const galleryCss = `
*{box-sizing:border-box}body{margin:0;background:#101014;color:#f1f1f5;font:15px/1.55 -apple-system,BlinkMacSystemFont,sans-serif}
main{max-width:1180px;margin:auto;padding:40px 28px}h1{font-size:34px;letter-spacing:-1px;margin:0 0 12px}h2{font-size:17px;margin:0 0 6px}
p{color:#aaaab7;margin:0 0 20px;max-width:850px}a{color:#aebdff}code{font-size:12px;color:#aaaab7}
.controls{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0}select{background:#262630;color:#fff;border:1px solid #424250;padding:9px 14px;border-radius:8px;font:inherit}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px}
article{border:1px solid #343440;border-radius:14px;overflow:hidden;background:#19191f}
.stage{min-height:190px;background:linear-gradient(130deg,#687cc9,#957a9e 60%,#bb8396);display:flex;align-items:flex-start;justify-content:center;padding:0 16px 22px}
.stage img{display:block;width:480px;max-width:100%;height:auto}.caption{padding:18px 20px}.caption p{font-size:13px;margin:4px 0 0}
.overview .stage{min-height:90px;padding-bottom:16px}.overview .stage img{max-height:380px;width:auto;max-width:100%}.overview main{padding:26px}.overview h1{font-size:28px}.overview .grid{display:block;columns:2;column-gap:18px}.overview article{break-inside:avoid;margin-bottom:18px}.overview .caption{padding:12px 16px}.overview .caption p{margin:0}.overview h2{font-size:16px}
@media(max-width:720px){main{padding:24px 16px}.grid{grid-template-columns:1fr}h1{font-size:28px}}
`;
function tile(spec, overview = false) {
  return `<article data-view="${spec.view}"><div class="stage"><a href="notch/${spec.id}.png"><img src="notch/${spec.id}.png" alt="${escape(spec.title)}" ${overview ? "" : 'loading="lazy"'}></a></div><div class="caption"><h2>${escape(spec.title)}</h2><code>${spec.view}</code><p>${escape(spec.description)}</p></div></article>`;
}
function writeGallery() {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Earpiece: four essential notch views</title><style>${galleryCss}</style><body class="overview"><main><h1>Earpiece: four essential notch views</h1><p>MacBook notch layout. Actual app renderer with sample data; the coloured background is for context.</p><p><a href="../notch-states.md">Short notes</a> · <a href="overview.png">Save overview</a></p><div class="grid">${scenarios.map(s => tile(s, true)).join("")}</div></main></body></html>`;
  fs.writeFileSync(path.join(output, "index.html"), html);
  fs.writeFileSync(path.join(output, "overview.html"), html);
}
async function captureOverview() {
  const win = new BrowserWindow({ width: 1180, height: 2000, show: false, frame: false, roundedCorners: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  await win.loadFile(path.join(output, "overview.html"));
  await win.webContents.executeJavaScript("Promise.all([...document.images].map(image => image.decode()))");
  const height = await win.webContents.executeJavaScript("document.querySelector('main').getBoundingClientRect().height");
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1180, height: Math.ceil(height) }, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(output, "overview.png"), image.toPNG());
  win.destroy();
}
app.whenReady().then(capture).then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); });
