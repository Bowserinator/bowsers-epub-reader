import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

export interface LaunchBook {
  bookId: string; fileName: string; sizeBytes: number; title?: string | null; author?: string | null;
  language?: string | null; fixedLayout: boolean; direction?: 'rtl' | 'ltr' | null;
  state: { lastCfi: string | null; lastPercentage: number | null; lastSpineHref: string | null };
}
export interface Bookmark { id: string; cfi: string; label: string | null; chapterHref: string | null; createdAt: string }
export interface Highlight {
  id: string; cfiRange: string; color: string; selectedText: string; quotePrefix: string | null;
  quoteSuffix: string | null; spineHref: string | null; createdAt: string; updatedAt: string;
}
export interface SectionStat { spineIndex: number; href: string; chars: number; words: number }
export interface IndexSummary { sections: SectionStat[]; reused: boolean }
export interface Hit { spineIndex: number; href: string; start: number; end: number; before: string; matched: string; after: string }
export interface QueryDone { queryId: number; total: number; truncated: boolean; cancelled: boolean; error: string | null }
export interface DictInfo {
  dictId: string; title: string; sourceLang: string | null; targetLang: string | null; enabled: boolean;
  priority: number; entries: number; attribution: string; importedAt: string;
}
export interface LookupEntry { dictId: string; dictTitle: string; headword: string; html: string; confidence: number }
export interface LookupResult { found: boolean; matchedChars: number; entries: LookupEntry[] }

type Json = Record<string, unknown>;

export const ipc = {
  getLaunchBook: () => invoke<LaunchBook | null>('get_launch_book'),
  openBook: (path: string) => invoke<LaunchBook>('open_book', { path }),
  pickBook: async (): Promise<string | null> => {
    const r = await openDialog({ multiple: false, directory: false, filters: [{ name: 'EPUB books', extensions: ['epub'] }] });
    return typeof r === 'string' ? r : null;
  },
  readBookBytes: () => invoke<ArrayBuffer>('read_book_bytes'),
  saveReadingPosition: (bookId: string, cfi: string, percentage: number, spineHref: string | null) =>
    invoke<void>('save_reading_position', { bookId, cfi, percentage, spineHref }),
  settingsGet: () => invoke<Json>('settings_get'),
  settingsUpdate: (patch: Json) => invoke<void>('settings_update', { patch }),
  overrideList: (bookId: string) => invoke<Json>('book_override_list', { bookId }),
  overrideSet: (bookId: string, key: string, value: unknown) => invoke<void>('book_override_set', { bookId, key, value }),
  overrideDelete: (bookId: string, key?: string) => invoke<void>('book_override_delete', { bookId, key: key ?? null }),
  bookmarkList: (bookId: string) => invoke<Bookmark[]>('bookmark_list', { bookId }),
  bookmarkUpsert: (bookId: string, bookmark: Bookmark) => invoke<void>('bookmark_upsert', { bookId, bookmark }),
  bookmarkDelete: (bookId: string, id: string) => invoke<void>('bookmark_delete', { bookId, id }),
  highlightList: (bookId: string) => invoke<Highlight[]>('highlight_list', { bookId }),
  highlightUpsert: (bookId: string, highlight: Highlight) => invoke<void>('highlight_upsert', { bookId, highlight }),
  highlightDelete: (bookId: string, id: string) => invoke<void>('highlight_delete', { bookId, id }),
  listSystemFonts: () => invoke<string[]>('list_system_fonts'),
  dictionaryImport: (paths: string[]) => invoke<{ imported: DictInfo[]; errors: string[] }>('dictionary_import', { paths }),
  dictionaryList: () => invoke<DictInfo[]>('dictionary_list'),
  dictionaryUpdate: (dictId: string, patch: { enabled?: boolean; priority?: number; sourceLang?: string; targetLang?: string }) =>
    invoke<void>('dictionary_update', { dictId, ...patch }),
  dictionaryRemove: (dictId: string) => invoke<void>('dictionary_remove', { dictId }),
  dictionaryLookup: (args: { term: string; context: string; bookLang?: string | null; dictIds?: string[] | null }) =>
    invoke<LookupResult>('dictionary_lookup', { args }),
  searchBuildIndex: (bookId: string) => invoke<IndexSummary>('search_build_index', { bookId }),
  searchQuery: (args: { queryId: number; pattern: string; regex: boolean; caseSensitive: boolean }) =>
    invoke<QueryDone>('search_query', { args }),
  searchCancel: () => invoke<void>('search_cancel'),
  onSearchBatch: (cb: (b: { queryId: number; hits: Hit[] }) => void): Promise<UnlistenFn> =>
    listen<{ queryId: number; hits: Hit[] }>('search-batch', (e) => cb(e.payload)),
  pickDictionaryFiles: async (directory: boolean): Promise<string[]> => {
    const r = await openDialog({
      multiple: !directory, directory,
      filters: directory ? undefined : [{ name: 'StarDict', extensions: ['ifo', 'idx', 'gz', 'dict', 'dz', 'syn'] }]
    });
    if (!r) return [];
    return Array.isArray(r) ? r : [r];
  }
};
