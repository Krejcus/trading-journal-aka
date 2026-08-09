import { describe, expect, it } from 'vitest';
import {
  journalRunSummary,
  orderDeliberations,
  tradeJournalEvents,
  tradeManagementStats,
} from '../services/backtestOrderJournal';
import type { BacktestClosedTrade, BacktestOrderEvent } from '../services/backtestTypes';

let sequence = 0;
const event = (partial: Partial<BacktestOrderEvent>): BacktestOrderEvent => ({
  id: `event-${sequence += 1}`,
  runId: 'run',
  orderId: 'order-1',
  kind: 'created',
  instrument: 'MNQ',
  marketTime: 0,
  ...partial,
});

const trade = (partial: Partial<BacktestClosedTrade> = {}): BacktestClosedTrade => ({
  id: 'trade-1', runId: 'run', instrument: 'MNQ', direction: 'Long', quantity: 1,
  entryPrice: 100, exitPrice: 104, entryTime: 1_000, exitTime: 2_000,
  grossPnl: 8, commission: 0.74, pnl: 7.26, reason: 'take-profit',
  ...partial,
});

describe('tradeJournalEvents', () => {
  it('přibere i události objednávky, která ležela v trhu před vstupem', () => {
    const events = [
      event({ kind: 'created', marketTime: 100 }),
      event({ kind: 'stop-moved', marketTime: 400, price: 99, previousPrice: 98 }),
      event({ kind: 'filled', marketTime: 1_000 }),
      event({ kind: 'filled', marketTime: 2_000 }),
    ];
    expect(tradeJournalEvents(events, trade()).map(item => item.kind))
      .toEqual(['created', 'stop-moved', 'filled', 'filled']);
  });

  it('ignoruje jiný instrument', () => {
    const events = [
      event({ kind: 'created', marketTime: 1_200, instrument: 'NQ', orderId: 'jiny' }),
      event({ kind: 'created', marketTime: 1_200, orderId: 'muj' }),
    ];
    expect(tradeJournalEvents(events, trade())).toHaveLength(1);
  });
});

describe('tradeManagementStats', () => {
  it('rozliší utažení a povolení stopky u longu', () => {
    const events = [
      event({ kind: 'position-stop-moved', marketTime: 1_100, price: 99, previousPrice: 98 }),
      event({ kind: 'position-stop-moved', marketTime: 1_200, price: 97, previousPrice: 99 }),
    ];
    const stats = tradeManagementStats(events, trade());
    expect(stats).toMatchObject({ stopMoves: 2, stopTightened: 1, stopLoosened: 1 });
  });

  it('u shortu je utažení posun stopky dolů', () => {
    const events = [
      event({ kind: 'position-stop-moved', marketTime: 1_100, price: 101, previousPrice: 102 }),
    ];
    const stats = tradeManagementStats(events, trade({ direction: 'Short', entryPrice: 100 }));
    expect(stats).toMatchObject({ stopTightened: 1, stopLoosened: 0 });
  });

  it('pozná breakeven a označí management', () => {
    const events = [
      event({ kind: 'position-stop-moved', marketTime: 1_100, price: 100, previousPrice: 98 }),
    ];
    const stats = tradeManagementStats(events, trade());
    expect(stats.movedToBreakeven).toBe(true);
    expect(stats.label).toBe('be_runner');
  });

  it('dvě utažení dál od vstupu čte jako trailing', () => {
    const events = [
      event({ kind: 'position-stop-moved', marketTime: 1_100, price: 99, previousPrice: 98 }),
      event({ kind: 'position-stop-moved', marketTime: 1_200, price: 101, previousPrice: 99 }),
    ];
    expect(tradeManagementStats(events, trade()).label).toBe('trail');
  });

  it('bez jediného zásahu zůstává management fixní', () => {
    expect(tradeManagementStats([], trade()).label).toBe('fixed');
  });

  it('fill uvnitř okna obchodu počítá jako částečný výstup', () => {
    const events = [
      event({ kind: 'filled', marketTime: 1_000 }),
      event({ kind: 'filled', marketTime: 1_500, orderId: 'order-2' }),
      event({ kind: 'filled', marketTime: 2_000, orderId: 'order-3' }),
    ];
    expect(tradeManagementStats(events, trade()).partialExits).toBe(1);
  });
});

describe('orderDeliberations', () => {
  it('měří tržní i reálný odstup od předchozí události', () => {
    const events = [
      event({ kind: 'created', marketTime: 1_000, recordedAt: 1_700_000_000_000 }),
      event({ kind: 'filled', marketTime: 1_060, recordedAt: 1_700_000_002_000 }),
      event({ kind: 'created', marketTime: 1_300, recordedAt: 1_700_000_062_000, orderId: 'order-2' }),
    ];
    expect(orderDeliberations(events)).toEqual([
      { orderId: 'order-1', marketGapSeconds: null, wallClockSeconds: null },
      { orderId: 'order-2', marketGapSeconds: 240, wallClockSeconds: 60 },
    ]);
  });

  it('bez wall clocku vrátí jen tržní odstup', () => {
    const events = [
      event({ kind: 'filled', marketTime: 1_000 }),
      event({ kind: 'created', marketTime: 1_120, orderId: 'order-2' }),
    ];
    expect(orderDeliberations(events)[0]).toEqual({
      orderId: 'order-2', marketGapSeconds: 120, wallClockSeconds: null,
    });
  });
});

describe('journalRunSummary', () => {
  // 2026-03-02 08:00 UTC a následující dva dny.
  const day1 = Date.UTC(2026, 2, 2, 8) / 1_000;
  const day3 = Date.UTC(2026, 2, 4, 8) / 1_000;

  it('vyjmenuje dny bez jediné objednávky', () => {
    const events = [event({ kind: 'created', marketTime: day1 })];
    const summary = journalRunSummary(events, { startSeconds: day1, endSeconds: day3 }, 'Europe/Prague');
    expect(summary.tradedDays).toEqual(['2026-03-02']);
    expect(summary.noTradeDays).toEqual(['2026-03-03', '2026-03-04']);
  });

  it('spočítá podíl zrušených vstupů', () => {
    const events = [
      event({ kind: 'created', marketTime: day1 }),
      event({ kind: 'created', marketTime: day1 + 600, orderId: 'order-2' }),
      event({ kind: 'cancelled', marketTime: day1 + 900, orderId: 'order-2' }),
    ];
    const summary = journalRunSummary(events, { startSeconds: day1, endSeconds: day1 }, 'Europe/Prague');
    expect(summary).toMatchObject({ ordersCreated: 2, ordersCancelled: 1, cancelRate: 0.5 });
  });

  it('povolení stopky pozná ze strany objednávky', () => {
    const events = [
      event({ kind: 'position-stop-moved', marketTime: day1, side: 'buy', price: 97, previousPrice: 99 }),
      event({ kind: 'position-stop-moved', marketTime: day1 + 60, side: 'buy', price: 100, previousPrice: 97 }),
    ];
    const summary = journalRunSummary(events, { startSeconds: day1, endSeconds: day1 }, 'Europe/Prague');
    expect(summary).toMatchObject({ stopMoves: 2, stopLoosened: 1 });
  });
});
