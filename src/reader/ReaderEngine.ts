import ePub from 'epubjs';
import { isScrollMode, isSpreadMode, type ReaderMode, type TextAlign } from '../settings/defaults';
import { type BookModel, type TocNode, locate } from './locations';
import { collectText, locateNear, rangeFromOffsets } from './searchText';
import type { PageGeometry } from './pageMap';
import { attachSwipe, wheelPager } from './touch';
import { subtractRange } from './rangeMath';
import { attachHover, type HoverWord } from './hoverDefine';
import { isTypingTarget, offsetRect, type Rect } from '../app/format';
import { installChapterSpread, midSpineAnchors, type ChapterSpreadHandle } from './chapterSpread';

export interface Appearance {
  bg: string; fg: string; dark: boolean; fontStack: string; fontSizePx: number; lineHeight: number; textAlign: TextAlign; fontCss: string;
}

export interface LocationInfo {
  cfi: string;
  endCfi: string;
  spineIndex: number;
  spineHref: string;
  page: number;      // 1-based displayed page within the section (paginated modes)
  pagesInSection: number;
  fracInSection: number;
}

export interface SelectionInfo {
  cfiRange: string; text: string; rect: Rect;
  spineHref: string; prefix: string; suffix: string;
}

export interface EngineHandlers {
  onRelocated(l: LocationInfo): void;
  onSelected(s: SelectionInfo): void;
  onSelectionCleared(): void;
  onContextMenu(x: number, y: number): void;
  onKey(e: KeyboardEvent): void;
  onHoverWord(w: HoverWord & { frameRect: DOMRect; cfi: string } | null): void;
  onSwipe(dir: 'left' | 'right'): void;
  onWheelPage(dir: 1 | -1): void;
  hoverEnabled(): boolean;
  locale(): string;
  onBookPointerDown(): void;
}

export const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: '#ffd43b', mint: '#63e6be', pink: '#f783ac', blue: '#4dabf7', violet: '#9775fa'
};

export function highlightFill(color: string): string {
  return HIGHLIGHT_COLORS[color] ?? HIGHLIGHT_COLORS.yellow;
}

export const MIN_SPREAD_WIDTH = 760;

const QUOTE_CONTEXT_CHARS = 32;
const SETTLE_MS = 150;
const LAYOUT_WAIT_MS = 50;
const LAYOUT_WAIT_TRIES = 20;

export interface HighlightPiece { cfiRange: string; text: string; prefix: string; suffix: string }

const spinePos = (cfi: string): number => new (ePub as any).CFI(cfi).spinePos;
const cfiCompare = (a: string, b: string): number => new (ePub as any).CFI().compare(a, b);
const linkColor = (dark: boolean) => (dark ? '#8ab4ff' : '#1a4fb4');

function quoteContext(range: Range): { prefix: string; suffix: string } {
  const before = range.startContainer.textContent ?? '';
  const after = range.endContainer.textContent ?? '';
  return {
    prefix: before.slice(Math.max(0, range.startOffset - QUOTE_CONTEXT_CHARS), range.startOffset),
    suffix: after.slice(range.endOffset, range.endOffset + QUOTE_CONTEXT_CHARS)
  };
}

function stripScripts(html: string): string {
  return html.replace(/<script\b[^>]*\/>/gi, '').replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
}

export class ReaderEngine {
  book: any;
  rendition: any;
  host!: HTMLElement;
  mode: ReaderMode = 'spread';
  isRtl = false;
  fixedLayout = false;
  spineItems: { href: string; index: number }[] = [];
  model: BookModel | null = null;
  pageListLabels = false;
  chapterSpread: ChapterSpreadHandle | null = null;
  private appearance!: Appearance;
  private h: EngineHandlers;
  private locationsReady = false;
  private cleanups = new Map<any, () => void>();
  private highlights = new Map<string, { cfi: string; color: string }>();
  private lastLoc: LocationInfo | null = null;
  private ro?: ResizeObserver;
  private destroyed = false;
  private markTimer?: number;
  private settleTimer?: number;
  private hoverCfi: string | null = null;

