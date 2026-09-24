import type { Line } from './types';
import { dictionaryRatio, isStrayMark, repairToken, type WordRanks } from './ocrCleanup';

interface Box { x0: number; y0: number; x1: number; y1: number }
export interface OcrWordLike { text: string; confidence: number; bbox: Box }
export interface OcrLineLike {
  text: string;
  confidence: number;
  bbox: Box;
  words?: OcrWordLike[];
}
export interface OcrBlockLike {
  paragraphs: Array<{ lines: OcrLineLike[] }>;
}

export interface OcrLineOptions {
  /** English word ranks. When given, obvious OCR mistakes are repaired and junk lines dropped. */
  dict?: WordRanks;
}

/** Share of characters that are letters or digits. */
function alnumRatio(s: string): number {
  const t = s.replace(/\s/g, '');
  if (!t) return 0;
  const n = (t.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return n / t.length;
}

const isNumberish = (t: string) => /^[\p{N}IVXLCivxlc.:,)(-]+$/u.test(t);
const medianOf = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const wordHeight = (l: OcrLineLike) => medianOf((l.words?.length ? l.words : [l]).map((w) => w.bbox.y1 - w.bbox.y0));

/**
 * Keep only the believable words of a large, heading-like line. OCR on big display type
 * often produces confident-looking junk ("I)C)PJCYT CXDLJBJIT"), and showing that as a
 * chapter title is worse than showing nothing. Returns null to drop the line.
 */
function cleanHeading(words: OcrWordLike[], dict: WordRanks | undefined): OcrWordLike[] | null {
  const good = words.filter((w) => {
    if (w.confidence < 70) return false;
    const core = w.text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!core) return false;
    if (isNumberish(core)) return true;
    if (!dict) return w.confidence >= 80;
    return dict.has(core.toLowerCase()) || (/^\p{Lu}\p{Ll}+$/u.test(core) && w.confidence >= 85);
  });
  if (!good.length) return null;
  // Most of the heading must survive; otherwise it was mostly noise.
  if (good.length / words.length < 0.5) return null;
  return good;
}

/**
 * Convert Tesseract blocks into Lines in PDF points.
 * `scale` is the render scale (canvas px per PDF point).
 * Low confidence and symbol-heavy lines (noise from images, borders, margins) are dropped.
 */
export function ocrToLines(blocks: OcrBlockLike[] | null | undefined, scale: number, minConf = 55, opts: OcrLineOptions = {}): Line[] {
  const { dict } = opts;
  const all = (blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
  const pageWordH = medianOf(all.map(wordHeight).filter((h) => h > 0));
  const out: Line[] = [];
  for (const l of all) {
    let words = (l.words ?? []).filter((w) => w.text.trim());
    // Drop single junk words inside otherwise good lines, and stray quote/tick marks.
    words = words.filter((w) => (w.confidence >= 25 || alnumRatio(w.text) > 0.6) && !isStrayMark(w.text));
    const h = wordHeight(l);
    const headingLike = pageWordH > 0 && h >= pageWordH * 1.3 && words.length <= 12;
    if (headingLike && words.length) {
      const kept = cleanHeading(words, dict);
      if (!kept) continue;
      words = kept;
    } else if (l.confidence < minConf && !(l.confidence >= 35 && alnumRatio(l.text) > 0.9 && l.text.length > 20)) {
      continue;
    }
    let tokens = words.length ? words.map((w) => (dict ? repairToken(w.text, dict, w.confidence) : w.text)) : [l.text];
    let text = tokens.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (alnumRatio(text) < 0.55) continue;
    if (text.length < 2 && !/\d/.test(text)) continue;
    if (dict) {
      tokens = text.split(' ');
      const wordish = tokens.filter((t) => /\p{L}{2,}/u.test(t)).length;
      // Mostly non-words: junk from a picture, a border, or bleed-through.
      if (wordish >= 2 && dictionaryRatio(tokens, dict) < 0.3) continue;
      // Low-confidence lines must also be mostly real words (3+ letters, so stray "to", "ad"
      // fragments do not count).
      const meanConf = words.length ? words.reduce((s, w) => s + w.confidence, 0) / words.length : l.confidence;
      const longer = tokens.filter((t) => /\p{L}{3,}/u.test(t));
      if (meanConf < 60 && longer.length >= 3 && dictionaryRatio(longer, dict) < 0.5) continue;
      if (wordish === 1 && tokens.length === 1 && dictionaryRatio(tokens, dict) === 0 && l.confidence < 60) continue;
    }
    // Line height is a stand-in for font size. Use the median word height, which ignores
    // stray tall glyphs, and scale to roughly match an em.
    const size = (h / scale) * 0.85;
    out.push({
      text,
      x: l.bbox.x0 / scale,
      y: l.bbox.y0 / scale,
      w: (l.bbox.x1 - l.bbox.x0) / scale,
      size,
    });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}
