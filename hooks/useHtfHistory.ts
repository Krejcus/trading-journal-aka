import { useEffect, useRef, useState } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import { resetChartView } from '../services/chartContextMenu';
import { htfHistoryDaysFor, htfHistoryRange } from '../services/htfHistory';
import { loadMarketCandles, resolveMarketSymbol, type MarketCandle, type MarketTimeframe } from '../services/marketData';

const EMPTY: readonly MarketCandle[] = Object.freeze([]);
/** Neúspěšné načtení (výpadek sítě, limit funkce) se jednou zopakuje. */
const RETRY_MS = 5_000;
/** Reset záběru po příchodu historie jen takhle brzy po přepnutí timeframu / otevření grafu. */
export const HTF_RESET_WINDOW_MS = 20_000;

export interface HtfHistory {
  candles: readonly MarketCandle[];
  /**
   * Zvýší se, když do grafu dorazí historie, kterou dosud neměl (žádnou, nebo
   * kratší). Graf pak smí srovnat záběr (`useResetViewOnHtfHistory`) —
   * doplnění zleva jinak drží záběr na posledních pár svíčkách.
   */
  arrived: number;
}

/**
 * Hodinová historie Databento pro vyšší timeframy grafu deníku (`services/htfHistory.ts`).
 * Načte se jen když některý panel má timeframe skládaný z hodin; selhání = jeden
 * opakovaný pokus, pak graf zůstane jen se svými 1m daty. Cache po dnech drží
 * `loadMarketCandles` (IndexedDB), uzavřené měsíce i serverové úložiště.
 */
export function useHtfHistory(root: 'MNQ' | 'NQ', timeframes: readonly MarketTimeframe[], firstRawTime: number | null | undefined): HtfHistory {
  const days = htfHistoryDaysFor(timeframes);
  const range = htfHistoryRange(firstRawTime, days);
  const key = range ? `${root}|${range.startMs}|${range.endMs}` : '';
  const [state, setState] = useState<{ key: string; candles: readonly MarketCandle[]; arrived: number }>({ key: '', candles: EMPTY, arrived: 0 });
  useEffect(() => {
    if (!range) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const load = (attempt: number) => {
      loadMarketCandles({ symbol: resolveMarketSymbol(root), start: new Date(range.startMs), end: new Date(range.endMs), schema: 'ohlcv-1h' })
        .then(response => {
          if (cancelled) return;
          setState(previous => {
            // Nová historie začíná dřív než ta, co graf ukazuje (nebo žádnou neměl).
            const shown = previous.key.startsWith(`${root}|`) ? previous.candles : EMPTY;
            const longer = response.candles.length > 0 && (!shown.length || response.candles[0].time < shown[0].time);
            return { key, candles: response.candles, arrived: previous.arrived + (longer ? 1 : 0) };
          });
        })
        .catch(reason => {
          if (cancelled) return;
          if (attempt === 0) { retry = setTimeout(() => { retry = null; if (!cancelled) load(1); }, RETRY_MS); return; }
          console.warn('Hodinovou historii pro vyšší timeframe se nepodařilo načíst', reason instanceof Error ? reason.message : reason);
          setState(previous => ({ key, candles: EMPTY, arrived: previous.arrived }));
        });
    };
    load(0);
    return () => { cancelled = true; if (retry) clearTimeout(retry); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- klíč pokrývá trh i okno
  }, [key]);
  // Během načtení jiného okna téhož trhu zůstane dosavadní historie (graf neztratí levou část).
  const candles = range && (state.key === key || state.key.startsWith(`${root}|`)) ? state.candles : EMPTY;
  return { candles, arrived: state.arrived };
}

/**
 * Srovnat záběr jako „Reset chart view“, když vyšší timeframe dostal historii —
 * po přepnutí na jiný timeframe skládaný z hodin a po příchodu delší historie.
 * Jen krátce po přepnutí / otevření (pozdní příchod historie nesmí přeskočit
 * graf, se kterým uživatel mezitím pracuje) a jen když to graf dovolí
 * (`enabled`: ne v přehrávání, ne s vybraným obchodem).
 */
export function useResetViewOnHtfHistory(api: ChartViewApi | null, history: HtfHistory, timeframe: MarketTimeframe, enabled = true): void {
  const handledRef = useRef({ arrived: history.arrived, timeframe });
  const changedAtRef = useRef(Date.now());
  const lastTimeframeRef = useRef(timeframe);
  if (lastTimeframeRef.current !== timeframe) {
    lastTimeframeRef.current = timeframe;
    changedAtRef.current = Date.now();
  }
  const hasHistory = history.candles.length > 0;
  useEffect(() => {
    // Graf se po přepnutí timeframu vytváří znovu — počkat na něj, nic neodškrtnout.
    if (!api) return;
    const handled = handledRef.current;
    if (handled.arrived === history.arrived && handled.timeframe === timeframe) return;
    if (!enabled || !hasHistory || htfHistoryDaysFor([timeframe]) === 0 || Date.now() - changedAtRef.current > HTF_RESET_WINDOW_MS) {
      handledRef.current = { arrived: history.arrived, timeframe };
      return;
    }
    const target = { arrived: history.arrived, timeframe };
    const frame = window.requestAnimationFrame(() => {
      handledRef.current = target;
      try { resetChartView(api); } catch { /* graf mezitím zanikl */ }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [api, enabled, hasHistory, history.arrived, timeframe]);
}
