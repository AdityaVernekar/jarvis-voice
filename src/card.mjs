// The on-screen card: every line Earpiece speaks (and every line it keeps quiet about because of
// quiet mode, quiet hours or a muted agent) is written to ~/.earpiece/card.json. The Mac
// app watches that file and shows a small floating card at the top of the screen. It works the
// same whether the line came from the app's hub or from a background worker process.
import crypto from "node:crypto";
import { P } from "./paths.mjs";
import { now, readJson, writeJson } from "./util.mjs";

// Skip reasons that still deserve a card: the user asked for silence, not blindness.
export const SILENT_REASONS = new Set(["mode_quiet", "quiet_hours", "agent_disabled"]);

/**
 * @param {object} c { line, kind, agent?, project?, session?, state: "speaking"|"spoken"|"silent"|"stopped", reason?, id? }
 * @returns the card id (pass it back to update the same card), or null
 */
export function showCard(c) {
  if (!c?.line) return null;
  try {
    const card = {
      id: c.id || crypto.randomUUID(),
      at: now(),
      line: String(c.line).slice(0, 400),
      kind: c.kind || "info",
      agent: c.agent || null,
      project: c.project || null,
      session: c.session || null,
      state: c.state || "spoken",
      reason: c.reason || null,
    };
    writeJson(P.card, card);
    return card.id;
  } catch {
    return null; // the card is a nicety; never let it break speaking
  }
}

export const readCard = () => readJson(P.card, null);

// A line is only "speaking" while its card says so, and speak() writes that state after the TTS
// API has answered, right before playback. Lines are one sentence, so a "speaking" card older than
// this belongs to a process that died mid-line, not to real speech.
export const SPEAKING_MAX_MS = 60_000;

/** Is audio playing right now? (Not: is Earpiece holding the speaker lock, which also covers the API wait.) */
export function isSpeaking(card = readCard()) {
  return card?.state === "speaking" && now() - (card.at || 0) < SPEAKING_MAX_MS;
}

/**
 * Drop the "Agent, project." lead-in from a spoken line when the screen already shows the agent
 * and project next to it.
 */
export function stripLeadIn(line, { agentName, project } = {}) {
  const t = String(line || "");
  const m = t.match(/^([^.!?]{1,80})\.\s+(\S[\s\S]*)$/);
  if (!m) return t;
  const lead = m[1].trim();
  const first = String(agentName || "").split(/\s+/)[0];
  if ((project && lead.includes(project)) || (agentName && lead.startsWith(agentName)) || (first && (lead === first || lead.startsWith(`${first},`)))) return m[2];
  return t;
}

/** What the app's card window gets: display names, and the line without its lead-in. */
export function cardPayload(c, { agentName, project } = {}) {
  const line = stripLeadIn(c.line, { agentName, project });
  return { id: c.id, line, kind: c.kind, state: c.state, reason: c.reason, agentId: c.agent, agentName, project, session: c.session || null };
}
