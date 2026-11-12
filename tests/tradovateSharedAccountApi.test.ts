import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sharedReadDb, OWNER, CONNECTION } from './helpers/tradovateSharedReadDb';
const state = vi.hoisted(() => ({ db: null as any, fetch: vi.fn(), rejectCapacity: false, worker: null as any }));
vi.mock('../server/tradovateOAuthStore.js', () => ({
  readTradovateServerConfig: () => ({ environment: 'demo' }), requireSupabaseUserId: async () => OWNER,
  createTradovateAdminClient: () => state.db,
  getValidTradovateAccessToken: async () => ({ accessToken: 'test-only', brokerUserId: 42, fetchImpl: state.fetch }),
}));
vi.mock('../server/tradovateServerRequestControl.js', async original => {
  const actual = await original<typeof import('../server/tradovateServerRequestControl')>();
  return { ...actual, assertTradovateBackgroundCapacity: async () => {
    if (state.rejectCapacity) throw new actual.TradovateRequestControlError('tradovate-request-budget', 20_000);
  } };
});
vi.mock('../server/tradovateSharedWorkerRead.js', async original => {
  const actual = await original<typeof import('../server/tradovateSharedWorkerRead')>();
  return { ...actual, readWorkerSharedTick: async (context: any, baseline: any) => state.worker
    ? actual.workerSharedTick(context, baseline, state.worker, Date.now()) : null, readWorkerSharedCash: async () => null };
});
vi.mock('../server/nativeCors.js', () => ({ handleNativeCors: () => false }));
import preflight from '../api/tradovate/oauth/preflight';
import pnl from '../api/tradovate/oauth/live-pnl';
import { TradovateRequestControlError } from '../server/tradovateServerRequestControl';
let db: Awaited<ReturnType<typeof sharedReadDb>>;
beforeAll(async () => { db = await sharedReadDb(); state.db = db.client(); }, 30_000);
afterAll(async () => { await db?.pg.close(); });
beforeEach(async () => {
  await db.pg.exec('truncate public.tradovate_shared_reads');
  state.rejectCapacity = false;
  state.worker = null;
  state.fetch.mockReset().mockImplementation(async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname.replace('/v1', '');
    // Hard assertion: the harness permits only broker reads, including read-only POST cash snapshots.
    if ((init?.method ?? 'GET') !== 'GET' && path !== '/cashBalance/getcashbalancesnapshot') throw new Error(`Forbidden broker mutation ${path}`);
    const payload = path === '/account/list' ? [{ id: 7, name: 'DEMO7', active: true }, { id: 8, name: 'DEMO8', active: true }]
      : path === '/cashBalance/getcashbalancesnapshot' ? { totalCashValue: 50_000, totalCashValueSOD: 50_000, openPnL: 0, netLiq: 50_000 }
        : [];
    return new Response(JSON.stringify(payload), { status: 200 });
  });
});
async function call(handler: typeof preflight | typeof pnl, body: Record<string, unknown>) {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  // Vercel serializes responses; a mock accepting arbitrary objects misses circular server clients.
  res.json.mockImplementation(body => { JSON.stringify(body); return res; });
  await handler({ method: 'POST', headers: { authorization: 'Bearer test-app' }, body: { connectionId: CONNECTION, ...body } } as never, res as never);
  return { status: res.status.mock.calls.at(-1)?.[0], body: res.json.mock.calls.at(-1)?.[0] };
}
const open = () => call(preflight, { mode: 'full', historicalProbe: false });
describe('same read model behind existing web and iPhone APIs', () => {
  it('serializes the worker tick without leaking the circular server database client or owner context', async () => {
    await open();
    const now = Date.now();
    state.worker = { environment: 'demo', displayBuiltAt: now, controller: { connected: true, exposure: {
      verifiedAt: now, positions: [], orders: [], followers: [],
      streamCoverage: [7, 8].map(accountId => ({ accountId, connectionId: CONNECTION, environment: 'demo',
        routeEpoch: 1, currentRouteEpoch: 1, sessionId: 'test-session', currentSessionId: 'test-session',
        baselineAt: now, lastDataAt: now, observedAt: now, socketLive: true, synchronized: true,
        gap: false, backlog: false, mergeInProgress: false })),
    } } };
    state.db.auth = { client: state.db, testCredential: 'test-only-server-credential' };
    const reads = state.fetch.mock.calls.length;
    try {
      const response = await call(pnl, {});
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ connectionId: CONNECTION, environment: 'demo', brokerCalls: 0, positions: [], orders: [] });
      const serialized = JSON.stringify(response.body);
      for (const privateField of ['db', 'userId', 'route', 'auth']) expect(response.body).not.toHaveProperty(privateField);
      expect(serialized).not.toContain('test-only-server-credential');
      expect(state.fetch).toHaveBeenCalledTimes(reads);
    } finally { delete state.db.auth; }
  });
  it('12 simultaneous cold starts and 30 subsequent opens share a complete baseline and its source timestamps', async () => {
    const started = performance.now();
    const cold = await Promise.all(Array.from({ length: 12 }, open));
    expect(cold.every(row => row.status === 200 && row.body.accounts.length === 2)).toBe(true);
    expect(state.fetch.mock.calls.filter(([url]) => url.includes('/account/list'))).toHaveLength(1);
    const physical = state.fetch.mock.calls.length;
    const warm = await Promise.all(Array.from({ length: 30 }, open));
    expect(warm.every(row => row.status === 200)).toBe(true);
    expect(state.fetch).toHaveBeenCalledTimes(physical);
    expect(new Set([...cold, ...warm].map(row => row.body.accounts[0].readState.cashAsOf)).size).toBe(1);
    console.info(JSON.stringify({ measurement: 'local-account-api', clients: 42, baselineBatches: 1, physicalReads: physical, elapsedMs: Math.round(performance.now() - started) }));
  });
  it('old iPhone contract cursors cannot multiply fast reads; the collector owns rotation', async () => {
    const ticks = await Promise.all(Array.from({ length: 12 }, (_, contractCursor) => call(pnl, { contractCursor })));
    expect(ticks.every(row => row.status === 200)).toBe(true);
    expect(state.fetch.mock.calls.filter(([url]) => url.includes('/position/list'))).toHaveLength(1);
    expect(state.fetch.mock.calls.filter(([url]) => url.includes('/order/list'))).toHaveLength(1);
    expect(ticks.reduce((sum, row) => sum + row.body.brokerCalls, 0)).toBe(2);
    expect(new Set(ticks.map(row => row.body.requestedAt)).size).toBe(1);
  });
  it('cached baseline survives a deferred tick, with unchanged data age and an explicit pending state', async () => {
    await open();
    // Age just the cached snapshot, not PostgreSQL/lease clocks.
    await db.pg.exec(`update public.tradovate_shared_reads set payload=jsonb_set(payload,'{requestedAt}',to_jsonb((clock_timestamp()-interval '1 minute')::text)) where channel='accounts:full:v1'`);
    const old = (await db.pg.query<{ payload: any }>(`select payload from public.tradovate_shared_reads where channel='accounts:full:v1'`)).rows[0].payload;
    state.fetch.mockRejectedValue(new TradovateRequestControlError('tradovate-request-budget', 20_000));
    const result = await open();
    expect(result.status).toBe(200);
    expect(result.body.accounts).toEqual(old.accounts);
    expect(result.body.requestedAt).toEqual(old.requestedAt);
    expect(result.body.sharedRead).toMatchObject({ refreshPending: true, retryAfterMs: 20_000 });
    const count = state.fetch.mock.calls.length;
    await open();
    expect(state.fetch).toHaveBeenCalledTimes(count);
  });
  it('keeps an expired last-known baseline visible during capacity exhaustion, then recovers', async () => {
    const initial = await open();
    await db.pg.exec(`update public.tradovate_shared_reads set fresh_until='-infinity' where channel='accounts:full:v1'`);
    state.rejectCapacity = true;
    const retained = await open();
    expect(retained.status).toBe(200);
    expect(retained.body.accounts.map((account: any) => account.id)).toEqual([7, 8]);
    expect(retained.body.accounts[0].readState.cashAsOf).toBe(initial.body.accounts[0].readState.cashAsOf);
    expect(retained.body.sharedRead.refreshPending).toBe(true);
    state.rejectCapacity = false;
    await db.pg.exec(`update public.tradovate_shared_reads set retry_at='-infinity'`);
    const recovered = await open();
    expect(recovered.status).toBe(200);
    expect(recovered.body.sharedRead.refreshPending).toBe(false);
    expect(state.fetch.mock.calls.filter(([url]) => url.includes('/account/list'))).toHaveLength(2);
  });
  it('refreshes exposure from one fast tick without relabelling cash or daily data as newly confirmed', async () => {
    const initial = await open();
    await db.pg.exec(`update public.tradovate_shared_reads set payload=jsonb_set(payload,'{requestedAt}',to_jsonb((clock_timestamp()-interval '1 minute')::text)) where channel='accounts:full:v1'`);
    const result = await open();
    expect(result.status).toBe(200);
    expect(result.body.accounts[0].readState.cashAsOf).toBe(initial.body.accounts[0].readState.cashAsOf);
    expect(result.body.accounts[0].readState.dailyAsOf).toBe(initial.body.accounts[0].readState.dailyAsOf);
    expect(result.body.sharedRead.baselineAsOf).not.toBe(result.body.requestedAt);
    expect(state.fetch.mock.calls.filter(([url]) => url.includes('/account/list'))).toHaveLength(1);
  });
});
