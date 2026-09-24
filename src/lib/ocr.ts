import type { Worker as TessWorker } from 'tesseract.js';
import { db } from './db';
import { emitLibraryChange, rebuildBook } from './library';
import { ocrToLines, type OcrBlockLike } from './ocrLines';
import { openPdf, renderPage } from './pdf';
import type { PageData } from './types';

export interface OcrStatus {
  bookId: string | null;
  state: 'idle' | 'loading' | 'running' | 'paused' | 'error';
  done: number;
  total: number;
  secPerPage: number | null;
  message: string;
}

let status: OcrStatus = { bookId: null, state: 'idle', done: 0, total: 0, secPerPage: null, message: '' };
const subs = new Set<() => void>();
function set(patch: Partial<OcrStatus>) {
  status = { ...status, ...patch };
  for (const s of subs) s();
}
export const ocrStore = {
  subscribe(fn: () => void) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
  get: () => status,
};

/* ---------------- wake lock ---------------- */

let wakeLock: { release: () => Promise<void> } | null = null;
async function keepAwake(on: boolean) {
  try {
    if (on && !wakeLock && document.visibilityState === 'visible') {
      const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
      wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      wakeLock = null; // the browser releases it when hidden
      if (status.state === 'running' || status.state === 'loading') void keepAwake(true);
    }
  });
}

export const wakeLockSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

/* ---------------- job control ---------------- */

const BUNDLED_LANGS = ['eng', 'ind'];
let runId = 0;
let pauseRequested = false;
let cancelRequested = false;
const queue: string[] = [];

async function persistOcr(bookId: string, patch: { done?: number; paused?: boolean; secPerPage?: number }) {
  const b = await db.getBook(bookId);
  if (!b?.ocr) return;
  await db.updateBook(bookId, { ocr: { ...b.ocr, ...patch } });
}

export async function startOcr(bookId: string): Promise<void> {
  if (status.bookId === bookId && (status.state === 'running' || status.state === 'loading')) return;
  if (status.state === 'running' || status.state === 'loading') {
    if (!queue.includes(bookId)) queue.push(bookId);
    return;
  }
  pauseRequested = false;
  cancelRequested = false;
  await persistOcr(bookId, { paused: false });
  const my = ++runId;
  void run(bookId, my);
}

export function pauseOcr(): void {
  if (status.state !== 'running' && status.state !== 'loading') return;
  pauseRequested = true;
  set({ message: 'Pausing after this page...' });
}

export async function cancelOcr(bookId: string): Promise<void> {
  const idx = queue.indexOf(bookId);
  if (idx >= 0) queue.splice(idx, 1);
  if (status.bookId === bookId && (status.state === 'running' || status.state === 'loading')) {
    cancelRequested = true;
    set({ message: 'Stopping...' });
    return;
  }
  await finishCancel(bookId);
}

async function finishCancel(bookId: string) {
  if (!(await db.getBook(bookId))) {
    if (status.bookId === bookId) set({ bookId: null, state: 'idle', message: '' });
    return;
  }
  const pages = await db.getPages(bookId);
  const rest = pages.filter((p) => p.source === 'pending').map((p): PageData => ({ ...p, source: 'skipped' }));
  if (rest.length) await db.putPages(bookId, rest);
  await db.updateBook(bookId, { status: 'ready', ocr: undefined });
  await db.deleteFile(bookId);
  if (status.bookId === bookId) set({ bookId: null, state: 'idle', message: '' });
  await rebuildBook(bookId);
}

/** Resume any scanning that was running when the tab was closed. */
export async function resumePendingOcr(): Promise<void> {
  try {
    const books = await db.listBooks();
    for (const b of books) if (b.status === 'ocr' && b.ocr && !b.ocr.paused) await startOcr(b.id);
  } catch {
    /* storage unavailable */
  }
}

