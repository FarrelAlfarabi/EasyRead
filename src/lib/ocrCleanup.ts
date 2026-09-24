/**
 * Post-OCR cleanup for the on-device (Tesseract) fallback, English only.
 *
 * Repairs obvious OCR mistakes using a word-frequency list, and only when the fix is
 * unambiguous:
 *  - merged words:   "thefool" -> "the fool", "Ifyou" -> "If you"
 *  - look-alike glyphs: "commil" -> "commit", "tfwy" -> "they"
 * Capitalized words (likely names) are never respelled, only split off a leading
 * function word. Words the list already knows are never touched.
 */

export type WordRanks = Map<string, number>;

/** Parse the one-word-per-line list (most frequent first) into word -> rank (0 = most common). */
export function loadWordRanks(text: string): WordRanks {
  const m: WordRanks = new Map();
  let i = 0;
  for (const w of text.split('\n')) {
    const t = w.trim();
    if (t && !m.has(t)) m.set(t, i++);
  }
  return m;
}

// Short words that are very often glued to the next word by OCR.
const FUNCTION_WORDS = new Set(
  'a an the of to in on at by for from with and or but if as is it its be he she we you they i me my his her our your their them this that was were are am not no so do did has had have will would can could all any'.split(' '),
);

// Pairs of letters that look alike when a scan is blurry. Substituting one for the other
// is "cheap" in the edit distance below.
const SIMILAR = new Set<string>();
for (const [a, b] of ['li', 'lt', 'ij', 'ft', 'hb', 'hk', 'hf', 'ce', 'eo', 'oa', 'co', 'ae', 'un', 'uv', 'vy', 'nh', 'rn', 'gq', 'mn', 'ec', 'rt']) {
  SIMILAR.add(a + b);
  SIMILAR.add(b + a);
}
// Multi-letter confusions: what OCR read -> what was printed.
const MULTI: Array<[string, string]> = [
  ['rn', 'm'], ['m', 'rn'], ['cl', 'd'], ['d', 'cl'], ['li', 'h'], ['h', 'li'], ['ii', 'u'],
  ['vv', 'w'], ['w', 'vv'], ['ri', 'n'], ['in', 'm'], ['ni', 'm'], ['fi', 'h'],
];
const CHEAP = 0.4;
// Fast lookup of SIMILAR for ASCII letters (the dictionary is a-z only).
const SIM_TABLE = new Uint8Array(128 * 128);
for (const pair of SIMILAR) SIM_TABLE[pair.charCodeAt(0) * 128 + pair.charCodeAt(1)] = 1;

// MULTI grouped by the last letter of the OCR side, so the inner loop only checks rules that can apply.
const MULTI_BY_END = new Map<string, Array<[string, string]>>();
for (const r of MULTI) {
  const k = r[0][r[0].length - 1];
  if (!MULTI_BY_END.has(k)) MULTI_BY_END.set(k, []);
  MULTI_BY_END.get(k)!.push(r);
}
let dp = new Float64Array(32 * 32);

/** Weighted edit distance from OCR text `a` to dictionary word `b`, with cheap look-alike edits. */
export function ocrDistance(a: string, b: string, cap = 3): number {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > 2) return Infinity;
  const W = m + 1;
  if (dp.length < (n + 1) * W) dp = new Float64Array((n + 1) * W * 2);
  for (let i = 0; i <= n; i++) {
    let rowMin = Infinity;
    const rules = i > 0 ? MULTI_BY_END.get(a[i - 1]) : undefined;
    for (let j = 0; j <= m; j++) {
      let best: number;
      if (i === 0) best = j;
      else if (j === 0) best = i;
      else {
        const x = a.charCodeAt(i - 1);
        const y = b.charCodeAt(j - 1);
        const sub = x === y ? 0 : x < 128 && y < 128 && SIM_TABLE[x * 128 + y] ? CHEAP : 1;
        best = Math.min(dp[(i - 1) * W + j] + 1, dp[i * W + j - 1] + 1, dp[(i - 1) * W + j - 1] + sub);
        if (rules) {
          for (const [from, to] of rules) {
            if (i >= from.length && j >= to.length && a.startsWith(from, i - from.length) && b.startsWith(to, j - to.length)) {
              const c = dp[(i - from.length) * W + j - to.length] + CHEAP;
              if (c < best) best = c;
            }
          }
        }
      }
      dp[i * W + j] = best;
      if (best < rowMin) rowMin = best;
    }
    if (rowMin > cap) return Infinity;
  }
  return dp[n * W + m];
}

