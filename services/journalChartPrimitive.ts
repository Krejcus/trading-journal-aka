import type { IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneRenderer, Logical, Time } from 'lightweight-charts';
import type { TradeExecutionHistory } from '../lib/tradeExecutionHistory';
import type { MarketCandle } from './marketData';
import { ALPHATRADE_CHART_STYLE as style } from './chartVisualStyle';
import { journalProtectionSegments } from '../lib/journalProtectionSegments';
import { createJournalTimeProjection, journalLogicalCoordinate, journalSpanCoordinates, type JournalCandleCoverage } from './journalChartTime';
export { journalTimeLogical, journalLogicalCoordinate } from './journalChartTime';

export function createJournalChartPrimitive(history: TradeExecutionHistory, candles: readonly MarketCandle[], intervalSeconds: number,
  chart: IChartApi, series: ISeriesApi<'Candlestick'>, coverage?: JournalCandleCoverage): ISeriesPrimitive<Time> {
  const projection = createJournalTimeProjection(candles, intervalSeconds, coverage);
  const segments = journalProtectionSegments(history).map(segment => ({ ...segment, spans: projection.spans(segment.from, segment.to) }));
  const firstEntry = history.fills.filter(fill => fill.role === 'entry').sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))[0];
  const lastExit = history.fills.filter(fill => fill.role === 'exit').sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).at(-1);
  const renderer: IPrimitivePaneRenderer = { draw: target => {
    target.useMediaCoordinateSpace(({ context }) => {
      const coordinate = (index: number) => chart.timeScale().logicalToCoordinate(index as Logical);
      const x = (at: number) => journalLogicalCoordinate(projection.point(at), coordinate);
      const line = (left: number, right: number, price: number, color: string, dashed = false) => {
        const y = series.priceToCoordinate(price);
        if (y == null || !Number.isFinite(y)) return;
        context.strokeStyle = color; context.lineWidth = 1.5; context.setLineDash(dashed ? [3, 3] : []);
        context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke();
      };
      context.save();
      for (const segment of segments) {
        const color = segment.kind === 'sl' ? style.exit : style.entry;
        for (const span of segment.spans) {
          const bounds = journalSpanCoordinates(span, coordinate);
          if (bounds) line(bounds.left, bounds.right, segment.price, color, segment.receivedTime);
        }
        if (segment.nextPrice != null && segment.spans.at(-1)?.to === segment.to && projection.point(segment.to) != null) {
          const xx = x(segment.to); const y1 = series.priceToCoordinate(segment.price); const y2 = series.priceToCoordinate(segment.nextPrice);
          if (xx != null && y1 != null && y2 != null) {
            context.strokeStyle = color; context.lineWidth = 1.5; context.setLineDash(segment.receivedTime ? [3, 3] : []);
            context.beginPath(); context.moveTo(xx, y1); context.lineTo(xx, y2); context.stroke();
          }
        }
      }
      context.setLineDash([]);
      for (const fill of history.fills) {
        const xx = x(fill.at); const yy = series.priceToCoordinate(fill.price);
        if (xx == null || yy == null) continue;
        context.fillStyle = fill.role === 'entry' ? style.entry : style.exit;
        context.beginPath(); context.arc(xx, yy, 3, 0, Math.PI * 2); context.fill();
        if (fill === firstEntry || fill === lastExit) {
          context.font = '10px Inter, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
          context.fillText(fill.role === 'entry' ? 'ENTRY' : 'EXIT', xx, yy + (fill.role === 'entry' ? 12 : -12));
        }
      }
      context.restore();
    });
  } };
  const views = [{ zOrder: () => 'top' as const, renderer: () => renderer }];
  return { attached: ({ requestUpdate }) => requestUpdate(), paneViews: () => views };
}
