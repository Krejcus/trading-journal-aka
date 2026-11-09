import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import type { TradovateAccountDataAccount, TradovateAccountDataResult } from '../lib/tradovateAccountDataTypes';
import type { TradovateWorkerAccountCoverage } from '../lib/tradovateRequestControl';
import { workerConnectionReadPlan, workerCoverageOwners, type WorkerConnectionDataset } from '../lib/tradovateWorkerCoverage';
import { useLiveChartData } from '../hooks/useLiveChartData';

const worker = vi.hoisted(() => ({ status: null as LocalCopierAgentStatus | null, observedAt: 0 }));
vi.mock('../hooks/useDisplayWorkerStatus', () => ({ useDisplayWorkerStatus: () => worker }));
vi.mock('../services/copyGroupLibrary', () => ({ readCopyGroupCache: () => [] }));
const { useJournalLivePosition } = await import('../hooks/useJournalLivePosition');
const NOW = Date.parse('2026-11-09T11:00:00Z');
const OLD = new Date(NOW - 300_000).toISOString();
const read = (count: number) => ({ availability: count ? 'available' as const : 'empty' as const, count, httpStatus: 200 });
const group = { id: 'g', name: 'G', enabled: true, manualOnly: true, leaderAccountId: 100, followers: [] };
const proof: TradovateWorkerAccountCoverage = { accountId: 100, connectionId: 'oauth-a', environment: 'demo', routeEpoch: 7, currentRouteEpoch: 7,
  sessionId: 'session-a', currentSessionId: 'session-a', baselineAt: NOW - 600_000, lastDataAt: NOW - 1_000,
  observedAt: NOW, socketLive: true, synchronized: true, gap: false, backlog: false, mergeInProgress: false };
const account = { id: 100, name: 'Demo', createdAt: null, active: true, canTrade: true, netPositionCount: 0, workingOrderCount: 0,
  readState: { positions: read(0), orders: read(0), positionsAsOf: OLD, ordersAsOf: OLD, cashAsOf: OLD, requestedAt: OLD },
  balance: { coverage: read(1), totalCashValue: 50_000, totalCashValueSOD: 50_000, netLiq: 50_000, netLiqSOD: 50_000,
    openPnL: 0, realizedPnL: 0, weekRealizedPnL: 0, totalPnL: 0, autoLiqLevel: null },
  activity: { positionCount: 0, netPositionCount: 0, workingOrderCount: 0, orderCount: 0, fillCount: 0, fillPairCount: 0,
    knownFees: 0, firstFillAt: null, lastFillAt: null },
  history: { coverage: read(0), entryCount: 0, firstEntryAt: null, lastEntryAt: null, realizedBalanceDrawdown: null },
  risk: { statusCoverage: read(0), limitsCoverage: read(0), maxNetLiq: null, minNetLiq: null, dailyLossAutoLiq: null,
    weeklyLossAutoLiq: null, trailingMaxDrawdown: null, trailingMaxDrawdownLimit: null },
  positions: [], orders: [], fills: [], fillPairs: [], daily: [], ledger: [],
} as unknown as TradovateAccountDataAccount;
const data: TradovateAccountDataResult = { capturedAt: OLD, requestedAt: OLD, accounts: [account],
  contracts: [{ id: 7, name: 'MNQZ6', contractMaturityId: null, timestamp: null }],
  coverage: { accounts: read(1), positions: read(0), orders: read(0), fills: read(0), fillPairs: read(0), fillFees: read(0), contracts: read(1) } };
const datasets = { 'oauth-a': { ...data, connectionId: 'oauth-a', environment: 'demo' } as WorkerConnectionDataset };
const status = { version: 1, environment: 'demo', nonce: 'n', startedAt: new Date(NOW - 3_600_000).toISOString(), group,
  controller: { armed: true, shadowMode: false, connected: true, excludedForeignFollowers: [], followerParticipation: [],
    exposure: { verifiedAt: NOW - 1_000, streamCoverage: [proof], positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: 2, avgPrice: 26_000 }],
      followers: [], orders: [
        { accountId: 100, brokerOrderId: '500', symbol: 'MNQZ6', side: 'Sell', orderType: 'Stop', quantity: 2, filledQuantity: 0,
          limitPrice: null, stopPrice: 25_990, status: 'working', updatedAt: NOW - 1_000 },
        { accountId: 100, brokerOrderId: '501', symbol: 'MNQZ6', side: 'Sell', orderType: 'Limit', quantity: 2, filledQuantity: 0,
          limitPrice: 26_020, stopPrice: null, status: 'working', updatedAt: NOW - 1_000 },
      ] },
  },
} as unknown as LocalCopierAgentStatus;
afterEach(() => vi.restoreAllMocks());

describe('actual chart hooks retain worker fills while covered frontend REST polling is suppressed', () => {
  it('passes exact connection owners through the LIVE chart hook and keeps position and protective orders from a fresh worker fill', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const coverageOwners = workerCoverageOwners(datasets);
    expect(workerConnectionReadPlan(datasets['oauth-a'], { status, observedAt: NOW }, NOW).suppressFullTick).toBe(true);
    let actual: ReturnType<typeof useLiveChartData> | null = null;
    const Probe = () => { actual = useLiveChartData({ enabled: true, data, coverageOwners, profiles: [], agentStatus: status,
      agentStatusObservedAt: NOW, statusFresh: true, displayAccounts: [], group, nameOf: String, root: 'MNQ', target: { kind: 'group' }, now: NOW }); return null; };
    renderToStaticMarkup(React.createElement(Probe));
    const out = actual as unknown as ReturnType<typeof useLiveChartData>;
    expect(out.position.issue).toBeNull();
    expect(out.position.summary).toMatchObject({ kind: 'position', quantity: 2, entry: 26_000, stop: 25_990, target: 26_020 });
    expect(out.working.verified).toBe(true);
    expect(out.working.orders.map(order => order.id)).toEqual([500, 501]);
    expect(data.accounts[0].positions).toEqual([]); expect(data.accounts[0].readState?.cashAsOf).toBe(OLD);
    const desk = readFileSync('components/TradovateLiveDesk.tsx', 'utf8');
    expect(desk).toMatch(/const coverageOwners = useMemo\(\(\) => workerCoverageOwners\(live\.connectionData\)/);
    expect(desk).toMatch(/useLiveChartData\(\{[\s\S]*?data: live\.data,\s*coverageOwners,/);
  });
  it('passes the same precise ownership through the journal hook without making old cash fresh', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW); worker.status = status; worker.observedAt = NOW;
    let actual: ReturnType<typeof useJournalLivePosition> | null = null;
    const Probe = () => { actual = useJournalLivePosition({ userId: 'user', data, profiles: [], connectionIds: ['oauth-a'],
      coverageOwners: workerCoverageOwners(datasets), setInterest: () => {} }, true, 'group'); return null; };
    renderToStaticMarkup(React.createElement(Probe));
    const out = actual as unknown as ReturnType<typeof useJournalLivePosition>;
    expect(out.issue).toBeNull(); expect(out.verified).toBe(true);
    expect(out.model).toMatchObject({ kind: 'position', quantity: 2, entry: 26_000, ladder: { stop: 25_990, target: 26_020 } });
    expect(data.accounts[0].readState?.cashAsOf).toBe(OLD);
    expect(readFileSync('App.tsx', 'utf8')).toContain('coverageOwners: workerCoverageOwners(tradovateLive.connectionData)');
  });
});
