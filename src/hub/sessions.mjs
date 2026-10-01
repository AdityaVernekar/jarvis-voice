// Session registry: one small JSON file per (agent, session) under ~/.earpiece/sessions/.
// It is what lets `earpiece agents` show every running agent, whichever tool it lives in.
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
// `touch: false` leaves `updated` alone, for bookkeeping (like where the agent runs) that isn't activity.
export function updateSession(agent, session, patch, { touch = true } = {}) {
  ensureDirs();
  const f = fileFor(agent, session);
  const cur = readJson(f, null) || { agent, session: String(session), created: now() };
  const p = typeof patch === "function" ? patch(cur) : patch;
  const next = { ...cur, ...p, agent, session: String(session), updated: touch || !cur.updated ? now() : cur.updated };
  writeJson(f, next);
  return next;
}

// What you can set from the app or CLI. "done" also counts as answering anything the agent was
// waiting on, so a queued "needs you" line for it is dropped instead of spoken late.
export const USER_STATUS = ["done", "idle"];
export function setSessionStatus(agent, session, status) {
  if (!USER_STATUS.includes(status)) throw new Error(`status must be ${USER_STATUS.join(" or ")}`);
  if (!getSession(agent, session)) throw new Error("no such session");
  return updateSession(agent, session, { status, activeAt: now(), activeTool: null, markedByUser: now() });
}

/** Forget a session; it comes back if the agent sends anything new. */
export function forgetSession(agent, session) {
  fs.rmSync(fileFor(agent, session), { force: true });
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
