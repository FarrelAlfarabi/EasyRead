import { db, requestPersistence } from './db';
import { extractPage, getOutline, getTitle, openPdf, renderPage } from './pdf';
import type { BookContent, BookMeta, OutlineItem, PageData } from './types';
import { OCR_LANGS } from './settings';
import { isPoorText, loadWordRanks, textQuality, type WordRanks } from './ocrCleanup';

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

export function reflow(pages: PageData[], outline: OutlineItem[], english = true): Promise<BookContent> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, pages, outline, english });
  });
}

/** Word repair and quality checks use an English word list; skip them for other languages. */
export const isEnglishBook = (b: Pick<BookMeta, 'lang' | 'ocr'> & { ocrLang?: string }) =>
  (b.ocrLang ?? b.ocr?.lang ?? '') === 'eng' || (!b.ocrLang && !b.ocr && b.lang === 'en');

let dictPromise: Promise<WordRanks | undefined> | null = null;
function englishDict(): Promise<WordRanks | undefined> {
  if (!dictPromise) {
    dictPromise = fetch('/dict/en-words.txt')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(loadWordRanks)
      .catch(() => {
        dictPromise = null;
        return undefined;
      });
  }
  return dictPromise;
}

/**
 * Scanned pages that came with the scanner's own OCR text: if that text looks broken,
 * queue the page for re-reading (Gemini first). The old text stays as a stand-in until then,
 * and is used as the fallback if re-reading fails.
 */
async function flagPoorScannerText(pages: PageData[], english: boolean): Promise<PageData[]> {
  const dict = english ? await englishDict() : undefined;
  return pages.map((p) => {
    if (p.source !== 'text' || !p.ocrLayer || !p.lines.length) return p;
    return isPoorText(textQuality(p.lines.map((l) => l.text), dict)) ? { ...p, source: 'pending' } : p;
  });
}

let rebuildChain: Promise<unknown> = Promise.resolve();

