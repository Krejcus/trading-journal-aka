import { describe, expect, it } from 'vitest';
import type { TradovateAccountDataAccount } from '../lib/tradovateAccountDataTypes';
import {
  accountRiskCushion,
  accountRiskFloor,
  accountRiskPeak,
  aggregateTradovateLive,
  aggregateTradovateLiveDays,
  buildTradovateLiveActivity,
  isWorkingTradovateOrder,
} from '../lib/tradovateLiveView';

const coverage = { availability: 'available' as const, count: 1, httpStatus: 200 };

const account = (): TradovateAccountDataAccount => ({
  id: 11,
  name: 'DEMO-11',
  createdAt: '2026-08-13T00:00:00.000Z',
  active: true,
  canTrade: true,
  netPositionCount: 1,
  workingOrderCount: 1,
  balance: {
    coverage,
    totalCashValue: 49_000,
    totalCashValueSOD: 50_000,
    totalPnL: -1_000,
    netLiq: 48_900,
    netLiqSOD: 50_000,
    openPnL: -100,
    realizedPnL: -900,
    weekRealizedPnL: -900,
    cashUSD: 49_000,
    cashSODUSD: 50_000,
    currencyCashAvailWithdrawalUSD: null,
    initialMargin: null,
    maintenanceMargin: null,
    fullInitialMargin: null,
    fullInitialMarginSOD: null,
    autoLiqLevel: null,
    withdrawalRejectReason: null,
  },
  activity: {
    positionCount: 1,
    netPositionCount: 1,
    workingOrderCount: 1,
    orderCount: 1,
    fillCount: 2,
    fillPairCount: 1,
    knownFees: 4.2,
    firstFillAt: '2026-08-15T08:00:00.000Z',
    lastFillAt: '2026-08-15T08:05:00.000Z',
  },
  history: { coverage, entryCount: 2, firstEntryAt: null, lastEntryAt: null, realizedBalanceDrawdown: 1_100 },
  risk: {
    statusCoverage: coverage,
    limitsCoverage: coverage,
    adminAction: null,
    maxNetLiq: null,
    minNetLiq: null,
    dailyLossAutoLiq: null,
    weeklyLossAutoLiq: null,
    trailingMaxDrawdown: null,
    trailingMaxDrawdownLimit: null,
    trailingMaxDrawdownMode: null,
    changesLocked: null,
  },
  positions: [{ id: 1, contractId: 7, symbol: 'MNQZ6', timestamp: null, tradeDate: '2026-08-15', netPosition: 1, bought: 1, boughtValue: null, sold: 0, soldValue: null, previousPosition: 0, averagePrice: 20_000, previousPrice: null }],
  orders: [{ id: 3, contractId: 7, symbol: 'MNQZ6', timestamp: '2026-08-15T08:00:00.000Z', action: 'Buy', orderType: 'Limit', quantity: 1, price: 20_000, stopPrice: null, status: 'Working', admin: false, ocoId: null, parentId: null, linkedId: null }],
  fills: [{ id: 4, orderId: 3, contractId: 7, symbol: 'MNQZ6', timestamp: '2026-08-15T08:05:00.000Z', tradeDate: '2026-08-15', action: 'Sell', quantity: 1, price: 20_050, active: true, finallyPaired: 1, fees: null }],
  fillPairs: [{ id: 5, positionId: 1, buyFillId: 2, sellFillId: 4, contractId: 7, symbol: 'MNQZ6', openedAt: '2026-08-15T08:00:00.000Z', closedAt: '2026-08-15T08:05:00.000Z', tradeDate: '2026-08-15', side: 'Long', quantity: 1, buyPrice: 20_000, sellPrice: 20_050, grossPnl: 100, knownFees: 4.2, netPnl: 95.8, active: false }],
  daily: [],
  ledger: [{ id: 6, timestamp: '2026-08-15T08:06:00.000Z', tradeDate: '2026-08-15', currencyId: 1, amount: 49_000, delta: 95.8, cashChangeType: 'TradePaired', realizedPnl: -900, weekRealizedPnl: -900, fillPairId: 5, fillId: null, comment: null }],
});

