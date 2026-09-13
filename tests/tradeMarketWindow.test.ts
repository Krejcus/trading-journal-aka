import { describe, expect, it } from 'vitest';
import { marketDataWindowForEntry, marketDataWindowForTrade } from '../services/marketDataCalculations';
import { formatSharedPnL } from '../utils/formatPnL';

describe('complete execution candle window', () => {
  it('reuses the existing daily window for intraday trades', () => {
    const entry = Date.parse('2026-09-10T13:30:12.123Z');
    expect(marketDataWindowForTrade(entry, entry + 60_000)).toEqual(marketDataWindowForEntry(entry));
  });
  it('includes the actual exit when a trade crosses Prague midnight', () => {
    const entry = Date.parse('2026-09-10T21:59:59.999Z'), exit = Date.parse('2026-09-11T01:00:00.123Z');
    const range = marketDataWindowForTrade(entry, exit);
    expect(range.start).toEqual(marketDataWindowForEntry(entry).start);
    expect(range.end.toISOString()).toBe('2026-09-11T22:00:00.000Z');
    expect(exit).toBeLessThan(range.end.getTime());
  });
  it('keeps the DST exit day and all intervening days', () => {
    const entry = Date.parse('2026-10-24T20:00:00Z'), exit = Date.parse('2026-10-25T22:59:59.999Z');
    expect(marketDataWindowForTrade(entry, exit).end.toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });
  it.each([[NaN, 1], [1, Infinity], [2, 1], [1, 1e20]])('rejects invalid chronology (%s, %s)', (entry, exit) => {
    expect(() => marketDataWindowForTrade(entry, exit)).toThrow();
  });
});

describe('already converted connection results', () => {
  it('keeps each shared equity point and day extreme in its source unit', () => {
    expect([1.5, -0.5, 3].map(value => formatSharedPnL(value, 'rr', 'CZK', { CZK: 23 })))
      .toEqual(['+1.50R', '-0.50R', '+3R']);
    expect(formatSharedPnL(3, 'usd', 'CZK', { CZK: 23 })).toContain('69');
    expect(formatSharedPnL(0, 'rr')).toBe('0R');
  });
  it('never turns hidden or unavailable shared results into numbers', () => {
    expect(formatSharedPnL(3, 'hidden')).toBe('—');
    expect(formatSharedPnL(NaN, 'rr')).toBe('—');
  });
});
