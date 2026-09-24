import type { Worker as TessWorker } from 'tesseract.js';
import { db } from './db';
import { GeminiOcrError, geminiBlocksToLines, geminiOcrPage } from './geminiOcr';
import { emitLibraryChange, rebuildBook } from './library';
import { ocrToLines, type OcrBlockLike } from './ocrLines';
import { ocrScale, openPdf, renderPage } from './pdf';
import { OCR_LANGS } from './settings';
import type { PageData } from './types';

export interface OcrStatus {
  bookId: string | null;
  state: 'idle' | 'loading' | 'running' | 'paused' | 'error';
  done: number;
  total: number;
  secPerPage: number | null;
  message: string;
  /** Pages in this run that had to fall back to the on-device reader. */
  fallbackPages: number;
}

let status: OcrStatus = { bookId: null, state: 'idle', done: 0, total: 0, secPerPage: null, message: '', fallbackPages: 0 };
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
// Gemini page requests in flight at once. A big book must not fire hundreds of parallel
// requests, and Gemini's own per-key rate limit would just turn extra concurrency into 429s.
const GEMINI_CONCURRENCY = 3;
// After this many Gemini failures in a row, stop trying it for the rest of this run and use
// the on-device reader for every remaining page, so a full Gemini outage does not turn into a
// 20-second wait per page for a long book.
const GEMINI_CIRCUIT_BREAKER = 4;

let runId = 0;
let pauseRequested = false;
let cancelRequested = false;
const queue: string[] = [];

async function persistOcr(bookId: string, patch: { done?: number; paused?: boolean; secPerPage?: number; fallbackPages?: number; geminiDown?: boolean }) {
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
  set({ message: 'Pausing after the pages in progress finish...' });
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

/* ---------------- Tesseract (fallback) ---------------- */

let tess: TessWorker | null = null;
let tessLoading: Promise<TessWorker> | null = null;

/** Tesseract is only spun up the first time a page actually needs the fallback. */
async function getTesseract(lang: string): Promise<TessWorker> {
  if (tess) return tess;
  if (!tessLoading) {
    const langs = lang.split('+');
    const bundled = langs.every((l) => BUNDLED_LANGS.includes(l));
    tessLoading = (async () => {
      const { createWorker } = await import('tesseract.js');
      // OEM 1 = LSTM engine only (with the "best" integer model for bundled languages).
      const w = await createWorker(langs, 1, {
        // Engine files are served from this site (see scripts/copy-tesseract.mjs).
        workerPath: '/tesseract/worker.min.js',
        corePath: '/tesseract/',
        workerBlobURL: false,
        // Language data is downloaded once per language, then cached in IndexedDB.
        cacheMethod: 'write',
        langPath: bundled ? '/tesseract/lang' : undefined,
      });
      // PSM 3 (fully automatic layout) read book pages best in testing; the library default
      // (6, one uniform block) mangled headings and indented paragraphs on degraded scans.
      await w.setParameters({ tessedit_pageseg_mode: '3' as never });
      tess = w;
      return w;
    })();
  }
  return tessLoading;
}

async function terminateTesseract() {
  prepWorker?.terminate();
  prepWorker = null;
  for (const p of prepPending.values()) p.reject(new Error('stopped'));
  prepPending.clear();
  const w = tess;
  tess = null;
  tessLoading = null;
  if (w) await w.terminate().catch(() => undefined);
}

/* Image cleanup and OCR text repair run in their own worker so the page stays responsive. */
let prepWorker: Worker | null = null;
let prepSeq = 0;
const prepPending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
function callPrep<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  if (!prepWorker) {
    prepWorker = new Worker(new URL('../workers/preprocess.worker.ts', import.meta.url), { type: 'module' });
    prepWorker.onmessage = (e: MessageEvent<{ id: number; error?: string } & Record<string, unknown>>) => {
      const p = prepPending.get(e.data.id);
      if (!p) return;
      prepPending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data);
    };
  }
  const id = ++prepSeq;
  const worker = prepWorker;
  return new Promise<T>((resolve, reject) => {
    prepPending.set(id, { resolve: resolve as (r: Record<string, unknown>) => void, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

/** Keep only what ocrToLines needs from Tesseract's (large) result before sending it to the worker. */
function slimBlocks(blocks: unknown): OcrBlockLike[] {
  const bs = (blocks ?? []) as Array<{ paragraphs: Array<{ lines: Array<OcrBlockLike['paragraphs'][number]['lines'][number]> }> }>;
  return bs.map((b) => ({
    paragraphs: b.paragraphs.map((p) => ({
      lines: p.lines.map((l) => ({
        text: l.text,
        confidence: l.confidence,
        bbox: l.bbox,
        words: (l.words ?? []).map((w) => ({ text: w.text, confidence: w.confidence, bbox: w.bbox })),
      })),
    })),
  }));
}

/** Set localStorage "easyread:debugOcr" = "1" to keep the last cleaned page image for inspection. */
function debugOcr(): boolean {
  try {
    return localStorage.getItem('easyread:debugOcr') === '1';
  } catch {
    return false;
  }
}

// One fallback page at a time: 300 DPI canvases are large, and Tesseract has one worker anyway.
let tessLock: Promise<unknown> = Promise.resolve();

async function tesseractPage(pdf: Awaited<ReturnType<typeof openPdf>>, page: number, lang: string) {
  const run = tessLock.then(async () => {
    const worker = await getTesseract(lang);
    const t0 = performance.now();
    const { canvas, scale } = await renderPage(pdf, page, 0, ocrScale);
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        try {
          if (debugOcr()) (window as unknown as { __easyreadLastOcrRaw?: string }).__easyreadLastOcrRaw = canvas.toDataURL('image/png');
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const buf = img.data.buffer as ArrayBuffer;
          const { buffer, skewDegrees, ms } = await callPrep<{ buffer: ArrayBuffer; skewDegrees: number; ms: number }>(
            { kind: 'image', buffer: buf, width: img.width, height: img.height },
            [buf],
          );
          ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer), canvas.width, canvas.height), 0, 0);
          lastPrep = { ms, skewDegrees };
        } catch (e) {
          // Cleanup is an improvement, not a requirement: OCR the raw render if it fails.
          console.warn('OCR image cleanup failed, using the raw page:', e);
        }
      }
      if (debugOcr()) (window as unknown as { __easyreadLastOcrImage?: string }).__easyreadLastOcrImage = canvas.toDataURL('image/png');
      const t1 = performance.now();
      const res = await worker.recognize(canvas, { user_defined_dpi: String(Math.round(scale * 72)) } as never, { blocks: true, text: false });
      const t2 = performance.now();
      let lines: PageData['lines'];
      try {
        ({ lines } = await callPrep<{ lines: PageData['lines'] }>({ kind: 'lines', blocks: slimBlocks(res.data.blocks), scale, english: lang === 'eng' }));
      } catch {
        lines = ocrToLines(res.data.blocks as unknown as OcrBlockLike[], scale);
      }
      const t3 = performance.now();
      lastTimings = { renderAndPrepMs: t1 - t0, ocrMs: t2 - t1, cleanupMs: t3 - t2 };
      return lines;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  });
  tessLock = run.catch(() => undefined);
  return run;
}

