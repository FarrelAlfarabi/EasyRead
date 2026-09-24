// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DrmError, parseEpub, resolvePath, scopeCss } from './epub';

const load = (f: string) => {
  const b = readFileSync(`${process.cwd()}/test/fixtures/${f}`);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('resolvePath', () => {
  it('resolves relative hrefs and keeps fragments', () => {
    expect(resolvePath('OEBPS/text/ch1.xhtml', '../images/a.png')).toBe('OEBPS/images/a.png');
    expect(resolvePath('OEBPS/text/ch1.xhtml', 'ch2.xhtml#fn1')).toBe('OEBPS/text/ch2.xhtml#fn1');
    expect(resolvePath('OEBPS/text/ch1.xhtml', '#x')).toBe('OEBPS/text/ch1.xhtml#x');
  });
});

describe('scopeCss', () => {
  it('scopes rules under .pub and drops fonts, urls and layout-breaking properties', () => {
    const out = scopeCss('body { font-family: X; margin: 5%; } p.first { text-indent: 0 } @font-face { src: url(a) } h1 { color: red; background: url(b.png) } @media screen { .n { font-size: .8em } }');
    expect(out).toContain('.pub { margin: 5%; }');
    expect(out).toContain('.pub p.first { text-indent: 0; }');
    expect(out).toContain('.pub h1 { color: red; }');
    expect(out).toContain('.pub .n { font-size: .8em; }');
    expect(out).not.toMatch(/url\(|font-family|@font-face/);
  });
});

describe('parseEpub (EPUB 3)', async () => {
  const book = await parseEpub(load('sample.epub'));
  const { blocks, toc, anchors } = book.content;

  it('reads metadata and cover', () => {
    expect(book.title).toBe('The Lighthouse');
    expect(book.author).toBe('Ada Keeper');
    expect(book.lang).toBe('en');
    expect(book.cover).toBe('OEBPS/images/cover.png');
    expect(book.resources.get('OEBPS/images/cover.png')?.type).toBe('image/png');
  });

  it('builds the table of contents from nav.xhtml', () => {
    expect(toc.map((t) => [t.title, t.level])).toEqual([
      ['Chapter One: The Lighthouse', 0],
      ['Chapter Two: Morning', 0],
      ['Notes', 1],
    ]);
    expect(blocks[toc[0].block].t).toBe('h');
  });

  it('keeps headings, emphasis, quotes, lists, images and line breaks', () => {
    const p = blocks.find((b) => b.text.startsWith('It was a dark'))!;
    expect(p.html).toContain('<em>dark</em>');
    expect(p.html).toContain('<strong>stormy</strong>');
    expect(p.cls).toBe('first');
    expect(blocks.find((b) => b.t === 'quote')?.text).toBe('Light is the first gift and the last.');
    expect(blocks.filter((b) => b.t === 'li').map((b) => [b.marker, b.text])).toEqual([
      ['•', 'Oil for the lamp'],
      ['•', 'Bread and cheese'],
      ['3.', 'Third item'],
    ]);
    const img = blocks.find((b) => b.t === 'img')!;
    expect(img.src).toBe('OEBPS/images/map.png');
    expect(book.resources.has('OEBPS/images/map.png')).toBe(true);
    expect(blocks.some((b) => b.text === 'The coast in 1850.')).toBe(true);
    const br = blocks.find((b) => b.text.startsWith('By morning'))!;
    expect(br.html).toContain('<br>');
    expect(br.text).toBe('By morning the sea was calm and the gulls came back.');
  });

  it('text equals the textContent of the rendered html', () => {
    for (const b of blocks) {
      if (!b.html || b.t === 'img') continue;
      const div = document.createElement('div');
      div.innerHTML = b.html;
      expect(div.textContent).toBe(b.text);
    }
  });

  it('links footnotes and cross references', () => {
    const p = blocks.find((b) => b.text.startsWith('It was a dark'))!;
    expect(p.html).toContain('data-href="OEBPS/text/ch2.xhtml#fn1" data-note="1"');
    const fn = blocks[anchors!['OEBPS/text/ch2.xhtml#fn1']];
    expect(fn.text).toContain('Argand burner');
    expect(fn.cls).toContain('footnote');
    expect(blocks[anchors!['OEBPS/text/ch1.xhtml#ch1']].t).toBe('h');
  });

  it('splits into one section per chapter', () => {
    expect(book.content.sections.map((s) => s.title)).toEqual(['Chapter One: The Lighthouse', 'Chapter Two: Morning']);
  });
});

describe('parseEpub (EPUB 2 / NCX)', () => {
  it('reads the NCX table of contents and meta cover', async () => {
    const book = await parseEpub(load('sample-epub2.epub'));
    expect(book.content.toc.map((t) => t.title)).toEqual(['Chapter One', 'Chapter Two']);
    expect(book.cover).toBe('OEBPS/images/cover.png');
  });
});

describe('DRM', () => {
  it('refuses DRM-protected books with a clear error', async () => {
    await expect(parseEpub(load('drm.epub'))).rejects.toBeInstanceOf(DrmError);
    await expect(parseEpub(load('drm.epub'))).rejects.toThrow(/DRM/);
  });
});
