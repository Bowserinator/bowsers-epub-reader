import { ipc, type Bookmark, type DictInfo, type Highlight, type Hit, type LaunchBook, type LookupResult } from './ipc';
import { clamp, debounce, errorMessage, formatBytes, formatPage, isTypingTarget, offsetRect, pushCapped, uuid, type Rect } from './format';
import {
  DEFAULT_SETTINGS, FONT_SIZE_MAX, FONT_SIZE_MIN, PAGE_GAP, PAGE_OUTER, THEME_COLORS, isOverridable, isScrollMode, isSpreadMode, parseOverrides, parseSettings,
  REMAINING_MODES, resolveTheme, validateValue, type ReaderMode, type ReaderSettings
} from '../settings/defaults';
import { fontFaceCss, fontStack } from '../settings/fontRegistry';
import { MIN_SPREAD_WIDTH, ReaderEngine, type Appearance, type LocationInfo, type SelectionInfo } from '../reader/ReaderEngine';
import {
  buildModel, chapterIndexAt, flattenToc, formatRemaining, percentAt, remainingWordsInBook, remainingWordsInChapter,
  type BookModel, type TocNode
} from '../reader/locations';
import { buildPageMap, locatePage, measureBook, pageAtOffset, type PageGeometry, type PageMap } from '../reader/pageMap';

export type Drawer = null | 'toc' | 'bookmarks' | 'highlights' | 'search';
export type SettingsSection = 'appearance' | 'dictionaries' | 'about';

const HOVER_LINGER_MS = 500;
const LAYOUT_DEBOUNCE_MS = 150;
const SAVE_DEBOUNCE_MS = 300;
const MEASURE_DELAY_MS = 300;
const EDIT_HISTORY_MAX = 10;
const NAV_HISTORY_MAX = 10;
const UNDO_NOTICE_MS = 2000;

/** What it takes to reverse one bookmark or highlight edit. */
interface Revert {
  label: string;
  restoreBookmarks?: Bookmark[];
  dropBookmarks?: string[];
  restoreHighlights?: Highlight[];
  dropHighlights?: string[];
}

class App {
  phase = $state<'loading' | 'empty' | 'ready' | 'error'>('loading');
  openError = $state<string | null>(null);
  error = $state<string | null>(null);
  notice = $state<string | null>(null);
  noticeIsError = $state(false);
  info = $state<LaunchBook | null>(null);

  global = $state<ReaderSettings>({ ...DEFAULT_SETTINGS });
  overrideEnabled = $state(false);
  overrides = $state<Partial<ReaderSettings>>({});
  effective = $derived<ReaderSettings>({ ...this.global, ...(this.overrideEnabled ? this.overrides : {}) });
  osDark = $state(false);
  resolvedTheme = $derived(resolveTheme(this.effective.theme, this.osDark));
  systemFonts = $state<string[]>([]);
  viewportWidth = $state(1200);
  /** Mode actually rendered. */
  effectiveMode = $derived<ReaderMode>(this.info?.fixedLayout && this.effective.readerMode !== 'single-scroll' ? 'spread' : this.effective.readerMode);
  twoPageActive = $derived(isSpreadMode(this.effectiveMode) && this.viewportWidth - 2 * (PAGE_OUTER + this.effective.pageMarginPx) >= MIN_SPREAD_WIDTH);

  toc = $state.raw<TocNode[]>([]);
  flatToc = $derived(flattenToc(this.toc));
  model = $state.raw<BookModel | null>(null);
  indexing = $state(false);
  loc = $state.raw<LocationInfo | null>(null);
  percent = $state(0);
  chapterTitle = $state('');
  pageLabel = $state('');
  pageScheme = $state<'EPUB' | 'Layout' | ''>('');
  totalPagesLabel = $state('');
  chapterWordsLeft = $state<number | null>(null);
  bookWordsLeft = $state<number | null>(null);
  chapterPagesLeft = $state<number | null>(null);
  remaining = $derived.by(() => {
    const wpm = this.effective.readingSpeedWpm;
    switch (this.effective.remainingMode) {
      case 'book-time': return `Book: ${formatRemaining(this.bookWordsLeft, wpm)}`;
      case 'chapter-pages': {
        const n = this.chapterPagesLeft;
        return `Chapter: ${n === null ? '—' : `${n} ${n === 1 ? 'page' : 'pages'} left`}`;
      }
      default: return `Chapter: ${formatRemaining(this.chapterWordsLeft, wpm)}`;
    }
  });
  bookmarks = $state<Bookmark[]>([]);
  highlights = $state<Highlight[]>([]);
  highlightsInOrder = $derived([...this.highlights].sort((a, b) => this.engine?.compareCfi(a.cfiRange, b.cfiRange) ?? 0));
  isBookmarked = $state(false);
  compatWarning = $state<string | null>(null);
  bookTitle = $derived(this.info?.title || this.info?.fileName || '');

  drawer = $state<Drawer>(null);
  settingsOpen = $state(false);
  settingsSection = $state<SettingsSection>('appearance');
  settingsScroll: Partial<Record<SettingsSection, number>> = {};
  goToOpen = $state(false);
  bookInfoOpen = $state(false);
  pinnedPercent = $state<number | null>(null);
  private pinCfi: string | null = null;
  shortcutsOpen = $state(false);
  modeMenuOpen = $state(false);
  selection = $state.raw<(SelectionInfo & { existingId?: string }) | null>(null);
  contextMenu = $state.raw<{ x: number; y: number } | null>(null);
  hover = $state.raw<{ rect: Rect; result: LookupResult | null; loading: boolean; word: string; error?: string } | null>(null);

