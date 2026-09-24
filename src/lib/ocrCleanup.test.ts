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

import { collapseLetterSpacing, joinBrokenWords, repairLine, segmentWords, textQuality, isPoorText } from './ocrCleanup';
import { couldBeHeading } from './reflow';

describe('scanner text-layer repair', () => {
  it('collapses letter-spaced headings and digits', () => {
    expect(collapseLetterSpacing('L A W: 2 0', dict)).toBe('LAW: 20');
    expect(collapseLetterSpacing('J U D GM ENT', dict)).toBe('JUDGMENT');
    expect(collapseLetterSpacing('D O N OT C OM MIT TO ANYONE', dict)).toBe('DO NOT COMMIT TO ANYONE');
    expect(collapseLetterSpacing('B UT B E C O U RTED BY ALL', dict)).toBe('BUT BE COURTED BY ALL');
    expect(collapseLetterSpacing('O B S E RVAN CE OF THE LAW When Queen', dict)).toBe('OBSERVANCE OF THE LAW When Queen');
  });

  it('leaves normal sentences alone', () => {
    for (const s of ['It is a big day for us', 'I saw a man', 'He was in a hurry to go']) expect(collapseLetterSpacing(s, dict)).toBe(s);
  });

  it('segments glued capitals', () => {
    expect(segmentWords('DONOTCOMMIT', dict)).toBe('DO NOT COMMIT');
  });

  it('rejoins words split by a dash or a space', () => {
    expect(joinBrokenWords('hold at—tention and', dict)).toBe('hold attention and');
    expect(joinBrokenWords('the Par liament urged', dict)).toBe('the Parliament urged');
    // Two real words stay apart, and a real dash between words stays.
    expect(joinBrokenWords('of the house', dict)).toBe('of the house');
    expect(joinBrokenWords('others——playing', dict)).toBe('others——playing');
  });

  it('never inserts colons into body text', () => {
    const out = repairLine('Do not com mit to it, at—tention but never', dict, true);
    expect(out).not.toContain(':');
  });

  it('scores broken scanner text as poor and clean text as fine', () => {
    expect(isPoorText(textQuality(['J U D GM ENT', 'D O N OT C OM MIT', 'It is thefool who tfwy commil'], dict))).toBe(true);
    expect(isPoorText(textQuality(['The old man walked slowly down to the river that morning.'], dict))).toBe(false);
  });
});

describe('heading guard', () => {
  it('rejects sentence-like lines as headings', () => {
    expect(couldBeHeading('over them. By not committing your affections, they will only try harder to win you over')).toBe(false);
    expect(couldBeHeading('mit to any side or cause but yourself. By maintaining your')).toBe(false);
    expect(couldBeHeading('It is the fool who always rushes to')).toBe(false);
    expect(couldBeHeading('LAW 20')).toBe(true);
    expect(couldBeHeading('DO NOT COMMIT TO ANYONE')).toBe(true);
    expect(couldBeHeading('Chapter 1: The Road to the Market')).toBe(true);
  });
});
