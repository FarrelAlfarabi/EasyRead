// Builds EPUB test fixtures in test/fixtures/:
//   sample.epub       EPUB 3: nav, cover image, CSS, inline image, footnote, list, quote
//   sample-epub2.epub EPUB 2: NCX table of contents only
//   drm.epub          encrypted content (must be refused)
import { writeFileSync } from 'node:fs';
import JSZip from 'jszip';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAGCAIAAABrW6giAAAAGklEQVR42mNkYGD4z4AHMOGTpL8CRgZGRgYAMOUBC0h3F0UAAAAASUVORK5CYII=', 'base64');

const xhtml = (title, body) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><title>${title}</title><link rel="stylesheet" href="../css/style.css"/></head>
<body>${body}</body></html>`;

const ch1 = xhtml('Chapter One', `
<section epub:type="chapter" id="c1">
<h1 id="ch1">Chapter One: The Lighthouse</h1>
<p class="first">It was a <em>dark</em> and <strong>stormy</strong> night, and Mr. Hale said the lamp would hold.<a epub:type="noteref" href="ch2.xhtml#fn1" id="r1"><sup>1</sup></a> Nobody believed him.</p>
<p>The keeper climbed the stairs. "Will it last?" asked Dr. Moore. It did, e.g. until dawn.</p>
<blockquote><p>Light is the first gift and the last.</p></blockquote>
<ul><li>Oil for the lamp</li><li>Bread and <i>cheese</i></li></ul>
<ol start="3"><li>Third item</li></ol>
<figure><img src="../images/map.png" alt="A map of the coast"/><figcaption>The coast in 1850.</figcaption></figure>
<p>By morning the sea was calm<br/>and the gulls came back.</p>
</section>`);

const ch2 = xhtml('Chapter Two', `
<section epub:type="chapter">
<h1>Chapter Two: Morning</h1>
<p>See <a href="ch1.xhtml#ch1">the first chapter</a> for the storm.</p>
<aside epub:type="footnote" id="fn1"><p>1. The lamp was an Argand burner, fitted in 1841.</p></aside>
</section>`);

const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body>
<nav epub:type="toc"><ol>
<li><a href="text/ch1.xhtml">Chapter One: The Lighthouse</a></li>
<li><a href="text/ch2.xhtml">Chapter Two: Morning</a><ol><li><a href="text/ch2.xhtml#fn1">Notes</a></li></ol></li>
</ol></nav></body></html>`;

const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>The Lighthouse</text></docTitle>
<navMap>
<navPoint id="n1" playOrder="1"><navLabel><text>Chapter One</text></navLabel><content src="text/ch1.xhtml"/></navPoint>
<navPoint id="n2" playOrder="2"><navLabel><text>Chapter Two</text></navLabel><content src="text/ch2.xhtml"/></navPoint>
</navMap></ncx>`;

const css = `body { font-family: "Fancy", serif; margin: 5%; } p.first { text-indent: 0; font-variant: small-caps; } @font-face { font-family: Fancy; src: url(../fonts/f.otf); } h1 { text-align: center; color: #333; background: url(../images/bg.png); } @media screen { .note { font-size: 0.8em; } }`;

async function build(file, { epub2 = false, drm = false } = {}) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  if (drm) zip.file('META-INF/encryption.xml', `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="OEBPS/text/ch1.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>`);
  const items = [
    `<item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>`,
    `<item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>`,
    `<item id="css" href="css/style.css" media-type="text/css"/>`,
    `<item id="map" href="images/map.png" media-type="image/png"/>`,
    epub2 ? `<item id="cover" href="images/cover.png" media-type="image/png"/>` : `<item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>`,
    epub2 ? `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>` : `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
  ];
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${epub2 ? '2.0' : '3.0'}" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:12345</dc:identifier><dc:title>The Lighthouse</dc:title><dc:creator>Ada Keeper</dc:creator><dc:language>en</dc:language>
${epub2 ? '<meta name="cover" content="cover"/>' : ''}
</metadata>
<manifest>${items.join('')}</manifest>
<spine${epub2 ? ' toc="ncx"' : ''}><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`);
  zip.file('OEBPS/text/ch1.xhtml', ch1);
  zip.file('OEBPS/text/ch2.xhtml', ch2);
  zip.file('OEBPS/css/style.css', css);
  zip.file('OEBPS/images/map.png', PNG);
  zip.file('OEBPS/images/cover.png', PNG);
  if (epub2) zip.file('OEBPS/toc.ncx', ncx);
  else zip.file('OEBPS/nav.xhtml', nav);
  writeFileSync(new URL(`../test/fixtures/${file}`, import.meta.url), await zip.generateAsync({ type: 'nodebuffer' }));
}

await build('sample.epub');
await build('sample-epub2.epub', { epub2: true });
await build('drm.epub', { drm: true });
console.log('EPUB fixtures written');
