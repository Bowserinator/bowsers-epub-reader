import { z } from 'zod';
import { clamp } from '../app/format';

export const READER_MODES = ['spread', 'single-scroll', 'continuous', 'chapter-spread'] as const;
export const THEMES = ['auto', 'white', 'sepia', 'light-blue', 'charcoal', 'black'] as const;
export const PAGE_SURFACES = ['gap', 'gap-shadow', 'no-gap'] as const;
export const TEXT_ALIGNS = ['left', 'justify'] as const;
export const REMAINING_MODES = ['chapter-time', 'book-time', 'chapter-pages'] as const;

export type ReaderMode = (typeof READER_MODES)[number];
export type Theme = (typeof THEMES)[number];
export type PageSurface = (typeof PAGE_SURFACES)[number];
export type TextAlign = (typeof TEXT_ALIGNS)[number];
export type RemainingMode = (typeof REMAINING_MODES)[number];

export const isScrollMode = (m: ReaderMode) => m === 'single-scroll' || m === 'continuous';
export const isSpreadMode = (m: ReaderMode) => m === 'spread' || m === 'chapter-spread';

export const PAGE_GAP: Record<(typeof PAGE_SURFACES)[number], number> = { gap: 12, 'gap-shadow': 12, 'no-gap': 0 };
export const PAGE_OUTER = 12;
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;
export const LINE_HEIGHT_MIN = 1;
export const LINE_HEIGHT_MAX = 2.5;
export const LINE_HEIGHT_STEP = 0.1;
export const PAGE_MARGIN_MIN = 8;
export const PAGE_MARGIN_MAX = 120;
export const PAGE_MARGIN_STEP = 4;
export const WPM_MIN = 100;
export const WPM_MAX = 1000;

function boundedNumber(min: number, max: number, step = 1) {
  return z.number().finite().transform((n) => clamp(Number((Math.round(n / step) * step).toFixed(2)), min, max));
}

/** Per-key validators so one invalid value does not reset the rest. */
export const settingSchemas = {
  theme: z.enum(THEMES),
  fontFamilyId: z.string().min(1).max(200),
  fontSizePx: boundedNumber(FONT_SIZE_MIN, FONT_SIZE_MAX),
  lineHeight: boundedNumber(LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, LINE_HEIGHT_STEP),
  textAlign: z.enum(TEXT_ALIGNS),
  pageMarginPx: boundedNumber(PAGE_MARGIN_MIN, PAGE_MARGIN_MAX),
  readerMode: z.enum(READER_MODES),
  pageSurface: z.enum(PAGE_SURFACES),
  showChapterRunningHeader: z.boolean(),
  showPageNumber: z.boolean(),
  showTitle: z.boolean(),
  hoverDefine: z.boolean(),
  dictionaryMode: z.enum(['auto', 'manual']),
  activeDictionaryIds: z.array(z.string().max(64)).max(64),
  autoHideControls: z.boolean(),
  reducedAnimations: z.boolean(),
  readingSpeedWpm: boundedNumber(WPM_MIN, WPM_MAX),
  remainingMode: z.enum(REMAINING_MODES)
} as const;

export interface ReaderSettings {
  theme: Theme;
  fontFamilyId: string;
  fontSizePx: number;
  lineHeight: number;
  textAlign: TextAlign;
  pageMarginPx: number;
  readerMode: ReaderMode;
  pageSurface: PageSurface;
  showChapterRunningHeader: boolean;
  showPageNumber: boolean;
  showTitle: boolean;
  hoverDefine: boolean;
  dictionaryMode: 'auto' | 'manual';
  activeDictionaryIds: string[];
  autoHideControls: boolean;
  reducedAnimations: boolean;
  readingSpeedWpm: number;
  remainingMode: RemainingMode;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'auto',
  fontFamilyId: 'noto-serif',
  fontSizePx: 18,
  lineHeight: 1.5,
  textAlign: 'left',
  pageMarginPx: 24,
  readerMode: 'spread',
  pageSurface: 'gap',
  showChapterRunningHeader: true,
  showPageNumber: true,
  showTitle: true,
  hoverDefine: true,
  dictionaryMode: 'auto',
  activeDictionaryIds: [],
  autoHideControls: false,
  reducedAnimations: false,
  readingSpeedWpm: 300,
  remainingMode: 'chapter-time'
};

/** Settings a book may override. */
export const OVERRIDABLE_KEYS = [
  'theme', 'fontFamilyId', 'fontSizePx', 'lineHeight', 'textAlign', 'pageMarginPx', 'readerMode', 'pageSurface', 'showChapterRunningHeader',
  'showPageNumber'
] as const;
export type OverridableKey = (typeof OVERRIDABLE_KEYS)[number];

export function isOverridable(k: string): k is OverridableKey {
  return (OVERRIDABLE_KEYS as readonly string[]).includes(k);
}

/** Merges stored values over defaults, ignoring invalid entries. */
export function parseSettings(raw: Record<string, unknown> | null | undefined): ReaderSettings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const [k, schema] of Object.entries(settingSchemas)) {
    if (raw && k in raw) {
      const r = (schema as z.ZodTypeAny).safeParse(raw[k]);
      if (r.success) out[k] = r.data;
    }
  }
  return out as unknown as ReaderSettings;
}

/** Parses valid per-book overrides. */
export function parseOverrides(raw: Record<string, unknown> | null | undefined): { enabled: boolean; values: Partial<ReaderSettings> } {
  const values: Record<string, unknown> = {};
  if (raw) {
    for (const k of OVERRIDABLE_KEYS) {
      if (k in raw) {
        const r = (settingSchemas[k] as z.ZodTypeAny).safeParse(raw[k]);
        if (r.success) values[k] = r.data;
      }
    }
  }
  return { enabled: raw?._enabled === true, values: values as Partial<ReaderSettings> };
}

export function validateValue<K extends keyof ReaderSettings>(key: K, value: unknown): ReaderSettings[K] {
  const r = (settingSchemas[key] as z.ZodTypeAny).safeParse(value);
  return (r.success ? r.data : DEFAULT_SETTINGS[key]) as ReaderSettings[K];
}

export const THEME_COLORS: Record<Exclude<Theme, 'auto'>, { bg: string; fg: string; dark: boolean }> = {
  white: { bg: '#ffffff', fg: '#111111', dark: false },
  sepia: { bg: '#f4ecd8', fg: '#171510', dark: false },
  'light-blue': { bg: '#e6f2fa', fg: '#111111', dark: false },
  charcoal: { bg: '#333333', fg: '#ffffff', dark: true },
  black: { bg: '#000000', fg: '#ffffff', dark: true }
};

export function resolveTheme(theme: Theme, osDark: boolean): Exclude<Theme, 'auto'> {
  return theme === 'auto' ? (osDark ? 'charcoal' : 'white') : theme;
}
