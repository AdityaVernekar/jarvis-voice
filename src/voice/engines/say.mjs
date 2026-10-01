// Offline system voice: macOS `say`, or espeak-ng / espeak / spd-say on Linux.
import { which } from "../../util.mjs";
import { run } from "../play.mjs";

export default {
  id: "say",
  label: "System voice",
  keyName: null,
  async speak(text, { cfg, lang, ready }) {
    await ready?.(); // no API to wait for: the voice starts right away
    const hindi = lang === "hi" || lang === "hinglish";
    if (which("say")) {
      const voice = hindi ? "Lekha" : cfg.sayVoice;
      if ((await run("say", ["-v", voice, text])) || (await run("say", [text]))) return;
      throw new Error("say failed");
    }
    for (const bin of ["espeak-ng", "espeak"]) {
      if (which(bin)) {
        if (await run(bin, hindi ? ["-v", "hi", text] : [text])) return;
        throw new Error(`${bin} failed`);
      }
    }
    if (which("spd-say") && (await run("spd-say", ["--wait", text]))) return;
    throw new Error("no system voice (say / espeak-ng / spd-say)");
  },
};
