// Keeps chapter starts on a left page in chapter-spread mode.

import type { ChapterStart } from './locations';

export interface ChapterSpreadHandle {
  warning: string | null;
  dispose(): void;
}

export function midSpineAnchors(chapters: ChapterStart[], spineHrefAt: (i: number) => string | undefined): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const c of chapters) {
    if (!c.fragment) continue;
    const href = spineHrefAt(c.spineIndex);
    if (!href) continue;
    const list = m.get(href) ?? [];
    list.push(c.fragment);
    m.set(href, list);
  }
  return m;
}

/** Forces chapter anchors onto the start of a column, padding so they land on a left page. */
export function alignChapterStarts(doc: Document, ids: string[], pageW: number | undefined): { changed: boolean; unverified: number } {
  let changed = false, unverified = 0;
  for (const id of ids) {
    const el = doc.getElementById(id) as HTMLElement | null;
    if (!el) { unverified++; continue; }
    el.style.setProperty('break-before', 'column');
    el.style.setProperty('-webkit-column-break-before', 'always');
    changed = true;
    if (!pageW) { unverified++; continue; }
    const left = el.getBoundingClientRect().left + (doc.defaultView?.scrollX ?? 0);
    const column = Math.round(left / pageW);
    if (column % 2 === 1) {
      const spacer = doc.createElement('div');
      spacer.setAttribute('data-bowser-spacer', '1');
      spacer.setAttribute('aria-hidden', 'true');
      spacer.style.cssText = 'break-before:column;height:1px;margin:0;padding:0;border:0;';
      el.parentNode?.insertBefore(spacer, el);
    }
  }
  return { changed, unverified };
}

export function installChapterSpread(rendition: any, anchors: Map<string, string[]>): ChapterSpreadHandle {
  let unverified = 0;
  const handle: ChapterSpreadHandle = {
    warning: null,
    dispose() { rendition.off?.('rendered', onRendered); }
  };
  if (![...anchors.values()].some((ids) => ids.length)) return handle;

  const hrefMatches = (sectionHref: string, key: string) => sectionHref === key || sectionHref.endsWith('/' + key) || key.endsWith('/' + sectionHref);

  function onRendered(section: any, view: any) {
    try {
      const doc: Document | undefined = view?.contents?.document ?? view?.document;
      if (!doc) { unverified++; return; }
      const layout = rendition.manager?.layout ?? rendition.layout?.();
      const pageW: number | undefined = layout?.delta ?? (layout?.columnWidth && layout?.gap !== undefined ? layout.columnWidth + layout.gap : undefined);
      let ids: string[] | undefined;
      for (const [k, v] of anchors) if (hrefMatches(section.href, k)) { ids = v; break; }
      if (!ids) return;
      const result = alignChapterStarts(doc, ids, pageW);
      unverified += result.unverified;
      if (result.changed) view.expand?.();
    } catch {
      unverified++;
    }
    handle.warning = unverified
      ? 'Some chapters in this book start inside a file. Chapter-spread could not verify their page alignment, so they may start on a right-hand page.'
      : null;
  }
  rendition.on('rendered', onRendered);
  return handle;
}
