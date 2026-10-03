// TTS engine registry. An engine is { id, label, keyName, speak(text, ctx) }.
// speak() must throw on any failure so the chain can fall through to the next engine.
// See docs/engines.md to add one.
import earpiece from "./earpiece.mjs";
import openai from "./openai.mjs";
import say from "./say.mjs";
import smallest from "./smallest.mjs";

const ENGINES = new Map();
export function registerEngine(engine) {
  if (!engine?.id || typeof engine.speak !== "function") throw new Error("engine needs an id and speak()");
  ENGINES.set(engine.id, engine);
}
export const getEngine = (id) => ENGINES.get(id) || null;
export const listEngines = () => [...ENGINES.values()];

for (const e of [earpiece, smallest, openai, say]) registerEngine(e);
