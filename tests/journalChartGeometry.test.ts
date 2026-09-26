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
    const primitive = createJournalChartPrimitive(value.executionHistory!, candles, 60, chart, series, undefined, { direction: 'Long' });
    const paths: number[][][] = [], labels: string[] = [];
    let path: number[][] = [];
    const context = new Proxy({ beginPath: () => { path = []; }, moveTo: (a: number, b: number) => path.push([a, b]),
      lineTo: (a: number, b: number) => path.push([a, b]), stroke: () => paths.push(path), fillText: (label: string) => labels.push(label) },
    { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} });
    const renderer = primitive.paneViews!()[0].renderer()!;
    renderer.draw({ useMediaCoordinateSpace: (callback: (scope: unknown) => void) => callback({ context }) } as Parameters<typeof renderer.draw>[0]);
    // Čtyři úseky SL/TP + dvě tenké šipky (hrot, stonek).
    const levels = paths.filter(points => points.length === 2);
    const arrows = paths.filter(points => points.length === 5);
    expect(levels).toHaveLength(4);
    expect(levels.every(points => !(points[0][0] < 140 && points[1][0] > 140))).toBe(true);
    // Šipky jen u plnění, která mají načtenou svíčku; hrot na x plnění.
    expect(arrows.map(points => points[1][0])).toEqual([120.041, 160.263]);
    // Bez najetí myší žádný štítek.
    expect(labels).toEqual([]);
  });
  it('po najetí na šipku ukáže, co je zač', () => {
    let onMove: ((param: { point?: { x: number; y: number } }) => void) | null = null;
    const chart = { timeScale: () => ({ logicalToCoordinate: x }), subscribeCrosshairMove: (handler: typeof onMove) => { onMove = handler; },
      unsubscribeCrosshairMove: () => { onMove = null; } } as unknown as IChartApi;
    const series = { priceToCoordinate: (price: number) => 200 - price } as unknown as ISeriesApi<'Candlestick'>;
    const primitive = createJournalChartPrimitive(trade().executionHistory!, candles, 60, chart, series, undefined, { direction: 'Long' });
    let updates = 0;
    primitive.attached!({ requestUpdate: () => { updates++; } } as unknown as Parameters<NonNullable<typeof primitive.attached>>[0]);
    const labels: string[] = [];
    const context = new Proxy({ fillText: (label: string) => labels.push(label) },
      { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} });
    const renderer = primitive.paneViews!()[0].renderer()!;
    const draw = () => renderer.draw({ useMediaCoordinateSpace: (callback: (scope: unknown) => void) => callback({ context }) } as Parameters<typeof renderer.draw>[0]);
    draw();
    const entryY = 200 - trade().executionHistory!.fills[0].price;
    onMove!({ point: { x: 121, y: entryY + 10 } });
    draw();
    expect(updates).toBeGreaterThan(1);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/^Vstup · Buy 1 · /);
    labels.length = 0;
    onMove!({ point: undefined });
    draw();
    expect(labels).toEqual([]);
    primitive.detached!();
    expect(onMove).toBeNull();
  });
});

describe('najetí na čáry SL/TP', () => {
  const setup = () => {
    const value = trade();
    value.executionHistory!.protection.push({ id: 'sl-move', orderId: 'sl', accountId: 1, at: 390_000, price: 95, status: 'confirmed',
      operation: 'modify', kind: 'sl', timeSource: 'broker', quantity: 1 } as never);
    let onMove: ((param: { point?: { x: number; y: number } }) => void) | null = null;
    const linear = (index: number) => 100 + index * 20;
    const chart = { timeScale: () => ({ logicalToCoordinate: linear, coordinateToLogical: (px: number) => (px - 100) / 20 }),
      subscribeCrosshairMove: (handler: typeof onMove) => { onMove = handler; }, unsubscribeCrosshairMove: () => {} } as unknown as IChartApi;
    const series = { priceToCoordinate: (price: number) => 200 - price } as unknown as ISeriesApi<'Candlestick'>;
    const primitive = createJournalChartPrimitive(value.executionHistory!, candles, 60, chart, series, undefined, { direction: 'Long', pointValue: 2, instrument: 'MNQ' });
    primitive.attached!({ requestUpdate: () => {} } as unknown as Parameters<NonNullable<typeof primitive.attached>>[0]);
    const labels: string[] = [];
    const context = new Proxy({ fillText: (label: string) => labels.push(label) },
      { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} });
    const renderer = primitive.paneViews!()[0].renderer()!;
    const draw = () => { labels.length = 0; renderer.draw({ useMediaCoordinateSpace: (callback: (scope: unknown) => void) => callback({ context }) } as Parameters<typeof renderer.draw>[0]); };
    return { draw, labels, move: (px: number, py: number) => onMove!({ point: { x: px, y: py } }) };
  };
  const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');
  it('vodorovná úroveň ukáže hodnotu pro otevřenou pozici, i kousek vedle čáry', () => {
    const { draw, labels, move } = setup();
    draw();
    move(145, 110 + 8);
    draw();
    expect(labels.map(plain)).toEqual(['SL 90,00 · −10,00 b. · −20,00 $ · 1 MNQ']);
  });
  it('svislý úsek ukáže samotný posun', () => {
    const { draw, labels, move } = setup();
    draw();
    move(150 + 4, 107.5);
    draw();
    // Nová úroveň 95 u longu ze 100 = pořád −5 b. / −10 $; posun +5 b. až na konci.
    expect(plain(labels[0])).toMatch(/^SL 90,00 → 95,00 · −5,00 b\. · −10,00 \$ · posun \+5,00 b\. · /);
  });
});

