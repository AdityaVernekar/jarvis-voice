// Play an audio file with whatever the OS has. macOS: afplay. Linux: paplay / aplay / ffplay / mpg123.
import { spawn } from "node:child_process";
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

// Resolves true when the player exits 0. Asynchronous on purpose: the desktop app runs the hub
// on its main thread, and a blocking player would freeze the window (and "Stop talking") for
// as long as a line plays.
const live = new Set(); // players started by this process, so Stop can end them (including `say`)

export function run(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "ignore" });
    live.add(child);
    const done = (ok) => {
      live.delete(child);
      resolve(ok);
    };
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });
}

// Kill every player this process started. Returns how many were playing.
export function stopPlayback() {
  const n = live.size;
  for (const c of live) c.kill("SIGTERM");
  return n;
}

export async function play(file) {
  const p = playerFor(file);
  if (!p) return false;
  return run(p.bin, p.args(file));
}

// Write audio bytes to a temp file, play it, always clean up. Throws if playback fails.
export async function playBuffer(buf, ext, player = play) {
  fs.mkdirSync(P.tmp, { recursive: true });
  const file = path.join(P.tmp, `say-${process.pid}-${Date.now()}${ext}`);
  fs.writeFileSync(file, buf);
  try {
    if (!(await player(file))) throw new Error(playerFor(file) ? "audio playback failed" : "no audio player (afplay/paplay/aplay/ffplay)");
  } finally {
    fs.rmSync(file, { force: true });
  }
}
