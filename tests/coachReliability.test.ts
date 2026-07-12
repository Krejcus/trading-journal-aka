/**
 * Regresní testy spolehlivosti AI coache — kryjí dva uživatelem nahlášené bugy:
 *
 * 1. „zprávy se občas seknou (Load failed)" — Safari hází TypeError('Load failed')
 *    při umření fetch streamu. PŘED opravou šel text chyby syrově uživateli a
 *    zpráva zmizela; PO opravě streamAIResponse tiše retryuje (max 2×, jen dokud
 *    kolo nevypsalo viditelný text) a odpověď dorazí.
 *
 * 2. „neodpovídá mi nahlas" — iOS autoplay policy blokla audio.play() po async
 *    mezeře; PŘED opravou .catch() selhání spolkl a vrátil úspěch → žádný
 *    fallback, ticho. PO opravě play() rejection vrací false → browser
 *    speechSynthesis fallback promluví.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock Supabase klienta: thenable query chain + session ──────────────────
// (services/supabase importují aiService, coachTools, coachMemoryService i
//  ttsService — jeden mock pokryje všechny.)
vi.mock('../services/supabase', () => {
  const makeChain = () => {
    const c: any = {};
    const self = () => c;
    for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'gt', 'lt',
      'order', 'limit', 'filter', 'not', 'or', 'contains', 'is', 'update',
      'upsert', 'delete']) c[m] = self;
    c.single = () => Promise.resolve({ data: null, error: null });
    c.maybeSingle = () => Promise.resolve({ data: null, error: null });
    c.insert = () => ({
      select: () => ({ single: () => Promise.resolve({ data: { id: 'mem1' }, error: null }) }),
      then: (res: any) => Promise.resolve({ data: null, error: null }).then(res),
    });
    c.then = (res: any) => Promise.resolve({ data: [], error: null }).then(res);
    return c;
  };
  return {
    supabase: {
      supabaseUrl: 'http://mock.supabase.local',
      auth: {
        getSession: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'u1' } } } }),
        getUser: async () => ({ data: { user: { id: 'u1' } } }),
      },
      from: () => makeChain(),
      rpc: async () => ({ data: [], error: null }),
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── 1) „Load failed" → tichý retry → odpověď dorazí ─────────────────────────
describe('streamAIResponse — síťová odolnost (bug: zprávy se seknou / Load failed)', () => {
  const sse = (events: any[]) =>
    events.map(e => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\n';

  const okStream = () => new Response(sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ahoj Filipe, spojení drží.' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

  it('Safari TypeError("Load failed") na 1. pokusu → retry → onDone s textem, žádný onError', async () => {
    let chatCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/functions/v1/chat')) {
        chatCalls++;
        if (chatCalls === 1) throw new TypeError('Load failed'); // přesně Safari chování
        return okStream();
      }
      // embed-query a spol. — nedostupné, služby mají fallbacky
      return new Response('{}', { status: 404 });
    }));

    const { streamAIResponse } = await import('../services/aiService');

    let text = '';
    let done = false;
    let error: string | null = null;

    await streamAIResponse(
      [{ role: 'user', content: 'test spojení' }],
      '', // traderContext
      [], // trades
      (chunk) => { text += chunk; },
      () => { /* onRefs */ },
      () => { done = true; },
      (e) => { error = String(e); },
      { preps: [], reviews: [], accounts: [], aiModel: 'fast' } as any,
    );

    expect(chatCalls).toBe(2);            // 1. pokus spadl, 2. prošel
    expect(error).toBeNull();             // uživatel žádnou chybu nevidí
    expect(done).toBe(true);
    expect(text).toContain('Ahoj Filipe');
  }, 15_000);

  it('trvalý výpadek (3× Load failed) → po vyčerpání retry česká hláška, ne syrové "Load failed"', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      if (String(url).includes('/functions/v1/chat')) throw new TypeError('Load failed');
      return new Response('{}', { status: 404 });
    }));

    const { streamAIResponse } = await import('../services/aiService');

    let error: string | null = null;
    await streamAIResponse(
      [{ role: 'user', content: 'test' }], '', [],
      () => {}, () => {}, () => {},
      (e) => { error = String(e); },
      { preps: [], reviews: [], accounts: [], aiModel: 'fast' } as any,
    );

    expect(error).not.toBeNull();
    expect(error!).not.toContain('Load failed');   // syrová hláška nesmí projít
    expect(error!).toMatch(/[Ss]pojení/);          // přeloženo pro uživatele
  }, 15_000);
});

// ── 2) TTS: blokace play() → browser fallback (bug: neodpovídá nahlas) ──────
describe('ttsService — iOS autoplay blokace (bug: coach neodpovídá nahlas)', () => {
  it('audio.play() rejected → speakViaGoogle vrátí false → promluví browser fallback', async () => {
    const spoken: string[] = [];

    class FakeAudio {
      src = '';
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      // iOS autoplay policy: play() mimo user-gesture stack rejectne
      play() { return Promise.reject(new DOMException('play() failed', 'NotAllowedError')); }
      pause() {}
    }
    class FakeUtterance {
      text: string; lang = ''; rate = 1; pitch = 1; voice: any = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(t: string) { this.text = t; }
    }
    const speechSynthesis = {
      cancel: vi.fn(),
      getVoices: () => [],
      speak: (u: FakeUtterance) => { spoken.push(u.text); u.onend?.(); },
      onvoiceschanged: null,
    };

    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    vi.stubGlobal('window', { speechSynthesis });

    // TTS edge funkce vrátí platné audio — selhání nastane až u přehrání
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ audioContent: 'QUJDREVG' }), { status: 200 })));

    const { speak } = await import('../services/ttsService');
    await speak('Testovací věta pro kouče');

    // PŘED opravou: play().catch(() => resolve()) → "úspěch" → spoken zůstalo prázdné (ticho).
    // PO opravě: rejection → false → fallback promluví.
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken.join(' ')).toContain('Testovací věta');
  });
});
