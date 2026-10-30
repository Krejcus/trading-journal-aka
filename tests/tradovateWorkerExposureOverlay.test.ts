import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import type { TradovateAccountDataAccount, TradovateAccountDataResult } from '../lib/tradovateAccountDataTypes';
import {
  WORKER_POSITION_DIVERGENT_DETAIL, WORKER_POSITION_MISMATCH_DETAIL, WORKER_POSITION_UNKNOWN_DETAIL, overlayWorkerExposure, WORKER_EXPOSURE_MAX_AGE_MS,
} from '../lib/tradovateWorkerExposureOverlay';
import { tradovateCopyTradeOrders, tradovateCopyTradeSnapshot } from '../lib/tradovateCopyTradeBridge';
import { buildTradeCard } from '../lib/liveTradeCard';
import { liveChartPosition } from '../lib/liveChartPosition';
import { liveBreakEven, liveLineMoveBlockReason } from '../lib/liveChartOrderLines';

const NOW = Date.UTC(2026, 8, 18, 9, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const coverage = (count: number) => ({ availability: count > 0 ? 'available' as const : 'empty' as const, count, httpStatus: 200 });
const account = (id: number, extras: Partial<TradovateAccountDataAccount> = {}): TradovateAccountDataAccount => ({
  id, name: `A${id}`, createdAt: null, active: true, canTrade: true, netPositionCount: 0, workingOrderCount: 0,
  readState: { positions: coverage(0), orders: coverage(0), positionsAsOf: iso(NOW - 600_000), ordersAsOf: iso(NOW - 600_000), cashAsOf: null, requestedAt: iso(NOW - 600_000) },
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
const data = (): TradovateAccountDataResult => ({
  capturedAt: iso(NOW - 600_000), requestedAt: iso(NOW - 600_000),
  accounts: [
    account(100, { positions: [{ id: 1, contractId: 7, symbol: 'MNQZ6', timestamp: null, tradeDate: null, netPosition: -7, bought: null, boughtValue: null, sold: null, soldValue: null, previousPosition: null, averagePrice: 29_730.75, previousPrice: null }], netPositionCount: 1 }),
    account(200, { orders: [{ id: 5, contractId: 7, symbol: 'MNQZ6', timestamp: null, action: 'Buy', orderType: 'Stop', quantity: 7, price: null, stopPrice: 29_748.25, status: 'Working', admin: null, ocoId: null, parentId: null, linkedId: null }], workingOrderCount: 1 }),
    account(300, { positions: [{ id: 2, contractId: 7, symbol: 'MNQZ6', timestamp: null, tradeDate: null, netPosition: 3, bought: null, boughtValue: null, sold: null, soldValue: null, previousPosition: null, averagePrice: 1, previousPrice: null }] }),
  ],
  contracts: [{ id: 7, name: 'MNQZ6', contractMaturityId: null, timestamp: null }],
  coverage: { accounts: coverage(3), positions: coverage(2), orders: coverage(1), fills: coverage(0), fillPairs: coverage(0), fillFees: coverage(0), contracts: coverage(1) },
});
const status = (extras: Partial<LocalCopierAgentStatus['controller']> = {}, exposureExtras: Record<string, unknown> = {}): LocalCopierAgentStatus => ({
  version: 1, environment: 'demo', nonce: 'n', startedAt: iso(NOW - 3_600_000),
  group: { id: 'g', name: 'G', enabled: true, leaderAccountId: 100, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }] },
  controller: {
    started: true, armed: true, killSwitch: false, shadowMode: false, connected: true, reconciliationRequired: false,
    divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false, stuckOperations: [], lastError: null, revision: 1, lastSequence: 1,
    exposure: {
      verifiedAt: NOW - 1_000,
      positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: -7 }, { accountId: 200, symbol: 'MNQZ6', netQuantity: -7 }],
      followers: [{ accountId: 200, ok: true, detail: null }],
      orders: [{ accountId: 200, brokerOrderId: '663908070136', symbol: 'MNQZ6', side: 'Buy', orderType: 'Stop', quantity: 7, filledQuantity: 0, limitPrice: null, stopPrice: 29_748.25, status: 'working', updatedAt: NOW - 2_000 }],
      ...exposureExtras,
    },
    ...extras,
  },
} as unknown as LocalCopierAgentStatus);

