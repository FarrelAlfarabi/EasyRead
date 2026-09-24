import { describe, expect, it } from 'vitest';
import { buildBlocks, buildContent, isPageNumber, itemsToLines, removeRunning } from './reflow';
import { ocrToLines } from './ocrLines';
import type { Line, PageData } from './types';

const W = 400;
const H = 600;

/** Build a fake page: header, body lines, footer page number. */
function page(n: number, body: Array<Partial<Line> & { text: string }>, opts: { header?: string } = {}): PageData {
  const lines: Line[] = [];
  if (opts.header !== undefined) lines.push({ text: opts.header, x: 150, y: 30, w: 100, size: 9 });
  let y = 120;
  for (const b of body) {
    const size = b.size ?? 11;
    lines.push({ text: b.text, x: b.x ?? 50, y: b.y ?? y, w: b.w ?? 300, size });
    y = (b.y ?? y) + 15;
  }
  lines.push({ text: String(n), x: 195, y: 560, w: 10, size: 9 });
  return { page: n, width: W, height: H, source: 'text', lines };
}

describe('isPageNumber', () => {
  it('matches common page number styles', () => {
    for (const s of ['12', '- 12 -', 'Page 3', 'xiv', '3 of 200', 'Halaman 5']) expect(isPageNumber(s)).toBe(true);
    for (const s of ['Chapter 1', 'He said 12 words.']) expect(isPageNumber(s)).toBe(false);
  });
});

describe('itemsToLines', () => {
  it('joins items on the same baseline and splits different baselines', () => {
    const lines = itemsToLines(
      [
        { str: 'Hello', transform: [11, 0, 0, 11, 50, 500], width: 25 },
        { str: 'world', transform: [11, 0, 0, 11, 80, 500.5], width: 25 },
        { str: 'Next line', transform: [11, 0, 0, 11, 50, 485], width: 45 },
      ],
      600,
    );
    expect(lines.map((l) => l.text)).toEqual(['Hello world', 'Next line']);
  });
});

describe('removeRunning', () => {
  it('removes repeated headers and page numbers', () => {
    const pages = [1, 2, 3, 4, 5, 6].map((n) => page(n, [{ text: `Body text on page ${n}.` }], { header: n % 2 ? 'THE BOOK TITLE' : 'Jane Author' }));
    const out = removeRunning(pages);
    for (const p of out) {
      expect(p.lines.map((l) => l.text)).toEqual([`Body text on page ${p.page}.`]);
    }
  });
});

describe('buildBlocks', () => {
  it('rejoins hyphenated words and merges lines into paragraphs', () => {
    const pages = [
      page(1, [
        { text: 'It was a bright cold day in April, and the clocks were', w: 300 },
        { text: 'striking thirteen. Winston Smith, his chin nuz-', w: 300 },
        { text: 'zled into his breast, slipped quickly.', w: 180 },
        { text: 'A second paragraph starts here with an indent and', x: 62, w: 290 },
        { text: 'continues on.', w: 80 },
      ]),
    ];
    const blocks = buildBlocks(pages);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain('nuzzled into');
    expect(blocks[0].text).toContain('clocks were striking');
    expect(blocks[1].text).toBe('A second paragraph starts here with an indent and continues on.');
  });

  it('continues a paragraph across a page break', () => {
    const pages = [
      page(1, [{ text: 'The sentence starts on one page and', w: 300 }], { header: 'Title' }),
      page(2, [{ text: 'ends on the next one.', w: 150 }], { header: 'Title' }),
      page(3, [{ text: 'Filler.', w: 60 }], { header: 'Title' }),
    ];
    const blocks = buildBlocks(pages);
    expect(blocks[0].text).toBe('The sentence starts on one page and ends on the next one.');
  });

  it('detects chapter headings by size and by "Chapter N" text', () => {
    const body = Array.from({ length: 6 }, () => ({ text: 'Plain body line of normal text that runs full width', w: 300 }));
    const pages = [
      page(1, [{ text: 'Chapter 1', size: 18, x: 160, w: 80 }, { text: 'The Beginning', size: 18, x: 140, w: 120 }, ...body]),
      page(2, [{ text: 'CHAPTER TWO', x: 150, w: 100, y: 120 }, ...body.map((b, i) => ({ ...b, y: 170 + i * 15 }))]),
    ];
    const { toc, blocks } = buildContent(pages);
    expect(toc.map((t) => t.title)).toEqual(['Chapter 1: The Beginning', 'CHAPTER TWO']);
    expect(blocks[toc[1].block].t).toBe('h');
  });

  it('uses the PDF outline for the table of contents when present', () => {
    const pages = [1, 2, 3].map((n) => page(n, [{ text: `A long line of text on page ${'abc'[n - 1]} that fills`, w: 300 }, { text: 'the width.', w: 60 }]));
    const { toc } = buildContent(pages, [
      { title: 'One', page: 1, level: 0 },
      { title: 'Two', page: 3, level: 0 },
    ]);
    expect(toc).toEqual([
      { title: 'One', block: 0, level: 0 },
      { title: 'Two', block: 2, level: 0 },
    ]);
  });
});

describe('ocrToLines', () => {
  it('drops low confidence and symbol junk lines and converts to PDF units', () => {
    const mk = (text: string, confidence: number, y: number) => ({
      text,
      confidence,
      bbox: { x0: 100, y0: y, x1: 700, y1: y + 30 },
      words: text.split(' ').map((t) => ({ text: t, confidence, bbox: { x0: 100, y0: y, x1: 150, y1: y + 30 } })),
    });
    const lines = ocrToLines(
      [{ paragraphs: [{ lines: [mk('A real line of text.', 92, 200), mk('~|/ ,; |{', 40, 260), mk('garbled maybe', 20, 300)] }] }],
      2,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: 'A real line of text.', x: 50, y: 100, w: 300 });
  });
});
