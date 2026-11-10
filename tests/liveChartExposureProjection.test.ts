import { liveUnverifiedActionBlock } from '../lib/liveChartRiskPolicy';
import { describe, expect, it } from 'vitest';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import type { TradovateAccountDataAccount, TradovateAccountDataResult } from '../lib/tradovateAccountDataTypes';
import { overlayWorkerExposure } from '../lib/tradovateWorkerExposureOverlay';
import { workerConnectionReadPlan } from '../lib/tradovateWorkerCoverage';
import { overlayWorkerContinuityForDisplay,
  liveChartDisplayAccounts, markLiveChartPositionProjection,
  projectLiveChartExposure, holdLastDrawnPosition, LIVE_CHART_HOLD_LAST_DRAWN_MS, liveChartDrawnMemory, liveChartDrawnMemoryKey, rememberLiveChartDrawn, resetLiveChartDrawnMemoryForTests,
} from '../lib/liveChartExposureProjection';
import { tradovateCopyTradeOrders, tradovateCopyTradeSnapshot } from '../lib/tradovateCopyTradeBridge';
import { buildTradeCard } from '../lib/liveTradeCard';
import { liveChartPosition, type LiveChartPosition, type LiveChartPositionSummary } from '../lib/liveChartPosition';
import { LIVE_UNVERIFIED_LINE_COLOR, livePositionChartLines } from '../lib/liveChartOrderLines';
import { isLiveAccountReadVerified } from '../lib/liveReadFreshness';
import { noteTradovateWorkerShown, resetTradovateClientReadSeqForTests, stampTradovateClientReads, tradovateWorkerShownSeq } from '../lib/tradovateClientReadOrder';
import { readFileSync } from 'node:fs';
import { liveChartWorkingOrders, liveChartWorkingSource } from '../hooks/useLiveChartData';
import { buildLiveTradeGroup } from '../lib/liveTradeGroupSource';

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

const fresh = { statusFresh: true, trusted: true, lastWorkerShownSeq: new Map<number, number>() };
/** REST čtení označené sekvencí ZAHÁJENÍ požadavku (jako `useTradovateLiveData`). */
const restRead = (seq: number, restAt = NOW - 4_000, patch?: (data: TradovateAccountDataResult) => void) => {
  const read = restFlat(restAt);
  patch?.(read);
  return stampTradovateClientReads(null, read, seq);
};
const silent = (shownSeq: number) => ({ ...fresh, statusFresh: false, lastWorkerShownSeq: new Map([[100, shownSeq], [200, shownSeq]]) });

/** Celý řetěz grafu: projekce → účty → karta leadera → pozice grafu → čáry. */
const chartLines = (projected: TradovateAccountDataResult) => {
  const snapshot = tradovateCopyTradeSnapshot(projected, []);
  const unverified = new Set(snapshot.accounts.filter(item => item.displayProjection === 'worker-unverified').map(item => item.id));
  const accounts = liveChartDisplayAccounts(snapshot.accounts);
  const leader = accounts.find(item => item.id === 100);
  const card = buildTradeCard([{ account: leader, accountId: 100, name: 'L', isLeader: true }],
    tradovateCopyTradeOrders(projected), new Map(), NOW);
  // Jako pohled deníku: neověřené čtení pozic = žádná pozice (štítek), nikdy poslední známá.
  const verified = leader != null && isLiveAccountReadVerified(leader, 'positions', NOW);
  const position = markLiveChartPositionProjection(liveChartPosition({ model: verified ? card : null, options: [], target: 100, verified, issue: verified ? null : 'stale', readAgeMs: 0,
    divergenceCandidate: false, copierOff: false, scopeLabel: null }, 100), unverified);
  return { position, snapshot, lines: position.summary ? livePositionChartLines(position.summary, { manageable: true, canClose: true, entryAvg: 28_768.5, pointValue: 2 }) : [] };
};

