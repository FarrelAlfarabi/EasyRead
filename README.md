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

## Limits

- Complex layouts (two columns, tables, footnotes, magazines, textbooks with side boxes) may come out in the wrong order.
- Scanned pages are sent to Google's Gemini API for reading (see above). This is the one part of EasyRead that is not fully on-device. Gemini API usage has a small cost, a small fraction of a cent per page.
- If Gemini is unavailable, the on-device fallback (Tesseract) is noticeably lower quality: it can garble headings and merge words together, especially on low-resolution scans.
- Images and figures are not shown.
- The on-device fallback needs internet the first time it runs, to download the OCR engine and language data (a few MB). After that it is cached.
