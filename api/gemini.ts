import type { VercelRequest, VercelResponse } from '@vercel/node';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const PRIMARY_MODEL = 'gemini-3.6-flash';
const FALLBACK_MODEL = 'gemini-2.5-flash';

async function callGeminiDirect(model: string, body: any): Promise<Response> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server.' });
  }

  const { model = PRIMARY_MODEL, contents, generationConfig, systemInstruction } = req.body ?? {};

  if (!contents || !Array.isArray(contents)) {
    return res.status(400).json({ error: 'Missing or invalid "contents" field.' });
  }

  const requestBody: any = { contents };
  if (generationConfig) requestBody.generationConfig = generationConfig;
  if (systemInstruction) requestBody.system_instruction = systemInstruction;

  try {
    let geminiRes = await callGeminiDirect(model, requestBody);
    if (!geminiRes.ok && model === PRIMARY_MODEL) {
      geminiRes = await callGeminiDirect(FALLBACK_MODEL, requestBody);
    }
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(geminiRes.status).json({ error: errText });
    }
    const data = await geminiRes.json();
    return res.status(200).json(data);
  } catch (error: any) {
    console.error('[DanceOS Gemini Proxy]', error?.message);
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
}
