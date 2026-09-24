// Vercel serverless function. Receives one page image from the browser and asks Google
// Gemini to transcribe it. The Gemini API key lives only here (GEMINI_API_KEY, server-side
// env var) and is never sent to the client. This is the only step in EasyRead where page
// image bytes leave the device, and only for scanned pages that need OCR.
import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = { maxDuration: 30 };

// "-latest" tracks Google's current recommended fast model, so this keeps working as models
// are retired. A pinned model is kept as a second try in case the alias or primary model
// is briefly unavailable.
const MODELS = ['gemini-flash-latest', 'gemini-2.5-flash-lite'];

function buildPrompt(language?: string): string {
  const hint = language && language !== 'auto' ? `\nThe page is most likely written in ${language}. Transcribe it in that language; do not translate.` : '';
  return `You are transcribing one page of a printed book for an e-reader. Read the image and return the page's body text only.${hint}

Rules:
- Do not include running headers, footers, or page numbers.
- Fix words that were split across a line break with a hyphen (join them back into one word).
- Keep the text in its original reading order and language. Do not translate or summarize.
- Split the text into blocks: one block per paragraph.
- If a line is a chapter title, section heading, or similar (short, standalone, not part of a paragraph), make it its own block with type "heading".
- If the page shows a typographic scene break (e.g. a centered row of asterisks or symbols, or a large blank gap marking a break within a chapter), add a block with type "scene_break" and empty text.
- If the page has no readable text at all, return an empty blocks array.
- Do not invent or guess text that is not visibly on the page.`;
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    blocks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING', enum: ['heading', 'paragraph', 'scene_break'] },
          text: { type: 'STRING' },
        },
        required: ['type', 'text'],
      },
    },
  },
  required: ['blocks'],
};

interface Block {
  type: string;
  text: string;
}

async function callGemini(model: string, key: string, image: string, mimeType: string, language: string | undefined, signal: AbortSignal) {
  const payload = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(language) }, { inlineData: { mimeType, data: image } }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA },
  };
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'OCR is not configured on the server (missing API key).' });
    return;
  }

  let body = req.body as { image?: string; mimeType?: string; language?: string } | string;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body) as { image?: string; mimeType?: string; language?: string };
    } catch {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
  }
  const image = body?.image;
  const mimeType = body?.mimeType || 'image/jpeg';
  const language = typeof body?.language === 'string' ? body.language.slice(0, 40) : undefined;
  if (!image || typeof image !== 'string') {
    res.status(400).json({ error: 'Missing image' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    let lastStatus = 502;
    let lastText = '';
    for (const model of MODELS) {
      let r: Response;
      try {
        r = await callGemini(model, key, image, mimeType, language, controller.signal);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') {
          res.status(504).json({ error: 'Gemini request timed out' });
          return;
        }
        lastText = String(e);
        continue;
      }
      if (r.ok) {
        const data = (await r.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
        let parsed: { blocks?: Block[] };
        try {
          parsed = JSON.parse(text) as { blocks?: Block[] };
        } catch {
          res.status(502).json({ error: 'Gemini returned an unreadable response' });
          return;
        }
        if (!Array.isArray(parsed.blocks)) {
          res.status(502).json({ error: 'Gemini response had no blocks' });
          return;
        }
        res.status(200).json({ blocks: parsed.blocks, model });
        return;
      }
      lastStatus = r.status;
      lastText = await r.text().catch(() => '');
      // Try the next model only if this one is unavailable/not-found; a real quota/server
      // error is the same for every model, so pass it straight through.
      if (r.status !== 404) break;
    }
    res.status(lastStatus).json({ error: `Gemini error ${lastStatus}: ${lastText.slice(0, 300)}` });
  } finally {
    clearTimeout(timer);
  }
}
