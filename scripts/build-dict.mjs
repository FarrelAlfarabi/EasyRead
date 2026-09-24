// Builds public/dict/en-words.txt: common English words, most frequent first, one per line.
// Used only by the on-device OCR fallback to repair obvious OCR mistakes. Source: the
// SUBTLEX-US word frequency list (subtlex-word-frequencies, ISC).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const src = join(dirname(require.resolve('subtlex-word-frequencies/package.json')), 'index.json');
const list = JSON.parse(readFileSync(src, 'utf8'));
const counts = new Map();
for (const { word, count } of list) {
  const w = word.toLowerCase();
  if (!/^[a-z]+$/.test(w)) continue;
  if (w.length === 1 && w !== 'a' && w !== 'i') continue;
  counts.set(w, (counts.get(w) ?? 0) + count);
}
const MAX = 60000;
const words = [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, MAX).map(([w]) => w);
const out = join(dirname(new URL(import.meta.url).pathname), '..', 'public', 'dict');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'en-words.txt'), words.join('\n') + '\n');
console.log(`English word list written (${words.length} words)`);
