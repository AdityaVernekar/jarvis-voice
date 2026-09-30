// Actions shared by the CLI and the desktop app.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BIN, P } from "./paths.mjs";
import { stopPlayback } from "./voice/play.mjs";
import { ensureDirs, now, which } from "./util.mjs";

// Silence what's playing and throw away everything queued. Lines already waiting for the
// speaker see the flush marker and drop themselves; stray workers and players are killed.
export function stopSpeaking() {
  ensureDirs();
  fs.writeFileSync(P.flushed, JSON.stringify({ at: now() }), { mode: 0o600 });
  let jobs = 0;
  for (const f of fs.readdirSync(P.tmp)) {
    if (!f.startsWith("job-")) continue;
    fs.rmSync(path.join(P.tmp, f), { force: true });
    jobs++;
  }
  const killed = [];
  if (stopPlayback()) killed.push("playback");
  if (process.platform !== "win32" && which("pkill")) {
    const kill = (pattern) => spawnSync("pkill", ["-f", pattern], { stdio: "ignore" }).status === 0;
    if (kill(`${BIN} _worker`) | kill(`jarvis.mjs _worker`)) killed.push("queued workers");
    if (kill(P.tmp) && !killed.includes("playback")) killed.push("playback");
  }
  fs.rmSync(P.lock, { recursive: true, force: true });
  return { jobs, killed };
}
