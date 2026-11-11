// Text extraction used to map search hits to DOM ranges.

const SKIP = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE']);

export interface TextSpan { node: Text; start: number; end: number; rawLen: number; map: number[] }

/** Collects collapsed text and per-node offset maps. */
export function collectText(doc: Document): { text: string; spans: TextSpan[] } {
  const root = doc.body ?? doc.documentElement;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      for (let p = n.parentElement; p; p = p.parentElement) if (SKIP.has(p.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let text = '';
  let prevWs = false;
  const spans: TextSpan[] = [];
  const ws = /\s/;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const raw = n.data;
    const start = text.length;
    const map: number[] = []; // map[k] = raw index of the k-th emitted char of this node
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (ws.test(c)) {
        if (!prevWs) { text += ' '; map.push(i); }
        prevWs = true;
      } else {
        text += c; map.push(i); prevWs = false;
      }
    }
    spans.push({ node: n, start, end: text.length, rawLen: raw.length, map });
  }
  return { text, spans };
}

/** Converts a text range to a DOM Range. */
export function rangeFromOffsets(doc: Document, spans: TextSpan[], start: number, end: number): Range | null {
  if (end <= start) return null;
  let a: { node: Text; offset: number } | null = null;
  let b: { node: Text; offset: number } | null = null;
  for (const s of spans) {
    if (!a && start >= s.start && start < s.end) a = { node: s.node, offset: s.map[start - s.start] };
    if (!b && end > s.start && end <= s.end) b = { node: s.node, offset: s.map[end - 1 - s.start] + 1 };
    if (a && b) break;
  }
  if (!a || !b) return null;
  const r = doc.createRange();
  try { r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); } catch { return null; }
  return r;
}

/** Finds the occurrence closest to `hint`. */
export function locateNear(text: string, needle: string, hint: number, caseSensitive: boolean): number {
  const hay = caseSensitive ? text : text.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  if (!n) return -1;
  let best = -1, bestDist = Infinity;
  for (let i = hay.indexOf(n); i !== -1; i = hay.indexOf(n, i + 1)) {
    const d = Math.abs(i - hint);
    if (d < bestDist) { best = i; bestDist = d; }
    if (i > hint + 2000) break;
  }
  return best;
}
