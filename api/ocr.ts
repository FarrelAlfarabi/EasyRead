// Vercel serverless function. Receives one page image from the browser and asks a cloud
// vision model to transcribe it: Google Gemini first, or Groq (Llama 4) when the client asks
// for it as a second opinion after Gemini fails. Both API keys live only here (GEMINI_API_KEY,
// GROQ_API_KEY, server-side env vars) and are never sent to the client. This is the only step
// in EasyRead where page image bytes leave the device, and only for scanned pages that need OCR.
import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = { maxDuration: 30 };

type Provider = 'gemini' | 'groq';

// "-latest" tracks Google's current recommended fast model, so this keeps working as models
// are retired. A pinned model is kept as a second try in case the alias or primary model
// is briefly unavailable. Groq's two current Llama 4 vision models play the same role.
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash-lite'];
const GROQ_MODELS = ['meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct'];

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
- Do not invent or guess text that is not visibly on the page.
Respond with a JSON object of the exact shape {"blocks": [{"type": "heading" | "paragraph" | "scene_break", "text": string}, ...]} and nothing else: no markdown fences, no commentary.`;
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
  const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  return fetch(`${base}/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
}

function textFromGemini(data: unknown): string {
  const d = data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return d.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
}

async function callGroq(model: string, key: string, image: string, mimeType: string, language: string | undefined, signal: AbortSignal) {
  const payload = {
    model,
    temperature: 0,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt(language) },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${image}` } },
        ],
      },
    ],
  };
  const url = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1/chat/completions';
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
    signal,
  });
}

function textFromGroq(data: unknown): string {
  const d = data as { choices?: Array<{ message?: { content?: string } }> };
  return d.choices?.[0]?.message?.content ?? '';
}

/** Groq sometimes wraps the JSON in a markdown fence or adds a stray sentence around it. */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) return fenced[1];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

const PROVIDERS: Record<Provider, { envKey: string; models: string[]; call: typeof callGemini; text: (d: unknown) => string; label: string }> = {
  gemini: { envKey: 'GEMINI_API_KEY', models: GEMINI_MODELS, call: callGemini, text: textFromGemini, label: 'Gemini' },
  groq: { envKey: 'GROQ_API_KEY', models: GROQ_MODELS, call: callGroq, text: textFromGroq, label: 'Groq' },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let body = req.body as { image?: string; mimeType?: string; language?: string; provider?: string } | string;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body) as { image?: string; mimeType?: string; language?: string; provider?: string };
    } catch {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
  }
  const image = body?.image;
  const mimeType = body?.mimeType || 'image/jpeg';
  const language = typeof body?.language === 'string' ? body.language.slice(0, 40) : undefined;
  const providerName: Provider = body?.provider === 'groq' ? 'groq' : 'gemini';
  const provider = PROVIDERS[providerName];
  if (!image || typeof image !== 'string') {
    res.status(400).json({ error: 'Missing image' });
    return;
  }

  const key = process.env[provider.envKey];
  if (!key) {
    res.status(500).json({ error: `OCR is not configured on the server (missing ${provider.label} API key).` });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    let lastStatus = 502;
    let lastText = '';
    for (const model of provider.models) {
      let r: Response;
      try {
        r = await provider.call(model, key, image, mimeType, language, controller.signal);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') {
          res.status(504).json({ error: `${provider.label} request timed out` });
          return;
        }
        lastText = String(e);
        continue;
      }
      if (r.ok) {
        const data = await r.json();
        const text = provider.text(data);
        let parsed: { blocks?: Block[] };
        try {
          parsed = JSON.parse(extractJson(text)) as { blocks?: Block[] };
        } catch {
          res.status(502).json({ error: `${provider.label} returned an unreadable response` });
          return;
        }
        if (!Array.isArray(parsed.blocks)) {
          res.status(502).json({ error: `${provider.label} response had no blocks` });
          return;
        }
        res.status(200).json({ blocks: parsed.blocks, model, provider: providerName });
        return;
      }
      lastStatus = r.status;
      lastText = await r.text().catch(() => '');
      // Try the next model if this one is retired (404) or briefly overloaded (503).
      // A per-key rate limit (429) or a real outage is the same for every model, so that
      // is passed straight back to the client, which does its own short retry/backoff.
      if (r.status !== 404 && r.status !== 503) break;
    }
    res.status(lastStatus).json({ error: `${provider.label} error ${lastStatus}: ${lastText.slice(0, 300)}` });
  } finally {
    clearTimeout(timer);
  }
}
