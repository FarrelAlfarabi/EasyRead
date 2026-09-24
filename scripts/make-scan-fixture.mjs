// Builds test/fixtures/scan-ocr-layer.pdf: a scanned-looking page (full-page image) with an
// invisible scanner OCR text layer (render mode 3) that contains the kind of broken text real
// scanners produce: letter-spaced headings, glued words, dash-split words, jittery font sizes.
import { writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, pushGraphicsState, popGraphicsState, setTextRenderingMode, TextRenderingMode } from 'pdf-lib';

const doc = await PDFDocument.create();
const page = doc.addPage([432, 648]);
// A plain light "scan" image covering the page (1x1 PNG stretched).
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4//8/AwAI/AL+hc2rNAAAAABJRU5ErkJggg==', 'base64');
const img = await doc.embedPng(png);
page.drawImage(img, { x: 0, y: 0, width: 432, height: 648 });
const font = await doc.embedFont(StandardFonts.TimesRoman);
page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
const lines = [
  ['L A W 2 0', 20, 'c'],
  ['D O N OT C OM MIT TO ANYONE', 16, 'c'],
  ['J U D GM ENT', 13, 'c'],
  ['It is thefool who always rushes to take sides. Do not com-', 11],
  ['mit to any side or cause but yourself. By maintaining your', 13.5],
  ['independence, you become the master of others——playing', 11],
  ['people against one another, making them pursue you. Ifyou', 13.5],
  ['do not commit, tfwy will only try harder to win you over.', 11],
  ['By not committing your affections, they will hold at—', 13.5],
  ['tention and frustrated desire, hope but never satisfaction.', 11],
  ['O B S E RVAN CE OF THE LAW', 13, 'c'],
  ['When Queen Elizabeth came to the throne, the Par liament', 11],
  ['urged her to find a husband, and she smiled at them.', 13.5],
];
let y = 590;
for (const [t, size, align] of lines) {
  const w = font.widthOfTextAtSize(t, size);
  const x = align === 'c' ? (432 - w) / 2 : 40;
  page.drawText(t, { x, y, size, font });
  y -= align === 'c' ? size * 2 : 17;
}
page.pushOperators(popGraphicsState());
writeFileSync(new URL('../test/fixtures/scan-ocr-layer.pdf', import.meta.url), await doc.save());
console.log('wrote test/fixtures/scan-ocr-layer.pdf');
