import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { db } from '../lib/db';
import { formatMinutes } from '../lib/format';
import { onLibraryChange } from '../lib/library';
import { ocrStore } from '../lib/ocr';
import { FONT_STACKS, type Settings } from '../lib/settings';
import { wordAt } from '../lib/sentences';
import { caretFromPoint, offsetOf, pointInRange, rangeFromOffsets, setHighlight } from '../lib/textRange';
import { Speaker, ttsSupported, type TtsPosition } from '../lib/tts';
import type { BookContent, BookMeta, Bookmark, Highlight, HighlightColor, ReadMarker, ReadingStats } from '../lib/types';
import { BlockView } from './BlockView';
import PdfPageView from './PdfPageView';
import { HL_COLORS, type SearchHit } from '../lib/annotations';
import { Dialog, Drawer, FootnotePopup, GoToDialog, ImageZoom, NoteDialog, NotesPanel, SearchPanel, StatsView } from './ReaderPanels';
import SettingsSheet from './SettingsSheet';

interface Props {
  bookId: string;
  settings: Settings;
  onSettings: (p: Partial<Settings>) => void;
  onClose: () => void;
}

type Panel = null | 'toc' | 'settings' | 'bookmarks' | 'notes' | 'search' | 'goto' | 'about';
type Target = { block: number; offset?: number } | { edge: 'start' | 'end' };

const CHARS_PER_MIN = 1500; // about 250 words per minute
const GAP = 48;

function measureCharWidth(font: string, sizePx: number, weight: number, letterSpacing: number): number {
  try {
    const c = document.createElement('canvas').getContext('2d');
    if (!c) return sizePx * 0.5;
    c.font = `${weight} ${sizePx}px ${font}`;
    const sample = 'The quick brown fox jumps over the lazy dog, and then it rests. ';
    return c.measureText(sample).width / sample.length + letterSpacing * sizePx;
  } catch {
    return sizePx * 0.5;
  }
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const newId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2);
  }
};

interface SelectionInfo {
  block: number;
  start: number;
  end: number;
  text: string;
  x: number;
  y: number;
  highlight?: Highlight; // tapped an existing highlight
}

