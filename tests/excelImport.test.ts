import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import Papa from 'papaparse';
import { formatExcelCell, isLegacyXlsFile, LEGACY_XLS_MESSAGE } from '../services/excelImport';
import { parseTradovateFills } from '../services/tradovateImport';

describe('Excel import compatibility', () => {
  it('odmítá starý binární .xls, ale přijímá .xlsx bez ohledu na velikost písmen', () => {
    expect(isLegacyXlsFile('orders.xls')).toBe(true);
    expect(isLegacyXlsFile('ORDERS.XLS')).toBe(true);
    expect(isLegacyXlsFile('orders.xlsx')).toBe(false);
    expect(LEGACY_XLS_MESSAGE).toContain('ulož ho jako .xlsx');
  });

  it('normalizuje typované buňky na stringy a zachová excelový wall-clock čas', () => {
    expect(formatExcelCell(29461.75)).toBe('29461.75');
    expect(formatExcelCell(true)).toBe('true');
    expect(formatExcelCell(null)).toBe('');
    expect(formatExcelCell(new Date(Date.UTC(2026, 6, 16, 16, 40, 5))))
      .toBe('2026-07-16 16:40:05');
  });

  it('dává Tradovate parseru stejný výsledek pro původní stringy a typované Excel hodnoty', () => {
    const baseRows = [
      { Symbol: 'MNQU6', Side: 'Buy', 'Filled Qty': '2', Status: 'Filled', Timestamp: '2026-07-16 16:40:00', 'Avg Price': '29461.75', 'Order ID': 'entry' },
      { Symbol: 'MNQU6', Side: 'Sell', 'Filled Qty': '2', Status: 'Filled', Timestamp: '2026-07-16 16:56:00', 'Avg Price': '29397.50', 'Order ID': 'exit' },
    ];
    const typedRows = baseRows.map((row, index) => ({
      ...row,
      'Filled Qty': 2,
      Timestamp: new Date(Date.UTC(2026, 6, 16, 16, index === 0 ? 40 : 56, 0)),
      'Avg Price': index === 0 ? 29461.75 : 29397.5,
    })).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, formatExcelCell(value)])));

    const fromStrings = parseTradovateFills(baseRows, 'account-1');
    const fromTypedExcel = parseTradovateFills(typedRows, 'account-1');
    expect(fromTypedExcel.trades).toHaveLength(fromStrings.trades.length);
    expect(fromTypedExcel.trades[0]?.entryPrice).toBe(fromStrings.trades[0]?.entryPrice);
    expect(fromTypedExcel.trades[0]?.exitPrice).toBe(fromStrings.trades[0]?.exitPrice);
    expect(fromTypedExcel.trades[0]?.entryTime).toBe(fromStrings.trades[0]?.entryTime);
    expect(fromTypedExcel.trades[0]?.timestamp).toBe(fromStrings.trades[0]?.timestamp);
  });

  it('zachová výsledky na skutečném Tradovate export fixture po Excel type round-trip', () => {
    const csv = readFileSync(new URL('../sample-tradovate-export.csv', import.meta.url), 'utf8');
    const originalRows = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true }).data;
    const typedRoundTrip = originalRows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
      if (key === 'avgPrice' || key === 'filledQty') return [key, formatExcelCell(Number(value))];
      if (key === 'Fill Time') return [key, formatExcelCell(new Date(`${value} UTC`))];
      return [key, formatExcelCell(value)];
    })));

    const expected = parseTradovateFills(originalRows, 'fixture-account').trades;
    const actual = parseTradovateFills(typedRoundTrip, 'fixture-account').trades;
    expect(actual.map(trade => ({
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      entryTime: trade.entryTime,
      timestamp: trade.timestamp,
      pnl: trade.pnl,
    }))).toEqual(expected.map(trade => ({
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      entryTime: trade.entryTime,
      timestamp: trade.timestamp,
      pnl: trade.pnl,
    })));
  });
});
