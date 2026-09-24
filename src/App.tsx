import { useCallback, useEffect, useState } from 'react';
import Library from './components/Library';
import Reader from './components/Reader';
import { loadSettings, resolveTheme, saveSettings, type Settings } from './lib/settings';
import { resumePendingOcr } from './lib/ocr';

function readRoute(): string | null {
  const m = /^#\/read\/(.+)$/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [bookId, setBookId] = useState<string | null>(readRoute);
  const [systemDark, setSystemDark] = useState(() => {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const onHash = () => setBookId(readRoute());
    window.addEventListener('hashchange', onHash);
    let mq: MediaQueryList | null = null;
    const onScheme = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', onScheme);
    } catch {
      /* old browser */
    }
    void resumePendingOcr();
    return () => {
      window.removeEventListener('hashchange', onHash);
      mq?.removeEventListener('change', onScheme);
    };
  }, []);

  const theme = settings.theme === 'auto' ? (systemDark ? 'dark' : 'light') : resolveTheme(settings.theme);
  const { customFg, customBg } = settings;
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    // Custom theme: the user's own text and background colours.
    const vars = ['--bg', '--fg', '--surface', '--muted', '--border'];
    if (theme === 'custom') {
      const fg = customFg;
      const bg = customBg;
      root.style.setProperty('--bg', bg);
      root.style.setProperty('--fg', fg);
      root.style.setProperty('--surface', `color-mix(in srgb, ${bg} 88%, ${fg})`);
      root.style.setProperty('--muted', `color-mix(in srgb, ${fg} 70%, ${bg})`);
      root.style.setProperty('--border', `color-mix(in srgb, ${fg} 20%, ${bg})`);
    } else for (const v of vars) root.style.removeProperty(v);
    const meta = document.querySelector('meta[name="theme-color"]');
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (meta && bg) meta.setAttribute('content', bg);
  }, [theme, customFg, customBg]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const open = useCallback((id: string) => {
    window.location.hash = `#/read/${encodeURIComponent(id)}`;
  }, []);
  const close = useCallback(() => {
    if (window.history.length > 1 && readRoute()) window.history.back();
    setTimeout(() => {
      if (readRoute()) window.location.hash = '';
    }, 50);
  }, []);

  return bookId ? (
    <Reader key={bookId} bookId={bookId} settings={settings} onSettings={update} onClose={close} />
  ) : (
    <Library settings={settings} onSettings={update} onOpen={open} />
  );
}
