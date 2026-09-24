/**
 * Image cleanup before on-device OCR (Tesseract fallback path).
 * Pure functions on 8-bit grayscale buffers, so they run the same in a Web Worker and in
 * Node tests. Tuned on degraded test scans (blur, skew, low contrast, JPEG noise); see
 * the README "On-device OCR quality" notes for what was tried and dropped.
 */

export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface PreprocessOptions {
  /** Estimate and undo page rotation. Default true. */
  deskew?: boolean;
  /** Sauvola sensitivity. 0.5 tested best (0.2 thickened blurry text into blobs). */
  k?: number;
}

export interface PreprocessResult {
  image: GrayImage;
  skewDegrees: number;
  ms: number;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** RGBA (canvas ImageData) to grayscale using integer Rec. 601 luma. */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): GrayImage {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return { data: out, width, height };
}

/** Write a grayscale image into an RGBA buffer (reusing `out` when given). */
export function grayToRgba(img: GrayImage, out?: Uint8ClampedArray): Uint8ClampedArray {
  const n = img.width * img.height;
  const rgba = out ?? new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = img.data[i];
    rgba[j] = v;
    rgba[j + 1] = v;
    rgba[j + 2] = v;
    rgba[j + 3] = 255;
  }
  return rgba;
}

/** Stretch contrast so the 1st percentile maps to black and the 99th to white. In place. */
export function normalizeContrast(img: GrayImage, lowPct = 0.01, highPct = 0.99): void {
  const h = new Uint32Array(256);
  for (let i = 0; i < img.data.length; i++) h[img.data[i]]++;
  const n = img.data.length;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += h[v];
    if (acc >= n * lowPct) { lo = v; break; }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += h[v];
    if (acc >= n * (1 - highPct)) { hi = v; break; }
  }
  if (hi - lo < 10) return;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round(((v - lo) * 255) / (hi - lo))));
  for (let i = 0; i < n; i++) img.data[i] = lut[img.data[i]];
}

/**
 * Sauvola adaptive threshold: T = mean * (1 + k * (std / 128 - 1)) over a local window.
 * Handles uneven lighting and faded print far better than one global threshold. Uses
 * running column sums, so extra memory is O(width) rather than two full-page integral
 * images (which would cost ~130 MB at 300 DPI, too much for phones).
 */
export function binarizeSauvola(img: GrayImage, window = 0, k = 0.5): GrayImage {
  const { width: w, height: h, data } = img;
  const win = window || Math.max(15, Math.round(Math.min(w, h) / 40) | 1);
  const r = win >> 1;
  const colSum = new Float64Array(w);
  const colSq = new Float64Array(w);
  const preS = new Float64Array(w + 1);
  const preQ = new Float64Array(w + 1);
  const out = new Uint8Array(data.length);
  const addRow = (y: number, sign: number) => {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const v = data[o + x];
      colSum[x] += sign * v;
      colSq[x] += sign * v * v;
    }
  };
  let top = 0; // first row inside the window
  let bottom = 0; // one past the last row inside the window
  for (let y = 0; y < h; y++) {
    // Slide the vertical window to [y - r, y + r].
    while (bottom < Math.min(h, y + r + 1)) addRow(bottom++, 1);
    while (top < y - r) addRow(top++, -1);
    const rows = bottom - top;
    for (let x = 0; x < w; x++) {
      preS[x + 1] = preS[x] + colSum[x];
      preQ[x + 1] = preQ[x] + colSq[x];
    }
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = x - r < 0 ? 0 : x - r;
      const x1 = x + r + 1 > w ? w : x + r + 1;
      const cnt = rows * (x1 - x0);
      const mean = (preS[x1] - preS[x0]) / cnt;
      const v = (preQ[x1] - preQ[x0]) / cnt - mean * mean;
      const std = v > 0 ? Math.sqrt(v) : 0;
      out[o + x] = data[o + x] > mean * (1 + k * (std / 128 - 1)) ? 255 : 0;
    }
  }
  return { data: out, width: w, height: h };
}

