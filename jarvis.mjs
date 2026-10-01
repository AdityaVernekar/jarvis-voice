#!/usr/bin/env node
// Legacy entry point. Hooks installed by jarvis-voice 0.1 point here; it forwards to the CLI.
// Re-run `earpiece install` to move your hooks to bin/earpiece.mjs. Safe to keep either way.
import { run } from "./src/cli/main.mjs";

run();
