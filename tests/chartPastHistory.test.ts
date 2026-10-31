import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createChartPastHistory, validateHistoryPage } from '../services/chartPastHistory';
import type { MarketCandleResponse } from '../services/marketDataCalculations';
const base = Date.parse('2026-10-01T00:00:00Z');
const response = (start: number, end: number): MarketCandleResponse => ({ provider: 'databento', dataset: 'GLBX.MDP3', symbol: 'MNQ.v.0', schema: 'ohlcv-1h', start: new Date(start).toISOString(), end: new Date(end).toISOString(),
  candles: Array.from({ length: (end - start) / 3600000 }, (_, i) => ({ time: start / 1000 + i * 3600, open: 100, high: 102, low: 99, close: 101, volume: i + 1 })) });
const loader = () => vi.fn(async (p: { start: Date; end: Date }) => response(+p.start, +p.end));
describe('shared deep-history read model', () => {
  it('deduplicates concurrent reads and only fetches the new prefix; candles remain ordered and unique', async () => {
    const load = loader(), store = createChartPastHistory('MNQ.v.0', 'ohlcv-1h', load);
    await Promise.all([store.ensure(base, base + 86400000), store.ensure(base, base + 86400000)]);
    expect(load).toHaveBeenCalledOnce();
    await store.ensure(base - 86400000, base + 86400000);
    expect(load.mock.calls[1][0]).toMatchObject({ start: new Date(base - 86400000), end: new Date(base) });
    const state = store.getSnapshot();
    expect(state.candles).toHaveLength(48);
    expect(new Set(state.candles.map(c => c.time)).size).toBe(48);
    expect(state.candles[24]).toEqual(response(base, base + 86400000).candles[0]);
    await store.ensure(base, base + 3600000);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('keeps all valid history after an outage or partial/wrong response and allows an explicit retry', async () => {
    const load = loader(), store = createChartPastHistory('MNQ.v.0', 'ohlcv-1h', load);
    await store.ensure(base, base + 3600000);
    const shown = store.getSnapshot().candles;
    load.mockRejectedValueOnce(new Error('offline'));
    await expect(store.ensure(base - 3600000, base + 3600000)).rejects.toThrow('offline');
    expect(store.getSnapshot()).toMatchObject({ candles: shown, loading: false, error: 'offline' });
    load.mockResolvedValueOnce({ ...response(base - 3600000, base), end: new Date(base - 1000).toISOString() });
    await expect(store.ensure(base - 3600000, base + 3600000)).rejects.toThrow('celé');
    expect(store.getSnapshot().candles).toBe(shown);
    await store.ensure(base - 3600000, base + 3600000);
    expect(store.getSnapshot()).toMatchObject({ error: null, loading: false });
    expect(store.getSnapshot().candles).toHaveLength(2);
  });
  it('advances over a confirmed empty calendar interval without inventing candles or claiming end of all history', async () => {
    const load = loader(), store = createChartPastHistory('MNQ.v.0', 'ohlcv-1h', load);
    load.mockResolvedValueOnce({ ...response(base, base + 3600000), candles: [] });
    await store.ensure(base, base + 3600000);
    expect(store.getSnapshot()).toMatchObject({ candles: [], startMs: base, endMs: base + 3600000 });
    await store.ensure(base - 3600000, base + 3600000);
    expect(store.getSnapshot().candles).toHaveLength(1);
  });
  it('keeps disjoint confirmed windows and later fills only the missing seam', async () => {
    const load = loader(), store = createChartPastHistory('MNQ.v.0', 'ohlcv-1h', load);
    await store.ensure(base, base + 3600000);
    await store.ensure(base + 3 * 3600000, base + 4 * 3600000);
    expect(store.getSnapshot().candles.map(candle => candle.time)).toEqual([base / 1000, base / 1000 + 3 * 3600]);
    await store.ensure(base, base + 4 * 3600000);
    expect(load.mock.calls[2][0]).toMatchObject({ start: new Date(base + 3600000), end: new Date(base + 3 * 3600000) });
    expect(store.getSnapshot().candles).toHaveLength(4);
  });
  it('rejects mixed symbol/schema but drops malformed rows without discarding the valid page', () => {
    const valid = response(base, base + 7200000);
    for (const bad of [{ ...valid, symbol: 'NQ.v.0' }, { ...valid, schema: 'ohlcv-1m' as const }]) {
      expect(() => validateHistoryPage(bad, 'MNQ.v.0', 'ohlcv-1h', base, base + 7200000)).toThrow();
    }
    const cleaned = validateHistoryPage({ ...valid, candles: [
      valid.candles[1],
      { ...valid.candles[0], high: 1 },
      valid.candles[0],
      valid.candles[0],
      { ...valid.candles[1], volume: NaN },
    ] }, 'MNQ.v.0', 'ohlcv-1h', base, base + 7200000);
    expect(cleaned).toEqual(valid.candles);
  });
  it('surfaces an HTF read error even while retained candles remain visible', () => {
    for (const file of ['../components/day/DayCompactChart.tsx', '../components/day/DayFullscreenChart.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).toContain('Starší historie není úplná: {htf.error}');
    }
  });
});
