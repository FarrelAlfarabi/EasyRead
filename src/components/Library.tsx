import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { db } from '../lib/db';
import { deleteBook, importPdf, ImportError, onLibraryChange, type ImportProgress } from '../lib/library';
import { cancelOcr, ocrStore, pauseOcr, startOcr, wakeLockSupported } from '../lib/ocr';
import { OCR_LANGS, type Settings } from '../lib/settings';
import type { BookMeta } from '../lib/types';
import { formatMinutes } from '../lib/format';

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

export default function Library({ settings, onSettings, onOpen }: Props) {
  const [books, setBooks] = useState<BookMeta[] | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const ocr = useSyncExternalStore(ocrStore.subscribe, ocrStore.get);

  const refresh = useCallback(async () => {
    try {
      const list = await db.listBooks();
      list.sort((a, b) => Math.max(b.lastReadAt, b.addedAt) - Math.max(a.lastReadAt, a.addedAt));
      setBooks(list);
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
        const book = await importPdf(file, settings.ocrLang, setProgress);
        setProgress(null);
        if (book.status === 'ocr') {
          void startOcr(book.id);
        } else {
          const content = await db.getContent(book.id);
          if (!content?.blocks.length) {
            setError('No readable text was found in this PDF.');
            return;
          }
          onOpen(book.id);
        }
      } catch (e) {
        setProgress(null);
        setError(e instanceof ImportError ? e.message : 'Something went wrong while reading this PDF.');
        console.error(e);
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

  const pct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;
  const progressText = !progress
    ? ''
    : progress.stage === 'reading'
      ? 'Opening file...'
      : progress.stage === 'text'
        ? `Reading page ${progress.done} of ${progress.total}`
        : 'Laying out the text...';

  return (
    <div className="library">
      <header className="lib-header">
        <h1 className="logo">
          <span aria-hidden="true" className="logo-mark">Aa</span> EasyRead
        </h1>
        <p className="tagline">Turn a PDF book into easy, phone-sized reading.</p>
      </header>

      <section className={`dropzone${dragging ? ' dragging' : ''}`} aria-labelledby="upload-title">
        <h2 id="upload-title" className="sr-only">Add a book</h2>
        <input
          ref={inputRef}
          id="file"
          type="file"
          accept="application/pdf,.pdf"
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
              Choose a PDF
            </label>
            <p className="hint">or drop it anywhere on this page</p>
          </>
        )}
        <p className="privacy">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
          Your file stays on this device. Nothing is uploaded.
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
        <h2 id="books-title">Your books</h2>
        {books === null ? null : books.length === 0 ? (
          <p className="empty">No books yet. Add a PDF to start reading.</p>
        ) : (
          <ul className="book-list">
            {books.map((b) => {
              const scanning = b.status === 'ocr' && b.ocr;
              const live = ocr.bookId === b.id ? ocr : null;
              const done = live?.done ?? b.ocr?.done ?? 0;
              const total = live?.total ?? b.ocr?.total ?? 0;
              const spp = live?.secPerPage ?? b.ocr?.secPerPage ?? null;
              const running = live && (live.state === 'running' || live.state === 'loading');
              return (
                <li key={b.id} className="book-card">
                  <button className="book-open" onClick={() => onOpen(b.id)} aria-label={`Open ${b.title}`}>
                    <span className="book-title">{b.title}</span>
                    <span className="book-meta">
                      {Math.round(b.progress * 100)}% read · {timeAgo(b.lastReadAt)} · {b.pageCount} pages
                    </span>
                    <span className="bar thin" aria-hidden="true"><span style={{ width: `${b.progress * 100}%` }} /></span>
                  </button>
                  {scanning && (
                    <div className="ocr-panel" role="status" aria-live="polite">
                      <p className="ocr-line">
                        {live?.state === 'loading'
                          ? live.message
                          : running
                            ? `Reading scanned page ${Math.min(done + 1, total)} of ${total}`
                            : `Scanned ${done} of ${total} pages. Paused.`}
                        {running && spp ? ` · about ${formatMinutes(((total - done) * spp) / 60)} left` : ''}
                      </p>
                      <div className="bar" role="progressbar" aria-label="Scanning progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
                        <span style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
                      </div>
                      {live?.state === 'error' && <p className="error small">{live.message}</p>}
                      {running && (
                        <p className="hint small">
                          Keep this tab open{wakeLockSupported ? '. The screen will stay on while scanning.' : ' and the screen on.'} You can start reading now.
                        </p>
                      )}
                      <div className="row">
                        {running ? (
                          <button className="btn" onClick={() => pauseOcr()}>Pause</button>
                        ) : (
                          <button className="btn" onClick={() => void startOcr(b.id)}>Resume</button>
                        )}
                        <button className="btn" onClick={() => void cancelOcr(b.id)}>Stop scanning</button>
                        {done > 0 && (
                          <button className="btn btn-primary" onClick={() => onOpen(b.id)}>Read now</button>
                        )}
                      </div>
                    </div>
                  )}
                  <button
                    className="icon-btn book-delete"
                    aria-label={`Delete ${b.title}`}
                    onClick={() => {
                      if (window.confirm(`Delete "${b.title}" from this device?`)) {
                        if (scanning) void cancelOcr(b.id).finally(() => void deleteBook(b.id));
                        else void deleteBook(b.id);
                      }
                    }}
                  >
                    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <footer className="lib-footer">
        <p>Works offline. Books, bookmarks and settings are saved in this browser only.</p>
      </footer>
    </div>
  );
}
