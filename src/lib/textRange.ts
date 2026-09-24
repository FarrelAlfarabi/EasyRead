/**
 * Map between character offsets in a block's plain text (its textContent) and DOM Ranges.
 * Offsets are stable across re-renders and layout changes, so highlights, the last-read
 * marker and search hits are stored as offsets and turned into Ranges when drawn.
 */

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

export function rangeFromOffsets(root: Element, start: number, end: number): Range | null {
  const nodes = textNodes(root);
  let pos = 0;
  let sNode: Text | null = null;
  let sOff = 0;
  let eNode: Text | null = null;
  let eOff = 0;
  for (const n of nodes) {
    const len = n.data.length;
    if (!sNode && start <= pos + len) {
      sNode = n;
      sOff = start - pos;
    }
    if (sNode && end <= pos + len) {
      eNode = n;
      eOff = end - pos;
      break;
    }
    pos += len;
  }
  if (!sNode || !eNode) return null;
  const r = root.ownerDocument!.createRange();
  r.setStart(sNode, Math.max(0, Math.min(sOff, sNode.data.length)));
  r.setEnd(eNode, Math.max(0, Math.min(eOff, eNode.data.length)));
  return r;
}

/** Character offset of (node, offset) within root's textContent. */
export function offsetOf(root: Element, node: Node, offset: number): number {
  if (node.nodeType !== Node.TEXT_NODE) {
    // Point is between child nodes: count text before child[offset].
    const r = root.ownerDocument!.createRange();
    r.setStart(root, 0);
    r.setEnd(node, offset);
    return r.toString().length;
  }
  let pos = 0;
  for (const n of textNodes(root)) {
    if (n === node) return pos + offset;
    pos += n.data.length;
  }
  return pos;
}

/** Caret position under a screen point (Chrome, Safari, Firefox). */
export function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    if (p) return { node: p.offsetNode, offset: p.offset };
  }
  if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(x, y);
    if (r) return { node: r.startContainer, offset: r.startOffset };
  }
  return null;
}

/** True if (x, y) is actually over one of the range's glyph boxes (not just nearest to it). */
export function pointInRange(r: Range, x: number, y: number, slop = 4): boolean {
  for (const rect of Array.from(r.getClientRects())) {
    if (x >= rect.left - slop && x <= rect.right + slop && y >= rect.top - slop && y <= rect.bottom + slop) return true;
  }
  return false;
}

type HighlightRegistry = Map<string, unknown> & { set(name: string, h: unknown): unknown; delete(name: string): boolean };

/** CSS Custom Highlight API (no DOM changes, so pagination is not disturbed). */
export function setHighlight(name: string, ranges: Range[]): boolean {
  const css = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const H = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!css?.highlights || !H) return false;
  if (!ranges.length) css.highlights.delete(name);
  else css.highlights.set(name, new H(...ranges));
  return true;
}

export const highlightsSupported = () => !!(globalThis as unknown as { CSS?: { highlights?: unknown } }).CSS?.highlights;