const isKnown = (w: string, dict: WordRanks) => dict.has(w.toLowerCase());

function matchCase(src: string, word: string): string {
  if (src.length > 1 && src === src.toUpperCase()) return word.toUpperCase();
  if (/^\p{Lu}/u.test(src)) return word[0].toUpperCase() + word.slice(1);
  return word;
}

/** Try to split a glued word into two known words. Returns null unless exactly one split works. */
export function splitGlued(core: string, dict: WordRanks, conf = 0): string | null {
  const lower = core.toLowerCase();
  const capitalized = /^\p{Lu}\p{Ll}+$/u.test(core);
  const found: string[] = [];
  for (let i = 1; i < lower.length; i++) {
    const a = lower.slice(0, i);
    const b = lower.slice(i);
    const ra = dict.get(a);
    const rb = dict.get(b);
    if (ra === undefined || rb === undefined) continue;
    const fnSplit = FUNCTION_WORDS.has(a) && (b.length >= 2 || FUNCTION_WORDS.has(b));
    // A capitalized word is only split off a leading function word ("Ifyou"), never
    // elsewhere, so names are left alone.
    if (capitalized && !fnSplit) continue;
    const bothCommon = a.length >= 3 && b.length >= 3 && ra < 3000 && rb < 3000 && conf < 90;
    const fnAfter = FUNCTION_WORDS.has(b) && a.length >= 3 && ra < 3000;
    if (fnSplit || bothCommon || fnAfter) found.push(`${core.slice(0, i)} ${core.slice(i)}`);
  }
  return found.length === 1 ? found[0] : null;
}

// Candidate words grouped by first letter and length, built once per dictionary.
const byFirst = new WeakMap<WordRanks, Map<string, Array<[string, number]>>>();
function bucket(dict: WordRanks): Map<string, Array<[string, number]>> {
  let b = byFirst.get(dict);
  if (!b) {
    b = new Map();
    for (const [w, r] of dict) {
      const k = w[0] + w.length;
      let arr = b.get(k);
      if (!arr) b.set(k, (arr = []));
      arr.push([w, r]);
    }
    byFirst.set(dict, b);
  }
  return b;
}
/** First letters a dictionary word may have if OCR read `c` as the first letter. */
function firstLetterOptions(word: string): string[] {
  const c = word[0];
  const out = new Set<string>([c]);
  for (const pair of SIMILAR) if (pair[0] === c) out.add(pair[1]);
  for (const [from, to] of MULTI) if (word.startsWith(from)) out.add(to[0]);
  return [...out];
}

/** Try to respell a lowercase word with look-alike glyph fixes. Returns null unless clearly best. */
const respellCache = new WeakMap<WordRanks, Map<string, string | null>>();

export function respell(core: string, dict: WordRanks, conf = 0): string | null {
  const lower = core.toLowerCase();
  if (lower.length < 3) return null;
  // Longer edits are only allowed for words Tesseract itself was unsure about.
  const maxCost = lower.length <= 3 ? CHEAP : conf < 75 ? (lower.length <= 5 ? 1.5 : 2) : 1;
  let cache = respellCache.get(dict);
  if (!cache) respellCache.set(dict, (cache = new Map()));
  const key = `${maxCost}|${lower}`;
  if (cache.has(key)) {
    const hit = cache.get(key) ?? null;
    return hit && matchCase(core, hit);
  }
  const found = respellUncached(lower, dict, maxCost);
  cache.set(key, found);
  return found && matchCase(core, found);
}

function respellUncached(lower: string, dict: WordRanks, maxCost: number): string | null {
  // Rivals are gathered with a wider net than the fix itself may use, so a close but
  // pricier alternative ("litle": "title" vs "little") makes the word count as ambiguous.
  const window = maxCost + 1;
  const cands: Array<{ w: string; cost: number; score: number }> = [];
  const groups = bucket(dict);
  for (const f of firstLetterOptions(lower)) {
    for (let len = Math.max(1, lower.length - 2); len <= lower.length + 2; len++) {
    for (const [w, rank] of groups.get(f + len) ?? []) {
      const cost = ocrDistance(lower, w, window);
      if (cost > window) continue;
      // Expensive fixes must land on a common word.
      if (cost > 1 && rank > 5000) continue;
      // Edit cost plus a small preference for common words (Zipf: log rank ~ -log frequency).
      cands.push({ w, cost, score: cost + 0.5 * Math.log10(rank + 1) });
    }
    }
  }
  if (!cands.length) return null;
  cands.sort((x, y) => x.score - y.score);
  const best = cands[0];
  if (best.cost > maxCost) return null;
  const rival = cands[1];
  if (rival && rival.score - best.score < 0.4) return null;
  return best.w;
}

