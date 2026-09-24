import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { db } from '../lib/db';
import { onLibraryChange } from '../lib/library';
import { ocrStore } from '../lib/ocr';
import { FONT_STACKS, type Settings } from '../lib/settings';
import type { BookContent, BookMeta, Bookmark } from '../lib/types';
import SettingsSheet from './SettingsSheet';
import { formatMinutes } from '../lib/format';

interface Props {
  bookId: string;
  settings: Settings;
  onSettings: (p: Partial<Settings>) => void;
  onClose: () => void;
}

type Panel = null | 'toc' | 'settings' | 'bookmarks';
type Target = { block: number } | { edge: 'start' | 'end' };

const CHARS_PER_MIN = 1500; // about 250 words per minute
const GAP = 48;

function measureCharWidth(font: string, sizePx: number): number {
  try {
    const c = document.createElement('canvas').getContext('2d');
    if (!c) return sizePx * 0.5;
    c.font = `${sizePx}px ${font}`;
    const sample = 'The quick brown fox jumps over the lazy dog, and then it rests. ';
    return c.measureText(sample).width / sample.length;
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
  const ocr = useSyncExternalStore(ocrStore.subscribe, ocrStore.get);

  const stageRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const target = useRef<Target | null>(null);
  const currentRef = useRef(0);
  const pointer = useRef<{ x: number; y: number; t: number } | null>(null);
  const swiped = useRef(false);
  const [animate, setAnimate] = useState(false);

  const paged = settings.mode === 'paged';

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
      if (initial) {
        const pos = Math.min(b.position, Math.max(0, c.blocks.length - 1));
        const si = Math.max(0, c.sections.findIndex((s) => pos >= s.start && pos < s.end));
        setSection(si);
        setCurrent(pos);
        currentRef.current = pos;
        target.current = { block: pos };
      } else {
        // Content grew (scanning). Keep the reader on the same block.
        const pos = Math.min(currentRef.current, Math.max(0, c.blocks.length - 1));
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
  }, [settings.font]);

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
      void db.updateBook(bookId, { position: current, progress, lastReadAt: Date.now() }).catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [book, bookId, current, progress]);

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
  }, [content, paged]);

  const fontStack = FONT_STACKS[settings.font];
  // fontsReady forces a re-measure once web fonts finish loading.
  const charW = useMemo(() => (fontsReady >= 0 ? measureCharWidth(fontStack, settings.fontSize) : 0), [fontStack, settings.fontSize, fontsReady]);

  const layout = useMemo(() => {
    const innerW = Math.max(200, stageSize.w - settings.margin * 2);
    const lineW = Math.min(innerW, Math.round(settings.maxWidth * charW));
    const spread = paged && settings.spread && stageSize.w >= 1000 && stageSize.w > stageSize.h * 1.2 && innerW >= lineW * 2 + GAP;
    const flowW = spread ? lineW * 2 + GAP : lineW;
    return { lineW, flowW, spread, stride: flowW + GAP };
  }, [stageSize, settings.margin, settings.maxWidth, settings.spread, charW, paged]);

  /* ---------------- pagination ---------------- */

  const blockEls = useCallback((): HTMLElement[] => {
    const root = paged ? flowRef.current : scrollerRef.current;
    return root ? Array.from(root.querySelectorAll<HTMLElement>('[data-i]')) : [];
  }, [paged]);

  const pageOf = useCallback(
    (el: HTMLElement): number => {
      const flow = flowRef.current;
      if (!flow) return 0;
      const off = el.getBoundingClientRect().left - flow.getBoundingClientRect().left;
      return Math.max(0, Math.floor((off + 2) / layout.stride));
    },
    [layout.stride],
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
    if (!content || !paged) return;
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
      const el = flow.querySelector<HTMLElement>(`[data-i="${t.block}"]`);
      p = el ? Math.min(count - 1, pageOf(el)) : 0;
    }
    setAnimate(false);
    setPage(p);
    const b = 'block' in t ? t.block : blockAtPage(p);
    if (b !== null) {
      currentRef.current = b;
      setCurrent(b);
    }
  }, [content, section, paged, layout, settings.fontSize, settings.lineHeight, settings.font, settings.align, settings.hyphens, fontsReady, blockEls, pageOf, blockAtPage]);

  // Scroll mode: jump to target after render.
  useLayoutEffect(() => {
    if (!content || paged) return;
    const sc = scrollerRef.current;
    if (!sc) return;
    const t = target.current ?? { block: currentRef.current };
    target.current = null;
    if ('edge' in t) sc.scrollTop = t.edge === 'end' ? sc.scrollHeight : 0;
    else {
      const el = sc.querySelector<HTMLElement>(`[data-i="${t.block}"]`);
      const sec = content.sections[section];
      if (el && sec && t.block !== sec.start) sc.scrollTop = el.offsetTop - 16;
      else sc.scrollTop = 0;
    }
  }, [content, section, paged, layout, settings.fontSize, settings.lineHeight, settings.font, fontsReady]);

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
    (block: number) => {
      if (!content) return;
      const si = Math.max(0, content.sections.findIndex((s) => block >= s.start && block < s.end));
      target.current = { block };
      currentRef.current = block;
      setCurrent(block);
      if (si === section) {
        // Same section: re-run layout effect by nudging state.
        setPageCount((c) => c);
        if (paged) {
          const el = flowRef.current?.querySelector<HTMLElement>(`[data-i="${block}"]`);
          if (el) setPage(pageOf(el));
          target.current = null;
        } else {
          const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-i="${block}"]`);
          if (el && scrollerRef.current) scrollerRef.current.scrollTop = el.offsetTop - 16;
          target.current = null;
        }
      } else setSection(si);
      setPanel(null);
      setChrome(false);
    },
    [content, section, paged, pageOf],
  );

  const turn = useCallback(
    (dir: 1 | -1) => {
      if (!content) return;
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
        } else sc.scrollBy({ top: dir * sc.clientHeight * 0.9, behavior: reducedMotion() ? 'auto' : 'smooth' });
        return;
      }
      const np = page + dir;
      if (np >= 0 && np < pageCount) {
        setAnimate(!reducedMotion());
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
    [content, paged, page, pageCount, section, blockAtPage],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (panel) {
        if (e.key === 'Escape') setPanel(null);
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (['ArrowRight', 'PageDown', ' '].includes(e.key) && !(e.key === ' ' && !paged)) {
        e.preventDefault();
        turn(1);
      } else if (['ArrowLeft', 'PageUp'].includes(e.key)) {
        e.preventDefault();
        turn(-1);
      } else if (e.key === 'Escape') setChrome((c) => !c);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [turn, panel, paged]);

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
  const onStageClick = (e: React.MouseEvent) => {
    if (swiped.current) {
      swiped.current = false;
      return;
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    if ((e.target as HTMLElement).closest('button, a')) return;
    if (chrome) {
      setChrome(false);
      return;
    }
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return;
    const x = (e.clientX - r.left) / r.width;
    if (x < 0.3) turn(-1);
    else if (x > 0.7) turn(1);
    else setChrome(true);
  };

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
    const next = await db.updateBook(bookId, { bookmarks: list });
    if (next) setBook(next);
  };

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

  const flowStyle: React.CSSProperties = {
    fontFamily: fontStack,
    fontSize: `${settings.fontSize}px`,
    lineHeight: settings.lineHeight,
    textAlign: settings.align,
    hyphens: settings.hyphens ? 'auto' : 'manual',
    WebkitHyphens: settings.hyphens ? 'auto' : 'manual',
  };

  const renderBlocks = () =>
    blocks.length ? (
      blocks.map((b, k) => {
        const i = sec.start + k;
        if (b.t === 'h') return <h2 key={i} data-i={i} className="b-h">{b.text}</h2>;
        if (b.t === 'hr') return <p key={i} data-i={i} className="b-hr" aria-hidden="true">* * *</p>;
        return <p key={i} data-i={i} className="b-p">{b.text}</p>;
      })
    ) : (
      <p className="b-p muted" data-i={0}>
        {book.status === 'ocr' ? 'Scanning the first pages. Text will appear here in a moment...' : 'No readable text was found in this PDF.'}
      </p>
    );

  const nextSection = section < content.sections.length - 1;

  return (
    <div className={`reader${chrome ? ' chrome-on' : ''}`} lang={langAttr}>
      <header className="topbar" aria-hidden={!chrome} inert={!chrome}>
        <button className="icon-btn" onClick={onClose} aria-label="Back to library">
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <p className="topbar-title">{book.title}</p>
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
        className={`stage ${paged ? 'paged' : 'scroll'}`}
        style={{ paddingInline: paged ? settings.margin : 0 }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onClick={onStageClick}
        aria-label="Book text"
      >
        {paged ? (
          <div className="viewport" style={{ width: layout.flowW }}>
            <div
              ref={flowRef}
              className={`flow${animate ? ' animate' : ''}`}
              style={{
                ...flowStyle,
                width: layout.flowW,
                columnCount: layout.spread ? 2 : 1,
                columnGap: GAP,
                transform: `translateX(${-page * layout.stride}px)`,
              }}
            >
              {renderBlocks()}
            </div>
          </div>
        ) : (
          <div ref={scrollerRef} className="scroller" onScroll={onScroll}>
            <div className="flow-scroll" style={{ ...flowStyle, maxWidth: layout.lineW, paddingInline: settings.margin, boxSizing: 'content-box' }}>
              {section > 0 && (
                <button className="btn section-nav" onClick={(e) => { e.stopPropagation(); target.current = { edge: 'end' }; setSection(section - 1); }}>
                  Back: {content.sections[section - 1].title}
                </button>
              )}
              {renderBlocks()}
              {nextSection && (
                <button className="btn btn-primary section-nav" onClick={(e) => { e.stopPropagation(); target.current = { edge: 'start' }; setSection(section + 1); }}>
                  Next: {content.sections[section + 1].title}
                </button>
              )}
            </div>
          </div>
        )}
      </main>

      <footer className="statusbar" aria-live="off">
        <span className="status-chapter">{chapter.title}</span>
        <span className="status-right">
          {formatMinutes(minutesLeft)} left in chapter · {Math.round(progress * 100)}%
        </span>
      </footer>

      <nav className="bottombar" aria-hidden={!chrome} inert={!chrome} aria-label="Reader controls">
        <input
          type="range"
          className="progress-range"
          min={0}
          max={1000}
          value={Math.round(progress * 1000)}
          aria-label="Book position"
          aria-valuetext={`${Math.round(progress * 100)}%`}
          onChange={(e) => {
            const total = content.charIndex[content.charIndex.length - 1];
            const want = (Number(e.target.value) / 1000) * total;
            let lo = 0;
            let hi = content.blocks.length - 1;
            while (lo < hi) {
              const mid = (lo + hi + 1) >> 1;
              if (content.charIndex[mid] <= want) lo = mid;
              else hi = mid - 1;
            }
            goToBlock(Math.max(0, lo));
            setChrome(true);
          }}
        />
        <div className="bottom-buttons">
          <button className="tool-btn" onClick={() => setPanel('toc')}>
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h10" /></svg>
            Contents
          </button>
          <button className="tool-btn" onClick={() => setPanel('bookmarks')}>
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 3h12v18l-6-4-6 4z" /></svg>
            Bookmarks
          </button>
          <button className="tool-btn" onClick={() => setPanel('settings')}>
            <span aria-hidden="true" className="aa">Aa</span>
            Display
          </button>
        </div>
      </nav>

      {panel === 'toc' && (
        <Drawer title="Contents" onClose={() => setPanel(null)}>
          {content.toc.length ? (
            <ul className="toc-list">
              {content.toc.map((t, i) => (
                <li key={`${t.block}-${i}`}>
                  <button className={`toc-item level-${Math.min(t.level, 2)}${i === chapter.index ? ' current' : ''}`} aria-current={i === chapter.index ? 'true' : undefined} onClick={() => goToBlock(t.block)}>
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
        <Drawer title="Bookmarks" onClose={() => setPanel(null)}>
          {book.bookmarks.length ? (
            <ul className="toc-list">
              {book.bookmarks.map((b) => (
                <li key={b.block}>
                  <button className="toc-item" onClick={() => goToBlock(b.block)}>
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

      {panel === 'settings' && <SettingsSheet settings={settings} onChange={onSettings} onClose={() => setPanel(null)} />}
    </div>
  );
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);
  return (
    <div className="overlay" onClick={onClose}>
      <div ref={ref} className="drawer" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}
