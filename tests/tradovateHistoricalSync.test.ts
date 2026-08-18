import { describe, expect, it } from 'vitest';
import type { TradovateAccountDataAccount } from '../lib/tradovateAccountDataTypes';
import { mergeTradovateHistoricalSnapshot } from '../lib/tradovateHistoricalMerge';
import type { TradovateHistorySnapshot } from '../lib/tradovateHistoricalTypes';
import {
  isTradovateRangeTooLongDiagnostic,
  normalizeTradovatePerformanceRows,
  resolveTradovateHistoryWindow,
  splitTradovateHistoryRange,
} from '../server/tradovateHistoricalSync';

describe('Tradovate historical backfill', () => {
  it('použije přesný broker timestamp a jinak jen posledních 12 měsíců', () => {
    expect(resolveTradovateHistoryWindow({
      endDate: '2026-08-15',
      accountCreatedAt: '2026-08-13T19:45:00.000Z',
    })).toEqual({
      startDate: '2026-08-13',
      accountCreatedAt: '2026-08-13T19:45:00.000Z',
      basis: 'account_created_at',
    });
    expect(resolveTradovateHistoryWindow({ endDate: '2026-08-15' })).toEqual({
      startDate: '2025-08-15',
      accountCreatedAt: null,
      basis: 'rolling_12_months',
    });
  });

  it('normalizuje živý Performance tvar a zachová původní řádek', () => {
    const [trade] = normalizeTradovatePerformanceRows([
      'symbol', 'buyFillId', 'sellFillId', 'qty', 'buyPrice', 'sellPrice', 'pnl', 'boughtTimestamp', 'soldTimestamp',
    ], [[
      'MNQU6', '101', '102', '7', '$29,861.50', '$29,862.25', '($10.50)', '08/13/2026 02:35:00 AM', '08/13/2026 02:36:00 AM',
    ]]);

    expect(trade).toMatchObject({
      symbol: 'MNQU6',
      buyFillId: 101,
      sellFillId: 102,
      quantity: 7,
      buyPrice: 29_861.5,
      sellPrice: 29_862.25,
      grossPnl: -10.5,
      boughtAt: '2026-08-13T07:35:00.000Z',
      soldAt: '2026-08-13T07:36:00.000Z',
      tradeDate: '2026-08-13',
    });
    expect(trade.sourceKey).toHaveLength(64);
    expect(trade.rawRow.symbol).toBe('MNQU6');
  });

  it('vytváří stabilní deduplikační klíč i při opakovaném reportu', () => {
    const columns = ['symbol', 'buyFillId', 'sellFillId', 'qty'];
    const first = normalizeTradovatePerformanceRows(columns, [['MNQU6', '1', '2', '3']])[0];
    const second = normalizeTradovatePerformanceRows(columns, [['MNQU6', '1', '2', '3']])[0];
    expect(second.sourceKey).toBe(first.sourceKey);
  });

  it('zachová záporné P&L pro oba měnové formáty Tradovate', () => {
    const columns = ['symbol', 'buyFillId', 'sellFillId', 'pnl'];
    const [minusBeforeCurrency, minusAfterCurrency] = normalizeTradovatePerformanceRows(columns, [
      ['MNQU6', '1', '2', '-$783.00'],
      ['MNQU6', '3', '4', '$-783.00'],
    ]);
    expect(minusBeforeCurrency.grossPnl).toBe(-783);
    expect(minusAfterCurrency.grossPnl).toBe(-783);
  });

  it('doplní ekonomické znaménko, když Performance vrátí jen velikost P&L', () => {
    const [shortLoss, longProfit] = normalizeTradovatePerformanceRows(
      ['symbol', 'buyFillId', 'sellFillId', 'buyPrice', 'sellPrice', 'pnl'],
      [
        ['MNQU6', '1', '2', '30198.25', '30184.75', '783.00'],
        ['MNQU6', '3', '4', '30184.75', '30198.25', '783.00'],
      ],
    );
    expect(shortLoss.grossPnl).toBe(-783);
    expect(longProfit.grossPnl).toBe(783);
  });

  it('půlí velký rozsah bez překryvu a bez vynechaného dne', () => {
    expect(splitTradovateHistoryRange({ startDate: '2010-01-01', endDate: '2026-08-15' })).toEqual([
      { startDate: '2010-01-01', endDate: '2018-04-24' },
      { startDate: '2018-04-25', endDate: '2026-08-15' },
    ]);
    expect(splitTradovateHistoryRange({ startDate: '2026-08-15', endDate: '2026-08-15' })).toBeNull();
  });

  it('rozpozná živou Tradovate odpověď pro příliš dlouhý report', () => {
    expect(isTradovateRangeTooLongDiagnostic('Too long range')).toBe(true);
    expect(isTradovateRangeTooLongDiagnostic('Range is too long')).toBe(true);
    expect(isTradovateRangeTooLongDiagnostic('Unauthorized')).toBe(false);
    expect(isTradovateRangeTooLongDiagnostic(null)).toBe(false);
  });

  it('doplní starší obchody do účtu a neduplikuje aktuální fill pair', () => {
    const account = {
      id: 11,
      name: 'TDFYG11',
      activity: { fillPairCount: 1, firstFillAt: '2026-08-15T10:00:00.000Z', lastFillAt: '2026-08-15T10:05:00.000Z' },
      history: { coverage: { availability: 'partial', count: 1, httpStatus: 200 }, entryCount: 1, firstEntryAt: null, lastEntryAt: null },
      fillPairs: [{ buyFillId: 1, sellFillId: 2, closedAt: '2026-08-15T10:05:00.000Z' }],
      daily: [],
    } as TradovateAccountDataAccount;
    const snapshot = {
      sync: {
        syncId: 'sync-1', accountId: 11, accountName: 'TDFYG11', status: 'complete',
        accountCreatedAt: '2026-08-13T00:00:00.000Z', historyStartBasis: 'account_created_at',
        requestedStart: '2010-01-01', requestedEnd: '2026-08-15', pendingRangeCount: 0,
        rowsSeen: 2, rowsImported: 2, syncedThrough: '2026-08-15', lastError: null, completedAt: '2026-08-15T12:00:00.000Z',
      },
      trades: [
        { sourceKey: 'a'.repeat(64), symbol: 'MNQU6', buyFillId: 1, sellFillId: 2, quantity: 1, buyPrice: 100, sellPrice: 101, grossPnl: 2, boughtAt: '2026-08-15T10:00:00.000Z', soldAt: '2026-08-15T10:05:00.000Z', tradeDate: '2026-08-15', rawRow: {} },
        { sourceKey: 'b'.repeat(64), symbol: 'MNQU6', buyFillId: 3, sellFillId: 4, quantity: 2, buyPrice: 90, sellPrice: 95, grossPnl: 20, boughtAt: '2026-08-13T08:00:00.000Z', soldAt: '2026-08-13T08:05:00.000Z', tradeDate: '2026-08-13', rawRow: {} },
      ],
    } satisfies TradovateHistorySnapshot;

    const merged = mergeTradovateHistoricalSnapshot(account, snapshot);
    expect(merged.fillPairs).toHaveLength(2);
    expect(merged.daily).toMatchObject([{ tradeDate: '2026-08-13', grossTradePnl: 20, pairedTradeCount: 1 }]);
    expect(merged.historicalBackfill).toMatchObject({ status: 'complete', tradeCount: 2 });
  });

  it('opraví znaménko už uloženého historického short obchodu i v client merge', () => {
    const value = {
      id: 11,
      name: 'TDFYG11',
      activity: { fillPairCount: 0, firstFillAt: null, lastFillAt: null },
      history: { coverage: { availability: 'empty', count: 0, httpStatus: 200 }, entryCount: 0, firstEntryAt: null, lastEntryAt: null },
      fillPairs: [],
      daily: [],
    } as unknown as TradovateAccountDataAccount;
    const snapshot = {
      sync: null,
      trades: [{
        sourceKey: 'c'.repeat(64), symbol: 'MNQU6', buyFillId: 1, sellFillId: 2,
        quantity: 29, buyPrice: 30_198.25, sellPrice: 30_184.75, grossPnl: 783,
        boughtAt: '2026-08-14T09:44:20.000Z', soldAt: '2026-08-14T09:32:00.000Z',
        tradeDate: '2026-08-14', rawRow: {},
      }],
    } satisfies TradovateHistorySnapshot;
    const merged = mergeTradovateHistoricalSnapshot(value, snapshot);
    expect(merged.fillPairs[0]).toMatchObject({ side: 'Short', grossPnl: -783 });
  });
});
