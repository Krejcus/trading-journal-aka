import { beforeAll, describe, expect, it } from 'vitest';
import { workerSharedTick } from '../server/tradovateSharedWorkerRead';
import { loadTradovateAccountData } from '../server/tradovateAccountData';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import type { TradovateAccountDataResult } from '../lib/tradovateAccountDataTypes';
const NOW = Date.UTC(2026, 10, 12, 6);
const context = { connectionId: 'c', environment: 'demo' as const };
let baseline: TradovateAccountDataResult;
beforeAll(async () => {
  baseline = await loadTradovateAccountData({ baseUrl: 'https://test.invalid', accessToken: 'test-only', now: NOW - 60_000,
    fetchImpl: async (input: string) => new Response(JSON.stringify(input.includes('/account/list')
      ? [{ id: 7, name: 'DEMO7', active: true }] : input.includes('getcashbalancesnapshot')
        ? { totalCashValue: 50_000, openPnL: 0 } : []), { status: 200 }) });
  baseline.contracts = [{ id: 77, name: 'MNQZ6', timestamp: null, contractMaturityId: null }];
});
function status() {
  return { environment: 'demo', displayBuiltAt: NOW, controller: { connected: true, exposure: {
    verifiedAt: NOW - 60_000,
    streamCoverage: [{ accountId: 7, connectionId: 'c', environment: 'demo', routeEpoch: 1, currentRouteEpoch: 1,
      sessionId: 'session', currentSessionId: 'session', baselineAt: NOW - 60_000, lastDataAt: NOW - 1_000,
      observedAt: NOW, socketLive: true, synchronized: true, gap: false, backlog: false, mergeInProgress: false }],
    positions: [{ accountId: 7, symbol: 'MNQZ6', netQuantity: 1, avgPrice: 21_000 }], orders: [], followers: [],
  } } } as unknown as LocalCopierAgentStatus;
}
describe('worker stream as a shared read source', () => {
  it('projects a complete fresh broker proof with zero REST, including an external entry', () => {
    const result = workerSharedTick(context, baseline, status(), NOW, NOW)!;
    expect(result.brokerCalls).toBe(0);
    expect(result.positions).toEqual([expect.objectContaining({ accountId: 7, contractId: 77, netPosition: 1, averagePrice: 21_000 })]);
    expect(result.anchor).toBeNull(); // no invented price/cash freshness
  });
  it.each(['gap', 'backlog', 'mergeInProgress'])('does not certify %s or substitute continuity for a proof', flag => {
    const current = status();
    (current.controller.exposure!.streamCoverage![0] as any)[flag] = true;
    expect(workerSharedTick(context, baseline, current, NOW, NOW)).toBeNull();
    current.controller.exposure!.streamContinuity = current.controller.exposure!.streamCoverage;
    current.controller.exposure!.streamCoverage = [];
    expect(workerSharedTick(context, baseline, current, NOW, NOW)).toBeNull();
  });
  it('rejects stale/replayed status even if it arrived just now', () => {
    const current = status(); current.displayBuiltAt = NOW - 10_000;
    expect(workerSharedTick(context, baseline, current, NOW, NOW)).toBeNull();
    expect(workerSharedTick(context, baseline, status(), NOW, NOW + 10_000)).toBeNull();
    expect(workerSharedTick(context, baseline, status(), NOW, NOW, NOW - 500)).toBeNull();
  });
  it('requires coverage for every account, matching route/session and known contract metadata', () => {
    const current = status();
    expect(workerSharedTick({ ...context, connectionId: 'other' }, baseline, current, NOW, NOW)).toBeNull();
    current.controller.exposure!.streamCoverage![0].currentSessionId = 'new-session';
    expect(workerSharedTick(context, baseline, current, NOW, NOW)).toBeNull();
    const unknownContract = status(); unknownContract.controller.exposure!.positions[0].symbol = 'UNKNOWN';
    expect(workerSharedTick(context, baseline, unknownContract, NOW, NOW)).toBeNull();
    expect(workerSharedTick(context, { ...baseline, accounts: [...baseline.accounts, { ...baseline.accounts[0], id: 8 }],
      coverage: { ...baseline.coverage, accounts: { availability: 'available', count: 2, httpStatus: 200 } } }, status(), NOW, NOW)).toBeNull();
  });
});

describe('worker cash ownership', () => {
  it('retains the actual cash confirmation time and defers while the worker owns a pending read', async () => {
    const { vi } = await import('vitest');
    const { readWorkerSharedCash } = await import('../server/tradovateSharedWorkerRead');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const current = status();
      current.startedAt = new Date(NOW - 3_600_000).toISOString();
      current.device = { deviceId: 'primary-worker', connectionId: 'c', state: 'paired', deviceName: 'test' };
      current.connectionDiscovery = { connectionAccounts: [{ connectionId: 'c', accountIds: [7] }] } as any;
      const confirmedAt = new Date(NOW - 30_000).toISOString();
      current.accountDisplay = [{ connectionId: 'c', environment: 'demo', streamConnected: true, pendingAccountIds: [],
        lastErrorAt: null, retryAt: null, snapshots: [{ accountId: 7, connectionId: 'c', environment: 'demo',
          requestedAt: confirmedAt, confirmedAt, fields: { totalCashValue: 50_000, dailyRealizedPnL: 0 } }] }];
      const query = { select: vi.fn(), eq: vi.fn(), is: vi.fn() };
      query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
      query.is.mockImplementation(async () => ({ data: [1,2].map(()=>({ runtime: { status: current, last_seen_at: new Date(NOW).toISOString() } })), error: null }));
      const authorizationQuery: any = { select: vi.fn(), eq: vi.fn(), maybeSingle: async()=>({data:{connected_at:new Date(NOW-3_600_000).toISOString(),refreshed_at:null,connection_status:'connected'},error:null}) };
      authorizationQuery.select.mockReturnValue(authorizationQuery); authorizationQuery.eq.mockReturnValue(authorizationQuery);
      const db = { from: vi.fn((table:string) => table==='tradovate_oauth_connections'?authorizationQuery:query) } as any;
      const result = await readWorkerSharedCash({ ...context, db, userId: 'owner', route: 'test' }, 7);
      expect(result?.confirmedAt).toBe(confirmedAt);
      expect(query.eq).toHaveBeenCalledWith('user_id', 'owner');
      expect(query.is).toHaveBeenCalledWith('revoked_at', null);
      current.accountDisplay[0].pendingAccountIds = [7];
      await expect(readWorkerSharedCash({ ...context, db, userId: 'owner', route: 'test' }, 7)).rejects.toMatchObject({ message: 'tradovate-read-pending' });
      expect(await readWorkerSharedCash({ ...context, db, userId: 'owner', route: 'test' }, 8)).toBeNull();
      current.displayBuiltAt = NOW - 20_000;
      expect(await readWorkerSharedCash({ ...context, db, userId: 'owner', route: 'test' }, 7)).toBeNull();
    } finally { clock.mockRestore(); }
  });
});
