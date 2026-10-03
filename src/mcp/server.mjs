// `earpiece mcp`: a stdio MCP server for Claude Desktop (chats and Cowork), which has no hooks.
// It gives Claude one tool, earpiece_notify. Claude calls it at the end of a reply that did real
// work, or when it stops to ask you something, and writes the spoken line itself, so nothing
// from the chat is sent anywhere for a summary.
//
// Events go to the hub socket (the Mac app or `earpiece serve`). With no hub running they are
// handled by a background worker, same as a hook.
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { agentConfig, config } from "../config.mjs";
import { normalizeEvent } from "../hub/events.mjs";
import { ingestEvent } from "../hub/hub.mjs";
import { P, ROOT } from "../paths.mjs";
import { policyBlock } from "../policy.mjs";
import { log, readJson, redact, safeId } from "../util.mjs";

export const AGENT = "claude-desktop";
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const pkg = readJson(path.join(ROOT, "package.json"), {});

export const INSTRUCTIONS = `Earpiece reads short updates aloud so the user can step away from the screen.
Call earpiece_notify once, as the very last step, when a reply:
- finished multi-step work (tool calls, files, research, code): status "done"
- stops to ask the user a question, or needs a decision or approval: status "needs_input"
- could not finish because something failed: status "error"
Do not call it for quick conversational replies. Never mention the call in your reply.`;

