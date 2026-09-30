// The hub as a long-running process. The desktop app (and `jarvis serve`) listen on a Unix
// socket; hooks send their payload there with curl instead of starting Node for every event.
// Only the current user can reach the socket (0600, no TCP port).
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { P } from "../paths.mjs";
import { ensureDirs, log } from "../util.mjs";
import { handleCodex, handleHook } from "./entry.mjs";
import { EVENT_TYPES, normalizeEvent } from "./events.mjs";
import { ingestEvent } from "./hub.mjs";

const MAX_BODY = 1024 * 1024;
const AGENT_ID = /^[A-Za-z0-9_.-]{1,64}$/;

function isLive(socket) {
  return new Promise((resolve) => {
    const c = net.connect(socket);
    c.once("connect", () => (c.destroy(), resolve(true)));
    c.once("error", () => resolve(false));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const parse = (raw) => {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
};

/**
 * Start the hub server. Resolves once it is listening.
 * `onEvent(info)` is called after each accepted request (the app uses it to refresh the tray).
 */
export async function startHubServer({ socket = P.socket, deps = {}, onEvent = () => {}, version = "" } = {}) {
  ensureDirs();
  if (fs.existsSync(socket)) {
    if (await isLive(socket)) throw Object.assign(new Error(`another Jarvis hub is already running on ${socket}`), { code: "EADDRINUSE" });
    fs.rmSync(socket, { force: true }); // left over from a crash
  }
  const pending = new Set();
  const opts = { foreground: true, deps };
  const run = (label, fn) => {
    const p = Promise.resolve()
      .then(fn)
      .catch((e) => log({ error: `hub ${label}: ${e?.message || e}` }))
      .finally(() => (pending.delete(p), onEvent({ route: label })));
    pending.add(p);
  };

  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, "http://jarvis");
      if (req.method === "GET" && url.pathname === "/health") return reply(200, { ok: true, pid: process.pid, version });
      if (req.method !== "POST") return reply(405, { error: "method not allowed" });
      const raw = await readBody(req);
      const hook = /^\/hook\/([^/]+)$/.exec(url.pathname);
      if (hook) {
        const agent = decodeURIComponent(hook[1]);
        if (!AGENT_ID.test(agent)) return reply(400, { error: "bad agent id" });
        const payload = parse(raw);
        run(`hook/${agent}`, () => handleHook(agent, payload, opts));
        return reply(202, { accepted: true });
      }
      if (url.pathname === "/codex") {
        parse(raw);
        const forwarded = req.headers["x-jarvis-forwarded"] === "1";
        run("codex", () => handleCodex(raw, { forwarded, ...opts }));
        return reply(202, { accepted: true });
      }
      if (url.pathname === "/emit") {
        const body = parse(raw);
        const agent = String(body.agent || "cli");
        if (!AGENT_ID.test(agent)) return reply(400, { error: "bad agent id" });
        if (!EVENT_TYPES.includes(body.type || "info")) return reply(400, { error: `unknown type ${body.type}` });
        const ev = normalizeEvent({ ...body, agent }, agent);
        run("emit", () => ingestEvent(ev, opts));
        return reply(202, { accepted: true });
      }
      return reply(404, { error: "not found" });
    } catch (e) {
      return reply(e.status || 500, { error: e.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => (server.off("error", reject), resolve()));
  });
  fs.chmodSync(socket, 0o600);
  log({ hub: "listening", socket, pid: process.pid });

  return {
    socket,
    server,
    /** Wait for every accepted event to finish (tests, clean shutdown). */
    idle: () => Promise.all([...pending]),
    async close() {
      await new Promise((r) => server.close(r));
      await Promise.all([...pending]);
      fs.rmSync(socket, { force: true });
    },
  };
}
