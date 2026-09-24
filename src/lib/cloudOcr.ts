import type { Line } from './types';

export type CloudProvider = 'gemini' | 'groq';

export interface CloudBlock {
  type: 'heading' | 'paragraph' | 'scene_break';
  text: string;
}

export class CloudOcrError extends Error {
  provider: CloudProvider;
  /** True for errors worth retrying (timeouts, 429, 5xx). False for things like a missing API key. */
  retryable: boolean;
  constructor(provider: CloudProvider, message: string, retryable: boolean) {
    super(message);
    this.provider = provider;
    this.retryable = retryable;
  }
}

/** Sends one rendered page to the server-side /api/ocr route, which calls the given provider. */
export async function cloudOcrPage(canvas: HTMLCanvasElement, language: string, provider: CloudProvider, timeoutMs = 20000): Promise<CloudBlock[]> {
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: base64, mimeType: 'image/jpeg', language, provider }),
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new CloudOcrError(provider, `${provider} OCR timed out`, true);
    throw new CloudOcrError(provider, `${provider} OCR network error`, true);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    let detail = '';
    try {
      detail = (await res.json())?.error ?? '';
    } catch {
      /* ignore */
    }
    throw new CloudOcrError(provider, detail || `${provider} OCR failed (${res.status})`, retryable);
  }

  const data = (await res.json()) as { blocks?: CloudBlock[] };
  if (!Array.isArray(data.blocks)) throw new CloudOcrError(provider, `${provider} OCR returned no text`, true);
  return data.blocks;
}

/**
 * Converts a provider's structured page transcription into synthetic Lines, one per block, so
 * it can flow through the same reflow pipeline as pdf.js text and Tesseract output. Each Line
 * carries `kind`, which tells buildBlocks to use it directly instead of guessing layout from
 * position (the model already read the whole page and made that call).
 */
export function cloudBlocksToLines(blocks: CloudBlock[], pageWidth: number): Line[] {
  const left = 54;
  const w = Math.max(100, pageWidth - left * 2);
  const out: Line[] = [];
  let y = 40;
  for (const b of blocks) {
    if (b.type === 'scene_break') {
      out.push({ text: '* * *', x: left, y, w, size: 11, kind: 'hr' });
      y += 30;
      continue;
    }
    const text = (b.text ?? '').replace(/[ \t]+/g, ' ').trim();
    if (!text) continue;
    const heading = b.type === 'heading';
    const size = heading ? 16 : 11;
    out.push({ text, x: left, y, w, size, kind: heading ? 'h' : 'p' });
    y += size * (heading ? 2 : Math.max(2, Math.ceil(text.length / 70)));
  }
  return out;
}
