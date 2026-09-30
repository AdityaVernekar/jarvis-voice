// Cross-process lock (mkdir is atomic) so sessions from different agents never talk over each other.
// The holder writes an owner token and refreshes the lock while it works, so a slow speaker is
// never mistaken for a crashed one, and a process only ever removes its own lock.
import fs from "node:fs";
import path from "node:path";
import { P } from "./paths.mjs";
import { now, sleep } from "./util.mjs";

const STALE_MS = 45_000;
const WAIT_MS = 60_000;
const HEARTBEAT_MS = 10_000;

const ownerFile = (dir) => path.join(dir, "owner");
const ownerOf = (dir) => {
  try {
    return fs.readFileSync(ownerFile(dir), "utf8");
  } catch {
    return null;
  }
};

export async function withLock(fn, lockDir = P.lock) {
  const token = `${process.pid}-${now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = now() + WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerFile(lockDir), token);
      break;
    } catch {
      try {
        if (now() - fs.statSync(lockDir).mtimeMs > STALE_MS) fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {}
      if (now() > deadline) throw Object.assign(new Error("lock timeout"), { code: "ELOCKTIMEOUT" });
      await sleep(200);
    }
  }
  const beat = setInterval(() => {
    try {
      const t = new Date();
      if (ownerOf(lockDir) === token) fs.utimesSync(lockDir, t, t);
    } catch {}
  }, HEARTBEAT_MS);
  beat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    if (ownerOf(lockDir) === token) fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
