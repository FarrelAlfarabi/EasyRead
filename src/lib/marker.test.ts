import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { db } from './db';
import type { BookMeta } from './types';

const book = (id: string): BookMeta => ({
  id,
  title: 'T',
  fileName: 't.epub',
  pageCount: 1,
  addedAt: 1,
  lastReadAt: 0,
  progress: 0,
  position: 0,
  bookmarks: [],
  status: 'ready',
  lang: 'en',
  outline: [],
});

describe('last-read marker and annotations persistence', () => {
  it('saves, replaces and clears the marker per book', async () => {
    await db.putBook(book('a'));
    await db.putBook(book('b'));
    await db.updateBook('a', { marker: { block: 3, start: 10, end: 15, at: 1 } });
    expect((await db.getBook('a'))?.marker).toEqual({ block: 3, start: 10, end: 15, at: 1 });
    expect((await db.getBook('b'))?.marker).toBeUndefined();
    // Moving the marker replaces the old one.
    await db.updateBook('a', { marker: { block: 7, start: 0, end: 4, at: 2 } });
    expect((await db.getBook('a'))?.marker?.block).toBe(7);
    await db.updateBook('a', { marker: undefined });
    expect((await db.getBook('a'))?.marker).toBeUndefined();
  });

  it('keeps highlights with notes and removes book resources on delete', async () => {
    await db.putBook(book('c'));
    await db.updateBook('c', { highlights: [{ id: 'h1', block: 1, start: 0, end: 5, color: 'green', text: 'Hello', note: 'nice', createdAt: 1 }] });
    expect((await db.getBook('c'))?.highlights?.[0].note).toBe('nice');
    await db.putFile('c', new Blob(['x']));
    await db.putFile('c:res:OEBPS/a.png', new Blob(['y']));
    await db.putFile('cc:res:other.png', new Blob(['z']));
    await db.deleteBook('c');
    expect(await db.getBook('c')).toBeUndefined();
    expect(await db.getFile('c:res:OEBPS/a.png')).toBeUndefined();
    // Another book whose id starts the same way is untouched.
    expect(await db.getFile('cc:res:other.png')).toBeDefined();
  });
});
