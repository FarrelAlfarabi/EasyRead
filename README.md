# EasyRead

EasyRead turns a PDF book into easy, phone-sized reading. Upload a PDF and get clean, reflowed text you can read like an e-book: pages or scroll, your font, your size, your theme.

Everything happens in your browser. Your files never leave your device, and there are no accounts.

## Features

- Upload by tapping "Choose a PDF" or by dropping a file on the page.
- Smart PDF to text conversion, made for books and novels:
  - Groups text into lines and paragraphs.
  - Removes running headers, footers and page numbers.
  - Joins words that were split with a hyphen at the end of a line.
  - Finds chapter headings and builds a table of contents. Uses the PDF outline when there is one.
- Scanned PDFs work too. Pages without a text layer are read with OCR (Tesseract) right in the browser:
  - Works page by page, so mixed PDFs (some text pages, some scanned) are fine.
  - Start reading as soon as the first pages are done. New pages appear as they finish.
  - Pause, resume or stop at any time. If you close the tab, scanning picks up where it left off next time.
  - Keeps the screen awake while scanning (when the browser supports it).
  - Pick the language: English, Indonesian, English + Indonesian, and a few more. Language data downloads once, then is cached.
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

The app is a static site built with Vite, so Vercel needs no extra setup.

1. Push this repo to GitHub.
2. In Vercel, click "Add New Project" and import the repo.
3. Vercel detects Vite. Build command `npm run build`, output folder `dist`. Click Deploy.

Or from the command line: `npx vercel` in the project folder.

## How it works

- `src/lib/pdf.ts` reads each page with pdf.js and turns text pieces into lines.
- `src/lib/reflow.ts` removes headers and page numbers, builds paragraphs, finds headings and makes the table of contents. It runs in a Web Worker (`src/workers/reflow.worker.ts`) so the page stays smooth on long books.
- `src/lib/ocr.ts` scans image-only pages with tesseract.js. `src/lib/ocrLines.ts` turns OCR results into the same line format and drops low-confidence junk.
- `src/lib/db.ts` stores books, pages and reading state in IndexedDB. Settings live in localStorage.

## Limits

- Complex layouts (two columns, tables, footnotes, magazines, textbooks with side boxes) may come out in the wrong order.
- OCR quality depends on the scan. Blurry, skewed or handwritten pages give poor text. OCR takes a few seconds per page on phones.
- Images and figures are not shown.
- The first OCR run needs internet to download the OCR engine and language data (a few MB). After that it is cached.
