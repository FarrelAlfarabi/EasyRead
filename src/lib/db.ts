import type { BookContent, BookMeta, PageData } from './types';

const DB_NAME = 'easyread';
const VERSION = 1;
const STORES = ['books', 'pages', 'content', 'files'] as const;
type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pages')) {
          const s = db.createObjectStore('pages', { keyPath: ['bookId', 'page'] });
          s.createIndex('bookId', 'bookId');
        }
        if (!db.objectStoreNames.contains('content')) db.createObjectStore('content');
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(stores: StoreName[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await open();
  const t = db.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Transaction aborted'));
  });
  const result = await fn(t);
  await done;
  return result;
}

export type StoredPage = PageData & { bookId: string };

export const db = {
  listBooks: () => tx(['books'], 'readonly', (t) => reqP(t.objectStore('books').getAll() as IDBRequest<BookMeta[]>)),
  getBook: (id: string) => tx(['books'], 'readonly', (t) => reqP(t.objectStore('books').get(id) as IDBRequest<BookMeta | undefined>)),
  putBook: (b: BookMeta) => tx(['books'], 'readwrite', (t) => { t.objectStore('books').put(b); }),
  async updateBook(id: string, patch: Partial<BookMeta>): Promise<BookMeta | undefined> {
    return tx(['books'], 'readwrite', async (t) => {
      const s = t.objectStore('books');
      const cur = (await reqP(s.get(id))) as BookMeta | undefined;
      if (!cur) return undefined;
      const next = { ...cur, ...patch };
      s.put(next);
      return next;
    });
  },
  getContent: (id: string) => tx(['content'], 'readonly', (t) => reqP(t.objectStore('content').get(id) as IDBRequest<BookContent | undefined>)),
  putContent: (id: string, c: BookContent) => tx(['content'], 'readwrite', (t) => { t.objectStore('content').put(c, id); }),
  putPages: (bookId: string, pages: PageData[]) =>
    tx(['pages'], 'readwrite', (t) => {
      const s = t.objectStore('pages');
      for (const p of pages) s.put({ ...p, bookId });
    }),
  getPages: (bookId: string) =>
    tx(['pages'], 'readonly', (t) => reqP(t.objectStore('pages').index('bookId').getAll(bookId) as IDBRequest<StoredPage[]>)),
  putFile: (id: string, data: Blob) => tx(['files'], 'readwrite', (t) => { t.objectStore('files').put(data, id); }),
  getFile: (id: string) => tx(['files'], 'readonly', (t) => reqP(t.objectStore('files').get(id) as IDBRequest<Blob | undefined>)),
  deleteFile: (id: string) => tx(['files'], 'readwrite', (t) => { t.objectStore('files').delete(id); }),
  deleteBook: (id: string) =>
    tx([...STORES], 'readwrite', (t) => {
      t.objectStore('books').delete(id);
      t.objectStore('content').delete(id);
      t.objectStore('files').delete(id);
      t.objectStore('pages').delete(IDBKeyRange.bound([id, -Infinity], [id, Infinity]));
    }),
};

/** Ask the browser not to evict our data. Ignored if unsupported. */
export function requestPersistence(): void {
  try {
    void navigator.storage?.persist?.();
  } catch {
    /* ignore */
  }
}
