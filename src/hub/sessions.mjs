// Session registry: one small JSON file per (agent, session) under ~/.jarvis-voice/sessions/.
// It is what lets `jarvis agents` show every running agent, whichever tool it lives in.
import fs from "node:fs";
import path from "node:path";
import { P } from "../paths.mjs";
import { ensureDirs, now, readJson, safeId, writeJson } from "../util.mjs";

export const STATUS = /** @type {const} */ (["working", "waiting", "done", "error", "idle"]);
const PRUNE_AFTER_MS = 7 * 24 * 3600_000;

const fileFor = (agent, session) => path.join(P.sessions, `${safeId(agent)}__${safeId(session)}.json`);

export function getSession(agent, session) {
  return readJson(fileFor(agent, session), null);
}

// `patch` may be a function of the current record, so the check and the write use the same read.
export function updateSession(agent, session, patch) {
  ensureDirs();
  const f = fileFor(agent, session);
  const cur = readJson(f, null) || { agent, session: String(session), created: now() };
  const p = typeof patch === "function" ? patch(cur) : patch;
  const next = { ...cur, ...p, agent, session: String(session), updated: now() };
  writeJson(f, next);
  return next;
}

/** All sessions, most recently active first. `sinceMs` limits to recent activity. */
export function listSessions({ sinceMs = null } = {}) {
  ensureDirs();
  const out = [];
  for (const name of fs.readdirSync(P.sessions)) {
    if (!name.endsWith(".json")) continue;
    const s = readJson(path.join(P.sessions, name), null);
    if (!s || !s.agent) continue; // skips pre-hub session files
    if (sinceMs && now() - (s.updated || 0) > sinceMs) continue;
    out.push(s);
  }
  return out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

export function pruneSessions(maxAgeMs = PRUNE_AFTER_MS) {
  ensureDirs();
  let n = 0;
  // Old sessions, plus job files a crashed worker left behind.
  for (const [dir, age] of [[P.sessions, maxAgeMs], [P.tmp, 3600_000]]) {
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name);
      try {
        if (now() - fs.statSync(f).mtimeMs > age) {
          fs.rmSync(f, { force: true });
          n++;
        }
      } catch {}
    }
  }
  return n;
}
