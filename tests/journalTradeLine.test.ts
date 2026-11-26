// Spojnice vstup → výstup v LIVE grafu (26. 11. 2026): kreslí se jen u zavřeného obchodu a jen na vyžádání.
import { describe, expect, it } from 'vitest';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { createJournalChartPrimitive } from '../services/journalChartPrimitive';
import { liveFillHistory, type LiveFillMarker } from '../lib/liveFillMarkers';

const candles = [60, 120, 360, 420].map(time => ({ time, open: 100, high: 110, low: 90, close: 105, volume: 1 }));
const fill = (patch: Partial<LiveFillMarker>): LiveFillMarker => ({ id: 'f', orderId: 'o', at: 120_123, price: 100, side: 'Buy', role: 'entry', quantity: 1, ...patch });
const long = [fill({ id: 'in', orderId: 'in' }), fill({ id: 'out', orderId: 'out', at: 420_789, price: 105, side: 'Sell', role: 'exit' })];
const plain = (text: string) => text.replace(/[  ]/g, ' ');

function setup(fills: LiveFillMarker[], open: boolean, options: { tradeLine?: boolean; pointValue?: number } = { tradeLine: true }) {
  let onMove: ((param: { point?: { x: number; y: number } }) => void) | null = null;
  const chart = { timeScale: () => ({ logicalToCoordinate: (index: number) => 100 + index * 20, coordinateToLogical: (px: number) => (px - 100) / 20 }),
    subscribeCrosshairMove: (handler: typeof onMove) => { onMove = handler; }, unsubscribeCrosshairMove: () => {} } as unknown as IChartApi;
  const series = { priceToCoordinate: (price: number) => 200 - price } as unknown as ISeriesApi<'Candlestick'>;
  const primitive = createJournalChartPrimitive(liveFillHistory(fills, open)!, candles, 60, chart, series, undefined,
    { direction: 'Long', resultBox: false, hideResultLabel: true, pointValue: 2, ...options });
  primitive.attached!({ requestUpdate: () => {} } as unknown as Parameters<NonNullable<typeof primitive.attached>>[0]);
  const labels: string[] = [];
  const dashed: Array<Array<[number, number]>> = [];
  let path: Array<[number, number]> = [];
  let dash: number[] = [];
  const context = new Proxy({
    fillText: (label: string) => labels.push(plain(label)),
    setLineDash: (value: number[]) => { dash = value; },
    beginPath: () => { path = []; },
    moveTo: (a: number, b: number) => path.push([a, b]),
    lineTo: (a: number, b: number) => path.push([a, b]),
    stroke: () => { if (dash.join() === '3,4') dashed.push(path); },
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} });
  const renderer = primitive.paneViews!()[0].renderer()!;
  const draw = () => { labels.length = 0; dashed.length = 0; renderer.draw({ useMediaCoordinateSpace: (callback: (scope: unknown) => void) => callback({ context }) } as Parameters<typeof renderer.draw>[0]); };
  return { draw, labels, dashed, move: (px: number, py: number) => onMove!({ point: { x: px, y: py } }), tap: primitive.hoverAt };
}

describe('spojnice vstupu a výstupu', () => {
  it('zavřený obchod: čára od průměrného vstupu k průměrnému výstupu, štítek až po najetí', () => {
    const { draw, labels, dashed, move } = setup(long, false);
    draw();
    expect(dashed).toEqual([[[120, 100], [160, 95]]]);
    expect(labels).toEqual([]);
    move(140, 97.5 + 5);
    draw();
    expect(labels).toEqual(['Vstup 100,00 → Výstup 105,00 · +5,00 b. · +10,00 $']);
    move(140, 150);
    draw();
    expect(labels).toEqual([]);
  });
  it('klepnutí na telefonu (hoverAt) ukáže totéž a klepnutí jinam štítek schová', () => {
    const { draw, labels, tap } = setup(long, false);
    draw();
    tap({ x: 140, y: 97.5 });
    draw();
    expect(labels).toHaveLength(1);
    tap(null);
    draw();
    expect(labels).toEqual([]);
  });
  it('short s dílčími výstupy: průměr vážený množstvím a hodnota bodu kontraktu', () => {
    const fills = [
      fill({ id: 'in', orderId: 'in', side: 'Sell', quantity: 2, price: 110 }),
      fill({ id: 'o1', orderId: 'o1', at: 360_500, side: 'Buy', role: 'exit', price: 104 }),
      fill({ id: 'o2', orderId: 'o2', at: 420_789, side: 'Buy', role: 'exit', price: 108 }),
    ];
    const { draw, labels, dashed, move } = setup(fills, false, { tradeLine: true, pointValue: 20 });
    draw();
    expect(dashed).toEqual([[[120, 90], [160, 94]]]);
    // x 140 je svíčka s dílčím výstupem (ta má přednost) — najetí mezi svíčky.
    move(130, 91);
    draw();
    expect(labels).toEqual(['Vstup 110,00 → Výstup 106,00 · +4,00 b. · +160,00 $']);
  });
  it('otevřený obchod a vypnutá volba spojnici nekreslí', () => {
    const openTrade = setup(long, true);
    openTrade.draw();
    expect(openTrade.dashed).toEqual([]);
    const off = setup(long, false, { tradeLine: false });
    off.draw();
    off.move(140, 97.5);
    off.draw();
    expect(off.dashed).toEqual([]);
    expect(off.labels).toEqual([]);
  });
  it('šipka má před spojnicí přednost', () => {
    const { draw, labels, move } = setup(long, false);
    draw();
    // Šipka vstupu stojí pod low svíčky (y 110) na x 120.
    move(120, 118);
    draw();
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/^Vstup · Buy 1 · 100,00/);
  });
});
