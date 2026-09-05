import { describe, expect, it } from 'vitest';
import { loadTradovateAccountData } from '../server/tradovateAccountData';
import { loadTradovateLivePnlTick } from '../server/tradovateLivePnl';
import { applyTradovateLivePnlAnchorTick, applyTradovateLivePnlTick } from '../lib/tradovateLivePnl';
import { applyTradovateConnectionDataRefresh } from '../lib/tradovateLiveConnectionCache';
import { tradovateCopyTradeSnapshot } from '../lib/tradovateCopyTradeBridge';
import { consumeTradovateReads } from '../lib/tradovateReadCoordinator';
import type { TradovatePreflightResult } from '../services/tradovateOAuthConnection';
import type { TradovateLivePnlTick } from '../lib/tradovateLivePnlTypes';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const at = (time: string) => `2026-09-05T${time}.000Z`;
const options = { baseUrl: 'https://mock.invalid/v1', accessToken: 'mock', now: Date.parse(at('10:00:00')) };
const position = { id: 1, accountId: 10, contractId: 7, netPos: 1, netPrice: 20_000 };
const tick: TradovateLivePnlTick = {
  connectionId: 'c', environment: 'demo', capturedAt: at('10:02:00'), requestedAt: at('10:01:59'),
  positions: [{ id: 1, accountId: 10, contractId: 7, netPosition: 1, averagePrice: 20_000, timestamp: null }],
  orders: [], anchor: null, activeContractCount: 1, nextContractCursor: 0,
};
const mock = (overrides: Record<string, () => Response | Promise<Response>> = {}) => (async (url: string | URL | Request) => {
  const path = new URL(String(url)).pathname.replace('/v1', '');
  if (overrides[path]) return overrides[path]();
  if (path === '/account/list') return json([{ id: 10, name: 'test', active: true }]);
  if (path === '/cashBalance/getcashbalancesnapshot') return json({ openPnL: 5, totalCashValue: 50_000, netLiq: 50_005 });
  if (path === '/contract/items') return json([{ id: 7, name: 'MNQU6' }]);
  return json([]);
}) as typeof fetch;
const base = async (overrides?: Parameters<typeof mock>[0]) => ({
  ...await loadTradovateAccountData({ ...options, fetchImpl: mock(overrides) }),
  connectionId: 'c', environment: 'demo', historicalSync: {},
  contracts: [{ id: 7, name: 'MNQU6', contractMaturityId: null, timestamp: null }],
}) as TradovatePreflightResult;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe('LIVE read reliability regressions', () => {
  it('distinguishes failed exposure reads from confirmed empty accounts', async () => {
    const failed = await base({ '/position/list': () => json({}, 503), '/order/list': () => json({}, 503) });
    const row = tradovateCopyTradeSnapshot(failed, []).accounts[0];
    expect(row.positionsAvailability).toBe('unavailable');
    expect(row.ordersAvailability).toBe('unavailable');
    expect(row.positionsUpdatedAt).toBeNull();
    const empty = tradovateCopyTradeSnapshot(await base(), []).accounts[0];
    expect(empty.positionsAvailability).toBe('empty');
    expect(empty.positionsUpdatedAt).toBe(at('10:00:00'));
  });

  it('does not interpret malformed HTTP 200 position data as flat', async () => {
    const invalid = await base({ '/position/list': () => json([{ accountId: 10, contractId: 7 }]) });
    expect(tradovateCopyTradeSnapshot(invalid, []).accounts[0].positionsAvailability).toBe('unavailable');
  });

  it('keeps the last known position and its timestamp after a failed refresh', async () => {
    const before = await base({ '/position/list': () => json([position]) });
    const failed = await base({ '/position/list': () => json({}, 503) });
    failed.requestedAt = at('10:00:01');
    failed.accounts[0].readState!.requestedAt = failed.requestedAt;
    const merged = applyTradovateConnectionDataRefresh({ c: before }, [failed], 'merge').c;
    expect(merged.accounts[0].positions).toEqual(before.accounts[0].positions);
    expect(merged.accounts[0].netPositionCount).toBe(1);
    const row = tradovateCopyTradeSnapshot(merged, []).accounts[0];
    expect(row.positionsAvailability).toBe('unavailable');
    expect(row.positionsUpdatedAt).toBe(at('10:00:00'));
  });

  it('merges late historical enrichment while retaining newer positions and orders', async () => {
    const slowFull = await base();
    slowFull.capturedAt = at('10:03:00'); // response finishes later, but started at 10:00
    slowFull.accounts[0].history.entryCount = 9;
    const latest = applyTradovateLivePnlTick(await base(), tick).data as TradovatePreflightResult;
    const merged = applyTradovateConnectionDataRefresh({ c: latest }, [slowFull], 'merge').c;
    expect(merged.accounts[0].netPositionCount).toBe(1);
    expect(merged.accounts[0].positions[0].netPosition).toBe(1);
    expect(merged.accounts[0].history.entryCount).toBe(9);
    expect(merged.accounts[0].readState!.positionsAsOf).toBe(tick.requestedAt);
  });

  it('ignores a late tick whose position read predates a newer snapshot', async () => {
    const latest = applyTradovateLivePnlTick(await base(), tick).data;
    const stale = { ...tick, positions: [], requestedAt: at('10:01:00'), capturedAt: at('10:03:00') };
    expect(applyTradovateLivePnlTick(latest, stale).data).toBe(latest);
  });

  it('expires old marks and preserves the time of the last supported P&L', async () => {
    const initial = await base();
    const result = applyTradovateLivePnlTick(initial, tick, {
      '7': { contractId: 7, price: 20_010, valuePerPoint: 2, observedAt: at('09:00:00') },
    }).data;
    expect(result.accounts[0].balance.openPnlSource).toBe('stale');
    expect(result.accounts[0].balance.openPnlAsOf).toBe(at('10:00:00'));
    expect(result.accounts[0].balance.openPnL).toBe(5);
  });

  it('keeps a recent estimate timestamp at the actual mark observation', async () => {
    const result = applyTradovateLivePnlTick(await base(), tick, {
      '7': { contractId: 7, price: 20_010, valuePerPoint: 2, observedAt: at('10:01:55') },
    }).data;
    expect(result.accounts[0].balance.openPnlSource).toBe('estimated');
    expect(result.accounts[0].balance.openPnlAsOf).toBe(at('10:01:55'));
    expect(result.accounts[0].balance.openPnL).toBe(20);
  });

  it('does not apply an old anchor to a newer position', async () => {
    const current = applyTradovateLivePnlTick(await base(), tick).data;
    const applied = applyTradovateLivePnlAnchorTick(current, {
      connectionId: 'c', environment: 'demo', requestedAt: at('10:00:00'), capturedAt: at('10:03:00'),
      anchor: { accountId: 10, contractId: 7, openPnl: 999, netLiq: null, totalCashValue: null },
    });
    expect(applied.data).toBe(current);
  });

  it('keeps a later queued cash snapshot when an older anchor completes afterwards', async () => {
    const current = await base({ '/position/list': () => json([position]) });
    current.accounts[0].readState!.cashAsOf = at('10:10:00');
    current.accounts[0].balance.openPnlAsOf = at('10:10:00');
    const applied = applyTradovateLivePnlAnchorTick(current, {
      connectionId: 'c', environment: 'demo', requestedAt: at('10:03:00'), capturedAt: at('10:20:00'),
      anchor: { accountId: 10, contractId: 7, openPnl: 999, netLiq: null, totalCashValue: null },
    });
    expect(applied.data).toBe(current);
  });

  it('does not overwrite a newer contract mark with a delayed anchor', async () => {
    const current = await base({ '/position/list': () => json([position]) });
    const marks = { '7': { contractId: 7, price: 20_010, valuePerPoint: 2, observedAt: at('10:10:00') } };
    const applied = applyTradovateLivePnlAnchorTick(current, {
      connectionId: 'c', environment: 'demo', requestedAt: at('10:03:00'), capturedAt: at('10:20:00'),
      anchor: { accountId: 10, contractId: 7, openPnl: 999, netLiq: null, totalCashValue: null },
    }, marks);
    expect(applied.marks).toBe(marks);
    expect(applied.data).toBe(current);
  });

  it('retains newer cash while accepting newer positions from a late cash tick', async () => {
    const current = await base();
    current.accounts[0].readState!.cashAsOf = at('10:10:00');
    current.accounts[0].balance.openPnlAsOf = at('10:10:00');
    const applied = applyTradovateLivePnlTick(current, {
      ...tick, requestedAt: at('10:03:00'), capturedAt: at('10:20:00'),
      anchor: { accountId: 10, contractId: 7, openPnl: 999, netLiq: 50_999, totalCashValue: 50_000 },
    }).data;
    expect(applied.accounts[0].netPositionCount).toBe(1);
    expect(applied.accounts[0].balance.openPnL).toBe(5);
    expect(applied.accounts[0].readState!.cashAsOf).toBe(at('10:10:00'));
  });

  it.each(['tick', 'anchor'] as const)('restores cash coverage with a valid exact %s after an earlier cash failure', async kind => {
    const failed = await base({
      '/position/list': () => json([position]),
      '/cashBalance/getcashbalancesnapshot': () => json({}, 503),
    });
    expect(tradovateCopyTradeSnapshot(failed, []).accounts[0].cashAvailability).toBe('unavailable');
    const anchor = { accountId: 10, contractId: 7, openPnl: 12, netLiq: 50_012, totalCashValue: 50_000 };
    const result = kind === 'tick'
      ? applyTradovateLivePnlTick(failed, { ...tick, anchor }).data
      : applyTradovateLivePnlAnchorTick(failed, { ...tick, anchor }).data;
    expect(tradovateCopyTradeSnapshot(result, []).accounts[0].cashAvailability).toBe('available');
    expect(result.accounts[0].balance.openPnlSource).toBe('broker');
    expect(result.accounts[0].readState!.cashAsOf).toBe(tick.requestedAt);
  });

  it('returns successful positions and orders despite cash snapshot failure', async () => {
    const result = await loadTradovateLivePnlTick({ ...options, connectionId: 'c', environment: 'demo', fetchImpl: mock({
      '/position/list': () => json([position]),
      '/cashBalance/getcashbalancesnapshot': () => json({}, 503),
    }) });
    expect(result.positions[0].netPosition).toBe(1);
    expect(result.orders).toEqual([]);
    expect(result.anchor).toBeNull();
    expect(result.anchorError).toContain('503');
  });

  it('preserves a cash rate-limit signal alongside successful exposure reads', async () => {
    const result = await loadTradovateLivePnlTick({ ...options, connectionId: 'c', environment: 'demo', fetchImpl: mock({
      '/position/list': () => json([position]),
      '/cashBalance/getcashbalancesnapshot': () => json({}, 429),
    }) });
    expect(result.positions[0].netPosition).toBe(1);
    expect(result.anchorErrorStatus).toBe(429);
  });

  it('does not let aggregation replace one account evidence time with another firms time', async () => {
    const old = await base();
    const aggregated = { ...old, capturedAt: at('11:00:00') };
    const row = tradovateCopyTradeSnapshot(aggregated, []).accounts[0];
    expect(row.positionsUpdatedAt).toBe(at('10:00:00'));
    expect(row.unrealizedPnlUpdatedAt).toBe(at('10:00:00'));
  });

  it('starts cash reads while global positions are still pending', async () => {
    const positions = deferred<Response>();
    const cashStarted = deferred<void>();
    const loading = loadTradovateAccountData({ ...options, fetchImpl: mock({
      '/position/list': () => positions.promise,
      '/cashBalance/getcashbalancesnapshot': () => { cashStarted.resolve(); return json({ openPnL: 0 }); },
    }) });
    await cashStarted.promise;
    positions.resolve(json([]));
    const result = await loading;
    expect(result.accounts[0].balance.openPnL).toBe(0);
  });

  it('caps concurrent per-account enrichment instead of bursting across every account', async () => {
    const release = deferred<void>();
    const threeStarted = deferred<void>();
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const loading = loadTradovateAccountData({ ...options, fetchImpl: mock({
      '/account/list': () => json(Array.from({ length: 8 }, (_, index) => ({ id: index + 10 }))),
      '/cashBalance/getcashbalancesnapshot': async () => {
        calls += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        if (active === 3) threeStarted.resolve();
        await release.promise;
        active -= 1;
        return json({ openPnL: 0 });
      },
    }) });
    await threeStarted.promise;
    expect(calls).toBe(3);
    release.resolve();
    await loading;
    expect(calls).toBe(8);
    expect(maximum).toBe(3);
  });

  it('does not advertise missing financial values as verified zero balances', async () => {
    const partial = await base({ '/cashBalance/getcashbalancesnapshot': () => json({ openPnL: 0 }) });
    const row = tradovateCopyTradeSnapshot(partial, []).accounts[0];
    expect(row.cashAvailability).toBe('unavailable');
    expect(row.unrealizedPnlSource).toBe('broker');
  });

  it('publishes a fast connection before the slow connection settles', async () => {
    const slow = deferred<number>();
    const accepted = deferred<void>();
    const values: string[] = [];
    const all = consumeTradovateReads(['slow', 'fast'], id => id === 'slow' ? slow.promise : Promise.resolve(2), (id, value) => {
      values.push(`${id}:${value}`);
      if (id === 'fast') accepted.resolve();
    });
    await accepted.promise;
    expect(values).toEqual(['fast:2']);
    slow.resolve(1);
    await all;
    expect(values).toEqual(['fast:2', 'slow:1']);
  });
});
