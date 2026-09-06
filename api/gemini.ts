import type { VercelRequest, VercelResponse } from '@vercel/node';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const PROXY_SECRET = process.env.PROXY_SECRET || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

const PRIMARY_MODEL = 'gemini-3.6-flash';
const FALLBACK_MODEL = 'gemini-2.5-flash';

// Limite grosseiro de tamanho do payload, pra evitar que alguém mande
// requisições gigantes só pra gastar sua cota da API.
const MAX_CONTENTS_JSON_LENGTH = 50_000; // ~50KB de texto

async function callGeminiDirect(model: string, body: any): Promise<Response> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Só tenta o modelo de fallback quando o erro é do lado do Gemini
// (5xx, instabilidade, timeout) — nunca quando o erro é do próprio
// request (4xx), porque aí o segundo modelo vai falhar do mesmo jeito
// e você paga/gasta cota por uma chamada que não tinha chance de dar certo.
function shouldRetryWithFallback(status: number): boolean {
  return status >= 500;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ── CORS restrito ──────────────────────────────────────────────
  // Antes: '*' liberava qualquer site do mundo a chamar seu proxy.
  // Agora: só a origem configurada em ALLOWED_ORIGIN pode chamar.
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-App-Secret');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Autenticação ───────────────────────────────────────────────
  // Antes: qualquer pessoa que descobrisse a URL podia chamar o proxy
  // direto e gastar sua cota do Gemini.
  // Agora: só quem manda o segredo correto no header consegue passar.
  // O app (frontend) precisa enviar esse mesmo valor no header X-App-Secret.
  const providedSecret = req.headers['x-app-secret'];
  if (!PROXY_SECRET || providedSecret !== PROXY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!GEMINI_API_KEY) {
    // Não exponha detalhes de configuração do servidor pro cliente.
    console.error('[DanceOS Gemini Proxy] GEMINI_API_KEY ausente na configuração do servidor.');
    return res.status(500).json({ error: 'Erro de configuração do servidor.' });
  }

  const { model = PRIMARY_MODEL, contents, generationConfig, systemInstruction } = req.body ?? {};

  if (!contents || !Array.isArray(contents)) {
    return res.status(400).json({ error: 'Missing or invalid "contents" field.' });
  }

  // ── Limite de tamanho ──────────────────────────────────────────
  const contentsSize = JSON.stringify(contents).length;
  if (contentsSize > MAX_CONTENTS_JSON_LENGTH) {
    return res.status(413).json({ error: 'Payload too large.' });
  }

  const requestBody: any = { contents };
  if (generationConfig) requestBody.generationConfig = generationConfig;
  if (systemInstruction) requestBody.system_instruction = systemInstruction;

  try {
    let geminiRes = await callGeminiDirect(model, requestBody);

    if (!geminiRes.ok && model === PRIMARY_MODEL && shouldRetryWithFallback(geminiRes.status)) {
      geminiRes = await callGeminiDirect(FALLBACK_MODEL, requestBody);
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      // Loga o erro completo no servidor (visível nos logs da Vercel),
      // mas devolve uma mensagem genérica pro cliente — não repasse
      // o corpo cru do erro do Gemini, que pode conter detalhes internos.
      console.error('[DanceOS Gemini Proxy] Gemini error:', geminiRes.status, errText);
      return res.status(geminiRes.status).json({ error: 'Erro ao processar a requisição.' });
    }

    const data = await geminiRes.json();
    return res.status(200).json(data);
  } catch (error: any) {
    console.error('[DanceOS Gemini Proxy]', error?.message);
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
}
