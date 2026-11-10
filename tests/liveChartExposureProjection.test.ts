import { describe, expect, it } from 'vitest';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import type { TradovateAccountDataAccount, TradovateAccountDataResult } from '../lib/tradovateAccountDataTypes';
import { overlayWorkerExposure } from '../lib/tradovateWorkerExposureOverlay';
import { workerConnectionReadPlan } from '../lib/tradovateWorkerCoverage';
import {
  LIVE_CHART_UNVERIFIED_RISK_TEXT, liveChartDisplayAccounts, liveChartProjectionActionBlock, liveChartWorkerCursor,
  liveChartWorkerCursorAccepts, markLiveChartPositionProjection, projectLiveChartExposure, selectLiveChartProjection,
  trackLiveChartRestArrivals, type LiveChartRestArrival,
} from '../lib/liveChartExposureProjection';
import { tradovateCopyTradeOrders, tradovateCopyTradeSnapshot } from '../lib/tradovateCopyTradeBridge';
import { buildTradeCard } from '../lib/liveTradeCard';
import { liveChartPosition } from '../lib/liveChartPosition';
import { livePositionChartLines } from '../lib/liveChartOrderLines';
import { isLiveAccountReadVerified } from '../lib/liveReadFreshness';
import { isLiveDisplayOnlyLine } from '../lib/liveWorkingOrderLines';

const NOW = Date.UTC(2026, 10, 10, 15, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const owner = { connectionId: 'login-a', environment: 'demo' as const };
const owners = new Map([100, 200].map(accountId => [accountId, owner]));
const proof = (accountId: number) => ({ accountId, connectionId: 'login-a', environment: 'demo' as const, routeEpoch: 1, currentRouteEpoch: 1,
  sessionId: 's', currentSessionId: 's', baselineAt: NOW - 600_000, lastDataAt: NOW - 1_000, observedAt: NOW - 500,
  socketLive: true, synchronized: true, gap: false, backlog: false, mergeInProgress: false });
const coverage = (count: number) => ({ availability: count > 0 ? 'available' as const : 'empty' as const, count, httpStatus: 200 });

const account = (id: number, restAt: number, extras: Partial<TradovateAccountDataAccount> = {}): TradovateAccountDataAccount => ({
  id, name: `A${id}`, createdAt: null, active: true, canTrade: true, netPositionCount: 0, workingOrderCount: 0,
  readState: { positions: coverage(0), orders: coverage(0), positionsAsOf: iso(restAt), ordersAsOf: iso(restAt), cashAsOf: iso(restAt), requestedAt: iso(restAt) },
  balance: { coverage: coverage(1), totalCashValue: 50_000, totalCashValueSOD: 50_000, totalPnL: 0, netLiq: 50_000, netLiqSOD: 50_000, openPnL: 0,
    realizedPnL: 0, weekRealizedPnL: 0, cashUSD: 50_000, cashSODUSD: 50_000, currencyCashAvailWithdrawalUSD: 0, initialMargin: 0, maintenanceMargin: 0,
    fullInitialMargin: 0, fullInitialMarginSOD: 0, autoLiqLevel: null, withdrawalRejectReason: null },
  activity: { positionCount: 0, netPositionCount: 0, workingOrderCount: 0, orderCount: 0, fillCount: 0, fillPairCount: 0, knownFees: 0, firstFillAt: null, lastFillAt: null },
  history: { coverage: coverage(0), entryCount: 0, firstEntryAt: null, lastEntryAt: null, realizedBalanceDrawdown: null },
  risk: { statusCoverage: coverage(0), limitsCoverage: coverage(0), adminAction: null, maxNetLiq: null, minNetLiq: null, dailyLossAutoLiq: null,
    weeklyLossAutoLiq: null, trailingMaxDrawdown: null, trailingMaxDrawdownLimit: null, trailingMaxDrawdownMode: null, changesLocked: null },
  positions: [], orders: [], fills: [], fillPairs: [], daily: [], ledger: [],
  ...extras,
} as TradovateAccountDataAccount);

/** REST: leader i follower ještě flat (čtení z doby před fillem). */
const restFlat = (restAt = NOW - 4_000): TradovateAccountDataResult => ({
  capturedAt: iso(restAt), requestedAt: iso(restAt),
  accounts: [account(100, restAt), account(200, restAt)],
  contracts: [{ id: 7, name: 'MNQZ6', contractMaturityId: null, timestamp: null }],
  coverage: { accounts: coverage(2), positions: coverage(0), orders: coverage(0), fills: coverage(0), fillPairs: coverage(0), fillFees: coverage(0), contracts: coverage(1) },
});

/** Worker: short 2 s SL 28 740 u leadera i followera; doklad kontinuity po fillu zmizel. */
const status = (opts: { proof?: boolean; streamLive?: boolean; connected?: boolean } = {}): LocalCopierAgentStatus => ({
  version: 1, environment: 'demo', nonce: 'n', startedAt: iso(NOW - 3_600_000),
  group: { id: 'g', name: 'G', enabled: true, leaderAccountId: 100, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }] },
  connectionUsage: [{ connectionId: 'login-a', rest: { minute: 0, hour: 0 }, ws: { minute: 0, hour: 0 }, streamConnected: opts.streamLive ?? true,
    phase: opts.streamLive === false ? 'waiting' : 'connected', lastClose: null, penaltyUntil: null, consecutiveSyncTimeouts: 0 }],
  controller: {
    started: true, armed: true, killSwitch: false, shadowMode: false, connected: opts.connected ?? true, reconciliationRequired: false,
    divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false, stuckOperations: [], lastError: null, revision: 1, lastSequence: 1,
    exposure: {
      verifiedAt: NOW - 1_000,
      streamCoverage: opts.proof ? [proof(100), proof(200)] : [],
      positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: -2, avgPrice: 28_768.5 }, { accountId: 200, symbol: 'MNQZ6', netQuantity: -2 }],
      followers: [{ accountId: 200, ok: true, detail: null }],
      orders: [
        { accountId: 100, brokerOrderId: '9', symbol: 'MNQZ6', side: 'Buy', orderType: 'Stop', quantity: 2, filledQuantity: 0, limitPrice: null, stopPrice: 28_790, status: 'working', updatedAt: NOW - 1_000 },
      ],
    },
  },
} as unknown as LocalCopierAgentStatus);

