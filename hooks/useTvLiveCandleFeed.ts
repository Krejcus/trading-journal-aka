import { useMemo } from 'react';
import type { LiveCandleFeed } from '../lib/liveCandleFeed';
import { createReplayingLiveCandleFeed } from '../lib/tvLiveCandleReplay';
import { loadChartSettings } from '../services/chartSettings';
import { tvPriceChannel, tvPriceStore } from '../services/tvPriceChannel';
import { acquireTvPriceGrantRefresh } from '../services/tvPriceGrant';

/**
 * Živá poslední svíčka grafu dne z kanálu ceny TradingView (krok 5, jen
 * zobrazení — INV-UI-04). Presence `chart` a obnova grantu mimo LIVE běží
 * jen po dobu odběru — tedy jen když je feed opravdu napojený na graf (ne
 * v přehrávání, ne bez svíček). `null` = vypnuto (den už skončil, graf bez
 * živého okna). Volba grafu „Přehrávat ticky z dávky“ (`scales.liveTickReplay`)
 * nechá svíčku projít skutečnými cenami dávky (`lib/tvLiveCandleReplay.ts`).
 */
export function useTvLiveCandleFeed(enabled: boolean, dayEndMs: number): LiveCandleFeed | null {
  return useMemo<LiveCandleFeed | null>(() => {
    if (!enabled) return null;
    const feed = createReplayingLiveCandleFeed({
      view: () => tvPriceStore.view(),
      subscribe: listener => tvPriceStore.subscribe(listener),
      // Mimo backtest platí jeden profil nastavení pro všechny grafy; barva motivu tu nehraje roli.
      enabled: () => loadChartSettings(false).scales.liveTickReplay,
      dayEndMs,
    });
    return {
      subscribe(listener) {
        const unsubscribe = feed.subscribe(listener);
        const releaseInterest = tvPriceChannel.addChartInterest();
        const releaseGrantRefresh = acquireTvPriceGrantRefresh();
        return () => {
          unsubscribe();
          releaseInterest();
          releaseGrantRefresh();
        };
      },
      // Svíčku čte jen napojení na graf (`useLiveCandleBinding`); tady se jen předává.
      current: root => feed.current(root),
    };
  }, [enabled, dayEndMs]);
}
