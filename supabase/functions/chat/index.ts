// Edge Function: chat
// Streaming proxy to Anthropic Messages API. The Anthropic API key lives only in
// Supabase secrets — never exposed to the client. Client sends the request body
// (model, messages, tools, system, stream, thinking) and gets back the SSE stream.
//
// v2: forwards interleaved-thinking beta header so Claude can think between
// tool calls (extended thinking with tool use).
//
// verify_jwt=true jen ověří, že token je podepsaný — anon key (v klientském bundlu) tím projde.
// Skutečné ověření přihlášeného uživatele dělá supabase.auth.getUser() níže: anon key nemá
// user.sub, takže getUser() ho odmítne. Bez toho je funkce otevřený proxy na placené Anthropic API.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// Strop max_tokens (obrana i proti zneužití přihlášeným účtem). Klient používá ≤4096.
const MAX_TOKENS_CEILING = 8192;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method-not-allowed' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // Ověření reálného uživatele — anon key sem nesmí projít (viz komentář nahoře).
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'missing-auth' }), {
      status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: 'auth-failed' }), {
      status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // Parse + obrana proti zneužití: jen Claude modely, max_tokens se stropem.
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(await req.text()); } catch {
    return new Response(JSON.stringify({ error: 'invalid-json' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  if (typeof payload.model !== 'string' || !payload.model.startsWith('claude-')) {
    return new Response(JSON.stringify({ error: 'invalid-model' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  payload.max_tokens = typeof payload.max_tokens === 'number'
    ? Math.min(payload.max_tokens, MAX_TOKENS_CEILING)
    : 4096;
  const body = JSON.stringify(payload);

  // Beta features we opt into:
  //  - interleaved-thinking: Claude can think between tool calls inside one assistant turn.
  //    Required when request body has `thinking: { type: 'enabled' }` AND `tools` set.
  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
      'Content-Type': 'application/json',
    },
    body,
  });

  // Forward the response stream (or JSON error) back to the client.
  const responseHeaders: Record<string, string> = {
    ...CORS_HEADERS,
    'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
  };

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
});
