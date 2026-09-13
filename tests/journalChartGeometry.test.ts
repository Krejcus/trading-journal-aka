import { describe, expect, it } from 'vitest';
import { DEFAULT_STYLE } from '@getcandlekit/charts';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { createJournalTimeProjection, journalLogicalCoordinate, journalSpanCoordinates, journalTimeLogical } from '../services/journalChartTime';
import { createJournalPositionPrimitive, journalPositionDrawing } from '../services/journalPositionDrawing';
import { createJournalChartPrimitive } from '../services/journalChartPrimitive';
import type { MarketCandle } from '../services/marketData';
import type { Trade } from '../types';

const candles = [60, 120, 360, 420].map(time => ({ time, open: 100, high: 110, low: 90, close: 105, volume: 1 }));
const x = (index: number) => Number.isInteger(index) ? 100 + index * 20 : 0;
const trade = (entry = 120_123, exit = 420_789): Trade => ({ id: 'fixture', instrument: 'MNQ', direction: 'Long', entryPrice: 999,
  executionHistory: { accountId: 1, environment: 'demo', connectionId: 'fixture', fills: [
    { id: 'entry', orderId: 'entry-order', accountId: 1, at: entry, price: 100, role: 'entry', quantity: 1, allocatedQuantity: 1 },
    { id: 'exit', orderId: 'exit-order', accountId: 1, at: exit, price: 105, role: 'exit', quantity: 1, allocatedQuantity: 1 },
  ], protection: [
    { id: 'sl', orderId: 'sl', accountId: 1, at: entry + 1, price: 90, status: 'confirmed', operation: 'new', kind: 'sl', timeSource: 'broker', quantity: 1 },
    { id: 'tp', orderId: 'tp', accountId: 1, at: entry + 2, price: 110, status: 'confirmed', operation: 'new', kind: 'tp', timeSource: 'broker', quantity: 1 },
  ], gaps: [], complete: true, issues: [], grossPnl: 10, fees: 2, netPnl: 8 },
} as Trade);

describe('journal candle geometry', () => {
  it('keeps each millisecond and rejects exact missing-bar boundaries', () => {
    const projection = createJournalTimeProjection(candles, 60);
    expect(projection.point(120_123)).toBeCloseTo(1.00205);
    expect(projection.point(120_456)).toBeCloseTo(1.0076);
    expect(projection.point(158_789)).toBeCloseTo(1.64648333);
    for (const time of [59_999, 180_000, 240_000, 359_999, 480_000]) expect(projection.point(time)).toBeNull();
    expect(projection.point(360_000)).toBe(2);
    expect(journalTimeLogical(candles, 100_000, Infinity)).toBeNull();
    expect(journalLogicalCoordinate(NaN, x)).toBeNull();
  });
  it('clips spans at both missing market candles and recording gaps', () => {
    const projection = createJournalTimeProjection(candles, 60);
    const spans = projection.spans(120_123, 450_789, [{ from: 390_000, to: 410_000 }]);
    expect(spans.map(row => [row.from, row.to])).toEqual([[120_123, 180_000], [360_000, 390_000], [410_000, 450_789]]);
    expect(spans[0].fromLogical).toBeCloseTo(1.00205);
    expect(spans[0].toLogical).toBe(2);
    expect(spans[1].fromLogical).toBe(2);
    const before = journalSpanCoordinates(spans[0], x)!;
    const after = journalSpanCoordinates(spans[1], x)!;
    expect(before.right).toBeLessThan(after.left);
    expect(before.left).toBeCloseTo(120.041);
    expect(projection.spans(150_000, 250_000).map(row => [row.from, row.to])).toEqual([[150_000, 180_000]]);
  });
  it('clips to loaded history and never fabricates coverage after an open recording gap', () => {
    const projection = createJournalTimeProjection(candles, 60);
    expect(projection.spans(0, 900_000).map(row => [row.from, row.to])).toEqual([[60_000, 180_000], [360_000, 480_000]]);
    expect(projection.spans(120_000, 480_000, [{ from: 170_000 }]).map(row => row.to)).toEqual([170_000]);
    expect(projection.spans(120_000, 480_000, [{ from: 170_000, to: 160_000 }])).toEqual([]);
    expect(createJournalTimeProjection([...candles, candles[0]], 60).spans(0, 900_000)).toEqual([]);
  });
  it('uses the panel interval on 5m and preserves subsecond ordering', () => {
    const projection = createJournalTimeProjection([{ time: 0 }, { time: 300 }, { time: 600 }], 300);
    expect(projection.point(420_123)).toBeCloseTo(1.40041);
    expect(projection.point(420_456)).toBeCloseTo(1.40152);
  });
  it('does not invent the missing minute hidden inside an aggregated 5m bar', () => {
    const projection = createJournalTimeProjection([{ time: 0 }], 300, { candles: [0, 60, 180, 240].map(time => ({ time })), intervalSeconds: 60 });
    expect(projection.point(120_123)).toBeNull();
    expect(projection.point(180_123)).toBeCloseTo(0.60041);
    expect(projection.spans(10_000, 290_000).map(span => [span.from, span.to])).toEqual([[10_000, 120_000], [180_000, 290_000]]);
  });
  it('paints confirmed levels in separate ranges and omits markers in missing candles', () => {
    const value = trade();
    value.executionHistory!.fills.push({ ...value.executionHistory!.fills[1], id: 'partial', at: 240_123 });
    const chart = { timeScale: () => ({ logicalToCoordinate: x }) } as unknown as IChartApi;
    const series = { priceToCoordinate: (price: number) => 200 - price } as unknown as ISeriesApi<'Candlestick'>;
    const primitive = createJournalChartPrimitive(value.executionHistory!, candles, 60, chart, series);
    const paths: number[][][] = [], marks: number[][] = [], labels: Array<[string, number]> = [];
    let path: number[][] = [];
    const context = new Proxy({ beginPath: () => { path = []; }, moveTo: (a: number, b: number) => path.push([a, b]),
      lineTo: (a: number, b: number) => path.push([a, b]), stroke: () => paths.push(path),
      arc: (...args: number[]) => marks.push(args), fillText: (label: string, xx: number) => labels.push([label, xx]) },
    { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} });
    const renderer = primitive.paneViews!()[0].renderer()!;
    renderer.draw({ useMediaCoordinateSpace: (callback: (scope: unknown) => void) => callback({ context }) } as Parameters<typeof renderer.draw>[0]);
    expect(paths).toHaveLength(4);
    expect(paths.every(points => !(points[0][0] < 140 && points[1][0] > 140))).toBe(true);
    expect(marks).toHaveLength(2);
    expect(labels).toEqual([['ENTRY', 120.041], ['EXIT', 160.263]]);
  });
});

