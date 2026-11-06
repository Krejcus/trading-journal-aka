import { describe, expect, it } from 'vitest';
import { updateVerifiedFvg, updateVerifiedStructure } from '../services/verifiedChartIndicators';
import { findFairValueGaps, calculateMarketStructure, type MarketCandle } from '../services/marketDataCalculations';
const data = (): MarketCandle[] => Array.from({ length: 1500 }, (_, i) => { const p = 20000 + (i % 40) * 4; return { time: 1700000040 + i * 60, open: p, close: p + 2, high: p + 3, low: p - 1, volume: i + 10 }; });
describe('verified incremental historical FVG', () => {
  it('rebuilds structure after an older correction even when first/last times and tail OHLCV are unchanged', () => {
    const rows = data();
    let state = updateVerifiedStructure(null, rows);
    rows[100].high += 500;
    rows[101].low -= 500;
    state = updateVerifiedStructure(state, rows);
    expect(state.state.events).toEqual(calculateMarketStructure(rows));
    const appended = [...rows, { ...rows.at(-1)!, time: rows.at(-1)!.time + 60 }];
    state = updateVerifiedStructure(state, appended);
    expect(state.state.events).toEqual(calculateMarketStructure(appended));
  });
  it('equals full recomputation over tail updates, in-place old corrections, prepend, append and rewind', () => {
    let rows = data();
    let state = updateVerifiedFvg(null, rows);
    for (let i = 0; i < 30; i++) {
      rows = rows.map((c, j) => j === rows.length - 1 ? { ...c, low: c.low - i, close: c.open + i, high: c.high + i } : c);
      state = updateVerifiedFvg(state, rows);
      expect(state.state.gaps).toEqual(findFairValueGaps(rows));
    }
    rows[100].low = 1;
    state = updateVerifiedFvg(state, rows);
    expect(state.state.gaps).toEqual(findFairValueGaps(rows));
    for (const next of [data(), data().slice(200), [...data().map(c => ({ ...c, time: c.time - 1500 * 60 })), ...data()], data().slice(0, 500)]) {
      state = updateVerifiedFvg(state, next);
      expect(state.state.gaps).toEqual(findFairValueGaps(next));
    }
  });
});