async function run(bookId: string, my: number) {
  let tess: TessWorker | null = null;
  try {
    const book = await db.getBook(bookId);
    const file = await db.getFile(bookId);
    if (!book || !book.ocr || !file) {
      if (book && book.status === 'ocr') await db.updateBook(bookId, { status: 'ready', ocr: undefined });
      set({ bookId: null, state: 'idle' });
      return;
    }
    const pagesAll = await db.getPages(bookId);
    const todo = pagesAll.filter((p) => p.source === 'pending').sort((a, b) => a.page - b.page);
    const total = book.ocr.total;
    let done = total - todo.length;
    set({ bookId, state: 'loading', done, total, secPerPage: book.ocr.secPerPage ?? null, message: 'Getting the text reader ready. Language data downloads once.' });
    void keepAwake(true);

    const pdf = await openPdf(await file.arrayBuffer());
    const { createWorker } = await import('tesseract.js');
    const langs = book.ocr.lang.split('+');
    const bundled = langs.every((l) => BUNDLED_LANGS.includes(l));
    let fail: (e: unknown) => void = () => undefined;
    const failed = new Promise<never>((_, reject) => { fail = reject; });
    failed.catch(() => undefined);
    tess = await Promise.race([createWorker(langs, 1, {
      // Engine files are served from this site (see scripts/copy-tesseract.mjs).
      workerPath: '/tesseract/worker.min.js',
      corePath: '/tesseract/',
      workerBlobURL: false,
      // Language data is downloaded once per language, then cached in IndexedDB.
      cacheMethod: 'write',
      langPath: bundled ? '/tesseract/lang' : undefined,
      errorHandler: (e: unknown) => fail(e),
    }), failed]);
    set({ state: 'running', message: '' });

    let spp = book.ocr.secPerPage ?? 0;
    let sinceRebuild = 0;
    for (const p of todo) {
      if (my !== runId) return;
      if (!(await db.getBook(bookId))) {
        // Book was deleted while scanning.
        cancelRequested = false;
        set({ bookId: null, state: 'idle', message: '' });
        await pdf.loadingTask.destroy();
        return;
      }
      if (cancelRequested) break;
      if (pauseRequested) {
        await persistOcr(bookId, { paused: true, done });
        set({ state: 'paused', message: '' });
        break;
      }
      const t0 = performance.now();
      const { canvas, scale } = await renderPage(pdf, p.page);
      const res = await Promise.race([tess.recognize(canvas, {}, { blocks: true, text: false }), failed]);
      canvas.width = 0;
      canvas.height = 0;
      const lines = ocrToLines(res.data.blocks as unknown as OcrBlockLike[], scale);
      await db.putPages(bookId, [{ ...p, source: 'ocr', lines }]);
      done++;
      const secs = (performance.now() - t0) / 1000;
      spp = spp ? spp * 0.7 + secs * 0.3 : secs;
      await persistOcr(bookId, { done, secPerPage: spp });
      set({ done, secPerPage: spp });
      sinceRebuild++;
      if (done <= 3 || sinceRebuild >= 5) {
        sinceRebuild = 0;
        await rebuildBook(bookId);
      }
    }
    await pdf.loadingTask.destroy();

    if (cancelRequested) {
      cancelRequested = false;
      await finishCancel(bookId);
    } else if (status.state !== 'paused') {
      await db.updateBook(bookId, { status: 'ready', ocr: undefined });
      await db.deleteFile(bookId);
      await rebuildBook(bookId);
      set({ bookId: null, state: 'idle', message: '' });
    } else {
      await rebuildBook(bookId);
    }
  } catch (e) {
    console.error(e);
    set({ state: 'error', message: `Scanning stopped: ${e instanceof Error ? e.message : String(e)}. Check your connection (language data is downloaded the first time) and try again.` });
    await persistOcr(bookId, { paused: true }).catch(() => undefined);
  } finally {
    pauseRequested = false;
    if (tess) await tess.terminate().catch(() => undefined);
    void keepAwake(false);
    emitLibraryChange(bookId);
    const next = queue.shift();
    if (next && (status.state === 'idle' || status.state === 'paused')) void startOcr(next);
  }
}
