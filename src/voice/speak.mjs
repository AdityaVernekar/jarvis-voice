// speak(): policy check, cross-process lock, duplicate suppression, then the engine chain.
import fs from "node:fs";
import { agentConfig, config } from "../config.mjs";
import { withLock } from "../lock.mjs";
import { P } from "../paths.mjs";
import { policyBlock } from "../policy.mjs";
import { echo, ensureDirs, isDry, log, now, plainFirstSentence, readJson, writeJson } from "../util.mjs";
import { getEngine } from "./engines/index.mjs";
import { play, playBuffer as realPlayBuffer } from "./play.mjs";

const CHIMES = {
  done: "/System/Library/Sounds/Glass.aiff",
  needs_input: "/System/Library/Sounds/Ping.aiff",
  error: "/System/Library/Sounds/Basso.aiff",
  info: null,
};
const DUPLICATE_WINDOW_MS = 60_000;
// A line that waited this long for the speaker is old news; drop it instead of reading it out late.
export const STALE_MS = 2 * 60_000;

// Why a queued line should be dropped once it reaches the front of the queue, or null.
function dropReason(queuedAt, kind, cfg, force) {
  if (force) return null;
  const blocked = policyBlock(kind, cfg); // the user may have run `jarvis off` while we waited
  if (blocked) return blocked;
  if (queuedAt) {
    if (queuedAt <= (readJson(P.flushed, {}).at || 0)) return "flushed";
    if (now() - queuedAt > STALE_MS) return "stale";
  }
  return null;
}

/**
 * @param {string} text  line to speak
 * @param {"done"|"needs_input"|"error"|"info"} kind
 * @param {object} meta  { agent?, lang?, provider?, force?, ...anything to log }
 * @param {object} deps  test seams: { playBuffer, fetch }
 */
export async function speak(text, kind = "info", meta = {}, deps = {}) {
  ensureDirs();
  const base = config();
  const cfg = meta.agent ? agentConfig(base, meta.agent) : base;
  let line = String(text || "").replace(/\s+/g, " ").trim();
  if (!line) return { skipped: "empty" };
  if (line.length > cfg.maxChars) line = plainFirstSentence(line, cfg.maxChars);

  const { provider, force, queuedAt = now(), ...logMeta } = meta;
  const blocked = dropReason(queuedAt, kind, cfg, force);
  if (blocked) {
    log({ skipped: blocked, kind, line, ...logMeta });
    echo(`[jarvis:skipped:${blocked}] (jarvis on to reset)`);
    return { skipped: blocked };
  }

  return withLock(async () => {
    const late = dropReason(queuedAt, kind, cfg, force);
    if (late) {
      log({ skipped: late, kind, line, ...logMeta });
      echo(`[jarvis:skipped:${late}]`);
      return { skipped: late };
    }
    const last = readJson(P.last, {});
    if (!force && last.line === line && now() - (last.at || 0) < DUPLICATE_WINDOW_MS) {
      log({ skipped: "duplicate", kind, line, ...logMeta });
      echo(`[jarvis:skipped:duplicate] said this <60s ago`);
      return { skipped: "duplicate" };
    }
    const lang = meta.lang || "en";
    const chain = provider ? [provider] : cfg.ttsProviders;
    const ctx = { cfg, lang, fetch: deps.fetch, playBuffer: deps.playBuffer || realPlayBuffer };
    let engine = "none";
    let ms = null;
    const failures = [];
    if (isDry()) {
      engine = "dry-run";
    } else {
      if (cfg.chimes && CHIMES[kind] && fs.existsSync(CHIMES[kind])) play(CHIMES[kind]);
      for (const id of chain) {
        const e = getEngine(id);
        if (!e) {
          failures.push(`${id}: unknown engine`);
          continue;
        }
        const t0 = now();
        try {
          await e.speak(line, ctx);
          engine = id;
          ms = now() - t0; // includes playback
          break;
        } catch (err) {
          const error = String(err?.message || err);
          failures.push(`${id}: ${error}`);
          log({ warn: "tts_failed", engine: id, error });
        }
      }
    }
    writeJson(P.last, { line, at: now(), kind });
    log({ spoke: line, kind, engine, lang, ms, ...logMeta });
    for (const f of failures) echo(`[jarvis:fallback] ${f}`);
    echo(`[jarvis:${engine}:${kind}] ${line}`);
    return { spoke: line, engine, ms, failures };
  }).catch((e) => {
    if (e?.code !== "ELOCKTIMEOUT") throw e;
    log({ skipped: "busy", kind, line, ...logMeta });
    echo(`[jarvis:skipped:busy] another line held the speaker too long`);
    return { skipped: "busy" };
  });
}
