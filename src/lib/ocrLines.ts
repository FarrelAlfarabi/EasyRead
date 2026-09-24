import type { Line } from './types';

interface Box { x0: number; y0: number; x1: number; y1: number }
export interface OcrLineLike {
  text: string;
  confidence: number;
  bbox: Box;
  words?: Array<{ text: string; confidence: number; bbox: Box }>;
}
export interface OcrBlockLike {
  paragraphs: Array<{ lines: OcrLineLike[] }>;
}

/** Share of characters that are letters or digits. */
function alnumRatio(s: string): number {
  const t = s.replace(/\s/g, '');
  if (!t) return 0;
  const n = (t.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return n / t.length;
}

/**
 * Convert Tesseract blocks into Lines in PDF points.
 * `scale` is the render scale (canvas px per PDF point).
 * Low confidence and symbol-heavy lines (noise from images, borders, margins) are dropped.
 */
export function ocrToLines(blocks: OcrBlockLike[] | null | undefined, scale: number, minConf = 55): Line[] {
  const out: Line[] = [];
  for (const b of blocks ?? []) {
    for (const p of b.paragraphs) {
      for (const l of p.lines) {
        let words = (l.words ?? []).filter((w) => w.text.trim());
        // Drop single junk words inside otherwise good lines.
        words = words.filter((w) => w.confidence >= 25 || alnumRatio(w.text) > 0.6);
        const text = (words.length ? words.map((w) => w.text).join(' ') : l.text).replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (l.confidence < minConf && !(l.confidence >= 35 && alnumRatio(text) > 0.9 && text.length > 20)) continue;
        if (alnumRatio(text) < 0.55) continue;
        if (text.length < 2 && !/\d/.test(text)) continue;
        // Line height is a stand-in for font size. Use the median word height, which ignores
        // stray tall glyphs, and scale to roughly match an em.
        const hs = (words.length ? words : [l]).map((w) => w.bbox.y1 - w.bbox.y0).sort((a, c) => a - c);
        const h = hs[Math.floor(hs.length / 2)];
        const size = (h / scale) * 0.85;
        out.push({
          text,
          x: l.bbox.x0 / scale,
          y: l.bbox.y0 / scale,
          w: (l.bbox.x1 - l.bbox.x0) / scale,
          size,
        });
      }
    }
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}
