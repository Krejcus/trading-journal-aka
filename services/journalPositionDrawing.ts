import { futuresSymbolRoot } from './futuresContractSpecs';
import type { Trade } from '../types';
import { managedPositionDrawing } from './backtestManagedPosition';
import { normalizePositionSettings, type PositionDrawingStyle } from './chartPositionDrawing';
import { DrawingEngine, DrawingPrimitive } from '@getcandlekit/charts';
import type { ISeriesPrimitive, Logical, Time } from 'lightweight-charts';
import type { MarketCandle } from './marketData';
import { createJournalTimeProjection, journalSpanCoordinates, type JournalCandleCoverage } from './journalChartTime';

/** Same position renderer and style as replay; missing original protection is never estimated. */
export function journalPositionDrawing(trade: Trade, currentStyle: PositionDrawingStyle, intervalSeconds: number) {
  const instrument = futuresSymbolRoot(trade.instrument ?? '');
  if (instrument !== 'MNQ' && instrument !== 'NQ') return null;
  const history = trade.executionHistory;
  if (!history || !history.fills.length) return null;
  if (history.position && history.position.status !== 'closed') return null;
  const original = history.protection.filter(event => event.accountId === history.accountId && event.status === 'confirmed' && event.operation === 'new').sort((a, b) => a.at - b.at);
  const entries = history.fills.filter(fill => fill.role === 'entry').sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const exits = history.fills.filter(fill => fill.role === 'exit');
  if (!entries.length || !exits.length || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0
    || history.fills.some(fill => fill.accountId !== history.accountId || !Number.isFinite(fill.at) || !Number.isFinite(fill.price))) return null;
  const start = Math.min(...entries.map(fill => fill.at));
  const end = Math.max(...exits.map(fill => fill.at));
  if (entries.some(fill => fill.at === start && fill.price !== entries[0].price)) return null;
  const stopEvent = original.find(event => event.kind === 'sl' && event.at <= end);
  const targetEvent = original.find(event => event.kind === 'tp' && event.at <= end);
  const stop = stopEvent?.price, target = targetEvent?.price;
  if (stop == null || target == null || !Number.isFinite(stop) || !Number.isFinite(target) || end <= start
    || !['Long', 'Short'].includes(trade.direction)
    || (trade.direction === 'Long' ? stop >= entries[0].price || target <= entries[0].price : stop <= entries[0].price || target >= entries[0].price)) return null;
  // A single reference box cannot represent incompatible simultaneous brackets.
  if (original.some(event => ((event.kind === 'sl' && event.at === stopEvent!.at && event.price !== stop)
    || (event.kind === 'tp' && event.at === targetEvent!.at && event.price !== target)))) return null;
  if (history.gaps.some(gap => gap.from <= start && (gap.to ?? Infinity) >= start)) return null;
  return managedPositionDrawing({
    id: `managed-position-journal-${trade.id}`, orderId: entries[0].orderId, instrument,
    tool: trade.direction === 'Long' ? 'LongPosition' : 'ShortPosition',
    startTime: start / 1_000, initialEndTime: end / 1_000, terminalTime: end / 1_000, state: 'closed',
    // Original risk box belongs to the first fill, not a later scale-in average.
    entryPrice: entries[0].price, stopPrice: stop, targetPrice: target,
    style: { ...currentStyle, position: { ...normalizePositionSettings(currentStyle.position, trade.instrument),
      intervalSeconds, stats: false, alwaysShowStats: false, priceLabels: true } },
  }, end / 1_000, intervalSeconds);
}

/** Reuse CandleKit's position renderer and appearance, with explicit projected
 * anchors. The shared editable drawing engine must not extrapolate a journal
 * timestamp from its latest bar across overnight/missing-candle gaps. */
export function createJournalPositionPrimitive(trade: Trade, currentStyle: PositionDrawingStyle,
  candles: readonly MarketCandle[], intervalSeconds: number, showPriceLabels = true, coverage?: JournalCandleCoverage): ISeriesPrimitive<Time> | null {
  const box = journalPositionDrawing(trade, currentStyle, intervalSeconds);
  if (!box || !trade.executionHistory) return null;
  const projection = createJournalTimeProjection(candles, intervalSeconds, coverage);
  const spans = projection.spans(box.points[0].time * 1000, box.points[1].time * 1000, trade.executionHistory.gaps);
  if (!spans.length) return null;
  const engine = new DrawingEngine();
  for (const [index, span] of spans.entries()) engine.commit({ ...box, id: `${box.id}:${index}`,
    points: box.points.map((point, i) => ({ ...point, time: (i ? span.to : span.from) / 1000 })),
    style: { ...box.style, position: { ...box.style.position, priceLabels: showPriceLabels && index === 0 } } as PositionDrawingStyle,
  });
  engine.select(null); engine.setLocked(true);
  const primitive = new DrawingPrimitive(engine);
  let attached: Parameters<DrawingPrimitive['attached']>[0] | null = null;
  return {
    attached: params => { attached = params; primitive.attached(params); params.requestUpdate(); },
    detached: () => { attached = null; primitive.detached(); },
    updateAllViews: () => {
      primitive.updateAllViews();
      if (!attached) return;
      const params = attached;
      const coordinate = (index: number) => params.chart.timeScale().logicalToCoordinate(index as Logical);
      // `shapes` is CandleKit's public primitive model. Preserve its renderer,
      // replace only screen anchors; no fake times enter the candle series.
      primitive.shapes = primitive.shapes.map((shape, index) => {
        const bounds = journalSpanCoordinates(spans[index], coordinate);
        return { ...shape, selected: false, hovered: false, draft: false,
          anchors: shape.drawing.points.map((point, i) => ({ x: bounds ? i ? bounds.right : bounds.left : null,
            y: params.series.priceToCoordinate(point.price) })) };
      });
    },
    paneViews: () => primitive.paneViews(),
    priceAxisViews: () => primitive.priceAxisViews(),
  };
}
