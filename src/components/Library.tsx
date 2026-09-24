import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { db } from '../lib/db';
import { formatMinutes } from '../lib/format';
import { deleteBook, emitLibraryChange, importBook, ImportError, onLibraryChange, reprocessBook, type ImportProgress } from '../lib/library';
import { cancelOcr, enableOnDeviceOcr, ocrStore, pauseOcr, startOcr, wakeLockSupported, type OcrStatus } from '../lib/ocr';
import { OCR_LANGS, type Settings } from '../lib/settings';
import type { BookMeta, ReadingStatus } from '../lib/types';
import { resourceUrl } from '../lib/render';
import { Dialog } from './ReaderPanels';

interface Props {
  settings: Settings;
  onSettings: (p: Partial<Settings>) => void;
  onOpen: (id: string) => void;
}

function timeAgo(ts: number): string {
  if (!ts) return 'Not started';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'Yesterday' : `${d} days ago`;
}

type Sort = 'recent' | 'added' | 'title' | 'author' | 'progress';
type View = 'grid' | 'list' | 'authors';
interface LibPrefs {
  view: View;
  sort: Sort;
  status: ReadingStatus | 'all';
  favorites: boolean;
  collection: string; // '' = all
}
const PREFS_KEY = 'easyread:library';
const COLL_KEY = 'easyread:collections';
const loadJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
};
const saveJson = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
};

const STATUS_LABEL: Record<ReadingStatus, string> = { none: 'No status', 'to-read': 'To read', reading: 'Reading', read: 'Have read' };
const statusOf = (b: BookMeta): ReadingStatus => b.readingStatus ?? (b.progress >= 0.98 ? 'read' : b.lastReadAt ? 'reading' : 'none');

function Cover({ book }: { book: BookMeta }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!book.cover) return;
    let alive = true;
    void resourceUrl(book.cover).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [book.cover]);
  if (url) return <img className="cover-img" src={url} alt="" loading="lazy" />;
  // Generated cover: title on a colour picked from the title.
  let h = 0;
  for (const c of book.title) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="cover-gen" style={{ background: `hsl(${h} 35% 42%)` }} aria-hidden="true">
      <span>{book.title}</span>
    </span>
  );
}

function OcrPanel({ b, live, onOpen }: { b: BookMeta; live: OcrStatus | null; onOpen: (id: string) => void }) {
  const done = live?.done ?? b.ocr?.done ?? 0;
  const total = live?.total ?? b.ocr?.total ?? 0;
  const spp = live?.secPerPage ?? b.ocr?.secPerPage ?? null;
  const running = live && (live.state === 'running' || live.state === 'loading');
  const fallbackPages = live?.fallbackPages ?? b.ocr?.fallbackPages ?? 0;
  const needsConsent = live?.needsConsent ?? b.ocr?.needsConsent ?? 0;
  return (
    <div className="ocr-panel" role="status" aria-live="polite">
      <p className="ocr-line">
        {live?.state === 'loading'
          ? live.message
          : running
            ? `Reading scanned page ${Math.min(done + 1, total)} of ${total}`
            : needsConsent > 0
              ? `Read ${done} of ${total} pages.`
              : `Scanned ${done} of ${total} pages. Paused.`}
        {running && spp ? ` · about ${formatMinutes(((total - done) * spp) / 60)} left` : ''}
      </p>
      <div className="bar" role="progressbar" aria-label="Scanning progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <span style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
      </div>
      {live?.state === 'error' && <p className="error small">{live.message}</p>}
      {live?.message && live.state !== 'error' && <p className="hint small">{live.message}</p>}
      {fallbackPages > 0 && <p className="hint small">{fallbackPages} page{fallbackPages === 1 ? '' : 's'} read on this device, with your OK, because the cloud readers were unavailable.</p>}
      {needsConsent > 0 ? (
        <p className="ocr-consent">
          Cloud OCR unavailable for {needsConsent} page{needsConsent === 1 ? '' : 's'}. Read {needsConsent === 1 ? 'it' : 'them'} on this device instead? This is slower and less accurate.
        </p>
      ) : (
        running && <p className="hint small">Keep this tab open{wakeLockSupported ? '. The screen will stay on while scanning.' : ' and the screen on.'} You can start reading now.</p>
      )}
      <div className="row">
        {needsConsent > 0 ? (
          <>
            <button className="btn btn-primary" onClick={() => void enableOnDeviceOcr(b.id)}>Use on-device OCR</button>
            <button className="btn" onClick={() => void startOcr(b.id)}>Retry cloud</button>
          </>
        ) : running ? (
          <button className="btn" onClick={() => pauseOcr()}>Pause</button>
        ) : (
          <button className="btn" onClick={() => void startOcr(b.id)}>Resume</button>
        )}
        <button className="btn" onClick={() => void cancelOcr(b.id)}>Stop scanning</button>
        {done > 0 && <button className="btn btn-primary" onClick={() => onOpen(b.id)}>Read now</button>}
      </div>
    </div>
  );
}