describe('obchod bez SL/TP', () => {
  const paint = (value: Trade) => {
    const chart = { timeScale: () => ({ logicalToCoordinate: (index: number) => 100 + index * 20 }) } as unknown as IChartApi;
    const series = { priceToCoordinate: (price: number) => 200 - price } as unknown as ISeriesApi<'Candlestick'>;
    const primitive = createJournalChartPrimitive(value.executionHistory!, candles, 60, chart, series, undefined, { direction: 'Long', pointValue: 2 });
    const labels: string[] = []; const rects: number[][] = [];
    const context = new Proxy({ fillText: (label: string) => labels.push(label.replace(/[\u00a0\u202f]/g, ' ')),
      fillRect: (...args: number[]) => rects.push(args) }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} });
    const renderer = primitive.paneViews!()[0].renderer()!;
    renderer.draw({ useMediaCoordinateSpace: (callback: (scope: unknown) => void) => callback({ context }) } as Parameters<typeof renderer.draw>[0]);
    return { labels, rects };
  };
  it('dostane výsledkový box od vstupu po výstup se štítkem výsledku', () => {
    const value = trade();
    value.executionHistory!.protection = [];
    const { labels, rects } = paint(value);
    expect(labels).toEqual(['+5,00 b. · +10,00 $']);
    // Box mezi vstupní (100) a výstupní (105) cenou, rozdělený chybějícími svíčkami.
    expect(rects.length).toBeGreaterThan(0);
    expect(rects.every(([, top, , height]) => top === 95 && height === 5)).toBe(true);
  });
  it('obchod se SL/TP box nedostane (má box pozice a čáry)', () => {
    const { labels, rects } = paint(trade());
    expect(labels).toEqual([]);
    expect(rects).toEqual([]);
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
  it('kopírka: SL/TP odeslané s příkazem a potvrzené úpravou při vstupu dají box', () => {
    // Skutečný tvar z Tradovate: „new“ jde jako pending před vstupem, potvrzení
    // přijde jako „modify“ pár ms po plnění. Bez toho box nikdy nevznikl.
    const value = trade();
    const [sl, tp] = value.executionHistory!.protection;
    value.executionHistory!.protection = [
      { ...sl, id: 'sl-new', at: 110_000, status: 'pending', operation: 'new' },
      { ...tp, id: 'tp-new', at: 110_000, status: 'pending', operation: 'new' },
      { ...sl, id: 'sl-ok', at: 120_140, status: 'confirmed', operation: 'modify' },
      { ...tp, id: 'tp-ok', at: 120_140, status: 'confirmed', operation: 'modify' },
      // Pozdější posun SL box nemění — box nese původní riziko.
      { ...sl, id: 'sl-trail', at: 300_000, price: 95, status: 'confirmed', operation: 'modify' },
    ];
    const box = journalPositionDrawing(value, DEFAULT_STYLE, 60)!;
    expect(box).toMatchObject({ tool: 'LongPosition' });
    expect(box.points.map(point => point.price)).toEqual([100, 110, 90]);
  });
  it('otevřená pozice (přehrávání) má box do posledního pozorovaného okamžiku, neúplná žádný', () => {
    const value = trade();
    value.executionHistory!.fills = value.executionHistory!.fills.filter(fill => fill.role === 'entry');
    value.executionHistory!.position = { id: 'p', status: 'open', openedAt: 120_123, closedAt: null, openQuantity: null, peakQuantity: 1, observedThrough: 360_000 };
    const box = journalPositionDrawing(value, DEFAULT_STYLE, 60)!;
    expect(box.points[1].time).toBe(360);
    value.executionHistory!.position = { ...value.executionHistory!.position, status: 'incomplete' };
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
