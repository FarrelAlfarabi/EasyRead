/**
 * EPUB 2 and 3 import, entirely in the browser. The zip is read with JSZip (lazy-loaded),
 * then every spine document is turned into EasyRead blocks with sanitized inline HTML,
 * so the book gets the same reader as PDFs: our fonts, themes and spacing, pagination,
 * highlights, search, text-to-speech and the last-read marker.
 */
import type { Block, BookContent, Section, TocEntry } from './types';

export class EpubError extends Error {}
export class DrmError extends EpubError {}

export interface EpubResource {
  data: Uint8Array;
  type: string;
}

export interface EpubBook {
  title: string;
  author: string;
  lang: string;
  content: BookContent;
  css: string;
  cover?: string; // resource path
  resources: Map<string, EpubResource>;
}

/* ---------------- small helpers ---------------- */

/** Resolve `href` relative to the directory of `base` (both zip paths). */
export function resolvePath(base: string, href: string): string {
  const [pathPart, frag] = href.split('#');
  let p: string;
  try {
    p = decodeURIComponent(pathPart);
  } catch {
    p = pathPart;
  }
  if (!p) return (base + (frag ? `#${frag}` : ''));
  const parts = p.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/') + (frag !== undefined ? `#${frag}` : '');
}

function byLocal(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter((e) => e.localName === name);
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    // Some books ship slightly broken XML; the HTML parser is forgiving.
    return new DOMParser().parseFromString(text, 'text/html');
  }
  return doc;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;');

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
};

/* ---------------- content conversion ---------------- */

const INLINE_MAP: Record<string, string> = {
  em: 'em', i: 'em', strong: 'strong', b: 'strong', u: 'u', s: 's', strike: 's', del: 's', ins: 'u',
  sup: 'sup', sub: 'sub', small: 'small', code: 'code', kbd: 'code', tt: 'code', q: 'q', cite: 'cite',
  abbr: 'abbr', dfn: 'em', var: 'em', mark: 'strong', span: 'span', big: 'span', font: 'span',
};
const BLOCKS = new Set([
  'p', 'div', 'section', 'article', 'body', 'main', 'header', 'footer', 'nav', 'aside', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'hr', 'table',
  'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'address', 'center', 'hgroup', 'details', 'summary',
]);

type Part = { k: 'text'; s: string } | { k: 'tag'; s: string };

export interface Ctx {
  path: string; // current document path
  page: number;
  blocks: Block[];
  anchors: Record<string, number>;
  pendingIds: string[];
  images: Set<string>;
  quote: number;
  listDepth: number;
}

function epubType(el: Element): string {
  return (el.getAttribute('epub:type') ?? el.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? '') + ' ' + (el.getAttribute('role') ?? '');
}

function imgSrc(el: Element, path: string): string | null {
  const name = el.localName;
  const raw =
    name === 'img' ? el.getAttribute('src') :
    name === 'image' ? el.getAttribute('xlink:href') ?? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? el.getAttribute('href') :
    null;
  return raw ? resolvePath(path, raw) : null;
}