const EDGE_PUNCT = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u;

/** Repair one OCR token. `conf` is Tesseract's 0-100 confidence for it. */
export function repairToken(token: string, dict: WordRanks, conf = 0): string {
  const m = EDGE_PUNCT.exec(token);
  if (!m) return token;
  const [, pre, core, post] = m;
  if (!core || !/^\p{L}+$/u.test(core) || core.length < 3) return token;
  if (isKnown(core, dict)) return token;
  if (core.length > 1 && core === core.toUpperCase()) return token; // acronyms, shouting
  const split = splitGlued(core, dict, conf);
  if (split) return pre + split + post;
  if (/^\p{Lu}/u.test(core)) return token; // likely a name: never respell
  if (conf >= 80) return token;
  const fixed = respell(core, dict, conf);
  return fixed ? pre + fixed + post : token;
}

/** Tokens that are only stray marks: lone quotes, ticks, bars and similar specks. */
export function isStrayMark(token: string): boolean {
  return /^[‘’'"“”`´,.;:|\\/_~^*•·°¦¡!]+$/u.test(token) && token !== '...';
}

/** Share of word-like tokens (2+ letters) that are real words. */
export function dictionaryRatio(tokens: string[], dict: WordRanks): number {
  let words = 0;
  let known = 0;
  for (const t of tokens) {
    const core = t.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    if (core.length < 2 || !/^\p{L}+$/u.test(core)) continue;
    words++;
    if (isKnown(core, dict)) known++;
  }
  return words ? known / words : 1;
}

/* ------------------------------------------------------------------ */
/* Line-level repair for OCR text (scanner text layers and Tesseract)   */
/* ------------------------------------------------------------------ */

const lettersOnly = (t: string) => t.replace(/[^\p{L}]/gu, '');

/**
 * Split a run of letters with no spaces into the most likely words ("DONOTCOMMIT" ->
 * "DO NOT COMMIT"). Dynamic programming over word costs: common words are cheap, and
 * each extra word costs a little so real long words win over fragments.
 * Returns null if some part cannot be covered by known words.
 */
export function segmentWords(run: string, dict: WordRanks): string | null {
  const s = run.toLowerCase();
  const n = s.length;
  if (!n || n > 80) return null;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const back = new Int32Array(n + 1).fill(-1);
  cost[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(0, i - 20); j < i; j++) {
      if (cost[j] === Infinity) continue;
      const w = s.slice(j, i);
      const r = dict.get(w);
      if (r === undefined) continue;
      // Single letters other than "a"/"i" are almost never right in a heading.
      if (w.length === 1 && w !== 'a' && w !== 'i') continue;
      const c = cost[j] + 1 + Math.log10(r + 1) * 0.6;
      if (c < cost[i]) { cost[i] = c; back[i] = j; }
    }
  }
  if (cost[n] === Infinity) return null;
  const parts: string[] = [];
  for (let i = n; i > 0; i = back[i]) parts.unshift(run.slice(back[i], i));
  return parts.join(' ');
}

/**
 * Undo letter-spaced type: "J U D GM ENT" -> "JUDGMENT", "D O N OT C OM MIT TO ANYONE"
 * -> "DO NOT COMMIT TO ANYONE", "2 0" -> "20". A run is a stretch of 3+ tokens made of
 * short letter groups (1-4 letters) with at least 2 lone letters (other than "a"/"I").
 */
export function collapseLetterSpacing(text: string, dict?: WordRanks): string {
  const toks = text.split(' ');
  const out: string[] = [];
  let i = 0;
  // Letter-spaced digits: "2 0" -> "20".
  const digitRun = (k: number) => {
    let j = k;
    while (j < toks.length && /^\d[:.,)]?$/.test(toks[j])) j++;
    return j;
  };
  while (i < toks.length) {
    const dj = digitRun(i);
    if (dj - i >= 2) {
      out.push(toks.slice(i, dj).join(''));
      i = dj;
      continue;
    }
    let j = i;
    let short = 0;
    while (j < toks.length) {
      const core = toks[j].replace(/[:,.;!?]+$/u, '');
      if (!/^\p{L}{1,4}$/u.test(core)) break;
      // Count lone letters, but not the real one-letter words "a" and "I".
      if (core.length === 1 && !/^[aAI]$/.test(core)) short++;
      j++;
      if (/[:,.;!?]$/.test(toks[j - 1])) break; // punctuation ends the run
    }
    if (j - i >= 3 && short >= 2) {
      const run = toks.slice(i, j);
      const tail = (run[run.length - 1].match(/[:,.;!?]+$/u) ?? [''])[0];
      const joined = run.map(lettersOnly).join('');
      const seg = dict ? segmentWords(joined, dict) : null;
      // Without a dictionary only rejoin pure one-letter spacing ("L A W").
      if (seg) out.push(seg + tail);
      else if (run.every((t) => lettersOnly(t).length === 1)) out.push(joined + tail);
      else out.push(...run);
      i = j;
      continue;
    }
    out.push(toks[i]);
    i++;
  }
  return out.join(' ');
}

