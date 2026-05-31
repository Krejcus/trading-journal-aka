// Edge Function: chat
// Streaming proxy to Anthropic Messages API. The Anthropic API key lives only in
// Supabase secrets — never exposed to the client. Client sends the request body
// (model, messages, tools, system, stream, thinking) and gets back the SSE stream.
//
// v2: forwards interleaved-thinking beta header so Claude can think between
// tool calls (extended thinking with tool use).
//
// verify_jwt=true ensures only authenticated users can hit this endpoint.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');

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

  const body = await req.text();

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
