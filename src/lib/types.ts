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

export type BlockType = 'p' | 'h' | 'hr' | 'li' | 'quote' | 'pre' | 'img';

export interface Block {
  t: BlockType;
  /** Plain text. For blocks with `html`, this equals the rendered element's textContent. */
  text: string;
  /** PDF: page number. EPUB: spine (chapter file) index. */
  page: number;
  /** Sanitized inline HTML (EPUB only): em/strong/sup/links etc. */
  html?: string;
  /** Heading level (1-6) or list nesting depth. */
  level?: number;
  /** List item marker text ("1." or "•"). */
  marker?: string;
  /** Image resource path inside the book (t: 'img'). */
  src?: string;
  /** Anchor ids that point at this block (EPUB links and footnotes). */
  ids?: string[];
  /** Original class names (for "use publisher styles"). */
  cls?: string;
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
  /** EPUB: link target ("chapter.xhtml#id" or "chapter.xhtml") to block index. */
  anchors?: Record<string, number>;
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

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

export interface Highlight {
  id: string;
  block: number;
  start: number; // char offsets in block text
  end: number;
  color: HighlightColor;
  text: string;
  note?: string;
  createdAt: number;
}

/** The reader's "I stopped reading here" marker: one word. */
export interface ReadMarker {
  block: number;
  start: number;
  end: number;
  at: number;
}

export type ReadingStatus = 'none' | 'to-read' | 'reading' | 'read';

export interface ReadingStats {
  /** Seconds of active reading. */
  seconds: number;
  /** Per day (YYYY-MM-DD): seconds read and characters advanced. */
  days: Record<string, { seconds: number; chars: number }>;
}

export interface BookMeta {
  id: string;
  title: string;
  format?: 'pdf' | 'epub';
  author?: string;
  /** Files-store key of the cover image, if any. */
  cover?: string;
  /** EPUB: the book's CSS, scoped under .pub (used when "publisher styles" is on). */
  css?: string;
  favorite?: boolean;
  readingStatus?: ReadingStatus;
  collections?: string[];
  highlights?: Highlight[];
  marker?: ReadMarker;
  stats?: ReadingStats;
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
