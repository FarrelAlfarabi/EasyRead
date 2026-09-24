import { db, requestPersistence } from './db';
import { extractPage, getOutline, getTitle, openPdf } from './pdf';
import type { BookContent, BookMeta, OutlineItem, PageData } from './types';
import { OCR_LANGS } from './settings';

/* ---------------- tiny event bus ---------------- */

type Listener = (bookId?: string) => void;
const listeners = new Set<Listener>();
export function onLibraryChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function emitLibraryChange(bookId?: string): void {
  for (const l of listeners) l(bookId);
}

/* ---------------- reflow worker ---------------- */

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (c: BookContent) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/reflow.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: number; content?: BookContent; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.content) p.resolve(e.data.content);
    else p.reject(new Error(e.data.error ?? 'Reflow failed'));
  };
  return worker;
}

export function reflow(pages: PageData[], outline: OutlineItem[]): Promise<BookContent> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, pages, outline });
  });
}

let rebuildChain: Promise<unknown> = Promise.resolve();

/** Rebuild the reflowed content from stored pages. Serialized so writes never race. */
export function rebuildBook(bookId: string): Promise<BookContent | undefined> {
  const run = rebuildChain.then(async () => {
    const book = await db.getBook(bookId);
    if (!book) return undefined;
    const pages = await db.getPages(bookId);
    const content = await reflow(pages, book.outline);
    await db.putContent(bookId, content);
    emitLibraryChange(bookId);
    return content;
  });
  rebuildChain = run.catch(() => undefined);
  return run;
}

/* ---------------- import ---------------- */

export class ImportError extends Error {}

export interface ImportProgress {
  stage: 'reading' | 'text' | 'layout';
  done: number;
  total: number;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

export async function importPdf(file: File, ocrLang: string, onProgress: (p: ImportProgress) => void): Promise<BookMeta> {
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) throw new ImportError('That file is not a PDF.');
  requestPersistence();
  onProgress({ stage: 'reading', done: 0, total: 1 });
  const buf = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await openPdf(buf.slice(0));
  } catch (e) {
    const msg = String(e);
    if (/password/i.test(msg)) throw new ImportError('This PDF is password protected. Remove the password and try again.');
    throw new ImportError('Could not open this PDF. The file may be damaged.');
  }

  const total = pdf.numPages;
  const pages: PageData[] = [];
  for (let n = 1; n <= total; n++) {
    try {
      pages.push(await extractPage(pdf, n));
    } catch {
      pages.push({ page: n, width: 600, height: 800, source: 'pending', lines: [] });
    }
    if (n % 5 === 0 || n === total) onProgress({ stage: 'text', done: n, total });
  }
  const outline = await getOutline(pdf);
  const title = await getTitle(pdf, file.name);
  await pdf.loadingTask.destroy();

  const needOcr = pages.filter((p) => p.source === 'pending').length;
  const id = newId();
  const lang = OCR_LANGS.find((l) => l.code === ocrLang)?.html ?? 'en';
  const book: BookMeta = {
    id,
    title,
    fileName: file.name,
    pageCount: total,
    addedAt: Date.now(),
    lastReadAt: 0,
    progress: 0,
    position: 0,
    bookmarks: [],
    status: needOcr ? 'ocr' : 'ready',
    ocr: needOcr ? { lang: ocrLang, done: 0, total: needOcr, paused: false } : undefined,
    lang: needOcr ? lang : 'en',
    outline,
  };

  onProgress({ stage: 'layout', done: 0, total: 1 });
  const content = await reflow(pages, outline);
  await db.putPages(id, pages);
  if (needOcr) await db.putFile(id, new Blob([buf], { type: 'application/pdf' }));
  await db.putContent(id, content);
  await db.putBook(book);
  emitLibraryChange(id);
  return book;
}

export async function deleteBook(id: string): Promise<void> {
  await db.deleteBook(id);
  emitLibraryChange(id);
}