/** Nearest-neighbour downscale so the image is at most `maxW` wide. */
function shrink(img: GrayImage, maxW: number): GrayImage {
  if (img.width <= maxW) return img;
  const f = maxW / img.width;
  const w = Math.round(img.width * f);
  const h = Math.round(img.height * f);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / f));
    for (let x = 0; x < w; x++) out[y * w + x] = img.data[sy * img.width + Math.min(img.width - 1, Math.floor(x / f))];
  }
  return { data: out, width: w, height: h };
}

/**
 * Estimate text skew in degrees with a projection profile: rotate the ink points by each
 * candidate angle and keep the angle whose row histogram is "peakiest" (text lines line up).
 * Works on a small copy, so it costs well under 100 ms.
 */
export function estimateSkew(img: GrayImage, maxAngle = 6): number {
  const small = shrink(img, 900);
  // Local threshold so uneven lighting or a grey background is not mistaken for ink.
  const ink = binarizeSauvola(small, 0, 0.3);
  const xs: number[] = [];
  const ys: number[] = [];
  // Subsample along x only: skipping rows would make angle 0 look artificially "peaky".
  const step = small.width * small.height > 400000 ? 2 : 1;
  for (let y = 0; y < small.height; y++) {
    for (let x = 0; x < small.width; x += step) {
      if (ink.data[y * small.width + x] === 0) { xs.push(x); ys.push(y); }
    }
  }
  if (xs.length < 200) return 0;
  const cx = small.width / 2;
  const cy = small.height / 2;
  const rows = new Float64Array(small.height * 2 + 10);
  const score = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    const s = Math.sin(a);
    const c = Math.cos(a);
    rows.fill(0);
    for (let i = 0; i < xs.length; i++) {
      const ry = Math.round(-(xs[i] - cx) * s + (ys[i] - cy) * c + cy + small.height / 2);
      if (ry >= 0 && ry < rows.length) rows[ry]++;
    }
    let sq = 0;
    for (let i = 0; i < rows.length; i++) sq += rows[i] * rows[i];
    return sq;
  };
  let best = 0;
  let bestScore = -1;
  for (let d = -maxAngle; d <= maxAngle + 1e-9; d += 0.5) {
    const sc = score(d);
    if (sc > bestScore) { bestScore = sc; best = d; }
  }
  const coarse = best;
  for (let d = coarse - 0.5; d <= coarse + 0.5 + 1e-9; d += 0.1) {
    const sc = score(d);
    if (sc > bestScore) { bestScore = sc; best = d; }
  }
  return Math.round(best * 10) / 10;
}

/** Rotate by `deg` degrees around the centre (same sign convention as estimateSkew), bilinear, white fill. */
export function rotate(img: GrayImage, deg: number): GrayImage {
  if (Math.abs(deg) < 0.05) return img;
  const { width: w, height: h, data } = img;
  const a = (deg * Math.PI) / 180;
  const s = Math.sin(a);
  const c = Math.cos(a);
  const cx = w / 2;
  const cy = h / 2;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Inverse map: where in the source does this output pixel come from?
      const dx = x - cx;
      const dy = y - cy;
      const sx = dx * c - dy * s + cx;
      const sy = dx * s + dy * c + cy;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) { out[y * w + x] = 255; continue; }
      const fx = sx - x0;
      const fy = sy - y0;
      const i = y0 * w + x0;
      const t = data[i] * (1 - fx) + data[i + 1] * fx;
      const b = data[i + w] * (1 - fx) + data[i + w + 1] * fx;
      out[y * w + x] = t * (1 - fy) + b * fy;
    }
  }
  return { data: out, width: w, height: h };
}

/** Full cleanup chain: contrast stretch, deskew, adaptive binarization. */
export function preprocessForOcr(input: GrayImage, opts: PreprocessOptions = {}): PreprocessResult {
  const t0 = now();
  const { deskew = true, k = 0.5 } = opts;
  let img: GrayImage = { data: new Uint8Array(input.data), width: input.width, height: input.height };
  normalizeContrast(img);
  let skewDegrees = 0;
  if (deskew) {
    const est = estimateSkew(img);
    if (Math.abs(est) >= 0.2) {
      img = rotate(img, est);
      skewDegrees = est;
    }
  }
  img = binarizeSauvola(img, 0, k);
  return { image: img, skewDegrees, ms: now() - t0 };
}