describe('worker exposure overlay', () => {
  it('replaces positions and orders of group accounts with the fresh heartbeat and stamps the heartbeat time', () => {
    const out = overlayWorkerExposure(data(), status(), NOW - 1_500, NOW)!;
    const follower = out.accounts.find(a => a.id === 200)!;
    expect(follower.positions).toEqual([expect.objectContaining({ symbol: 'MNQZ6', netPosition: -7, contractId: 7, timestamp: iso(NOW - 1_500) })]);
    expect(follower.orders).toEqual([expect.objectContaining({ id: 663908070136, action: 'Buy', orderType: 'Stop', stopPrice: 29_748.25, status: 'Working', contractId: 7 })]);
    expect(follower.netPositionCount).toBe(1);
    expect(follower.workingOrderCount).toBe(1);
    expect(follower.readState).toMatchObject({ positionsAsOf: iso(NOW - 1_500), ordersAsOf: iso(NOW - 1_500),
      positions: { availability: 'available', count: 1 }, orders: { availability: 'available', count: 1 } });
    const leader = out.accounts.find(a => a.id === 100)!;
    expect(leader.positions[0]).toMatchObject({ netPosition: -7, averagePrice: 29_730.75 });
    expect(leader.orders).toEqual([]);
    expect(leader.readState?.orders).toMatchObject({ availability: 'empty', count: 0 });
    expect(leader.balance.totalCashValue).toBe(50_000);
  });
  it('leaves accounts outside the copy group untouched', () => {
    const before = data();
    const out = overlayWorkerExposure(before, status(), NOW - 1_000, NOW)!;
    expect(out.accounts.find(a => a.id === 300)).toBe(before.accounts[2]);
  });
  it.each([
    ['stale heartbeat', status(), NOW - WORKER_EXPOSURE_MAX_AGE_MS - 1],
    ['future heartbeat', status(), NOW + 10_000],
    ['no observation time', status(), null],
    ['stream disconnected', status({ connected: false }), NOW - 1_000],
    ['no exposure block', status({ exposure: null }), NOW - 1_000],
    ['no status at all', null, NOW - 1_000],
  ])('returns the REST data unchanged for %s', (_label, current, observedAt) => {
    const before = data();
    expect(overlayWorkerExposure(before, current, observedAt, NOW)).toBe(before);
  });
  it('keeps REST orders when the worker heartbeat predates the orders field', () => {
    const out = overlayWorkerExposure(data(), status({}, { orders: undefined }), NOW - 1_000, NOW)!;
    const follower = out.accounts.find(a => a.id === 200)!;
    expect(follower.orders).toHaveLength(1);
    expect(follower.orders[0].id).toBe(5);
    expect(follower.readState?.ordersAsOf).toBe(iso(NOW - 600_000));
    expect(follower.readState?.positionsAsOf).toBe(iso(NOW - 1_000));
  });
  it('a flat account from the worker becomes an explicit empty read, never a stale position', () => {
    const out = overlayWorkerExposure(data(), status({}, { positions: [] }), NOW - 1_000, NOW)!;
    const leader = out.accounts.find(a => a.id === 100)!;
    expect(leader.positions).toEqual([]);
    expect(leader.readState).toMatchObject({ positions: { availability: 'empty', count: 0 }, positionsAsOf: iso(NOW - 1_000) });
  });

  it('otočení nebo změna velikosti pozice nenese starou průměrnou cenu (čára vstupu by stála jinde)', () => {
    const flipped = overlayWorkerExposure(data(), status({}, {
      positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: 7 }, { accountId: 200, symbol: 'MNQZ6', netQuantity: 7 }],
    }), NOW - 1_000, NOW)!;
    expect(flipped.accounts.find(item => item.id === 100)!.positions[0]).toMatchObject({ netPosition: 7, averagePrice: null });
    const added = overlayWorkerExposure(data(), status({}, {
      positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: -9 }, { accountId: 200, symbol: 'MNQZ6', netQuantity: -7 }],
    }), NOW - 1_000, NOW)!;
    expect(added.accounts.find(item => item.id === 100)!.positions[0]).toMatchObject({ netPosition: -9, averagePrice: null });
  });

  it('čerstvý vstup: REST pozici ještě nezná → průměr z fillů workeru a P&L karta neukáže (30. 10.)', () => {
    const before = data();
    before.accounts[0] = { ...before.accounts[0], positions: [], netPositionCount: 0 };
    const out = overlayWorkerExposure(before, status({}, {
      positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: 2, avgPrice: 28_768.5 }, { accountId: 200, symbol: 'MNQZ6', netQuantity: 2, avgPrice: 28_769 }],
    }), NOW - 1_000, NOW)!;
    const leader = out.accounts.find(item => item.id === 100)!;
    expect(leader.positions[0]).toMatchObject({ netPosition: 2, averagePrice: 28_768.5 });
    expect(leader.balance.openPnlBehindPosition).toBe(true);
    // Zdroj P&L pro ostatní (denní limit účtu) zůstává.
    expect(leader.balance.openPnlSource).toBeUndefined();
    expect(out.accounts.find(item => item.id === 200)!.positions[0]).toMatchObject({ averagePrice: 28_769 });
    const snapshot = tradovateCopyTradeSnapshot(out, []);
    const card = buildTradeCard([
      { account: snapshot.accounts.find(item => item.id === 100), accountId: 100, name: 'L', isLeader: true },
    ], tradovateCopyTradeOrders(out), new Map(), NOW);
    expect(card).toMatchObject({ kind: 'position', entry: 28_768.5, openPnl: null, mark: null });
  });

  it('tutéž pozici zná REST → jeho průměr i P&L platí, průměr workeru se nepoužije', () => {
    const out = overlayWorkerExposure(data(), status({}, {
      positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: -7, avgPrice: 1 }, { accountId: 200, symbol: 'MNQZ6', netQuantity: -7 }],
    }), NOW - 1_000, NOW)!;
    const leader = out.accounts.find(item => item.id === 100)!;
    expect(leader.positions[0]).toMatchObject({ averagePrice: 29_730.75 });
    expect(leader.balance.openPnlBehindPosition).toBeUndefined();
  });

  it('přikoupení a otočení: průměr workeru, P&L pozadu; částečné zavření bez průměru workeru = neznámo', () => {
    const added = overlayWorkerExposure(data(), status({}, {
      positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: -9, avgPrice: 29_731.5 }, { accountId: 200, symbol: 'MNQZ6', netQuantity: -7 }],
    }), NOW - 1_000, NOW)!.accounts.find(item => item.id === 100)!;
    expect(added.positions[0]).toMatchObject({ netPosition: -9, averagePrice: 29_731.5 });
    expect(added.balance.openPnlBehindPosition).toBe(true);
    const flipped = overlayWorkerExposure(data(), status({}, {
      positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: 2, avgPrice: 29_700 }, { accountId: 200, symbol: 'MNQZ6', netQuantity: 2 }],
    }), NOW - 1_000, NOW)!.accounts.find(item => item.id === 100)!;
    expect(flipped.positions[0]).toMatchObject({ netPosition: 2, averagePrice: 29_700 });
    expect(flipped.balance.openPnlBehindPosition).toBe(true);
    const reduced = overlayWorkerExposure(data(), status({}, {
      positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: -3 }, { accountId: 200, symbol: 'MNQZ6', netQuantity: -3 }],
    }), NOW - 1_000, NOW)!.accounts.find(item => item.id === 100)!;
    expect(reduced.positions[0]).toMatchObject({ netPosition: -3, averagePrice: null });
    expect(reduced.balance.openPnlBehindPosition).toBe(true);
  });

  it('REST drží symbol, o kterém worker neví (nebo řádek bez symbolu) → P&L pozadu', () => {
    const flat = overlayWorkerExposure(data(), status({}, { positions: [{ accountId: 200, symbol: 'MNQZ6', netQuantity: 0 }] }), NOW - 1_000, NOW)!;
    expect(flat.accounts.find(item => item.id === 100)!.balance.openPnlBehindPosition).toBe(true);
    const before = data();
    before.accounts[0] = { ...before.accounts[0], positions: [{ ...before.accounts[0].positions[0], symbol: null }] };
    const unnamed = overlayWorkerExposure(before, status(), NOW - 1_000, NOW)!;
    expect(unnamed.accounts.find(item => item.id === 100)!.balance.openPnlBehindPosition).toBe(true);
  });

  it('karta s P&L pozadu: utažení SL k trhu i BE blokované, posun od trhu smí', () => {
    const before = data();
    before.accounts[0] = { ...before.accounts[0], positions: [], netPositionCount: 0,
      orders: [{ id: 9, contractId: 7, symbol: 'MNQZ6', timestamp: null, action: 'Sell', orderType: 'Stop', quantity: 2, price: null, stopPrice: 28_740, status: 'Working', admin: null, ocoId: null, parentId: null, linkedId: null }] };
    const out = overlayWorkerExposure(before, status({}, {
      positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: 2, avgPrice: 28_768.5 }],
      orders: [{ accountId: 100, brokerOrderId: '9', symbol: 'MNQZ6', side: 'Sell', orderType: 'Stop', quantity: 2, filledQuantity: 0, limitPrice: null, stopPrice: 28_740, status: 'working', updatedAt: NOW - 2_000 }],
    }), NOW - 1_000, NOW)!;
    const snapshot = tradovateCopyTradeSnapshot(out, []);
    const card = buildTradeCard([{ account: snapshot.accounts.find(item => item.id === 100), accountId: 100, name: 'L', isLeader: true }],
      tradovateCopyTradeOrders(out), new Map(), NOW)!;
    const summary = liveChartPosition({ model: card, options: [], target: 100, verified: true, issue: null, readAgeMs: 0,
      divergenceCandidate: false, copierOff: false, scopeLabel: null }, 100).summary!;
    expect(summary).toMatchObject({ kind: 'position', entry: 28_768.5, stop: 28_740, mark: null });
    expect(liveLineMoveBlockReason(summary, 'stopLoss', 28_750)).toContain('není známá');
    expect(liveLineMoveBlockReason(summary, 'stopLoss', 28_730)).toBeNull();
    expect(liveBreakEven(summary, 28_768.5).blocked).toContain('není známá');
  });

  it.each([0, -5, Number.NaN, '28768'])('neplatný průměr workeru (%s) = neznámý vstup', avgPrice => {
    const out = overlayWorkerExposure(data(), status({}, {
      positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: 3, avgPrice }, { accountId: 200, symbol: 'MNQZ6', netQuantity: 3 }],
    }), NOW - 1_000, NOW)!;
    expect(out.accounts.find(item => item.id === 100)!.positions[0]).toMatchObject({ netPosition: 3, averagePrice: null });
  });

  it('follower, jehož pozici worker nezná, není ověřeně flat — zůstane mu REST čtení', () => {
    const rest = data();
    const result = overlayWorkerExposure(rest, status({}, {
      positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: -7 }],
      followers: [{ accountId: 200, ok: false, detail: WORKER_POSITION_UNKNOWN_DETAIL }],
    }), NOW - 1_000, NOW)!;
    expect(result.accounts.find(item => item.id === 200)).toBe(rest.accounts.find(item => item.id === 200));
  });

  it('follower bez prokazatelně známé pozice (zlikvidovaný, denní limit, příkazy mimo kopii, vypnutý režim) zůstane na REST', () => {
    for (const verdict of [
      { ok: false, detail: 'účet zlikvidován propkou' },
      { ok: false, detail: 'denní limit účtu' },
      { ok: false, detail: 'aktivní příkazy mimo kopii' },
      { ok: false, detail: 'vypnutý follower není flat' },
      { ok: true, detail: 'vypnutý follower' },
      // Rozjetí čekající na reconcile vzniká před čtením pozice followera.
      { ok: false, detail: WORKER_POSITION_DIVERGENT_DETAIL },
    ]) {
      const rest = data();
      const result = overlayWorkerExposure(rest, status({}, {
        positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: -7 }],
        followers: [{ accountId: 200, ...verdict }],
      }), NOW - 1_000, NOW)!;
      expect(result.accounts.find(item => item.id === 200), verdict.detail).toBe(rest.accounts.find(item => item.id === 200));
    }
    // Starší worker bez verdiktů followerů: bez záznamu pozice taky REST.
    const rest = data();
    const legacy = overlayWorkerExposure(rest, status({}, { positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: -7 }], followers: undefined }), NOW - 1_000, NOW)!;
    expect(legacy.accounts.find(item => item.id === 200)).toBe(rest.accounts.find(item => item.id === 200));
  });

  it('follower se známou pozicí (OK po porovnání, rozdíl kusů) se překryje — i flat', () => {
    for (const verdict of [
      { ok: true, detail: null },
      { ok: true, detail: 'ručně zavřen — čeká na další obchod' },
      { ok: false, detail: 'MNQZ6: drží 0, očekáváno -7' },
    ]) {
      const result = overlayWorkerExposure(data(), status({}, {
        positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: -7 }],
        followers: [{ accountId: 200, ...verdict }],
      }), NOW - 1_000, NOW)!;
      const follower = result.accounts.find(item => item.id === 200)!;
      expect(follower.positions, String(verdict.detail)).toEqual([]);
      expect(follower.readState.positionsAsOf).toBe(iso(NOW - 1_000));
    }
  });

  it('každý OK verdikt followera ve workeru před kontrolou pozice je jeden ze známých (jinak by znamenal „ověřeně flat“)', () => {
    const worker = readFileSync(join(__dirname, '..', 'services/copierRuntimeController.ts'), 'utf8');
    const start = worker.indexOf('const followers = group.followers.map(follower => {');
    const heldCheck = worker.indexOf("if (!held) return { accountId: id, ok: false, detail: 'pozice neověřena' };", start);
    expect(start).toBeGreaterThan(0);
    expect(heldCheck).toBeGreaterThan(start);
    const beforeHeld = worker.slice(start, heldCheck);
    const okDetails = [...beforeHeld.matchAll(/ok: true, detail: '([^']*)'/g)].map(match => match[1]).sort();
    // „vyřazen“ a „ručně vypnutý“ vyžadují held != null; „vypnutý follower“ (režim off) overlay vynechá.
    expect(okDetails).toEqual(['ručně vypnutý follower', 'vypnutý follower', 'vyřazen — vlastní pozice, kopírka ji neřídí'].sort());
    expect(beforeHeld.match(/ok: true\b/g)).toHaveLength(3);
  });

  it('texty verdiktů followera jsou přesně ty, které posílá worker', () => {
    const worker = readFileSync(join(__dirname, '..', 'services/copierRuntimeController.ts'), 'utf8');
    expect(worker).toContain(`detail: '${WORKER_POSITION_UNKNOWN_DETAIL}'`);
    expect(worker).toContain(`detail: '${WORKER_POSITION_DIVERGENT_DETAIL}'`);
    expect(worker).toContain("detail: 'vypnutý follower' }");
    expect(worker).toContain('detail: `${symbol}: drží ${actual}, očekáváno ${expected}`');
    expect(WORKER_POSITION_MISMATCH_DETAIL.test('MNQZ6: drží -2, očekáváno 0')).toBe(true);
  });
});