describe('tradovate LIVE view model', () => {
  it('aggregates only Tradovate account data', () => {
    expect(aggregateTradovateLive([account()])).toEqual({
      balance: 49_000,
      netLiq: 48_900,
      realizedPnl: -900,
      openPnl: -100,
      knownFees: 4.2,
      openPositionCount: 1,
      workingOrderCount: 1,
      fillCount: 2,
    });
  });

  it('derives the risk floor and cushion from a saved prop profile', () => {
    const value = account();
    const profile = { accountSize: 50_000, maxLoss: 2_000, drawdownType: 'static' } as never;
    expect(accountRiskFloor(value, profile)).toBe(48_000);
    expect(accountRiskCushion(value, profile)).toBe(900);
  });

  it('prefers the broker auto-liq floor over reconstructed risk fields', () => {
    const value = account();
    value.balance.autoLiqLevel = 49_725;
    value.risk.trailingMaxDrawdown = 2_000;
    value.risk.maxNetLiq = 51_000;
    const profile = { accountSize: 50_000, maxLoss: 2_000, drawdownType: 'eod_trailing' } as never;
    expect(accountRiskFloor(value, profile)).toBe(49_725);
    expect(accountRiskCushion(value, profile)).toBe(-825);
  });

  it('auto-liq 0 je sentinel „nenastaveno" — floor se rekonstruuje z high-watermarku', () => {
    const value = account();
    value.balance.autoLiqLevel = 0;
    value.risk.trailingMaxDrawdown = 2_000;
    value.risk.maxNetLiq = 51_000;
    const profile = { accountSize: 50_000, maxLoss: 2_000, drawdownType: 'eod_trailing' } as never;
    expect(accountRiskFloor(value, profile)).toBe(49_000);
  });

  it('trailing amount 0 je také nenastavený broker limit a použije profil', () => {
    const value = account();
    value.risk.trailingMaxDrawdown = 0;
    value.risk.maxNetLiq = 51_000;
    const profile = { accountSize: 50_000, maxLoss: 2_000, drawdownType: 'eod_trailing' } as never;
    expect(accountRiskFloor(value, profile)).toBe(49_000);
  });

  it('moves an EOD trailing floor only when a historical ending balance made a new high', () => {
    const value = account();
    value.daily = [
      { tradeDate: '2026-08-13', endingBalance: 50_350 },
      { tradeDate: '2026-08-14', endingBalance: 49_000 },
    ] as never;
    // minNetLiq is an observed low, not the prop-firm liquidation floor.
    value.risk.minNetLiq = 48_900;
    const profile = { accountSize: 50_000, maxLoss: 2_000, drawdownType: 'eod_trailing' } as never;
    expect(accountRiskPeak(value, profile)).toBe(50_350);
    expect(accountRiskFloor(value, profile)).toBe(48_350);
    expect(accountRiskCushion(value, profile)).toBe(550);
  });

  it('prefers the broker EOD high-watermark and trailing amount over reconstructed values', () => {
    const value = account();
    value.daily = [{ tradeDate: '2026-08-14', endingBalance: 50_350 }] as never;
    value.risk.maxNetLiq = 50_600;
    value.risk.trailingMaxDrawdown = 1_900;
    value.risk.trailingMaxDrawdownMode = 'EOD';
    const profile = { accountSize: 50_000, maxLoss: 2_000, drawdownType: 'eod_trailing' } as never;
    expect(accountRiskPeak(value, profile)).toBe(50_600);
    expect(accountRiskFloor(value, profile)).toBe(48_700);
    expect(accountRiskCushion(value, profile)).toBe(200);
  });

  it('stops the reconstructed floor at the broker trailing drawdown limit', () => {
    const value = account();
    value.balance.totalCashValue = 52_400;
    value.balance.netLiq = 52_450;
    value.risk.maxNetLiq = 52_600;
    value.risk.trailingMaxDrawdown = 2_000;
    value.risk.trailingMaxDrawdownLimit = 50_100;
    value.risk.trailingMaxDrawdownMode = 'EOD';

    expect(accountRiskPeak(value)).toBe(52_600);
    expect(accountRiskFloor(value)).toBe(50_100);
    expect(accountRiskCushion(value)).toBe(2_350);
  });

  it('uses the known funded plan lock when Tradovate omits its limit', () => {
    const value = account();
    value.balance.netLiq = 52_400;
    value.risk.maxNetLiq = 52_600;
    value.risk.trailingMaxDrawdown = 2_000;
    const plan = {
      propFirm: 'Tradeify', planName: 'Growth 50K', accountType: 'funded',
      accountSize: 50_000, maxLoss: 2_000, drawdownType: 'eod_trailing',
    } as const;
    const funded = plan as never;
    const evaluation = { ...plan, accountType: 'evaluation' } as never;

    expect(accountRiskFloor(value, funded)).toBe(50_100);
    expect(accountRiskCushion(value, funded)).toBe(2_300);
    expect(accountRiskFloor(value, evaluation)).toBe(50_600);
  });

  it('classifies working orders and creates chronologically sorted activity', () => {
    const value = account();
    expect(isWorkingTradovateOrder(value.orders[0])).toBe(true);
    expect(isWorkingTradovateOrder({ ...value.orders[0], status: 'Filled' })).toBe(false);
    expect(isWorkingTradovateOrder({ ...value.orders[0], status: 'Suspended' })).toBe(false);
    expect(isWorkingTradovateOrder({ ...value.orders[0], status: null })).toBe(false);
    const events = buildTradovateLiveActivity([value]);
    expect(events.map(event => event.kind)).toEqual(['cash', 'trade', 'fill', 'order']);
    expect(events[1].pnl).toBe(95.8);
  });

  it('deduplicates repeated NewSession ledger markers without collapsing other cash rows', () => {
    const value = account();
    value.ledger = [
      { ...value.ledger[0], id: 20, cashChangeType: 'NewSession', delta: 0 },
      { ...value.ledger[0], id: 21, cashChangeType: 'NewSession', delta: 0 },
      { ...value.ledger[0], id: 22, cashChangeType: 'Fee', delta: -1 },
      { ...value.ledger[0], id: 23, cashChangeType: 'Fee', delta: -1 },
    ];

    const cash = buildTradovateLiveActivity([value]).filter(event => event.kind === 'cash');
    expect(cash.filter(event => event.title === 'NewSession')).toHaveLength(1);
    expect(cash.filter(event => event.title === 'Fee')).toHaveLength(2);
  });

  it('marks SL only when the closing fill belongs to a real stop order', () => {
    const value = account();
    value.orders = [
      { ...value.orders[0], id: 10, action: 'Buy', orderType: 'Limit', status: 'Filled' },
      { ...value.orders[0], id: 11, action: 'Sell', orderType: 'Stop', price: null, stopPrice: 19_950, status: 'Filled', parentId: 10 },
    ];
    value.fills = [
      { ...value.fills[0], id: 2, orderId: 10, action: 'Buy', price: 20_000, timestamp: '2026-08-15T08:00:00.000Z' },
      { ...value.fills[0], id: 4, orderId: 11, action: 'Sell', price: 19_950, timestamp: '2026-08-15T08:05:00.000Z' },
    ];
    value.fillPairs = [{ ...value.fillPairs[0], buyFillId: 2, sellFillId: 4, buyPrice: 20_000, sellPrice: 19_950 }];

    const events = buildTradovateLiveActivity([value]);
    const trade = events.find(event => event.kind === 'trade');
    const closingFill = events.find(event => event.id === 'fill:11:4');
    expect(trade).toMatchObject({ evidence: 'broker-confirmed', orderId: 11 });
    expect(trade?.title).toContain('Stop loss');
    expect(closingFill?.semantic).toBe('stop-loss-fill');
  });

  it('marks a linked bracket limit as TP but not an unlinked limit exit', () => {
    const value = account();
    value.orders = [{ ...value.orders[0], id: 11, action: 'Sell', orderType: 'Limit', status: 'Filled', linkedId: 12 }];
    value.fills = [{ ...value.fills[0], id: 4, orderId: 11, action: 'Sell' }];
    const linked = buildTradovateLiveActivity([value]).find(event => event.kind === 'trade');
    expect(linked).toMatchObject({ evidence: 'broker-confirmed', orderId: 11 });
    expect(linked?.title).toContain('Take profit');

    value.orders[0].linkedId = null;
    const unlinked = buildTradovateLiveActivity([value]).find(event => event.kind === 'trade');
    expect(unlinked).toMatchObject({ evidence: 'fillpair-derived', orderId: 11 });
    expect(unlinked?.title).toContain('TP nepotvrzen');
  });

  it('never invents SL or TP for a Performance-report-only historical pair', () => {
    const value = account();
    value.orders = [];
    value.fills = [];
    value.fillPairs = [{ ...value.fillPairs[0], id: -55, buyFillId: 501, sellFillId: 502 }];
    const trade = buildTradovateLiveActivity([value]).find(event => event.kind === 'trade');
    expect(trade).toMatchObject({
      evidence: 'historical-limited',
      orderId: null,
      pnlLabel: 'Net P&L',
    });
    expect(trade?.title).toContain('důvod výstupu neurčen');
    expect(trade?.evidenceDetail).toContain('neobsahuje closing order');
  });

  it('labels Performance-only P&L as gross when report fees are unavailable', () => {
    const value = account();
    value.orders = [];
    value.fills = [];
    value.fillPairs = [{
      ...value.fillPairs[0],
      id: -56,
      buyFillId: 601,
      sellFillId: 602,
      netPnl: null,
      knownFees: null,
    }];

    const trade = buildTradovateLiveActivity([value]).find(event => event.kind === 'trade');
    expect(trade).toMatchObject({
      pnl: 100,
      pnlLabel: 'Gross P&L bez známých poplatků',
      evidence: 'historical-limited',
    });
  });

  it('coalesces exact Performance fill fragments into one readable lifecycle', () => {
    const value = account();
    value.orders = [];
    value.fills = [];
    value.fillPairs = [
      {
        ...value.fillPairs[0],
        id: -61,
        buyFillId: 701,
        sellFillId: 702,
        quantity: 2,
        grossPnl: 25,
        netPnl: null,
        knownFees: null,
      },
      {
        ...value.fillPairs[0],
        id: -62,
        buyFillId: 703,
        sellFillId: 704,
        quantity: 3,
        grossPnl: 37.5,
        netPnl: null,
        knownFees: null,
      },
    ];

    const trades = buildTradovateLiveActivity([value]).filter(event => event.kind === 'trade');
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ quantity: 5, pnl: 62.5, componentCount: 2 });
    expect(trades[0].detail).toContain('2 spárovaných částí');
  });

  it('aggregates daily history across accounts without inventing reported PnL', () => {
    const first = account();
    first.daily = [{ tradeDate: '2026-08-15', reportedRealizedPnl: 100, reportedWeekRealizedPnl: 100, endingBalance: 50_100, cashDelta: 95, grossTradePnl: 100, feeDelta: -5, knownFillFees: 5, fillCount: 2, pairedTradeCount: 1, ledgerEntryCount: 2 }];
    const second = account();
    second.id = 12;
    second.daily = [{ ...first.daily[0], reportedRealizedPnl: null, cashDelta: -50, grossTradePnl: -45, feeDelta: -5 }];
    expect(aggregateTradovateLiveDays([first, second])).toEqual([{ tradeDate: '2026-08-15', reportedRealizedPnl: 100, grossTradePnl: 55, feeDelta: -10, cashDelta: 45, fillCount: 4, pairedTradeCount: 2 }]);
  });
});
