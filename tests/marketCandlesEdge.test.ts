import { describe, expect, it } from 'vitest';
import {
  isAllowedSymbol,
  isAllowedSchema,
  MAX_CANDLE_RECORDS,
  MAX_HTF_RANGE_MS,
  MAX_RANGE_MS,
  normalizeMarketSymbol,
  parseDatabentoOhlcvJsonl,
  parseEstimatedCost,
  providerCostError,
  shouldRetryProviderCost,
  validateEstimatedCost,
  validateRequestedRange,
} from '../supabase/functions/market-candles/shared';

describe('market-candles Edge Function helpers', () => {
  it('allows only exact and continuous NQ/MNQ symbols', () => {
    expect(isAllowedSymbol('MNQU6')).toBe(true);
    expect(isAllowedSymbol('NQZ26')).toBe(true);
    expect(isAllowedSymbol('MNQ.v.0')).toBe(true);
    expect(isAllowedSymbol('ES.v.0')).toBe(false);
    expect(isAllowedSymbol('MNQ.v.0,NQ.v.0')).toBe(false);
  });

  it('normalizes continuous symbols without changing Databento stype casing', () => {
    expect(normalizeMarketSymbol(' mnq.V.0 ')).toBe('MNQ.v.0');
    expect(normalizeMarketSymbol('nqz26')).toBe('NQZ26');
    expect(isAllowedSymbol(normalizeMarketSymbol('mnq.V.0'))).toBe(true);
  });

  it('accepts only a positive range of at most sixteen days', () => {
    expect(validateRequestedRange(1, 1 + MAX_RANGE_MS)).toBe(true);
    expect(validateRequestedRange(1, 1 + MAX_RANGE_MS + 1)).toBe(false);
    expect(validateRequestedRange(2, 1)).toBe(false);
    expect(validateRequestedRange(Number.NaN, 1)).toBe(false);
  });

  it('allows only supported OHLCV schemas and a larger bounded HTF range', () => {
    expect(isAllowedSchema('ohlcv-1m')).toBe(true);
    expect(isAllowedSchema('ohlcv-1h')).toBe(true);
    expect(isAllowedSchema('trades')).toBe(false);
    expect(validateRequestedRange(1, 1 + MAX_HTF_RANGE_MS, 'ohlcv-1h')).toBe(true);
    expect(validateRequestedRange(1, 1 + MAX_HTF_RANGE_MS + 1, 'ohlcv-1h')).toBe(false);
  });

  it('rejects invalid or over-limit provider cost estimates', () => {
    expect(validateEstimatedCost(0.18, 0.25)).toBe('allowed');
    expect(validateEstimatedCost(0.26, 0.25)).toBe('over-limit');
    expect(validateEstimatedCost(Number.NaN, 0.25)).toBe('invalid');
    expect(validateEstimatedCost(-0.01, 0.25)).toBe('invalid');
    expect(validateEstimatedCost(0.01, 0)).toBe('invalid');
  });

  it('parses numeric cost responses defensively without weakening the limit', () => {
    expect(parseEstimatedCost('0.0125\n')).toBe(0.0125);
    expect(parseEstimatedCost('{"cost_usd":0.02}')).toBe(0.02);
    expect(parseEstimatedCost('{"cost":0.03}')).toBe(0.03);
    expect(parseEstimatedCost('not-a-cost')).toBeNaN();
  });

  it('turns provider cost failures into actionable client errors', () => {
    expect(providerCostError(402)).toMatchObject({ error: 'provider-payment', status: 402 });
    expect(providerCostError(429)).toMatchObject({ error: 'provider-rate-limit', status: 429 });
    expect(providerCostError(500)).toMatchObject({ error: 'provider-cost-unavailable', status: 502 });
    expect(providerCostError(400)).toMatchObject({ error: 'provider-cost-request', status: 502 });
  });

  it('retries only transient provider cost failures', () => {
    expect(shouldRetryProviderCost(429)).toBe(true);
    expect(shouldRetryProviderCost(500)).toBe(true);
    expect(shouldRetryProviderCost(503)).toBe(true);
    expect(shouldRetryProviderCost(400)).toBe(false);
    expect(shouldRetryProviderCost(402)).toBe(false);
  });

  it('parses the documented Databento pretty JSONL shape', () => {
    const raw = [
      JSON.stringify({
        ts_event: '2026-07-30T13:30:00.000000000Z',
        hd: { rtype: 33, publisher_id: 1, instrument_id: 1234 },
        open: '23100.250000000', high: '23102.750000000', low: '23099.500000000',
        close: '23101.000000000', volume: 142, symbol: 'MNQU6',
      }),
      JSON.stringify({
        hd: { ts_event: '2026-07-30T13:31:00.000000000Z' },
        open: '23101.000000000', high: '23103.000000000', low: '23100.750000000',
        close: '23102.500000000', volume: '97', symbol: 'MNQU6',
      }),
    ].join('\n');

    expect(parseDatabentoOhlcvJsonl(raw, 'MNQ.v.0')).toEqual({
      sourceSymbol: 'MNQU6',
      malformedRecords: 0,
      truncated: false,
      candles: [
        { time: 1785418200, open: 23100.25, high: 23102.75, low: 23099.5, close: 23101, volume: 142 },
        { time: 1785418260, open: 23101, high: 23103, low: 23100.75, close: 23102.5, volume: 97 },
      ],
    });
  });

  it('supports raw nanosecond timestamps and counts invalid records', () => {
    const result = parseDatabentoOhlcvJsonl([
      '{not-json}',
      JSON.stringify({ ts_event: 1785418200000000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }),
      JSON.stringify({ ts_event: 'invalid', open: 1, high: 2, low: 0.5, close: 1.5 }),
    ].join('\n'), 'MNQ.v.0');

    expect(result.candles).toEqual([{ time: 1785418200, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }]);
    expect(result.malformedRecords).toBe(2);
  });

  it('marks a response as truncated instead of returning an incomplete chart', () => {
    const row = JSON.stringify({ ts_event: '2026-07-30T13:30:00Z', open: 1, high: 2, low: 0, close: 1, volume: 1 });
    const result = parseDatabentoOhlcvJsonl(`${row}\n${row}`, 'MNQ.v.0', 1);
    expect(result.truncated).toBe(true);
    expect(result.candles).toHaveLength(1);
    expect(MAX_CANDLE_RECORDS).toBeGreaterThan(16 * 24 * 60);
  });
});
