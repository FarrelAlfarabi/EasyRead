# EasyRead

EasyRead turns a PDF book into easy, phone-sized reading. Upload a PDF and get clean, reflowed text you can read like an e-book: pages or scroll, your font, your size, your theme.

Everything happens in your browser: your file, its text, your library and your settings never leave your device. The one exception is scanned pages (pages with no text layer): those are sent as an image to Google's Gemini API for accurate reading, with an automatic on-device fallback if Gemini is unavailable. See "Scanned PDFs and OCR" below. There are no accounts.

## Features

- Upload by tapping "Choose a PDF" or by dropping a file on the page.
- Smart PDF to text conversion, made for books and novels:
  - Groups text into lines and paragraphs.
  - Removes running headers, footers and page numbers.
  - Joins words that were split with a hyphen at the end of a line.
  - Finds chapter headings and builds a table of contents. Uses the PDF outline when there is one.
- Scanned PDFs work too. Pages without a text layer are read with OCR:
  - Primary reader: Google Gemini (a server-side API route), which gives much cleaner text than on-device OCR alone: correct paragraph breaks, real headings, no garbled words.
  - Automatic fallback: if Gemini fails, times out, or is rate-limited, that page is read on-device with Tesseract instead, so the book always finishes.
  - Works page by page, so mixed PDFs (some text pages, some scanned) are fine, and pages are sent a few at a time, not all at once.
  - Start reading as soon as the first pages are done. New pages appear as they finish.
  - Pause, resume or stop at any time. If you close the tab, scanning picks up where it left off next time.
  - Keeps the screen awake while scanning (when the browser supports it).
  - Pick the language: English, Indonesian, English + Indonesian, and a few more. This is passed to Gemini as a hint, and used by the on-device fallback (whose language data downloads once, then is cached).
- Reader:
  - Page mode (tap the left or right side, swipe, or use arrow keys) or scroll mode.
  - Tap the middle to show the menu: contents, bookmarks, display settings, and a position slider.
  - Shows percent read and minutes left in the chapter.
  - Remembers where you stopped.
  - Two pages side by side on large landscape screens (can be turned off).
- Display settings with live preview: serif, sans or Atkinson Hyperlegible font, text size, line spacing, margins, line width (in characters), left or justified text, hyphenation, and five themes (light, sepia, dark, black for OLED, and a dim night theme).
- Library with progress and last read time. Delete books you are done with.
- Works offline after the first visit. Can be installed to the home screen.

See [docs/reader-research.md](docs/reader-research.md) for the reading research behind the defaults.

## Run it locally

You need Node.js 20 or newer.

```bash
npm install
npm run dev        # start the dev server at http://localhost:5173
npm run build      # typecheck and build to dist/
npm run preview    # serve the built app
npm test           # unit tests for the text conversion
npm run lint       # lint
```

## Deploy to Vercel

The app is a static site built with Vite, plus one small serverless function for OCR (`api/ocr.ts`). Vercel handles both with no extra config.

