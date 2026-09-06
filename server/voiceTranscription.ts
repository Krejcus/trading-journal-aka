import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleNativeCors } from './nativeCors.js';

export const MAX_VOICE_BYTES = 3 * 1024 * 1024;
const AUDIO_TYPES = new Map([
  ['audio/webm', 'webm'], ['audio/mp4', 'm4a'], ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/ogg', 'ogg'], ['audio/flac', 'flac'],
]);

type Dependencies = {
  authorize: (authorization: string) => Promise<string | null>;
  apiKey: () => string | undefined;
  fetch: typeof fetch;
  now: () => number;
};

export function createVoiceTranscriptionHandler(deps: Dependencies) {
  // Additional instance-local burst protection. Authentication and bounded uploads
  // apply on every instance; the provider also enforces the server key's quota.
  const attempts = new Map<string, { since: number; count: number }>();
  return async (req: VercelRequest, res: VercelResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    if (handleNativeCors(req, res, ['POST'])) return;
    if (req.method !== 'POST') { res.status(405).json({ error: 'method-not-allowed' }); return; }
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    if (!/^Bearer \S+$/.test(authorization)) { res.status(401).json({ error: 'authentication-required' }); return; }
    let userId: string | null;
    try { userId = await deps.authorize(authorization); }
    catch { res.status(503).json({ error: 'authentication-unavailable' }); return; }
    if (!userId) { res.status(401).json({ error: 'authentication-required' }); return; }
    const key = deps.apiKey()?.trim();
    if (!key) { res.status(503).json({ error: 'transcription-unavailable' }); return; }
    const body = req.body;
    const audio = body?.audio;
    const mime = typeof body?.mimeType === 'string' ? body.mimeType.split(';')[0].toLowerCase() : '';
    if (typeof audio !== 'string' || !audio.length || audio.length > Math.ceil(MAX_VOICE_BYTES / 3) * 4) {
      res.status(413).json({ error: 'audio-size-limit' }); return;
    }
    if (!AUDIO_TYPES.has(mime) || (audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio))) {
      res.status(400).json({ error: 'invalid-audio' }); return;
    }
    const bytes = Buffer.from(audio, 'base64');
    if (bytes.toString('base64') !== audio) { res.status(400).json({ error: 'invalid-audio' }); return; }
    if (!bytes.length || bytes.length > MAX_VOICE_BYTES) { res.status(413).json({ error: 'audio-size-limit' }); return; }
    const language = body.language ?? 'cs';
    const prompt = body.prompt ?? '';
    if (typeof language !== 'string' || !/^[a-z]{2}$/.test(language)
      || typeof prompt !== 'string' || prompt.length > 2000) {
      res.status(400).json({ error: 'invalid-transcription-options' }); return;
    }
    const now = deps.now();
    for (const [id, entry] of attempts) if (now - entry.since >= 60_000) attempts.delete(id);
    const entry = attempts.get(userId) ?? { since: now, count: 0 };
    if (entry.count >= 10) { res.setHeader('Retry-After', '60'); res.status(429).json({ error: 'transcription-rate-limit' }); return; }
    attempts.set(userId, { ...entry, count: entry.count + 1 });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), `memo.${AUDIO_TYPES.get(mime)}`);
    form.append('model', 'whisper-large-v3');
    form.append('language', language);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (prompt) form.append('prompt', prompt);
    try {
      const response = await deps.fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) {
        res.status(response.status === 429 ? 429 : 502).json({ error: 'transcription-provider-unavailable' }); return;
      }
      const data = await response.json() as { text?: unknown };
      if (typeof data.text !== 'string') { res.status(502).json({ error: 'invalid-transcription-response' }); return; }
      res.status(200).json({ text: data.text.trim() });
    } catch { res.status(502).json({ error: 'transcription-provider-unavailable' }); }
  };
}

export const handleVoiceTranscription = createVoiceTranscriptionHandler({
  apiKey: () => process.env.GROQ_API_KEY,
  fetch: (input, init) => fetch(input, init),
  now: Date.now,
  authorize: async authorization => {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error('missing-auth-configuration');
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.auth.getUser(authorization.slice(7));
    return error ? null : data.user?.id ?? null;
  },
});