const fresh = { statusFresh: true, trusted: true, restArrivals: new Map<number, LiveChartRestArrival>(), lastWorkerRestAt: new Map<number, number | null>() };

/** Celý řetěz grafu: projekce → účty → karta leadera → pozice grafu → čáry. */
const chartLines = (projected: TradovateAccountDataResult) => {
  const snapshot = tradovateCopyTradeSnapshot(projected, []);
  const unverified = new Set(snapshot.accounts.filter(item => item.displayProjection === 'worker-unverified').map(item => item.id));
  const accounts = liveChartDisplayAccounts(snapshot.accounts);
  const card = buildTradeCard([{ account: accounts.find(item => item.id === 100), accountId: 100, name: 'L', isLeader: true }],
    tradovateCopyTradeOrders(projected), new Map(), NOW);
  const position = markLiveChartPositionProjection(liveChartPosition({ model: card, options: [], target: 100, verified: card != null, issue: null, readAgeMs: 0,
    divergenceCandidate: false, copierOff: false, scopeLabel: null }, 100), unverified);
  return { position, snapshot, lines: position.summary ? livePositionChartLines(position.summary, { manageable: true, entryAvg: 28_768.5, pointValue: 2 }) : [] };
};

describe('LIVE graf: zobrazovací projekce stavu workeru', () => {
  it('ztráta dokladu při otevřené pozici neschová čáry — kreslí se ze stavu workeru jako „neověřeno“', () => {
    // Dnešní chyba: bez dokladu overlay vrátí starý REST (flat) a čáry zmizí.
    expect(overlayWorkerExposure(restFlat(), status(), NOW - 1_000, NOW, owners)!.accounts[0].positions).toEqual([]);
    const { data } = projectLiveChartExposure(restFlat(), status(), NOW - 1_000, NOW, owners, fresh);
    const { position, lines } = chartLines(data!);
    expect(position.summary).toMatchObject({ kind: 'position', side: 'short', quantity: 2, stop: 28_790, unverified: true });
    expect(lines.map(line => line.kind)).toEqual(['entry', 'stopLoss']);
    // Tlumené a označené, ale ne displayOnly: SL se dá utáhnout a čára není potvrzená ochrana.
    expect(lines.every(line => !isLiveDisplayOnlyLine(line as never) && /neověřeno/.test(line.label))).toBe(true);
    expect(lines.find(line => line.kind === 'stopLoss')).toMatchObject({ draggable: true, color: '#64748b' });
  });

  it('s platným dokladem zůstává ověřený stav (bez štítku, s ovládáním)', () => {
    const { data } = projectLiveChartExposure(restFlat(), status({ proof: true }), NOW - 1_000, NOW, owners, fresh);
    const { position, lines } = chartLines(data!);
    expect(position.summary?.unverified).toBeUndefined();
    expect(lines.find(line => line.kind === 'stopLoss')).toMatchObject({ draggable: true });
  });

  it('stará REST odpověď nepřepíše novější stav workeru, dokud worker žije', () => {
    // REST dorazil (i podle serveru) později, ale worker je čerstvý: přednost má worker.
    const rest = restFlat(NOW - 200);
    const arrivals = trackLiveChartRestArrivals(new Map(), rest);
    const { data } = projectLiveChartExposure(rest, status(), NOW - 1_000, NOW, owners, { ...fresh, restArrivals: arrivals });
    expect(data!.accounts.find(item => item.id === 100)!.positions[0]).toMatchObject({ netPosition: -2 });
  });

  it('worker zmlkne: REST se starším requestedAt je neutrální, ne flat; novější requestedAt platí i když odpověď přišla pozdě', () => {
    const rest = restFlat(NOW - 30_000);
    const held = new Map<number, number | null>([[100, NOW - 30_000], [200, NOW - 30_000]]);
    const older = trackLiveChartRestArrivals(new Map(), rest);
    const stale = projectLiveChartExposure(rest, status(), NOW - 20_000, NOW, owners, { ...fresh, statusFresh: false, restArrivals: older, lastWorkerRestAt: held });
    const leader = stale.data!.accounts.find(item => item.id === 100)!;
    expect(leader.readState?.positions.availability).toBe('unavailable');
    const snapshot = tradovateCopyTradeSnapshot(stale.data!, []);
    expect(isLiveAccountReadVerified(snapshot.accounts.find(item => item.id === 100)!, 'positions', NOW)).toBe(false);
    // Pozdní odpověď čtení, které začalo před stavem workeru, flat nevrátí.
    const late = trackLiveChartRestArrivals(new Map(), restFlat(NOW - 60_000));
    const lateOut = projectLiveChartExposure(restFlat(NOW - 60_000), status(), NOW - 20_000, NOW, owners, { ...fresh, statusFresh: false, restArrivals: late, lastWorkerRestAt: held });
    expect(lateOut.data!.accounts.find(item => item.id === 100)!.readState?.positions.availability).toBe('unavailable');
    // Čtení spuštěné až po tom, které pod workerem leželo, už stav nahradí.
    const newer = trackLiveChartRestArrivals(older, restFlat(NOW - 1_000));
    const after = projectLiveChartExposure(restFlat(NOW - 1_000), status(), NOW - 20_000, NOW, owners, { ...fresh, statusFresh: false, restArrivals: newer, lastWorkerRestAt: held });
    expect(after.data!.accounts.find(item => item.id === 100)!.readState?.positions.availability).toBe('empty');
  });

  it('starší revision nebo displaySeq téhož běhu se do grafu nevrátí', () => {
    const current = liveChartWorkerCursor(status());
    const olderRevision = liveChartWorkerCursor({ ...status(), controller: { ...status().controller, revision: 0 } });
    const olderSeq = liveChartWorkerCursor({ ...status(), displaySeq: 4 });
    const newerSeq = liveChartWorkerCursor({ ...status(), displaySeq: 5 });
    expect(liveChartWorkerCursorAccepts(null, current)).toBe(true);
    expect(liveChartWorkerCursorAccepts(current, olderRevision)).toBe(false);
    expect(liveChartWorkerCursorAccepts({ ...current!, displaySeq: 5 }, olderSeq)).toBe(false);
    expect(liveChartWorkerCursorAccepts({ ...current!, displaySeq: 4 }, newerSeq)).toBe(true);
    const held = projectLiveChartExposure(restFlat(), status(), NOW - 1_000, NOW, owners, fresh);
    const selected = selectLiveChartProjection({ cursor: { ...current!, displaySeq: 5 }, projected: held }, olderSeq, { statusFresh: true }, () => {
      throw new Error('starší snímek se nesmí znovu počítat');
    });
    expect(selected.held).toBe(true);
    expect(selected.projected).toBe(held);
    let recomputed = 0;
    const released = selectLiveChartProjection({ cursor: { ...current!, displaySeq: 5 }, projected: held }, olderSeq, { statusFresh: false }, () => {
      recomputed += 1;
      return held;
    });
    expect(recomputed).toBe(1);
    expect(released.held).toBe(false);
    expect(released.cursor).toEqual(olderSeq);
    const cleared = selectLiveChartProjection({ cursor: current, projected: held }, null, { statusFresh: true }, () => held);
    expect(cleared.held).toBe(false);
    expect(cleared.cursor).toBeNull();
  });

  it('obnovená cache, odpojený worker ani spadlý socket připojení se nepromítnou jako stav (neznámo ≠ flat)', () => {
    for (const [input, current] of [
      [{ ...fresh, trusted: false }, status()],
      [{ ...fresh, statusFresh: false }, status()],
      [fresh, status({ connected: false })],
      [fresh, status({ streamLive: false })],
    ] as const) {
      const rest = restFlat();
      const out = projectLiveChartExposure(rest, current, NOW - 1_000, NOW, owners, input);
      expect(out.data!.accounts.find(item => item.id === 100)!.readState?.displayProjection).toBeUndefined();
      expect(out.workerShown).toEqual([]);
    }
  });

  it('dvě OAuth připojení: projektuje se jen účet připojení s živým socketem; nejednoznačný vlastník nikdy', () => {
    const current = status();
    (current as { connectionUsage: unknown[] }).connectionUsage.push({ connectionId: 'login-b', rest: { minute: 0, hour: 0 }, ws: { minute: 0, hour: 0 },
      streamConnected: false, phase: 'waiting', lastClose: null, penaltyUntil: null, consecutiveSyncTimeouts: 0 });
    const split = new Map([[100, owner], [200, { connectionId: 'login-b', environment: 'demo' as const }]]);
    const out = projectLiveChartExposure(restFlat(), current, NOW - 1_000, NOW, split, fresh);
    expect(out.workerShown).toEqual([100]);
    expect(out.data!.accounts.find(item => item.id === 200)!.readState?.displayProjection).toBeUndefined();
    const ambiguous = projectLiveChartExposure(restFlat(), status(), NOW - 1_000, NOW, new Map([[200, owner]]), fresh);
    expect(ambiguous.workerShown).toEqual([200]);
  });

  it('starší než 8 s pozorování workeru se nekreslí jako stav', () => {
    const out = projectLiveChartExposure(restFlat(), status(), NOW - 8_001, NOW, owners, fresh);
    expect(out.data!.accounts.find(item => item.id === 100)!.readState?.displayProjection).toBeUndefined();
  });
});

