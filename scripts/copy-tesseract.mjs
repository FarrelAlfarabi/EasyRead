// Copies the OCR engine (tesseract.js worker + wasm core) into public/tesseract
// so it is served from our own site instead of a CDN. Runs before dev and build.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const out = join(dirname(new URL(import.meta.url).pathname), '..', 'public', 'tesseract');
mkdirSync(out, { recursive: true });
const tessDir = dirname(require.resolve('tesseract.js/package.json'));
const coreDir = dirname(require.resolve('tesseract.js-core/package.json'));
copyFileSync(join(tessDir, 'dist', 'worker.min.js'), join(out, 'worker.min.js'));
for (const v of ['', '-simd', '-relaxedsimd']) {
  const f = `tesseract-core${v}-lstm.wasm.js`;
  copyFileSync(join(coreDir, f), join(out, f));
}
// English and Indonesian language data ship with the app. Other languages load from a CDN once.
mkdirSync(join(out, 'lang'), { recursive: true });
for (const lang of ['eng', 'ind']) {
  const dir = dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
  copyFileSync(join(dir, '4.0.0_best_int', `${lang}.traineddata.gz`), join(out, 'lang', `${lang}.traineddata.gz`));
}
console.log('OCR engine copied to public/tesseract');
