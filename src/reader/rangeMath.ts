// DOM range arithmetic.

type Point = [Node, number];

/** Where point b lies relative to point a: -1 before, 0 equal, 1 after. */
function compare(doc: Document, a: Point, b: Point): number {
  const r = doc.createRange();
  r.setStart(a[0], a[1]);
  r.collapse(true);
  return r.comparePoint(b[0], b[1]);
}

/**
 * The parts of `from` that lie outside `cut`, in document order, or null when the two ranges do not overlap.
 * Both ranges must belong to `doc`.
 */
export function subtractRange(doc: Document, from: Range, cut: Range): Range[] | null {
  const fs: Point = [from.startContainer, from.startOffset], fe: Point = [from.endContainer, from.endOffset];
  const cs: Point = [cut.startContainer, cut.startOffset], ce: Point = [cut.endContainer, cut.endOffset];
  if (compare(doc, fs, ce) !== 1 || compare(doc, cs, fe) !== 1) return null;
  const parts: Range[] = [];
  if (compare(doc, fs, cs) === 1) {
    const r = doc.createRange();
    r.setStart(fs[0], fs[1]); r.setEnd(cs[0], cs[1]);
    parts.push(r);
  }
  if (compare(doc, ce, fe) === 1) {
    const r = doc.createRange();
    r.setStart(ce[0], ce[1]); r.setEnd(fe[0], fe[1]);
    parts.push(r);
  }
  return parts;
}
