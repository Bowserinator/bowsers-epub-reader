const HOVER_DELAY_MS = 800;
const SCROLL_QUIET_MS = 250;
const HIT_SLOP_PX = 2;

export interface HoverWord { word: string; context: string; range: Range; rect: DOMRect }
export interface HoverOptions {
  enabled: () => boolean;
  locale: () => string;
  onWord: (w: HoverWord) => void;
  onCancel: () => void;
}

type CaretDoc = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
};

export function wordAt(doc: Document, x: number, y: number, locale: string): HoverWord | null {
  const d = doc as CaretDoc;
  let node: Node | null = null, offset = 0;
  const r = d.caretRangeFromPoint?.(x, y);
  if (r) { node = r.startContainer; offset = r.startOffset; }
  else {
    const p = d.caretPositionFromPoint?.(x, y);
    if (p) { node = p.offsetNode; offset = p.offset; }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const text = (node as Text).data;
  if (!text.trim()) return null;
  let start = -1, end = -1;
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: object) => { segment(s: string): Iterable<{ index: number; segment: string; isWordLike?: boolean }> } }).Segmenter;
  if (Seg) {
    for (const s of new Seg(locale || 'en', { granularity: 'word' }).segment(text)) {
      if (offset >= s.index && offset < s.index + s.segment.length) {
        if (s.isWordLike) { start = s.index; end = s.index + s.segment.length; }
        break;
      }
    }
  } else {
    const m = /[\p{L}\p{M}\p{N}'’-]+/gu;
    for (let mm = m.exec(text); mm; mm = m.exec(text)) {
      if (offset >= mm.index && offset <= mm.index + mm[0].length) { start = mm.index; end = mm.index + mm[0].length; break; }
    }
  }
  if (start < 0) return null;
  const range = doc.createRange();
  range.setStart(node, start); range.setEnd(node, end);
  const rect = range.getBoundingClientRect();
  if (x < rect.left - HIT_SLOP_PX || x > rect.right + HIT_SLOP_PX || y < rect.top - HIT_SLOP_PX || y > rect.bottom + HIT_SLOP_PX) return null;
  return { word: text.slice(start, end), context: text.slice(start, start + 64), range, rect };
}

export function attachHover(doc: Document, o: HoverOptions): () => void {
  let timer: number | undefined;
  let lastX = -1, lastY = -1;
  let blocked = false;
  const clear = () => { if (timer) { clearTimeout(timer); timer = undefined; } };
  const cancel = () => { clear(); o.onCancel(); };
  const move = (e: MouseEvent) => {
    if (!o.enabled()) return;
    if (e.buttons !== 0 || blocked) { cancel(); return; }
    if (Math.abs(e.clientX - lastX) < 3 && Math.abs(e.clientY - lastY) < 3) return;
    lastX = e.clientX; lastY = e.clientY;
    cancel();
    timer = window.setTimeout(() => {
      const sel = doc.getSelection?.();
      if (sel && !sel.isCollapsed) return;
      const w = wordAt(doc, lastX, lastY, o.locale());
      if (w) o.onWord(w);
    }, HOVER_DELAY_MS);
  };
  const scroll = () => { blocked = true; cancel(); window.setTimeout(() => (blocked = false), SCROLL_QUIET_MS); };
  doc.addEventListener('mousemove', move, { passive: true });
  doc.addEventListener('mouseleave', cancel, { passive: true });
  doc.addEventListener('mousedown', cancel, { passive: true });
  doc.addEventListener('keydown', cancel, { passive: true });
  doc.addEventListener('wheel', scroll, { passive: true });
  doc.addEventListener('scroll', scroll, { passive: true, capture: true });
  return () => {
    clear();
    doc.removeEventListener('mousemove', move);
    doc.removeEventListener('mouseleave', cancel);
    doc.removeEventListener('mousedown', cancel);
    doc.removeEventListener('keydown', cancel);
    doc.removeEventListener('wheel', scroll);
    doc.removeEventListener('scroll', scroll, true);
  };
}
