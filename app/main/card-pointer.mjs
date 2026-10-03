// Native cursor position owns hover. Transparent-window mouse events can leave/re-enter
// while click-through changes or the island animates, even with the cursor still inside.
export function createCardPointer({ getWindow, getCursor, onChange }) {
  let hovering = false;
  let rect = { w: 0, h: 0 };
  let timer = null;

  function setHover(on) {
    if (hovering === on) return;
    hovering = on;
    const win = getWindow();
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!on, { forward: true });
    onChange(on);
  }

  function check() {
    const win = getWindow();
    if (!win || win.isDestroyed() || !win.isVisible() || rect.w <= 0 || rect.h <= 0) {
      return setHover(false);
    }
    const b = win.getBounds();
    const p = getCursor();
    // Use the destination size throughout expansion, so the pointer can move into
    // the opening panel. A small exit margin keeps its animated edges forgiving.
    const margin = hovering ? 8 : 0;
    const half = rect.w / 2 + 10 + margin;
    const cx = b.x + b.width / 2;
    setHover(p.x >= cx - half && p.x <= cx + half && p.y >= b.y && p.y <= b.y + rect.h + 2 + margin);
  }

  return {
    check,
    setRect(value) {
      rect = value;
      check();
    },
    start() {
      if (timer !== null) return;
      // Watch entry as well as exit: changing click-through can swallow DOM events.
      timer = setInterval(check, 60);
      check();
    },
    stop() {
      clearInterval(timer);
      timer = null;
      rect = { w: 0, h: 0 };
      setHover(false);
    },
  };
}
