// Earpiece was called Jarvis Voice before 0.3. Old JARVIS_* variables still work: each one fills
// in its EARPIECE_* name when that isn't set, so the rest of the code only reads EARPIECE_*.
// paths.mjs imports this first, so it runs before anything reads the environment.
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith("JARVIS_")) continue;
  const next = `EARPIECE_${k.slice(7)}`;
  if (process.env[next] === undefined) process.env[next] = v;
}
