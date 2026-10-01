import type { IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneRenderer, Logical, Time } from 'lightweight-charts';
import type { TradeEntryOrder } from '../lib/journalEntryOrders';
import type { MarketCandle } from './marketData';
import { createJournalTimeProjection, journalLogicalCoordinate, journalVisibleSpanCoordinates, type JournalCandleCoverage } from './journalChartTime';
import { JOURNAL_BUY_COLOR, JOURNAL_SELL_COLOR } from './journalChartPrimitive';

/**
 * Vstupní příkazy obchodu ve stylu příkazu v TradingView: přerušovaná linka
 * od zadání po vyplnění/zrušení, na začátku cedulka (strana, typ, kusy),
 * posun příkazu = schod. Vyplnění = zelená tečka u šipky vstupu, zrušený
 * příkaz zešedne a končí ✕. Limit čárkovaně, stop tečkovaně.
 */
const FILL_COLOR = '#10b981';
const CANCEL_COLOR = '#94a3b8';
const CHIP = { height: 16, padX: 5, gap: 4, font: '700 9.5px Inter, system-ui, sans-serif', radius: 3 };

export function entryOrderLabel(order: Pick<TradeEntryOrder, 'side' | 'type' | 'quantity'>): string {
  return `${order.side === 'Buy' ? 'BUY' : 'SELL'} ${order.type === 'Limit' ? 'LMT' : 'STP'}${order.quantity != null ? ` ${order.quantity}` : ''}`;
}

