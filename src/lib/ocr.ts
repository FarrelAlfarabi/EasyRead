import type { Worker as TessWorker } from 'tesseract.js';
import { CloudOcrError, cloudBlocksToLines, cloudOcrPage, type CloudProvider } from './cloudOcr';
import { db } from './db';
import { emitLibraryChange, rebuildBook } from './library';
import { ocrToLines, type OcrBlockLike } from './ocrLines';
import { ocrScale, openPdf, renderPage } from './pdf';
import { OCR_LANGS } from './settings';
import type { PageData } from './types';

export interface OcrStatus {
  bookId: string | null;
  state: 'idle' | 'loading' | 'running' | 'paused' | 'needs-consent' | 'error';
  done: number;
  total: number;
  secPerPage: number | null;
  message: string;
  /** Pages read on-device this run. Only ever non-zero after the user explicitly agreed to it. */
  fallbackPages: number;
  /** Pages that could not be read by any cloud provider and are waiting on the user's choice. */
  needsConsent: number;
}

let status: OcrStatus = { bookId: null, state: 'idle', done: 0, total: 0, secPerPage: null, message: '', fallbackPages: 0, needsConsent: 0 };
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
// Cloud OCR requests in flight at once, per book. A big book must not fire hundreds of
// parallel requests, and each provider's own rate limit would just turn extra concurrency
// into more 429s. Gemini and Groq share this pool: each page tries one provider at a time.
const CLOUD_CONCURRENCY = 3;
// After this many failures in a row on a given provider, stop trying it for the rest of this
// run, so an outage does not turn into a long wait per page for a long book.
const CIRCUIT_BREAKER = 4;

let runId = 0;
let pauseRequested = false;
let cancelRequested = false;
const queue: string[] = [];

async function persistOcr(
  bookId: string,
  patch: { done?: number; paused?: boolean; secPerPage?: number; fallbackPages?: number; geminiDown?: boolean; groqDown?: boolean; needsConsent?: number; onDeviceConsent?: boolean },
) {
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

/**
 * The user explicitly agreed to read this book's cloud-unreadable pages on this device.
 * EasyRead never does this on its own: this is the only way on-device OCR ever runs.
 */
export async function enableOnDeviceOcr(bookId: string): Promise<void> {
  await persistOcr(bookId, { onDeviceConsent: true, needsConsent: 0, paused: false });
  await startOcr(bookId);
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
  if (status.bookId === bookId) set({ bookId: null, state: 'idle', message: '' });
  await rebuildBook(bookId);
}

/**
 * Resume any cloud OCR that was running when the tab was closed. This only ever retries the
 * cloud providers, never on-device OCR: a book stopped waiting on the user's consent
 * (needsConsent > 0) stays stopped until they choose "Use on-device OCR" or "Retry cloud".
 */
export async function resumePendingOcr(): Promise<void> {
  try {
    const books = await db.listBooks();
    for (const b of books) if (b.status === 'ocr' && b.ocr && !b.ocr.paused && !b.ocr.needsConsent) await startOcr(b.id);
  } catch {
    /* storage unavailable */
  }
}

/* ---------------- Tesseract (on-device, consent-gated) ---------------- */

let tess: TessWorker | null = null;
let tessLoading: Promise<TessWorker> | null = null;

/** Tesseract is only ever created after the user has explicitly agreed to on-device OCR. */
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

// One on-device page at a time: 300 DPI canvases are large, and Tesseract has one worker anyway.
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

/** Timings of the most recent on-device page, for diagnostics and tests. */
export let lastTimings: { renderAndPrepMs: number; ocrMs: number; cleanupMs: number } | null = null;
export let lastPrep: { ms: number; skewDegrees: number } | null = null;
if (typeof window !== 'undefined') {
  (window as unknown as { __easyreadOcrStats?: () => unknown }).__easyreadOcrStats = () => ({ lastTimings, lastPrep });
}

/* ---------------- one page: Gemini, then Groq, then (only with consent) on-device ---------------- */

export type PageOutcome = 'gemini' | 'groq' | 'ocr' | 'kept-scanner-text' | 'needs-consent';

interface PageResult {
  page: number;
  lines: PageData['lines'];
  outcome: PageOutcome;
}

export interface ProviderGate {
  available: () => boolean;
  onResult: (ok: boolean) => void;
}

/** One try (with a single retry/backoff on transient errors) against a cloud provider. */
async function tryCloud(
  canvas: HTMLCanvasElement,
  page: number,
  pageWidth: number,
  languageLabel: string,
  provider: CloudProvider,
  gate: ProviderGate,
): Promise<PageData['lines'] | null> {
  if (!gate.available()) return null;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const blocks = await cloudOcrPage(canvas, languageLabel, provider);
      gate.onResult(true);
      return cloudBlocksToLines(blocks, pageWidth);
    } catch (e) {
      lastErr = e;
      if (e instanceof CloudOcrError && e.retryable && attempt === 0) {
        await new Promise((r) => setTimeout(r, 600 + Math.random() * 600));
        continue;
      }
      break;
    }
  }
  gate.onResult(false);
  console.warn(`${provider} OCR failed on page ${page}:`, lastErr instanceof Error ? lastErr.message : lastErr);
  return null;
}

