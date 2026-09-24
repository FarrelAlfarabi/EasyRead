import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildContent, itemsToLines, type RawItem } from './reflow';
import { isPoorText, loadWordRanks, textQuality } from './ocrCleanup';
import { looksLikeScanWithTextLayer } from './scanDetect';
import type { PageData } from './types';

function realDict() {
  const require = createRequire(import.meta.url);
  const list = JSON.parse(readFileSync(require.resolve('subtlex-word-frequencies/index.json'), 'utf8')) as Array<{ word: string; count: number }>;
  const counts = new Map<string, number>();
  for (const { word, count } of list) {
    const w = word.toLowerCase();
    if (!/^[a-z]+$/.test(w) || (w.length === 1 && w !== 'a' && w !== 'i')) continue;
    counts.set(w, (counts.get(w) ?? 0) + count);
  }
  return loadWordRanks([...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 60000).map(([w]) => w).join('\n'));
}

describe('scanned page with a broken scanner OCR text layer', async () => {
  const dict = realDict();
  const data = new Uint8Array(readFileSync(new URL('../../test/fixtures/scan-ocr-layer.pdf', import.meta.url)));
  const pdf = await pdfjs.getDocument({ data }).promise;
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const lines = itemsToLines(tc.items as unknown as RawItem[], vp.height);
  const ocrLayer = await looksLikeScanWithTextLayer(page as never, pdfjs.OPS as unknown as Record<string, number>);
  const pd: PageData = { page: 1, width: vp.width, height: vp.height, source: 'text', lines, ocrLayer };

  it('is detected as scanner text and flagged for re-reading', () => {
    expect(ocrLayer).toBe(true);
    expect(isPoorText(textQuality(lines.map((l) => l.text), dict))).toBe(true);
  });

  it('comes out clean even without re-reading (fallback path)', () => {
    const { blocks, toc } = buildContent([pd], [], { dict });
    const heads = blocks.filter((b) => b.t === 'h').map((b) => b.text);
    const body = blocks.filter((b) => b.t === 'p').map((b) => b.text).join('\n');
    expect(heads.join(' | ')).toContain('LAW 20');
    expect(heads.join(' | ')).toContain('DO NOT COMMIT TO ANYONE');
    expect(heads.join(' | ')).toContain('OBSERVANCE OF THE LAW');
    // No body sentence became a heading.
    for (const h of heads) expect(h.split(' ').length).toBeLessThanOrEqual(12);
    expect(toc.length).toBeGreaterThan(0);
    // Word repairs.
    expect(body).toContain('the fool');
    expect(body).toContain('commit to any side');
    expect(body).toContain('If you');
    expect(body).toContain('they will only try');
    expect(body).toContain('attention');
    expect(body).toContain('Parliament');
    // No stray colons from merged lines.
    expect(body).not.toMatch(/\p{L}: \p{Ll}/u);
    expect(body).not.toMatch(/thefool|tfwy|Ifyou|at—tention|Par liament|com: mit/);
  });
});
