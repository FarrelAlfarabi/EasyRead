/** One visual line of text on a PDF page. Units are PDF points, y is measured from the page top. */
export interface Line {
  text: string;
  x: number;
  y: number;
  w: number;
  /** Font size (or OCR line height proxy) in PDF points. */
  size: number;
}

export type PageSource = 'text' | 'ocr' | 'pending' | 'skipped';

export interface PageData {
  page: number; // 1-based
  width: number;
  height: number;
  source: PageSource;
  lines: Line[];
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
