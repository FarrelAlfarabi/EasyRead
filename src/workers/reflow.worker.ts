/// <reference lib="webworker" />
import { buildContent } from '../lib/reflow';
import { loadWordRanks, type WordRanks } from '../lib/ocrCleanup';
import type { OutlineItem, PageData } from '../lib/types';

interface Req { id: number; pages: PageData[]; outline: OutlineItem[]; english?: boolean }

let dict: Promise<WordRanks | undefined> | null = null;
function englishDict(): Promise<WordRanks | undefined> {
  if (!dict) {
    dict = fetch('/dict/en-words.txt')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(loadWordRanks)
      .catch(() => {
        dict = null;
        return undefined;
      });
  }
  return dict;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, pages, outline, english } = e.data;
  try {
    const words = english ? await englishDict() : undefined;
    const content = buildContent(pages, outline, { dict: words });
    (self as unknown as Worker).postMessage({ id, content });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
