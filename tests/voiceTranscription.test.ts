import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createVoiceTranscriptionHandler, MAX_VOICE_BYTES } from '../server/voiceTranscription';

function fixture() {
  const authorize = vi.fn().mockResolvedValue('user-a');
  const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: ' text ' }), { status: 200 }));
  const handler = createVoiceTranscriptionHandler({ authorize, apiKey: () => 'server-only-example', fetch: send, now: () => 1000 });
  const req: any = { method: 'POST', headers: { authorization: 'Bearer user-session' }, body: { audio: 'dGVzdA==', mimeType: 'audio/mp4', language: 'cs' } };
  const res: any = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn(), end: vi.fn() };
  return { authorize, send, handler, req, res };
}
describe('authenticated server voice transcription', () => {
  it('rejects missing/invalid auth before sending audio to the provider', async () => {
    const f = fixture(); delete f.req.headers.authorization;
    await f.handler(f.req, f.res);
    expect(f.res.status).toHaveBeenCalledWith(401); expect(f.authorize).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    f.req.headers.authorization = 'Bearer invalid'; f.authorize.mockResolvedValue(null);
    await f.handler(f.req, f.res); expect(f.send).not.toHaveBeenCalled();
  });
  it('uses only the server key and returns only the transcript', async () => {
    const f = fixture(); f.req.body.apiKey = 'untrusted'; f.req.body.userId = 'someone-else';
    await f.handler(f.req, f.res);
    expect(f.send.mock.calls[0][1].headers.Authorization).toBe('Bearer server-only-example');
    const form = f.send.mock.calls[0][1].body as FormData;
    expect((form.get('file') as File).name).toBe('memo.m4a');
    expect(f.res.json).toHaveBeenCalledWith({ text: 'text' });
  });
  it('rejects oversized and unsupported uploads without provider calls', async () => {
    const f = fixture(); f.req.body.audio = 'A'.repeat(Math.ceil(MAX_VOICE_BYTES / 3) * 4 + 4);
    await f.handler(f.req, f.res); expect(f.res.status).toHaveBeenCalledWith(413);
    f.req.body.audio = 'dGVzdA=='; f.req.body.mimeType = 'text/html';
    await f.handler(f.req, f.res); expect(f.res.status).toHaveBeenCalledWith(400); expect(f.send).not.toHaveBeenCalled();
  });
  it('does not expose provider errors or credentials in responses', async () => {
    const f = fixture(); f.send.mockResolvedValue(new Response('private diagnostic', { status: 403 }));
    await f.handler(f.req, f.res);
    expect(f.res.json).toHaveBeenCalledWith({ error: 'transcription-provider-unavailable' });
  });
  it('bounds bursts by authenticated identity', async () => {
    const f = fixture();
    for (let n = 0; n < 11; n++) await f.handler(f.req, f.res);
    expect(f.send).toHaveBeenCalledTimes(10); expect(f.res.status).toHaveBeenLastCalledWith(429);
  });
  it('client source contains no provider key or direct Groq transport', () => {
    const client = readFileSync(new URL('../services/voiceMemoService.ts', import.meta.url), 'utf8');
    expect(client).not.toContain('VITE_GROQ_API_KEY'); expect(client).not.toContain('api.groq.com');
    expect(client).toContain("apiUrl('/api/voice-transcription')");
  });
});
