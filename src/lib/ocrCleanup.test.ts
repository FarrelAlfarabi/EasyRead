import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { dictionaryRatio, isStrayMark, loadWordRanks, ocrDistance, repairToken, respell, splitGlued } from './ocrCleanup';
import { ocrToLines, type OcrLineLike } from './ocrLines';

// Build the same list the app ships (see scripts/build-dict.mjs), straight from the source package.
function realDict() {
  const require = createRequire(import.meta.url);
  const list = JSON.parse(readFileSync(require.resolve('subtlex-word-frequencies/index.json'), 'utf8')) as Array<{ word: string; count: number }>;
  const counts = new Map<string, number>();
  for (const { word, count } of list) {
    const w = word.toLowerCase();
    if (!/^[a-z]+$/.test(w) || (w.length === 1 && w !== 'a' && w !== 'i')) continue;
    counts.set(w, (counts.get(w) ?? 0) + count);
  }
  const words = [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 60000).map(([w]) => w);
  return loadWordRanks(words.join('\n'));
}
const dict = realDict();

describe('ocrDistance', () => {
  it('makes look-alike glyph swaps cheap', () => {
    expect(ocrDistance('commil', 'commit')).toBeCloseTo(0.4);
    expect(ocrDistance('rnorning', 'morning')).toBeCloseTo(0.4);
    expect(ocrDistance('cat', 'dog')).toBeGreaterThanOrEqual(2);
  });
});

describe('repairToken', () => {
  it('fixes the examples from real scans', () => {
    expect(repairToken('tfwy', dict, 40)).toBe('they');
    expect(repairToken('commil', dict, 50)).toBe('commit');
    expect(repairToken('Ifyou', dict, 60)).toBe('If you');
    expect(repairToken('thefool', dict, 60)).toBe('the fool');
  });

  it('keeps punctuation around a repaired word', () => {
    expect(repairToken('“thefool,', dict, 60)).toBe('“the fool,');
    expect(repairToken('wheee.', dict, 40)).toBe('where.');
  });

  it('never touches known words, names, acronyms, numbers or short words', () => {
    for (const w of ['they', 'gloaming', 'Bellweather', 'Anna', 'NASA', 'OK', '1984', 'hil']) {
      expect(repairToken(w, dict, 30)).toBe(w);
    }
  });

  it('leaves ambiguous words alone instead of guessing', () => {
    // "title" (look-alike swap) vs "little" (missing letter): too close to call.
    expect(respell('litle', dict, 40)).toBeNull();
  });

  it('only allows big fixes when Tesseract itself was unsure', () => {
    expect(repairToken('tfwy', dict, 95)).toBe('tfwy');
  });
});

describe('splitGlued', () => {
  it('splits a capitalized word only off a leading function word', () => {
    expect(splitGlued('Ifyou', dict)).toBe('If you');
    expect(splitGlued('Martha', dict)).toBeNull();
  });
});

describe('junk detection', () => {
  it('spots stray marks and non-word lines', () => {
    expect(isStrayMark("'")).toBe(true);
    expect(isStrayMark('“')).toBe(true);
    expect(isStrayMark('a')).toBe(false);
    expect(dictionaryRatio(['I)C)PJCYT', 'CXDLJBJIT:'], dict)).toBe(0);
    expect(dictionaryRatio(['The', 'old', 'man.'], dict)).toBe(1);
  });
});

describe('ocrToLines with cleanup', () => {
  const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });
  const line = (text: string, conf: number, y: number, h: number, wordConf = conf): OcrLineLike => {
    let x = 100;
    const words = text.split(' ').map((t) => {
      const w = { text: t, confidence: wordConf, bbox: box(x, y, x + t.length * 12, y + h) };
      x += t.length * 12 + 10;
      return w;
    });
    return { text, confidence: conf, bbox: box(100, y, x, y + h), words };
  };
  const body = (y: number) => line('The old man walked slowly down to the river that morning.', 90, y, 20);

  it('drops a garbage heading instead of showing junk as a big title', () => {
    const lines = ocrToLines([{ paragraphs: [{ lines: [line('20: I)C)PJCYT CXDLJBJIT:', 80, 100, 40), body(200), body(240), body(280)] }] }], 2, 55, { dict });
    expect(lines.map((l) => l.text)).not.toContain('20: I)C)PJCYT CXDLJBJIT:');
    expect(lines.some((l) => /PJCYT/.test(l.text))).toBe(false);
  });

  it('keeps a real heading', () => {
    const lines = ocrToLines([{ paragraphs: [{ lines: [line('Chapter 20', 92, 100, 40), body(200), body(240), body(280)] }] }], 2, 55, { dict });
    expect(lines[0].text).toBe('Chapter 20');
  });

  it('drops body lines that are mostly non-words and removes stray marks', () => {
    const lines = ocrToLines(
      [{ paragraphs: [{ lines: [body(200), line('Wr ksh qzt vvvr plm', 60, 240, 20), line("the fool ' went home", 85, 280, 20)] }] }],
      2,
      55,
      { dict },
    );
    expect(lines.map((l) => l.text)).toEqual(['The old man walked slowly down to the river that morning.', 'the fool went home']);
  });

  it('repairs words inside lines', () => {
    const lines = ocrToLines([{ paragraphs: [{ lines: [line('Ifyou ask me thefool could not commil to it.', 70, 200, 20, 55)] }] }], 2, 55, { dict });
    expect(lines[0].text).toBe('If you ask me the fool could not commit to it.');
  });
});
