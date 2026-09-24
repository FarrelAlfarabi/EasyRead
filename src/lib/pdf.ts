import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { itemsToLines, type RawItem } from './reflow';
import { looksLikeScanWithTextLayer } from './scanDetect';
import type { OutlineItem, PageData } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}`;

/** Pages with fewer visible characters than this are treated as scanned images. */
export const MIN_TEXT_CHARS = 40;

export async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({
    data: new Uint8Array(data),
    cMapUrl: `${CDN}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${CDN}/standard_fonts/`,
  }).promise;
}

export async function extractPage(pdf: PDFDocumentProxy, n: number): Promise<PageData> {
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items = tc.items.filter((i): i is RawItem & typeof i => 'str' in i) as unknown as RawItem[];
  // Map to viewport coordinates so rotated pages and odd viewBoxes work.
  const lines = itemsToLines(
    items.map((it) => {
      const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      const t = [...it.transform];
      t[4] = x;
      t[5] = vp.height - y;
      return { ...it, transform: t };
    }),
    vp.height,
  );
  const chars = lines.reduce((s, l) => s + l.text.replace(/\s/g, '').length, 0);
  const ocrLayer = chars >= MIN_TEXT_CHARS ? await looksLikeScanWithTextLayer(page, pdfjs.OPS) : false;
  page.cleanup();
  return {
    page: n,
    width: vp.width,
    height: vp.height,
    source: chars >= MIN_TEXT_CHARS ? 'text' : 'pending',
    lines: chars >= MIN_TEXT_CHARS ? lines : [],
    ocrLayer,
  };
}

export async function getOutline(pdf: PDFDocumentProxy): Promise<OutlineItem[]> {
  const out: OutlineItem[] = [];
  try {
    const outline = await pdf.getOutline();
    if (!outline) return out;
    const walk = async (items: typeof outline, level: number) => {
      for (const it of items) {
        let page = -1;
        try {
          const dest = typeof it.dest === 'string' ? await pdf.getDestination(it.dest) : it.dest;
          const ref = dest?.[0];
          if (ref && typeof ref === 'object') page = (await pdf.getPageIndex(ref)) + 1;
          else if (typeof ref === 'number') page = ref + 1;
        } catch {
          /* bad destination */
        }
        if (it.title?.trim()) out.push({ title: it.title.trim(), page, level });
        if (it.items?.length && level < 2) await walk(it.items, level + 1);
      }
    };
    await walk(outline, 0);
  } catch {
    /* no outline */
  }
  return out;
}

export async function getTitle(pdf: PDFDocumentProxy, fallback: string): Promise<string> {
  try {
    const meta = await pdf.getMetadata();
    const info = meta.info as { Title?: string } | undefined;
    const t = info?.Title?.trim();
    if (t && !/^(untitled|microsoft word|document\d*)/i.test(t) && !/\.(docx?|pdf)$/i.test(t)) return t;
  } catch {
    /* ignore */
  }
  return fallback.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled';
}

/** Render a page to a canvas for OCR. Returns the canvas and the scale used (px per PDF point). */
export async function renderPage(
  pdf: PDFDocumentProxy,
  n: number,
  maxWidth = 2400,
  pickScale?: (base: { width: number; height: number }) => number,
): Promise<{ canvas: HTMLCanvasElement; scale: number }> {
  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = pickScale ? pickScale(base) : Math.min(2.5, maxWidth / base.width, Math.max(2, 1600 / base.width));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas not available');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  return { canvas, scale };
}

export const OCR_DPI = 300;

/**
 * Scale for on-device OCR: about 300 DPI (Tesseract's sweet spot), capped by pixel count
 * so a big page does not exhaust memory on a phone. PDF units are 1/72 inch.
 */
export function ocrScale(base: { width: number; height: number }): number {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }) : undefined;
  const lowMemory = (nav?.deviceMemory ?? 8) <= 4;
  const maxPixels = lowMemory ? 5_000_000 : 8_500_000;
  let dpi = OCR_DPI;
  try {
    dpi = Number(localStorage.getItem('easyread:ocrDpi')) || OCR_DPI; // test hook
  } catch {
    /* ignore */
  }
  const target = dpi / 72;
  const capped = Math.sqrt(maxPixels / (base.width * base.height));
  return Math.max(1, Math.min(target, capped));
}