/** Collect inline content of `el` into parts (sanitized tags + text). Images found are returned separately. */
function inlineParts(el: Node, ctx: Ctx, parts: Part[], images: string[], ids: string[]): void {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) {
      parts.push({ k: 'text', s: (node as Text).data });
      continue;
    }
    if (node.nodeType !== 1) continue;
    const e = node as Element;
    const name = e.localName;
    const id = e.getAttribute('id');
    if (id) ids.push(id);
    if (name === 'br') {
      parts.push({ k: 'text', s: ' ' }, { k: 'tag', s: '<br>' });
      continue;
    }
    if (name === 'img' || name === 'image') {
      const src = imgSrc(e, ctx.path);
      if (src) images.push(src);
      continue;
    }
    if (name === 'svg') {
      for (const im of byLocal(e, 'image')) {
        const src = imgSrc(im, ctx.path);
        if (src) images.push(src);
      }
      continue;
    }
    if (name === 'script' || name === 'style' || name === 'head') continue;
    if (name === 'a') {
      const href = e.getAttribute('href');
      const noteref = /noteref/.test(epubType(e));
      if (href && !/^[a-z]+:/i.test(href)) {
        const target = resolvePath(ctx.path, href);
        parts.push({ k: 'tag', s: `<a data-href="${escAttr(target)}"${noteref ? ' data-note="1"' : ''}>` });
        inlineParts(e, ctx, parts, images, ids);
        parts.push({ k: 'tag', s: '</a>' });
      } else if (href && /^https?:/i.test(href)) {
        parts.push({ k: 'tag', s: `<a data-ext="${escAttr(href)}">` });
        inlineParts(e, ctx, parts, images, ids);
        parts.push({ k: 'tag', s: '</a>' });
      } else inlineParts(e, ctx, parts, images, ids);
      continue;
    }
    const mapped = INLINE_MAP[name];
    if (mapped) {
      const cls = e.getAttribute('class');
      const style = e.getAttribute('style') ?? '';
      // Italic/bold via inline style or common class names.
      const italic = /font-style:\s*italic/i.test(style) || /\b(italic|ital|emph)\b/i.test(cls ?? '');
      const bold = /font-weight:\s*(bold|[6-9]00)/i.test(style) || /\bbold\b/i.test(cls ?? '');
      const tag = mapped === 'span' ? (italic ? 'em' : bold ? 'strong' : 'span') : mapped;
      parts.push({ k: 'tag', s: `<${tag}${cls ? ` class="${escAttr(cls)}"` : ''}>` });
      inlineParts(e, ctx, parts, images, ids);
      parts.push({ k: 'tag', s: `</${tag}>` });
      continue;
    }
    // Unknown inline element (or a block inside inline content): keep its text.
    inlineParts(e, ctx, parts, images, ids);
  }
}

/** Collapse whitespace across parts, trim the ends, and produce matching html + text. */
function finishParts(parts: Part[]): { html: string; text: string } {
  const texts = parts.filter((p): p is Part & { k: 'text' } => p.k === 'text');
  let prevSpace = true;
  for (const t of texts) {
    let s = t.s.replace(/[\s ]+/g, (m) => (m.includes(' ') && !/[\t\n\r ]/.test(m) ? ' ' : ' '));
    if (prevSpace) s = s.replace(/^ +/, '');
    if (s.length) prevSpace = s.endsWith(' ');
    t.s = s;
  }
  for (let i = texts.length - 1; i >= 0; i--) {
    const before = texts[i].s;
    texts[i].s = before.replace(/ +$/, '');
    if (texts[i].s.length) break;
  }
  const html = parts.map((p) => (p.k === 'text' ? esc(p.s) : p.s)).join('');
  const text = texts.map((t) => t.s).join('');
  return { html, text };
}

function pushBlock(ctx: Ctx, b: Omit<Block, 'page'>, ids: string[] = []) {
  const idx = ctx.blocks.length;
  const all = [...ctx.pendingIds, ...ids];
  ctx.pendingIds = [];
  const block: Block = { ...b, page: ctx.page };
  if (all.length) block.ids = all;
  for (const id of all) ctx.anchors[`${ctx.path}#${id}`] = idx;
  if (ctx.anchors[ctx.path] === undefined) ctx.anchors[ctx.path] = idx;
  ctx.blocks.push(block);
}

function pushImages(ctx: Ctx, images: string[], alt = '') {
  for (const src of images) {
    ctx.images.add(src);
    pushBlock(ctx, { t: 'img', text: '', src, html: alt ? escAttr(alt) : undefined });
  }
}

function inlineBlock(ctx: Ctx, el: Element, t: Block['t'], extra: Partial<Block> = {}) {
  const parts: Part[] = [];
  const images: string[] = [];
  const ids: string[] = [];
  inlineParts(el, ctx, parts, images, ids);
  const { html, text } = finishParts(parts);
  const cls = el.getAttribute('class') ?? undefined;
  if (text.trim()) {
    pushBlock(ctx, { t, text, html: html === esc(text) ? undefined : html, cls, ...extra }, ids);
  } else if (ids.length) ctx.pendingIds.push(...ids);
  pushImages(ctx, images, el.localName === 'img' ? el.getAttribute('alt') ?? '' : '');
}

function hasBlockChild(el: Element): boolean {
  return Array.from(el.children).some((c) => BLOCKS.has(c.localName) || (c.localName === 'svg' && byLocal(c, 'image').length > 0));
}

