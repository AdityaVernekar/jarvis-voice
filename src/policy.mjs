// When Jarvis is allowed to talk: modes (on / quiet / off) and quiet hours.
import { P } from "./paths.mjs";
import { now, readJson, writeJson } from "./util.mjs";

export function inQuietHours(qh, d = new Date()) {
  if (!qh?.start || !qh?.end) return false;
  const mins = (s) => {
    const [h, m] = String(s).split(":").map(Number);
    return h * 60 + (m || 0);
  };
  const cur = d.getHours() * 60 + d.getMinutes();
  const a = mins(qh.start), b = mins(qh.end);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}

export function currentMode() {
  const m = readJson(P.mode, { mode: "on" });
  if (m.until && now() > m.until) return "on";
  return m.mode || "on";
}

export function setMode(mode, minutes = 0) {
  writeJson(P.mode, mode === "on" ? { mode } : { mode, until: minutes ? now() + minutes * 60_000 : null });
}

// Returns a skip reason, or null if this kind of line may be spoken now.
export function policyBlock(kind, cfg, d = new Date()) {
  const mode = currentMode();
  if (mode === "off") return "mode_off";
  if (mode === "quiet" && kind !== "needs_input" && kind !== "error") return "mode_quiet";
  if (inQuietHours(cfg.quietHours, d) && kind !== "needs_input") return "quiet_hours";
  return null;
}
