/**
 * Sentence and word boundaries in plain text, used by text-to-speech (read sentence by
 * sentence, highlighting each) and by the last-read marker (tap a word).
 */

export interface Span {
  start: number;
  end: number;
}

// Abbreviations whose trailing period does not end a sentence (lowercase, no dot).
const ABBREVIATIONS = new Set(
  (
    'mr mrs ms dr prof sr jr st mt ft vs etc eg ie cf al approx dept est inc ltd co corp no nos vol vols ed eds p pp ch fig figs ' +
    'jan feb mar apr jun jul aug sep sept oct nov dec mon tue wed thu fri sat sun gen col capt lt sgt rev hon messrs mme mlle ' +
    'dll dsb tsb dkk yth'
  ).split(' '),
);

const CLOSERS = `"'”’»)]`;
const OPENERS = `"'“‘«(\\[`;

/** Split text into sentences. Handles "Mr.", "e.g.", initials ("J. R. R."), decimals, ellipses and closing quotes. */
export function splitSentences(text: string): Span[] {
  const out: Span[] = [];
  let start = 0;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      // Absorb runs like "?!" or "..." and closing quotes/brackets.
      let j = i + 1;
      while (j < n && /[.!?…]/.test(text[j])) j++;
      while (j < n && CLOSERS.includes(text[j])) j++;
      const next = text.slice(j).match(/^\s+(\S)/);
      const atEnd = j >= n || /^\s*$/.test(text.slice(j));
      let ends = atEnd;
      if (!atEnd && next) {
        const nextCh = next[1];
        const startsNew = /[\p{Lu}\p{N}]/u.test(nextCh) || OPENERS.includes(nextCh);
        ends = startsNew;
        if (ends && ch === '.') {
          // The word before the period.
          const before = text.slice(start, i).match(/([\p{L}.]+)$/u)?.[1] ?? '';
          const word = before.replace(/\./g, '').toLowerCase();
          if (ABBREVIATIONS.has(word)) ends = false;
          // Single-letter initials: "J. Smith", "U.S. Army".
          else if (/^\p{L}$/u.test(word) || /^(\p{L}\.)+\p{L}$/u.test(before)) ends = false;
        }
      }
      if (ends) {
        out.push({ start, end: j });
        i = j;
        while (i < n && /\s/.test(text[i])) i++;
        start = i;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  if (start < n && text.slice(start).trim()) out.push({ start, end: n });
  return trimSpans(text, out);
}

function trimSpans(text: string, spans: Span[]): Span[] {
  return spans
    .map(({ start, end }) => {
      while (start < end && /\s/.test(text[start])) start++;
      while (end > start && /\s/.test(text[end - 1])) end--;
      return { start, end };
    })
    .filter((s) => s.end > s.start);
}

/** The word around character `offset` (letters, digits, apostrophes and inner hyphens). */
export function wordAt(text: string, offset: number): Span | null {
  const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}'’-]/u.test(c);
  let i = Math.min(Math.max(0, offset), text.length);
  if (!isWord(text[i]) && isWord(text[i - 1])) i--;
  if (!isWord(text[i])) return null;
  let s = i;
  let e = i;
  while (s > 0 && isWord(text[s - 1])) s--;
  while (e < text.length && isWord(text[e])) e++;
  // Trim apostrophes/hyphens at the edges ("'Hello" -> "Hello").
  while (s < e && /['’-]/.test(text[s])) s++;
  while (e > s && /['’-]/.test(text[e - 1])) e--;
  return e > s ? { start: s, end: e } : null;
}

/** The sentence containing `offset`. */
export function sentenceAt(text: string, offset: number): Span | null {
  for (const s of splitSentences(text)) if (offset >= s.start && offset < s.end) return s;
  return null;
}
