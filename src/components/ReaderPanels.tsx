import { useEffect, useMemo, useRef, useState } from 'react';
import { exportNotes, pctOf, searchBook, type SearchHit } from '../lib/annotations';
import type { BookContent, BookMeta, Highlight } from '../lib/types';
import { BlockView } from './BlockView';


const CloseIcon = () => (
  <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
);

export function Drawer({ title, onClose, children, side = 'left' }: { title: string; onClose: () => void; children: React.ReactNode; side?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();
  }, []);
  return (
    <div className={`overlay${side === 'right' ? ' overlay-right' : ''}`} onClick={onClose}>
      <div ref={ref} className="drawer" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="overlay center-overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}

export function NotesPanel({
  book,
  content,
  onGo,
  onEdit,
  onDelete,
  onClose,
}: {
  book: BookMeta;
  content: BookContent;
  onGo: (h: Highlight) => void;
  onEdit: (h: Highlight) => void;
  onDelete: (h: Highlight) => void;
  onClose: () => void;
}) {
  const [msg, setMsg] = useState('');
  const list = [...(book.highlights ?? [])].sort((a, b) => a.block - b.block || a.start - b.start);
  const text = () => exportNotes(book, content);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setMsg('Copied.');
    } catch {
      setMsg('Copy is not allowed here. Use Download instead.');
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: `${book.title}: quotes and notes`, text: text() });
    } catch {
      /* cancelled */
    }
  };
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text()], { type: 'text/plain' }));
    a.download = `${book.title.replace(/[^\p{L}\p{N} _-]+/gu, '').slice(0, 60) || 'notes'} - notes.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <Drawer title="Quotes and notes" onClose={onClose} side="right">
      {list.length ? (
        <>
          <div className="row notes-actions">
            <button className="btn btn-small" onClick={() => void copy()}>Copy all</button>
            {'share' in navigator && <button className="btn btn-small" onClick={() => void share()}>Share</button>}
            <button className="btn btn-small" onClick={download}>Download</button>
          </div>
          {msg && <p className="hint small" role="status">{msg}</p>}
          <ul className="notes-list">
            {list.map((h) => (
              <li key={h.id} className={`note-item hl-${h.color}`}>
                <button className="note-quote" onClick={() => onGo(h)}>
                  <span className="bm-pct">{pctOf(content, h.block)}%</span>
                  {h.text}
                </button>
                {h.note && <p className="note-text">{h.note}</p>}
                <div className="row">
                  <button className="btn btn-small" onClick={() => onEdit(h)}>{h.note ? 'Edit note' : 'Add note'}</button>
                  <button className="btn btn-small" onClick={() => onDelete(h)}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">No highlights yet. Press and hold on a word, drag to select, then pick a colour.</p>
      )}
    </Drawer>
  );
}

export function SearchPanel({ content, initial, onGo, onClose }: { content: BookContent; initial: string; onGo: (h: SearchHit, q: string) => void; onClose: () => void }) {
  const [q, setQ] = useState(initial);
  const [debounced, setDebounced] = useState(initial);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const hits = useMemo(() => searchBook(content, debounced), [content, debounced]);
  return (
    <Drawer title="Search in book" onClose={onClose} side="right">
      <input className="search-input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find words in this book" aria-label="Search text" />
      {debounced.trim().length >= 2 && <p className="hint small">{hits.length >= 300 ? '300+ results' : `${hits.length} result${hits.length === 1 ? '' : 's'}`}</p>}
      <ul className="toc-list">
        {hits.map((h, k) => {
          const t = content.blocks[h.block].text;
          const a = Math.max(0, h.start - 40);
          return (
            <li key={k}>
              <button className="toc-item search-hit" onClick={() => onGo(h, q)}>
                <span className="bm-pct">{pctOf(content, h.block)}%</span>
                {a > 0 ? '...' : ''}
                {t.slice(a, h.start)}
                <mark>{t.slice(h.start, h.end)}</mark>
                {t.slice(h.end, h.end + 60)}
                {h.end + 60 < t.length ? '...' : ''}
              </button>
            </li>
          );
        })}
      </ul>
    </Drawer>
  );
}

export function GoToDialog({ isPdf, pageCount, onGo, onClose }: { isPdf: boolean; pageCount: number; onGo: (kind: 'percent' | 'page', n: number) => void; onClose: () => void }) {
  const [kind, setKind] = useState<'percent' | 'page'>(isPdf ? 'page' : 'percent');
  const [v, setV] = useState('');
  return (
    <Dialog title="Go to" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(v);
          if (Number.isFinite(n)) onGo(kind, n);
        }}
      >
        {isPdf && (
          <div className="segmented" role="radiogroup" aria-label="Go to">
            <button type="button" role="radio" aria-checked={kind === 'page'} className={kind === 'page' ? 'on' : ''} onClick={() => setKind('page')}>Page</button>
            <button type="button" role="radio" aria-checked={kind === 'percent'} className={kind === 'percent' ? 'on' : ''} onClick={() => setKind('percent')}>Percent</button>
          </div>
        )}
        <label className="field">
          <span>{kind === 'page' ? `Page (1 to ${pageCount})` : 'Percent (0 to 100)'}</span>
          <input type="number" inputMode="numeric" min={kind === 'page' ? 1 : 0} max={kind === 'page' ? pageCount : 100} value={v} onChange={(e) => setV(e.target.value)} autoFocus />
        </label>
        <button className="btn btn-primary" type="submit">Go</button>
      </form>
    </Dialog>
  );
}

export function NoteDialog({ highlight, onSave, onClose }: { highlight: Highlight; onSave: (note: string) => void; onClose: () => void }) {
  const [v, setV] = useState(highlight.note ?? '');
  return (
    <Dialog title="Note" onClose={onClose}>
      <blockquote className={`note-preview hl-${highlight.color}`}>{highlight.text}</blockquote>
      <textarea className="note-input" value={v} onChange={(e) => setV(e.target.value)} rows={5} autoFocus aria-label="Note text" />
      <div className="row">
        <button className="btn btn-primary" onClick={() => onSave(v.trim())}>Save</button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  );
}

export function FootnotePopup({ content, block, bookId, onGo, onClose }: { content: BookContent; block: number; bookId: string; onGo: () => void; onClose: () => void }) {
  // Show the note block and any following blocks that belong to the same footnote.
  const blocks = [block];
  for (let i = block + 1; i < content.blocks.length && i < block + 4; i++) {
    const b = content.blocks[i];
    if (!/footnote/.test(b.cls ?? '') || b.ids?.length) break;
    blocks.push(i);
  }
  return (
    <Dialog title="Note" onClose={onClose}>
      <div className="footnote-body">
        {blocks.map((i) => (
          <BlockView key={i} block={content.blocks[i]} index={i} bookId={bookId} read={false} bold={false} />
        ))}
      </div>
      <button className="btn btn-small" onClick={onGo}>Go to note</button>
    </Dialog>
  );
}

export function StatsView({ book, content }: { book: BookMeta; content: BookContent }) {
  const s = book.stats ?? { seconds: 0, days: {} };
  const days = Object.entries(s.days).sort((a, b) => a[0].localeCompare(b[0]));
  const totalChars = days.reduce((n, [, d]) => n + d.chars, 0);
  const pages = (chars: number) => Math.round(chars / 1500);
  const fmt = (sec: number) => (sec < 3600 ? `${Math.round(sec / 60)} min` : `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`);
  const last7 = days.slice(-7);
  const max = Math.max(1, ...last7.map(([, d]) => d.seconds));
  const pct = Math.round(book.progress * 100);
  const cpm = s.seconds > 60 ? totalChars / (s.seconds / 60) : 0;
  const leftMin = cpm > 0 ? ((content.charIndex[content.charIndex.length - 1] ?? 0) * (1 - book.progress)) / cpm : 0;
  return (
    <div className="stats">
      <dl className="stats-grid">
        <div><dt>Time read</dt><dd>{fmt(s.seconds)}</dd></div>
        <div><dt>Progress</dt><dd>{pct}%</dd></div>
        <div><dt>Days read</dt><dd>{days.length}</dd></div>
        <div><dt>Pages per day</dt><dd>{days.length ? Math.round(pages(totalChars) / days.length) : 0}</dd></div>
        {leftMin > 0 && <div><dt>Time to finish</dt><dd>{fmt(leftMin * 60)}</dd></div>}
      </dl>
      {last7.length > 0 && (
        <div className="stats-bars" aria-label="Minutes read on recent days">
          {last7.map(([day, d]) => (
            <div key={day} className="stats-bar">
              <span style={{ height: `${Math.max(4, (d.seconds / max) * 100)}%` }} title={`${day}: ${fmt(d.seconds)}`} />
              <small>{day.slice(5)}</small>
            </div>
          ))}
        </div>
      )}
      <p className="hint small">Pages are counted as about 1,500 characters. Time counts only while you are reading.</p>
    </div>
  );
}

export function ImageZoom({ src, onClose }: { src: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  return (
    <div className="zoom-overlay" role="dialog" aria-modal="true" aria-label="Image" onClick={onClose}>
      <div className="zoom-scroll" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt="" style={{ width: `${scale * 100}%` }} />
      </div>
      <div className="zoom-controls" onClick={(e) => e.stopPropagation()}>
        <button className="btn" onClick={() => setScale((s) => Math.max(0.5, s / 1.5))} aria-label="Zoom out">−</button>
        <button className="btn" onClick={() => setScale((s) => Math.min(6, s * 1.5))} aria-label="Zoom in">+</button>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
