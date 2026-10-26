import { useEffect, useMemo, useState } from 'react';
import type { Trade } from '../types';
import { isEvidenceJournalTrade } from '../lib/journalTradeFacts';
import { tradeDetailSource } from '../lib/tradeHistoryPresentation';
import { HISTORICAL_LAG_MS, composeDayCandles, dayCandleWindow, loadDayHistoricalCandles, type DayCandleAnchor } from '../services/dayCandles';
import type { MarketCandle } from '../services/marketData';
import { storageService } from '../services/storageService';
import { tradeChartTiming } from '../services/tradeChartData';
import { useLiveCandles } from './useLiveCandles';
import { useTvLiveCandleFeed } from './useTvLiveCandleFeed';

/**
 * Data grafu dne: obchody dne s historií plnění (šipky, SL/TP) a svíčky
 * — historie Databento + živé čtení TradingView pro posledních 25 h.
 * `liveFeed`: rozpracovaná poslední svíčka z kanálu ceny (jen překreslení
 * v grafu, do `candles` se nikdy nepřidává).
 */
export function useDayChartData(day: string, dayTrades: readonly Trade[], allTrades: readonly Trade[], now: number) {
  // Detaily (historie plnění) jedním dotazem; sloučené karty berou svůj zdroj.
  const sources = useMemo(() => dayTrades.map(trade => tradeDetailSource(trade, allTrades) ?? trade), [allTrades, dayTrades]);
  const detailKey = sources.filter(isEvidenceJournalTrade).map(trade => String(trade.id)).join(',');
  const [details, setDetails] = useState<{ key: string; byId: Map<string, Trade> }>({ key: '', byId: new Map() });
  useEffect(() => {
    if (!detailKey) { setDetails({ key: '', byId: new Map() }); return; }
    const controller = new AbortController();
    storageService.getJournalTradeDetails(detailKey.split(','), controller.signal)
      .then(rows => { if (!controller.signal.aborted) setDetails({ key: detailKey, byId: new Map(rows.map(row => [String(row.id), row])) }); })
      .catch(() => { if (!controller.signal.aborted) setDetails({ key: detailKey, byId: new Map() }); });
    return () => controller.abort();
  }, [detailKey]);
  const chartTrades = useMemo(() => sources.map(row => details.byId.get(String(row.id)) ?? row), [details, sources]);
  const detailsReady = !detailKey || details.key === detailKey;

  // Kontrakt ověří první vstup dne (rollover); bez obchodů kontinuální řada.
  const anchor = useMemo<DayCandleAnchor | null>(() => {
    const first = chartTrades[0];
    if (!first) return null;
    const timing = tradeChartTiming(first);
    return { symbol: first.symbol || first.instrument, at: timing.firstEntry.at, price: timing.firstEntry.price };
  }, [chartTrades]);
  const anchorKey = anchor ? `${anchor.symbol}:${anchor.at}:${anchor.price}` : '';

  // Okno se mění jen když se posune hranice historie (po 15 min; u starých dnů nikdy).
  const probe = dayCandleWindow(day, now);
  const capKey = probe.historicalEnd?.getTime() ?? 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- okno určuje den a hranice historie
  const candleWindow = useMemo(() => probe, [day, capKey]);
  const [historical, setHistorical] = useState<{ day: string; key: string; candles: MarketCandle[]; symbol: string; error?: string } | null>(null);
  const historicalKey = `${day}|${anchorKey}|${capKey}`;
  useEffect(() => {
    if (!detailsReady) return;
    let cancelled = false;
    loadDayHistoricalCandles({ day, anchor, now: capKey ? capKey + HISTORICAL_LAG_MS : undefined })
      .then(({ response }) => { if (!cancelled) setHistorical({ day, key: historicalKey, candles: response?.candles ?? [], symbol: response?.symbol ?? 'MNQ' }); })
      .catch(reason => {
        if (cancelled) return;
        // Neúspěšné obnovení stejného dne nechá dosavadní svíčky na místě.
        setHistorical(previous => previous?.day === day && previous.candles.length
          ? { ...previous, key: historicalKey }
          : { day, key: historicalKey, candles: [], symbol: 'MNQ', error: reason instanceof Error ? reason.message : 'Tržní data se nepodařilo načíst.' });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- klíč pokrývá den, kotvu i hranici historie
  }, [historicalKey, detailsReady]);

  const { live, status: liveStatus } = useLiveCandles('MNQ', { enabled: candleWindow.needsLive });
  // Během obnovení (posun hranice, ověřený kontrakt) zůstávají svíčky téhož dne —
  // graf se neodpojí ani neztratí záběr.
  const sameDay = historical?.day === day ? historical : null;
  const candles = useMemo(
    () => composeDayCandles(candleWindow, sameDay?.candles ?? [], live?.response.candles ?? null),
    [candleWindow, live, sameDay],
  );
  const loading = !sameDay || (candleWindow.needsLive && liveStatus === 'loading');
  // Jen dokud den běží (včerejšek v živém okně ani sobota už živou svíčku nemají).
  const liveFeed = useTvLiveCandleFeed(candleWindow.needsLive && now < candleWindow.dayEnd, candleWindow.dayEnd);
  return {
    candles,
    chartTrades,
    window: candleWindow,
    loading,
    error: sameDay?.error ?? null,
    liveStatus: candleWindow.needsLive ? liveStatus : null,
    liveCapturedAt: live?.capturedAt ?? null,
    liveFeed,
  };
}
