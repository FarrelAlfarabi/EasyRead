import { useEffect, useRef, useState } from 'react';
import { db } from '../lib/db';
import { openPdf } from '../lib/pdf';

type Pdf = Awaited<ReturnType<typeof openPdf>>;

interface Props {
  bookId: string;
  pageCount: number;
  startPage: number;
  crop: boolean;
  zoom: number;
  onPage: (page: number) => void;
}

/** Find the inked area of a rendered page (for margin crop), as fractions of the page. */
function contentBox(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const { data } = ctx.getImageData(0, 0, w, h);
  let x0 = w;
  let y0 = h;
  let x1 = 0;
  let y1 = 0;
  const step = 2;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (data[i] + data[i + 1] + data[i + 2] < 600) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 <= x0 || y1 <= y0) return { x: 0, y: 0, w: 1, h: 1 };
  const pad = 0.015;
  const fx = Math.max(0, x0 / w - pad);
  const fy = Math.max(0, y0 / h - pad);
  return { x: fx, y: fy, w: Math.min(1, x1 / w + pad) - fx, h: Math.min(1, y1 / h + pad) - fy };
}

function PageCanvas({ pdf, n, width, crop, visible }: { pdf: Pdf; n: number; width: number; crop: boolean; visible: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ratio, setRatio] = useState(1.3);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      // Render big enough that the cropped part still fills the width sharply.
      const scale = Math.min(4, ((width * dpr) / base.width) * (crop ? 1.35 : 1));
      const vp = page.getViewport({ scale });
      const off = document.createElement('canvas');
      off.width = Math.floor(vp.width);
      off.height = Math.floor(vp.height);
      const octx = off.getContext('2d', { willReadFrequently: true });
      if (!octx) return;
      octx.fillStyle = '#fff';
      octx.fillRect(0, 0, off.width, off.height);
      await page.render({ canvas: off, canvasContext: octx, viewport: vp }).promise;
      if (cancelled) return;
      const box = crop ? contentBox(octx, off.width, off.height) : { x: 0, y: 0, w: 1, h: 1 };
      const sw = off.width * box.w;
      const sh = off.height * box.h;
      const c = ref.current;
      if (!c) return;
      c.width = Math.round(width * dpr);
      c.height = Math.round((width * dpr * sh) / sw);
      setRatio(sh / sw);
      c.getContext('2d')?.drawImage(off, off.width * box.x, off.height * box.y, sw, sh, 0, 0, c.width, c.height);
      off.width = 0;
      page.cleanup();
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pdf, n, width, crop, visible]);
  return <canvas ref={ref} className="pdf-page" style={{ width, height: width * ratio }} aria-label={`Page ${n}`} />;
}

/** Original-page view for PDFs: the real pages, with optional margin crop and zoom. */
export default function PdfPageView({ bookId, pageCount, startPage, crop, zoom, onPage }: Props) {
  const [pdf, setPdf] = useState<Pdf | null>(null);
  const [error, setError] = useState('');
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState<Set<number>>(new Set([startPage]));
  const scroller = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  useEffect(() => {
    let doc: Pdf | null = null;
    (async () => {
      const file = await db.getFile(bookId);
      if (!file) {
        setError('The original PDF is not stored for this book. Re-upload it to use page view.');
        return;
      }
      doc = await openPdf(await file.arrayBuffer());
      setPdf(doc);
    })().catch(() => setError('Could not open the original PDF.'));
    return () => {
      void doc?.loadingTask.destroy();
    };
  }, [bookId]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth - 16)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !pdf) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const n = Number((e.target as HTMLElement).dataset.page);
            if (e.isIntersecting) next.add(n);
          }
          return next;
        });
        const top = entries.filter((e) => e.isIntersecting && e.intersectionRatio > 0.3).map((e) => Number((e.target as HTMLElement).dataset.page));
        if (top.length) onPage(Math.min(...top));
      },
      { root: el, rootMargin: '100% 0px', threshold: [0, 0.3, 0.6] },
    );
    el.querySelectorAll('[data-page]').forEach((p) => io.observe(p));
    return () => io.disconnect();
  }, [pdf, width, zoom, onPage]);

  // Jump to the starting page once the first layout is ready.
  useEffect(() => {
    if (!pdf || !width || started.current) return;
    started.current = true;
    scroller.current?.querySelector(`[data-page="${startPage}"]`)?.scrollIntoView();
  }, [pdf, width, startPage]);

  if (error) return <p className="reader-msg">{error}</p>;
  const w = Math.round(width * zoom);
  return (
    <div ref={scroller} className="pdf-scroller">
      {pdf &&
        w > 0 &&
        Array.from({ length: pageCount }, (_, k) => k + 1).map((n) => (
          <div key={n} data-page={n} className="pdf-page-wrap" style={{ width: w, minHeight: visible.has(n) ? undefined : w * 1.3 }}>
            {visible.has(n) && <PageCanvas pdf={pdf} n={n} width={w} crop={crop} visible />}
          </div>
        ))}
    </div>
  );
}
