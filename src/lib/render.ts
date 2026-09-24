import { db } from './db';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Optional "bold word starts" (bionic-style). Wraps the first part of each word in <b>;
 * the text content is unchanged, so offsets for highlights and the marker still match.
 */
export function boldStarts(html: string): string {
  return html.replace(/(<[^>]*>)|([^<]+)/g, (_m, tag: string | undefined, text: string | undefined) => {
    if (tag) return tag;
    return (text ?? '').replace(/(\p{L}+)/gu, (w: string) => {
      if (w.length < 2) return w;
      const n = Math.ceil(w.length / 2);
      return `<b class="bs">${w.slice(0, n)}</b>${w.slice(n)}`;
    });
  });
}

/** Object URLs for book images, cached for the life of the page. */
const urlCache = new Map<string, Promise<string | null>>();
export function resourceUrl(key: string): Promise<string | null> {
  let p = urlCache.get(key);
  if (!p) {
    p = db
      .getFile(key)
      .then((blob) => (blob ? URL.createObjectURL(blob) : null))
      .catch(() => null);
    urlCache.set(key, p);
  }
  return p;
}