describe('autorizace dál vyžaduje doklad', () => {
  it('neověřená projekce není ověřené čtení pozic ani příkazů', () => {
    const { data } = projectLiveChartExposure(restFlat(), status(), NOW - 1_000, NOW, owners, fresh);
    const leader = tradovateCopyTradeSnapshot(data!, []).accounts.find(item => item.id === 100)!;
    expect(leader.displayProjection).toBe('worker-unverified');
    expect(isLiveAccountReadVerified(leader, 'positions', NOW)).toBe(false);
    expect(isLiveAccountReadVerified(leader, 'orders', NOW)).toBe(false);
  });

  it('desková data (přehled, způsobilost) i plán REST čtení dál stojí jen na dokladu', () => {
    const rest = restFlat();
    expect(overlayWorkerExposure(rest, status(), NOW - 1_000, NOW, owners)).toBe(rest);
    const plan = workerConnectionReadPlan({ ...rest, ...owner }, { status: status(), observedAt: NOW - 1_000 }, NOW);
    expect(plan.suppressFullTick).toBe(false);
    expect(plan.uncoveredAccountIds).toEqual([100, 200]);
  });

  it('z neověřené pozice jde zavřít a utáhnout SL; roztažení, přikoupení a nový vstup ne', () => {
    const unverified = chartLines(projectLiveChartExposure(restFlat(), status(), NOW - 1_000, NOW, owners, fresh).data!).position;
    expect(liveChartProjectionActionBlock(unverified, { action: 'close-position' })).toBeNull();
    expect(liveChartProjectionActionBlock(unverified, { action: 'cancel-entry' })).toBeNull();
    expect(liveChartProjectionActionBlock(unverified, { action: 'attach-brackets' })).toBeNull();
    expect(liveChartProjectionActionBlock(unverified, { action: 'add-stop' })).toBeNull();
    // Short: utažení = SL níž. 28 790 → 28 780.
    expect(liveChartProjectionActionBlock(unverified, { action: 'move-stop', nextPrice: 28_780 })).toBeNull();
    expect(liveChartProjectionActionBlock(unverified, { action: 'move-stop', nextPrice: 28_800 })).toBe(LIVE_CHART_UNVERIFIED_RISK_TEXT);
    expect(liveChartProjectionActionBlock(unverified, { action: 'move-stop', nextPrice: 28_790 })).toBe(LIVE_CHART_UNVERIFIED_RISK_TEXT);
    expect(liveChartProjectionActionBlock(unverified, { action: 'scale-in' })).toBe(LIVE_CHART_UNVERIFIED_RISK_TEXT);
    expect(liveChartProjectionActionBlock(unverified, { action: 'entry' })).toBe(LIVE_CHART_UNVERIFIED_RISK_TEXT);
    expect(liveChartProjectionActionBlock(unverified, { action: 'remove-stop' })).toBe(LIVE_CHART_UNVERIFIED_RISK_TEXT);
    expect(LIVE_CHART_UNVERIFIED_RISK_TEXT).toMatch(/nic se neodeslalo/);
    const verified = chartLines(projectLiveChartExposure(restFlat(), status({ proof: true }), NOW - 1_000, NOW, owners, fresh).data!).position;
    expect(liveChartProjectionActionBlock(verified, { action: 'scale-in' })).toBeNull();
    expect(liveChartProjectionActionBlock(verified, { action: 'move-stop', nextPrice: 28_800 })).toBeNull();
  });
});