/** Rebuild the reflowed content from stored pages. Serialized so writes never race. */
export function rebuildBook(bookId: string): Promise<BookContent | undefined> {
  const run = rebuildChain.then(async () => {
    const book = await db.getBook(bookId);
    if (!book) return undefined;
    if (book.format === 'epub') return db.getContent(bookId);
    const pages = await db.getPages(bookId);
    const content = await reflow(pages, book.outline, isEnglishBook(book));
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

/** PDF or EPUB, picked by file name / type. */
export async function importBook(file: File, ocrLang: string, onProgress: (p: ImportProgress) => void): Promise<BookMeta> {
  if (/epub/i.test(file.type) || /\.epub$/i.test(file.name)) return importEpub(file, onProgress);
  return importPdf(file, ocrLang, onProgress);
}

/** Approximate "pages" for a reflowable book: about 1500 characters per page. */
const approxPages = (c: BookContent) => Math.max(1, Math.ceil((c.charIndex[c.charIndex.length - 1] ?? 0) / 1500));

export async function importEpub(file: File, onProgress: (p: ImportProgress) => void = () => undefined, id = newId(), keep?: Partial<BookMeta>): Promise<BookMeta> {
  requestPersistence();
  onProgress({ stage: 'reading', done: 0, total: 1 });
  const buf = await file.arrayBuffer();
  const { parseEpub, EpubError } = await import('./epub');
  let parsed;
  try {
    parsed = await parseEpub(buf.slice(0));
  } catch (e) {
    if (e instanceof EpubError) throw new ImportError(e.message);
    console.error(e);
    throw new ImportError('Could not open this EPUB. The file may be damaged.');
  }
  onProgress({ stage: 'layout', done: 0, total: 1 });
  const resKey = (path: string) => `${id}:res:${path}`;
  for (const [path, r] of parsed.resources) await db.putFile(resKey(path), new Blob([r.data as BlobPart], { type: r.type }));
  const book: BookMeta = {
    id,
    title: parsed.title,
    author: parsed.author || undefined,
    format: 'epub',
    cover: parsed.cover && parsed.resources.has(parsed.cover) ? resKey(parsed.cover) : undefined,
    css: parsed.css || undefined,
    fileName: file.name,
    pageCount: approxPages(parsed.content),
    addedAt: Date.now(),
    lastReadAt: 0,
    progress: 0,
    position: 0,
    bookmarks: [],
    status: 'ready',
    lang: parsed.lang,
    outline: [],
    ...keep,
  };
  await db.putFile(id, new Blob([buf], { type: 'application/epub+zip' }));
  await db.putContent(id, parsed.content);
  await db.putBook(book);
  emitLibraryChange(id);
  return book;
}

/** Small first-page thumbnail for the library grid. */
async function savePdfCover(pdf: Awaited<ReturnType<typeof openPdf>>, id: string): Promise<string | undefined> {
  try {
    if (typeof document === 'undefined') return undefined;
    const { canvas } = await renderPage(pdf, 1, 0, (base) => 360 / base.width);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.8));
    canvas.width = 0;
    if (!blob) return undefined;
    await db.putFile(`${id}:cover`, blob);
    return `${id}:cover`;
  } catch {
    return undefined;
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
  const id = newId();
  const cover = await savePdfCover(pdf, id);
  await pdf.loadingTask.destroy();
  return saveImported(id, file.name, buf, pages, outline, title, ocrLang, onProgress, { cover });
}

async function saveImported(
  id: string,
  fileName: string,
  buf: ArrayBuffer,
  extracted: PageData[],
  outline: OutlineItem[],
  title: string,
  ocrLang: string,
  onProgress: (p: ImportProgress) => void,
  keep?: Partial<BookMeta>,
): Promise<BookMeta> {
  const english = ocrLang === 'eng';
  const pages = await flagPoorScannerText(extracted, english);
  const total = pages.length;
  const needOcr = pages.filter((p) => p.source === 'pending').length;
  const lang = OCR_LANGS.find((l) => l.code === ocrLang)?.html ?? 'en';
  const book: BookMeta = {
    id,
    title,
    fileName,
    pageCount: total,
    addedAt: Date.now(),
    lastReadAt: 0,
    progress: 0,
    position: 0,
    bookmarks: [],
    status: needOcr ? 'ocr' : 'ready',
    ocr: needOcr ? { lang: ocrLang, done: 0, total: needOcr, paused: false } : undefined,
    lang: needOcr || ocrLang !== 'eng' ? lang : 'en',
    outline,
    format: 'pdf',
    ...keep,
  };

  onProgress({ stage: 'layout', done: 0, total: 1 });
  const content = await reflow(pages, outline, english);
  if (keep?.progress) {
    // Re-processing: put the reader back at about the same place.
    const want = keep.progress * (content.charIndex[content.charIndex.length - 1] ?? 0);
    book.position = Math.max(0, content.charIndex.findIndex((c) => c > want) - 1);
  }
  await db.putPages(id, pages);
  // Keep the PDF so the book can be re-processed later (and scanned pages re-read).
  await db.putFile(id, new Blob([buf], { type: 'application/pdf' }));
  await db.putContent(id, content);
  await db.putBook(book);
  emitLibraryChange(id);
  return book;
}

/**
 * Run a saved book through the current conversion again, without re-uploading. With the
 * original PDF on file this re-extracts every page (and re-reads poor scanned pages);
 * older books imported before the PDF was kept are rebuilt from their stored text.
 */
export async function reprocessBook(id: string, ocrLang: string, onProgress: (p: ImportProgress) => void = () => undefined): Promise<BookMeta | undefined> {
  const book = await db.getBook(id);
  if (!book) return undefined;
  const lang = book.ocr?.lang ?? ocrLang;
  // Highlights and the last-read marker are tied to text positions, which change on re-processing.
  const keep: Partial<BookMeta> = {
    addedAt: book.addedAt,
    lastReadAt: book.lastReadAt,
    title: book.title,
    progress: book.progress,
    favorite: book.favorite,
    readingStatus: book.readingStatus,
    collections: book.collections,
    stats: book.stats,
  };
  const file = await db.getFile(id);
  if (file && book.format === 'epub') {
    await db.deleteBook(id);
    return importEpub(new File([file], book.fileName, { type: 'application/epub+zip' }), onProgress, id, keep);
  }
  if (file) {
    const buf = await file.arrayBuffer();
    const pdf = await openPdf(buf.slice(0));
    const pages: PageData[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      try {
        pages.push(await extractPage(pdf, n));
      } catch {
        pages.push({ page: n, width: 600, height: 800, source: 'pending', lines: [] });
      }
      if (n % 5 === 0 || n === pdf.numPages) onProgress({ stage: 'text', done: n, total: pdf.numPages });
    }
    const outline = await getOutline(pdf);
    await db.deleteBook(id);
    const cover = await savePdfCover(pdf, id);
    await pdf.loadingTask.destroy();
    return saveImported(id, book.fileName, buf, pages, outline, book.title, lang, onProgress, { ...keep, cover });
  }
  // No PDF kept: re-run layout and text repair on the stored text. Without the page images we
  // cannot tell scanner text from real text, so treat text that looks OCR-broken as scanner text.
  const english = lang === 'eng';
  const dict = english ? await englishDict() : undefined;
  const stored = await db.getPages(id);
  const pages = stored.map((p) => {
    if (p.source !== 'text' || !p.lines.length) return p;
    const looksScanned = isPoorText(textQuality(p.lines.map((l) => l.text), dict));
    return looksScanned ? { ...p, ocrLayer: true } : p;
  });
  onProgress({ stage: 'layout', done: 0, total: 1 });
  await db.putPages(id, pages);
  const content = await reflow(pages, book.outline, english);
  await db.putContent(id, content);
  await db.updateBook(id, { position: Math.min(book.position, Math.max(0, content.blocks.length - 1)) });
  emitLibraryChange(id);
  return db.getBook(id);
}

export async function deleteBook(id: string): Promise<void> {
  await db.deleteBook(id);
  emitLibraryChange(id);
}
