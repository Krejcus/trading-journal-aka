// Edge Function: gemini-chat
// Streaming proxy na Google Gemini API. Klíč (GEMINI_API_KEY) žije jen v Supabase secrets,
// nikdy v klientu. Klient pošle { model, payload } (contents/systemInstruction/tools/generationConfig)
// a dostane zpět SSE stream (alt=sse), který parsuje stejně jako kdyby volal Google přímo.
//
// Tool-use smyčka zůstává na klientovi (stejně jako u `chat` proxy pro Anthropic) — tahle funkce
// je čistý stateless passthrough. verify_jwt=true → jen přihlášení uživatelé.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method-not-allowed' }), {
      status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  // Klíč není nastavený → 501, klient spadne na Haiku (Anthropic proxy).
  if (!GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }), {
      status: 501, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  let body: { model?: string; payload?: unknown };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'invalid-json' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const model = (body.model || 'gemini-2.5-flash').replace(/[^a-zA-Z0-9.\-]/g, ''); // sanitizace
  if (!body.payload) {
    return new Response(JSON.stringify({ error: 'missing-payload' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body.payload),
    },
  );

  // Forwarduj stream (nebo JSON error) zpět klientovi.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': upstream.headers.get('Content-Type') || 'text/event-stream',
    },
  });
});
