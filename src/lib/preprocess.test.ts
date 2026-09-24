import { describe, expect, it } from 'vitest';
import { binarizeSauvola, estimateSkew, normalizeContrast, preprocessForOcr, rotate, type GrayImage } from './preprocess';

/** A fake page: light grey paper with dark "text lines" made of short dashes. */
function fakePage(w = 600, h = 800, paper = 200, ink = 90): GrayImage {
  const data = new Uint8Array(w * h).fill(paper);
  for (let y = 100; y < h - 100; y += 30) {
    for (let x = 60; x < w - 60; x++) {
      if ((x % 14) < 10) for (let t = 0; t < 8; t++) data[(y + t) * w + x] = ink;
    }
  }
  return { data, width: w, height: h };
}

describe('preprocess', () => {
  it('stretches low contrast to full range', () => {
    const img = fakePage();
    normalizeContrast(img);
    expect(img.data.reduce((m, v) => Math.min(m, v), 255)).toBe(0);
    expect(img.data.reduce((m, v) => Math.max(m, v), 0)).toBe(255);
  });

  it('estimates and undoes skew', () => {
    for (const angle of [-3, -1.2, 0, 2]) {
      const skewed = rotate(fakePage(), -angle);
      const est = estimateSkew(skewed);
      expect(Math.abs(est - angle)).toBeLessThanOrEqual(0.3);
    }
  });

  it('binarizes to pure black and white, keeping text and dropping an uneven background', () => {
    const img = fakePage();
    // Uneven lighting: paper gets darker to the right.
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const i = y * img.width + x;
      img.data[i] = Math.max(0, img.data[i] - Math.round((x / img.width) * 60));
    }
    const out = binarizeSauvola(img);
    expect(new Set(out.data)).toEqual(new Set([0, 255]));
    expect(out.data[100 * img.width + 62]).toBe(0); // ink stays ink
    expect(out.data[50 * img.width + img.width - 20]).toBe(255); // dark paper becomes white
  });

  it('runs the full chain and reports the skew it removed', () => {
    const r = preprocessForOcr(rotate(fakePage(), 1.5));
    expect(Math.abs(r.skewDegrees + 1.5)).toBeLessThanOrEqual(0.3);
    expect(r.image.width).toBe(600);
  });
});