/** Timings of the most recent fallback page, for diagnostics and tests. */
export let lastTimings: { renderAndPrepMs: number; ocrMs: number; cleanupMs: number } | null = null;
export let lastPrep: { ms: number; skewDegrees: number } | null = null;
if (typeof window !== 'undefined') {
  (window as unknown as { __easyreadOcrStats?: () => unknown }).__easyreadOcrStats = () => ({ lastTimings, lastPrep });
}

/* ---------------- one page: Gemini, falling back to Tesseract ---------------- */

interface PageResult {
  page: number;
  lines: PageData['lines'];
  usedFallback: boolean;
}

async function readPage(
  pdf: Awaited<ReturnType<typeof openPdf>>,
  page: number,
  pageWidth: number,
  lang: string,
  geminiAvailable: () => boolean,
  onGeminiResult: (ok: boolean) => void,
): Promise<PageResult> {
  if (geminiAvailable()) {
    const { canvas } = await renderPage(pdf, page, 1600);
    const languageLabel = OCR_LANGS.find((l) => l.code === lang)?.label;
    try {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const blocks = await geminiOcrPage(canvas, languageLabel ?? 'auto');
          onGeminiResult(true);
          return { page, lines: geminiBlocksToLines(blocks, pageWidth), usedFallback: false };
        } catch (e) {
          lastErr = e;
          // One short backoff-and-retry for transient errors (rate limit, timeout, 5xx)
          // before giving up on Gemini for this page and using the on-device reader.
          if (e instanceof GeminiOcrError && e.retryable && attempt === 0) {
            await new Promise((r) => setTimeout(r, 600 + Math.random() * 600));
            continue;
          }
          break;
        }
      }
      onGeminiResult(false);
      console.warn(`Gemini OCR failed on page ${page}, using on-device reader instead:`, lastErr instanceof Error ? lastErr.message : lastErr);
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  const lines = await tesseractPage(pdf, page, lang);
  return { page, lines, usedFallback: true };
}

