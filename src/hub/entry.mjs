// Entry points shared by the CLI (`jarvis hook`, `jarvis codex`) and the hub server, so a hook
// behaves the same whether it runs as its own process or is sent to the desktop app.
import { getAdapter } from "../adapters/index.mjs";
import { log } from "../util.mjs";
import { ingest } from "./hub.mjs";

export function handleHook(agent, payload, opts = {}) {
  return ingest(agent || "claude-code", payload || {}, opts);
}

/** `raw` is the JSON string Codex passes as the last argv. */
export function handleCodex(raw, { forwarded = false, ...opts } = {}) {
  const codex = getAdapter("codex");
  // Called back by a chained notify wrapper: this turn was already handled.
  if (forwarded) return log({ skipped: "forwarded_echo", agent: "codex" });
  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch {}
  if (codex.firstSeen && !codex.firstSeen(payload, raw)) return log({ skipped: "duplicate_turn", agent: "codex" });
  codex.forward?.(raw);
  return ingest("codex", payload, opts);
}
