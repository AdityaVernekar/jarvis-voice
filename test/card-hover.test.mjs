import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createCardPointer } from "../app/main/card-pointer.mjs";

const renderer = fs.readFileSync(new URL("../app/renderer/card.js", import.meta.url), "utf8");

// Run the real renderer's events and timers with a native cursor. Layout is fixed here;
// the pointer tests cover geometry, while these exercise the hover/close IPC handoff.
function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const elements = new Map();
  const callbacks = {};
  const messages = [];
  function element() {
    const listeners = new Map();
    const children = new Map();
    return {
      dataset: {}, style: { setProperty() {} }, classList: { toggle() {} },
      value: "", offsetHeight: 200, offsetWidth: 460, scrollWidth: 24,
      querySelector(selector) {
        if (!children.has(selector)) children.set(selector, element());
        return children.get(selector);
      },
      querySelectorAll: () => [],
      prepend() {}, append() {}, remove() {}, replaceChildren() {},
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      fire(type, event = {}) {
        for (const fn of listeners.get(type) || []) fn({ target: { closest: () => null }, ...event });
      },
    };
  }
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  let point = { x: 100, y: 100 };
  const pointer = createCardPointer({
    getWindow: () => ({
      isVisible: () => true,
      isDestroyed: () => false,
      getBounds: () => ({ x: 516, y: 0, width: 480, height: 560 }),
      setIgnoreMouseEvents() {},
    }),
    getCursor: () => point,
    onChange: (on) => callbacks.Pointer?.(on),
  });
  const bridge = {
    card(action, value) {
      messages.push({ action, value });
      if (action === "rect") pointer.setRect(value);
      if (action === "hover") pointer.check();
    },
  };
  for (const name of ["Card", "Geom", "Agents", "Rest", "Pointer"]) bridge[`on${name}`] = (fn) => { callbacks[name] = fn; };
  vm.runInNewContext(renderer, {
    window: { earpiece: bridge, EarpieceLogos: { logo: element } },
    document: { getElementById: get, body: element(), activeElement: null, createElement: element },
    setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn(),
  });
  callbacks.Geom({ notch: true, notchW: 204, notchH: 33 });
  callbacks.Rest(true);
  pointer.start();
  t.after(() => pointer.stop());
  return {
    get, callbacks, messages,
    move(x, y) { point = { x, y }; t.mock.timers.tick(60); },
    tick: (ms) => t.mock.timers.tick(ms),
    view: () => get("card").dataset.view,
  };
}

test("agents list stays open through DOM mouseleave while moving into the panel", (t) => {
  const f = fixture(t);
  f.move(630, 15);
  f.get("card").fire("click");
  assert.equal(f.view(), "list");
  f.move(550, 180);
  f.get("card").fire("mouseleave");
  f.tick(1000);
  assert.equal(f.view(), "list");
  f.move(550, 400);
  f.tick(250);
  assert.equal(f.view(), "rest", "a real exit still closes the list");
});

test("returning before the close timer expires keeps the list open without DOM entry", (t) => {
  const f = fixture(t);
  f.move(630, 15);
  f.get("card").fire("click");
  f.move(550, 400);
  f.tick(100);
  f.move(550, 180);
  f.tick(1000);
  assert.equal(f.view(), "list");
});

test("a notification stays readable while hovered and folds after a real exit", (t) => {
  const f = fixture(t);
  f.callbacks.Card({ id: "line-1", line: "Finished the task.", state: "spoken", kind: "done" });
  assert.equal(f.view(), "peek");
  f.move(630, 100);
  f.get("card").fire("mouseleave");
  f.tick(6000);
  assert.equal(f.view(), "peek");
  f.move(630, 400);
  f.tick(6000);
  assert.equal(f.view(), "mini");
});

test("questions still require a click and keep their button arming delay", (t) => {
  const f = fixture(t);
  f.callbacks.Card({
    id: "ask-1", line: "Run the command?", state: "ask", kind: "needs_input",
    ask: { id: "ask-1", kind: "permission", expiresAt: Date.now() + 60_000 },
  });
  f.move(630, 15);
  f.tick(1000);
  assert.equal(f.view(), "mini", "hover does not open permission prompts");
  f.get("card").fire("click");
  assert.equal(f.view(), "open");
  assert.equal(f.get("allow").disabled, true);
  f.move(550, 180);
  f.get("card").fire("mouseleave");
  f.tick(500);
  assert.equal(f.view(), "open");
  assert.equal(f.get("allow").disabled, true);
  f.tick(200);
  assert.equal(f.get("allow").disabled, false);
  f.move(550, 400);
  f.tick(450);
  assert.equal(f.view(), "mini");
});

test("a gone island reports no interactive area even on a notched display", (t) => {
  const f = fixture(t);
  f.callbacks.Rest(false);
  const rect = f.messages.filter((m) => m.action === "rect").at(-1).value;
  assert.equal(rect.w, 0);
  assert.equal(rect.h, 0);
});
