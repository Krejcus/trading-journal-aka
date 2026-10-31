import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { htfHistoryDaysFor, htfHistoryRange } from '../services/htfHistory';
import { loadMarketCandles, resolveMarketSymbol, marketDataSchemaForTimeframe, type MarketCandle, type MarketTimeframe } from '../services/marketData';
import { createChartPastHistory, historyPageDays } from '../services/chartPastHistory';

const stores = new Map<string, ReturnType<typeof createChartPastHistory>>();
const EMPTY_CANDLES: readonly MarketCandle[] = [];
const getStore = (symbol: string, schema: 'ohlcv-1h' | 'ohlcv-1m', scope = '') => {
  const key = `${symbol}|${schema}|${scope}`;
  let store = stores.get(key);
  if (!store) {
    store = createChartPastHistory(symbol, schema, loadMarketCandles);
    if (stores.size >= 8) stores.delete(stores.keys().next().value!);
    stores.set(key, store);
  }
  return store;
};
export interface HtfHistory {
  candles: readonly MarketCandle[];
  minuteBridge: readonly MarketCandle[];
  arrived: number;
  loading: boolean;
  error: string | null;
  startMs: number | null;
  loadOlder: (beforeSeconds: number) => Promise<void>;
}

/** Shared symbol/schema history survives timeframe changes and failed refreshes. */
export function useHtfHistory(root: 'MNQ' | 'NQ', timeframes: readonly MarketTimeframe[], firstRawTime: number | null | undefined, tradeSymbol?: string): HtfHistory {
  const tf = timeframes[0] ?? '1m';
  const days = htfHistoryDaysFor(timeframes);
  const schema = days > 0 ? 'ohlcv-1h' : marketDataSchemaForTimeframe(tf);
  const symbol = resolveMarketSymbol(root, tradeSymbol);
  const store = useMemo(() => getStore(symbol, schema), [symbol, schema]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  // An hourly page cannot supply the minutes between its final whole hour
  // and a recent series that starts mid-hour. Fetch that seam at 1m resolution.
  const bridgeEnd = schema === 'ohlcv-1h' && firstRawTime != null && Number.isFinite(firstRawTime) ? firstRawTime * 1000 : 0;
  const bridgeStart = Math.floor(bridgeEnd / 3600_000) * 3600_000;
  const bridgeStore = useMemo(() => getStore(symbol, 'ohlcv-1m', `bridge:${bridgeStart}`), [symbol, bridgeStart]);
  const bridgeState = useSyncExternalStore(bridgeStore.subscribe, bridgeStore.getSnapshot, bridgeStore.getSnapshot);
  const needsBridge = bridgeEnd > bridgeStart;
  useEffect(() => {
    if (needsBridge && timeframes.length) void bridgeStore.ensure(bridgeStart, bridgeEnd).catch(() => undefined);
  }, [bridgeStore, bridgeStart, bridgeEnd, needsBridge, timeframes.length]);
  const minuteBridge = useMemo(() => needsBridge
    ? bridgeState.candles.filter(c => c.time * 1000 >= bridgeStart && c.time * 1000 < bridgeEnd)
    : EMPTY_CANDLES, [bridgeState.candles, needsBridge, bridgeStart, bridgeEnd]);
  const range = htfHistoryRange(firstRawTime, days);
  const start = range?.startMs, end = range?.endMs;
  useEffect(() => {
    if (start == null || end == null || !timeframes.length) return;
    void store.ensure(start, end).catch(() => undefined);
  }, [store, start, end, timeframes.length]);
  const minuteEnd = schema === 'ohlcv-1m' && firstRawTime != null ? firstRawTime * 1000 : null;
  useEffect(() => {
    // A rolling recent window can move forward while shared past data stays
    // cached. Fill its newly exposed seam before treating it as continuous.
    if (!timeframes.length || minuteEnd == null || state.startMs == null || state.endMs == null || minuteEnd <= state.endMs) return;
    void store.ensure(state.startMs, minuteEnd).catch(() => undefined);
  }, [store, minuteEnd, state.startMs, state.endMs, timeframes.length]);
  const loadOlder = useCallback(async (beforeSeconds: number) => {
    if (needsBridge) await bridgeStore.ensure(bridgeStart, bridgeEnd);
    const known = store.getSnapshot();
    const step = schema === 'ohlcv-1h' ? 3600_000 : 60_000;
    const right = Math.floor(Math.min(beforeSeconds * 1000, known.startMs ?? Infinity) / step) * step;
    await store.ensure(right - historyPageDays(schema, tf) * 86400_000, known.endMs ?? right);
  }, [store, schema, tf, bridgeStore, bridgeStart, bridgeEnd, needsBridge]);
  return { candles: state.candles, minuteBridge, arrived: state.revision + (needsBridge ? bridgeState.revision : 0), loading: state.loading || (needsBridge && bridgeState.loading), error: state.error ?? (needsBridge ? bridgeState.error : null), startMs: state.startMs, loadOlder };
}