  constructor(h: EngineHandlers) { this.h = h; }

  async open(bytes: ArrayBuffer): Promise<TocNode[]> {
    this.book = ePub(bytes as any);
    await this.book.ready;
    // Hooks receive the original output; edit section.output so earlier hooks' changes are kept.
    this.book.spine.hooks.serialize.register((_output: string, section: any) => {
      section.output = stripScripts(section.output);
    });
    this.spineItems = (this.book.spine.spineItems ?? this.book.spine.items ?? []).map((s: any, i: number) => ({ href: s.href as string, index: s.index ?? i }));
    const md = this.book.packaging?.metadata ?? {};
    this.isRtl = md.direction === 'rtl' || this.book.packaging?.spine?.direction === 'rtl' || this.book.package?.metadata?.direction === 'rtl';
    this.fixedLayout = md.layout === 'pre-paginated';
    try { await this.book.loaded.pageList; this.pageListLabels = (this.book.pageList?.pages?.length ?? 0) > 0; } catch { this.pageListLabels = false; }
    const nav = await this.book.loaded.navigation;
    return this.convertToc(nav?.toc ?? [], 0);
  }

  findSpineIndex(href: string): number {
    const clean = decodeURIComponent(href.split('#')[0]).replace(/^\.\//, '');
    let best = -1, bestLen = -1;
    for (const s of this.spineItems) {
      const sh = decodeURIComponent(s.href);
      if (sh === clean) return s.index;
      let n = 0;
      const a = sh.split('/').reverse(), b = clean.split('/').reverse();
      while (n < a.length && n < b.length && a[n] === b[n]) n++;
      if (n > bestLen && n > 0) { best = s.index; bestLen = n; }
    }
    return best;
  }

  private convertToc(items: any[], depth: number): TocNode[] {
    return items.map((it, i) => {
      const href: string = it.href ?? '';
      const [path, frag] = href.split('#');
      return {
        id: it.id ?? `toc-${depth}-${i}-${href}`,
        href,
        label: String(it.label ?? '').replace(/\s+/g, ' ').trim() || '(untitled)',
        depth,
        spineIndex: path ? this.findSpineIndex(path) : -1,
        fragment: frag ? decodeURIComponent(frag) : null,
        subitems: this.convertToc(it.subitems ?? [], depth + 1)
      };
    });
  }

  setModel(m: BookModel) { this.model = m; }

  async start(host: HTMLElement, mode: ReaderMode, appearance: Appearance, target: string | null | undefined, gap: number) {
    this.host = host;
    this.appearance = appearance;
    this.mode = this.fixedLayout && mode !== 'single-scroll' ? 'spread' : mode;
    this.teardownRendition();
    host.innerHTML = '';
    await this.waitForLayout(host);
    const scrolled = isScrollMode(this.mode);
    const opts: any = {
      width: '100%', height: '100%',
      flow: this.mode === 'continuous' ? 'scrolled' : this.mode === 'single-scroll' ? 'scrolled-doc' : 'paginated',
      manager: this.mode === 'continuous' ? 'continuous' : 'default',
      spread: scrolled ? 'none' : 'auto',
      gap,
      // Scripted content must be allowed or WebKit skips the reader's listeners in the frame; book scripts are stripped and blocked by the CSP.
      allowScriptedContent: true,
      allowPopups: false,
      defaultDirection: this.isRtl ? 'rtl' : 'ltr',
      snap: false
    };
    if (!scrolled) opts.minSpreadWidth = MIN_SPREAD_WIDTH;
    this.rendition = this.book.renderTo(host, opts);
    try { this.rendition.manager.viewSettings.forceEvenPages = this.mode === 'chapter-spread'; } catch { /* unsupported setting */ }
    this.rendition.hooks.content.register((contents: any) => this.onContents(contents));
    this.rendition.on('relocated', (loc: any) => this.onRelocated(loc));
    this.rendition.on('selected', (cfiRange: string, contents: any) => this.onSelected(cfiRange, contents));
    this.rendition.on('click', () => this.h.onBookPointerDown());
    if (this.mode === 'chapter-spread' && this.model) {
      const anchors = midSpineAnchors(this.model.chapters, (i) => this.spineItems[i]?.href);
      this.chapterSpread = installChapterSpread(this.rendition, anchors);
    }
    try {
      await this.rendition.display(target || undefined);
    } catch (e) {
      if (target) { await this.rendition.display(); throw new Error('stale-position'); }
      throw e;
    }
    this.ro?.disconnect();
    this.ro = new ResizeObserver(() => {
      if (this.destroyed || !this.rendition) return;
      const r = this.host.getBoundingClientRect();
      try { this.rendition.resize(Math.floor(r.width), Math.floor(r.height)); } catch { /* ignore mid-teardown resize */ }
      // The first layout can happen while the window is still being sized, so re-anchor once the size settles.
      clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => {
        if (!this.destroyed) this.rendition?.display(this.lastLoc?.cfi ?? target ?? undefined).catch(() => { /* keep current view */ });
      }, SETTLE_MS);
    });
    this.ro.observe(host);
    this.generateLocations();
  }

