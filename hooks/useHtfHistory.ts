import { useEffect, useRef, useState } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import { resetChartView } from '../services/chartContextMenu';
import { htfHistoryDaysFor, htfHistoryRange } from '../services/htfHistory';
import { loadMarketCandles, resolveMarketSymbol, type MarketCandle, type MarketTimeframe } from '../services/marketData';

const EMPTY: readonly MarketCandle[] = Object.freeze([]);

export interface HtfHistory {
  candles: readonly MarketCandle[];
  /**
   * Zvýší se, když historie dorazí do grafu, který ji dosud neměl. Graf má pak
   * srovnat záběr (`useResetViewOnHtfHistory`) — doplnění zleva jinak drží záběr
   * na posledních pár svíčkách, které graf ukázal bez historie.
   */
  arrived: number;
}

/**
 * Hodinová historie Databento pro vyšší timeframy grafu deníku (`services/htfHistory.ts`).
 * Načte se jen když některý panel má timeframe skládaný z hodin; selhání = graf
 * zůstane jen se svými 1m daty. Cache po dnech drží `loadMarketCandles` (IndexedDB).
 */
export function useHtfHistory(root: 'MNQ' | 'NQ', timeframes: readonly MarketTimeframe[], firstRawTime: number | null | undefined): HtfHistory {
  const days = htfHistoryDaysFor(timeframes);
  const range = htfHistoryRange(firstRawTime, days);
  const key = range ? `${root}|${range.startMs}|${range.endMs}` : '';
  const [state, setState] = useState<{ key: string; candles: readonly MarketCandle[]; arrived: number }>({ key: '', candles: EMPTY, arrived: 0 });
  /** Graf naposledy dostal prázdnou historii (je tedy vykreslený bez ní). */
  const shownEmptyRef = useRef(true);
  useEffect(() => {
    if (!range) return;
    let cancelled = false;
    loadMarketCandles({ symbol: resolveMarketSymbol(root), start: new Date(range.startMs), end: new Date(range.endMs), schema: 'ohlcv-1h' })
      .then(response => {
        if (cancelled) return;
        const arrivedNow = shownEmptyRef.current && response.candles.length > 0;
        setState(previous => ({ key, candles: response.candles, arrived: previous.arrived + (arrivedNow ? 1 : 0) }));
      })
      .catch(() => { if (!cancelled) setState(previous => ({ key, candles: EMPTY, arrived: previous.arrived })); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- klíč pokrývá trh i okno
  }, [key]);
  // Během načtení jiného okna téhož trhu zůstane dosavadní historie (graf neztratí levou část).
  const candles = range && (state.key === key || state.key.startsWith(`${root}|`)) ? state.candles : EMPTY;
  shownEmptyRef.current = candles.length === 0;
  return { candles, arrived: state.arrived };
}

/**
 * Srovnat záběr jako „Reset chart view“, když vyšší timeframe dostal historii:
 * po jejím příchodu do grafu, který ji neměl, a po přepnutí na jiný timeframe
 * skládaný z hodin (záběr předchozího timeframu by ukázal jen pár svíček).
 */
export function useResetViewOnHtfHistory(api: ChartViewApi | null, history: HtfHistory, timeframe: MarketTimeframe): void {
  const handledRef = useRef({ arrived: history.arrived, timeframe });
  const hasHistory = history.candles.length > 0;
  useEffect(() => {
    // Graf se po přepnutí timeframu vytváří znovu — počkat na něj, nic neodškrtnout.
    if (!api) return;
    if (!hasHistory || htfHistoryDaysFor([timeframe]) === 0) {
      handledRef.current = { arrived: history.arrived, timeframe };
      return;
    }
    const handled = handledRef.current;
    if (handled.arrived === history.arrived && handled.timeframe === timeframe) return;
    handledRef.current = { arrived: history.arrived, timeframe };
    const frame = window.requestAnimationFrame(() => {
      try { resetChartView(api); } catch { /* graf mezitím zanikl */ }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [api, hasHistory, history.arrived, timeframe]);
}