function BookDialog({
  b,
  collections,
  busy,
  onClose,
  onReprocess,
  onDelete,
  onNewCollection,
}: {
  b: BookMeta;
  collections: string[];
  busy: boolean;
  onClose: () => void;
  onReprocess: () => void;
  onDelete: () => void;
  onNewCollection: (name: string) => void;
}) {
  const [newName, setNewName] = useState('');
  const update = (patch: Partial<BookMeta>) => void db.updateBook(b.id, patch).then(() => emitLibraryChange(b.id));
  const inColl = new Set(b.collections ?? []);
  return (
    <Dialog title={b.title} onClose={onClose}>
      {b.author && <p className="muted book-author">{b.author}</p>}
      <label className="field">
        <span>Status</span>
        <select value={statusOf(b)} onChange={(e) => update({ readingStatus: e.target.value as ReadingStatus })}>
          {(Object.keys(STATUS_LABEL) as ReadingStatus[]).map((s) => (
            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
          ))}
        </select>
      </label>
      <label className="toggle-row setting-row">
        <span className="setting-label">Favourite</span>
        <input type="checkbox" role="switch" checked={!!b.favorite} onChange={(e) => update({ favorite: e.target.checked })} />
      </label>
      <fieldset className="coll-field">
        <legend>Collections</legend>
        {collections.map((c) => (
          <label key={c} className="coll-check">
            <input
              type="checkbox"
              checked={inColl.has(c)}
              onChange={(e) => {
                const next = new Set(inColl);
                if (e.target.checked) next.add(c);
                else next.delete(c);
                update({ collections: [...next] });
              }}
            />{' '}
            {c}
          </label>
        ))}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const n = newName.trim();
            if (!n) return;
            onNewCollection(n);
            update({ collections: [...inColl, n] });
            setNewName('');
          }}
        >
          <input className="lib-search" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New collection" aria-label="New collection name" />
          <button className="btn btn-small" type="submit">Add</button>
        </form>
      </fieldset>
      <p className="hint small">
        {b.format === 'epub' ? 'EPUB' : 'PDF'} · {b.pageCount} pages · added {new Date(b.addedAt).toLocaleDateString()} · {(b.highlights ?? []).length} highlights
      </p>
      <div className="row">
        <button className="btn btn-small" disabled={busy} onClick={onReprocess}>{busy ? 'Re-processing...' : 'Re-process'}</button>
        <button className="btn btn-small danger" onClick={onDelete}>Delete</button>
      </div>
    </Dialog>
  );
}