export default function Reader({ bookId, settings, onSettings, onClose }: Props) {
  const [book, setBook] = useState<BookMeta | null>(null);
  const [content, setContent] = useState<BookContent | null>(null);
  const [missing, setMissing] = useState(false);
  const [section, setSection] = useState(0);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [current, setCurrent] = useState(0); // current block index
  const [chrome, setChrome] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [fontsReady, setFontsReady] = useState(0);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [noteFor, setNoteFor] = useState<Highlight | null>(null);
  const [footnote, setFootnote] = useState<number | null>(null);
  const [zoomSrc, setZoomSrc] = useState<string | null>(null);
  const [searchHit, setSearchHit] = useState<(SearchHit & { q: string }) | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [tts, setTts] = useState<{ playing: boolean; pos: TtsPosition | null; rate: number } | null>(null);
  const [markerBar, setMarkerBar] = useState<{ left: number; top: number; height: number } | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const [battery, setBattery] = useState<number | null>(null);
  const [toast, setToast] = useState('');
  const ocr = useSyncExternalStore(ocrStore.subscribe, ocrStore.get);

  const stageRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const target = useRef<Target | null>(null);
  const currentRef = useRef(0);
  const pointer = useRef<{ x: number; y: number; t: number } | null>(null);
  const swiped = useRef(false);
  const speaker = useRef<Speaker | null>(null);
  const lastActive = useRef(Date.now());
  const [animate, setAnimate] = useState(false);

  const isPdf = book?.format !== 'epub';
  const original = settings.mode === 'original' && isPdf;
  const paged = settings.mode === 'paged' || (settings.mode === 'original' && !isPdf);

  /* ---------------- load ---------------- */

  const load = useCallback(async (initial: boolean) => {
    try {
      const [b, c] = await Promise.all([db.getBook(bookId), db.getContent(bookId)]);
      if (!b || !c) {
        setMissing(true);
        return;
      }
      setBook(b);
      setContent(c);
      const clampB = (n: number) => Math.min(n, Math.max(0, c.blocks.length - 1));
      if (initial) {
        // Open at the last-read marker if there is one, so the eyes land on it.
        const m = b.marker && b.marker.block < c.blocks.length ? b.marker : null;
        const pos = clampB(m ? m.block : b.position);
        const si = Math.max(0, c.sections.findIndex((s) => pos >= s.start && pos < s.end));
        setSection(si);
        setCurrent(pos);
        currentRef.current = pos;
        target.current = { block: pos, offset: m?.start };
      } else {
        // Content grew (scanning). Keep the reader on the same block.
        const pos = clampB(currentRef.current);
        const si = Math.max(0, c.sections.findIndex((s) => pos >= s.start && pos < s.end));
        setSection(si);
        target.current = { block: pos };
      }
    } catch {
      setMissing(true);
    }
  }, [bookId]);

  useEffect(() => {
    // Async IndexedDB read; state is set when it resolves.
    // oxlint-disable-next-line react/set-state-in-effect
    void load(true);
    return onLibraryChange((id) => {
      if (id === bookId) void load(false);
    });
  }, [bookId, load]);

  useEffect(() => {
    let alive = true;
    try {
      void document.fonts?.ready.then(() => alive && setFontsReady((n) => n + 1));
    } catch {
      /* ignore */
    }
    return () => {
      alive = false;
    };
  }, [settings.font, settings.fontWeight]);

  const updateBook = useCallback(
    async (patch: Partial<BookMeta>) => {
      const next = await db.updateBook(bookId, patch);
      if (next) setBook(next);
      return next;
    },
    [bookId],
  );

  /* ---------------- save position ---------------- */

  const progress = useMemo(() => {
    if (!content || !content.blocks.length) return 0;
    const total = content.charIndex[content.charIndex.length - 1] || 1;
    const sec = content.sections[section];
    if (paged && sec && pageCount > 1) {
      const a = content.charIndex[sec.start];
      const b = content.charIndex[sec.end];
      return Math.min(1, (a + ((b - a) * page) / pageCount) / total);
    }
    return Math.min(1, content.charIndex[current] / total);
  }, [content, section, page, pageCount, current, paged]);

  useEffect(() => {
    if (!book) return;
    const t = setTimeout(() => {
      void db.updateBook(bookId, { position: current, progress, lastReadAt: Date.now(), readingStatus: book.readingStatus && book.readingStatus !== 'to-read' && book.readingStatus !== 'none' ? book.readingStatus : 'reading' }).catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [book, bookId, current, progress]);

  /* ---------------- reading stats ---------------- */

  const statsRef = useRef<{ seconds: number; chars: number; lastChar: number | null }>({ seconds: 0, chars: 0, lastChar: null });
  useEffect(() => {
    if (!content) return;
    const c = content.charIndex[current] ?? 0;
    const s = statsRef.current;
    if (s.lastChar !== null && c > s.lastChar && c - s.lastChar < 20000) s.chars += c - s.lastChar;
    s.lastChar = c;
  }, [content, current]);
  useEffect(() => {
    const bump = () => (lastActive.current = Date.now());
    window.addEventListener('pointerdown', bump);
    window.addEventListener('keydown', bump);
    const tick = setInterval(() => {
      if (document.visibilityState === 'visible' && (Date.now() - lastActive.current < 120000 || speaker.current?.position)) statsRef.current.seconds += 15;
    }, 15000);
    const flush = setInterval(() => void flushStats(), 60000);
    const flushStats = async () => {
      const s = statsRef.current;
      if (!s.seconds && !s.chars) return;
      const add = { seconds: s.seconds, chars: s.chars };
      s.seconds = 0;
      s.chars = 0;
      const b = await db.getBook(bookId);
      if (!b) return;
      const st: ReadingStats = b.stats ?? { seconds: 0, days: {} };
      const d = st.days[today()] ?? { seconds: 0, chars: 0 };
      const next: ReadingStats = { seconds: st.seconds + add.seconds, days: { ...st.days, [today()]: { seconds: d.seconds + add.seconds, chars: d.chars + add.chars } } };
      await db.updateBook(bookId, { stats: next });
    };
    return () => {
      window.removeEventListener('pointerdown', bump);
      window.removeEventListener('keydown', bump);
      clearInterval(tick);
      clearInterval(flush);
      void flushStats();
    };
  }, [bookId]);

  /* ---------------- keep screen on, clock, battery ---------------- */

  useEffect(() => {
    if (!settings.keepAwake) return;
    let lock: { release: () => Promise<void> } | null = null;
    const get = async () => {
      try {
        const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
        if (document.visibilityState === 'visible') lock = (await nav.wakeLock?.request('screen')) ?? null;
      } catch {
        lock = null;
      }
    };
    void get();
    const vis = () => void get();
    document.addEventListener('visibilitychange', vis);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      void lock?.release().catch(() => undefined);
    };
  }, [settings.keepAwake]);

  useEffect(() => {
    if (!settings.statusClock) return;
    const t = setInterval(() => setClock(new Date()), 20000);
    return () => clearInterval(t);
  }, [settings.statusClock]);

  useEffect(() => {
    if (!settings.statusBattery) return;
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; addEventListener: (e: string, f: () => void) => void }> };
    let alive = true;
    void nav.getBattery?.().then((b) => {
      const upd = () => alive && setBattery(Math.round(b.level * 100));
      upd();
      b.addEventListener('levelchange', upd);
    });
    return () => {
      alive = false;
    };
  }, [settings.statusBattery]);

  /* ---------------- layout metrics ---------------- */

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setStageSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setStageSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [content, paged, original]);

  const fontStack = FONT_STACKS[settings.font];
  // fontsReady forces a re-measure once web fonts finish loading.
  const charW = useMemo(
    () => (fontsReady >= 0 ? measureCharWidth(fontStack, settings.fontSize, settings.fontWeight, settings.letterSpacing) : 0),
    [fontStack, settings.fontSize, settings.fontWeight, settings.letterSpacing, fontsReady],
  );

  const mx = settings.marginLeft + settings.marginRight;
  const layout = useMemo(() => {
    const innerW = Math.max(200, stageSize.w - mx);
    const lineW = Math.min(innerW, Math.round(settings.maxWidth * charW));
    const spread = paged && settings.spread && stageSize.w >= 1000 && stageSize.w > stageSize.h * 1.2 && innerW >= lineW * 2 + GAP;
    const flowW = spread ? lineW * 2 + GAP : lineW;
    return { lineW, flowW, spread, stride: flowW + GAP, colStride: spread ? lineW + GAP : flowW + GAP };
  }, [stageSize, mx, settings.maxWidth, settings.spread, charW, paged]);

  const layoutKey = [
    settings.fontSize, settings.lineHeight, settings.font, settings.fontWeight, settings.align, settings.hyphens, settings.letterSpacing,
    settings.wordSpacing, settings.paragraphSpacing, settings.indent, settings.publisherStyles, settings.boldStarts, settings.marginTop, settings.marginBottom,
  ].join('|');

  /* ---------------- pagination ---------------- */

  const blockEls = useCallback((): HTMLElement[] => {
    const root = paged ? flowRef.current : scrollerRef.current;
    return root ? Array.from(root.querySelectorAll<HTMLElement>('[data-i]')) : [];
  }, [paged]);

  const pageOfX = useCallback(
    (left: number): number => {
      const flow = flowRef.current;
      if (!flow) return 0;
      const off = left - flow.getBoundingClientRect().left;
      return Math.max(0, Math.floor((off + 2) / layout.stride));
    },
    [layout.stride],
  );
  const pageOf = useCallback((el: HTMLElement) => pageOfX(el.getBoundingClientRect().left), [pageOfX]);

  /** Page holding character `offset` of block `block` (for the marker and search hits). */
  const pageOfOffset = useCallback(
    (block: number, offset: number): number | null => {
      const el = flowRef.current?.querySelector<HTMLElement>(`[data-i="${block}"]`);
      if (!el) return null;
      const r = rangeFromOffsets(el, offset, Math.min(offset + 1, (el.textContent ?? '').length));
      const rect = r?.getClientRects()[0];
      return rect ? pageOfX(rect.left) : pageOf(el);
    },
    [pageOf, pageOfX],
  );

  /** Figure out which block is at the top of the given page. */
  const blockAtPage = useCallback(
    (p: number): number | null => {
      const els = blockEls();
      const flow = flowRef.current;
      if (!els.length || !flow) return null;
      const top = flow.getBoundingClientRect().top;
      for (let i = 0; i < els.length; i++) {
        if (pageOf(els[i]) >= p) {
          const atTop = els[i].getBoundingClientRect().top - top < 4;
          const el = !atTop && i > 0 ? els[i - 1] : els[i];
          return Number(el.dataset.i);
        }
      }
      return Number(els[els.length - 1].dataset.i);
    },
    [blockEls, pageOf],
  );

  // After render or layout change: count pages and go to the target spot.
  useLayoutEffect(() => {
    if (!content || !paged || original) return;
    const flow = flowRef.current;
    if (!flow) return;
    const els = blockEls();
    let count = 1;
    if (els.length) {
      const last = els[els.length - 1];
      const rects = last.getClientRects();
      const r = rects[rects.length - 1] ?? last.getBoundingClientRect();
      const off = r.right - flow.getBoundingClientRect().left;
      count = Math.max(1, Math.ceil((off - 2) / layout.stride));
    }
    setPageCount(count);
    const t = target.current ?? { block: currentRef.current };
    target.current = null;
    let p = 0;
    if ('edge' in t) p = t.edge === 'end' ? count - 1 : 0;
    else {
      const byOffset = t.offset !== undefined ? pageOfOffset(t.block, t.offset) : null;
      const el = flow.querySelector<HTMLElement>(`[data-i="${t.block}"]`);
      p = Math.min(count - 1, byOffset ?? (el ? pageOf(el) : 0));
    }
    setAnimate(false);
    setPage(p);
    const b = 'block' in t ? t.block : blockAtPage(p);
    if (b !== null) {
      currentRef.current = b;
      setCurrent(b);
    }
  }, [content, section, paged, original, layout, layoutKey, fontsReady, blockEls, pageOf, pageOfOffset, blockAtPage]);

  // Scroll mode: jump to target after render.
  useLayoutEffect(() => {
    if (!content || paged || original) return;
    const sc = scrollerRef.current;
    if (!sc) return;
    const t = target.current ?? { block: currentRef.current };
    target.current = null;
    if ('edge' in t) sc.scrollTop = t.edge === 'end' ? sc.scrollHeight : 0;
    else {
      const el = sc.querySelector<HTMLElement>(`[data-i="${t.block}"]`);
      const sec = content.sections[section];
      if (el && sec && (t.block !== sec.start || t.offset)) {
        let top = el.offsetTop - 16;
        if (t.offset !== undefined) {
          const rect = rangeFromOffsets(el, t.offset, t.offset + 1)?.getClientRects()[0];
          if (rect) top = sc.scrollTop + rect.top - sc.getBoundingClientRect().top - sc.clientHeight / 3;
        }
        sc.scrollTop = top;
      } else sc.scrollTop = 0;
    }
  }, [content, section, paged, original, layout, layoutKey, fontsReady]);

  const onScroll = useCallback(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const top = sc.getBoundingClientRect().top;
    const els = blockEls();
    for (const el of els) {
      if (el.getBoundingClientRect().bottom > top + 8) {
        const b = Number(el.dataset.i);
        if (b !== currentRef.current) {
          currentRef.current = b;
          setCurrent(b);
        }
        break;
      }
    }
  }, [blockEls]);

  /* ---------------- navigation ---------------- */

  const goToBlock = useCallback(
    (block: number, opts: { offset?: number; remember?: boolean; keepPanel?: boolean } = {}) => {
      if (!content) return;
      if (opts.remember) setHistory((h) => [...h.slice(-19), currentRef.current]);
      const si = Math.max(0, content.sections.findIndex((s) => block >= s.start && block < s.end));
      target.current = { block, offset: opts.offset };
      currentRef.current = block;
      setCurrent(block);
      if (si === section) {
        if (paged) {
          const p = opts.offset !== undefined ? pageOfOffset(block, opts.offset) : null;
          const el = flowRef.current?.querySelector<HTMLElement>(`[data-i="${block}"]`);
          if (p !== null) setPage(p);
          else if (el) setPage(pageOf(el));
          target.current = null;
        } else if (scrollerRef.current) {
          const sc = scrollerRef.current;
          const el = sc.querySelector<HTMLElement>(`[data-i="${block}"]`);
          const rect = el && opts.offset !== undefined ? rangeFromOffsets(el, opts.offset, opts.offset + 1)?.getClientRects()[0] : null;
          if (rect) sc.scrollTop += rect.top - sc.getBoundingClientRect().top - sc.clientHeight / 3;
          else if (el) sc.scrollTop = el.offsetTop - 16;
          target.current = null;
        }
      } else setSection(si);
      if (!opts.keepPanel) setPanel(null);
      setChrome(false);
    },
    [content, section, paged, pageOf, pageOfOffset],
  );

  const goBack = () => {
    setHistory((h) => {
      const last = h[h.length - 1];
      if (last !== undefined) goToBlock(last);
      return h.slice(0, -1);
    });
  };

  const setMarker = useCallback(
    async (m: ReadMarker | undefined) => {
      await updateBook({ marker: m });
    },
    [updateBook],
  );

  /** Auto-mark: the last word on the page being left (paged mode, turning forward). */
  const autoMarkPage = useCallback(() => {
    const flow = flowRef.current;
    const stage = stageRef.current;
    if (!flow || !stage || !content) return;
    const vr = flow.parentElement!.getBoundingClientRect();
    const lh = settings.fontSize * settings.lineHeight;
    // Probe from the bottom-right of the (right-hand) column upward until a word is found.
    for (let y = vr.bottom - lh / 2; y > vr.top; y -= lh / 2) {
      for (let x = vr.right - 4; x > vr.right - layout.lineW; x -= settings.fontSize) {
        const c = caretFromPoint(x, y);
        const el = c && (c.node.nodeType === 3 ? c.node.parentElement : (c.node as Element))?.closest<HTMLElement>('[data-i]');
        if (!c || !el) continue;
        const idx = Number(el.dataset.i);
        const text = content.blocks[idx]?.text ?? '';
        const w = wordAt(text, offsetOf(el, c.node, c.offset));
        if (w) {
          void setMarker({ block: idx, start: w.start, end: w.end, at: Date.now() });
          return;
        }
      }
    }
  }, [content, layout.lineW, settings.fontSize, settings.lineHeight, setMarker]);

  const turn = useCallback(
    (dir: 1 | -1) => {
      if (!content) return;
      setSelection(null);
      if (!paged) {
        const sc = scrollerRef.current;
        if (!sc) return;
        const atEnd = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
        const atStart = sc.scrollTop <= 0;
        if (dir === 1 && atEnd && section < content.sections.length - 1) {
          target.current = { edge: 'start' };
          setSection(section + 1);
        } else if (dir === -1 && atStart && section > 0) {
          target.current = { edge: 'end' };
          setSection(section - 1);
        } else sc.scrollBy({ top: dir * sc.clientHeight * 0.9, behavior: reducedMotion() || !settings.pageAnimation ? 'auto' : 'smooth' });
        return;
      }
      if (dir === 1 && settings.autoMark) autoMarkPage();
      const np = page + dir;
      if (np >= 0 && np < pageCount) {
        setAnimate(settings.pageAnimation && !reducedMotion());
        setPage(np);
        const b = blockAtPage(np);
        if (b !== null) {
          currentRef.current = b;
          setCurrent(b);
        }
      } else if (dir === 1 && section < content.sections.length - 1) {
        target.current = { edge: 'start' };
        setSection(section + 1);
      } else if (dir === -1 && section > 0) {
        target.current = { edge: 'end' };
        setSection(section - 1);
      }
    },
    [content, paged, page, pageCount, section, blockAtPage, settings.pageAnimation, settings.autoMark, autoMarkPage],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (panel || noteFor || footnote !== null || zoomSrc) {
        if (e.key === 'Escape') {
          setPanel(null);
          setNoteFor(null);
          setFootnote(null);
          setZoomSrc(null);
        }
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      // Media/volume-style keys some keyboards and page turners send are handled too.
      if (['ArrowRight', 'PageDown', ' ', 'MediaTrackNext', 'AudioVolumeDown'].includes(e.key) && !(e.key === ' ' && !paged)) {
        e.preventDefault();
        turn(1);
      } else if (['ArrowLeft', 'PageUp', 'MediaTrackPrevious', 'AudioVolumeUp'].includes(e.key)) {
        e.preventDefault();
        turn(-1);
      } else if (e.key === 'Escape') setChrome((c) => !c);
      else if (e.key === 'm' || e.key === 'M') onSettings({ markMode: !settings.markMode });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [turn, panel, paged, noteFor, footnote, zoomSrc, onSettings, settings.markMode]);

  /* ---------------- taps: links, images, marker, zones ---------------- */

  const onPointerDown = (e: React.PointerEvent) => {
    pointer.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    swiped.current = false;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const p = pointer.current;
    pointer.current = null;
    if (!p || !paged) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - p.t < 800) {
      swiped.current = true;
      turn(dx < 0 ? 1 : -1);
    }
  };

  /** The word under a screen point, if the point is really on it. */
  const wordAtPoint = (x: number, y: number) => {
    if (!content) return null;
    const c = caretFromPoint(x, y);
    if (!c) return null;
    const host = c.node.nodeType === 3 ? c.node.parentElement : (c.node as Element);
    const el = host?.closest<HTMLElement>('[data-i]');
    if (!el || !(paged ? flowRef.current : scrollerRef.current)?.contains(el)) return null;
    const idx = Number(el.dataset.i);
    const text = content.blocks[idx]?.text ?? '';
    const w = wordAt(text, offsetOf(el, c.node, c.offset));
    if (!w) return null;
    const r = rangeFromOffsets(el, w.start, w.end);
    if (!r || !pointInRange(r, x, y)) return null;
    return { block: idx, ...w };
  };

  const highlightAtPoint = (x: number, y: number): Highlight | null => {
    const hs = book?.highlights ?? [];
    for (const h of hs) {
      const el = (paged ? flowRef.current : scrollerRef.current)?.querySelector<HTMLElement>(`[data-i="${h.block}"]`);
      const r = el && rangeFromOffsets(el, h.start, h.end);
      if (r && pointInRange(r, x, y, 0)) return h;
    }
    return null;
  };

  const handleLink = (a: HTMLElement) => {
    if (!content) return;
    const ext = a.dataset.ext;
    if (ext) {
      if (window.confirm(`Open ${ext} in a new tab?`)) window.open(ext, '_blank', 'noopener');
      return;
    }
    const href = a.dataset.href ?? '';
    const idx = content.anchors?.[href] ?? content.anchors?.[href.split('#')[0]];
    if (idx === undefined) return;
    const isNote = a.dataset.note === '1' || /footnote/.test(content.blocks[idx]?.cls ?? '');
    if (isNote) setFootnote(idx);
    else goToBlock(idx, { remember: true });
  };

  const onStageClick = (e: React.MouseEvent) => {
    if (swiped.current) {
      swiped.current = false;
      return;
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const el = e.target as HTMLElement;
    if (el.closest('button, input, .marker-bar')) return;
    const link = el.closest<HTMLElement>('a[data-href], a[data-ext]');
    if (link) {
      handleLink(link);
      return;
    }
    if (selection) {
      setSelection(null);
      return;
    }
    if (chrome) {
      setChrome(false);
      return;
    }
    // Marking mode: a tap on a word marks it (tap the marked word again to clear).
    if (settings.markMode) {
      const w = wordAtPoint(e.clientX, e.clientY);
      if (w) {
        const m = book?.marker;
        if (m && m.block === w.block && m.start === w.start) void setMarker(undefined);
        else void setMarker({ block: w.block, start: w.start, end: w.end, at: Date.now() });
        return;
      }
    }
    const img = el.closest('img[data-zoom]') as HTMLImageElement | null;
    if (img) {
      setZoomSrc(img.src);
      return;
    }
    const h = highlightAtPoint(e.clientX, e.clientY);
    if (h) {
      setSelection({ block: h.block, start: h.start, end: h.end, text: h.text, x: e.clientX, y: e.clientY, highlight: h });
      return;
    }
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return;
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const zone: -1 | 0 | 1 =
      settings.tapLayout === 'top-bottom'
        ? x > 0.3 && x < 0.7 && y > 0.35 && y < 0.65 ? 0 : y < 0.5 ? -1 : 1
        : settings.tapLayout === 'mostly-forward'
          ? x < 0.2 ? -1 : x > 0.35 && x < 0.65 && y > 0.3 && y < 0.7 ? 0 : 1
          : x < 0.3 ? -1 : x > 0.7 ? 1 : 0;
    if (zone === 0) setChrome(true);
    else turn(zone);
  };

  /* ---------------- text selection -> highlight / note / lookup ---------------- */

  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount || !content) return;
      const r = sel.getRangeAt(0);
      const root = paged ? flowRef.current : scrollerRef.current;
      if (!root || !root.contains(r.commonAncestorContainer)) return;
      const startEl = (r.startContainer.nodeType === 3 ? r.startContainer.parentElement : (r.startContainer as Element))?.closest<HTMLElement>('[data-i]');
      if (!startEl) return;
      const idx = Number(startEl.dataset.i);
      const text = content.blocks[idx]?.text ?? '';
      const start = offsetOf(startEl, r.startContainer, r.startOffset);
      const end = startEl.contains(r.endContainer) ? offsetOf(startEl, r.endContainer, r.endOffset) : text.length;
      if (end <= start) return;
      const rect = r.getBoundingClientRect();
      setSelection({ block: idx, start, end, text: text.slice(start, end), x: rect.left + rect.width / 2, y: rect.top });
    };
    let t: ReturnType<typeof setTimeout>;
    const deb = () => {
      clearTimeout(t);
      t = setTimeout(onSel, 300);
    };
    document.addEventListener('selectionchange', deb);
    return () => {
      document.removeEventListener('selectionchange', deb);
      clearTimeout(t);
    };
  }, [content, paged]);

  const addHighlight = async (color: HighlightColor, withNote = false) => {
    if (!selection || !book) return;
    let hs = book.highlights ?? [];
    let h: Highlight;
    if (selection.highlight) {
      h = { ...selection.highlight, color };
      hs = hs.map((x) => (x.id === h.id ? h : x));
    } else {
      h = { id: newId(), block: selection.block, start: selection.start, end: selection.end, color, text: selection.text, createdAt: Date.now() };
      hs = [...hs, h];
    }
    await updateBook({ highlights: hs });
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    if (withNote) setNoteFor(h);
  };

  const deleteHighlight = async (h: Highlight) => {
    if (!book) return;
    await updateBook({ highlights: (book.highlights ?? []).filter((x) => x.id !== h.id) });
    setSelection(null);
  };

  const saveNote = async (h: Highlight, note: string) => {
    if (!book) return;
    await updateBook({ highlights: (book.highlights ?? []).map((x) => (x.id === h.id ? { ...x, note: note || undefined } : x)) });
    setNoteFor(null);
  };

  const lookup = (kind: 'define' | 'translate') => {
    if (!selection) return;
    const q = selection.text.trim().slice(0, 200);
    const lang = (book?.lang || 'en').slice(0, 2);
    const ui = (navigator.language || 'en').slice(0, 2);
    const url =
      kind === 'define'
        ? q.split(/\s+/).length === 1
          ? `https://${lang}.wiktionary.org/wiki/${encodeURIComponent(q.toLowerCase())}`
          : `https://www.google.com/search?q=${encodeURIComponent(`define ${q}`)}`
        : `https://translate.google.com/?sl=auto&tl=${ui === lang ? 'en' : ui}&text=${encodeURIComponent(q)}&op=translate`;
    window.open(url, '_blank', 'noopener');
  };

  const copySelection = async () => {
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(selection.text);
      setToast('Copied');
    } catch {
      setToast('Copy is not allowed here');
    }
    setSelection(null);
  };

  /* ---------------- text to speech ---------------- */

  const stopTts = useCallback(() => {
    speaker.current?.stop();
    speaker.current = null;
    setTts(null);
    setHighlight('er-tts', []);
  }, []);
  useEffect(() => () => speaker.current?.stop(), []);

  const startTts = (fromBlock?: number, offset = 0) => {
    if (!content || !ttsSupported()) {
      setToast('Read aloud is not available in this browser.');
      return;
    }
    speaker.current?.stop();
    const sp = new Speaker(
      (i) => (i < content.blocks.length ? content.blocks[i].text : null),
      (pos) => setTts((t) => ({ playing: true, pos, rate: t?.rate ?? sp.rate })),
      () => setTts(null),
    );
    sp.lang = book?.lang || 'en';
    sp.rate = tts?.rate ?? 1;
    speaker.current = sp;
    const m = book?.marker;
    const from = fromBlock ?? (m && m.block >= current ? m.block : current);
    const off = fromBlock !== undefined ? offset : m && m.block === from ? m.start : 0;
    setTts({ playing: true, pos: null, rate: sp.rate });
    sp.start(from, off);
    setChrome(false);
  };

  // Keep the sentence being read on screen.
  useEffect(() => {
    const pos = tts?.pos;
    if (!pos || !content) return;
    const sec = content.sections[section];
    if (!sec || pos.block < sec.start || pos.block >= sec.end) {
      goToBlock(pos.block, { offset: pos.start, keepPanel: true });
      return;
    }
    if (paged) {
      const p = pageOfOffset(pos.block, pos.start);
      if (p !== null && p !== page) {
        setAnimate(false);
        setPage(p);
      }
    } else {
      const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-i="${pos.block}"]`);
      const rect = el && rangeFromOffsets(el, pos.start, pos.end)?.getBoundingClientRect();
      const sc = scrollerRef.current;
      if (rect && sc) {
        const sr = sc.getBoundingClientRect();
        if (rect.top < sr.top + 40 || rect.bottom > sr.bottom - 40) sc.scrollTop += rect.top - sr.top - sc.clientHeight / 3;
      }
    }
    // Only react to a new sentence; the navigation helpers are stable enough for this.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tts?.pos]);

  /* ---------------- drawing: highlights, search hit, TTS, marker ---------------- */

  useLayoutEffect(() => {
    if (!content || original) {
      setMarkerBar(null);
      return;
    }
    const root = paged ? flowRef.current : scrollerRef.current;
    if (!root) return;
    const sec = content.sections[section];
    const inSec = (b: number) => !!sec && b >= sec.start && b < sec.end;
    const range = (b: number, s: number, e: number) => {
      const el = root.querySelector<HTMLElement>(`[data-i="${b}"]`);
      return el ? rangeFromOffsets(el, s, e) : null;
    };
    const byColor: Record<string, Range[]> = { yellow: [], green: [], blue: [], pink: [] };
    for (const h of book?.highlights ?? []) {
      if (!inSec(h.block)) continue;
      const r = range(h.block, h.start, h.end);
      if (r) byColor[h.color].push(r);
    }
    for (const c of HL_COLORS) setHighlight(`er-hl-${c}`, byColor[c]);
    const sh = searchHit && inSec(searchHit.block) ? range(searchHit.block, searchHit.start, searchHit.end) : null;
    setHighlight('er-search', sh ? [sh] : []);
    const tp = tts?.pos;
    const tr = tp && inSec(tp.block) ? range(tp.block, tp.start, tp.end) : null;
    setHighlight('er-tts', tr ? [tr] : []);

    // Last-read marker.
    const m = book?.marker;
    const show = !!m && settings.markerStyle !== 'none' && inSec(m.block);
    const mr = show && m ? range(m.block, m.start, m.end) : null;
    setHighlight('er-mark', mr && settings.markerStyle === 'underline' ? [mr] : []);
    const before = m && settings.markerDim && inSec(m.block) ? range(m.block, 0, m.start) : null;
    setHighlight('er-before', before ? [before] : []);
    if (mr && settings.markerStyle === 'bar') {
      const rect = mr.getClientRects()[0];
      const host = paged ? flowRef.current : (scrollerRef.current?.firstElementChild as HTMLElement | null);
      const hr = host?.getBoundingClientRect();
      if (rect && hr) {
        const relX = rect.left - hr.left;
        const colLeft = paged ? Math.floor((relX + 2) / layout.colStride) * layout.colStride : 0;
        setMarkerBar({ left: colLeft - 12, top: rect.top - hr.top, height: rect.height });
      } else setMarkerBar(null);
    } else setMarkerBar(null);
  }, [content, section, page, paged, original, layout, layoutKey, fontsReady, book?.highlights, book?.marker, searchHit, tts?.pos, settings.markerStyle, settings.markerDim]);

  useEffect(
    () => () => {
      for (const n of ['er-hl-yellow', 'er-hl-green', 'er-hl-blue', 'er-hl-pink', 'er-search', 'er-tts', 'er-mark', 'er-before']) setHighlight(n, []);
    },
    [],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  /* ---------------- derived ---------------- */

  const chapter = useMemo(() => {
    if (!content) return { title: '', end: 0, index: -1 };
    let idx = -1;
    content.toc.forEach((t, i) => {
      if (t.block <= current) idx = i;
    });
    const nextTop = content.toc.find((t, i) => i > idx && t.block > current && t.level <= (content.toc[idx]?.level ?? 0));
    return {
      title: idx >= 0 ? content.toc[idx].title : content.sections[section]?.title ?? '',
      end: nextTop ? nextTop.block : content.blocks.length,
      index: idx,
    };
  }, [content, current, section]);

  const minutesLeft = useMemo(() => {
    if (!content) return 0;
    let from = content.charIndex[current] ?? 0;
    const sec = content.sections[section];
    if (paged && sec && pageCount > 1) {
      const a = content.charIndex[sec.start];
      const b = content.charIndex[sec.end];
      from = Math.max(from, a + ((b - a) * page) / pageCount);
    }
    return Math.max(0, (content.charIndex[chapter.end] - from) / CHARS_PER_MIN);
  }, [content, current, chapter.end, paged, section, page, pageCount]);

  const isBookmarked = !!book?.bookmarks.some((b) => b.block === current);
  const toggleBookmark = async () => {
    if (!book || !content) return;
    const list: Bookmark[] = isBookmarked
      ? book.bookmarks.filter((b) => b.block !== current)
      : [...book.bookmarks, { block: current, snippet: content.blocks[current]?.text.slice(0, 120) ?? '', createdAt: Date.now() }].sort((a, b) => a.block - b.block);
    await updateBook({ bookmarks: list });
  };

  const goToPercentOrPage = (kind: 'percent' | 'page', n: number) => {
    if (!content) return;
    if (kind === 'page') {
      const idx = content.blocks.findIndex((b) => b.page >= n);
      if (idx >= 0) goToBlock(idx, { remember: true });
      return;
    }
    const total = content.charIndex[content.charIndex.length - 1];
    const want = (Math.min(100, Math.max(0, n)) / 100) * total;
    let lo = 0;
    let hi = content.blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (content.charIndex[mid] <= want) lo = mid;
      else hi = mid - 1;
    }
    goToBlock(Math.max(0, lo), { remember: true });
  };

  const onPdfPage = useCallback(
    (p: number) => {
      if (!content) return;
      const idx = content.blocks.findIndex((b) => b.page >= p);
      if (idx >= 0 && idx !== currentRef.current) {
        currentRef.current = idx;
        setCurrent(idx);
      }
    },
    [content],
  );

  /* ---------------- render ---------------- */

  if (missing) {
    return (
      <div className="reader-msg">
        <p>This book could not be found on this device.</p>
        <button className="btn btn-primary" onClick={onClose}>Back to library</button>
      </div>
    );
  }
  if (!content || !book) return <div className="reader-msg" aria-busy="true">Opening...</div>;

  const sec = content.sections[section] ?? { start: 0, end: 0, title: '' };
  const blocks = content.blocks.slice(sec.start, sec.end);
  const scanning = book.status === 'ocr' && ocr.bookId === bookId && (ocr.state === 'running' || ocr.state === 'loading');
  const langAttr = book.lang || 'en';
  const marker = book.marker;
  const pub = settings.publisherStyles && !!book.css;

  const flowStyle: React.CSSProperties = {
    fontFamily: fontStack,
    fontSize: `${settings.fontSize}px`,
    fontWeight: settings.fontWeight,
    lineHeight: settings.lineHeight,
    letterSpacing: settings.letterSpacing ? `${settings.letterSpacing}em` : undefined,
    wordSpacing: settings.wordSpacing ? `${settings.wordSpacing}em` : undefined,
    textAlign: settings.align,
    hyphens: settings.hyphens ? 'auto' : 'manual',
    WebkitHyphens: settings.hyphens ? 'auto' : 'manual',
    ['--para-gap' as string]: `${settings.paragraphSpacing}em`,
    ['--fw' as string]: settings.fontWeight,
    ['--indent' as string]: `${settings.indent}em`,
    ['--page-h' as string]: `${Math.max(120, stageSize.h - settings.marginTop - settings.marginBottom - 16)}px`,
  };

  const renderBlocks = () =>
    blocks.length ? (
      blocks.map((b, k) => {
        const i = sec.start + k;
        return <BlockView key={i} block={b} index={i} bookId={bookId} read={!!marker && settings.markerDim && i < marker.block} bold={settings.boldStarts} />;
      })
    ) : (
      <p className="b-p muted" data-i={0}>
        {book.status === 'ocr' ? 'Scanning the first pages. Text will appear here in a moment...' : 'No readable text was found in this book.'}
      </p>
    );

  const bar = markerBar && <span className="marker-bar" aria-hidden="true" style={{ left: markerBar.left, top: markerBar.top, height: markerBar.height }} />;
  const nextSection = section < content.sections.length - 1;
  const pagesLeft = paged ? Math.max(0, pageCount - page - 1) : null;
  const pdfPage = content.blocks[current]?.page ?? 1;

  return (
    <div className={`reader${chrome ? ' chrome-on' : ''}${settings.markMode ? ' mark-mode' : ''}`} lang={langAttr}>
      {pub && <style>{book.css}</style>}
      <header className="topbar" aria-hidden={!chrome} inert={!chrome}>
        <button className="icon-btn" onClick={onClose} aria-label="Back to library">
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <p className="topbar-title">{book.title}</p>
        <button className="icon-btn" onClick={() => setPanel('search')} aria-label="Search in book">
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
        </button>
        <button className="icon-btn" onClick={() => (tts ? stopTts() : startTts())} aria-label={tts ? 'Stop reading aloud' : 'Read aloud'} aria-pressed={!!tts}>
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" /></svg>
        </button>
        <button className={`icon-btn${isBookmarked ? ' active' : ''}`} onClick={() => void toggleBookmark()} aria-pressed={isBookmarked} aria-label={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}>
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill={isBookmarked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"><path d="M6 3h12v18l-6-4-6 4z" /></svg>
        </button>
      </header>

      {scanning && (
        <p className="scan-banner" role="status">
          Scanning pages {ocr.done} of {ocr.total}. New text appears as it is ready.
        </p>
      )}

      <main
        ref={stageRef}
        className={`stage ${original ? 'original' : paged ? 'paged' : 'scroll'}`}
        style={{
          paddingLeft: paged ? settings.marginLeft : 0,
          paddingRight: paged ? settings.marginRight : 0,
          paddingTop: paged ? `calc(${settings.marginTop}px + var(--safe-top))` : 0,
          paddingBottom: paged ? settings.marginBottom : 0,
        }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onClick={original ? undefined : onStageClick}
        aria-label="Book text"
      >
        {original ? (
          <PdfPageView bookId={bookId} pageCount={book.pageCount} startPage={pdfPage} crop={settings.pdfCrop} zoom={settings.pdfZoom} onPage={onPdfPage} />
        ) : paged ? (
          <div className="viewport" style={{ width: layout.flowW }}>
            <div
              ref={flowRef}
              className={`flow${animate ? ' animate' : ''}${pub ? ' pub' : ''}`}
              style={{
                ...flowStyle,
                width: layout.flowW,
                columnCount: layout.spread ? 2 : 1,
                columnGap: GAP,
                transform: `translateX(${-page * layout.stride}px)`,
              }}
            >
              {renderBlocks()}
              {bar}
            </div>
          </div>
        ) : (
          <div ref={scrollerRef} className="scroller" onScroll={onScroll} style={{ paddingTop: `calc(${settings.marginTop}px + var(--safe-top))` }}>
            <div className={`flow-scroll${pub ? ' pub' : ''}`} style={{ ...flowStyle, maxWidth: layout.lineW, paddingLeft: settings.marginLeft, paddingRight: settings.marginRight, boxSizing: 'content-box' }}>
              {section > 0 && (
                <button className="btn section-nav" onClick={(e) => { e.stopPropagation(); target.current = { edge: 'end' }; setSection(section - 1); }}>
                  Back: {content.sections[section - 1].title}
                </button>
              )}
              {renderBlocks()}
              {bar}
              {nextSection && (
                <button className="btn btn-primary section-nav" onClick={(e) => { e.stopPropagation(); target.current = { edge: 'start' }; setSection(section + 1); }}>
                  Next: {content.sections[section + 1].title}
                </button>
              )}
            </div>
          </div>
        )}
      </main>

      {settings.ruler && !original && <Ruler y={settings.rulerY} height={settings.fontSize * settings.lineHeight * 1.15} onMove={(y) => onSettings({ rulerY: y })} />}
      {settings.dim > 0 && <div className="dim-overlay" style={{ opacity: settings.dim }} aria-hidden="true" />}

      {history.length > 0 && (
        <button className="back-chip" onClick={goBack}>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M15 18l-6-6 6-6" /></svg>
          Back
        </button>
      )}

      {tts && (
        <div className="tts-bar" role="group" aria-label="Read aloud">
          <button className="btn btn-small" onClick={() => {
            if (tts.playing) {
              speaker.current?.pause();
              setTts({ ...tts, playing: false });
            } else {
              speaker.current?.resume();
              setTts({ ...tts, playing: true });
            }
          }}>{tts.playing ? 'Pause' : 'Play'}</button>
          <button className="btn btn-small" aria-label="Slower" onClick={() => {
            const r = Math.max(0.5, Math.round((tts.rate - 0.1) * 10) / 10);
            speaker.current?.setRate(r);
            setTts({ ...tts, rate: r });
          }}>−</button>
          <span className="tts-rate">{tts.rate.toFixed(1)}×</span>
          <button className="btn btn-small" aria-label="Faster" onClick={() => {
            const r = Math.min(2.5, Math.round((tts.rate + 0.1) * 10) / 10);
            speaker.current?.setRate(r);
            setTts({ ...tts, rate: r });
          }}>+</button>
          <button className="btn btn-small" onClick={stopTts}>Stop</button>
        </div>
      )}

      {selection && (
        <div
          className="sel-menu"
          role="toolbar"
          aria-label="Selected text"
          style={{ left: Math.min(Math.max(8, selection.x - 150), window.innerWidth - 308), top: selection.y > 140 ? selection.y - 104 : selection.y + 28 }}
          onPointerDown={(e) => e.preventDefault()}
        >
          <div className="sel-colors">
            {HL_COLORS.map((c) => (
              <button key={c} className={`sel-color hl-${c}${selection.highlight?.color === c ? ' on' : ''}`} aria-label={`Highlight ${c}`} onClick={() => void addHighlight(c)} />
            ))}
          </div>
          <div className="sel-actions">
            <button onClick={() => (selection.highlight ? setNoteFor(selection.highlight) : void addHighlight('yellow', true))}>Note</button>
            <button onClick={() => void copySelection()}>Copy</button>
            <button onClick={() => lookup('define')}>Define</button>
            <button onClick={() => lookup('translate')}>Translate</button>
            <button onClick={() => { startTts(selection.block, selection.start); setSelection(null); }}>Speak</button>
            {selection.highlight && <button onClick={() => void deleteHighlight(selection.highlight!)}>Remove</button>}
          </div>
        </div>
      )}

      <footer className="statusbar" aria-live="off">
        <button
          className={`mark-toggle${settings.markMode ? ' on' : ''}`}
          onClick={() => {
            onSettings({ markMode: !settings.markMode });
            setToast(settings.markMode ? 'Marking off: taps turn pages' : 'Marking on: tap a word to mark where you stopped');
          }}
          aria-pressed={settings.markMode}
          aria-label="Mark where I stopped: tap a word"
          title="Mark where I stopped (M)"
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M4 20h4l10-10-4-4L4 16v4z" /><path d="M13 7l4 4" /></svg>
          <span>{settings.markMode ? 'Marking' : 'Mark'}</span>
        </button>
        <span className="status-chapter">{chapter.title}</span>
        <span className="status-right">
          {[
            settings.statusPagesLeft && pagesLeft !== null ? `${pagesLeft} page${pagesLeft === 1 ? '' : 's'} left` : '',
            settings.statusChapterTime ? `${formatMinutes(minutesLeft)} left in chapter` : '',
            settings.statusProgress ? `${Math.round(progress * 100)}%` : '',
            settings.statusBattery && battery !== null ? `${battery}% battery` : '',
            settings.statusClock ? clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </footer>

      {toast && <p className="toast" role="status">{toast}</p>}

      <nav className="bottombar" aria-hidden={!chrome} inert={!chrome} aria-label="Reader controls">
        <div className="range-row">
          <input
            type="range"
            className="progress-range"
            min={0}
            max={1000}
            value={Math.round(progress * 1000)}
            aria-label="Book position"
            aria-valuetext={`${Math.round(progress * 100)}%`}
            onChange={(e) => {
              goToPercentOrPage('percent', Number(e.target.value) / 10);
              setChrome(true);
            }}
          />
          <button className="btn btn-small" onClick={() => setPanel('goto')}>Go to</button>
        </div>
        <div className="bottom-buttons">
          <button className="tool-btn" onClick={() => setPanel('toc')}>
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h10" /></svg>
            Contents
          </button>
          <button className="tool-btn" onClick={() => setPanel('notes')}>
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
            Notes
          </button>
          <button className="tool-btn" onClick={() => setPanel('bookmarks')}>
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 3h12v18l-6-4-6 4z" /></svg>
            Marks
          </button>
          <button className="tool-btn" onClick={() => setPanel('settings')}>
            <span aria-hidden="true" className="aa">Aa</span>
            Display
          </button>
          <button className="tool-btn" onClick={() => setPanel('about')}>
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></svg>
            Book
          </button>
        </div>
      </nav>

      {panel === 'toc' && (
        <Drawer title="Contents" onClose={() => setPanel(null)}>
          {content.toc.length ? (
            <ul className="toc-list">
              {content.toc.map((t, i) => (
                <li key={`${t.block}-${i}`}>
                  <button className={`toc-item level-${Math.min(t.level, 2)}${i === chapter.index ? ' current' : ''}`} aria-current={i === chapter.index ? 'true' : undefined} onClick={() => goToBlock(t.block, { remember: true })}>
                    {t.title}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No chapters were found in this book.</p>
          )}
        </Drawer>
      )}

      {panel === 'bookmarks' && (
        <Drawer title="Bookmarks and marker" onClose={() => setPanel(null)}>
          {marker && (
            <div className="marker-card">
              <p className="hint small">Where you stopped</p>
              <button className="toc-item" onClick={() => goToBlock(marker.block, { offset: marker.start, remember: true })}>
                <span className="bm-pct">{Math.round((content.charIndex[marker.block] / (content.charIndex[content.charIndex.length - 1] || 1)) * 100)}%</span>
                ...{content.blocks[marker.block]?.text.slice(Math.max(0, marker.start - 40), marker.end + 40)}...
              </button>
              <button className="btn btn-small" onClick={() => void setMarker(undefined)}>Clear marker</button>
            </div>
          )}
          {book.bookmarks.length ? (
            <ul className="toc-list">
              {book.bookmarks.map((b) => (
                <li key={b.block}>
                  <button className="toc-item" onClick={() => goToBlock(b.block, { remember: true })}>
                    <span className="bm-pct">{Math.round((content.charIndex[b.block] / (content.charIndex[content.charIndex.length - 1] || 1)) * 100)}%</span>
                    {b.snippet || 'Bookmark'}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No bookmarks yet. Tap the ribbon at the top to add one.</p>
          )}
        </Drawer>
      )}

      {panel === 'notes' && (
        <NotesPanel
          book={book}
          content={content}
          onClose={() => setPanel(null)}
          onGo={(h) => goToBlock(h.block, { offset: h.start, remember: true })}
          onEdit={(h) => setNoteFor(h)}
          onDelete={(h) => void deleteHighlight(h)}
        />
      )}

      {panel === 'search' && (
        <SearchPanel
          content={content}
          initial={searchHit?.q ?? ''}
          onClose={() => setPanel(null)}
          onGo={(h, q) => {
            setSearchHit({ ...h, q });
            goToBlock(h.block, { offset: h.start, remember: true });
          }}
        />
      )}

      {panel === 'goto' && (
        <GoToDialog
          isPdf={isPdf}
          pageCount={book.pageCount}
          onClose={() => setPanel(null)}
          onGo={(kind, n) => {
            setPanel(null);
            goToPercentOrPage(kind, n);
          }}
        />
      )}

      {panel === 'about' && (
        <Dialog title={book.title} onClose={() => setPanel(null)}>
          {book.author && <p className="muted">{book.author}</p>}
          <StatsView book={book} content={content} />
          <p className="hint small">{(book.highlights ?? []).length} highlights · {book.bookmarks.length} bookmarks</p>
        </Dialog>
      )}

      {noteFor && <NoteDialog highlight={noteFor} onClose={() => setNoteFor(null)} onSave={(n) => void saveNote(noteFor, n)} />}
      {footnote !== null && (
        <FootnotePopup
          content={content}
          block={footnote}
          bookId={bookId}
          onClose={() => setFootnote(null)}
          onGo={() => {
            const f = footnote;
            setFootnote(null);
            goToBlock(f, { remember: true });
          }}
        />
      )}
      {zoomSrc && <ImageZoom src={zoomSrc} onClose={() => setZoomSrc(null)} />}

      {panel === 'settings' && <SettingsSheet settings={settings} onChange={onSettings} onClose={() => setPanel(null)} isPdf={isPdf} hasPublisherCss={!!book.css} />}
    </div>
  );
}

/** A translucent band that follows the line being read; drag its handle to move it. */
function Ruler({ y, height, onMove }: { y: number; height: number; onMove: (y: number) => void }) {
  const [pos, setPos] = useState(y);
  const drag = useRef(false);
  return (
    <div className="ruler" aria-hidden="true">
      <div className="ruler-shade" style={{ height: `calc(${pos * 100}% - ${height / 2}px)` }} />
      <div className="ruler-band" style={{ top: `calc(${pos * 100}% - ${height / 2}px)`, height }} />
      <div className="ruler-shade bottom" style={{ top: `calc(${pos * 100}% + ${height / 2}px)` }} />
      <div
        className="ruler-handle"
        style={{ top: `calc(${pos * 100}% - 18px)` }}
        onPointerDown={(e) => {
          drag.current = true;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current) setPos(Math.min(0.95, Math.max(0.05, e.clientY / window.innerHeight)));
        }}
        onPointerUp={() => {
          drag.current = false;
          onMove(pos);
        }}
      />
    </div>
  );
}