export async function readPage(
  pdf: Awaited<ReturnType<typeof openPdf>>,
  page: number,
  pageWidth: number,
  lang: string,
  gemini: ProviderGate,
  groq: ProviderGate,
  allowTesseract: boolean,
  provisional?: PageData['lines'],
): Promise<PageResult> {
  const chars = (ls: PageData['lines']) => ls.reduce((n, l) => n + l.text.length, 0);
  if (gemini.available() || groq.available()) {
    const { canvas } = await renderPage(pdf, page, 1600);
    const languageLabel = OCR_LANGS.find((l) => l.code === lang)?.label ?? 'auto';
    try {
      for (const [provider, gate] of [['gemini', gemini], ['groq', groq]] as const) {
        const lines = await tryCloud(canvas, page, pageWidth, languageLabel, provider, gate);
        if (!lines) continue;
        // Sanity check against the scanner's own text: if the model found far less text than
        // the scanner did (a blank or unreadable image), keep the scanner text instead.
        if (provisional?.length && chars(lines) < chars(provisional) * 0.3) {
          return { page, lines: provisional, outcome: 'kept-scanner-text' };
        }
        return { page, lines, outcome: provider };
      }
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  // Both cloud providers failed (or their circuit breakers are open). A scanned page that
  // came with the scanner's own text is kept as-is (repaired) rather than asking the user
  // about on-device OCR for text we already have, however rough.
  if (provisional?.length) return { page, lines: provisional, outcome: 'kept-scanner-text' };
  // EasyRead never runs on-device OCR without the user explicitly asking for it.
  if (!allowTesseract) return { page, lines: [], outcome: 'needs-consent' };
  const lines = await tesseractPage(pdf, page, lang);
  return { page, lines, outcome: 'ocr' };
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

export function makeGate(down: () => boolean, onFail: () => void): ProviderGate {
  let consecutive = 0;
  return {
    available: () => !down(),
    onResult: (ok) => {
      if (ok) consecutive = 0;
      else if (++consecutive >= CIRCUIT_BREAKER) onFail();
    },
  };
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
    let groqDown = book.ocr.groqDown ?? false;
    const allowTesseract = book.ocr.onDeviceConsent === true;
    set({ bookId, state: 'running', done, total, secPerPage: book.ocr.secPerPage ?? null, fallbackPages, needsConsent: 0, message: '' });
    if (allowTesseract) void keepAwake(true);

    const pdf = await openPdf(await file.arrayBuffer());

    let spp = book.ocr.secPerPage ?? 0;
    let sinceRebuild = 0;
    let stopping = false;
    let needsConsentCount = 0;
    const writeLock: Promise<void>[] = [];

    const geminiGate = makeGate(
      () => geminiDown,
      () => {
        geminiDown = true;
        set({ message: 'Google Gemini is unavailable right now. Trying Groq for the rest of this book.' });
      },
    );
    const groqGate = makeGate(
      () => groqDown,
      () => {
        groqDown = true;
        set({
          message: allowTesseract
            ? 'Both cloud readers are unavailable right now. Using the on-device reader for the rest of this book (slower, but it will finish).'
            : 'Both cloud readers are unavailable right now. Remaining pages will need your OK to read on this device.',
        });
      },
    );

    const stalePage = async () => my !== runId || cancelRequested || pauseRequested || !(await db.getBook(bookId));

    await runPool(
      todo,
      CLOUD_CONCURRENCY,
      () => stopping,
      async (p) => {
        if (await stalePage()) {
          stopping = true;
          return;
        }
        const t0 = performance.now();
        const result = await readPage(pdf, p.page, p.width, book.ocr!.lang, geminiGate, groqGate, allowTesseract, p.ocrLayer ? p.lines : undefined);
        if (my !== runId) return;
        if (result.outcome === 'needs-consent') {
          needsConsentCount++;
          return;
        }
        if (result.outcome === 'ocr') fallbackPages++;
        const source: PageData['source'] = result.outcome === 'kept-scanner-text' ? 'text' : result.outcome;
        const lines = result.lines;
        // Serialize DB writes: page tasks finish in parallel, but IndexedDB updates must not race.
        const prevWrite = writeLock.length ? writeLock[writeLock.length - 1] : Promise.resolve();
        const thisWrite = prevWrite.then(async () => {
          await db.putPages(bookId, [{ ...p, source, lines }]);
          done++;
          const secs = (performance.now() - t0) / 1000;
          spp = spp ? spp * 0.85 + secs * 0.15 : secs;
          await persistOcr(bookId, { done, secPerPage: spp, fallbackPages, geminiDown, groqDown });
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
      await persistOcr(bookId, { paused: true, done, fallbackPages, geminiDown, groqDown });
      set({ state: 'paused', message: '' });
      await rebuildBook(bookId);
    } else if (needsConsentCount > 0) {
      // Stop and wait: only the user can send remaining pages to on-device OCR, and leaving
      // this "paused" (rather than silently retrying) avoids hammering a down cloud provider
      // every time the app reopens.
      await persistOcr(bookId, { paused: true, done, fallbackPages, geminiDown, groqDown, needsConsent: needsConsentCount });
      set({ state: 'needs-consent', needsConsent: needsConsentCount, message: '' });
      await rebuildBook(bookId);
    } else {
      await db.updateBook(bookId, { status: 'ready', ocr: undefined });
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
    if (next && (status.state === 'idle' || status.state === 'paused' || status.state === 'needs-consent')) void startOcr(next);
  }
}
