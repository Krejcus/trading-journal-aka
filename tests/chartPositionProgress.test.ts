import { describe, expect, it } from 'vitest';
import type { MarketCandle } from '../services/marketData';
import { calculatePositionProgress } from '../services/chartPositionProgress';
import { normalizePositionSettings, type PositionDrawing } from '../services/chartPositionDrawing';

const candle = (time: number, open: number, high: number, low: number, close: number): MarketCandle => ({
  time, open, high, low, close, volume: 1,
});

const position = (tool: PositionDrawing['tool'] = 'LongPosition'): PositionDrawing => ({
  id: 'position',
  tool,
  points: tool === 'LongPosition'
    ? [{ time: 120, price: 100 }, { time: 600, price: 110 }, { time: 600, price: 95 }]
    : [{ time: 120, price: 100 }, { time: 600, price: 90 }, { time: 600, price: 105 }],
  style: { color: '#787b86', width: 1, dashed: false, fill: null, position: normalizePositionSettings({}) },
});

describe('position replay progress', () => {
  it('stays hidden until a replay candle touches entry', () => {
    expect(calculatePositionProgress(position(), [
      candle(120, 98, 99, 97, 98),
      candle(180, 98, 99.75, 97.5, 99),
    ])).toBeNull();
  });

  it('starts on the entry-hit candle and follows the latest close without changing drawing anchors', () => {
    const drawing = position();
    const originalPoints = structuredClone(drawing.points);
    expect(calculatePositionProgress(drawing, [
      candle(120, 98, 99, 97, 98),
      candle(180, 99, 101, 98.5, 100.5),
      candle(240, 100.5, 104, 100, 103),
    ])).toEqual({
      entryTime: 180,
      currentTime: 240,
      entryPrice: 100,
      currentPrice: 103,
      outcome: 'open',
      profitable: true,
    });
    expect(drawing.points).toEqual(originalPoints);
  });

  it('colors an open short by its current side of entry', () => {
    expect(calculatePositionProgress(position('ShortPosition'), [
      candle(120, 101, 102, 99, 100),
      candle(180, 100, 101, 96, 97),
    ])?.profitable).toBe(true);
  });

  it('freezes at the first terminal hit and uses conservative stop-first ordering', () => {
    expect(calculatePositionProgress(position(), [
      candle(120, 100, 101, 99, 100),
      candle(180, 100, 111, 94, 106),
      candle(240, 106, 120, 105, 119),
    ])).toMatchObject({ currentTime: 180, currentPrice: 95, outcome: 'stop', profitable: false });
  });

  it('stops the progress line and fill at the visual right edge of the box', () => {
    const drawing = position();
    drawing.points[1].time = 240;
    drawing.points[2].time = 240;
    expect(calculatePositionProgress(drawing, [
      candle(120, 99, 101, 98, 100),
      candle(180, 100, 104, 99, 103),
      candle(240, 103, 106, 102, 105),
      candle(300, 105, 109, 104, 108),
    ])).toMatchObject({ currentTime: 240, currentPrice: 105, outcome: 'open' });
  });

  // Renderer volá tuhle funkci pro každou pozici při každém překreslení.
  // Původně kopírovala filtrem celé pole svíček, což při scrollu do historie
  // zamrzlo hlavní vlákno na desítky sekund. Půlení intervalu musí dávat
  // identické výsledky i na svíčkách mimo rozsah pozice.
  describe('vyhledávání úseku (regrese výkonu)', () => {
    const withPadding = (inner: MarketCandle[]): MarketCandle[] => [
      candle(0, 50, 51, 49, 50),
      candle(60, 50, 51, 49, 50),
      ...inner,
      candle(3000, 200, 201, 199, 200),
      candle(3060, 200, 201, 199, 200),
    ];

    it('ignoruje svíčky před vstupem i za koncem boxu', () => {
      const inner = [
        candle(120, 99, 101, 98, 100),
        candle(180, 100, 104, 99, 103),
      ];
      const drawing = position();
      drawing.points[1].time = 180;
      drawing.points[2].time = 180;
      const bare = calculatePositionProgress(drawing, inner);
      const padded = calculatePositionProgress(drawing, withPadding(inner));
      expect(padded).toEqual(bare);
      expect(padded).toMatchObject({ currentTime: 180, outcome: 'open' });
    });

    it('najde vstup i uprostřed dlouhé historie', () => {
      const many: MarketCandle[] = [];
      for (let i = 0; i < 5000; i += 1) many.push(candle(i * 60, 50, 51, 49, 50));
      many[2000] = candle(2000 * 60, 99, 101, 98, 100); // dotyk vstupu na 100
      const drawing = position();
      drawing.points[0].time = 2000 * 60;
      drawing.points[1].time = 2100 * 60;
      drawing.points[2].time = 2100 * 60;
      expect(calculatePositionProgress(drawing, many)).toMatchObject({
        entryTime: 2000 * 60,
        outcome: 'open',
      });
    });
  });
});