describe('journal position reference uses the actual CandleKit renderer', () => {
  const draw = (value: Trade, rows: MarketCandle[] = candles) => {
    const primitive = createJournalPositionPrimitive(value, DEFAULT_STYLE, rows, 60)!;
    expect(primitive).not.toBeNull();
    const chart = { timeScale: () => ({ logicalToCoordinate: x, timeToCoordinate: () => 9999 }) } as unknown as IChartApi;
    const series = { priceToCoordinate: (price: number) => 200 - price } as unknown as ISeriesApi<'Candlestick'>;
    primitive.attached!({ chart, series, requestUpdate: () => {} } as Parameters<NonNullable<typeof primitive.attached>>[0]);
    primitive.updateAllViews!();
    const fills: number[][] = [];
    const context = new Proxy({ fillRect: (...args: number[]) => fills.push(args) }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} });
    const renderer = primitive.paneViews!()[0].renderer()!;
    renderer.draw({ useBitmapCoordinateSpace: (callback: (scope: unknown) => void) => callback({ context, horizontalPixelRatio: 1, verticalPixelRatio: 1, bitmapSize: { width: 800, height: 400 } }) } as Parameters<typeof renderer.draw>[0]);
    primitive.detached!();
    return fills;
  };
  it('uses fractional account entry/exit coordinates instead of generic time extrapolation', () => {
    const fills = draw(trade());
    expect(fills).toHaveLength(4); // Risk and target for two separate candle ranges.
    expect(fills[0][0]).toBeCloseTo(120.041);
    expect(fills[0][0] + fills[0][2]).toBeLessThan(fills[2][0]);
    expect(fills[2][0] + fills[2][2]).toBeCloseTo(160.263);
    expect(fills[0][1]).toBe(90); expect(fills[0][3]).toBe(10);
    const other = draw(trade(120_456, 420_955));
    expect(other[0][0]).toBeGreaterThan(fills[0][0]);
    expect(other[2][0] + other[2][2]).toBeGreaterThan(fills[2][0] + fills[2][2]);
  });
  it('preserves loaded portions when entry or exit has no loaded candle', () => {
    expect(draw(trade(30_000, 500_000))).toHaveLength(4);
    expect(createJournalPositionPrimitive(trade(190_000, 250_000), DEFAULT_STYLE, candles, 60)).toBeNull();
  });
  it('never normalizes invalid SL/TP into an invented bracket or uses the scale-in average', () => {
    expect(journalPositionDrawing(trade(), DEFAULT_STYLE, 60)!.points[0].price).toBe(100);
    for (const price of [NaN, 100, 105]) {
      const value = trade(); value.executionHistory!.protection[0].price = price;
      expect(journalPositionDrawing(value, DEFAULT_STYLE, 60)).toBeNull();
    }
    const value = trade(); value.executionHistory!.protection[0].accountId = 2;
    expect(journalPositionDrawing(value, DEFAULT_STYLE, 60)).toBeNull();
  });
  it('handles short references and refuses ambiguous simultaneous first-fill prices', () => {
    const value = trade(); value.direction = 'Short';
    value.executionHistory!.protection[0].price = 110;
    value.executionHistory!.protection[1].price = 90;
    expect(journalPositionDrawing(value, DEFAULT_STYLE, 60)).toMatchObject({ tool: 'ShortPosition' });
    value.executionHistory!.fills.push({ ...value.executionHistory!.fills[0], id: 'simultaneous', price: 101 });
    expect(journalPositionDrawing(value, DEFAULT_STYLE, 60)).toBeNull();
  });
});
