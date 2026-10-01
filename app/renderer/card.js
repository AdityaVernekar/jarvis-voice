// Floating card. The app sends it one card at a time; it animates in, stays while the line is
// spoken (and while you hover), then animates out and tells the app to hide the window.
// A question an agent is waiting on ("ask" cards) stays until it is answered, times out, or you
// send it back to the terminal. Nothing is approved without a click on a button.
const J = window.earpiece;
const $ = (id) => document.getElementById(id);
const card = $("card");
const REASON = { mode_quiet: "Quiet", quiet_hours: "Quiet hours", agent_disabled: "Muted", voice_failed: "No voice" };
// A "speaking" card is replaced within seconds by spoken/stopped. If it never is (the process that
// wrote it died), don't leave the window stuck on screen.
const SPEAKING_MAX_MS = 60_000;
// Buttons wake up a moment after a question appears, so a click meant for the window underneath
// can't approve a command.
const ARM_MS = 700;
let current = null;
let hideTimer = null;
let armTimer = null;
let hovering = false;
let busy = false;

function holdFor(c) {
  if (c.brief) return 1800;
  const words = String(c.line || "").split(/\s+/).length;
  return Math.min(Math.max(4500, words * 330 + 2500), 12000);
}

function scheduleHide() {
  clearTimeout(hideTimer);
  if (!current || hovering || current.ask) return;
  hideTimer = setTimeout(hide, current.state === "speaking" ? SPEAKING_MAX_MS : holdFor(current));
}

function hide() {
  clearTimeout(hideTimer);
  card.classList.remove("in");
  card.classList.add("out");
  setTimeout(() => {
    if (card.classList.contains("out")) J.card("hidden");
  }, 260);
}

// ---------- questions ----------

const choiceButtons = () => [$("allow"), $("always"), $("deny"), $("terminal"), $("send"), $("replyTerminal")];

function setBusy(on) {
  busy = on;
  for (const b of choiceButtons()) b.disabled = on || b.dataset.armed !== "1";
}

function arm(on) {
  clearTimeout(armTimer);
  for (const b of choiceButtons()) b.dataset.armed = on ? "1" : "0";
  setBusy(false);
  if (!on) armTimer = setTimeout(() => arm(true), ARM_MS);
}

function startTimer(expiresAt) {
  const bar = $("timerBar");
  const left = Math.max(0, expiresAt - Date.now());
  bar.style.transition = "none";
  bar.style.transform = "scaleX(1)";
  void bar.offsetWidth;
  bar.style.transition = `transform ${left}ms linear`;
  bar.style.transform = "scaleX(0)";
}

function showAsk(c) {
  const a = c.ask;
  const perm = a.kind === "permission";
  $("ask").hidden = false;
  $("detail").textContent = a.detail || "";
  $("detail").hidden = !a.detail;
  $("why").textContent = a.why || "";
  $("why").hidden = !a.why;
  $("rule").textContent = a.canAlways && a.alwaysRule ? `Always allow adds: ${a.alwaysRule}` : "";
  $("rule").hidden = !$("rule").textContent;
  $("allow").hidden = Boolean(a.partial);
  $("askErr").textContent = a.partial ? "Too long to approve here. Check the whole command in the terminal." : "";
  $("choices").hidden = !perm;
  $("always").hidden = !a.canAlways;
  $("reply").hidden = perm;
  $("replyText").value = "";
  $("replyText").placeholder = `Reply to ${c.agentName || "the agent"}…  (Enter to send, Shift+Enter for a new line)`;
  $("askErr").hidden = !a.partial;
  arm(false);
  startTimer(a.expiresAt);
}

function hideAsk() {
  $("ask").hidden = true;
  clearTimeout(armTimer);
  if (document.activeElement === $("replyText")) $("replyText").blur();
}

async function answer(payload) {
  if (!current?.ask || busy) return;
  const id = current.ask.id;
  setBusy(true);
  let r;
  try {
    r = await J.answer(id, payload);
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  if (r?.ok || current?.ask?.id !== id) return; // the app has already moved the card on
  $("askErr").textContent = r?.error || "Couldn't send that.";
  $("askErr").hidden = false;
  setBusy(false);
}

$("allow").addEventListener("click", () => answer({ behavior: "allow" }));
$("always").addEventListener("click", () => answer({ behavior: "always" }));
$("deny").addEventListener("click", () => answer({ behavior: "deny" }));
const toTerminal = () => current?.ask && J.card("defer", current.ask.id);
$("terminal").addEventListener("click", toTerminal);
$("replyTerminal").addEventListener("click", toTerminal);

// The card never takes the keyboard on its own. Clicking into the box makes it focusable;
// the app gives the keyboard back to your terminal when the box is done with.
const box = $("replyText");
box.addEventListener("mousedown", async (e) => {
  if (document.activeElement === box) return;
  e.preventDefault();
  await J.card("focus", true);
  box.focus();
});
box.addEventListener("blur", () => {
  if (!box.value.trim()) J.card("focus", false);
});
box.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    box.blur();
    J.card("focus", false);
  } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (box.value.trim()) answer({ text: box.value });
  }
});
$("send").addEventListener("click", () => box.value.trim() && answer({ text: box.value }));

// ---------- showing cards ----------

function show(c) {
  if (c.state === "clear") {
    if (current?.ask) {
      current = null;
      hideAsk();
      hide();
    }
    return;
  }
  const same = current && current.id === c.id;
  const isAsk = Boolean(c.ask);
  current = c;
  card.className = `card ${c.state === "silent" ? "silent" : c.kind} ${c.state}${isAsk ? " asking" : ""}`;
  if (!same) {
    const av = $("avatar");
    av.querySelector(".logo")?.remove();
    av.prepend(window.EarpieceLogos.logo(c.agentId));
    $("who").textContent = c.agentName || "Earpiece";
    $("project").textContent = c.project || "";
    $("line").textContent = c.line;
    card.title = isAsk ? "" : c.line;
    $("close").title = isAsk ? "Answer in the terminal instead" : "Dismiss";
    if (isAsk) showAsk(c);
    else hideAsk();
  }
  const chip = $("chip");
  let label = c.state === "silent" ? REASON[c.reason] || "Silent" : c.kind === "needs_input" ? "Needs you" : c.kind === "error" ? "Error" : "";
  if (isAsk && c.more > 0) label += ` · +${c.more} more`;
  chip.textContent = label;
  chip.hidden = !label;
  requestAnimationFrame(() => {
    card.classList.add("in");
    if (isAsk) J.card("size", card.offsetHeight + 30); // body padding, so the window fits the card
  });
  scheduleHide();
}

J.onCard(show);
card.addEventListener("mouseenter", () => ((hovering = true), clearTimeout(hideTimer), J.card("hover", true)));
card.addEventListener("mouseleave", () => ((hovering = false), J.card("hover", false), scheduleHide()));
card.addEventListener("click", (e) => {
  if (current?.ask) return e.target.closest("#close") ? toTerminal() : undefined; // only the buttons act on a question
  if (e.target.closest("#stop")) return J.card("stop");
  if (e.target.closest("#close")) return hide();
  J.card("open");
  hide();
});
