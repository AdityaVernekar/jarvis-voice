// Anonymous usage stats, so we can tell how many people run Earpiece. A few times a day the app
// sends exactly what payload() returns: a random install id, the app and macOS versions, the CPU
// architecture, the locale and which agents are connected. Never code, prompts, summaries,
// project names or paths. Off with the General switch, or EARPIECE_TELEMETRY=0.
//
// No Electron imports here: main.mjs passes in what it needs, so the logic can be tested in Node.
import crypto from "node:crypto";

export const ENDPOINT = "https://xqlcwdmgikqbicwvgfbj.supabase.co/rest/v1/pings";
// Publishable key. Row-level security lets it insert today's row into `pings` and nothing else:
// it can't read, change or delete anything.
export const KEY = "sb_publishable_EH82KH93ZvUQAN_yHprfAA_Y2dIbyVX";
const FIRST_PING_MS = 30_000;
// The table keeps one row per install per day, so later pings that day get a 409 and are dropped.
const PING_EVERY_MS = 6 * 3600_000;

export const enabled = (shareStats, env = process.env) => shareStats !== false && env.EARPIECE_TELEMETRY !== "0";

export const payload = ({ installId, version, osVersion, arch, locale, agents }) => ({
  install_id: installId,
  app_version: version,
  macos_version: osVersion,
  arch,
  locale,
  agents,
});

// getPrefs() → { shareStats, installId }; saveInstallId(id) persists a new id; info() → the rest.
export function createTelemetry({ getPrefs, saveInstallId, info, fetch = globalThis.fetch }) {
  async function ping() {
    const p = getPrefs();
    if (!enabled(p.shareStats)) return false;
    let installId = p.installId;
    if (!installId) saveInstallId((installId = crypto.randomUUID()));
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { apikey: KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(payload({ installId, ...info() })),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false; // offline or blocked: try again at the next interval, never bother the user
    }
  }

  return {
    ping,
    start() {
      setTimeout(ping, FIRST_PING_MS).unref?.();
      setInterval(ping, PING_EVERY_MS).unref?.();
    },
  };
}