  /** Waits (briefly) for the host to have a non-zero size, as it has none while the window is still opening. */
  private async waitForLayout(host: HTMLElement) {
    for (let i = 0; i < LAYOUT_WAIT_TRIES && (host.clientWidth === 0 || host.clientHeight === 0); i++) {
      await new Promise((r) => setTimeout(r, LAYOUT_WAIT_MS));
    }
  }

  private generateLocations() {
    if (this.locationsReady) return;
    this.book.locations.generate(1600).then(() => { this.locationsReady = true; }).catch(() => { /* optional refinement */ });
  }

  styleCss(): string {
    const a = this.appearance;
    const family = a.fontStack ? `font-family:${a.fontStack}!important;` : '';
    const headingFamily = a.fontStack ? `:where(h1,h2,h3,h4,h5,h6){font-family:${a.fontStack};}` : '';
    const justify = a.textAlign === 'justify' ? '-webkit-hyphens:auto;hyphens:auto;' : '';
    const imgSafe = a.dark ? 'img,svg,video,canvas{opacity:1!important;filter:none!important;}' : '';
    return `
${a.fontCss}
:root{color-scheme:${a.dark ? 'dark' : 'light'};}
html{background:transparent!important;${isSpreadMode(this.mode) ? 'touch-action:pan-y pinch-zoom;' : ''}}
body{background:transparent!important;color:${a.fg}!important;${family}font-size:${a.fontSizePx}px!important;-webkit-text-size-adjust:none;}
body,body :where(p,li,div,blockquote,dd,dt,td,th,pre){line-height:${a.lineHeight}!important;}
body :where(p,li,dd,dt,blockquote){text-align:${a.textAlign}!important;${justify}}
body :where(p,li,div,span,h1,h2,h3,h4,h5,h6,blockquote,td,th,dt,dd,em,strong,i,b,cite,pre,code,figcaption,section,article){color:inherit;}
${a.dark ? 'body :where(p,li,div,span,h1,h2,h3,h4,h5,h6,blockquote,td,th,dt,dd,section,article){background-color:transparent!important;}' : ''}
a{color:${linkColor(a.dark)}!important;}
${headingFamily}
::selection{background:${a.dark ? 'rgba(138,180,255,.45)' : 'rgba(26,79,180,.25)'};}
${imgSafe}
img,svg{max-width:100%;}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;}}
`;
  }

  private applyStyle(contents: any) {
    const doc: Document | undefined = contents?.document;
    if (!doc?.head) return;
    let el = doc.getElementById('bowser-style') as HTMLStyleElement | null;
    if (!el) { el = doc.createElement('style'); el.id = 'bowser-style'; doc.head.appendChild(el); }
    el.textContent = this.styleCss();
    const frame = contents.window?.frameElement as HTMLElement | null;
    if (frame) frame.style.colorScheme = this.appearance.dark ? 'dark' : 'light';
  }

