import assert from "node:assert/strict";
import test from "node:test";
import { createCardPointer } from "../app/main/card-pointer.mjs";

function fixture(t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const changes = [];
  const ignores = [];
  let point = { x: 100, y: 100 };
  const win = {
    visible: true,
    destroyed: false,
    bounds: { x: 516, y: 0, width: 480, height: 560 },
    isDestroyed() { return this.destroyed; },
    isVisible() { return this.visible; },
    getBounds() { return this.bounds; },
    setIgnoreMouseEvents(ignore) { ignores.push(ignore); },
  };
  const pointer = createCardPointer({
    getWindow: () => win,
    getCursor: () => point,
    onChange: (on) => changes.push(on),
  });
  pointer.setRect({ w: 276, h: 33 });
  pointer.start();
  t.after(() => pointer.stop());
  return { pointer, win, changes, ignores, move: (x, y) => { point = { x, y }; }, tick: () => t.mock.timers.tick(60) };
}

test("native polling finds entry even when the page misses mouseenter", (t) => {
  const f = fixture(t);
  f.move(630, 15);
  f.tick();
  assert.deepEqual(f.changes, [true]);
  assert.deepEqual(f.ignores, [false]);
});

test("spurious leave checks do not close the island or toggle click-through", (t) => {
  const f = fixture(t);
  f.move(630, 15);
  f.pointer.check();
  for (let i = 0; i < 10; i++) f.pointer.check();
  assert.deepEqual(f.changes, [true]);
  assert.deepEqual(f.ignores, [false]);
});

test("the cursor can move from the notch into the full panel during expansion", (t) => {
  const f = fixture(t);
  f.move(630, 15);
  f.tick();
  f.pointer.setRect({ w: 460, h: 300 });
  f.move(550, 280);
  for (let i = 0; i < 10; i++) f.tick();
  assert.deepEqual(f.changes, [true]);
  f.move(550, 340);
  f.tick();
  assert.deepEqual(f.changes, [true, false]);
  assert.deepEqual(f.ignores, [false, true]);
});

test("small edge movements retain hover, but the margin does not trigger entry", (t) => {
  const f = fixture(t);
  f.move(756, 40);
  f.tick();
  assert.deepEqual(f.changes, []);
  f.move(756, 30);
  f.tick();
  f.move(756, 40);
  f.tick();
  assert.deepEqual(f.changes, [true]);
  f.move(756, 45);
  f.tick();
  assert.deepEqual(f.changes, [true, false]);
});

test("leaving and returning without page events restores hover", (t) => {
  const f = fixture(t);
  f.move(630, 15);
  f.tick();
  f.move(630, -1);
  f.tick();
  f.move(630, 15);
  f.tick();
  assert.deepEqual(f.changes, [true, false, true]);
});

test("uses window coordinates on a display with a negative origin", (t) => {
  const f = fixture(t);
  f.win.bounds = { x: -1200, y: -900, width: 480, height: 560 };
  f.move(-960, -885);
  f.tick();
  assert.deepEqual(f.changes, [true]);
  f.move(-960, -840);
  f.tick();
  assert.deepEqual(f.changes, [true, false]);
});

test("hidden, empty, or destroyed islands stop catching clicks", (t) => {
  const f = fixture(t);
  f.move(630, 15);
  f.tick();
  f.win.visible = false;
  f.tick();
  f.win.visible = true;
  f.tick();
  f.pointer.setRect({ w: 0, h: 0 });
  f.pointer.setRect({ w: 276, h: 33 });
  f.win.destroyed = true;
  f.tick();
  assert.deepEqual(f.changes, [true, false, true, false, true, false]);
  assert.deepEqual(f.ignores, [false, true, false, true, false]);
});

test("stopping releases hover and cancels polling; restarting has no stale rectangle", (t) => {
  const f = fixture(t);
  f.move(630, 15);
  f.tick();
  f.pointer.stop();
  f.tick();
  f.pointer.start();
  f.tick();
  assert.deepEqual(f.changes, [true, false]);
  f.pointer.setRect({ w: 276, h: 33 });
  assert.deepEqual(f.changes, [true, false, true]);
});