function walk(el: Element, ctx: Ctx): void {
  let run: Node[] = [];
  const flushRun = () => {
    if (!run.length) return;
    const wrapper = el.ownerDocument.createElement('div');
    for (const n of run) wrapper.appendChild(n.cloneNode(true));
    run = [];
    inlineBlock(ctx, wrapper, ctx.quote ? 'quote' : 'p');
  };
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) {
      if ((node as Text).data.trim()) run.push(node);
      else if (run.length) run.push(node);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const e = node as Element;
    const name = e.localName;
    if (!BLOCKS.has(name) && name !== 'img' && name !== 'svg') {
      run.push(e);
      continue;
    }
    flushRun();
    const id = e.getAttribute('id');
    if (id) ctx.pendingIds.push(id);
    const type = epubType(e);
    if (/^h[1-6]$/.test(name)) {
      inlineBlock(ctx, e, 'h', { level: Number(name[1]) });
    } else if (name === 'hr') {
      pushBlock(ctx, { t: 'hr', text: '' });
    } else if (name === 'img' || name === 'svg') {
      const images = name === 'img' ? [imgSrc(e, ctx.path)] : byLocal(e, 'image').map((im) => imgSrc(im, ctx.path));
      pushImages(ctx, images.filter((s): s is string => !!s), e.getAttribute('alt') ?? '');
    } else if (name === 'pre') {
      const text = e.textContent ?? '';
      if (text.trim()) pushBlock(ctx, { t: 'pre', text });
    } else if (name === 'ul' || name === 'ol') {
      let n = Number(e.getAttribute('start') ?? 1) || 1;
      ctx.listDepth++;
      for (const li of Array.from(e.children)) {
        if (li.localName !== 'li') {
          walk(li, ctx);
          continue;
        }
        const marker = name === 'ol' ? `${n++}.` : '•';
        const liId = li.getAttribute('id');
        if (liId) ctx.pendingIds.push(liId);
        if (hasBlockChild(li)) {
          // Put the marker on the first block produced for this item.
          const first = ctx.blocks.length;
          walk(li, ctx);
          for (let k = first; k < ctx.blocks.length; k++) {
            if (ctx.blocks[k].t === 'p' || ctx.blocks[k].t === 'quote') {
              ctx.blocks[k] = { ...ctx.blocks[k], t: 'li', marker: k === first ? marker : '', level: ctx.listDepth };
            }
          }
        } else inlineBlock(ctx, li, 'li', { marker, level: ctx.listDepth });
      }
      ctx.listDepth--;
    } else if (name === 'blockquote') {
      ctx.quote++;
      if (hasBlockChild(e)) walk(e, ctx);
      else inlineBlock(ctx, e, 'quote');
      ctx.quote--;
    } else if (name === 'table') {
      for (const tr of byLocal(e, 'tr')) {
        const cells = Array.from(tr.children).map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        if (cells.length) pushBlock(ctx, { t: 'p', text: cells.join(' | '), cls: 'table-row' });
      }
    } else if (/footnote|endnote|rearnote/.test(type) || (name === 'aside' && !hasBlockChild(e))) {
      const before = ctx.blocks.length;
      if (hasBlockChild(e)) walk(e, ctx);
      else inlineBlock(ctx, e, 'p');
      for (let k = before; k < ctx.blocks.length; k++) ctx.blocks[k] = { ...ctx.blocks[k], cls: `${ctx.blocks[k].cls ?? ''} footnote`.trim() };
    } else if (name === 'p' || name === 'dt' || name === 'dd' || name === 'figcaption' || name === 'caption' || name === 'summary' || !hasBlockChild(e)) {
      if (name === 'p' && hasBlockChild(e)) walk(e, ctx);
      else inlineBlock(ctx, e, ctx.quote ? 'quote' : 'p');
    } else {
      walk(e, ctx);
    }
  }
  flushRun();
}

/** Convert one XHTML document into blocks appended to ctx. Exported for tests. */
export function convertDocument(html: string, ctx: Ctx): void {
  // Nothing in a book should load or run: drop stylesheet links, scripts and event handlers.
  const safe = html.replace(/<link\b[^>]*>/gi, '').replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<\?xml[^>]*>/, '');
  const doc = new DOMParser().parseFromString(safe, 'text/html');
  const body = doc.body ?? doc.documentElement;
  if (body) walk(body, ctx);
  // Ids that never got a block point at the next chapter's start; drop them.
  ctx.pendingIds = [];
}

export function newCtx(): Ctx {
  return { path: '', page: 0, blocks: [], anchors: {}, pendingIds: [], images: new Set(), quote: 0, listDepth: 0 };
}

/* ---------------- CSS ---------------- */

