import { useEffect, useRef } from 'react';
import type { ISeriesApi } from 'lightweight-charts';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { MarketCandle } from '../../services/marketData';
import { createJournalChartPrimitive, type JournalChartPrimitive } from '../../services/journalChartPrimitive';
import { liveFillHistory, liveFillKey, type LiveFillMarker } from '../../lib/liveFillMarkers';

const TAP_PX = 8;
const TAP_MS = 450;

/**
 * Šipky plnění živého obchodu v LIVE grafu telefonu — stejné jako v grafu
 * deníku (primitiva deníku). Klepnutí na šipku ji zvýrazní a ukáže přesnou
 * cenu ve svíčce (čárka + tečka, spojnice, štítek s časem, cena na ose);
 * klepnutí jinam výběr zruší. Překreslí se jen s novým plněním nebo svíčkou.
 */
export function useLiveFillArrows({ api, fills, open, candles, intervalSeconds, enabled, isDark }: {
  api: ChartViewApi | null;
  fills: readonly LiveFillMarker[];
  open: boolean;
  candles: readonly MarketCandle[];
  intervalSeconds: number;
  enabled: boolean;
  isDark: boolean;
}) {
  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const fillsRef = useRef(fills);
  fillsRef.current = fills;
  const fillKey = liveFillKey(fills);
  // Nová svíčka mění promítnutí času na svíčky; tick v téže svíčce ne.
  const candleKey = `${candles.length}:${candles[0]?.time ?? 0}`;
  useEffect(() => {
    if (!api || !enabled || !fillKey || !candlesRef.current.length) return undefined;
    const history = liveFillHistory(fillsRef.current, open);
    if (!history) return undefined;
    let series: ISeriesApi<'Candlestick'>;
    let primitive: JournalChartPrimitive;
    let element: HTMLElement;
    try {
      const chart = api.controller.getChart();
      series = api.controller.getSeries() as ISeriesApi<'Candlestick'>;
      element = chart.chartElement();
      const firstEntry = history.fills.find(fill => fill.role === 'entry');
      primitive = createJournalChartPrimitive(history, candlesRef.current, intervalSeconds, chart, series, undefined, {
        direction: firstEntry?.side === 'Sell' ? 'Short' : 'Long',
        resultBox: false, hideResultLabel: true, isDark, pointValue: 2, instrument: 'MNQ',
      });
      series.attachPrimitive(primitive);
    } catch { return undefined; }
    // Klepnutí (krátký dotyk bez posunu) = najetí kurzorem na tom bodě. Až po
    // zpracování dotyku grafem (ten na klepnutí schová crosshair a zrušil by výběr).
    let down: { x: number; y: number; at: number } | null = null;
    let timer = 0;
    const onDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY, at: Date.now() }; };
    const onUp = (event: PointerEvent) => {
      const start = down;
      down = null;
      if (!start || Date.now() - start.at > TAP_MS || Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_PX) return;
      const rect = element.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      window.clearTimeout(timer);
      timer = window.setTimeout(() => primitive.hoverAt(point), 40);
    };
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointerup', onUp);
    return () => {
      window.clearTimeout(timer);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointerup', onUp);
      try { series.detachPrimitive(primitive); } catch { /* graf už je pryč */ }
    };
  }, [api, enabled, fillKey, candleKey, open, intervalSeconds, isDark]);
}
