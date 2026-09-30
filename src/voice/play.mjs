// Play an audio file with whatever the OS has. macOS: afplay. Linux: paplay / aplay / ffplay / mpg123.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { P } from "../paths.mjs";
import { which } from "../util.mjs";

const PLAYERS = [
  { bin: "afplay", args: (f) => [f], exts: null },
  { bin: "paplay", args: (f) => [f], exts: [".wav"] },
  { bin: "aplay", args: (f) => ["-q", f], exts: [".wav"] },
  { bin: "ffplay", args: (f) => ["-nodisp", "-autoexit", "-loglevel", "quiet", f], exts: null },
  { bin: "mpg123", args: (f) => ["-q", f], exts: [".mp3"] },
];

let cache = null;
function available() {
  if (!cache) cache = PLAYERS.filter((p) => which(p.bin));
  return cache;
}

export function playerFor(file) {
  const ext = path.extname(file).toLowerCase();
  return available().find((p) => !p.exts || p.exts.includes(ext)) || null;
}

export function play(file) {
  const p = playerFor(file);
  if (!p) return false;
  return spawnSync(p.bin, p.args(file), { stdio: "ignore" }).status === 0;
}

// Write audio bytes to a temp file, play it, always clean up. Throws if playback fails.
export function playBuffer(buf, ext, player = play) {
  fs.mkdirSync(P.tmp, { recursive: true });
  const file = path.join(P.tmp, `say-${process.pid}-${Date.now()}${ext}`);
  fs.writeFileSync(file, buf);
  try {
    if (!player(file)) throw new Error(playerFor(file) ? "audio playback failed" : "no audio player (afplay/paplay/aplay/ffplay)");
  } finally {
    fs.rmSync(file, { force: true });
  }
}
