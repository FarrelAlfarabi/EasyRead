/// <reference lib="webworker" />
// Off-main-thread helpers for the on-device OCR fallback:
//  - "image": clean up a rendered page (contrast, deskew, binarize) before Tesseract
//  - "lines": turn Tesseract's result into Lines, repairing OCR mistakes with a word list
import { grayToRgba, preprocessForOcr, rgbaToGray } from '../lib/preprocess';
import { loadWordRanks, type WordRanks } from '../lib/ocrCleanup';
import { ocrToLines, type OcrBlockLike } from '../lib/ocrLines';

type Req =
  | { id: number; kind: 'image'; buffer: ArrayBuffer; width: number; height: number }
  | { id: number; kind: 'lines'; blocks: OcrBlockLike[]; scale: number; english: boolean };

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

let dict: Promise<WordRanks | undefined> | null = null;
function englishDict(): Promise<WordRanks | undefined> {
  if (!dict) {
    dict = fetch('/dict/en-words.txt')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(loadWordRanks)
      .catch(() => {
        dict = null; // try again next page
        return undefined;
      });
  }
  return dict;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data;
  try {
    if (req.kind === 'image') {
      const rgba = new Uint8ClampedArray(req.buffer);
      const { image, skewDegrees, ms } = preprocessForOcr(rgbaToGray(rgba, req.width, req.height));
      // Write the result back into the same buffer and hand it back without copying.
      grayToRgba(image, rgba);
      post({ id: req.id, buffer: req.buffer, skewDegrees, ms }, [req.buffer]);
    } else {
      const t0 = performance.now();
      // The word list only fits English; for other languages it would "fix" correct words.
      const words = req.english ? await englishDict() : undefined;
      const lines = ocrToLines(req.blocks, req.scale, 55, { dict: words });
      post({ id: req.id, lines, ms: performance.now() - t0 });
    }
  } catch (err) {
    post({ id: req.id, error: String(err) });
  }
};