describe('LIVE graf: zobrazovací projekce stavu workeru', () => {
  it('ztráta dokladu při otevřené pozici neschová čáry ani ovládání snižující riziko — vše „neověřeno“', () => {
    // Chyba z dd393f72: bez dokladu overlay vrátí starý REST (flat) a čáry zmizí.
    expect(overlayWorkerExposure(restFlat(), status(), NOW - 1_000, NOW, owners)!.accounts[0].positions).toEqual([]);
    const { data } = projectLiveChartExposure(restFlat(), status(), NOW - 1_000, NOW, owners, fresh);
    const { position, lines } = chartLines(data!);
    expect(position.summary).toMatchObject({ kind: 'position', side: 'short', quantity: 2, stop: 28_790, unverified: true });
    expect(lines.map(line => line.kind)).toEqual(['entry', 'stopLoss']);
    expect(lines.every(line => /neověřeno/.test(line.label) && line.color === LIVE_UNVERIFIED_LINE_COLOR)).toBe(true);
    // Ovládání snižující riziko zůstává: × zavřít a tažení SL (jen utažení ověří brána).
    const entry = lines.find(line => line.kind === 'entry')!;
    expect(entry.cancellable).toBe(true);
    expect(lines.find(line => line.kind === 'stopLoss')!.draggable).toBe(true);
  });

  it('DEMO 10. 11.: doklad po obchodu chybí, ale kontinuita streamu od baseline z čerstvého statusu pozici ověří (tažení jde)', () => {
    const withContinuity = (observedAt = NOW - 500) => {
      const current = status();
      (current.controller.exposure as { streamContinuity?: unknown }).streamContinuity = [100, 200].map(id => ({ ...proof(id), observedAt }));
      return current;
    };
    const { data, workerShown } = projectLiveChartExposure(restFlat(), withContinuity(), NOW - 1_000, NOW, owners, fresh);
    expect(workerShown).toEqual(expect.arrayContaining([100, 200]));
    const { position, lines } = chartLines(data!);
    expect(position.summary).toMatchObject({ kind: 'position', side: 'short', quantity: 2, stop: 28_790 });
    expect(position.summary?.unverified).toBeUndefined();
    expect(lines.find(line => line.kind === 'stopLoss')).toMatchObject({ draggable: true });
    expect(liveUnverifiedActionBlock(position.summary, { kind: 'move-target' })).toBeNull();
    // Řízení REST čtení kontinuitu NEbere: bez dokladu web dál čte REST sám.
    expect(workerConnectionReadPlan({ ...restFlat(), ...owner }, { status: withContinuity(), observedAt: NOW - 1_000 }, NOW).suppressFullTick).toBe(false);
    // Obnovená cache ani nečerstvý status kontinuitu nepoužijí; starý řádek (> 8 s) taky ne.
    for (const input of [{ ...fresh, trusted: false }, { ...fresh, statusFresh: false }]) {
      const out = projectLiveChartExposure(restFlat(), withContinuity(), NOW - 1_000, NOW, owners, input);
      expect(out.data!.accounts.find(item => item.id === 100)!.readState?.displayStreamCoverage).toBeUndefined();
    }
    // Nezpracované události (backlog) ani neshoda snímku streamu s cache (merge) kontinuitu neověří.
    for (const flag of [{ backlog: true }, { mergeInProgress: true }, { synchronized: false }, { gap: true }, { socketLive: false }]) {
      const current = withContinuity();
      const rows = (current.controller.exposure as unknown as { streamContinuity: Array<Record<string, unknown>> }).streamContinuity;
      rows.forEach((row, index) => { rows[index] = { ...row, ...flag }; });
      const out = projectLiveChartExposure(restFlat(), current, NOW - 1_000, NOW, owners, fresh);
      expect(chartLines(out.data!).position.summary?.unverified).toBe(true);
    }
    const stale = projectLiveChartExposure(restFlat(), withContinuity(NOW - 9_000), NOW - 1_000, NOW, owners, fresh);
    expect(chartLines(stale.data!).position.summary?.unverified).toBe(true);
  });

  it('s platným dokladem zůstává ověřený stav (bez štítku, s tažením)', () => {
    const { data } = projectLiveChartExposure(restFlat(), status({ proof: true }), NOW - 1_000, NOW, owners, fresh);
    const { position, lines } = chartLines(data!);
    expect(position.summary?.unverified).toBeUndefined();
    expect(lines.find(line => line.kind === 'stopLoss')).toMatchObject({ draggable: true });
  });

  it('dokud worker žije, nepřepíše jeho stav žádná REST odpověď (ani zahájená později)', () => {
    const { data } = projectLiveChartExposure(restRead(99), status(), NOW - 1_000, NOW, owners, { ...fresh, lastWorkerShownSeq: new Map([[100, 5]]) });
    expect(data!.accounts.find(item => item.id === 100)!.positions[0]).toMatchObject({ netPosition: -2 });
  });

  it('REST odpovědi mimo pořadí: pozdní odpověď na požadavek zahájený PŘED posledním stavem workeru nevyrobí flat', () => {
    // Pořadí: požadavek #4 zahájen → worker ukázal short 2 (sekvence 5) → worker zmlkl → #4 dorazí až teď.
    const late = projectLiveChartExposure(restRead(4), status(), NOW - 20_000, NOW, owners, silent(5));
    const leader = late.data!.accounts.find(item => item.id === 100)!;
    expect(leader.readState?.positions.availability).toBe('unavailable');
    expect(leader.positions).toEqual([]);
    const snapshot = tradovateCopyTradeSnapshot(late.data!, []);
    expect(isLiveAccountReadVerified(snapshot.accounts.find(item => item.id === 100)!, 'positions', NOW)).toBe(false);
    expect(chartLines(late.data!).position.summary).toBeNull();
    // Požadavek zahájený až po stavu workeru (#6) platí — i kdyby jeho čas serveru byl „starší“.
    const after = projectLiveChartExposure(restRead(6, NOW - 60_000), status(), NOW - 20_000, NOW, owners, silent(5));
    expect(after.data!.accounts.find(item => item.id === 100)!.readState?.positions.availability).toBe('empty');
  });

  it('remount grafu: evidence posledního stavu workeru žije v modulu, takže stará REST odpověď po remountu flat nevyrobí', () => {
    resetTradovateClientReadSeqForTests(10);
    // Instance grafu A ukázala stav workeru (short 2) při sekvenci 10, pak se odpojila (remount).
    noteTradovateWorkerShown([100, 200], 10);
    // Nová instance B nemá vlastní paměť — čte modul. Worker mezitím zmlkl, dorazí odpověď na požadavek #9.
    const afterRemount = projectLiveChartExposure(restRead(9), status(), NOW - 20_000, NOW, owners,
      { statusFresh: false, trusted: true, lastWorkerShownSeq: tradovateWorkerShownSeq() });
    expect(afterRemount.data!.accounts.find(item => item.id === 100)!.readState?.positions.availability).toBe('unavailable');
    expect(chartLines(afterRemount.data!).position.summary).toBeNull();
    // Čtení zahájené po stavu workeru (#11) platí.
    const fresh11 = projectLiveChartExposure(restRead(11), status(), NOW - 20_000, NOW, owners,
      { statusFresh: false, trusted: true, lastWorkerShownSeq: tradovateWorkerShownSeq() });
    expect(fresh11.data!.accounts.find(item => item.id === 100)!.readState?.positions.availability).toBe('empty');
    // Hodnota jen roste (starší záznam ji nesníží).
    noteTradovateWorkerShown([100], 3);
    expect(tradovateWorkerShownSeq().get(100)).toBe(10);
    // Hook nemá vlastní (per-instance) paměť stavu workeru — jen modul.
    const hook = readFileSync('hooks/useLiveChartData.ts', 'utf8');
    expect(hook).toMatch(/lastWorkerShownSeq: tradovateWorkerShownSeq\(\)/);
    expect(hook).toMatch(/noteTradovateWorkerShown\(projected\.workerShown, currentTradovateClientReadSeq\(\)\)/);
    expect(hook).not.toMatch(/lastWorkerShownRef/);
    resetTradovateClientReadSeqForTests();
  });

  it('pořadí podle sekvence, ne podle příchodu: novější čtení pozic se starším čtením příkazů nestačí', () => {
    const mixed = restFlat();
    const stamped = stampTradovateClientReads(null, mixed, 6);
    stamped.accounts[0].readState!.clientOrdersReadSeq = 3;
    const out = projectLiveChartExposure(stamped, status(), NOW - 20_000, NOW, owners, silent(5));
    expect(out.data!.accounts.find(item => item.id === 100)!.readState?.orders.availability).toBe('unavailable');
  });

  it('merge starší odpovědi nepřevezme její sekvenci: čtení, které nic nezměnilo, si nechá původní číslo', () => {
    const first = stampTradovateClientReads(null, restFlat(NOW - 4_000), 7);
    const sameAsOf = stampTradovateClientReads(first, restFlat(NOW - 4_000), 2);
    expect(sameAsOf.accounts[0].readState).toMatchObject({ clientPositionsReadSeq: 7, clientOrdersReadSeq: 7 });
    const unknownStart = stampTradovateClientReads(first, restFlat(NOW - 1_000), null);
    expect(unknownStart.accounts[0].readState).toMatchObject({ clientPositionsReadSeq: 0, clientOrdersReadSeq: 0 });
  });

  it('stará pozice vs. nový vstup: pozdní REST se starou pozicí nepřepíše nový vstup workeru', () => {
    // REST (požadavek #4) ještě vidí starou long 1; worker už hlásí nový short 2.
    const oldLong = (read: TradovateAccountDataResult) => {
      read.accounts[0].positions = [{ id: 1, contractId: 7, symbol: 'MNQZ6', timestamp: null, tradeDate: null, netPosition: 1, bought: null, boughtValue: null, sold: null, soldValue: null, previousPosition: null, averagePrice: 28_700, previousPrice: null }];
      read.accounts[0].netPositionCount = 1;
    };
    const live = projectLiveChartExposure(restRead(4, NOW - 4_000, oldLong), status(), NOW - 1_000, NOW, owners, fresh);
    expect(chartLines(live.data!).position.summary).toMatchObject({ side: 'short', quantity: 2, unverified: true });
    const silentLate = projectLiveChartExposure(restRead(4, NOW - 4_000, oldLong), status(), NOW - 20_000, NOW, owners, silent(5));
    expect(chartLines(silentLate.data!).position.summary).toBeNull();
    expect(silentLate.data!.accounts.find(item => item.id === 100)!.readState?.positions.availability).toBe('unavailable');
  });

  describe('tabulka (review Codexu, 4. kolo): sekvenční plot je první krok, před overlayem i zkratkou dokladu', () => {
    const flat = (proof: boolean) => {
      const current = status({ proof });
      current.controller.exposure!.positions = [];
      current.controller.exposure!.orders = [];
      return current;
    };
    const rows: Array<{ trusted: boolean; statusFresh: boolean; proof: boolean; worker: 'short2' | 'flat'; restSeq: number }> = [];
    for (const trusted of [true, false]) for (const statusFresh of [true, false]) for (const proof of [true, false])
      for (const worker of ['short2', 'flat'] as const) for (const restSeq of [9, 11]) rows.push({ trusted, statusFresh, proof, worker, restSeq });

    it.each(rows)('trusted=$trusted statusFresh=$statusFresh doklad=$proof worker=$worker REST seq=$restSeq (worker zobrazen při seq 10)', row => {
      const current = row.worker === 'flat' ? flat(row.proof) : status({ proof: row.proof });
      const out = projectLiveChartExposure(restRead(row.restSeq), current, NOW - 1_000, NOW, owners,
        { trusted: row.trusted, statusFresh: row.statusFresh, lastWorkerShownSeq: new Map([[100, 10], [200, 10]]) });
      const leader = out.data!.accounts.find(item => item.id === 100)!;
      const drawsWorker = row.trusted && row.statusFresh;
      if (drawsWorker) {
        // Čerstvý status této instance: graf kreslí stav workeru (s dokladem ověřeně, bez něj „neověřeno“).
        expect(leader.readState?.positionsAsOf).toBe(iso(NOW - 1_000));
        expect(leader.positions.filter(position => position.netPosition !== 0).length).toBe(row.worker === 'short2' ? 1 : 0);
        expect(leader.readState?.displayStreamCoverage != null).toBe(row.proof);
        expect(out.workerShown).toContain(100);
      } else {
        // Obnovená cache / nečerstvý status: stav workeru se nekreslí ani s platným dokladem; rozhoduje jen plot.
        expect(leader.readState?.displayStreamCoverage).toBeUndefined();
        expect(leader.readState?.displayProjection).toBeUndefined();
        expect(out.workerShown).toEqual([]);
        expect(leader.readState?.positions.availability).toBe(row.restSeq < 10 ? 'unavailable' : 'empty');
        expect(leader.readState?.orders.availability).toBe(row.restSeq < 10 ? 'unavailable' : 'empty');
        if (row.restSeq < 10) expect(chartLines(out.data!).position.summary).toBeNull();
      }
    });

    it('přesné repro: obnovený FLAT status s časově platným dokladem, trusted:false, statusFresh:false, worker seq 10, REST seq 9 → unavailable', () => {
      const out = projectLiveChartExposure(restRead(9), flat(true), NOW - 1_000, NOW, owners,
        { trusted: false, statusFresh: false, lastWorkerShownSeq: new Map([[100, 10], [200, 10]]) });
      expect(out.data!.accounts.find(item => item.id === 100)!.readState?.positions.availability).toBe('unavailable');
    });

    it('dvě projekce po sobě: čerstvý stav (zobrazen, evidence v modulu) → status zestárne → starší REST = unavailable', () => {
      resetTradovateClientReadSeqForTests(20);
      const first = projectLiveChartExposure(restRead(19), status(), NOW - 1_000, NOW, owners,
        { trusted: true, statusFresh: true, lastWorkerShownSeq: tradovateWorkerShownSeq() });
      expect(first.workerShown).toEqual(expect.arrayContaining([100, 200]));
      // Jako hook po renderu.
      noteTradovateWorkerShown(first.workerShown, 20);
      const stale = projectLiveChartExposure(restRead(19), status(), NOW - 20_000, NOW, owners,
        { trusted: true, statusFresh: false, lastWorkerShownSeq: tradovateWorkerShownSeq() });
      expect(stale.data!.accounts.find(item => item.id === 100)!.readState?.positions.availability).toBe('unavailable');
      const newer = projectLiveChartExposure(restRead(21), status(), NOW - 20_000, NOW, owners,
        { trusted: true, statusFresh: false, lastWorkerShownSeq: tradovateWorkerShownSeq() });
      expect(newer.data!.accounts.find(item => item.id === 100)!.readState?.positions.availability).toBe('empty');
      resetTradovateClientReadSeqForTests();
    });

    it('doklad starší než 8 s při trusted && statusFresh a starší REST = unavailable (doklad nic nezkrátí)', () => {
      const out = projectLiveChartExposure(restRead(9), status({ proof: true }), NOW - 8_001, NOW, owners,
        { trusted: true, statusFresh: true, lastWorkerShownSeq: new Map([[100, 10], [200, 10]]) });
      const leader = out.data!.accounts.find(item => item.id === 100)!;
      expect(leader.readState?.displayStreamCoverage).toBeUndefined();
      expect(leader.readState?.positions.availability).toBe('unavailable');
      expect(out.workerShown).toEqual([]);
    });

    it('plot je samostatný první krok: bez statusu workeru vůbec (null) platí taky', () => {
      const out = projectLiveChartExposure(restRead(9), null, null, NOW, owners,
        { trusted: true, statusFresh: true, lastWorkerShownSeq: new Map([[100, 10]]) });
      expect(out.data!.accounts.find(item => item.id === 100)!.readState?.positions.availability).toBe('unavailable');
      expect(out.data!.accounts.find(item => item.id === 200)!.readState?.positions.availability).toBe('empty');
    });
  });

  it('repro Codex P1: worker zobrazen při seq 10, REST čtení seq 9 = „unavailable“, ne „empty“ — na VŠECH cestách vč. obnovené cache', () => {
    const shown = new Map([[100, 10], [200, 10]]);
    for (const [label, input, current] of [
      ['obnovený status z cache (trusted:false)', { statusFresh: false, trusted: false, lastWorkerShownSeq: shown }, status()],
      ['obnovený status z cache, ještě „čerstvý“', { statusFresh: true, trusted: false, lastWorkerShownSeq: shown }, status()],
      ['worker zmlkl', { statusFresh: false, trusted: true, lastWorkerShownSeq: shown }, status()],
      ['worker odpojený', { statusFresh: true, trusted: true, lastWorkerShownSeq: shown }, status({ connected: false })],
      ['socket připojení dole', { statusFresh: true, trusted: true, lastWorkerShownSeq: shown }, status({ streamLive: false })],
    ] as const) {
      const out = projectLiveChartExposure(restRead(9), current, NOW - 1_000, NOW, owners, input);
      const leader = out.data!.accounts.find(item => item.id === 100)!;
      expect({ label, availability: leader.readState?.positions.availability }).toEqual({ label, availability: 'unavailable' });
      expect(leader.readState?.orders.availability).toBe('unavailable');
      expect(chartLines(out.data!).position.summary).toBeNull();
      // Obnovená cache nic neeviduje jako „zobrazený stav workeru“.
      if (!input.trusted) expect(out.workerShown).toEqual([]);
      // Čtení zahájené po zobrazení (seq 11) platí i na této cestě.
      const later = projectLiveChartExposure(restRead(11), current, NOW - 1_000, NOW, owners, input);
      expect(later.data!.accounts.find(item => item.id === 100)!.readState?.positions.availability).toBe('empty');
    }
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

describe('stav „neověřeno“ ve všech cestách zobrazení', () => {
  const projected = () => projectLiveChartExposure(restFlat(), status(), NOW - 1_000, NOW, owners, fresh).data!;

  it('karta ochrany (souhrn i řádky účtů) nese neověřeno a nikdy „kryje celou pozici“', () => {
    const { summary } = chartLines(projected()).position;
    expect(summary!.protection).toMatch(/· neověřeno$/);
    expect(summary!.rows.every(row => row.unverified === true && row.protectedFully === false)).toBe(true);
  });

  it('oba kanály čar: čáry pozice i pracující příkazy jsou tlumené se štítkem neověřeno', () => {
    const data = projected();
    const { position, snapshot, lines } = chartLines(data);
    expect(lines.every(line => /neověřeno/.test(line.label))).toBe(true);
    const unverified = new Set([100, 200]);
    const accounts = liveChartDisplayAccounts(snapshot.accounts);
    // Pracující příkaz mimo čáry pozice (Limit leadera) jde druhým kanálem.
    const orders = [...tradovateCopyTradeOrders(data), { accountId: 100, id: 77, symbol: 'MNQZ6', action: 'Buy', orderType: 'Limit', quantity: 1, price: 28_700, stopPrice: null, working: true, status: 'Working' }] as never;
    const source = liveChartWorkingSource({ enabled: true, accounts, orders, target: { kind: 'group' } as never, leaderAccountId: 100, position, now: NOW, unverifiedAccountIds: unverified });
    expect(source.unverified).toBe(true);
    const working = liveChartWorkingOrders(source, { pointValue: 2 });
    expect(working.lines.length).toBeGreaterThan(0);
    expect(working.lines.every(line => /neověřeno/.test(line.label) && line.color === LIVE_UNVERIFIED_LINE_COLOR)).toBe(true);
    const verifiedWorking = liveChartWorkingOrders({ ...source, unverified: false }, { pointValue: 2 });
    expect(verifiedWorking.key).not.toBe(working.key);
  });

  it('skupina v hlavičce grafu: text pozice neověřeného účtu nese neověřeno', () => {
    const { snapshot } = chartLines(projected());
    const accounts = liveChartDisplayAccounts(snapshot.accounts);
    const group = buildLiveTradeGroup({ group: { leaderAccountId: 100, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }] } as never,
      controller: null, statusFresh: true, displayAccounts: accounts, positionAccounts: accounts, orders: [], nameOf: id => `A${id}`,
      root: 'MNQ', now: NOW, unverifiedAccountIds: new Set([100]) })!;
    expect(JSON.stringify(group)).toMatch(/-2 @ [^"]* · neověřeno/);
  });
});

describe('autorizace dál vyžaduje doklad', () => {
  it('přehled LIVE: kontinuita jako graf ověří pozice pro zobrazení, doklad kopírky se nemění (review 9aa17b7, bod 4)', () => {
    const current = status();
    (current.controller.exposure as { streamContinuity?: unknown }).streamContinuity = [100, 200].map(id => ({ ...proof(id), observedAt: NOW - 500 }));
    const rest = restFlat();
    const proven = overlayWorkerExposure(rest, current, NOW - 1_000, NOW, owners)!;
    // Kopírka, způsobilost a REST plán: bez dokladu beze změny.
    expect(proven).toBe(rest);
    expect(workerConnectionReadPlan({ ...rest, ...owner }, { status: current, observedAt: NOW - 1_000 }, NOW).suppressFullTick).toBe(false);
    const shown = overlayWorkerContinuityForDisplay(proven, current, NOW - 1_000, NOW, owners, { statusFresh: true, trusted: true })!;
    const leader = tradovateCopyTradeSnapshot(shown, []).accounts.find(item => item.id === 100)!;
    expect(isLiveAccountReadVerified(leader, 'positions', NOW)).toBe(true);
    expect(isLiveAccountReadVerified(leader, 'orders', NOW)).toBe(true);
    // Stejně jako graf: obnovená cache, nečerstvý status ani starý řádek nic neověří.
    for (const input of [{ statusFresh: true, trusted: false }, { statusFresh: false, trusted: true }]) {
      expect(overlayWorkerContinuityForDisplay(proven, current, NOW - 1_000, NOW, owners, input)).toBe(proven);
    }
    expect(overlayWorkerContinuityForDisplay(proven, current, NOW - 9_000, NOW, owners, { statusFresh: true, trusted: true })).toBe(proven);
    // Odpojený worker ani chybějící příkazy v expozici nic neověří (critic 0a7f6ff3).
    const disconnected = { ...current, controller: { ...current.controller, connected: false } };
    expect(overlayWorkerContinuityForDisplay(proven, disconnected as never, NOW - 1_000, NOW, owners, { statusFresh: true, trusted: true })).toBe(proven);
    const noOrders = { ...current, controller: { ...current.controller, exposure: { ...current.controller.exposure, orders: undefined } } };
    expect(overlayWorkerContinuityForDisplay(proven, noOrders as never, NOW - 1_000, NOW, owners, { statusFresh: true, trusted: true })).toBe(proven);
    // Účet s dokladem se nepřepíše: druhý průchod nic nemění.
    expect(overlayWorkerContinuityForDisplay(shown, current, NOW - 1_000, NOW, owners, { statusFresh: true, trusted: true })).toBe(shown);
  });

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

  it('z neověřené pozice desk nic neodešle; ověřená projde dál k workeru', () => {
    const unverified = chartLines(projectLiveChartExposure(restFlat(), status(), NOW - 1_000, NOW, owners, fresh).data!).position;
    // Z neověřené pozice neprojde nic, co riziko zvyšuje; snížení rizika ano.
    expect(liveUnverifiedActionBlock(unverified.summary, { kind: 'entry' })).toMatch(/Nic se neodeslalo/);
    expect(liveUnverifiedActionBlock(unverified.summary, { kind: 'close' })).toBeNull();
    const verified = chartLines(projectLiveChartExposure(restFlat(), status({ proof: true }), NOW - 1_000, NOW, owners, fresh).data!).position;
    expect(liveUnverifiedActionBlock(verified.summary, { kind: 'entry' })).toBeNull();
  });
});

describe('DEMO 10. 11. bod 3: návrat na tab — poslední nakreslený stav se drží jako neověřený', () => {
  const drawn = (patch: Partial<LiveChartPositionSummary> = {}): LiveChartPosition => ({
    key: 'pos', symbol: 'MNQZ6', lines: [], issue: null,
    summary: { kind: 'position', side: 'short', quantity: 2, entry: 100, entryType: null, openPnl: 0, mark: 99, stop: 110, target: 80,
      protection: 'SL 2/2 · TP 2/2', accounts: 2, scopeLabel: null, leader: { accountId: 100, quantity: 2, entry: 100 },
      rows: [{ accountId: 100 } as never, { accountId: 200 } as never], ...patch },
  });
  const unknown: LiveChartPosition = { key: 'issue:stale', symbol: null, lines: [], summary: null, issue: 'Pozice neověřené', issueKind: 'stale' };
  const verifiedFlat: LiveChartPosition = { key: 'none', symbol: null, lines: [], summary: null, issue: null };

  it('po návratu na tab (status ještě nečerstvý, starší REST = neznámo) čáry nezmizí — pozice se drží jako neověřená', () => {
    let memory = holdLastDrawnPosition(null, drawn(), NOW).memory;
    const back = holdLastDrawnPosition(memory, unknown, NOW + 650);
    expect(back.shown.summary).toMatchObject({ side: 'short', quantity: 2, unverified: true });
    expect(back.shown.summary!.protection).toMatch(/neověřeno/);
    // Držený stav nic neautorizuje.
    expect(liveUnverifiedActionBlock(back.shown.summary, { kind: 'scale-in' })).toMatch(/přikoupit/);
    expect(liveUnverifiedActionBlock(back.shown.summary, { kind: 'close' })).toBeNull();
    // Nový stav (ověřený) ho nahradí hned.
    memory = back.memory;
    const fresh2 = holdLastDrawnPosition(memory, drawn({ quantity: 1 }), NOW + 700);
    expect(fresh2.shown.summary).toMatchObject({ quantity: 1 });
    expect(fresh2.shown.summary!.unverified).toBeUndefined();
  });

  it('rozjetá skupina, dobíhající kopie, chybějící účet ani jiný cíl se nedrží — štítek hned (INV-UI-01/03)', () => {
    const memory = holdLastDrawnPosition(null, drawn(), NOW).memory;
    for (const issueKind of ['divergent', 'settling', 'missing-account', 'mismatch', 'unknown'] as const) {
      const real: LiveChartPosition = { key: `issue:${issueKind}`, symbol: null, lines: [], summary: null, issue: 'Účty skupiny se liší', issueKind };
      expect(holdLastDrawnPosition(memory, real, NOW + 300)).toEqual({ shown: real, memory: null });
    }
    // orders-stale (jen příkazy neověřené) se drží stejně jako stale.
    expect(holdLastDrawnPosition(memory, { ...unknown, issueKind: 'orders-stale' }, NOW + 300).shown.summary?.unverified).toBe(true);
  });

  it('checklist ★: remount grafu — paměť posledního stavu žije v modulu (ne v komponentě), takže nový mount neblikne na flat', () => {
    resetLiveChartDrawnMemoryForTests();
    // Instance A nakreslí pozici a odpojí se.
    rememberLiveChartDrawn('group', holdLastDrawnPosition(liveChartDrawnMemory('group', NOW), drawn(), NOW).memory);
    // Instance B (nový mount, žádné vlastní refs) dostane nejdřív jen neověřené čtení.
    const afterRemount = holdLastDrawnPosition(liveChartDrawnMemory('group', NOW + 400), unknown, NOW + 400);
    expect(afterRemount.shown.summary).toMatchObject({ side: 'short', unverified: true });
    // Jiný cíl pohledu cizí paměť nepoužije.
    expect(holdLastDrawnPosition(liveChartDrawnMemory('100', NOW + 400), unknown, NOW + 400).shown).toBe(unknown);
    const hook = readFileSync('hooks/useLiveChartData.ts', 'utf8');
    expect(hook).toMatch(/holdLastDrawnPosition\(enabled \? liveChartDrawnMemory\(targetKey, now\) : null/);
    // Klíč nese skupinu (po přepnutí skupiny se nedrží cizí pozice) a vypnutý graf paměť maže.
    expect(hook).toMatch(/const targetKey = liveChartDrawnMemoryKey\(viewGroup, requested, \{ userId: input.userId, owners: coverageOwners \}\);/);
    expect(hook).toMatch(/else rememberLiveChartDrawn\(targetKey, null\);/);
    expect(hook).not.toMatch(/drawnRef/);
    resetLiveChartDrawnMemoryForTests();
  });

  it('ověřený flat se ukáže hned; držení má strop 15 s a nikdy nenahradí jinou pozici', () => {
    const memory = holdLastDrawnPosition(null, drawn(), NOW).memory;
    expect(holdLastDrawnPosition(memory, verifiedFlat, NOW + 100)).toEqual({ shown: verifiedFlat, memory: null });
    expect(holdLastDrawnPosition(memory, unknown, NOW + LIVE_CHART_HOLD_LAST_DRAWN_MS + 1).shown).toBe(unknown);
    const other = drawn({ side: 'long' });
    expect(holdLastDrawnPosition(memory, other, NOW + 100).shown).toBe(other);
    // Bez řádků účtů je držený stav stejně neověřený.
    const bare = holdLastDrawnPosition(holdLastDrawnPosition(null, drawn({ rows: [], leader: null }), NOW).memory, unknown, NOW + 500);
    expect(bare.shown.summary!.unverified).toBe(true);
  });
});

describe('DEMO 10. 11. bod 5: po stop-outu se zbylý TP nekreslí jako čekající vstup', () => {
  const stoppedOut = (link: Record<string, string>) => {
    const current = status();
    current.controller.exposure!.positions = [];
    current.controller.exposure!.orders = [{ accountId: 100, brokerOrderId: '42', symbol: 'MNQZ6', side: 'Sell', orderType: 'Limit', quantity: 1,
      filledQuantity: 0, limitPrice: 27_796.25, stopPrice: null, status: 'working', updatedAt: NOW - 1_000, ...link } as never];
    (current.controller.exposure as { streamContinuity?: unknown }).streamContinuity = [100, 200].map(id => proof(id));
    return current;
  };
  it('TP s OSO rodičem / OCO párem od workeru = noha bracketu, ne „SELL 1 LIMIT“ vstup', () => {
    for (const link of [{ parentOrderId: '41' }, { ocoId: '43' }]) {
      const { data } = projectLiveChartExposure(restFlat(), stoppedOut(link), NOW - 1_000, NOW, owners, fresh);
      expect(tradovateCopyTradeOrders(data!).find(order => order.id === 42)).toMatchObject({ bracketLeg: true });
      expect(chartLines(data!).position.summary).toBeNull();
    }
  });
  it('vazba známá jen z REST téhož příkazu se zachová i v datech workeru', () => {
    const rest = restFlat();
    rest.accounts[0].orders = [{ id: 42, contractId: 7, symbol: 'MNQZ6', timestamp: null, action: 'Sell', orderType: 'Limit', quantity: 1, price: 27_796.25,
      stopPrice: null, status: 'Working', admin: null, ocoId: null, parentId: 41, linkedId: null }];
    const { data } = projectLiveChartExposure(rest, stoppedOut({}), NOW - 1_000, NOW, owners, fresh);
    expect(data!.accounts[0].orders[0]).toMatchObject({ id: 42, parentId: 41 });
    expect(chartLines(data!).position.summary).toBeNull();
  });
  it('skutečný čekající vstup (bez vazby) se dál kreslí jako čekající', () => {
    const { data } = projectLiveChartExposure(restFlat(), stoppedOut({}), NOW - 1_000, NOW, owners, fresh);
    expect(chartLines(data!).position.summary).toMatchObject({ kind: 'pending', side: 'short' });
  });
});

describe('review Codexu a09c4176', () => {
  it('neověřený flat nese issue stale, ověřený flat ani pozice se nemění', async () => {
    const { markUnverifiedFlat } = await import('../lib/liveChartExposureProjection');
    const flat = { key: 'none', symbol: null, lines: [], summary: null, issue: null };
    const marked = markUnverifiedFlat(flat, [1, 2], new Set([1]));
    expect(marked.issueKind).toBe('stale');
    expect(marked.issue).toContain('neověřeno');
    expect(markUnverifiedFlat(flat, [1, 2], new Set([9]))).toBe(flat);
    expect(markUnverifiedFlat(flat, [1], new Set())).toBe(flat);
    const withIssue = { ...flat, issue: 'rozjeto', issueKind: 'mismatch' as const };
    expect(markUnverifiedFlat(withIssue, [1], new Set([1]))).toBe(withIssue);
  });

  it('klíč držené pozice odliší uživatele, připojení i prostředí', () => {
    const group = { id: 'g', leaderAccountId: 1, followers: [{ accountId: 2 }] };
    const owners = (env: 'demo' | 'live', conn: string) => new Map([[1, { connectionId: conn, environment: env }], [2, { connectionId: conn, environment: env }]]);
    const base = liveChartDrawnMemoryKey(group, 'group', { userId: 'u1', owners: owners('demo', 'c1') });
    expect(liveChartDrawnMemoryKey(group, 'group', { userId: 'u2', owners: owners('demo', 'c1') })).not.toBe(base);
    expect(liveChartDrawnMemoryKey(group, 'group', { userId: 'u1', owners: owners('live', 'c1') })).not.toBe(base);
    expect(liveChartDrawnMemoryKey(group, 'group', { userId: 'u1', owners: owners('demo', 'c2') })).not.toBe(base);
    expect(liveChartDrawnMemoryKey(group, 'group', { userId: 'u1', owners: owners('demo', 'c1') })).toBe(base);
  });
});

describe('kontinuita = mezistupeň autorizace (review Codexu 5e9b2aef)', () => {
  it('projekce vrací účty ověřené jen kotvou; doklad mezi ně nepatří', () => {
    const current = status();
    (current.controller.exposure as { streamContinuity?: unknown }).streamContinuity = [100, 200].map(id => ({ ...proof(id), observedAt: NOW - 500 }));
    const result = projectLiveChartExposure(restFlat(), current, NOW - 1_000, NOW, owners, fresh);
    expect(result.continuityOnly).toEqual([100, 200]);
  });

  it('značka continuityOnly: jen ověřená pozice dotčená kotvou', async () => {
    const { markLiveChartContinuityOnly } = await import('../lib/liveChartExposureProjection');
    const summary = { leader: { accountId: 100, quantity: 1, entry: 1 }, rows: [] } as never;
    const pos = { key: 'p', symbol: 'MNQZ6', lines: [], summary, issue: null };
    expect(markLiveChartContinuityOnly(pos, new Set([100])).summary?.continuityOnly).toBe(true);
    expect(markLiveChartContinuityOnly(pos, new Set([300]))).toBe(pos);
    const unverified = { ...pos, summary: { ...(summary as object), unverified: true } as never };
    expect(markLiveChartContinuityOnly(unverified, new Set([100]))).toBe(unverified);
  });
});
