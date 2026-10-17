import { describe, expect, it } from 'vitest';
import { aggregateCandles, type MarketCandle } from '../services/marketData';
import { formingReplayBar, formingReplayBase } from '../services/chartReplayForming';

// Pondělí 13. 10. 2026 14:00 UTC (10:00 New York) — uprostřed session.
const START = Date.UTC(2026, 9, 13, 14, 0) / 1_000;
const minute = (index: number, close: number): MarketCandle => ({
  time: START + index * 60, open: close - 1, high: close + 2, low: close - 3, close, volume: 10,
});

describe('formingReplayBar — rozpracovaný bar plynulého replaye', () => {
  const raw = [minute(0, 100), minute(1, 101), minute(2, 102), minute(3, 103), minute(4, 104), minute(5, 105)];

  it('na 5m slije odkryté minuty intervalu s rozpracovanou', () => {
    const cursor = raw[2].time;
    const base = formingReplayBase(raw, cursor, '5m');
    const partial = { ...raw[3], high: 120, low: 90, close: 110, volume: 4 };
    const bar = formingReplayBar(base, partial, '5m');
    const expected = aggregateCandles([raw[0], raw[1], raw[2], partial], '5m')[0];
    expect(bar).toEqual(expected);
  });

  it('rozpracovaná minuta v novém intervalu založí nový bar', () => {
    const cursor = raw[4].time;
    const base = formingReplayBase(raw, cursor, '5m');
    const partial = { ...raw[5], close: 99 };
    const bar = formingReplayBar(base, partial, '5m');
    expect(bar.time).toBe(raw[5].time);
    expect(bar.open).toBe(raw[5].open);
    expect(bar.close).toBe(99);
  });

  it('na 1m není základ a bar je přímo rozpracovaná minuta', () => {
    expect(formingReplayBase(raw, raw[2].time, '1m')).toBeNull();
    const partial = { ...raw[3], close: 77 };
    expect(formingReplayBar(null, partial, '1m')).toEqual(partial);
  });
});
