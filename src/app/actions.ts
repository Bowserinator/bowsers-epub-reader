import { cubicOut } from 'svelte/easing';
import type { Rect } from './format';

export const PANEL_SLIDE_MS = 100;
export const TOAST_OUT_MS = 200;
export const POPUP_MARGIN = 8;

/** Slides a side panel in from, and back out to, the given edge. */
export function panelSlide(_node: HTMLElement, o: { from: 'left' | 'right'; enabled: boolean }) {
  const dir = o.from === 'left' ? -1 : 1;
  return { duration: o.enabled ? PANEL_SLIDE_MS : 0, css: (t: number) => `transform: translateX(${dir * (1 - cubicOut(t)) * 100}%)` };
}

/** Fades a centered toast out while it sinks slightly. */
export function toastOut(_node: HTMLElement, o: { enabled: boolean }) {
  return { duration: o.enabled ? TOAST_OUT_MS : 0, css: (t: number) => `transform: translateX(-50%) translateY(${(1 - cubicOut(t)) * 16}px); opacity: ${t}` };
}

/** Trap Tab focus inside a dialog and restore focus to the previously focused element on close. */
export function trap(node: HTMLElement) {
  const prev = document.activeElement as HTMLElement | null;
  const sel = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';
  queueMicrotask(() => (node.querySelector<HTMLElement>('[data-autofocus]') ?? node.querySelector<HTMLElement>(sel))?.focus());
  const kd = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const f = [...node.querySelectorAll<HTMLElement>(sel)].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  node.addEventListener('keydown', kd);
  return { destroy() { node.removeEventListener('keydown', kd); prev?.focus?.(); } };
}

const fit = (pos: number, size: number, limit: number, margin: number) => Math.max(margin, Math.min(limit - size - margin, pos));

/** Places a popup with its top-left corner at the point, shifted to stay inside the window. */
export function placeAtPoint(x: number, y: number, w: number, h: number, margin = POPUP_MARGIN) {
  return { left: fit(x, w, window.innerWidth, margin), top: fit(y, h, window.innerHeight, margin) };
}

/**
 * Centers a tooltip horizontally on the anchor and puts it above it, or below when the anchor is in the top half of the
 * window. It flips to the other side when its preferred side is too small, and always stays inside the window.
 */
export function placeTooltip(anchor: Rect, w: number, h: number, margin = POPUP_MARGIN, gap = 6) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const left = fit((anchor.left + anchor.right) / 2 - w / 2, w, vw, margin);
  const spaceAbove = anchor.top - gap - margin, spaceBelow = vh - anchor.bottom - gap - margin;
  let below = (anchor.top + anchor.bottom) / 2 < vh / 2;
  if (below && h > spaceBelow && spaceAbove > spaceBelow) below = false;
  else if (!below && h > spaceAbove && spaceBelow > spaceAbove) below = true;
  const top = below ? anchor.bottom + gap : anchor.top - gap - h;
  return { left, top: fit(top, h, vh, margin) };
}

/** Builds a pointerdown handler that calls `close` when the backdrop itself is pressed. */
export const onBackdrop = (close: () => void) => (e: PointerEvent) => { if (e.target === e.currentTarget) close(); };

/** Attaches a non-passive wheel listener so the handler may call preventDefault. */
export function onWheel(node: HTMLElement, handler: (e: WheelEvent) => void) {
  node.addEventListener('wheel', handler, { passive: false });
  return { destroy() { node.removeEventListener('wheel', handler); } };
}
