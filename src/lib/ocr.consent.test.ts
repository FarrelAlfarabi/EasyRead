import { beforeEach, describe, expect, it, vi } from 'vitest';

// A minimal stand-in canvas: nothing here should ever be touched by these tests, since
// cloudOcrPage and tesseract's recognize() are both mocked below.
const fakeCanvas = { width: 100, height: 100 } as unknown as HTMLCanvasElement;

vi.mock('./pdf', () => ({
  renderPage: vi.fn(async () => ({ canvas: fakeCanvas, scale: 2 })),
  ocrScale: () => 2,
  openPdf: vi.fn(),
}));

const cloudOcrPage = vi.fn();
vi.mock('./cloudOcr', async () => {
  const actual = await vi.importActual<typeof import('./cloudOcr')>('./cloudOcr');
  return { ...actual, cloudOcrPage: (...args: unknown[]) => cloudOcrPage(...args) };
});

// If on-device OCR is ever reached without consent, this should blow up loudly rather than
// silently "working" via a real (slow, browser-only) Tesseract worker.
const createWorker = vi.fn(async () => {
  throw new Error('tesseract.js createWorker() must never be called without explicit user consent');
});
vi.mock('tesseract.js', () => ({ createWorker }));

const { readPage, makeGate } = await import('./ocr');
const { CloudOcrError } = await import('./cloudOcr');

function gate(down = false) {
  const fail = vi.fn();
  return { g: makeGate(() => down, fail), fail };
}

describe('readPage: consent gate for on-device OCR', () => {
  beforeEach(() => {
    cloudOcrPage.mockReset();
    createWorker.mockClear();
  });

  it('never calls Tesseract when both cloud providers fail and consent was not given', async () => {
    cloudOcrPage.mockRejectedValue(new CloudOcrError('gemini', 'down', true));
    const { g: gemini } = gate();
    const { g: groq } = gate();
    const result = await readPage({} as never, 1, 400, 'eng', gemini, groq, false);
    expect(result.outcome).toBe('needs-consent');
    expect(result.lines).toEqual([]);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('never calls Tesseract when both circuit breakers are already open and consent was not given', async () => {
    const { g: gemini } = gate(true);
    const { g: groq } = gate(true);
    const result = await readPage({} as never, 1, 400, 'eng', gemini, groq, false);
    expect(result.outcome).toBe('needs-consent');
    expect(cloudOcrPage).not.toHaveBeenCalled();
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('keeps the scanner\'s own text instead of asking for consent, when there is some', async () => {
    cloudOcrPage.mockRejectedValue(new CloudOcrError('gemini', 'down', true));
    const { g: gemini } = gate();
    const { g: groq } = gate();
    const provisional = [{ text: 'Some scanner text', x: 0, y: 0, w: 100, size: 11 }];
    const result = await readPage({} as never, 1, 400, 'eng', gemini, groq, false, provisional);
    expect(result.outcome).toBe('kept-scanner-text');
    expect(result.lines).toBe(provisional);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('only reads on-device once allowTesseract is true (the explicit-consent path)', async () => {
    cloudOcrPage.mockRejectedValue(new CloudOcrError('gemini', 'down', true));
    const { g: gemini } = gate();
    const { g: groq } = gate();
    // allowTesseract=true is only ever set from a book whose ocr.onDeviceConsent the user set
    // by tapping "Use on-device OCR" (see enableOnDeviceOcr in ocr.ts).
    await expect(readPage({} as never, 1, 400, 'eng', gemini, groq, true)).rejects.toThrow();
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it('falls back to Groq when Gemini fails, without needing consent', async () => {
    cloudOcrPage.mockImplementation(async (_canvas: unknown, _lang: unknown, provider: string) => {
      if (provider === 'gemini') throw new CloudOcrError('gemini', 'down', true);
      return [{ type: 'paragraph', text: 'Read by Groq.' }];
    });
    const { g: gemini } = gate();
    const { g: groq } = gate();
    const result = await readPage({} as never, 1, 400, 'eng', gemini, groq, false);
    expect(result.outcome).toBe('groq');
    expect(result.lines.map((l) => l.text)).toEqual(['Read by Groq.']);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('uses Gemini directly when it succeeds, and never tries Groq', async () => {
    cloudOcrPage.mockResolvedValue([{ type: 'paragraph', text: 'Read by Gemini.' }]);
    const { g: gemini } = gate();
    const { g: groq } = gate();
    const result = await readPage({} as never, 1, 400, 'eng', gemini, groq, false);
    expect(result.outcome).toBe('gemini');
    expect(cloudOcrPage).toHaveBeenCalledTimes(1);
  });
});

describe('makeGate: per-provider circuit breaker', () => {
  it('opens only after repeated failures, and resets on a success', () => {
    const onFail = vi.fn();
    let down = false;
    const g = makeGate(() => down, () => {
      down = true;
      onFail();
    });
    for (let i = 0; i < 3; i++) g.onResult(false);
    expect(onFail).not.toHaveBeenCalled();
    g.onResult(true); // resets the streak
    for (let i = 0; i < 3; i++) g.onResult(false);
    expect(onFail).not.toHaveBeenCalled();
    g.onResult(false); // 4th in a row
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(g.available()).toBe(false);
  });
});