/** Scope publisher CSS under `.pub`, dropping fonts, imports and external resources. */
export function scopeCss(css: string): string {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@charset[^;]*;/gi, '').replace(/@import[^;]*;/gi, '');
  let out = '';
  let i = 0;
  const readBlock = (from: number): number => {
    let depth = 0;
    for (let k = from; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') {
        depth--;
        if (depth === 0) return k;
      }
    }
    return src.length - 1;
  };
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const selector = src.slice(i, open).trim();
    const close = readBlock(open);
    const body = src.slice(open + 1, close);
    i = close + 1;
    if (selector.startsWith('@media')) {
      out += scopeCss(body);
      continue;
    }
    if (selector.startsWith('@')) continue; // @font-face, @page, @namespace...
    const decls = body
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d && !/url\(/i.test(d) && !/^(position|font-family|width|height|max-width|max-height|min-height|float|display)\s*:/i.test(d));
    if (!decls.length) continue;
    const sel = selector
      .split(',')
      .map((s) => s.trim().replace(/^(html|body)\b\s*/i, ''))
      .map((s) => (s ? `.pub ${s}` : '.pub'))
      .join(', ');
    out += `${sel} { ${decls.join('; ')}; }\n`;
  }
  return out;
}

/* ---------------- package ---------------- */

const FONT_OBFUSCATION = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'];

