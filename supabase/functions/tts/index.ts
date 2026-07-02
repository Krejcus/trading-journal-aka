// Edge Function: tts
// ElevenLabs Text-to-Speech proxy. API klíč žije jen v Supabase secrets (ELEVENLABS_API_KEY),
// nikdy v klientu. Klient pošle { text, voice?, rate? } a dostane zpět { audioContent: base64 mp3 }.
//
// Nativní přirozený český hlas přes multilingual model. Výrazně lidštější než browser TTS.
// verify_jwt=true jen ověří podpis tokenu — anon key (v klientu) tím projde. Skutečné ověření
// přihlášeného uživatele dělá supabase.auth.getUser() níže, jinak je to otevřený proxy na placené
// ElevenLabs kredity (libovolně dlouhý text = libovolná spotřeba).

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const ELEVENLABS_API_KEY = Deno.env.get('ELEVENLABS_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// Strop délky textu — obrana i proti zneužití přihlášeným účtem (jedna promluva coache je krátká).
const MAX_TTS_CHARS = 5000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Premade hlas (dostupný i na free účtu). Lze přepnout přes body.voice (voice_id z ElevenLabs).
const DEFAULT_VOICE_ID = 'uYFJyGaibp4N2VwYQshk'; // uživatelův hlas z My Voices
// Flash = nejnižší latence + nejlevnější kredity, podporuje češtinu (multilingual).
const MODEL_ID = 'eleven_flash_v2_5';

// Bezpečný base64 encode pro velké buffery (btoa na celém poli přeteče stack).
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method-not-allowed' }), {
      status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  // Klíč není nastavený → 501, klient spadne na browser TTS.
  if (!ELEVENLABS_API_KEY) {
    return new Response(JSON.stringify({ error: 'ELEVENLABS_API_KEY not configured' }), {
      status: 501, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // Ověření reálného uživatele — anon key sem nesmí projít.
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

  let body: { text?: string; voice?: string };
  try { body = await req.json(); } catch { body = {}; }
  const text = (body.text || '').trim().slice(0, MAX_TTS_CHARS);
  if (!text) {
    return new Response(JSON.stringify({ error: 'empty-text' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const voiceId = body.voice || DEFAULT_VOICE_ID;

  const elRes = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
      }),
    },
  );

  if (!elRes.ok) {
    const errText = await elRes.text().catch(() => '');
    console.error('[tts] ElevenLabs error', elRes.status, errText);
    return new Response(JSON.stringify({ error: `elevenlabs-${elRes.status}`, detail: errText.slice(0, 300) }), {
      status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const audioBuf = await elRes.arrayBuffer();
  return new Response(JSON.stringify({ audioContent: toBase64(audioBuf) }), {
    status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
});