export const TOOLS = [
  {
    name: "earpiece_notify",
    title: "Speak an update",
    description:
      "Say a one-sentence update aloud to the user through Earpiece. Use it as the last step of a reply that did real work, or when you need the user's input. Skip it for short chat replies.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["done", "needs_input", "error"], description: "done = finished, needs_input = waiting on the user, error = could not finish" },
        summary: {
          type: "string",
          minLength: 1,
          description: "One spoken sentence, at most 20 words: what got done, or what you need from the user. Plain speech: no markdown, code, file paths, URLs or IDs.",
        },
        topic: { type: "string", description: "A 1-4 word name for this conversation. Use the same one every time in a conversation." },
      },
      required: ["status", "summary"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

const TYPE = { done: "turn_end", needs_input: "needs_input", error: "error" };
const KIND = { done: "done", needs_input: "needs_input", error: "error" };
export const MAX_WORDS = 25;

/**
 * Make a model-written summary safe to read aloud. The tool description asks for plain speech,
 * but models don't always listen, so the server enforces it: no markdown or code, URLs become
 * their domain, file paths their file name, IDs and secrets are dropped, and the result is cut
 * to MAX_WORDS at a sentence or word boundary.
 */
export function speakable(text, maxWords = MAX_WORDS) {
  let t = String(text || "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/\b(?:https?|ftp):\/\/([^\s/?#)]+?)(?:[/?#][^\s)]*?)?(?=[.,;:!?]*(?:[\s)]|$))/gi, (_, host) => host.replace(/^www\./i, "").replace(/:\d+$/, ""))
    .replace(/\bwww\.([^\s/?#)]+?)(?:[/?#][^\s)]*?)?(?=[.,;:!?]*(?:[\s)]|$))/gi, "$1")
    .replace(/(?:~|\.{1,2}|[\w.@+-]+)?(?:\/[\w.@+-]+)+\/?/g, (m) => (/^[~./]/.test(m) || m.split("/").filter(Boolean).length > 2 || /\.[a-z]\w{0,5}$/i.test(m) ? path.basename(m) : m)) // paths → file name; keeps "and/or", "24/7"
    .replace(/(?:[A-Za-z]:)?(?:\\[\w.@+-]+){2,}/g, (m) => m.split("\\").pop()) // Windows paths
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ") // UUIDs
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, " "); // hashes, hex ids
  t = redact(t)
    .replace(/\[redacted\]/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ") // stray HTML tags
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "") // headings, quotes, list markers
    .replace(/\*\*|__|~~|[*_|#]/g, " ")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([.!?])[.,;:]+/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/^[\s.,;:-]+/, "")
    .trim();
  const words = t.split(" ").filter(Boolean);
  if (words.length > maxWords) {
    const cut = words.slice(0, maxWords).join(" ");
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    t = end > 0 && cut.slice(0, end).split(" ").length >= 5 ? cut.slice(0, end + 1) : cut.replace(/[,;:\s-]+$/, "") + ".";
  }
  return t;
}

/** The hub event for one earpiece_notify call. Throws on bad input. */
export function notifyEvent(args = {}) {
  const status = String(args.status || "done");
  if (!TYPE[status]) throw new Error(`status must be "done", "needs_input" or "error", got ${JSON.stringify(args.status)}`);
  if (typeof args.summary !== "string" || !args.summary.trim()) throw new Error("summary is required: one short spoken sentence");
  const summary = speakable(args.summary);
  if (!summary) throw new Error("summary had nothing speakable left after removing markdown, code, links and IDs; write it as plain speech");
  const topic = speakable(String(args.topic || ""), 6).replace(/[.!?]+$/, "").slice(0, 60);
  const cfg = agentConfig(config(), AGENT);
  const name = cfg.label || "Claude";
  const who = cfg.announceAgent || cfg.label ? (topic ? `${name}, ${topic}` : name) : topic;
  return normalizeEvent(
    {
      agent: AGENT,
      type: TYPE[status],
      session: safeId(topic.toLowerCase()) || "chat",
      project: topic || "Claude Desktop",
      line: who ? `${who}. ${summary}` : summary,
    },
    AGENT,
  );
}

// Per-process guard against a model calling the tool in a loop. Claude Desktop starts one
// server process per app launch, so this spans every chat in that app.
export const LIMITS = { dedupeMs: 60_000, windowMs: 60_000, maxCalls: 5 };
const recent = []; // { at, key }
export function resetLimits() {
  recent.length = 0;
}
function gate(ev, at) {
  while (recent.length && at - recent[0].at > Math.max(LIMITS.dedupeMs, LIMITS.windowMs)) recent.shift();
  const key = `${ev.type}|${ev.line.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
  if (recent.some((r) => r.key === key && at - r.at <= LIMITS.dedupeMs)) return "duplicate";
  if (recent.filter((r) => at - r.at <= LIMITS.windowMs).length >= LIMITS.maxCalls) return "throttled";
  recent.push({ at, key });
  return null;
}

const BLOCKED = {
  mode_off: "Earpiece is switched off",
  mode_quiet: "Earpiece is in quiet mode, which shows updates on screen without speaking",
  quiet_hours: "it is inside the user's quiet hours",
  agent_disabled: "Claude Desktop is muted in Earpiece",
};

/** Say what will happen to this event, so the model (and the user reading the tool result) knows. */
export function predictOutcome(ev, status) {
  const cfg = agentConfig(config(), AGENT);
  if (!cfg.enabled) return "agent_disabled";
  return policyBlock(KIND[status] || "done", cfg);
}

const normalizeSpace = (x) => String(x || "").replace(/\s+/g, " ").trim();

function postToHub(ev, socket = P.socket) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: socket, path: "/emit", method: "POST", timeout: 2000, headers: { "Content-Type": "application/json" } }, (res) => {
      res.resume();
      resolve(res.statusCode === 202);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => (req.destroy(), resolve(false)));
    req.end(JSON.stringify(ev));
  });
}

export async function deliver(ev, { socket } = {}) {
  if (await postToHub(ev, socket)) return "hub";
  await ingestEvent(ev, { foreground: false });
  return "worker";
}

/** Handle one JSON-RPC message. Returns the response object, or null for notifications. */
export async function handleMessage(msg, { send = deliver } = {}) {
  const { id, method, params = {} } = msg || {};
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (id === undefined || id === null) return null; // notifications/initialized, cancelled, …
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "earpiece", title: "Earpiece", version: pkg.version || "0.0.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      if (params.name !== "earpiece_notify") return fail(-32602, `unknown tool ${params.name}`);
      try {
        const args = params.arguments || {};
        const ev = notifyEvent(args);
        const status = String(args.status || "done");
        const limited = gate(ev, Date.now());
        if (limited === "duplicate") return ok({ content: [{ type: "text", text: "Not spoken: the same update was sent under a minute ago. No need to call again." }] });
        if (limited === "throttled")
          return ok({ content: [{ type: "text", text: `Not spoken: more than ${LIMITS.maxCalls} updates in a minute. Call earpiece_notify once, at the end of a reply.` }] });
        const blocked = predictOutcome(ev, status);
        const via = await send(ev);
        const notes = [];
        if (normalizeSpace(args.summary) !== speakable(args.summary)) notes.push(`The summary was cleaned up for speech (plain words, at most ${MAX_WORDS}); write it that way next time.`);
        if (!String(args.topic || "").trim()) notes.push('Tip: pass a short "topic" so the user knows which chat this is.');
        const head = blocked ? `Not spoken now: ${BLOCKED[blocked] || blocked}. The status was still recorded.` : `Queued to speak${via === "worker" ? " (no Earpiece app running, used the background speaker)" : ""}: "${ev.line}"`;
        return ok({ content: [{ type: "text", text: [head, ...notes].join(" ") }] });
      } catch (e) {
        return ok({ isError: true, content: [{ type: "text", text: String(e?.message || e) }] });
      }
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

export async function runMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (o) => o && output.write(JSON.stringify(o) + "\n");
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    // Batches aren't used by Claude Desktop, but they're cheap to support.
    const list = Array.isArray(msg) ? msg : [msg];
    const replies = (await Promise.all(list.map((m) => handleMessage(m).catch((e) => (log({ error: `mcp: ${e.message}` }), null))))).filter(Boolean);
    if (Array.isArray(msg)) replies.length && write(replies);
    else write(replies[0]);
  }
}
