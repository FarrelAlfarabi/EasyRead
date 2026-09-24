import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildContent, itemsToLines, type RawItem } from './reflow';
import type { PageData } from './types';

describe('real PDF fixture (text layer)', () => {
  it('strips headers and page numbers, keeps paragraphs, and finds chapters', async () => {
    const data = new Uint8Array(readFileSync(new URL('../../test/fixtures/book-text.pdf', import.meta.url)));
    const pdf = await pdfjs.getDocument({ data }).promise;
    const pages: PageData[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const lines = itemsToLines(tc.items as unknown as RawItem[], vp.height);
      pages.push({ page: n, width: vp.width, height: vp.height, source: 'text', lines });
    }
    const { blocks, toc } = buildContent(pages);
    expect(toc.map((t) => t.title)).toEqual([
      'Chapter 1: The Road to the Market',
      'Chapter 2: A Letter from the North',
      'Chapter 3: Storm over the Valley',
    ]);
    const text = blocks.map((b) => b.text).join('\n');
    // Running headers and page numbers are gone.
    expect(text).not.toMatch(/^The Quiet Valley$/m);
    expect(blocks.some((b) => /^\d+$/.test(b.text))).toBe(false);
    expect(blocks.filter((b) => b.text === 'The Quiet Valley')).toHaveLength(0);
    // Hyphenated words were rejoined.
    expect(text).not.toMatch(/\p{L}- \p{L}/u);
    expect(text).toContain('grandmother');
    // 14 paragraphs per chapter.
    expect(blocks.filter((b) => b.t === 'p')).toHaveLength(42);
  });
});
