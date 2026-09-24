import { describe, expect, it } from 'vitest';
import { sentenceAt, splitSentences, wordAt } from './sentences';

const sents = (t: string) => splitSentences(t).map((s) => t.slice(s.start, s.end));

describe('splitSentences', () => {
  it('splits ordinary sentences', () => {
    expect(sents('It was late. The lamp held! Did it? Yes.')).toEqual(['It was late.', 'The lamp held!', 'Did it?', 'Yes.']);
  });
  it('does not split after abbreviations, initials or decimals', () => {
    expect(sents('Mr. Hale met Dr. Moore at 3.5 miles, e.g. near St. Ives. They waved.')).toEqual([
      'Mr. Hale met Dr. Moore at 3.5 miles, e.g. near St. Ives.',
      'They waved.',
    ]);
    expect(sents('J. R. R. Tolkien wrote it. U.S. Army troops came.')).toEqual(['J. R. R. Tolkien wrote it.', 'U.S. Army troops came.']);
  });
  it('keeps closing quotes with the sentence and starts a new one at an opening quote', () => {
    expect(sents('"Will it last?" asked Dr. Moore. "It will." He smiled.')).toEqual(['"Will it last?" asked Dr. Moore.', '"It will."', 'He smiled.']);
    expect(sents('She said “stop.” Then she left.')).toEqual(['She said “stop.”', 'Then she left.']);
  });
  it('handles ellipses and lowercase continuations', () => {
    expect(sents('Wait... then what? nothing, he said.')).toEqual(['Wait... then what? nothing, he said.']);
    expect(sents('He paused… And then he ran.')).toEqual(['He paused…', 'And then he ran.']);
  });
  it('returns the tail without final punctuation', () => {
    expect(sents('One. Two without end')).toEqual(['One.', 'Two without end']);
  });
  it('finds the sentence at an offset', () => {
    const t = 'First one. Second one.';
    const s = sentenceAt(t, 14)!;
    expect(t.slice(s.start, s.end)).toBe('Second one.');
  });
});

describe('wordAt', () => {
  const w = (t: string, i: number) => {
    const r = wordAt(t, i);
    return r ? t.slice(r.start, r.end) : null;
  };
  it('finds the word under an offset, including apostrophes and inner hyphens', () => {
    expect(w('the keeper’s well-lit room.', 6)).toBe('keeper’s');
    expect(w('the keeper’s well-lit room.', 15)).toBe('well-lit');
    expect(w('"Hello," she said', 2)).toBe('Hello');
  });
  it('returns null on spaces and punctuation', () => {
    expect(w('a , b', 2)).toBeNull();
  });
  it('snaps to the word just before the caret at a word end', () => {
    expect(w('stormy night', 6)).toBe('stormy');
  });
});
