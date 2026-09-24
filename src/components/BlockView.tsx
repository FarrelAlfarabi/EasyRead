import { memo, useEffect, useState } from 'react';
import { boldStarts, esc, resourceUrl } from '../lib/render';
import type { Block } from '../lib/types';

function BookImage({ bookId, src, alt }: { bookId: string; src: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void resourceUrl(`${bookId}:res:${src}`).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [bookId, src]);
  return url ? <img src={url} alt={alt} data-zoom="1" loading="lazy" decoding="async" /> : <span className="img-placeholder" aria-label={alt} />;
}

interface Props {
  block: Block;
  index: number;
  bookId: string;
  read: boolean; // before the last-read marker (dimmed)
  bold: boolean;
}

/** One block of book text. `data-i` is the block index used for navigation and offsets. */
export const BlockView = memo(function BlockView({ block: b, index: i, bookId, read, bold }: Props) {
  const cls = `${b.cls ? `${b.cls} ` : ''}${read ? 'is-read ' : ''}`;
  const inner = (() => {
    const html = b.html ?? esc(b.text);
    return { __html: bold ? boldStarts(html) : html };
  })();
  switch (b.t) {
    case 'h': {
      const level = Math.min(Math.max(b.level ?? 2, 1), 4);
      const Tag = (['h2', 'h2', 'h3', 'h4'] as const)[level - 1];
      return <Tag data-i={i} className={`${cls}b-h lvl-${level}`} dangerouslySetInnerHTML={inner} />;
    }
    case 'hr':
      return <p data-i={i} className={`${cls}b-hr`} aria-hidden="true">* * *</p>;
    case 'img':
      return (
        <figure data-i={i} className={`${cls}b-img`}>
          <BookImage bookId={bookId} src={b.src ?? ''} alt={b.html ?? ''} />
        </figure>
      );
    case 'li':
      return (
        <p data-i={i} className={`${cls}b-li`} style={{ '--depth': b.level ?? 1 } as React.CSSProperties} data-marker={b.marker ?? ''}>
          <span dangerouslySetInnerHTML={inner} />
        </p>
      );
    case 'quote':
      return <p data-i={i} className={`${cls}b-quote`} dangerouslySetInnerHTML={inner} />;
    case 'pre':
      return <pre data-i={i} className={`${cls}b-pre`}>{b.text}</pre>;
    default:
      return <p data-i={i} className={`${cls}b-p`} dangerouslySetInnerHTML={inner} />;
  }
});
