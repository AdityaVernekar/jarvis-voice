#!/usr/bin/env node
// Legacy entry point. Hooks installed by jarvis-voice 0.1 point here; it forwards to bin/jarvis.mjs.
// Re-run `jarvis install` to move your hooks to the new path. Safe to keep either way.
import { run } from "./src/cli/main.mjs";

run();
