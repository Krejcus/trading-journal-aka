import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/tradovateOAuthStore.js', () => ({
  readTradovateServerConfig: () => ({ environment: 'demo' }),
  requireSupabaseUserId: async () => 'mock-user',
  createTradovateAdminClient: () => ({}),
  getValidTradovateAccessToken: async () => ({ accessToken: 'mock-only' }),
}));
vi.mock('../server/tradovateHistoricalProbe.js', () => ({
  probeTradovateHistoricalSync: async () => ({ status: 'unavailable' }),
  unavailableTradovateHistoricalSync: () => ({ status: 'unavailable' }),
}));
vi.mock('../server/nativeCors.js', () => ({ handleNativeCors: () => false }));
import { loadTradovateAccountData } from '../server/tradovateAccountData';
import preflight from '../api/tradovate/oauth/preflight';

const options = { baseUrl: 'https://mock.invalid/v1', accessToken: 'mock-only', detail: 'bootstrap' as const, now: Date.parse('2026-09-05T10:00:00Z') };
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });
const mockFetch = (overrides: Record<string, () => Response | Promise<Response>>) => vi.fn(async input => {
  const path = new URL(String(input)).pathname.replace('/v1', '');
  if (overrides[path]) return overrides[path]();
  if (['/position/list', '/order/list', '/orderVersion/list'].includes(path)) return json([]);
  throw new Error(`Unexpected mocked read: ${path}`);
}) as unknown as typeof fetch;
const response = () => {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('server account-data stop and rate-limit propagation', () => {
  it.each([401, 429])('stops queued account reads after an observed %i', async status => {
    let cashCalls = 0;
    const result = await loadTradovateAccountData({ ...options, fetchImpl: mockFetch({
      '/account/list': () => json(Array.from({ length: 8 }, (_, index) => ({ id: index + 1 }))),
      '/cashBalance/getcashbalancesnapshot': () => { cashCalls++; return json({}, status, { 'Retry-After': '60' }); },
    }) });
    expect(result.accounts).toHaveLength(8);
    expect(cashCalls).toBe(3); // Three requests were already started concurrently.
    expect(result.accounts.every(account => account.balance.coverage.httpStatus === status)).toBe(true);
  });

  it('continues other accounts after endpoint-scoped403 rather than treating it as expired auth', async () => {
    let cashCalls = 0;
    const result = await loadTradovateAccountData({ ...options, fetchImpl: mockFetch({
      '/account/list': () => json(Array.from({ length: 8 }, (_, index) => ({ id: index + 1 }))),
      '/cashBalance/getcashbalancesnapshot': () => { cashCalls++; return json({}, 403); },
    }) });
    expect(cashCalls).toBe(8);
    expect(result.accounts.every(account => account.balance.coverage.availability === 'denied')).toBe(true);
  });

  it('preserves successful exposure and the precise retry duration on cash-limited partial data', async () => {
    const result = await loadTradovateAccountData({ ...options, fetchImpl: mockFetch({
      '/account/list': () => json([{ id: 1 }]),
      '/cashBalance/getcashbalancesnapshot': () => json({}, 429, { 'Retry-After': '12' }),
    }) });
    expect(result.accounts[0].readState?.positions.availability).toBe('empty');
    expect(result.accounts[0].balance.coverage).toMatchObject({ availability: 'unavailable', httpStatus: 429, retryAfterMs: 12_000 });
  });

  it.each([null, 'not-a-duration'])('uses bounded conservative fallback for Retry-After=%s', async header => {
    await expect(loadTradovateAccountData({ ...options, fetchImpl: mockFetch({
      '/account/list': () => json({}, 429, header == null ? {} : { 'Retry-After': header }),
    }) })).rejects.toMatchObject({ status: 429, retryAfterMs: 3_600_000 });
  });

  it('parses the HTTP-date Retry-After form', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(options.now);
    await expect(loadTradovateAccountData({ ...options, fetchImpl: mockFetch({
      '/account/list': () => json({}, 429, { 'Retry-After': new Date(options.now + 30_000).toUTCString() }),
    }) })).rejects.toMatchObject({ status: 429, retryAfterMs: 30_000 });
  });

  it('preserves rate-limit metadata when one of multiple contract chunks succeeds', async () => {
    let chunks = 0;
    const result = await loadTradovateAccountData({ ...options, fetchImpl: mockFetch({
      '/account/list': () => json([{ id: 1 }]),
      '/position/list': () => json(Array.from({ length: 101 }, (_, index) => ({ accountId: 1, contractId: index + 1, netPos: 0 }))),
      '/cashBalance/getcashbalancesnapshot': () => json({ totalCashValue: 50_000, openPnL: 0 }),
      '/contract/items': () => ++chunks === 1 ? json({}, 429, { 'Retry-After': '17' }) : json([{ id: 101, name: 'MNQU6' }]),
    }) });
    expect(result.contracts).toHaveLength(1);
    expect(result.coverage.contracts).toMatchObject({ availability: 'partial', httpStatus: 429, retryAfterMs: 17_000 });
  });

  it('preserves account/list429 status and Retry-After as structured failure', async () => {
    await expect(loadTradovateAccountData({ ...options, fetchImpl: mockFetch({
      '/account/list': () => json({ errorText: 'private broker diagnostic' }, 429, { 'Retry-After': '120' }),
    }) })).rejects.toMatchObject({ status: 429, retryAfterMs: 120_000 });
  });

  it.each([401, 403])('preserves account-list %i without leaking broker payload', async status => {
    vi.stubGlobal('fetch', mockFetch({ '/account/list': () => json({ errorText: 'private broker diagnostic' }, status) }));
    const res = response();
    await preflight({ method: 'POST', headers: {}, body: { connectionId: 'c', mode: 'bootstrap' } } as never, res as never);
    expect(res.status).toHaveBeenLastCalledWith(status);
    expect(res.json).toHaveBeenLastCalledWith({ error: 'tradovate-read-denied' });
  });

  it('returns sanitized 429 and Retry-After from the actual preflight handler', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', mockFetch({ '/account/list': () => json({ errorText: 'private broker diagnostic' }, 429, { 'Retry-After': '120' }) }));
    const res = response();
    await preflight({ method: 'POST', headers: {}, body: { connectionId: 'c', mode: 'bootstrap' } } as never, res as never);
    expect(res.status).toHaveBeenLastCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '120');
    expect(res.json).toHaveBeenLastCalledWith({ error: 'tradovate-rate-limited', retryAfterMs: 120_000 });
  });
});
