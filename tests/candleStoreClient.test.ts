import { describe, expect, it, vi } from 'vitest';
import { requestCandleStore, type StoreInvoke } from '../services/candleStoreClient';

const body = { symbol: 'MNQ.v.0', schema: 'ohlcv-1m' as const, start: '2026-09-20T00:00:00.000Z', end: '2026-09-21T00:00:00.000Z' };
const httpError = (status: number, payload: unknown) => ({ context: new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }) });
const sleep = vi.fn(async () => {});

describe('klient soukromého skladu svíček', () => {
  it('úspěch vrátí data skladu', async () => {
    const invoke: StoreInvoke = async () => ({ data: { candles: [{ time: 1 }], store: 'hit' }, error: null });
    expect(await requestCandleStore(invoke, body, { sleep })).toMatchObject({ kind: 'ok', data: { store: 'hit' } });
  });

  it('202 store-pending čeká a opakuje — nikdy nepadne na placenou zálohu', async () => {
    const responses = [
      { data: { error: 'store-pending', retryAfterMs: 1000 }, error: null },
      { data: { error: 'store-pending', retryAfterMs: 1000 }, error: null },
      { data: { candles: [], store: 'filled' }, error: null },
    ];
    const invoke = vi.fn<StoreInvoke>(async () => responses.shift()!);
    const outcome = await requestCandleStore(invoke, body, { sleep });
    expect(outcome.kind).toBe('ok');
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('nekonečné čekání skončí chybou, ne zálohou', async () => {
    const invoke: StoreInvoke = async () => ({ data: { error: 'store-pending', retryAfterMs: 5000 }, error: null });
    expect(await requestCandleStore(invoke, body, { sleep, maxPendingMs: 12_000 })).toMatchObject({ kind: 'error', code: 'store-pending-timeout' });
  });

  it('funkce 404, cizí uživatel a nenastavený sklad → stará cesta a sklad do konce relace vypnout', async () => {
    for (const [status, payload] of [[404, { code: 'NOT_FOUND', message: 'Requested function was not found' }], [403, { error: 'not-authorized' }],
      [401, { error: 'auth-failed' }], [503, { error: 'store-not-configured' }]] as const) {
      expect(await requestCandleStore(async () => ({ data: null, error: httpError(status, payload) }), body, { sleep }))
        .toMatchObject({ kind: 'fallback', disable: 'session' });
    }
  });

  it('404 no-data je prázdná řada, 409 jde na starou cestu bez vypnutí skladu', async () => {
    expect(await requestCandleStore(async () => ({ data: null, error: httpError(404, { error: 'no-data' }) }), body, { sleep })).toEqual({ kind: 'no-data' });
    expect(await requestCandleStore(async () => ({ data: null, error: httpError(409, { error: 'data-not-yet-historical' }) }), body, { sleep }))
      .toMatchObject({ kind: 'fallback', disable: false });
  });

  it('nenasazená funkce v prohlížeči (CORS → FunctionsFetchError) → stará cesta, pár minut nezkoušet', async () => {
    const fetchError = { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function', context: new TypeError('Failed to fetch') };
    expect(await requestCandleStore(async () => ({ data: null, error: fetchError }), body, { sleep }))
      .toMatchObject({ kind: 'fallback', disable: 'temporary' });
  });

  it('402/429 u poskytovatele je chyba bez zálohy (nekupovat dvakrát)', async () => {
    expect(await requestCandleStore(async () => ({ data: null, error: httpError(429, { error: 'rate-limit', message: 'limit' }) }), body, { sleep }))
      .toMatchObject({ kind: 'error', code: 'rate-limit' });
  });

  it('503 výpadek: jednou zopakovat, pak stará cesta', async () => {
    const invoke = vi.fn<StoreInvoke>(async () => ({ data: null, error: httpError(503, { error: 'store-unavailable' }) }));
    expect(await requestCandleStore(invoke, body, { sleep })).toMatchObject({ kind: 'fallback', disable: false });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
