/** One visual line of text on a PDF page. Units are PDF points, y is measured from the page top. */
export interface Line {
  text: string;
  x: number;
  y: number;
  w: number;
  /** Font size (or OCR line height proxy) in PDF points. */
  size: number;
  /**
   * Set only for lines that already come pre-classified as a whole paragraph or heading
   * (e.g. from the Gemini OCR path, which returns structured blocks instead of raw lines).
   * When set, buildBlocks uses this directly instead of running its layout heuristics.
   */
  kind?: 'h' | 'p' | 'hr';
}

export type PageSource = 'text' | 'ocr' | 'gemini' | 'groq' | 'pending' | 'skipped';

export interface PageData {
  page: number; // 1-based
  width: number;
  height: number;
  source: PageSource;
  lines: Line[];
  /**
   * The page is a scanned image with an OCR text layer from the scanner (not born-digital
   * text). Its words may be misread, so stronger repair is applied, and when it looks poor
   * the page is re-read with OCR.
   */
  ocrLayer?: boolean;
}

export type BlockType = 'p' | 'h' | 'hr';

export interface Block {
  t: BlockType;
  text: string;
  page: number;
}

export interface TocEntry {
  title: string;
  block: number;
  level: number;
}

export interface Section {
  title: string;
  start: number; // inclusive block index
  end: number; // exclusive block index
}

export interface BookContent {
  blocks: Block[];
  sections: Section[];
  toc: TocEntry[];
  /** Cumulative character count before each block, plus total at the end. */
  charIndex: number[];
}

export interface OutlineItem {
  title: string;
  page: number;
  level: number;
}

export interface Bookmark {
  block: number;
  snippet: string;
  createdAt: number;
}

export interface OcrState {
  lang: string;
  done: number;
  total: number;
  paused: boolean;
  secPerPage?: number;
  /**
   * Pages read on-device (Tesseract), only ever true after the user explicitly agreed to it
   * for this book (see onDeviceConsent). EasyRead never runs on-device OCR silently.
   */
  fallbackPages?: number;
  /** True once Gemini has failed repeatedly and this run stopped trying it for the rest of the run. */
  geminiDown?: boolean;
  /** True once Groq has failed repeatedly and this run stopped trying it for the rest of the run. */
  groqDown?: boolean;
  /** Pages that could not be read by either cloud provider and are waiting on the user's choice. */
  needsConsent?: number;
  /** The user has agreed to read this book's remaining/failed pages on-device when the cloud can't. */
  onDeviceConsent?: boolean;
}

export interface BookMeta {
  id: string;
  title: string;
  fileName: string;
  pageCount: number;
  addedAt: number;
  lastReadAt: number;
  progress: number; // 0..1
  position: number; // block index
  bookmarks: Bookmark[];
  status: 'ready' | 'ocr';
  ocr?: OcrState;
  lang: string;
  outline: OutlineItem[];
}