/** Runs async tasks with at most `limit` in flight, in the given order, stopping if `shouldStop` returns true. */
async function runPool<T>(items: T[], limit: number, shouldStop: () => boolean, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const lane = async () => {
    while (i < items.length) {
      if (shouldStop()) return;
      const item = items[i++];
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

async function run(bookId: string, my: number) {
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
    let fallbackPages = book.ocr.fallbackPages ?? 0;
    let geminiDown = book.ocr.geminiDown ?? false;
    set({ bookId, state: 'running', done, total, secPerPage: book.ocr.secPerPage ?? null, fallbackPages, message: '' });
    void keepAwake(true);

    const pdf = await openPdf(await file.arrayBuffer());

    let spp = book.ocr.secPerPage ?? 0;
    let sinceRebuild = 0;
    let consecutiveGeminiFailures = 0;
    let stopping = false;
    const writeLock: Promise<void>[] = [];

    const stalePage = async () => my !== runId || cancelRequested || pauseRequested || !(await db.getBook(bookId));

    await runPool(
      todo,
      GEMINI_CONCURRENCY,
      () => stopping,
      async (p) => {
        if (await stalePage()) {
          stopping = true;
          return;
        }
        const t0 = performance.now();
        const result = await readPage(
          pdf,
          p.page,
          p.width,
          book.ocr!.lang,
          () => !geminiDown,
          (ok) => {
            consecutiveGeminiFailures = ok ? 0 : consecutiveGeminiFailures + 1;
            if (!ok && consecutiveGeminiFailures >= GEMINI_CIRCUIT_BREAKER && !geminiDown) {
              geminiDown = true;
              set({ message: 'Gemini OCR is unavailable right now. Using the on-device reader for the rest of this book (slower, but it will finish).' });
            }
          },
        );
        if (my !== runId) return;
        if (result.usedFallback) fallbackPages++;
        // Serialize DB writes: page tasks finish in parallel, but IndexedDB updates must not race.
        const prevWrite = writeLock.length ? writeLock[writeLock.length - 1] : Promise.resolve();
        const thisWrite = prevWrite.then(async () => {
          await db.putPages(bookId, [{ ...p, source: result.usedFallback ? 'ocr' : 'gemini', lines: result.lines }]);
          done++;
          const secs = (performance.now() - t0) / 1000;
          spp = spp ? spp * 0.85 + secs * 0.15 : secs;
          await persistOcr(bookId, { done, secPerPage: spp, fallbackPages, geminiDown });
          set({ done, secPerPage: spp, fallbackPages });
          sinceRebuild++;
          if (done <= 3 || sinceRebuild >= 4) {
            sinceRebuild = 0;
            await rebuildBook(bookId);
          }
        });
        writeLock.push(thisWrite);
        await thisWrite;
      },
    );
    await Promise.all(writeLock);
    await pdf.loadingTask.destroy();

    if (my !== runId) return;
    if (cancelRequested) {
      cancelRequested = false;
      await finishCancel(bookId);
    } else if (pauseRequested) {
      await persistOcr(bookId, { paused: true, done, fallbackPages, geminiDown });
      set({ state: 'paused', message: '' });
      await rebuildBook(bookId);
    } else {
      await db.updateBook(bookId, { status: 'ready', ocr: undefined });
      await db.deleteFile(bookId);
      await rebuildBook(bookId);
      set({ bookId: null, state: 'idle', message: '' });
    }
  } catch (e) {
    console.error(e);
    set({ state: 'error', message: `Scanning stopped: ${e instanceof Error ? e.message : String(e)}. Check your connection and try again.` });
    await persistOcr(bookId, { paused: true }).catch(() => undefined);
  } finally {
    pauseRequested = false;
    await terminateTesseract();
    void keepAwake(false);
    emitLibraryChange(bookId);
    const next = queue.shift();
    if (next && (status.state === 'idle' || status.state === 'paused')) void startOcr(next);
  }
}