  async setAppearance(a: Appearance) {
    const prev = this.appearance;
    const relayout = !prev || prev.fontSizePx !== a.fontSizePx || prev.fontStack !== a.fontStack || prev.lineHeight !== a.lineHeight || prev.textAlign !== a.textAlign;
    this.appearance = a;
    const cfi = this.lastLoc?.cfi;
    for (const c of this.rendition?.getContents?.() ?? []) this.applyStyle(c);
    if (relayout && cfi) window.setTimeout(() => { if (!this.destroyed) this.rendition?.display(cfi).catch(() => {}); }, 120);
  }

  private onContents(contents: any) {
    this.applyStyle(contents);
    const doc: Document = contents.document;
    const win: Window = contents.window;
    const frame = win.frameElement as HTMLElement | null;
    const frameRect = () => (frame ? frame.getBoundingClientRect() : new DOMRect());
    const paginated = () => isSpreadMode(this.mode);

    doc.querySelectorAll('script,iframe,object,embed').forEach((n) => n.remove());

    const kd = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (isTypingTarget(e.target)) return;
      this.h.onKey(e);
    };
    doc.addEventListener('keydown', kd);

    const offGest = attachSwipe(doc, { isPaginated: paginated, onSwipe: (d) => this.h.onSwipe(d) });
    const wheel = wheelPager(paginated, (d) => this.h.onWheelPage(d));
    doc.addEventListener('wheel', wheel, { passive: false });
    const pd = () => this.h.onBookPointerDown();
    doc.addEventListener('pointerdown', pd, { passive: true, capture: true });
    doc.addEventListener('mousedown', pd, { passive: true, capture: true });
    const ctx = (ev: MouseEvent) => {
      ev.preventDefault();
      const sel = doc.getSelection();
      if (sel?.rangeCount && !sel.isCollapsed) this.onSelected(contents.cfiFromRange(sel.getRangeAt(0)), contents);
      const f = frameRect();
      this.h.onContextMenu(f.left + ev.clientX, f.top + ev.clientY);
    };
    doc.addEventListener('contextmenu', ctx, true);
    const sc = () => { if (doc.getSelection()?.isCollapsed) this.h.onSelectionCleared(); };
    doc.addEventListener('selectionchange', sc);

