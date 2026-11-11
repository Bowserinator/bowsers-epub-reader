// Swipe and wheel page turning.
const SWIPE_MIN_PX = 48;
const WHEEL_MIN_DELTA = 4;
const WHEEL_LOCK_MS = 300;

export type Side = 'left' | 'right';

/** The left half of the page area turns back and the right half turns forward. */
export function edgeSide(x: number, width: number): Side {
  return x < width / 2 ? 'left' : 'right';
}

export function wheelPager(isPaginated: () => boolean, onPage: (dir: 1 | -1) => void) {
  let last = 0;
  return (e: WheelEvent) => {
    if (!isPaginated() || e.ctrlKey) return;
    const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(d) < WHEEL_MIN_DELTA) return;
    e.preventDefault();
    const now = performance.now();
    if (now - last < WHEEL_LOCK_MS) return;
    last = now;
    onPage(d > 0 ? 1 : -1);
  };
}

export interface GestureOptions {
  isPaginated: () => boolean;
  onSwipe: (dir: Side) => void;
}

/** Turns a horizontal touch or pen swipe anywhere in `root` into a page turn. */
export function attachSwipe(root: Document | HTMLElement, o: GestureOptions): () => void {
  let x0 = 0, y0 = 0, t0 = 0, pid = -1;
  const doc = 'getSelection' in root ? root : root.ownerDocument;

  const down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    pid = e.pointerId; x0 = e.clientX; y0 = e.clientY; t0 = performance.now();
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    pid = -1;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    const sel = doc.getSelection?.();
    if (sel && !sel.isCollapsed) return;
    if (o.isPaginated() && Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5 && performance.now() - t0 < 800) {
      o.onSwipe(dx < 0 ? 'left' : 'right');
    }
  };
  const cancel = (e: PointerEvent) => { if (e.pointerId === pid) pid = -1; };

  const events: [string, EventListener][] = [
    ['pointerdown', down as EventListener], ['pointerup', up as EventListener], ['pointercancel', cancel as EventListener]
  ];
  for (const [n, f] of events) root.addEventListener(n, f, { passive: true, capture: true });
  return () => { for (const [n, f] of events) root.removeEventListener(n, f, true); };
}
