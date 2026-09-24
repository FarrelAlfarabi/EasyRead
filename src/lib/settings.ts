export type Theme = 'light' | 'sepia' | 'dark' | 'dark-sepia' | 'dark-gray' | 'black' | 'night' | 'custom';
export type FontFamily = 'serif' | 'source-serif' | 'sans' | 'hyperlegible' | 'lexend' | 'opendyslexic';
export type PageMode = 'paged' | 'scroll' | 'original';
export type TapLayout = 'left-right' | 'top-bottom' | 'mostly-forward';
export type MarkerStyle = 'bar' | 'underline' | 'none';

export interface Settings {
  theme: Theme | 'auto';
  customFg: string;
  customBg: string;
  font: FontFamily;
  fontSize: number; // px
  fontWeight: number; // 300..700, variable fonts make this smooth
  lineHeight: number;
  letterSpacing: number; // em
  wordSpacing: number; // em
  paragraphSpacing: number; // em
  indent: number; // em, first-line indent
  marginLeft: number; // px
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  maxWidth: number; // characters per line
  align: 'left' | 'justify';
  hyphens: boolean;
  mode: PageMode;
  spread: boolean; // two pages on wide landscape screens
  pageAnimation: boolean;
  tapLayout: TapLayout;
  dim: number; // 0..0.7 extra darkening overlay
  keepAwake: boolean;
  statusClock: boolean;
  statusBattery: boolean;
  statusProgress: boolean;
  statusChapterTime: boolean;
  statusPagesLeft: boolean;
  publisherStyles: boolean; // EPUB: use the book's own CSS
  boldStarts: boolean; // "bionic"-style bold word starts (little evidence, optional)
  ruler: boolean; // reading ruler band
  rulerY: number; // 0..1 position of the ruler
  // Last-read word marker
  markMode: boolean; // taps on words set the marker
  markerStyle: MarkerStyle;
  markerDim: boolean; // dim the text before the marker
  autoMark: boolean; // mark the last word of a page when turning forward
  pdfCrop: boolean; // original-page view: trim white margins
  pdfZoom: number;
  ocrLang: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  customFg: '#2b2b2b',
  customBg: '#f3ecdc',
  font: 'serif',
  fontSize: 19,
  fontWeight: 400,
  lineHeight: 1.6,
  letterSpacing: 0,
  wordSpacing: 0,
  paragraphSpacing: 0.3,
  indent: 1.5,
  marginLeft: 20,
  marginRight: 20,
  marginTop: 28,
  marginBottom: 8,
  maxWidth: 66,
  align: 'left',
  hyphens: true,
  mode: 'paged',
  spread: true,
  pageAnimation: true,
  tapLayout: 'left-right',
  dim: 0,
  keepAwake: false,
  statusClock: false,
  statusBattery: false,
  statusProgress: true,
  statusChapterTime: true,
  statusPagesLeft: false,
  publisherStyles: false,
  boldStarts: false,
  ruler: false,
  rulerY: 0.45,
  markMode: false,
  markerStyle: 'bar',
  markerDim: true,
  autoMark: false,
  pdfCrop: true,
  pdfZoom: 1,
  ocrLang: 'eng',
};

/** Settings recommended for dyslexia (BDA style guide, WCAG 1.4.12 spacing). */
export const DYSLEXIA_PRESET: Partial<Settings> = {
  font: 'lexend',
  fontSize: 20,
  lineHeight: 1.8,
  letterSpacing: 0.12,
  wordSpacing: 0.16,
  paragraphSpacing: 1,
  indent: 0,
  align: 'left',
  hyphens: false,
  maxWidth: 60,
  theme: 'sepia',
};

export const FONTS: Array<{ id: FontFamily; label: string; stack: string; variable: boolean }> = [
  { id: 'serif', label: 'Literata', stack: "'Literata', Georgia, 'Times New Roman', serif", variable: true },
  { id: 'source-serif', label: 'Source Serif', stack: "'Source Serif 4', Georgia, serif", variable: true },
  { id: 'sans', label: 'System sans', stack: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif", variable: true },
  { id: 'hyperlegible', label: 'Atkinson', stack: "'Atkinson Hyperlegible Next', 'Atkinson Hyperlegible', Verdana, sans-serif", variable: true },
  { id: 'lexend', label: 'Lexend', stack: "'Lexend', Verdana, sans-serif", variable: true },
  { id: 'opendyslexic', label: 'OpenDyslexic', stack: "'OpenDyslexic', 'Comic Sans MS', sans-serif", variable: false },
];

export const FONT_STACKS = Object.fromEntries(FONTS.map((f) => [f.id, f.stack])) as Record<FontFamily, string>;

export const OCR_LANGS: Array<{ code: string; label: string; html: string }> = [
  { code: 'eng', label: 'English', html: 'en' },
  { code: 'ind', label: 'Indonesian', html: 'id' },
  { code: 'eng+ind', label: 'English + Indonesian', html: 'en' },
  { code: 'spa', label: 'Spanish', html: 'es' },
  { code: 'fra', label: 'French', html: 'fr' },
  { code: 'deu', label: 'German', html: 'de' },
  { code: 'por', label: 'Portuguese', html: 'pt' },
  { code: 'ita', label: 'Italian', html: 'it' },
  { code: 'nld', label: 'Dutch', html: 'nl' },
];

const KEY = 'easyread:settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const old = JSON.parse(raw) as Partial<Settings> & { margin?: number };
      // Older versions had one horizontal margin.
      if (old.margin !== undefined && old.marginLeft === undefined) {
        old.marginLeft = old.margin;
        old.marginRight = old.margin;
      }
      delete old.margin;
      const merged = { ...DEFAULT_SETTINGS, ...old };
      if (!FONTS.some((f) => f.id === merged.font)) merged.font = 'serif';
      return merged;
    }
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

export function resolveTheme(t: Settings['theme']): Theme {
  if (t !== 'auto') return t;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}
