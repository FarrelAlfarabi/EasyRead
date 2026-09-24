import type { Block, BookContent, Line, OutlineItem, PageData, Section, TocEntry } from './types';
import { repairLine, type WordRanks } from './ocrCleanup';

/* ------------------------------------------------------------------ */
/* Text items -> lines                                                  */
/* ------------------------------------------------------------------ */

export interface RawItem {
  str: string;
  transform: number[];
  width: number;
  hasEOL?: boolean;
}

/** Group pdf.js text items into visual lines using their baselines. */
export function itemsToLines(items: RawItem[], pageHeight: number): Line[] {
  type Frag = { str: string; x: number; base: number; w: number; size: number };
  const frags: Frag[] = [];
  for (const it of items) {
    if (!it.str) continue;
    const t = it.transform;
    const size = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 10;
    frags.push({ str: it.str, x: t[4], base: pageHeight - t[5], w: it.width, size });
  }
  frags.sort((a, b) => a.base - b.base || a.x - b.x);

  const groups: Frag[][] = [];
  for (const f of frags) {
    const g = groups[groups.length - 1];
    if (g) {
      const ref = g[0];
      if (Math.abs(f.base - ref.base) < Math.max(ref.size, f.size) * 0.45) {
        g.push(f);
        continue;
      }
    }
    groups.push([f]);
  }

  const lines: Line[] = [];
  for (const g of groups) {
    g.sort((a, b) => a.x - b.x);
    let text = '';
    let end = -Infinity;
    let sizeSum = 0;
    let sizeW = 0;
    for (const f of g) {
      if (text && !/\s$/.test(text) && !/^\s/.test(f.str) && f.x - end > f.size * 0.12) text += ' ';
      text += f.str;
      end = Math.max(end, f.x + f.w);
      const n = f.str.trim().length;
      sizeSum += f.size * n;
      sizeW += n;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const size = sizeW ? sizeSum / sizeW : g[0].size;
    const x = g[0].x;
    const base = g.reduce((m, f) => m + f.base, 0) / g.length;
    lines.push({ text, x, y: base - size * 0.8, w: end - x, size });
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const median = (a: number[]): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

const percentile = (a: number[], p: number): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

/** Most common value (after rounding), weighted. */
function weightedMode(values: Array<[number, number]>, step: number): number {
  const m = new Map<number, number>();
  for (const [v, w] of values) {
    const k = Math.round(v / step) * step;
    m.set(k, (m.get(k) ?? 0) + w);
  }
  let best = 0;
  let bestW = -1;
  for (const [k, w] of m) if (w > bestW) { best = k; bestW = w; }
  return best;
}

export function bodySize(lines: Line[]): number {
  return weightedMode(lines.map((l) => [l.size, l.text.length]), 0.5) || 10;
}

const PAGE_NUM_RE = /^[\s\-–—|[(]*(page\s+|p\.\s*|hal(aman)?\.?\s+)?(\d{1,4}|[ivxlcdm]{1,7})(\s*(of|\/|dari)\s*\d{1,4})?[\s\-–—|\])]*$/i;

export function isPageNumber(text: string): boolean {
  return PAGE_NUM_RE.test(text.trim());
}

/** Normalized key used to spot running headers and footers that repeat across pages. */
export function runningKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b[ivxlcdm]{1,7}\b/g, '#')
    .replace(/\d+/g, '#')
    .replace(/[^a-z#\p{L}]+/gu, '');
}

/* ------------------------------------------------------------------ */
/* Running header / footer removal                                      */
/* ------------------------------------------------------------------ */

const EDGE_LINES = 2;

/** Remove page numbers and text repeating at the top/bottom of many pages. Returns new page list. */
export function removeRunning(pages: PageData[]): PageData[] {
  const textPages = pages.filter((p) => p.lines.length);
  const sizeBySource = new Map<string, number>();
  for (const src of new Set(textPages.map((p) => p.source))) {
    const ls = textPages.filter((p) => p.source === src).flatMap((p) => p.lines);
    if (ls.length) sizeBySource.set(src, bodySize(ls));
  }

  const edgeIdx = (p: PageData): number[] => {
    const n = p.lines.length;
    const idx = new Set<number>();
    for (let i = 0; i < Math.min(EDGE_LINES, n); i++) idx.add(i);
    for (let i = Math.max(0, n - EDGE_LINES); i < n; i++) idx.add(i);
    // Only lines near the page edges (top 15% / bottom 15%) count. Pre-classified lines
    // (e.g. from Gemini OCR, which already excludes headers/footers) are left alone.
    return [...idx].filter((i) => {
      const l = p.lines[i];
      return !l.kind && (l.y < p.height * 0.15 || l.y + l.size > p.height * 0.85);
    });
  };

  const counts = new Map<string, number>();
  for (const p of textPages) {
    const seen = new Set<string>();
    for (const i of edgeIdx(p)) {
      const k = runningKey(p.lines[i].text);
      if (k.length < 2 || seen.has(k)) continue;
      seen.add(k);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const minRepeat = Math.max(3, Math.ceil(textPages.length * 0.15));

  return pages.map((p) => {
    if (!p.lines.length) return p;
    const body = sizeBySource.get(p.source) ?? 10;
    const drop = new Set<number>();
    for (const i of edgeIdx(p)) {
      const l = p.lines[i];
      if (isPageNumber(l.text)) { drop.add(i); continue; }
      // Big text is a heading, not a running header.
      if (l.size > body * 1.15) continue;
      const k = runningKey(l.text);
      if (k.length >= 2 && (counts.get(k) ?? 0) >= minRepeat) { drop.add(i); continue; }
      // Small, short line at the very top of the page (running head that changes per chapter).
      const small = l.size < body * 0.92;
      const isTop = i === 0 && l.y < p.height * 0.12;
      if (small && isTop && l.text.length < 80 && !/[.!?]$/.test(l.text.trim())) { drop.add(i); continue; }
      if (small && k.length >= 2 && (counts.get(k) ?? 0) >= 2) drop.add(i);
    }
    return drop.size ? { ...p, lines: p.lines.filter((_, i) => !drop.has(i)) } : p;
  });
}

/* ------------------------------------------------------------------ */
/* Paragraphs and headings                                              */
/* ------------------------------------------------------------------ */

const CHAPTER_RE = /^(chapter|chap\.|part|book|volume|prologue|epilogue|introduction|preface|foreword|afterword|interlude|appendix|contents|bab|bagian|prolog|epilog|pendahuluan|kata pengantar|daftar isi|lampiran)\b/i;
const NUMERAL_RE = /^(\d{1,3}|[IVXLC]{1,7})\.?$/;
const SCENE_BREAK_RE = /^[\s*•·~#◆◇❖✦✧⁂§=\-–—_.]{1,15}$/;
const ENDS_SENTENCE_RE = /[.!?:;"'”’)\]…]$/;

interface PageStats {
  left: number;
  width: number;
  spacing: number;
  center: number;
  body: number;
}

function pageStats(p: PageData, fallback: PageStats | undefined, body: number): PageStats {
  const bodyLines = p.lines.filter((l) => Math.abs(l.size - body) <= body * 0.15);
  if (bodyLines.length < 4 && fallback) return { ...fallback, body };
  const left = weightedMode(bodyLines.map((l) => [l.x, 1]), 2) || percentile(p.lines.map((l) => l.x), 0.1);
  const width = percentile(bodyLines.map((l) => l.w), 0.8) || p.width * 0.7;
  const dys: number[] = [];
  for (let i = 1; i < bodyLines.length; i++) {
    const d = bodyLines[i].y - bodyLines[i - 1].y;
    if (d > 0) dys.push(d);
  }
  const spacing = median(dys) || body * 1.3;
  // Centre of the text block: from the left margin to the (near) right-most text edge, so
  // ragged-right pages do not pull the centre left.
  const right = Math.max(left + width, percentile(p.lines.map((l) => l.x + l.w), 0.9));
  return { left, width, spacing, center: (left + right) / 2, body };
}

function joinLines(a: string, b: string): string {
  if (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;
  if (a.endsWith('­')) return a.slice(0, -1) + b;
  if (/[-–—/]$/.test(a) && !/\s[-–—]$/.test(a)) return a + b;
  return a + ' ' + b;
}

/** Headings are short and title-like. Anything sentence-like is body text, whatever its size. */
export function couldBeHeading(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 12 || text.length > 80) return false;
  // Ends mid-word or mid-sentence ("... to", "com-"): a wrapped body line.
  if (/[-–—,;]$/.test(text)) return false;
  const letterWords = words.filter((w) => /^\p{L}/u.test(w));
  const lower = letterWords.filter((w) => /^\p{Ll}/u.test(w)).length;
  // Body lines are mostly lowercase words; headings are Title Case or CAPITALS.
  if (letterWords.length > 4 && lower / letterWords.length > 0.5) return false;
  // Several sentences in one line: body text.
  if ((text.match(/[.!?]["”’]?\s+\p{Lu}/gu) ?? []).length >= 1 && words.length > 6) return false;
  return true;
}

function looksLikeHeading(l: Line, st: PageStats, gapAbove: number, gapBelow: number): boolean {
  const text = l.text.trim();
  if (!couldBeHeading(text)) return false;
  // A full-width line is a wrapped body line, even if the size estimate says "big"
  // (scanner text layers often have jittery font sizes).
  if (l.w > st.width * 0.9 && Math.abs(l.x - st.left) < st.body * 2 && !CHAPTER_RE.test(text)) return false;
  const big = l.size >= st.body * 1.2;
  const lineCenter = l.x + l.w / 2;
  const centered = Math.abs(lineCenter - st.center) < st.width * 0.08 && l.w < st.width * 0.8;
  if (big && text.length < 100 && /\p{L}|\d/u.test(text)) return true;
  if (CHAPTER_RE.test(text) && text.length < 70 && (centered || gapAbove > st.spacing * 1.8 || l.size > st.body * 1.05)) return true;
  if (NUMERAL_RE.test(text) && (centered || big) && gapBelow > st.spacing * 1.3) return true;
  // Short centered line in capitals ("DO NOT COMMIT TO ANYONE", "JUDGMENT").
  const caps = text.replace(/[^\p{L}]/gu, '');
  const centeredAnyWidth = Math.abs(lineCenter - st.center) < st.width * 0.08 && l.w < st.width * 0.97;
  if (centeredAnyWidth && caps.length >= 4 && caps === caps.toUpperCase() && text.split(/\s+/).length <= 8) return true;
  // Short centered, title-like line with space around it.
  if (
    centered &&
    text.length < 50 &&
    gapAbove > st.spacing * 2 &&
    gapBelow > st.spacing * 1.4 &&
    !ENDS_SENTENCE_RE.test(text) &&
    /^\p{Lu}/u.test(text)
  ) return true;
  return false;
}

export function buildBlocks(pagesIn: PageData[]): Block[] {
  const pages = removeRunning([...pagesIn].sort((a, b) => a.page - b.page));
  const sizeBySource = new Map<string, number>();
  for (const src of new Set(pages.map((p) => p.source))) {
    const ls = pages.filter((p) => p.source === src).flatMap((p) => p.lines);
    if (ls.length) sizeBySource.set(src, bodySize(ls));
  }

  const blocks: Block[] = [];
  let para: { text: string; page: number } | null = null;
  let prevLine: Line | null = null;
  let prevStats: PageStats | null = null;
  let heading: { text: string; page: number; y: number; spacing: number } | null = null;
  const fallback = new Map<string, PageStats>();
  for (const [src, body] of sizeBySource) {
    const all = pages.filter((p) => p.source === src);
    const merged: PageData = { page: 0, width: all[0]?.width ?? 600, height: 0, source: src as PageData['source'], lines: all.flatMap((p) => p.lines) };
    fallback.set(src, pageStats(merged, undefined, body));
  }

  const flushPara = () => {
    if (para && para.text.trim()) blocks.push({ t: 'p', text: para.text.trim(), page: para.page });
    para = null;
  };
  const flushHeading = () => {
    if (heading) blocks.push({ t: 'h', text: heading.text, page: heading.page });
    heading = null;
  };
  // For lines pre-classified as whole paragraphs/headings (Gemini OCR): track the last
  // such line and its page, so we only merge a paragraph across an actual page boundary,
  // never two blocks Gemini already split on the same page.
  let prevKind: { kind: NonNullable<Line['kind']>; page: number } | null = null;

  for (const p of pages) {
    if (!p.lines.length) continue;
    const body = sizeBySource.get(p.source) ?? bodySize(p.lines);
    const st = pageStats(p, fallback.get(p.source), body);
    const lines = [...p.lines].sort((a, b) => a.y - b.y || a.x - b.x);

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const text = l.text.trim();
      if (!text) continue;

      if (l.kind) {
        if (l.kind === 'hr') {
          flushPara();
          flushHeading();
          blocks.push({ t: 'hr', text: '', page: p.page });
        } else if (l.kind === 'h') {
          flushPara();
          if (heading && heading.page === p.page) {
            heading.text = `${heading.text}: ${text}`.replace(/:\s*:/, ':');
          } else {
            flushHeading();
            heading = { text, page: p.page, y: l.y, spacing: 0 };
          }
        } else {
          flushHeading();
          const canContinue = para && prevKind?.kind === 'p' && prevKind.page !== p.page && !ENDS_SENTENCE_RE.test(para.text.trim());
          if (canContinue && para) para.text = `${para.text} ${text}`;
          else {
            flushPara();
            para = { text, page: p.page };
          }
        }
        prevLine = null;
        prevKind = { kind: l.kind, page: p.page };
        continue;
      }

      const prevOnPage = i > 0 ? lines[i - 1] : null;
      const nextOnPage = i < lines.length - 1 ? lines[i + 1] : null;
      const gapAbove = prevOnPage ? l.y - prevOnPage.y : st.spacing * 3;
      const gapBelow = nextOnPage ? nextOnPage.y - l.y : st.spacing * 3;

      if (SCENE_BREAK_RE.test(text) && /[*•·~#◆◇❖✦✧⁂§]/.test(text)) {
        flushPara();
        flushHeading();
        blocks.push({ t: 'hr', text: '', page: p.page });
        prevLine = null;
        prevKind = null;
        continue;
      }

      if (looksLikeHeading(l, st, gapAbove, gapBelow)) {
        flushPara();
        if (heading && heading.page === p.page && l.y - heading.y < st.spacing * 4 && heading.text.length + text.length < 100) {
          heading.text = `${heading.text}: ${text}`.replace(/:\s*:/, ':');
          heading.y = l.y;
        } else {
          flushHeading();
          heading = { text, page: p.page, y: l.y, spacing: st.spacing };
        }
        prevLine = null;
        prevKind = null;
        continue;
      }
      flushHeading();

      let newPara = !para || !prevLine;
      if (!newPara && prevLine && prevStats) {
        const samePage = prevOnPage !== null && prevLine === prevOnPage;
        const prevEnded = ENDS_SENTENCE_RE.test(prevLine.text.trim());
        const prevShort = prevLine.w < prevStats.width * 0.8;
        const indented = l.x > st.left + st.body * 0.8 && l.x - st.left < st.width * 0.3;
        if (samePage && gapAbove > st.spacing * 1.45) newPara = true;
        else if (indented && prevEnded) newPara = true;
        else if (prevShort && prevEnded) newPara = true;
      }
      if (newPara) {
        flushPara();
        para = { text, page: p.page };
      } else if (para) {
        para.text = joinLines(para.text, text);
      }
      prevLine = l;
      prevStats = st;
      prevKind = null;
    }
  }
  flushPara();
  flushHeading();
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Sections and table of contents                                       */
/* ------------------------------------------------------------------ */

const MAX_SECTION_BLOCKS = 300;

export interface BuildOptions {
  /** English word ranks; enables dictionary-based repair of OCR-looking text. */
  dict?: WordRanks;
}

/**
 * Clean up text that came from OCR before layout: collapse letter-spaced headings,
 * rejoin broken words, and (for scanner OCR layers only) repair misread words.
 * Tesseract pages were already repaired when read, Gemini text needs none.
 */
export function repairPages(pages: PageData[], dict?: WordRanks): PageData[] {
  return pages.map((p) => {
    if (!p.lines.length || p.source === 'ocr' || p.source === 'gemini') return p;
    const respell = !!p.ocrLayer;
    const lines = [...p.lines].sort((a, b) => a.y - b.y || a.x - b.x).map((l) => ({ ...l }));
    // Mend words split over a line break by a hyphen or dash ("com-" / "mit", "at—" / "tention")
    // before anything else looks at the pieces, so they are never "repaired" separately.
    if (dict) {
      for (let i = 0; i + 1 < lines.length; i++) {
        const a = /(\p{L}+)[-–—]$/u.exec(lines[i].text);
        const b = /^(\p{Ll}+)/u.exec(lines[i + 1].text);
        if (!a || !b || lines[i].kind || lines[i + 1].kind) continue;
        if (!dict.has((a[1] + b[1]).toLowerCase())) continue;
        const first = /^(\S+)\s*/u.exec(lines[i + 1].text)!;
        lines[i].text = lines[i].text.slice(0, a.index) + a[1] + first[1];
        lines[i + 1].text = lines[i + 1].text.slice(first[0].length);
      }
    }
    return { ...p, lines: lines.filter((l) => l.text.trim()).map((l) => (l.kind ? l : { ...l, text: repairLine(l.text, dict, respell) })) };
  });
}

export function buildContent(pages: PageData[], outline: OutlineItem[] = [], opts: BuildOptions = {}): BookContent {
  const blocks = buildBlocks(repairPages(pages, opts.dict));

  let toc: TocEntry[] = [];
  const usable = outline.filter((o) => o.page >= 1);
  if (usable.length >= 2) {
    for (const o of usable) {
      const onPage = blocks.findIndex((b) => b.page >= o.page);
      if (onPage < 0) continue;
      // Prefer a heading on that page whose text matches the outline title.
      let idx = onPage;
      for (let i = onPage; i < blocks.length && blocks[i].page === blocks[onPage].page; i++) {
        if (blocks[i].t === 'h') { idx = i; break; }
      }
      toc.push({ title: o.title, block: idx, level: o.level });
    }
  } else {
    blocks.forEach((b, i) => {
      if (b.t === 'h') toc.push({ title: b.text, block: i, level: 0 });
    });
  }
  // Drop duplicates pointing to the same block, keep order.
  const seenBlocks = new Set<string>();
  toc = toc.filter((t) => {
    const k = `${t.block}|${t.title}`;
    if (seenBlocks.has(k)) return false;
    seenBlocks.add(k);
    return true;
  });

  // Sections: split at top-level TOC entries, then cap size so rendering stays fast.
  const starts = new Set<number>([0]);
  for (const t of toc) if (t.level === 0) starts.add(t.block);
  const sorted = [...starts].filter((s) => s < blocks.length).sort((a, b) => a - b);
  const sections: Section[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    const end = i + 1 < sorted.length ? sorted[i + 1] : blocks.length;
    const entry = toc.find((t) => t.block === start);
    const title = entry?.title ?? (blocks[start]?.t === 'h' ? blocks[start].text : 'Start');
    for (let s = start; s < end; s += MAX_SECTION_BLOCKS) {
      sections.push({ title, start: s, end: Math.min(end, s + MAX_SECTION_BLOCKS) });
    }
  }
  if (!sections.length) sections.push({ title: 'Start', start: 0, end: 0 });

  const charIndex: number[] = [0];
  for (const b of blocks) charIndex.push(charIndex[charIndex.length - 1] + b.text.length + 1);

  return { blocks, sections, toc, charIndex };
}
