// Bundled reader fonts.
import notoSans from '@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff2?url';
import notoSansBold from '@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff2?url';
import notoSansItalic from '@fontsource/noto-sans/files/noto-sans-latin-400-italic.woff2?url';
import notoSerif from '@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff2?url';
import notoSerifBold from '@fontsource/noto-serif/files/noto-serif-latin-700-normal.woff2?url';
import notoSerifItalic from '@fontsource/noto-serif/files/noto-serif-latin-400-italic.woff2?url';
import notoMono from '@fontsource/noto-sans-mono/files/noto-sans-mono-latin-400-normal.woff2?url';
import notoMonoBold from '@fontsource/noto-sans-mono/files/noto-sans-mono-latin-700-normal.woff2?url';
import libron from '../assets/fonts/Libron-Regular.ttf?url';
import libronBold from '../assets/fonts/Libron-Bold.ttf?url';
import libronItalic from '../assets/fonts/Libron-Italic.ttf?url';
import libronBoldItalic from '../assets/fonts/Libron-BoldItalic.ttf?url';
import commitMono from '../assets/fonts/CommitMono-400-Regular.otf?url';
import commitMonoBold from '../assets/fonts/CommitMono-700-Regular.otf?url';
import commitMonoItalic from '../assets/fonts/CommitMono-400-Italic.otf?url';
import commitMonoBoldItalic from '../assets/fonts/CommitMono-700-Italic.otf?url';

type FontFormat = 'woff2' | 'opentype' | 'truetype';
const FONT_MIME: Record<FontFormat, string> = { woff2: 'font/woff2', opentype: 'font/otf', truetype: 'font/ttf' };

export interface BundledFont {
  id: string;
  label: string;
  family: string;
  fallback: string;
  faces: { url: string; weight: number; style: 'normal' | 'italic'; format?: FontFormat }[];
}

export const bundledFonts: BundledFont[] = [
  {
    id: 'noto-sans', label: 'Noto Sans', family: 'Noto Sans', fallback: 'sans-serif',
    faces: [
      { url: notoSans, weight: 400, style: 'normal' },
      { url: notoSansBold, weight: 700, style: 'normal' },
      { url: notoSansItalic, weight: 400, style: 'italic' }
    ]
  },
  {
    id: 'noto-serif', label: 'Noto Serif', family: 'Noto Serif', fallback: 'serif',
    faces: [
      { url: notoSerif, weight: 400, style: 'normal' },
      { url: notoSerifBold, weight: 700, style: 'normal' },
      { url: notoSerifItalic, weight: 400, style: 'italic' }
    ]
  },
  {
    id: 'noto-sans-mono', label: 'Noto Sans Mono', family: 'Noto Sans Mono', fallback: 'monospace',
    faces: [
      { url: notoMono, weight: 400, style: 'normal' },
      { url: notoMonoBold, weight: 700, style: 'normal' }
    ]
  },
  {
    id: 'libron', label: 'Libron', family: 'Libron', fallback: 'serif',
    faces: [
      { url: libron, weight: 400, style: 'normal', format: 'truetype' },
      { url: libronBold, weight: 700, style: 'normal', format: 'truetype' },
      { url: libronItalic, weight: 400, style: 'italic', format: 'truetype' },
      { url: libronBoldItalic, weight: 700, style: 'italic', format: 'truetype' }
    ]
  },
  {
    id: 'commit-mono', label: 'Commit Mono', family: 'Commit Mono', fallback: 'monospace',
    faces: [
      { url: commitMono, weight: 400, style: 'normal', format: 'opentype' },
      { url: commitMonoBold, weight: 700, style: 'normal', format: 'opentype' },
      { url: commitMonoItalic, weight: 400, style: 'italic', format: 'opentype' },
      { url: commitMonoBoldItalic, weight: 700, style: 'italic', format: 'opentype' }
    ]
  }
];

export const BOOK_FONT_ID = 'book';
export const SYSTEM_PREFIX = 'system:';

export function isSystemId(id: string) { return id.startsWith(SYSTEM_PREFIX); }
export function systemFamily(id: string) { return id.slice(SYSTEM_PREFIX.length); }
export function systemId(family: string) { return SYSTEM_PREFIX + family; }

const dataUrlCache = new Map<string, string>();
async function toDataUrl(url: string, format: FontFormat): Promise<string> {
  const hit = dataUrlCache.get(url);
  if (hit) return hit;
  const buf = await (await fetch(url)).arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const d = `data:${FONT_MIME[format]};base64,` + btoa(bin);
  dataUrlCache.set(url, d);
  return d;
}

/** Builds the @font-face CSS for a bundled font. */
export async function fontFaceCss(font: BundledFont): Promise<string> {
  const parts: string[] = [];
  for (const f of font.faces) {
    const format = f.format ?? 'woff2';
    const d = await toDataUrl(f.url, format);
    parts.push(`@font-face{font-family:"${font.family}";font-weight:${f.weight};font-style:${f.style};font-display:swap;src:url(${d}) format("${format}");}`);
  }
  return parts.join('\n');
}

export function findBundled(id: string): BundledFont | undefined {
  return bundledFonts.find((f) => f.id === id);
}

/** Resolves a stored font id to a CSS stack, falling back to Noto Serif. An empty stack leaves the book's own fonts in place. */
export function fontStack(id: string, systemFamilies: Set<string>): { stack: string; bundled?: BundledFont } {
  if (id === BOOK_FONT_ID) return { stack: '' };
  const b = findBundled(id);
  if (b) return { stack: `"${b.family}", ${b.fallback}`, bundled: b };
  if (isSystemId(id)) {
    const fam = systemFamily(id);
    if (systemFamilies.size === 0 || systemFamilies.has(fam)) {
      return { stack: `"${fam.replace(/"/g, '')}", serif` };
    }
  }
  const d = findBundled('noto-serif')!;
  return { stack: `"${d.family}", ${d.fallback}`, bundled: d };
}

const PANGRAMS: Record<string, string> = {
  en: 'The quick brown fox jumps over the lazy dog',
  es: 'El veloz murciélago hindú comía feliz cardillo y kiwi',
  fr: 'Portez ce vieux whisky au juge blond qui fume',
  de: 'Falsches Üben von Xylophonmusik quält jeden größeren Zwerg',
  ja: 'いろはにほへと ちりぬるを わかよたれそ',
  zh: '敏捷的棕色狐狸跳过了懒狗',
  ko: '다람쥐 헌 쳇바퀴에 타고파',
  ru: 'Съешь же ещё этих мягких французских булок'
};

export function pangramFor(locale: string): string {
  return PANGRAMS[locale.split('-')[0].toLowerCase()] ?? PANGRAMS.en;
}
