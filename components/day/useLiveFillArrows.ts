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
 * `past` = dřívější zavřené obchody, každý jako vlastní vrstva (25. 11. 2026) —
 * dřív zůstaly v grafu jen šipky posledního obchodu.
 */
export function useLiveFillArrows({ api, fills, past, open, candles, intervalSeconds, enabled, isDark }: {
  api: ChartViewApi | null;
  fills: readonly LiveFillMarker[];
  past?: readonly (readonly LiveFillMarker[])[];
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
  const pastRef = useRef(past);
  pastRef.current = past;
  const fillKey = [liveFillKey(fills), ...(past ?? []).map(liveFillKey)].join('/');
  const hasFills = fills.length > 0 || (past ?? []).some(trade => trade.length > 0);
  // Nová svíčka mění promítnutí času na svíčky; tick v téže svíčce ne.
  const candleKey = `${candles.length}:${candles[0]?.time ?? 0}`;
  useEffect(() => {
    if (!api || !enabled || !hasFills || !candlesRef.current.length) return undefined;
    // Poslední (případně otevřený) obchod + dřívější zavřené; každý obchod = vlastní historie a primitiva.
    const histories = [liveFillHistory(fillsRef.current, open), ...(pastRef.current ?? []).map(trade => liveFillHistory(trade, false))]
      .filter((history): history is NonNullable<typeof history> => history !== null);
    if (!histories.length) return undefined;
    let series: ISeriesApi<'Candlestick'>;
    let element: HTMLElement;
    const primitives: JournalChartPrimitive[] = [];
    try {
      const chart = api.controller.getChart();
      series = api.controller.getSeries() as ISeriesApi<'Candlestick'>;
      element = chart.chartElement();
      for (const history of histories) {
        const firstEntry = history.fills.find(fill => fill.role === 'entry');
        const primitive = createJournalChartPrimitive(history, candlesRef.current, intervalSeconds, chart, series, undefined, {
          direction: firstEntry?.side === 'Sell' ? 'Short' : 'Long',
          resultBox: false, hideResultLabel: true, isDark, pointValue: 2, instrument: 'MNQ',
        });
        series.attachPrimitive(primitive);
        primitives.push(primitive);
      }
    } catch {
      for (const primitive of primitives) { try { series!.detachPrimitive(primitive); } catch { /* graf už je pryč */ } }
      return undefined;
    }
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
      timer = window.setTimeout(() => { for (const primitive of primitives) primitive.hoverAt(point); }, 40);
    };
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointerup', onUp);
    return () => {
      window.clearTimeout(timer);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointerup', onUp);
      for (const primitive of primitives) { try { series.detachPrimitive(primitive); } catch { /* graf už je pryč */ } }
    };
  }, [api, enabled, hasFills, fillKey, candleKey, open, intervalSeconds, isDark]);
}
