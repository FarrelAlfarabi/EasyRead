import type { BookContent, BookMeta, HighlightColor } from './types';

export const HL_COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink'];

export const pctOf = (content: BookContent, block: number) => Math.round((content.charIndex[block] / (content.charIndex[content.charIndex.length - 1] || 1)) * 100);

/** Quotes and notes as plain text, for copy / share / download. */
export function exportNotes(book: BookMeta, content: BookContent): string {
  const lines = [`${book.title}${book.author ? ` by ${book.author}` : ''}`, ''];
  for (const h of [...(book.highlights ?? [])].sort((a, b) => a.block - b.block || a.start - b.start)) {
    lines.push(`"${h.text}" (${pctOf(content, h.block)}%)`);
    if (h.note) lines.push(`Note: ${h.note}`);
    lines.push('');
  }
  return lines.join('\n');
}

export interface SearchHit {
  block: number;
  start: number;
  end: number;
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function searchBook(content: BookContent, query: string, limit = 300): SearchHit[] {
  const q = fold(query.trim());
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  content.blocks.forEach((b, i) => {
    if (hits.length >= limit || !b.text) return;
    // NFD folding keeps string length for Latin text in practice; clamp just in case.
    const t = fold(b.text);
    let from = 0;
    for (;;) {
      const k = t.indexOf(q, from);
      if (k < 0 || hits.length >= limit) break;
      hits.push({ block: i, start: Math.min(k, b.text.length), end: Math.min(k + query.trim().length, b.text.length) });
      from = k + q.length;
    }
  });
  return hits;
}

