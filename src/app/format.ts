export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: number | undefined;
  const d = (...a: A) => { if (t) clearTimeout(t); t = window.setTimeout(() => { t = undefined; fn(...a); }, ms); };
  d.flush = (...a: A) => { if (t) clearTimeout(t); t = undefined; fn(...a); };
  return d;
}

export function uuid(): string {
  return (crypto as Crypto & { randomUUID?: () => string }).randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** Appends to a stack, discarding the oldest entries beyond `max`. */
export function pushCapped<T>(stack: T[], item: T, max: number) {
  stack.push(item);
  if (stack.length > max) stack.splice(0, stack.length - max);
}

export function clamp(n: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, n)); }

export interface Rect { left: number; top: number; right: number; bottom: number }

/** Translates a rect by the position of another rect's top-left corner. */
export function offsetRect(r: Rect, origin: { left: number; top: number }): Rect {
  return { left: r.left + origin.left, top: r.top + origin.top, right: r.right + origin.left, bottom: r.bottom + origin.top };
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const formatPage = (page: number | string) => `pg.${page}`;