export function createEntryOrdersPrimitive(orders: readonly TradeEntryOrder[], candles: readonly MarketCandle[], intervalSeconds: number,
  chart: IChartApi, series: ISeriesApi<'Candlestick'>, coverage?: JournalCandleCoverage, options: { isDark?: boolean } = {}): ISeriesPrimitive<Time> {
  const projection = createJournalTimeProjection(candles, intervalSeconds, coverage);
  const lastAt = candles.length ? (candles[candles.length - 1].time + intervalSeconds) * 1000 - 1 : 0;
  const shapes = orders.map(order => {
    const until = order.end?.at ?? lastAt;
    return {
      order,
      color: order.end?.kind === 'cancel' ? CANCEL_COLOR : order.side === 'Buy' ? JOURNAL_BUY_COLOR : JOURNAL_SELL_COLOR,
      legs: order.legs.map((leg, index) => {
        const to = Math.max(leg.at, index + 1 < order.legs.length ? order.legs[index + 1].at : until);
        return { ...leg, to, spans: projection.spans(leg.at, to) };
      }),
    };
  });
  const renderer: IPrimitivePaneRenderer = { draw: target => {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const coordinate = (index: number) => chart.timeScale().logicalToCoordinate(index as Logical);
      const x = (at: number) => journalLogicalCoordinate(projection.point(at), coordinate);
      context.save();
      context.font = CHIP.font;
      // Cedulky se nevrství: další příkaz na stejné ceně (přezadání) jde nad linku.
      const chips: Array<{ left: number; right: number; top: number; bottom: number }> = [];
      for (const { order, color, legs } of shapes) {
        const cancelled = order.end?.kind === 'cancel';
        context.globalAlpha = cancelled ? 0.85 : 1;
        context.strokeStyle = color;
        context.lineWidth = 1.5;
        let previous: { x: number; y: number } | null = null;
        let lastPoint: { x: number; y: number } | null = null;
        for (const leg of legs) {
          const y = series.priceToCoordinate(leg.price);
          if (y == null || !Number.isFinite(y)) { previous = null; continue; }
          context.setLineDash(order.type === 'Limit' ? [6, 4] : [2, 3]);
          for (const span of leg.spans) {
            const bounds = journalVisibleSpanCoordinates(span, coordinate);
            if (!bounds) continue;
            context.beginPath(); context.moveTo(bounds.left, y); context.lineTo(bounds.right, y); context.stroke();
          }
          const start = x(leg.at);
          // Posun příkazu: svislý schod a malé kolečko v novém místě.
          if (previous && start != null) {
            context.setLineDash([]);
            context.beginPath(); context.moveTo(start, previous.y); context.lineTo(start, y); context.stroke();
            context.fillStyle = options.isDark ? '#0b1017' : '#ffffff';
            context.beginPath(); context.arc(start, y, 2.6, 0, Math.PI * 2); context.fill(); context.stroke();
          }
          const end = x(leg.to);
          if (start != null) previous = { x: start, y };
          if (end != null) lastPoint = { x: end, y };
        }
        // Cedulka u zadání (vlevo od začátku; u levého okraje vpravo).
        const first = legs[0];
        const fy = first ? series.priceToCoordinate(first.price) : null;
        const fx = first ? x(first.at) : null;
        if (first && fy != null && fx != null) {
          const text = entryOrderLabel(order);
          const width = context.measureText(text).width + CHIP.padX * 2;
          const left = fx - CHIP.gap - width >= 0 ? fx - CHIP.gap - width : fx + CHIP.gap;
          let top = fy - CHIP.height / 2;
          const overlaps = () => chips.some(chip => left < chip.right && left + width > chip.left && top < chip.bottom && top + CHIP.height > chip.top);
          for (let guard = 0; guard < 4 && overlaps(); guard += 1) top -= CHIP.height + 3;
          chips.push({ left, right: left + width, top, bottom: top + CHIP.height });
          if (left < mediaSize.width) {
            context.setLineDash([]);
            context.globalAlpha = 1;
            context.fillStyle = cancelled ? (options.isDark ? '#1e293b' : '#f1f5f9') : color;
            context.strokeStyle = cancelled ? (options.isDark ? '#334155' : '#cbd5e1') : color;
            context.lineWidth = 1;
            // Posunutá cedulka má krátkou spojku k začátku své linky.
            if (top !== fy - CHIP.height / 2) {
              context.beginPath(); context.moveTo(left + width / 2, top + CHIP.height); context.lineTo(left + width / 2, fy); context.stroke();
            }
            context.beginPath(); context.roundRect(left, top, width, CHIP.height, CHIP.radius); context.fill(); context.stroke();
            context.fillStyle = cancelled ? '#64748b' : '#ffffff';
            context.textBaseline = 'middle';
            context.fillText(text, left + CHIP.padX, top + CHIP.height / 2 + 0.5);
          }
        }
        // Konec: vyplnění (tečka) nebo zrušení (✕). Čekající příkaz bez značky.
        if (order.end && lastPoint) {
          context.setLineDash([]);
          context.globalAlpha = 1;
          if (order.end.kind === 'fill') {
            context.fillStyle = FILL_COLOR; context.strokeStyle = options.isDark ? '#0b1017' : '#ffffff'; context.lineWidth = 1.5;
            context.beginPath(); context.arc(lastPoint.x, lastPoint.y, 4.5, 0, Math.PI * 2); context.fill(); context.stroke();
          } else {
            context.fillStyle = options.isDark ? '#0b1017' : '#ffffff'; context.strokeStyle = options.isDark ? '#475569' : '#cbd5e1'; context.lineWidth = 1;
            context.beginPath(); context.arc(lastPoint.x, lastPoint.y, 6, 0, Math.PI * 2); context.fill(); context.stroke();
            context.strokeStyle = '#64748b'; context.lineWidth = 1.5; context.lineCap = 'round';
            context.beginPath();
            context.moveTo(lastPoint.x - 2.6, lastPoint.y - 2.6); context.lineTo(lastPoint.x + 2.6, lastPoint.y + 2.6);
            context.moveTo(lastPoint.x + 2.6, lastPoint.y - 2.6); context.lineTo(lastPoint.x - 2.6, lastPoint.y + 2.6);
            context.stroke();
          }
        }
      }
      context.restore();
    });
  } };
  const views = [{ zOrder: () => 'top' as const, renderer: () => renderer }];
  // Čekající příkaz (při přehrávání) má štítek na cenové ose.
  const axisViews = () => shapes.filter(shape => !shape.order.end).flatMap(({ order, color }) => {
    const price = order.legs.at(-1)?.price;
    const y = price == null ? null : series.priceToCoordinate(price);
    return y == null ? [] : [{ coordinate: () => y, text: () => `${order.type === 'Limit' ? 'LMT' : 'STP'} ${price!.toFixed(2)}`,
      textColor: () => '#ffffff', backColor: () => color, visible: () => true, tickVisible: () => true }];
  });
  return { paneViews: () => views, priceAxisViews: axisViews };
}
