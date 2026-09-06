// Both variants use the actual production store. This wrapper only warms its
// public read API with synthetic transport before measuring a large workspace.
// @ts-expect-error Vite resolves this explicit escape to the selected variant's real store.
import { createBacktestCandleStore as createActualStore } from 'qa-real-backtest-candle-store';
import type { BacktestRun } from '../../services/backtestTypes';

export const performanceData = { warm: false, sourceBars: 0, historyBars: 0, requests: 0 };
export function createBacktestCandleStore(run: BacktestRun) {
  const store = createActualStore(run) as ReturnType<typeof import('../../services/backtestCandleStore').createBacktestCandleStore>;
  let warming: Promise<void> | undefined;
  const warm = () => warming ??= (async () => {
    await store.loadInitial();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const snapshot = store.getSnapshot();
      const source = snapshot.candles[run.executionSymbol] ?? [];
      const history = snapshot.history[run.executionSymbol]?.['ohlcv-1m'] ?? [];
      const revealed = source.filter(candle => candle.time <= (run.runtimeState.replay.cursorTime ?? 0));
      performanceData.sourceBars = revealed.length;
      performanceData.historyBars = history.length;
      if (revealed.length + history.length >= 14_000) break;
      const before = history[0]?.time ?? source[0]?.time;
      if (before === undefined) throw new Error('Synthetic performance source is empty');
      performanceData.requests++;
      await store.loadOlder(run.executionSymbol, 'ohlcv-1m', before * 1000);
    }
    performanceData.warm = true;
  })();
  return { ...store,
    loadInitial: async () => { await warm(); return store.getSnapshot(); },
    ensureThrough: async (endMs: number) => { await warm(); return store.ensureThrough(endMs); },
  };
}