/**
 * Rejoin words broken by OCR: "at—tention" -> "attention" (a dash inside a word where the
 * pieces are not both words but the join is), and "Par liament" -> "Parliament" (two
 * non-words that make a word together).
 */
export function joinBrokenWords(text: string, dict: WordRanks): string {
  let toks = text.split(' ').map((t) => {
    const m = /^(\W*)(\p{L}+)[-–—]+(\p{L}+)(\W*)$/u.exec(t);
    if (!m) return t;
    const [, pre, a, b, post] = m;
    const joined = (a + b).toLowerCase();
    if (dict.has(joined) && !(dict.has(a.toLowerCase()) && dict.has(b.toLowerCase()) && a.length > 2 && b.length > 2)) return pre + a + b + post;
    return t;
  });
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const a = toks[i];
    const b = toks[i + 1];
    if (b !== undefined) {
      const ca = EDGE_PUNCT.exec(a);
      const cb = EDGE_PUNCT.exec(b);
      if (ca && cb && !ca[3] && !cb[1] && /^\p{L}+$/u.test(ca[2]) && /^\p{L}+$/u.test(cb[2])) {
        const la = ca[2].toLowerCase();
        const lb = cb[2].toLowerCase();
        const aKnown = dict.has(la) && (la.length > 1 || la === 'a' || la === 'i');
        const bKnown = dict.has(lb) && (lb.length > 1 || lb === 'a' || lb === 'i');
        if ((!aKnown || !bKnown) && dict.has(la + lb) && !(aKnown && bKnown)) {
          out.push(a + b);
          i++;
          continue;
        }
      }
    }
    out.push(a);
  }
  toks = out;
  return toks.join(' ');
}

/**
 * Full repair of one OCR'd line. `respellWords` turns on look-alike respelling, which is
 * only safe for text that really came from OCR (not a born-digital PDF).
 */
export function repairLine(text: string, dict: WordRanks | undefined, respellWords: boolean, conf = 60): string {
  let t = text.replace(/\s+/g, ' ').trim();
  t = collapseLetterSpacing(t, dict);
  if (!dict) return t;
  t = joinBrokenWords(t, dict);
  if (respellWords) t = t.split(' ').filter((w) => !isStrayMark(w)).map((w) => repairToken(w, dict, conf)).join(' ');
  return t;
}

export interface TextQuality {
  words: number;
  unknownRatio: number;
  letterSpaced: number;
  junkRatio: number;
}

/** How "OCR-broken" a page of text looks. */
export function textQuality(lines: string[], dict?: WordRanks): TextQuality {
  let words = 0;
  let unknown = 0;
  let letterSpaced = 0;
  let chars = 0;
  let junk = 0;
  for (const l of lines) {
    for (const ch of l) {
      if (ch === ' ') continue;
      chars++;
      if (!/[\p{L}\p{N}.,;:!?'"’“”()\-–—]/u.test(ch)) junk++;
    }
    const toks = l.split(/\s+/).filter(Boolean);
    const shortRun = toks.filter((t) => /^\p{L}{1,2}[:,.]?$/u.test(t)).length;
    if (toks.length >= 3 && shortRun >= 3 && shortRun / toks.length >= 0.4) letterSpaced++;
    if (dict) {
      for (const t of toks) {
        const core = t.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
        if (core.length < 3 || !/^\p{L}+$/u.test(core)) continue;
        words++;
        if (!dict.has(core.toLowerCase())) unknown++;
      }
    }
  }
  return { words, unknownRatio: words ? unknown / words : 0, letterSpaced, junkRatio: chars ? junk / chars : 0 };
}

/** True when a page's text layer is bad enough that re-reading the page image is worth it. */
export function isPoorText(q: TextQuality): boolean {
  return q.unknownRatio > 0.06 || q.letterSpaced >= 2 || q.junkRatio > 0.02;
}
