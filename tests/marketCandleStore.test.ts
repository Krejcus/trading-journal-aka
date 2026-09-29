import { describe, expect, it } from 'vitest';
import {
  COMPLETE_MARGIN_MS,
  groupAdjacentPeriods,
  mergeWindow,
  parseStoreRequest,
  periodsForWindow,
  slicePeriod,
  validateProviderCandles,
  validateStoredPeriod,
} from '../supabase/functions/market-candle-store/shared';

const date = (value: string) => Date.parse(value);
const now = date('2026-09-26T12:00:00.000Z');
const candle = (time: string) => ({ time: date(time) / 1000, open: 100, high: 102, low: 99, close: 101, volume: 4 });

describe('private market candle store periods', () => {
  it('uses UTC day buckets for 1m and stable UTC month buckets for 1h', () => {
    expect(periodsForWindow('ohlcv-1m', date('2026-09-20T22:30:00Z'), date('2026-09-22T01:00:00Z')).map(p => p.key))
      .toEqual(['2026-09-20', '2026-09-21', '2026-09-22']);
    expect(periodsForWindow('ohlcv-1h', date('2026-01-20T00:00:00Z'), date('2026-04-02T00:00:00Z')).map(p => p.key))
      .toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
  });

  it('accepts only permitted contracts, schemas, and bounded windows', () => {
    const request = parseStoreRequest({ symbol: ' mnq.V.0 ', schema: 'ohlcv-1m',
      start: '2026-09-20T00:00:00.000Z', end: '2026-09-21T00:00:00.000Z' }, now);
    expect(request.symbol).toBe('MNQ.v.0');
    expect(parseStoreRequest({ symbol: 'nqz26', schema: 'ohlcv-1h',
      start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' }, now).symbol).toBe('NQZ26');
    expect(() => parseStoreRequest({ symbol: 'ES.v.0', schema: 'ohlcv-1m',
      start: '2026-09-20T00:00:00.000Z', end: '2026-09-21T00:00:00.000Z' }, now)).toThrow('invalid-request');
    expect(() => parseStoreRequest({ symbol: 'MNQ.v.0', schema: 'trades',
      start: '2026-09-20T00:00:00.000Z', end: '2026-09-21T00:00:00.000Z' }, now)).toThrow('invalid-request');
  });

  it('keeps incomplete day/month out of storage but permits a historical transient tail', () => {
    expect(COMPLETE_MARGIN_MS).toBe(25 * 60 * 60 * 1000);
    const minute = parseStoreRequest({ symbol: 'MNQ.v.0', schema: 'ohlcv-1m',
      start: '2026-09-23T00:00:00.000Z', end: '2026-09-25T11:00:00.000Z' }, now);
    expect(minute.cacheablePeriods.map(p => p.key)).toEqual(['2026-09-23', '2026-09-24']);
    expect(minute.transientPeriods.map(p => p.key)).toEqual(['2026-09-25']);
    const hourly = parseStoreRequest({ symbol: 'MNQ.v.0', schema: 'ohlcv-1h',
      start: '2026-08-01T00:00:00.000Z', end: '2026-09-25T11:00:00.000Z' }, now);
    expect(hourly.cacheablePeriods.map(p => p.key)).toEqual(['2026-08']);
    expect(hourly.transientPeriods.map(p => p.key)).toEqual(['2026-09']);
    expect(() => parseStoreRequest({ symbol: 'MNQ.v.0', schema: 'ohlcv-1m',
      start: '2026-09-25T00:00:00.000Z', end: '2026-09-25T13:00:00.000Z' }, now)).toThrow('data-not-yet-historical');
  });

  it('groups only adjacent periods and keeps provider requests below configured spans', () => {
    const days = periodsForWindow('ohlcv-1m', date('2026-09-01T00:00:00Z'), date('2026-09-16T00:00:00Z'));
    expect(groupAdjacentPeriods(days, 14).map(group => group.length)).toEqual([14, 1]);
    expect(groupAdjacentPeriods([days[0], days[2], days[3]], 14).map(group => group.length)).toEqual([1, 2]);
    const months = periodsForWindow('ohlcv-1h', date('2025-01-01T00:00:00Z'), date('2026-01-01T00:00:00Z'));
    expect(groupAdjacentPeriods(months, 300).map(group => group.length)).toEqual([9, 3]);
  });

  it('validates provider candles and stored envelopes before exposing them', () => {
    const request = parseStoreRequest({ symbol: 'MNQZ6', schema: 'ohlcv-1m',
      start: '2026-09-20T00:00:00.000Z', end: '2026-09-21T00:00:00.000Z' }, now);
    const period = request.periods[0];
    const rows = [candle('2026-09-20T00:00:00Z'), candle('2026-09-20T00:01:00Z')];
    expect(validateProviderCandles(rows, period.startMs, period.endMs)).toEqual(rows);
    expect(() => validateProviderCandles([...rows].reverse(), period.startMs, period.endMs)).toThrow('invalid-provider-candles');
    expect(() => validateProviderCandles([candle('2026-09-21T00:00:00Z')], period.startMs, period.endMs)).toThrow('invalid-provider-candles');
    const saved = { version: 1, schema: request.schema, symbol: request.symbol,
      start: new Date(period.startMs).toISOString(), end: new Date(period.endMs).toISOString(), candles: rows };
    expect(validateStoredPeriod(saved, request, period, 2).candles).toEqual(rows);
    expect(() => validateStoredPeriod({ ...saved, symbol: 'MNQ.v.0' }, request, period, 2)).toThrow('corrupt-stored-period');
    expect(() => validateStoredPeriod(saved, request, period, 3)).toThrow('corrupt-stored-period');
  });

  it('slices complete provider ranges and merges them without duplicate boundary candles', () => {
    const periods = periodsForWindow('ohlcv-1m', date('2026-09-20T00:00:00Z'), date('2026-09-22T00:00:00Z'));
    const rows = [candle('2026-09-20T23:59:00Z'), candle('2026-09-21T00:00:00Z')];
    expect(slicePeriod(rows, periods[0])).toEqual([rows[0]]);
    expect(slicePeriod(rows, periods[1])).toEqual([rows[1]]);
    expect(mergeWindow([
      { period: periods[0], candles: [rows[0]] },
      { period: periods[1], candles: rows },
    ], date('2026-09-20T00:00:00Z'), date('2026-09-22T00:00:00Z'))).toEqual(rows);
  });
});
