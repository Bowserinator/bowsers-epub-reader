// Progress and chapter positions derived from text length per spine document.

export interface TocNode { id: string; href: string; label: string; depth: number; spineIndex: number; fragment: string | null; subitems: TocNode[] }
export interface Section { index: number; href: string; chars: number; words: number }
export interface ChapterStart { title: string; spineIndex: number; fragment: string | null; startPct: number }

export interface BookModel {
  sections: Section[];
  totalChars: number;
  totalWords: number;
  cumChars: number[]; // cumChars[i] = chars before section i
  chapters: ChapterStart[]; // sorted by position
}

export function flattenToc(nodes: TocNode[], out: TocNode[] = []): TocNode[] {
  for (const n of nodes) { out.push(n); flattenToc(n.subitems, out); }
  return out;
}

export function buildModel(sections: Section[], toc: TocNode[]): BookModel {
  const cum: number[] = [];
  let t = 0, w = 0;
  for (const s of sections) { cum.push(t); t += Math.max(1, s.chars); w += s.words; }
  const total = Math.max(1, t);
  const seen = new Set<string>();
  const chapters: ChapterStart[] = [];
  for (const n of flattenToc(toc)) {
    if (n.spineIndex < 0 || n.spineIndex >= sections.length) continue;
    const key = `${n.spineIndex}#${n.fragment ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chapters.push({ title: n.label, spineIndex: n.spineIndex, fragment: n.fragment, startPct: cum[n.spineIndex] / total });
  }
  chapters.sort((a, b) => a.startPct - b.startPct || a.spineIndex - b.spineIndex);
  return { sections, totalChars: total, totalWords: w, cumChars: cum, chapters };
}

/** Global fraction from a spine index and the fraction within that section. */
export function percentAt(m: BookModel, spineIndex: number, fracInSection: number): number {
  if (!m.sections.length) return 0;
  const i = Math.min(Math.max(spineIndex, 0), m.sections.length - 1);
  const f = Math.min(Math.max(Number.isFinite(fracInSection) ? fracInSection : 0, 0), 1);
  const p = (m.cumChars[i] + f * Math.max(1, m.sections[i].chars)) / m.totalChars;
  return Math.min(1, Math.max(0, p));
}

/** Inverse: which section and fraction a global percentage falls into. */
export function locate(m: BookModel, pct: number): { spineIndex: number; frac: number } {
  const target = Math.min(1, Math.max(0, pct)) * m.totalChars;
  for (let i = m.sections.length - 1; i >= 0; i--) {
    if (target >= m.cumChars[i]) {
      return { spineIndex: i, frac: Math.min(1, (target - m.cumChars[i]) / Math.max(1, m.sections[i].chars)) };
    }
  }
  return { spineIndex: 0, frac: 0 };
}

/** Index of the chapter containing a position. */
export function chapterIndexAt(m: BookModel, pct: number): number {
  let idx = -1;
  for (let i = 0; i < m.chapters.length; i++) {
    if (m.chapters[i].startPct <= pct + 1e-9) idx = i; else break;
  }
  return idx;
}

/** Remaining words in the current chapter, from the current position to the next chapter start. */
export function remainingWordsInChapter(m: BookModel, pct: number): number | null {
  if (!m.totalWords) return null;
  const ci = chapterIndexAt(m, pct);
  const endPct = ci >= 0 && ci + 1 < m.chapters.length ? m.chapters[ci + 1].startPct : 1;
  const startPct = Math.max(pct, ci >= 0 ? m.chapters[ci].startPct : 0);
  if (endPct <= startPct) return 0;
  const wordsPerChar = m.totalWords / m.totalChars;
  return Math.max(0, Math.round((endPct - startPct) * m.totalChars * wordsPerChar));
}

/** Remaining words in the whole book from the current position. */
export function remainingWordsInBook(m: BookModel, pct: number): number | null {
  if (!m.totalWords) return null;
  return Math.max(0, Math.round((1 - Math.min(1, Math.max(0, pct))) * m.totalWords));
}

export function formatRemaining(words: number | null, wpm: number): string {
  if (words === null || !Number.isFinite(wpm) || wpm <= 0 || words <= 0) return '—';
  const mins = Math.max(1, Math.round(words / wpm));
  if (mins < 60) return `~${mins} min left`;
  return `~${Math.floor(mins / 60)} h ${mins % 60} min left`;
}

