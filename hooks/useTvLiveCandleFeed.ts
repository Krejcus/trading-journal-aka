import { useMemo } from 'react';
import type { LiveCandleFeed } from '../lib/liveCandleFeed';
import { tvLiveCandle } from '../lib/tvLiveCandle';
import { tvPriceChannel, tvPriceStore } from '../services/tvPriceChannel';
import { acquireTvPriceGrantRefresh } from '../services/tvPriceGrant';

/**
 * Živá poslední svíčka grafu dne z kanálu ceny TradingView (krok 5, jen
 * zobrazení — INV-UI-04). Presence `chart` a obnova grantu mimo LIVE běží
 * jen po dobu odběru — tedy jen když je feed opravdu napojený na graf (ne
 * v přehrávání, ne bez svíček). `null` = vypnuto (den už skončil, graf bez
 * živého okna).
 */
export function useTvLiveCandleFeed(enabled: boolean, dayEndMs: number): LiveCandleFeed | null {
  return useMemo<LiveCandleFeed | null>(() => (enabled
    ? {
      subscribe(listener) {
        const unsubscribe = tvPriceStore.subscribe(listener);
        const releaseInterest = tvPriceChannel.addChartInterest();
        const releaseGrantRefresh = acquireTvPriceGrantRefresh();
        return () => {
          unsubscribe();
          releaseInterest();
          releaseGrantRefresh();
        };
      },
      current: root => tvLiveCandle(tvPriceStore.view(), root, dayEndMs),
    }
    : null), [enabled, dayEndMs]);
}
