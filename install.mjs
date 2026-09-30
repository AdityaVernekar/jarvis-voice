#!/usr/bin/env node
// Installs Jarvis for every supported agent. Same as `jarvis install`.
//   node install.mjs [--only claude-code,codex] [--chain] [--env path/.env]
//   node install.mjs --uninstall
import { run } from "./src/cli/main.mjs";

run(["install", ...process.argv.slice(2)]);