export async function parseEpub(data: ArrayBuffer): Promise<EpubBook> {
  const JSZip = (await import('jszip')).default;
  let zip: import('jszip');
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new EpubError('This file is not a valid EPUB.');
  }
  const read = async (path: string): Promise<string | null> => {
    const f = zip.file(path) ?? zip.file(decodeURI(path));
    return f ? f.async('string') : null;
  };

  // DRM: Adobe/Readium rights files, or encrypted content beyond font obfuscation.
  if (zip.file('META-INF/rights.xml')) throw new DrmError('This book is protected with DRM, so it cannot be opened here. EasyRead can only open DRM-free EPUB files.');
  const enc = await read('META-INF/encryption.xml');
  if (enc) {
    const algs = byLocal(parseXml(enc), 'EncryptionMethod').map((m) => m.getAttribute('Algorithm') ?? '');
    if (algs.some((a) => !FONT_OBFUSCATION.includes(a))) {
      throw new DrmError('This book is protected with DRM, so it cannot be opened here. EasyRead can only open DRM-free EPUB files.');
    }
  }

  const container = await read('META-INF/container.xml');
  const opfPath = container ? byLocal(parseXml(container), 'rootfile')[0]?.getAttribute('full-path') : null;
  const opfText = opfPath ? await read(opfPath) : null;
  if (!opfPath || !opfText) throw new EpubError('This EPUB is missing its package file.');
  const opf = parseXml(opfText);

  const meta = (name: string) => byLocal(opf, name)[0]?.textContent?.trim() ?? '';
  const title = meta('title') || 'Untitled';
  const author = byLocal(opf, 'creator').map((c) => c.textContent?.trim()).filter(Boolean).join(', ');
  const lang = (meta('language') || 'en').slice(0, 2).toLowerCase();

  const manifest = new Map<string, { href: string; type: string; props: string }>();
  for (const item of byLocal(opf, 'item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href) manifest.set(id, { href: resolvePath(opfPath, href), type: item.getAttribute('media-type') ?? '', props: item.getAttribute('properties') ?? '' });
  }
  const spineEl = byLocal(opf, 'spine')[0];
  const spine = byLocal(opf, 'itemref')
    .map((r) => manifest.get(r.getAttribute('idref') ?? ''))
    .filter((m): m is { href: string; type: string; props: string } => !!m && /html|xml/.test(m.type));
  if (!spine.length) throw new EpubError('This EPUB has no readable chapters.');

  // Cover image.
  let cover: string | undefined = [...manifest.values()].find((m) => /cover-image/.test(m.props))?.href;
  if (!cover) {
    const metaCover = byLocal(opf, 'meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
    const m = metaCover ? manifest.get(metaCover) : undefined;
    if (m && m.type.startsWith('image/')) cover = m.href;
  }

  // Content.
  const ctx = newCtx();
  const chapterStarts: number[] = [];
  for (let i = 0; i < spine.length; i++) {
    const html = await read(spine[i].href);
    if (html === null) continue;
    ctx.path = spine[i].href;
    ctx.page = i;
    chapterStarts.push(ctx.blocks.length);
    convertDocument(html, ctx);
  }

  // Images and cover.
  const resources = new Map<string, EpubResource>();
  const wanted = new Set(ctx.images);
  if (cover) wanted.add(cover);
  for (const path of wanted) {
    const f = zip.file(path);
    if (!f) continue;
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const type = [...manifest.values()].find((m) => m.href === path)?.type || MIME[ext] || 'application/octet-stream';
    resources.set(path, { data: await f.async('uint8array'), type });
  }

  // CSS.
  let css = '';
  for (const m of manifest.values()) {
    if (m.type !== 'text/css') continue;
    const t = await read(m.href);
    if (t) css += scopeCss(t);
  }

  // Table of contents: EPUB 3 nav, else EPUB 2 NCX.
  const toc: TocEntry[] = [];
  const target = (href: string) => ctx.anchors[href] ?? ctx.anchors[href.split('#')[0]];
  const navItem = [...manifest.values()].find((m) => /\bnav\b/.test(m.props));
  if (navItem) {
    const navHtml = await read(navItem.href);
    if (navHtml) {
      const doc = new DOMParser().parseFromString(navHtml, 'text/html');
      const navs = Array.from(doc.getElementsByTagName('nav'));
      const nav = navs.find((n) => /toc/.test(epubType(n))) ?? navs[0];
      const walkOl = (ol: Element, level: number) => {
        for (const li of Array.from(ol.children).filter((c) => c.localName === 'li')) {
          const a = Array.from(li.children).find((c) => c.localName === 'a' || c.localName === 'span');
          const href = a?.getAttribute('href');
          const label = (a?.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (href && label) {
            const b = target(resolvePath(navItem.href, href));
            if (b !== undefined) toc.push({ title: label, block: b, level: Math.min(level, 2) });
          }
          const sub = Array.from(li.children).find((c) => c.localName === 'ol' || c.localName === 'ul');
          if (sub) walkOl(sub, level + 1);
        }
      };
      const ol = nav ? Array.from(nav.children).find((c) => c.localName === 'ol' || c.localName === 'ul') : undefined;
      if (ol) walkOl(ol, 0);
    }
  }
  if (!toc.length) {
    const ncxId = spineEl?.getAttribute('toc');
    const ncx = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');
    const ncxText = ncx ? await read(ncx.href) : null;
    if (ncx && ncxText) {
      const doc = parseXml(ncxText);
      const walkNp = (el: Element, level: number) => {
        for (const np of Array.from(el.children).filter((c) => c.localName === 'navPoint')) {
          const label = byLocal(np, 'text')[0]?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          const src = byLocal(np, 'content')[0]?.getAttribute('src');
          if (label && src) {
            const b = target(resolvePath(ncx.href, src));
            if (b !== undefined) toc.push({ title: label, block: b, level: Math.min(level, 2) });
          }
          walkNp(np, level + 1);
        }
      };
      const map = byLocal(doc, 'navMap')[0];
      if (map) walkNp(map, 0);
    }
  }
  if (!toc.length) {
    ctx.blocks.forEach((b, i) => {
      if (b.t === 'h' && (b.level ?? 1) <= 2) toc.push({ title: b.text, block: i, level: 0 });
    });
  }

  // Sections: one per chapter file (capped in size), so rendering stays fast.
  const sections: Section[] = [];
  const starts = [...new Set(chapterStarts.filter((s) => s < ctx.blocks.length))].sort((a, b) => a - b);
  if (!starts.length || starts[0] !== 0) starts.unshift(0);
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : ctx.blocks.length;
    if (end <= start) continue;
    const entry = [...toc].reverse().find((t) => t.block <= start);
    const title = entry?.title ?? title0(ctx.blocks, start, end);
    for (let s = start; s < end; s += 300) sections.push({ title, start: s, end: Math.min(end, s + 300) });
  }
  if (!sections.length) sections.push({ title: 'Start', start: 0, end: 0 });

  const charIndex: number[] = [0];
  for (const b of ctx.blocks) charIndex.push(charIndex[charIndex.length - 1] + b.text.length + 1);

  return {
    title,
    author,
    lang,
    content: { blocks: ctx.blocks, sections, toc, charIndex, anchors: ctx.anchors },
    css,
    cover,
    resources,
  };
}

function title0(blocks: Block[], start: number, end: number): string {
  for (let i = start; i < end; i++) if (blocks[i].t === 'h') return blocks[i].text;
  return 'Start';
}