    const offHover = attachHover(doc, {
      enabled: () => this.h.hoverEnabled(),
      locale: () => this.h.locale(),
      onCancel: () => this.h.onHoverWord(null),
      onWord: (w) => {
        let cfi = '';
        try { cfi = contents.cfiFromRange(w.range); } catch { /* ignore */ }
        this.h.onHoverWord({ ...w, frameRect: frameRect(), cfi });
      }
    });
    this.cleanups.set(contents, () => { offGest(); offHover(); doc.removeEventListener('wheel', wheel); doc.removeEventListener('keydown', kd); doc.removeEventListener('pointerdown', pd, true); doc.removeEventListener('mousedown', pd, true); doc.removeEventListener('contextmenu', ctx, true); doc.removeEventListener('selectionchange', sc); });
  }

  private onRelocated(loc: any) {
    const start = loc?.start;
    if (!start) return;
    const pagesInSection: number = start.displayed?.total ?? 1;
    const page: number = start.displayed?.page ?? 1;
    const spineIndex: number = start.index ?? 0;
    let frac = pagesInSection > 0 ? (page - 1) / pagesInSection : 0;
    if ((isScrollMode(this.mode) || pagesInSection <= 1) && this.locationsReady && this.model) {
      try {
        const g = this.book.locations.percentageFromCfi(start.cfi) as number;
        const base = this.model.cumChars[spineIndex] / this.model.totalChars;
        const span = this.model.sections[spineIndex].chars / this.model.totalChars;
        if (span > 0) frac = Math.min(1, Math.max(0, (g - base) / span));
      } catch { /* keep page-based fraction */ }
    }
    const info: LocationInfo = {
      cfi: start.cfi, endCfi: loc.end?.cfi ?? start.cfi, spineIndex, spineHref: start.href ?? this.spineItems[spineIndex]?.href ?? '',
      page, pagesInSection, fracInSection: frac
    };
    this.lastLoc = info;
    this.h.onRelocated(info);
  }

  private onSelected(cfiRange: string, contents: any) {
    try {
      const range: Range = contents.range(cfiRange);
      const text = range.toString().replace(/\s+/g, ' ').trim();
      if (!text) return;
      const frame = (contents.window.frameElement as HTMLElement).getBoundingClientRect();
      this.h.onSelected({
        cfiRange, text,
        rect: offsetRect(range.getBoundingClientRect(), frame),
        spineHref: contents.sectionIndex !== undefined ? (this.spineItems[contents.sectionIndex]?.href ?? '') : (this.lastLoc?.spineHref ?? ''),
        ...quoteContext(range)
      });
    } catch { /* selection vanished */ }
  }

  next() { return this.rendition?.next(); }
  prev() { return this.rendition?.prev(); }
  focusContent() {
    try { this.rendition?.getContents()[0]?.window.focus(); } catch { /* no content yet */ }
  }

  /** Global fraction of a CFI once locations are generated, otherwise null. */
  percentOfCfi(cfi: string): number | null {
    if (!this.locationsReady) return null;
    try {
      const p = this.book.locations.percentageFromCfi(cfi) as number;
      return Number.isFinite(p) ? p : null;
    } catch { return null; }
  }

  async display(target?: string) { await this.rendition?.display(target); }

  async displayHref(href: string) {
    const idx = this.findSpineIndex(href);
    await this.rendition.display(idx >= 0 ? href : undefined);
  }

  async seekPercent(pct: number) {
    if (!this.model) return;
    const { spineIndex, frac } = locate(this.model, pct);
    const cfi = frac > 0.001 ? await this.cfiAtFraction(spineIndex, frac) : null;
    await this.rendition.display(cfi ?? this.spineItems[spineIndex]?.href);
  }

  /** CFI of the text at a fraction of a section's length, or null if it can't be resolved. */
  private async cfiAtFraction(spineIndex: number, frac: number): Promise<string | null> {
    try {
      const section = this.book.spine.get(spineIndex);
      await section.load(this.book.load.bind(this.book));
      const doc: Document = section.document;
      const { text, spans } = collectText(doc);
      if (!text.length) return null;
      const at = Math.min(text.length - 1, Math.floor(frac * text.length));
      const range = rangeFromOffsets(doc, spans, at, at + 1);
      return range ? section.cfiFromRange(range) : null;
    } catch { return null; }
  }

  /** The book's own descriptive fields as plain text, skipping empty ones. */
  metadata(): Record<string, string> {
    const md = this.book?.packaging?.metadata ?? {};
    const text = (v: unknown) => new DOMParser().parseFromString(String(v ?? ''), 'text/html').body.textContent?.trim() ?? '';
    const out: Record<string, string> = {};
    for (const k of ['creator', 'publisher', 'pubdate', 'language', 'identifier', 'rights', 'description']) {
      const v = text(md[k]);
      if (v) out[k] = v;
    }
    return out;
  }

  /** Column geometry of the live reader, or null before the first render. */
  pageGeometry(): PageGeometry | null {
    const l = this.rendition?.manager?.layout;
    if (!l || !this.appearance) return null;
    const divisor: number = l.divisor ?? 1;
    const gap: number = l.gap ?? 0;
    const width: number = l.width ?? this.host.clientWidth;
    const height: number = l.height ?? this.host.clientHeight;
    const columnWidth: number = l.columnWidth ?? (width - gap * (divisor - 1)) / divisor;
    if (!(width > 0 && height > 0 && columnWidth > 0)) return null;
    return {
      width, height, columnWidth, gap, divisor,
      scrolled: isScrollMode(this.mode),
      chapterSpread: this.mode === 'chapter-spread',
      styleKey: `${this.appearance.fontStack}|${this.appearance.fontSizePx}|${this.appearance.lineHeight}|${this.appearance.textAlign}|${this.appearance.fg}`,
      css: () => this.styleCss()
    };
  }

  /** Serialized HTML of a spine section with its resources resolved. */
  async renderSection(index: number): Promise<string> {
    const section = this.book.spine.get(index);
    return section.render(this.book.load.bind(this.book));
  }

  /** Spine index and text offset of a CFI, or null if it can't be resolved. */
  async textPositionOfCfi(cfi: string): Promise<{ spineIndex: number; offset: number } | null> {
    try {
      const spineIndex = spinePos(cfi);
      const range: Range | null = await this.book.getRange(cfi);
      if (!range || spineIndex < 0) return null;
      const { spans } = collectText(range.startContainer.ownerDocument as Document);
      const s = spans.find((x) => x.node === range.startContainer);
      if (!s) return { spineIndex, offset: 0 };
      let k = s.map.findIndex((raw) => raw >= range.startOffset);
      if (k < 0) k = s.map.length - 1;
      return { spineIndex, offset: s.start + Math.max(0, k) };
    } catch { return null; }
  }

  /** Shows the page `page` (1-based, within the section) of a section. */
  async displayPageInSection(spineIndex: number, page: number) {
    await this.rendition.display(this.spineItems[spineIndex]?.href);
    const spreads = Math.floor((page - 1) / (this.rendition.manager?.layout?.divisor ?? 1));
    for (let i = 0; i < spreads; i++) await this.rendition.next();
  }

  pageListLabel(cfi: string): string | null {
    if (!this.pageListLabels) return null;
    try {
      const p = this.book.pageList.pageFromCfi(cfi);
      return p === -1 || p === undefined ? null : String(p);
    } catch { return null; }
  }

  cfiFromPageLabel(label: string): string | null {
    if (!this.pageListLabels) return null;
    try {
      const n = parseInt(label, 10);
      if (Number.isNaN(n)) return null;
      const cfi = this.book.pageList.cfiFromPage(n);
      return cfi && cfi !== -1 ? cfi : null;
    } catch { return null; }
  }

  /**
   * Removes the part covered by `cfiRange` from every highlight in `others` that overlaps it.
   * Returns, for each affected highlight, the pieces that remain (none when it is fully covered).
   */
  async subtractHighlights(cfiRange: string, others: { id: string; cfiRange: string }[]): Promise<{ id: string; pieces: HighlightPiece[] }[]> {
    const out: { id: string; pieces: HighlightPiece[] }[] = [];
    try {
      const pos = spinePos(cfiRange);
      const section = this.book.spine.get(pos);
      const cut: Range | null = await this.book.getRange(cfiRange);
      if (!section || !cut) return out;
      const doc = cut.startContainer.ownerDocument as Document;
      for (const o of others) {
        try {
          if (spinePos(o.cfiRange) !== pos) continue;
          const from: Range | null = await this.book.getRange(o.cfiRange);
          const parts = from && subtractRange(doc, from, cut);
          if (!parts) continue;
          const pieces: HighlightPiece[] = [];
          for (const r of parts) {
            const text = r.toString().replace(/\s+/g, ' ').trim();
            if (!text) continue;
            pieces.push({ cfiRange: section.cfiFromRange(r), text, ...quoteContext(r) });
          }
          out.push({ id: o.id, pieces });
        } catch { /* leave this highlight untouched */ }
      }
    } catch { /* section unavailable */ }
    return out;
  }

  addHighlight(id: string, cfiRange: string, color: string) {
    this.highlights.set(id, { cfi: cfiRange, color });
    const fill = highlightFill(color);
    try {
      this.rendition.annotations.remove(cfiRange, 'highlight');
      this.rendition.annotations.highlight(cfiRange, { id }, undefined, 'bowser-hl', { fill, 'fill-opacity': '0.45', style: `mix-blend-mode:${this.appearance.dark ? 'screen' : 'multiply'}` });
    } catch { /* section not yet loaded: re-applied on render */ }
  }

  removeHighlight(id: string) {
    const h = this.highlights.get(id);
    if (!h) return;
    this.highlights.delete(id);
    try { this.rendition.annotations.remove(h.cfi, 'highlight'); } catch { /* already gone */ }
  }

  /** The highlight drawn under a window coordinate, with the rect it occupies there. */
  highlightAt(x: number, y: number): { id: string; rect: Rect } | null {
    for (const contents of this.rendition?.getContents?.() ?? []) {
      const frame = (contents.window.frameElement as HTMLElement).getBoundingClientRect();
      for (const [id, h] of this.highlights) {
        try {
          if (spinePos(h.cfi) !== contents.sectionIndex) continue;
          for (const r of (contents.range(h.cfi) as Range).getClientRects()) {
            const rect = offsetRect(r, frame);
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return { id, rect };
          }
        } catch { /* range not resolvable in this section */ }
      }
    }
    return null;
  }

  compareCfi(a: string, b: string): number {
    try { return cfiCompare(a, b); } catch { return 0; }
  }

  markTemporary(cfiRange: string) {
    try {
      if (this.markTimer) clearTimeout(this.markTimer);
      this.rendition.annotations.remove(cfiRange, 'highlight');
      this.rendition.annotations.highlight(cfiRange, {}, undefined, 'bowser-search-mark', { fill: '#ff922b', 'fill-opacity': '0.5' });
      this.markTimer = window.setTimeout(() => { try { this.rendition.annotations.remove(cfiRange, 'highlight'); } catch { /* ignore */ } }, 3500);
    } catch { /* ignore */ }
  }

  setTempHover(cfiRange: string | null) {
    try {
      if (this.hoverCfi) this.rendition.annotations.remove(this.hoverCfi, 'underline');
      this.hoverCfi = cfiRange;
      if (cfiRange) this.rendition.annotations.underline(cfiRange, {}, undefined, 'bowser-hover-word', { stroke: linkColor(this.appearance.dark), 'stroke-opacity': '0.8' });
    } catch { this.hoverCfi = null; }
  }

  async displaySearchHit(spineIndex: number, start: number, end: number, matched: string, caseSensitive: boolean): Promise<void> {
    const section = this.book.spine.get(spineIndex);
    if (!section) return;
    await section.load(this.book.load.bind(this.book));
    const doc: Document = section.document;
    const { text, spans } = collectText(doc);
    let s = start, e = end;
    if (text.slice(s, e) !== matched && text.slice(s, e).toLowerCase() !== matched.toLowerCase()) {
      const alt = locateNear(text, matched, start, caseSensitive);
      if (alt < 0) { await this.rendition.display(section.href); return; }
      s = alt; e = alt + matched.length;
    }
    const range = rangeFromOffsets(doc, spans, s, e);
    if (!range) { await this.rendition.display(section.href); return; }
    const cfi: string = section.cfiFromRange(range);
    await this.rendition.display(cfi);
    this.markTemporary(cfi);
  }

  private teardownRendition() {
    for (const off of this.cleanups.values()) { try { off(); } catch { /* ignore */ } }
    this.cleanups.clear();
    this.chapterSpread?.dispose();
    this.chapterSpread = null;
    this.ro?.disconnect();
    clearTimeout(this.settleTimer);
    if (this.rendition) { try { this.rendition.destroy(); } catch { /* ignore */ } this.rendition = null; }
  }

  isCfiOnPage(cfi: string): boolean {
    const l = this.lastLoc;
    if (!l) return false;
    try {
      return cfiCompare(cfi, l.cfi) >= 0 && cfiCompare(cfi, l.endCfi) <= 0;
    } catch { return cfi === l.cfi; }
  }

  destroy() {
    this.destroyed = true;
    this.teardownRendition();
    try { this.book?.destroy(); } catch { /* ignore */ }
  }
}
