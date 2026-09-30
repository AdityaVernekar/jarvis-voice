// Offline system voice: macOS `say`, or espeak-ng / espeak / spd-say on Linux.
import { spawnSync } from "node:child_process";
import { which } from "../../util.mjs";

const run = (bin, args) => spawnSync(bin, args, { stdio: "ignore" }).status === 0;

export default {
  id: "say",
  label: "System voice",
  keyName: null,
  async speak(text, { cfg, lang }) {
    const hindi = lang === "hi" || lang === "hinglish";
    if (which("say")) {
      const voice = hindi ? "Lekha" : cfg.sayVoice;
      if (run("say", ["-v", voice, text]) || run("say", [text])) return;
      throw new Error("say failed");
    }
    for (const bin of ["espeak-ng", "espeak"]) {
      if (which(bin)) {
        if (run(bin, hindi ? ["-v", "hi", text] : [text])) return;
        throw new Error(`${bin} failed`);
      }
    }
    if (which("spd-say") && run("spd-say", ["--wait", text])) return;
    throw new Error("no system voice (say / espeak-ng / spd-say)");
  },
};
