export type Theme = 'light' | 'sepia' | 'dark' | 'black' | 'night';
export type FontFamily = 'serif' | 'sans' | 'hyperlegible';
export type PageMode = 'paged' | 'scroll';

export interface Settings {
  theme: Theme | 'auto';
  font: FontFamily;
  fontSize: number; // px
  lineHeight: number;
  margin: number; // px, each side
  maxWidth: number; // characters per line
  align: 'left' | 'justify';
  hyphens: boolean;
  mode: PageMode;
  spread: boolean; // two pages on wide landscape screens
  ocrLang: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  font: 'serif',
  fontSize: 19,
  lineHeight: 1.6,
  margin: 20,
  maxWidth: 66,
  align: 'left',
  hyphens: true,
  mode: 'paged',
  spread: true,
  ocrLang: 'eng',
};

export const FONT_STACKS: Record<FontFamily, string> = {
  serif: "'Literata', Georgia, 'Times New Roman', serif",
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  hyperlegible: "'Atkinson Hyperlegible', Verdana, system-ui, sans-serif",
};

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
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
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