1. Push this repo to GitHub.
2. In Vercel, click "Add New Project" and import the repo.
3. Vercel detects Vite. Build command `npm run build`, output folder `dist`. Click Deploy.
4. In Project Settings -> Environment Variables, add `GEMINI_API_KEY` with a key from [Google AI Studio](https://aistudio.google.com/). This must be a server-side variable (not prefixed with `VITE_`), so it is never sent to the browser. Without it, scanned PDFs still work, just entirely on-device (slower, lower quality).

Or from the command line: `npx vercel` in the project folder.

## Scanned PDFs and OCR

Most of a scanned page never needs to leave your device, because most PDFs already have a text layer that pdf.js reads directly. Only a page with no text layer (a photographed or scanned page) needs OCR.

For those pages, EasyRead sends the rendered page image to `/api/ocr`, a small serverless function that calls Google's Gemini API with your `GEMINI_API_KEY` and asks it to transcribe the page, split into paragraphs and headings. The key lives only in that server function; it is never bundled into the app or sent to the browser.

If that call fails for any reason (offline, rate-limited, Gemini down, or `GEMINI_API_KEY` missing), EasyRead automatically falls back to reading the page on-device with Tesseract, so scanning always finishes. Pages are OCR'd a few at a time (not all at once) to stay within Gemini's rate limits, with automatic retries on rate-limit and server errors.

## How it works

- `src/lib/pdf.ts` reads each page with pdf.js and turns text pieces into lines.
- `src/lib/reflow.ts` removes headers and page numbers, builds paragraphs, finds headings and makes the table of contents. It runs in a Web Worker (`src/workers/reflow.worker.ts`) so the page stays smooth on long books.
- `src/lib/ocr.ts` orchestrates OCR: it sends each image-only page to `/api/ocr` (Gemini) first, and falls back to tesseract.js on-device if that fails. `src/lib/geminiOcr.ts` and `src/lib/ocrLines.ts` turn each engine's output into the same line format the reflow pipeline expects.
- `api/ocr.ts` is the Vercel serverless function that calls the Gemini API. `GEMINI_API_KEY` is read only here.
- `src/lib/db.ts` stores books, pages and reading state in IndexedDB. Settings live in localStorage.

## Scanned PDFs that already have text

Many scanned books come with a hidden text layer made by the scanner's own OCR, often of poor quality: letter-spaced headings like "J U D GM ENT", glued words like "thefool", and words split by a dash at a line end. EasyRead detects these pages (text drawn invisibly over a page image, or text over a full-page image) and checks how broken the text looks. Poor pages are re-read with Gemini, falling back to the on-device reader, and the scanner text is shown until then. Scanner text that is kept gets repaired: letter-spaced headings are rejoined and split into words ("DO NOT COMMIT TO ANYONE"), broken words are rejoined ("Par liament" becomes "Parliament"), and obvious misreadings are fixed. Long, sentence-like lines are never shown as headings.

Books imported before a fix can be updated with "Re-process" in the library. EasyRead now keeps the original PDF on the device so this can re-read every page. Books imported before this change only have their stored text, so re-processing repairs that text but cannot re-read the images. Bookmarks are cleared on re-process because the text positions change.

## On-device OCR quality (fallback path)

When Gemini is unavailable, pages are read on-device with Tesseract. Three steps make that much more usable than plain Tesseract:

1. Image cleanup (in a Web Worker, `src/lib/preprocess.ts`): render at about 300 DPI (capped at 5 to 8.5 megapixels depending on device memory), grayscale, contrast stretch, deskew (projection profile, up to 6 degrees), then Sauvola adaptive thresholding.
2. Tesseract settings: LSTM engine with the "best" integer English model, page segmentation mode 3 (automatic layout).
3. Text cleanup for English (`src/lib/ocrCleanup.ts`): a 60,000 word frequency list (built from SUBTLEX-US at build time, about 240 KB gzipped, downloaded only when the fallback runs) is used to split glued words ("thefool" to "the fool", "Ifyou" to "If you") and fix look-alike letters ("commil" to "commit", "tfwy" to "they"). A fix is applied only when it is clearly the best one. Known words, capitalized words (likely names) and acronyms are never respelled. Lines that are mostly non-words, stray quote marks, and big "headings" made of junk are dropped.

Measured on test pages (word accuracy, page rendered as a scanned image, Chromium, forced fallback):

| Test page | Before | After |
| --- | --- | --- |
| Clean scan | 100% | 100% |
| Moderate (1.2 degree skew, blur, low contrast, JPEG) | 7% | 99% |
| Severe (about 95 DPI, 2 degree skew, noise) | 16% | 38% |
| Extreme (about 40 DPI) | 0% (junk shown) | 0% (junk hidden) |

Time per page on the test machine: about 0.7 s render and cleanup plus 3.2 s OCR, about 4 to 5 s in total (was 4 to 8 s, since Tesseract slows down on noisy pages). Phones are slower.

Tried and not shipped: median filter denoise and speck removal (both hurt blurry, low-resolution text), unsharp mask (hurt every test page), Otsu and Wolf thresholding (worse than Sauvola), page segmentation modes 4 and 6 (4 about equal, 6 worse on degraded pages), and the larger 10.9 MB standard English model (same results as the 2.9 MB "best" integer model). The float "tessdata_best" model could not be downloaded in the build environment, so it was not tested.

## Limits

- Complex layouts (two columns, tables, footnotes, magazines, textbooks with side boxes) may come out in the wrong order.
- Scanned pages are sent to Google's Gemini API for reading (see above). This is the one part of EasyRead that is not fully on-device. Gemini API usage has a small cost, a small fraction of a cent per page.
- If Gemini is unavailable, the on-device fallback (Tesseract) is still lower quality on poor scans. It is good on clean and moderately degraded pages, but very low resolution scans (under about 100 DPI) remain hard to read. Word repair is English only.
- Images and figures are not shown.
- The on-device fallback needs internet the first time it runs, to download the OCR engine and language data (a few MB). After that it is cached.