  search = $state({ query: '', regex: false, caseSensitive: false, hits: [] as Hit[], running: false, error: null as string | null, total: 0, truncated: false, done: false });
  private queryId = 0;

  dictionaries = $state<DictInfo[]>([]);

  engine: ReaderEngine | null = null;
  private host: HTMLElement | null = null;
  private navBack: string[] = [];
  private navForward: string[] = [];
  /** Exact page layout of the whole book for the current reader geometry; null while being measured. */
  pageMap = $state.raw<PageMap | null>(null);
  private pageMapKey = '';
  private pmToken = 0;
  private pmTimer: number | undefined;
  private cfiPages = $state.raw<Record<string, number>>({});
  private cfiPending = new Set<string>();
  private scrubTarget: number | null = null;
  private scrubRun: Promise<void> | null = null;
  private scrubFrom: string | null = null;
  private pendingGlobal: Record<string, unknown> = {};
  private pendingOverride: Record<string, unknown> = {};
  private fontCssCache = new Map<string, string>();
  private lastSpread = false;
  private lastSurface = DEFAULT_SETTINGS.pageSurface;
  private lastMargin = DEFAULT_SETTINGS.pageMarginPx;
  private edits: Revert[] = [];

  /** Labelled book details for the info dialog. */
  bookMetadata(): [string, string][] {
    const i = this.info, md = this.engine?.metadata() ?? {};
    const rows: [string, string | null | undefined][] = [
      ['Title', this.bookTitle], ['Author', i?.author || md.creator], ['Publisher', md.publisher], ['Published', md.pubdate],
      ['Language', i?.language || md.language], ['Identifier', md.identifier], ['Rights', md.rights],
      ['Words', this.model ? this.model.totalWords.toLocaleString() : null], ['File', i?.fileName], ['Size', i ? formatBytes(i.sizeBytes) : null],
      ['Description', md.description]
    ];
    return rows.filter((r): r is [string, string] => !!r[1]);
  }

  private fail = (what: string) => (e: unknown) => this.notify(`Could not ${what}: ${e}`);

  private noticeTimer: number | undefined;

  private notify(message: string, isError = true, dismissAfterMs?: number) {
    clearTimeout(this.noticeTimer);
    this.notice = message;
    this.noticeIsError = isError;
    if (dismissAfterMs !== undefined) this.noticeTimer = window.setTimeout(() => { if (this.notice === message) this.notice = null; }, dismissAfterMs);
  }

