// Exact page counts for the whole book.
import { collectText, type TextSpan } from './searchText';
import { alignChapterStarts } from './chapterSpread';

export interface PageGeometry {
  width: number;
  height: number;
  columnWidth: number;
  gap: number;
  divisor: number;
  scrolled: boolean;
  chapterSpread: boolean;
  /** Identifies the book styling so layout changes can be detected cheaply. */
  styleKey: string;
  css: () => string;
}

export interface SectionPages {
  pages: number;
  /** [text offset, page] pairs, at each offset where the page number changes. */
  marks: [number, number][];
  /** Page (within the section) of each requested element id. */
  anchors: Record<string, number>;
}

export interface PageMap {
  key: string;
  sections: SectionPages[];
  /** starts[i] = pages before section i. */
  starts: number[];
  total: number;
}

export function buildPageMap(key: string, sections: SectionPages[]): PageMap {
  const starts: number[] = [];
  let t = 0;
  for (const s of sections) { starts.push(t); t += s.pages; }
  return { key, sections, starts, total: t };
}

/** Number of the page containing a text offset of a section. */
export function pageAtOffset(m: PageMap, spineIndex: number, offset: number): number {
  const s = m.sections[spineIndex];
  if (!s) return 0;
  let lo = 0, hi = s.marks.length - 1, page = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.marks[mid][0] <= offset) { page = s.marks[mid][1]; lo = mid + 1; } else hi = mid - 1;
  }
  return m.starts[spineIndex] + Math.min(page, s.pages);
}

/** Section and in-section page for an absolute page number. */
export function locatePage(m: PageMap, page: number): { spineIndex: number; inSection: number } | null {
  if (page < 1 || page > m.total) return null;
  for (let i = m.sections.length - 1; i >= 0; i--) {
    if (m.starts[i] < page && m.sections[i].pages > 0) return { spineIndex: i, inSection: page - m.starts[i] };
  }
  return null;
}

const nextTick = () => new Promise<void>((r) => setTimeout(r, 0));

function loadFrame(frame: HTMLIFrameElement, html: string): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { frame.removeEventListener('load', done); resolve(); };
    frame.addEventListener('load', done);
    frame.srcdoc = html;
  });
}

async function settle(doc: Document) {
  const imgs = [...doc.images].filter((i) => !i.complete).map((i) => new Promise<void>((r) => { i.onload = i.onerror = () => r(); }));
  const waits: Promise<unknown>[] = [...imgs];
  if (doc.fonts?.ready) waits.push(doc.fonts.ready);
  await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 3000))]);
}

function measure(doc: Document, g: PageGeometry, anchorIds: string[], chapterIds: string[]): SectionPages {
  const step = g.columnWidth + g.gap;
  const pageOfRect = (r: { left: number; top: number }) =>
    g.scrolled ? Math.floor(Math.max(0, r.top) / g.height) + 1 : Math.floor((Math.max(0, r.left) + 1) / step) + 1;

  if (g.chapterSpread && chapterIds.length) alignChapterStarts(doc, chapterIds, step);

  const root = doc.documentElement;
  const extent = g.scrolled ? Math.max(root.scrollHeight, doc.body.scrollHeight) : Math.max(root.scrollWidth, doc.body.scrollWidth);
  let pages: number;
  if (g.scrolled) pages = Math.max(1, Math.ceil(extent / g.height));
  else {
    const cols = Math.max(1, Math.round((extent + g.gap) / step));
    pages = Math.ceil(cols / g.divisor) * g.divisor;
    if (g.chapterSpread) pages = Math.ceil(pages / 2) * 2;
  }

  const marks: [number, number][] = [];
  const { spans } = collectText(doc);
  const pageAt = (s: TextSpan, off: number): number | null => {
    try {
      const r = doc.createRange();
      const at = s.map[off - s.start];
      r.setStart(s.node, at);
      r.setEnd(s.node, at + 1);
      const rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) return null;
      return pageOfRect(rect);
    } catch { return null; }
  };
  let last = 1;
  const scan = (s: TextSpan, lo: number, hi: number, plo: number, phi: number) => {
    if (plo === phi) return;
    if (hi - lo <= 1) { marks.push([hi, phi]); last = phi; return; }
    const mid = (lo + hi) >> 1;
    const pm = pageAt(s, mid) ?? plo;
    scan(s, lo, mid, plo, pm);
    scan(s, mid, hi, pm, phi);
  };
  for (const s of spans) {
    if (s.end <= s.start) continue;
    const p0 = pageAt(s, s.start);
    if (p0 === null) continue;
    if (p0 !== last) { marks.push([s.start, p0]); last = p0; }
    const p1 = s.end - 1 > s.start ? pageAt(s, s.end - 1) : p0;
    if (p1 !== null && p1 !== p0) scan(s, s.start, s.end - 1, p0, p1);
  }

  const anchors: Record<string, number> = {};
  for (const id of anchorIds) {
    const el = doc.getElementById(id) ?? doc.getElementsByName(id)[0];
    if (!el) continue;
    const rect = (el as HTMLElement).getClientRects()[0] ?? el.getBoundingClientRect();
    anchors[id] = Math.min(pageOfRect(rect), pages);
  }
  return { pages, marks, anchors };
}

/** Lays out every section and counts its pages. Resolves null if `cancelled()` turns true. */
export async function measureBook(
  sectionCount: number,
  renderSection: (index: number) => Promise<string>,
  g: PageGeometry,
  anchorsFor: (index: number) => string[],
  chapterIdsFor: (index: number) => string[],
  cancelled: () => boolean
): Promise<SectionPages[] | null> {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:-100000px;top:0;border:0;visibility:hidden;pointer-events:none;width:${g.width}px;height:${g.height}px;`;
  document.body.appendChild(frame);
  const out: SectionPages[] = [];
  try {
    for (let i = 0; i < sectionCount; i++) {
      if (cancelled()) return null;
      let res: SectionPages = { pages: 1, marks: [], anchors: {} };
      try {
        await loadFrame(frame, await renderSection(i));
        const doc = frame.contentDocument;
        if (doc?.body) {
          const style = doc.createElement('style');
          style.textContent = `${g.css()}
html{margin:0!important;padding:0!important;width:${g.width}px;height:${g.height}px;}
body{margin:0!important;padding:0!important;width:${g.width}px;${g.scrolled ? '' : `height:${g.height}px;column-width:${g.columnWidth}px;column-gap:${g.gap}px;column-fill:auto;`}}
img,svg{max-width:${g.columnWidth}px!important;max-height:${g.height}px!important;object-fit:contain;break-inside:avoid;}`;
          doc.head.appendChild(style);
          await settle(doc);
          res = measure(doc, g, anchorsFor(i), chapterIdsFor(i));
        }
      } catch { /* an unreadable section counts as one page */ }
      out.push(res);
      await nextTick();
    }
  } finally {
    frame.remove();
  }
  return cancelled() ? null : out;
}
