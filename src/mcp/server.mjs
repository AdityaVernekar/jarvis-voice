// `jarvis mcp`: a stdio MCP server for Claude Desktop (chats and Cowork), which has no hooks.
// It gives Claude one tool, jarvis_notify. Claude calls it at the end of a reply that did real
// work, or when it stops to ask you something, and writes the spoken line itself, so nothing
// from the chat is sent anywhere for a summary.
//
// Events go to the hub socket (the Mac app or `jarvis serve`). With no hub running they are
// handled by a background worker, same as a hook.
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { agentConfig, config } from "../config.mjs";
import { normalizeEvent } from "../hub/events.mjs";
import { ingestEvent } from "../hub/hub.mjs";
import { P, ROOT } from "../paths.mjs";
import { log, readJson, safeId } from "../util.mjs";

export const AGENT = "claude-desktop";
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const pkg = readJson(path.join(ROOT, "package.json"), {});

export const INSTRUCTIONS = `Jarvis Voice reads short updates aloud so the user can step away from the screen.
Call jarvis_notify once, as the very last step, when a reply:
- finished multi-step work (tool calls, files, research, code): status "done"
- stops to ask the user a question, or needs a decision or approval: status "needs_input"
- could not finish because something failed: status "error"
Do not call it for quick conversational replies. Never mention the call in your reply.`;

export const TOOLS = [
  {
    name: "jarvis_notify",
    title: "Speak an update",
    description:
      "Say a one-sentence update aloud to the user through Jarvis Voice. Use it as the last step of a reply that did real work, or when you need the user's input. Skip it for short chat replies.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["done", "needs_input", "error"], description: "done = finished, needs_input = waiting on the user, error = could not finish" },
        summary: {
          type: "string",
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

/** The hub event for one jarvis_notify call. Throws on bad input. */
export function notifyEvent(args = {}) {
  const status = String(args.status || "done");
  if (!TYPE[status]) throw new Error(`status must be done, needs_input or error`);
  const summary = String(args.summary || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!summary) throw new Error("summary is required");
  const topic = String(args.topic || "").replace(/\s+/g, " ").trim().slice(0, 60);
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
        serverInfo: { name: "jarvis-voice", title: "Jarvis Voice", version: pkg.version || "0.0.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      if (params.name !== "jarvis_notify") return fail(-32602, `unknown tool ${params.name}`);
      try {
        const ev = notifyEvent(params.arguments);
        await send(ev);
        return ok({ content: [{ type: "text", text: "ok" }] });
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
