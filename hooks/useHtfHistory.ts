import { useEffect, useState } from 'react';
import { htfHistoryDaysFor, htfHistoryRange } from '../services/htfHistory';
import { loadMarketCandles, resolveMarketSymbol, type MarketCandle, type MarketTimeframe } from '../services/marketData';

const EMPTY: readonly MarketCandle[] = Object.freeze([]);

/**
 * Hodinová historie Databento pro vyšší timeframy grafu deníku (`services/htfHistory.ts`).
 * Načte se jen když některý panel má timeframe skládaný z hodin; selhání = graf
 * zůstane jen se svými 1m daty. Cache po dnech drží `loadMarketCandles` (IndexedDB).
 */
export function useHtfHistory(root: 'MNQ' | 'NQ', timeframes: readonly MarketTimeframe[], firstRawTime: number | null | undefined): readonly MarketCandle[] {
  const days = htfHistoryDaysFor(timeframes);
  const range = htfHistoryRange(firstRawTime, days);
  const key = range ? `${root}|${range.startMs}|${range.endMs}` : '';
  const [state, setState] = useState<{ key: string; candles: readonly MarketCandle[] }>({ key: '', candles: EMPTY });
  useEffect(() => {
    if (!range) return;
    let cancelled = false;
    loadMarketCandles({ symbol: resolveMarketSymbol(root), start: new Date(range.startMs), end: new Date(range.endMs), schema: 'ohlcv-1h' })
      .then(response => { if (!cancelled) setState({ key, candles: response.candles }); })
      .catch(() => { if (!cancelled) setState({ key, candles: EMPTY }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- klíč pokrývá trh i okno
  }, [key]);
  if (!range) return EMPTY;
  // Během načtení jiného okna téhož trhu zůstane dosavadní historie (graf neztratí levou část).
  return state.key === key || state.key.startsWith(`${root}|`) ? state.candles : EMPTY;
}
