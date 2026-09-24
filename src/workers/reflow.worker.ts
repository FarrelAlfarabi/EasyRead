/// <reference lib="webworker" />
import { buildContent } from '../lib/reflow';
import type { OutlineItem, PageData } from '../lib/types';

interface Req { id: number; pages: PageData[]; outline: OutlineItem[] }

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, pages, outline } = e.data;
  try {
    const content = buildContent(pages, outline);
    (self as unknown as Worker).postMessage({ id, content });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