  async boot() {
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      this.osDark = mq.matches;
      mq.addEventListener('change', (e) => (this.osDark = e.matches));
      this.viewportWidth = window.innerWidth;
      window.addEventListener('resize', () => (this.viewportWidth = window.innerWidth));

      const launch = await ipc.getLaunchBook();
      this.global = parseSettings(await ipc.settingsGet().catch(() => ({})));
      ipc.listSystemFonts().then((f) => (this.systemFonts = f)).catch(() => {});
      this.refreshDictionaries();
      if (!launch) { this.phase = 'empty'; return; }
      await this.loadBook(launch);
    } catch (e) {
      this.error = errorMessage(e);
      this.phase = 'error';
    }
  }

  async chooseBook() {
    this.openError = null;
    try {
      const path = await ipc.pickBook();
      if (!path) return;
      this.phase = 'loading';
      const info = await ipc.openBook(path);
      await this.loadBook(info);
    } catch (e) {
      this.openError = errorMessage(e);
      this.phase = 'empty';
    }
  }

  private async loadBook(launch: LaunchBook) {
    try {
      this.info = launch;
      const rawOv = await ipc.overrideList(launch.bookId).catch(() => ({}));
      const o = parseOverrides(rawOv);
      this.overrideEnabled = o.enabled;
      this.overrides = o.values;
      ipc.onSearchBatch((b) => {
        if (b.queryId !== this.queryId) return;
        this.search.hits = [...this.search.hits, ...b.hits];
      });

      const [bookmarks, highlights] = await Promise.all([ipc.bookmarkList(this.info.bookId), ipc.highlightList(this.info.bookId)]);
      this.bookmarks = bookmarks;
      this.highlights = highlights;

      const bytes = await ipc.readBookBytes();
      this.engine = new ReaderEngine({
        onRelocated: (l) => this.onRelocated(l),
        onSelected: (s) => this.onSelected(s),
        onSelectionCleared: () => { if (this.selection && !this.selection.existingId) this.selection = null; },
        onContextMenu: (x, y) => this.openContextMenu(x, y),
        onKey: (e) => this.handleKey(e),
        onHoverWord: (w) => this.onHoverWord(w),
        onSwipe: (d) => this.turn(d === 'left' ? 'right' : 'left'),
        onWheelPage: (d) => (d > 0 ? this.next() : this.prev()),
        hoverEnabled: () => this.effective.hoverDefine && this.dictionaries.some((d) => d.enabled),
        locale: () => this.info?.language ?? 'en',
        onBookPointerDown: () => { this.dismissHover(); this.modeMenuOpen = false; this.closePanels(); this.closeContextMenu(); }
      });
      this.toc = await this.engine.open(bytes);
      this.phase = 'ready';
      this.startIndexing();
    } catch (e) {
      this.error = errorMessage(e);
      this.phase = 'error';
    }
  }

  async startReader(host: HTMLElement) {
    this.host = host;
    await this.restart(this.info?.state.lastCfi ?? null);
    window.addEventListener('beforeunload', () => this.flush());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flush(); });
  }

  async restart(target?: string | null) {
    if (!this.engine || !this.host) return;
    const t = target === undefined ? this.loc?.cfi ?? null : target;
    try {
      await this.engine.start(this.host, this.effectiveMode, await this.appearance(), t, this.epubGap());
    } catch (e) {
      if (e instanceof Error && e.message === 'stale-position') {
        const pct = this.info?.state.lastPercentage;
        this.notify('Your saved position no longer matches this book layout; showing the nearest chapter.');
        if (pct != null && this.model) await this.engine.seekPercent(pct);
      } else {
        this.error = errorMessage(e);
        this.phase = 'error';
        return;
      }
    }
    this.compatWarning = this.engine.chapterSpread?.warning ?? null;
    for (const h of this.highlights) this.engine.addHighlight(h.id, h.cfiRange, h.color);
    this.lastSpread = this.twoPageActive;
    this.lastSurface = this.effective.pageSurface;
    this.lastMargin = this.effective.pageMarginPx;
    if (!this.settingsOpen && !this.drawer) this.engine.focusContent();
  }

  /** Column gap that places the two text columns inside their page surfaces. */
  private epubGap() {
    return this.twoPageActive ? PAGE_GAP[this.effective.pageSurface] + 2 * this.effective.pageMarginPx : 0;
  }

  private async startIndexing() {
    if (!this.info) return;
    this.indexing = true;
    try {
      const idx = await ipc.searchBuildIndex(this.info.bookId);
      const m = buildModel(idx.sections.map((s) => ({ index: s.spineIndex, href: s.href, chars: s.chars, words: s.words })), this.toc);
      this.model = m;
      this.engine?.setModel(m);
      if (this.loc) this.updateProgress(this.loc);
      if (this.effectiveMode === 'chapter-spread') await this.restart();
    } catch (e) {
      this.notify(`Search index unavailable: ${errorMessage(e)}`);
    } finally {
      this.indexing = false;
    }
  }

  async appearance(): Promise<Appearance> {
    const c = THEME_COLORS[this.resolvedTheme];
    const fonts = new Set(this.systemFonts);
    const { stack, bundled } = fontStack(this.effective.fontFamilyId, fonts);
    let css = '';
    if (bundled) {
      css = this.fontCssCache.get(bundled.id) ?? (await fontFaceCss(bundled));
      this.fontCssCache.set(bundled.id, css);
    }
    return { bg: c.bg, fg: c.fg, dark: c.dark, fontStack: stack, fontSizePx: this.effective.fontSizePx, lineHeight: this.effective.lineHeight, textAlign: this.effective.textAlign, fontCss: css };
  }

  async applyAppearance() {
    if (!this.engine?.rendition) return;
    await this.engine.setAppearance(await this.appearance());
  }

  async applyMode(mode: ReaderMode, two: boolean, surface: string, margin: number) {
    if (!this.engine?.rendition) return;
    if (mode !== this.engine.mode) await this.restart();
    else if (!isScrollMode(mode) && (two !== this.lastSpread || surface !== this.lastSurface || margin !== this.lastMargin)) this.restartLayout();
  }

  private restartLayout = debounce(() => { void this.restart(); }, LAYOUT_DEBOUNCE_MS);

  private writeGlobal = debounce(() => {
    const p = this.pendingGlobal; this.pendingGlobal = {};
    if (Object.keys(p).length) ipc.settingsUpdate(p).catch(this.fail('save settings'));
  }, SAVE_DEBOUNCE_MS);
  private writeOverride = debounce(() => {
    const p = this.pendingOverride; this.pendingOverride = {};
    const id = this.info?.bookId;
    if (!id) return;
    for (const [k, v] of Object.entries(p)) ipc.overrideSet(id, k, v).catch(this.fail('save settings'));
  }, SAVE_DEBOUNCE_MS);

  flush() {
    this.writeGlobal.flush(); this.writeOverride.flush(); this.savePosition.flush();
  }

  set<K extends keyof ReaderSettings>(key: K, raw: ReaderSettings[K]) {
    const value = validateValue(key, raw);
    if (this.overrideEnabled && isOverridable(key)) {
      (this.overrides as Record<string, unknown>)[key] = value;
      this.pendingOverride[key] = value;
      this.writeOverride();
    } else {
      (this.global as Record<string, unknown>)[key] = value;
      this.pendingGlobal[key] = value;
      this.writeGlobal();
    }
  }

  cycleRemainingMode() {
    const i = REMAINING_MODES.indexOf(this.effective.remainingMode);
    this.set('remainingMode', REMAINING_MODES[(i + 1) % REMAINING_MODES.length]);
  }

  setOverrideEnabled(on: boolean) {
    const id = this.info?.bookId;
    if (!id) return;
    this.overrideEnabled = on;
    ipc.overrideSet(id, '_enabled', on).catch(() => {});
  }

  resetOverride() {
    const id = this.info?.bookId;
    if (!id) return;
    this.overrides = {};
    this.overrideEnabled = false;
    this.pendingOverride = {};
    ipc.overrideDelete(id).catch(this.fail('reset'));
  }

  fontSize(delta: number) { this.set('fontSizePx', clamp(this.effective.fontSizePx + delta, FONT_SIZE_MIN, FONT_SIZE_MAX)); }
  resetFontSize() { this.set('fontSizePx', DEFAULT_SETTINGS.fontSizePx); }

  private savePosition = debounce(() => {
    const l = this.loc;
    if (!l || !this.info) return;
    ipc.saveReadingPosition(this.info.bookId, l.cfi, this.percent, l.spineHref || null).catch(() => {});
  }, 500);

  private onRelocated(l: LocationInfo) {
    this.loc = l;
    if (this.pinCfi !== null && l.cfi !== this.pinCfi) this.pinnedPercent = null;
    this.updateProgress(l);
    this.savePosition();
    this.refreshBookmarked();
  }

  private refreshBookmarked() {
    this.isBookmarked = this.bookmarks.some((b) => this.engine?.isCfiOnPage(b.cfi));
  }

  private updateProgress(l: LocationInfo) {
    const m = this.model;
    this.percent = m ? percentAt(m, l.spineIndex, l.fracInSection) : 0;
    if (m) {
      const ci = chapterIndexAt(m, this.percent);
      this.chapterTitle = ci >= 0 ? m.chapters[ci].title : '';
      this.chapterWordsLeft = remainingWordsInChapter(m, this.percent);
      this.bookWordsLeft = remainingWordsInBook(m, this.percent);
    } else {
      this.chapterTitle = '';
      this.chapterWordsLeft = null;
      this.bookWordsLeft = null;
    }
    this.syncPageMap(l);
    this.updatePageLabels(l);
  }

  private updatePagesLeft(l: LocationInfo) {
    const pm = this.pageMap, m = this.model, sec = pm?.sections[l.spineIndex];
    if (!pm || !m || !sec) { this.chapterPagesLeft = null; return; }
    const inSection = this.isScrolling ? Math.floor(l.fracInSection * sec.pages) + 1 : l.page;
    const current = pm.starts[l.spineIndex] + Math.min(Math.max(1, inSection), sec.pages);
    const next = m.chapters[chapterIndexAt(m, this.percent) + 1];
    let end = pm.total + 1;
    if (next) {
      const ns = pm.sections[next.spineIndex];
      end = pm.starts[next.spineIndex] + (next.fragment ? ns?.anchors[next.fragment] ?? 1 : 1);
    }
    this.chapterPagesLeft = Math.max(0, end - current - 1);
  }

  private updatePageLabels(l: LocationInfo) {
    this.updatePagesLeft(l);
    const label = this.engine?.pageListLabel(l.cfi) ?? null;
    const pm = this.pageMap, sec = pm?.sections[l.spineIndex];
    if (label !== null) {
      this.pageLabel = label; this.pageScheme = 'EPUB';
      this.totalPagesLabel = String(this.engine?.book?.pageList?.lastPage ?? '');
    } else if (pm && sec) {
      const inSection = this.isScrolling ? Math.floor(l.fracInSection * sec.pages) + 1 : l.page;
      this.pageLabel = String(pm.starts[l.spineIndex] + Math.min(Math.max(1, inSection), sec.pages));
      this.totalPagesLabel = String(pm.total);
      this.pageScheme = 'Layout';
    } else {
      this.pageLabel = ''; this.totalPagesLabel = ''; this.pageScheme = '';
    }
  }

  private get isScrolling() { return isScrollMode(this.effectiveMode); }

  /** Re-measures the book when the page geometry changes, and trusts the live count for the visible section. */
  private syncPageMap(l: LocationInfo) {
    const g = this.engine?.pageGeometry();
    if (!g) return;
    const key = [g.width, g.height, g.columnWidth, g.gap, g.divisor, g.scrolled, g.chapterSpread, g.styleKey, !!this.model].join('|');
    if (key !== this.pageMapKey) {
      this.pageMapKey = key;
      this.pageMap = null;
      this.cfiPages = {};
      this.cfiPending.clear();
      this.scheduleMeasure(key, g);
      return;
    }
    const pm = this.pageMap;
    if (pm && !g.scrolled && l.pagesInSection > 0 && pm.sections[l.spineIndex] && pm.sections[l.spineIndex].pages !== l.pagesInSection) {
      const sections = pm.sections.map((s, i) => (i === l.spineIndex ? { ...s, pages: l.pagesInSection } : s));
      this.pageMap = buildPageMap(pm.key, sections);
    }
  }

  private scheduleMeasure(key: string, g: PageGeometry) {
    clearTimeout(this.pmTimer);
    const token = ++this.pmToken;
    this.pmTimer = window.setTimeout(async () => {
      const eng = this.engine;
      if (!eng) return;
      const toc = new Map<number, string[]>(), chapters = new Map<number, string[]>();
      const add = (m: Map<number, string[]>, i: number, id: string) => m.set(i, [...(m.get(i) ?? []), id]);
      for (const n of this.flatToc) if (n.spineIndex >= 0 && n.fragment) add(toc, n.spineIndex, n.fragment);
      for (const c of this.model?.chapters ?? []) if (c.fragment) add(chapters, c.spineIndex, c.fragment);
      const sections = await measureBook(
        eng.spineItems.length, (i) => eng.renderSection(i), g,
        (i) => toc.get(i) ?? [], (i) => chapters.get(i) ?? [],
        () => token !== this.pmToken || this.engine !== eng
      );
      if (!sections || token !== this.pmToken) return;
      this.pageMap = buildPageMap(key, sections);
      if (this.loc) { this.syncPageMap(this.loc); this.updatePageLabels(this.loc); }
    }, MEASURE_DELAY_MS);
  }

  async jump(fn: () => Promise<unknown> | unknown, origin?: string) {
    const from = origin ?? this.loc?.cfi;
    try { await fn(); } catch (e) { this.notify(errorMessage(e)); }
    if (!from) return;
    this.navForward = [];
    if (this.navBack[this.navBack.length - 1] !== from) pushCapped(this.navBack, from, NAV_HISTORY_MAX);
  }

  async historyBack() {
    const cur = this.loc?.cfi;
    if (!cur) return;
    while (this.navBack[this.navBack.length - 1] === cur) this.navBack.pop();
    const target = this.navBack.pop();
    if (!target) return;
    pushCapped(this.navForward, cur, NAV_HISTORY_MAX);
    await this.engine?.display(target);
  }

  async historyForward() {
    const cur = this.loc?.cfi;
    if (!cur) return;
    while (this.navForward[this.navForward.length - 1] === cur) this.navForward.pop();
    const target = this.navForward.pop();
    if (!target) return;
    pushCapped(this.navBack, cur, NAV_HISTORY_MAX);
    await this.engine?.display(target);
  }

  /** Starts a slider drag; the position before the drag is what history returns to. */
  beginScrub() { this.scrubFrom = this.loc?.cfi ?? null; }

  /** Shows the page at `p` while the slider is dragged, skipping intermediate positions that can't keep up. */
  scrub(p: number) {
    this.scrubTarget = p;
    if (this.scrubRun) return;
    this.scrubRun = (async () => {
      while (this.scrubTarget !== null) {
        const t = this.scrubTarget;
        this.scrubTarget = null;
        try { await this.engine?.seekPercent(t); } catch { /* next drag step retries */ }
      }
      this.scrubRun = null;
    })();
  }

  async endScrub(p: number) {
    this.scrubTarget = null;
    await this.scrubRun;
    const from = this.scrubFrom ?? undefined;
    this.scrubFrom = null;
    await this.seek(p, from);
  }

  /** Jumps to a percentage and keeps the slider there until the reader moves on from the landing page. */
  private async seek(p: number, origin?: string) {
    this.pinnedPercent = p;
    this.pinCfi = null;
    await this.jump(() => this.engine?.seekPercent(p), origin);
    this.pinCfi = this.loc?.cfi ?? null;
  }

  goToHref(href: string) { return this.jump(() => this.engine?.displayHref(href)); }
  goToCfi(cfi: string) { return this.jump(() => this.engine?.display(cfi)); }
  goToPercent(p: number) { return this.seek(p); }
  goToHit(h: Hit) { return this.jump(() => this.engine?.displaySearchHit(h.spineIndex, h.start, h.end, h.matched, this.search.caseSensitive)); }

  async goToPage(label: string): Promise<string | null> {
    const t = label.trim();
    if (!t) return 'Enter a page.';
    const cfi = this.engine?.cfiFromPageLabel(t);
    if (cfi) { await this.goToCfi(cfi); return null; }
    if (this.engine?.pageListLabels) return `No page “${t}” in this book’s page list.`;
    const n = parseInt(t, 10);
    if (Number.isNaN(n) || n < 1) return 'Enter a page number.';
    const pm = this.pageMap;
    if (!pm) return 'Page numbers are still being calculated; try again in a moment.';
    if (n > pm.total) return `This book has ${pm.total} pages.`;
    const at = locatePage(pm, n);
    if (!at) return 'Enter a page number.';
    if (this.isScrolling && this.model) {
      await this.goToPercent(percentAt(this.model, at.spineIndex, (at.inSection - 1) / pm.sections[at.spineIndex].pages));
    } else {
      await this.jump(() => this.engine?.displayPageInSection(at.spineIndex, at.inSection));
    }
    return null;
  }

  turn(side: 'left' | 'right') {
    const rtl = this.engine?.isRtl;
    const forward = side === 'right' ? !rtl : !!rtl;
    if (forward) this.next(); else this.prev();
  }

  next() { this.hover = null; this.engine?.next(); }
  prev() { this.hover = null; this.engine?.prev(); }
  home() { return this.jump(() => this.engine?.seekPercent(0)); }
  end() { return this.jump(() => this.engine?.seekPercent(0.9999)); }

  async toggleBookmark() {
    const l = this.loc, id = this.info?.bookId;
    if (!l || !id) return;
    const existing = this.bookmarks.filter((b) => this.engine?.isCfiOnPage(b.cfi));
    if (existing.length) {
      await this.removeBookmarks(existing.map((b) => b.id));
      return;
    }
    const b: Bookmark = {
      id: uuid(), cfi: l.cfi, createdAt: new Date().toISOString(), chapterHref: l.spineHref || null,
      label: this.chapterTitle || this.bookTitle
    };
    this.bookmarks = [...this.bookmarks, b];
    this.isBookmarked = true;
    try {
      await ipc.bookmarkUpsert(id, b);
      this.recordEdit({ label: 'bookmark', dropBookmarks: [b.id] });
    } catch (e) { this.fail('save bookmark')(e); this.bookmarks = this.bookmarks.filter((x) => x.id !== b.id); this.isBookmarked = false; }
  }

  removeBookmark(bid: string) { return this.removeBookmarks([bid]); }

  private async removeBookmarks(ids: string[]) {
    const id = this.info?.bookId;
    const removed = this.bookmarks.filter((b) => ids.includes(b.id));
    if (!id || !removed.length) return;
    this.recordEdit({ label: 'bookmark removal', restoreBookmarks: removed });
    this.bookmarks = this.bookmarks.filter((b) => !ids.includes(b.id));
    this.refreshBookmarked();
    await Promise.all(removed.map((b) => ipc.bookmarkDelete(id, b.id))).catch(this.fail('remove bookmark'));
  }

  private recordEdit(r: Revert) { pushCapped(this.edits, r, EDIT_HISTORY_MAX); }

  /** Records the highlight changes made since `before` as one undoable edit. */
  private recordHighlightEdit(label: string, before: Highlight[]) {
    const now = new Map(this.highlights.map((h) => [h.id, h]));
    const restoreHighlights = before.filter((h) => now.get(h.id) !== h);
    const dropHighlights = this.highlights.filter((h) => !before.some((b) => b.id === h.id)).map((h) => h.id);
    if (restoreHighlights.length || dropHighlights.length) this.recordEdit({ label, restoreHighlights, dropHighlights });
  }

  /** Reverses the most recent bookmark or highlight edit. */
  async undo() {
    const bookId = this.info?.bookId, r = this.edits.pop();
    if (!bookId || !r) return;
    const dropB = r.dropBookmarks ?? [], restoreB = r.restoreBookmarks ?? [];
    const dropH = r.dropHighlights ?? [], restoreH = r.restoreHighlights ?? [];

    const touchedB = new Set([...dropB, ...restoreB.map((b) => b.id)]);
    this.bookmarks = [...this.bookmarks.filter((b) => !touchedB.has(b.id)), ...restoreB].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.refreshBookmarked();

    const touchedH = new Set([...dropH, ...restoreH.map((h) => h.id)]);
    for (const id of touchedH) this.engine?.removeHighlight(id);
    this.highlights = [...this.highlights.filter((h) => !touchedH.has(h.id)), ...restoreH];
    for (const h of restoreH) this.engine?.addHighlight(h.id, h.cfiRange, h.color);

    this.notify(`Undid ${r.label}`, false, UNDO_NOTICE_MS);
    await Promise.all([
      ...dropB.map((id) => ipc.bookmarkDelete(bookId, id)),
      ...restoreB.map((b) => ipc.bookmarkUpsert(bookId, b)),
      ...dropH.map((id) => ipc.highlightDelete(bookId, id)),
      ...restoreH.map((h) => ipc.highlightUpsert(bookId, h))
    ]).catch(this.fail('undo'));
  }

  private cfiPlace(cfi: string, chapterHref: string | null): { chapter: string; page: string } {
    const m = this.model;
    let pct = this.engine?.percentOfCfi(cfi) ?? null;
    if (pct === null && m && chapterHref) {
      const i = this.engine?.findSpineIndex(chapterHref) ?? -1;
      if (i >= 0) pct = percentAt(m, i, 0);
    }
    const ci = m && pct !== null ? chapterIndexAt(m, pct) : -1;
    const epubPage = this.engine?.pageListLabel(cfi) ?? null;
    if (epubPage === null && this.pageMap && !(cfi in this.cfiPages)) this.resolveCfiPage(cfi);
    const page = epubPage ?? this.cfiPages[cfi] ?? '';
    return { chapter: ci >= 0 && m ? m.chapters[ci].title : '', page: page === '' ? '' : formatPage(page) };
  }

  bookmarkView(b: Bookmark): { title: string; page: string } {
    const p = this.cfiPlace(b.cfi, b.chapterHref);
    return { title: p.chapter || b.label || 'Bookmark', page: p.page };
  }

  highlightView(h: Highlight): { chapter: string; page: string } { return this.cfiPlace(h.cfiRange, h.spineHref); }

  async removeHighlight(id: string) {
    const bookId = this.info?.bookId;
    if (!bookId) return;
    const before = this.highlights;
    this.engine?.removeHighlight(id);
    this.highlights = this.highlights.filter((h) => h.id !== id);
    this.recordHighlightEdit('highlight removal', before);
    await ipc.highlightDelete(bookId, id).catch(this.fail('remove highlight'));
  }

  /** Dictionary result for the first word of the current selection, set only when a definition exists. */
  selectionDef = $state.raw<{ word: string; result: LookupResult } | null>(null);
  private defSeq = 0;

  private onSelected(s: SelectionInfo) {
    if (this.selection?.cfiRange === s.cfiRange && !this.selection.existingId) return;
    this.hover = null;
    this.selection = s;
    this.probeDefinition(s);
  }

  private async probeDefinition(s: { text: string; cfiRange: string }) {
    const seq = ++this.defSeq;
    this.selectionDef = null;
    if (!this.dictionaries.some((d) => d.enabled)) return;
    const word = (s.text.split(/\s+/)[0] ?? '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!word) return;
    try {
      const manual = this.effective.dictionaryMode === 'manual' ? this.effective.activeDictionaryIds : null;
      const result = await ipc.dictionaryLookup({ term: word, context: s.text, bookLang: this.info?.language ?? null, dictIds: manual });
      if (seq === this.defSeq && result.found && this.selection?.cfiRange === s.cfiRange) this.selectionDef = { word, result };
    } catch { /* no definition available */ }
  }

  /** Opens the text menu for the current selection, or for the highlight under the point when nothing is selected. */
  openContextMenu(x: number, y: number) {
    if (!this.selection) {
      const hit = this.engine?.highlightAt(x, y);
      const h = hit && this.highlights.find((v) => v.id === hit.id);
      if (!hit || !h) return;
      this.selection = { cfiRange: h.cfiRange, text: h.selectedText, rect: hit.rect, spineHref: h.spineHref ?? '', prefix: h.quotePrefix ?? '', suffix: h.quoteSuffix ?? '', existingId: h.id };
      this.probeDefinition(this.selection);
    }
    this.contextMenu = { x, y };
  }

  closeContextMenu() {
    this.contextMenu = null;
    if (this.selection?.existingId) this.selection = null;
  }

  private consumeSelection() {
    this.selection = null;
    this.contextMenu = null;
  }

  /** Cuts the range out of every other highlight it overlaps, deleting those it covers completely. */
  private async carve(cfiRange: string, keepId?: string) {
    const bookId = this.info?.bookId;
    if (!bookId || !this.engine) return;
    const others = this.highlights.filter((h) => h.id !== keepId);
    const affected = await this.engine.subtractHighlights(cfiRange, others);
    if (!affected.length) return;
    const now = new Date().toISOString();
    const removed = new Set<string>();
    const changed: Highlight[] = [];
    const added: Highlight[] = [];
    for (const { id, pieces } of affected) {
      const h = others.find((x) => x.id === id);
      if (!h) continue;
      this.engine.removeHighlight(id);
      if (!pieces.length) { removed.add(id); continue; }
      const mk = (p: (typeof pieces)[number], pid: string): Highlight => ({ ...h, id: pid, cfiRange: p.cfiRange, selectedText: p.text.slice(0, 5000), quotePrefix: p.prefix, quoteSuffix: p.suffix, updatedAt: now });
      changed.push(mk(pieces[0], id));
      for (const p of pieces.slice(1)) added.push(mk(p, uuid()));
    }
    const byId = new Map(changed.map((h) => [h.id, h]));
    this.highlights = [...this.highlights.filter((h) => !removed.has(h.id)).map((h) => byId.get(h.id) ?? h), ...added];
    for (const h of [...changed, ...added]) this.engine.addHighlight(h.id, h.cfiRange, h.color);
    await Promise.all([
      ...[...removed].map((id) => ipc.highlightDelete(bookId, id)),
      ...[...changed, ...added].map((h) => ipc.highlightUpsert(bookId, h))
    ]).catch(this.fail('update highlights'));
  }

  async applyHighlight(color: string) {
    const s = this.selection, id = this.info?.bookId;
    if (!s || !id) return;
    this.consumeSelection();
    this.clearDomSelection();
    const before = this.highlights;
    const reuse = s.existingId ? this.highlights.find((h) => h.id === s.existingId) : this.highlights.find((h) => h.cfiRange === s.cfiRange);
    await this.carve(s.cfiRange, reuse?.id);
    const now = new Date().toISOString();
    const h: Highlight = reuse
      ? { ...reuse, color, updatedAt: now }
      : { id: uuid(), cfiRange: s.cfiRange, color, selectedText: s.text.slice(0, 5000), quotePrefix: s.prefix, quoteSuffix: s.suffix, spineHref: s.spineHref || null, createdAt: now, updatedAt: now };
    this.highlights = reuse ? this.highlights.map((x) => (x.id === h.id ? h : x)) : [...this.highlights, h];
    this.engine?.addHighlight(h.id, h.cfiRange, h.color);
    this.recordHighlightEdit('highlight', before);
    await ipc.highlightUpsert(id, h).catch(this.fail('save highlight'));
  }

  async clearHighlight() {
    const s = this.selection;
    if (!s) return;
    this.consumeSelection();
    this.clearDomSelection();
    const before = this.highlights;
    await this.carve(s.cfiRange);
    this.recordHighlightEdit('highlight removal', before);
  }

  private clearDomSelection() {
    for (const c of this.engine?.rendition?.getContents?.() ?? []) c.window?.getSelection?.()?.removeAllRanges();
  }

  copySelection() {
    const t = this.selection?.text;
    this.consumeSelection();
    if (t) navigator.clipboard.writeText(t).catch(this.fail('copy text'));
  }

  searchSelection() {
    const t = this.selection?.text;
    if (!t) return;
    this.consumeSelection();
    this.drawer = 'search';
    this.search.query = t.slice(0, 200);
    this.search.regex = false;
    this.runSearch();
  }

  async defineSelection() {
    const s = this.selection, d = this.selectionDef;
    if (!s || !d) return;
    this.consumeSelection();
    this.selectionDef = null;
    this.hoverSeq++;
    this.hover = { rect: s.rect, result: d.result, loading: false, word: d.word };
  }

  private hoverSeq = 0;
  private hoverLinger: number | undefined;
  private hoverHeld = false;
  private onHoverWord(w: { word: string; context: string; rect: DOMRect; frameRect: DOMRect; cfi: string } | null) {
    clearTimeout(this.hoverLinger);
    if (!this.hover) this.hoverHeld = false;
    if (this.hoverHeld) return;
    if (!w) {
      if (this.hover) this.hoverLinger = window.setTimeout(() => this.dismissHover(), HOVER_LINGER_MS);
      return;
    }
    this.engine?.setTempHover(w.cfi || null);
    this.lookup(w.word, w.context, offsetRect(w.rect, w.frameRect), w.cfi);
  }

  async lookup(word: string, context: string, rect: Rect, hoverCfi?: string) {
    const seq = ++this.hoverSeq;
    this.hover = { rect, result: null, loading: true, word };
    try {
      const manual = this.effective.dictionaryMode === 'manual' ? this.effective.activeDictionaryIds : null;
      const result = await ipc.dictionaryLookup({ term: word, context, bookLang: this.info?.language ?? null, dictIds: manual });
      if (seq !== this.hoverSeq) return;
      this.hover = { rect, result, loading: false, word };
      if (!result.found && hoverCfi) this.engine?.setTempHover(null);
    } catch (e) {
      console.error('dictionary lookup failed', e);
      if (seq === this.hoverSeq) this.hover = { rect, result: { found: false, matchedChars: 0, entries: [] }, loading: false, word, error: String(e) };
    }
  }

  dismissHover() { clearTimeout(this.hoverLinger); this.hoverSeq++; this.hover = null; this.engine?.setTempHover(null); }

  /** Keeps the definition popup open while the pointer is over it. */
  holdHover() { clearTimeout(this.hoverLinger); this.hoverHeld = true; }

  /** Closes the definition popup shortly after the pointer leaves it. */
  releaseHover() {
    this.hoverHeld = false;
    clearTimeout(this.hoverLinger);
    this.hoverLinger = window.setTimeout(() => this.dismissHover(), HOVER_LINGER_MS);
  }

  async refreshDictionaries() {
    try { this.dictionaries = await ipc.dictionaryList(); } catch { this.dictionaries = []; }
  }

  private runSearchDebounced = debounce(() => this.runSearch(), 250);
  onSearchInput() { this.runSearchDebounced(); }

  async runSearch() {
    const s = this.search;
    const q = s.query;
    ipc.searchCancel().catch(() => {});
    this.queryId += 1;
    const id = this.queryId;
    s.hits = []; s.error = null; s.total = 0; s.truncated = false; s.done = false;
    if (!q.trim()) { s.running = false; return; }
    s.running = true;
    try {
      const r = await ipc.searchQuery({ queryId: id, pattern: q, regex: s.regex, caseSensitive: s.caseSensitive });
      if (id !== this.queryId) return;
      s.error = r.error; s.total = r.total; s.truncated = r.truncated; s.done = !r.cancelled;
    } catch (e) {
      if (id === this.queryId) s.error = String(e);
    } finally {
      if (id === this.queryId) s.running = false;
    }
  }

  tocPage(n: TocNode): string {
    const pm = this.pageMap, sec = pm?.sections[n.spineIndex];
    if (!pm || !sec) return '';
    const inSection = n.fragment ? sec.anchors[n.fragment] ?? 1 : 1;
    return formatPage(pm.starts[n.spineIndex] + inSection);
  }

  private resolveCfiPage(cfi: string) {
    const pm = this.pageMap, eng = this.engine;
    if (!pm || !eng || this.cfiPending.has(cfi)) return;
    this.cfiPending.add(cfi);
    eng.textPositionOfCfi(cfi).then((pos) => {
      if (!pos || this.pageMap !== pm) return;
      this.cfiPages = { ...this.cfiPages, [cfi]: pageAtOffset(pm, pos.spineIndex, pos.offset) };
    });
  }

  searchLabel(h: Hit): { chapter: string; page: string } {
    const m = this.model;
    if (!m) return { chapter: '', page: '' };
    const chars = Math.max(1, m.sections[h.spineIndex]?.chars ?? 1);
    const pct = percentAt(m, h.spineIndex, h.start / chars);
    const ci = chapterIndexAt(m, pct);
    const pm = this.pageMap;
    return { chapter: ci >= 0 ? m.chapters[ci].title : '', page: pm ? formatPage(pageAtOffset(pm, h.spineIndex, h.start)) : '' };
  }

  closePanels() { this.drawer = null; this.settingsOpen = false; }

  toggleDrawer(d: Exclude<Drawer, null>) {
    this.drawer = this.drawer === d ? null : d;
    if (!this.drawer) return;
    this.settingsOpen = false;
    if (d === 'search') this.focusSearch();
  }

  toggleSettings() {
    this.settingsOpen = !this.settingsOpen;
    if (this.settingsOpen) this.drawer = null;
  }

  private focusSearch() { queueMicrotask(() => document.getElementById('search-input')?.focus()); }

  handleKey(e: KeyboardEvent) {
    if (e.isComposing) return;
    const typing = isTypingTarget(e.target);
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    const done = () => { e.preventDefault(); e.stopPropagation(); };

    if (k === 'Escape') {
      if (this.contextMenu) { this.closeContextMenu(); done(); return; }
      if (this.hover) { this.dismissHover(); done(); return; }
      if (this.modeMenuOpen) { this.modeMenuOpen = false; done(); return; }
      if (this.goToOpen) { this.goToOpen = false; done(); return; }
      if (this.bookInfoOpen) { this.bookInfoOpen = false; done(); return; }
      if (this.shortcutsOpen) { this.shortcutsOpen = false; done(); return; }
      if (this.settingsOpen) { this.settingsOpen = false; done(); return; }
      if (this.drawer) { this.drawer = null; done(); return; }
      return;
    }
    if (ctrl && !e.altKey) {
      switch (k.toLowerCase()) {
        case 'f': this.drawer = 'search'; this.settingsOpen = false; this.focusSearch(); return done();
        case ',': this.toggleSettings(); return done();
        case 'b': this.toggleBookmark(); return done();
        case 'z': if (typing || e.shiftKey || !this.edits.length) return; this.undo(); return done();
        case 'g': this.goToOpen = true; return done();
        case 'h': this.set('autoHideControls', !this.effective.autoHideControls); return done();
        case '=': case '+': this.fontSize(1); return done();
        case '-': case '_': this.fontSize(-1); return done();
        case '0': this.resetFontSize(); return done();
      }
      return;
    }
    if (typing) return;
    if (this.settingsOpen || this.goToOpen || this.bookInfoOpen || this.shortcutsOpen) return;
    if (e.altKey) {
      if (k === 'ArrowLeft') { this.historyBack(); return done(); }
      if (k === 'ArrowRight') { this.historyForward(); return done(); }
      return;
    }
    switch (k) {
      case 'ArrowLeft': this.turn('left'); return done();
      case 'ArrowRight': this.turn('right'); return done();
      case 'PageDown': this.next(); return done();
      case 'PageUp': this.prev(); return done();
      case ' ': if (e.shiftKey) this.prev(); else this.next(); return done();
      case 'Home': this.home(); return done();
      case 'End': this.end(); return done();
      case '?': this.shortcutsOpen = true; return done();
    }
  }
}

export const app = new App();