export default function Library({ settings, onSettings, onOpen }: Props) {
  const [books, setBooks] = useState<BookMeta[] | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reprocessing, setReprocessing] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<LibPrefs>(() => loadJson(PREFS_KEY, { view: 'grid', sort: 'recent', status: 'all', favorites: false, collection: '' }));
  const [extraColls, setExtraColls] = useState<string[]>(() => loadJson<{ list: string[] }>(COLL_KEY, { list: [] }).list);
  const [query, setQuery] = useState('');
  const [details, setDetails] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const ocr = useSyncExternalStore(ocrStore.subscribe, ocrStore.get);

  const setPref = (p: Partial<LibPrefs>) =>
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      saveJson(PREFS_KEY, next);
      return next;
    });

  const refresh = useCallback(async () => {
    try {
      setBooks(await db.listBooks());
    } catch {
      setBooks([]);
      setError('Your browser blocked on-device storage (private mode?). Books cannot be saved.');
    }
  }, []);

  useEffect(() => {
    // Loading from IndexedDB is async; state is set after the read completes.
    // oxlint-disable-next-line react/set-state-in-effect
    void refresh();
    return onLibraryChange(() => void refresh());
  }, [refresh]);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file || progress) return;
      setError(null);
      try {
        const book = await importBook(file, settings.ocrLang, setProgress);
        setProgress(null);
        if (book.status === 'ocr') {
          void startOcr(book.id);
        } else {
          const content = await db.getContent(book.id);
          if (!content?.blocks.length) {
            setError('No readable text was found in this book.');
            return;
          }
          onOpen(book.id);
        }
      } catch (e) {
        setProgress(null);
        setError(e instanceof ImportError ? e.message : 'Something went wrong while reading this file.');
        if (!(e instanceof ImportError)) console.error(e);
      }
    },
    [progress, settings.ocrLang, onOpen],
  );

  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      void handleFile(e.dataTransfer?.files?.[0]);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [handleFile]);

  const collections = useMemo(() => {
    const s = new Set(extraColls);
    for (const b of books ?? []) for (const c of b.collections ?? []) s.add(c);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [books, extraColls]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = (books ?? []).filter((b) => {
      if (prefs.favorites && !b.favorite) return false;
      if (prefs.status !== 'all' && statusOf(b) !== prefs.status) return false;
      if (prefs.collection && !(b.collections ?? []).includes(prefs.collection)) return false;
      if (q && !`${b.title} ${b.author ?? ''} ${b.fileName}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const by: Record<Sort, (a: BookMeta, b: BookMeta) => number> = {
      recent: (a, b) => Math.max(b.lastReadAt, b.addedAt) - Math.max(a.lastReadAt, a.addedAt),
      added: (a, b) => b.addedAt - a.addedAt,
      title: (a, b) => a.title.localeCompare(b.title),
      author: (a, b) => (a.author ?? '~').localeCompare(b.author ?? '~') || a.title.localeCompare(b.title),
      progress: (a, b) => b.progress - a.progress,
    };
    list = [...list].sort(by[prefs.sort]);
    return list;
  }, [books, prefs, query]);

  const byAuthor = useMemo(() => {
    const m = new Map<string, BookMeta[]>();
    for (const b of shown) {
      const a = b.author?.trim() || 'Unknown author';
      m.set(a, [...(m.get(a) ?? []), b]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [shown]);

  const pct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;
  const progressText = !progress
    ? ''
    : progress.stage === 'reading'
      ? 'Opening file...'
      : progress.stage === 'text'
        ? `Reading page ${progress.done} of ${progress.total}`
        : 'Laying out the text...';

  const reprocess = async (b: BookMeta) => {
    if ((b.highlights?.length || b.marker) && !window.confirm('Re-processing clears this book\'s highlights and marker, because the text positions change. Continue?')) return;
    setReprocessing(b.id);
    setError(null);
    try {
      const next = await reprocessBook(b.id, settings.ocrLang);
      if (next?.status === 'ocr') void startOcr(b.id);
    } catch (e) {
      console.error(e);
      setError(e instanceof ImportError ? e.message : 'Could not re-process this book.');
    } finally {
      setReprocessing(null);
    }
  };

  const remove = (b: BookMeta) => {
    if (!window.confirm(`Delete "${b.title}" from this device?`)) return;
    setDetails(null);
    if (b.status === 'ocr') void cancelOcr(b.id).finally(() => void deleteBook(b.id));
    else void deleteBook(b.id);
  };

  const card = (b: BookMeta) => {
    const live = ocr.bookId === b.id ? ocr : null;
    const scanning = b.status === 'ocr' && b.ocr;
    const st = statusOf(b);
    return (
      <li key={b.id} className="book-card">
        <button className="book-open" onClick={() => onOpen(b.id)} aria-label={`Open ${b.title}`}>
          <span className="cover">
            <Cover book={b} />
            {b.favorite && <span className="fav-badge" aria-label="Favourite">★</span>}
          </span>
          <span className="book-text">
            <span className="book-title">{b.title}</span>
            {b.author && <span className="book-author">{b.author}</span>}
            <span className="book-meta">
              {Math.round(b.progress * 100)}% · {st !== 'none' ? `${STATUS_LABEL[st]} · ` : ''}
              {timeAgo(b.lastReadAt)}
            </span>
            <span className="bar thin" aria-hidden="true"><span style={{ width: `${b.progress * 100}%` }} /></span>
          </span>
        </button>
        <button className="icon-btn book-more" aria-label={`More for ${b.title}`} onClick={() => setDetails(b.id)}>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
        </button>
        {scanning && <OcrPanel b={b} live={live} onOpen={onOpen} />}
      </li>
    );
  };

  const detailBook = books?.find((b) => b.id === details);

  return (
    <div className="library">
      <header className="lib-header">
        <h1 className="logo">
          <span aria-hidden="true" className="logo-mark">Aa</span> EasyRead
        </h1>
        <p className="tagline">Turn PDF and EPUB books into easy, phone-sized reading.</p>
      </header>

      <section className={`dropzone${dragging ? ' dragging' : ''}`} aria-labelledby="upload-title">
        <h2 id="upload-title" className="sr-only">Add a book</h2>
        <input
          ref={inputRef}
          id="file"
          type="file"
          accept="application/pdf,.pdf,application/epub+zip,.epub"
          className="sr-only"
          onChange={(e) => {
            void handleFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        {progress ? (
          <div className="import-progress" role="status" aria-live="polite">
            <p>{progressText}</p>
            <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Import progress">
              <span style={{ width: `${progress.stage === 'layout' ? 100 : pct}%` }} />
            </div>
          </div>
        ) : (
          <>
            <label htmlFor="file" className="btn btn-primary btn-big">
              Choose a PDF or EPUB
            </label>
            <p className="hint">or drop it anywhere on this page</p>
          </>
        )}
        <p className="privacy">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
          Your file and its text stay on this device and are never uploaded.
        </p>
        <p className="privacy small">
          Exception: a scanned PDF page with no text layer is sent as an image to a cloud reader (Google Gemini, or Groq as a backup when Gemini is busy) since that gives much cleaner results than reading it on your device. EasyRead never reads a page on your device without asking you first.
        </p>
        <div className="field-inline">
          <label htmlFor="ocr-lang">Language for scanned pages</label>
          <select id="ocr-lang" value={settings.ocrLang} onChange={(e) => onSettings({ ocrLang: e.target.value })}>
            {OCR_LANGS.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </div>
      </section>

      {error && (
        <p className="error" role="alert">{error}</p>
      )}

      <section aria-labelledby="books-title" className="books">
        <div className="books-head">
          <h2 id="books-title">Your books</h2>
          <div className="segmented view-switch" role="radiogroup" aria-label="View">
            {(['grid', 'list', 'authors'] as View[]).map((v) => (
              <button key={v} role="radio" aria-checked={prefs.view === v} className={prefs.view === v ? 'on' : ''} onClick={() => setPref({ view: v })}>
                {v === 'grid' ? 'Covers' : v === 'list' ? 'List' : 'Authors'}
              </button>
            ))}
          </div>
        </div>
        {books && books.length > 0 && (
          <div className="lib-tools">
            <input className="lib-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title or author" aria-label="Search library" />
            <select value={prefs.sort} onChange={(e) => setPref({ sort: e.target.value as Sort })} aria-label="Sort by">
              <option value="recent">Recent</option>
              <option value="added">Date added</option>
              <option value="title">Title</option>
              <option value="author">Author</option>
              <option value="progress">Progress</option>
            </select>
            <select value={prefs.status} onChange={(e) => setPref({ status: e.target.value as LibPrefs['status'] })} aria-label="Filter by status">
              <option value="all">All statuses</option>
              {(['to-read', 'reading', 'read'] as ReadingStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
            <select
              value={prefs.collection}
              onChange={(e) => {
                if (e.target.value === '__new') {
                  const n = window.prompt('New collection name')?.trim();
                  if (n) {
                    const list = [...new Set([...extraColls, n])];
                    setExtraColls(list);
                    saveJson(COLL_KEY, { list });
                    setPref({ collection: n });
                  }
                  return;
                }
                setPref({ collection: e.target.value });
              }}
              aria-label="Collection"
            >
              <option value="">All collections</option>
              {collections.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
              <option value="__new">+ New collection...</option>
            </select>
            <button className={`btn btn-small${prefs.favorites ? ' btn-primary' : ''}`} aria-pressed={prefs.favorites} onClick={() => setPref({ favorites: !prefs.favorites })}>
              ★ Favourites
            </button>
          </div>
        )}
        {books === null ? null : books.length === 0 ? (
          <p className="empty">No books yet. Add a PDF or EPUB to start reading.</p>
        ) : shown.length === 0 ? (
          <p className="empty">No books match.</p>
        ) : prefs.view === 'authors' ? (
          byAuthor.map(([author, list]) => (
            <section key={author} className="author-group">
              <h3>{author} <span className="muted">({list.length})</span></h3>
              <ul className="book-list list">{list.map(card)}</ul>
            </section>
          ))
        ) : (
          <ul className={`book-list ${prefs.view}`}>{shown.map(card)}</ul>
        )}
      </section>
      <footer className="lib-footer">
        <p>Works offline. Books, notes, bookmarks and settings are saved in this browser only.</p>
      </footer>

      {detailBook && (
        <BookDialog
          b={detailBook}
          collections={collections}
          busy={reprocessing === detailBook.id}
          onClose={() => setDetails(null)}
          onReprocess={() => void reprocess(detailBook)}
          onDelete={() => remove(detailBook)}
          onNewCollection={(n) => {
            const list = [...new Set([...extraColls, n])];
            setExtraColls(list);
            saveJson(COLL_KEY, { list });
          }}
        />
      )}
    </div>
  );
}
