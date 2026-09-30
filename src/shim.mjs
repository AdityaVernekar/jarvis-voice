// The hook shim: a tiny shell script agents call instead of Node. It sends the event to the
// hub socket with curl (about 10 ms), and only if nothing is listening does it start the
// core itself. It always exits 0 so it can never block or fail an agent.
import fs from "node:fs";
import path from "node:path";
import { BIN, P } from "./paths.mjs";

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * @param {object} o
 * @param {string[]} [o.fallback] argv that runs the core CLI, e.g. [node, bin/jarvis.mjs]
 * @param {Record<string,string>} [o.env] extra env for the fallback (ELECTRON_RUN_AS_NODE=1)
 */
export function shimScript({ fallback = [process.execPath, BIN], env = {}, socket = P.socket } = {}) {
  const envs = Object.entries(env).map(([k, v]) => `${k}=${sq(v)} `).join("");
  const argv = fallback.map(sq).join(" ");
  const run = `${envs}${argv}`;
  return `#!/bin/sh
# Jarvis Voice hook shim. Written by Jarvis; \`jarvis uninstall\` removes the hooks that call it.
SOCK=${sq(socket)}
EXE=${sq(fallback[0])}
post() { [ -S "$SOCK" ] && command -v curl >/dev/null 2>&1 && curl -fsS -m 2 --unix-socket "$SOCK" -H 'Content-Type: application/json' --data-binary @- "http://jarvis$1" >/dev/null 2>&1; }
fallback() { [ -x "$EXE" ] || exit 0; ${run} "$@" >/dev/null 2>&1; exit 0; }
case "$1" in
  hook)
    agent="\${2:-claude-code}"
    payload=$(cat)
    printf '%s' "$payload" | post "/hook/$agent" && exit 0
    printf '%s' "$payload" | fallback hook "$agent"
    ;;
  codex)
    [ "$JARVIS_FORWARDED" = 1 ] && exit 0
    for last; do :; done
    printf '%s' "$last" | post /codex && exit 0
    fallback "$@"
    ;;
  mcp)
    # Claude Desktop starts this as a long-running MCP server on stdin/stdout.
    [ -x "$EXE" ] || exit 1
    ${envs}exec ${argv} mcp
    ;;
  *)
    fallback "$@"
    ;;
esac
exit 0
`;
}

export function writeShim(opts = {}, file = P.shim) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, shimScript(opts), { mode: 0o700 });
  fs.renameSync(tmp, file);
  return file;
}
