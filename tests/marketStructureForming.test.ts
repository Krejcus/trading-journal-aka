import { describe, expect, it } from 'vitest';
import {
  calculateMarketStructure,
  marketStructureWithFormingBars,
  updateMarketStructureAccumulator,
  type MarketCandle,
} from '../services/marketData';
import { validateWorkspaceAppearance } from '../services/chartWorkspaceAppearanceValidation';

const candle = (time: number, open: number, high: number, low: number, close: number): MarketCandle =>
  ({ time, open, high, low, close, volume: 1 });

// Pivot high 13 na baru 180 (potvrzený barem 240), poslední data = bar 240.
const input = [
  candle(0, 10, 11, 9, 10.5), candle(60, 10.5, 12, 10, 11.5),
  candle(120, 11.5, 12.5, 11, 12), candle(180, 12, 13, 11.5, 12.5),
  candle(240, 12.5, 12.8, 11.8, 12.2),
];

describe('marketStructureWithFormingBars', () => {
  it('zlom z tvořící se svíčky se ukáže nad pivotem a zmizí, když se cena vrátí', () => {
    const base = updateMarketStructureAccumulator(null, input);
    const before = base.events.length;
    const above = marketStructureWithFormingBars(base, input, [candle(300, 12.2, 13.4, 12.1, 13.3)]);
    expect(above.at(-1)).toMatchObject({ direction: 'bullish', pivotTime: 180, breakTime: 300, price: 13 });
    expect(above).toHaveLength(before + 1);
    // Knot nad pivotem nestačí — rozhoduje zavření (cena) tvořící se svíčky.
    const back = marketStructureWithFormingBars(base, input, [candle(300, 12.2, 13.4, 12.1, 12.9)]);
    expect(back).toEqual(base.events);
    // Akumulátor dat zůstal beze změny.
    expect(base.events).toHaveLength(before);
    expect(base.candleCount).toBe(input.length);
  });

  it('přepsaný poslední bar dat se počítá ze stavu před ním', () => {
    const closedAbove = [...input.slice(0, -1), candle(240, 12.5, 12.8, 11.8, 12.2), candle(300, 12.2, 13.4, 12.1, 13.3)];
    const base = updateMarketStructureAccumulator(null, closedAbove);
    expect(base.events.at(-1)).toMatchObject({ breakTime: 300 });
    // Graf má poslední svíčku čerstvější než data: cena se vrátila pod pivot.
    const back = candle(300, 12.2, 13.4, 12.1, 12.7);
    expect(marketStructureWithFormingBars(base, closedAbove, [back]))
      .toEqual(calculateMarketStructure([...closedAbove.slice(0, -1), back]));
    expect(marketStructureWithFormingBars(base, closedAbove, [back]).some(event => event.breakTime === 300)).toBe(false);
  });

  it('na přelomu minuty počítá dokončenou živou svíčku i novou tvořící se', () => {
    const base = updateMarketStructureAccumulator(null, input);
    const tail = [candle(240, 12.5, 12.9, 11.8, 12.6), candle(300, 12.6, 13.5, 12.5, 13.2)];
    expect(marketStructureWithFormingBars(base, input, tail))
      .toEqual(calculateMarketStructure([...input.slice(0, -1), ...tail]));
  });

  it('beze změny konce řady vrací zlomy dat', () => {
    const base = updateMarketStructureAccumulator(null, input);
    expect(marketStructureWithFormingBars(base, input, [])).toBe(base.events);
    expect(marketStructureWithFormingBars(base, input, [input.at(-1)!])).toBe(base.events);
    expect(marketStructureWithFormingBars(null, input, [candle(300, 1, 2, 0, 1)])).toEqual([]);
  });

  it('odpovídá plnému výpočtu pro libovolnou tvořící se svíčku', () => {
    let seed = 7;
    const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
    let price = 100;
    const series: MarketCandle[] = Array.from({ length: 160 }, (_, index) => {
      const open = price;
      const close = open + (random() - 0.5) * 6;
      price = close;
      return candle(index * 60, open, Math.max(open, close) + random() * 2, Math.min(open, close) - random() * 2, close);
    });
    for (let end = 20; end <= series.length; end += 7) {
      const data = series.slice(0, end);
      const base = updateMarketStructureAccumulator(null, data);
      // Stejný bar jinak (přepsaný) i jeden až dva bary navíc.
      const last = data.at(-1)!;
      const replaced = candle(last.time, last.open, last.high + random() * 4, last.low - random() * 4, last.close + (random() - 0.5) * 8);
      const next = candle(last.time + 60, replaced.close, replaced.close + 3, replaced.close - 3, replaced.close + (random() - 0.5) * 6);
      for (const tail of [[replaced], [replaced, next], [next]]) {
        const expected = calculateMarketStructure([...data.filter(bar => bar.time < tail[0].time), ...tail]);
        expect(marketStructureWithFormingBars(base, data, tail)).toEqual(expected);
      }
    }
  });

  it('postupné přidávání dat drží stav pro přepsání posledního baru', () => {
    let state = updateMarketStructureAccumulator(null, input.slice(0, 3));
    for (let end = 4; end <= input.length; end += 1) state = updateMarketStructureAccumulator(state, input.slice(0, end));
    const replaced = candle(240, 12.5, 13.6, 11.8, 13.5);
    expect(marketStructureWithFormingBars(state, input, [replaced]))
      .toEqual(calculateMarketStructure([...input.slice(0, -1), replaced]));
  });
});

describe('BoS/CHoCH bez textu', () => {
  it('uložené nastavení „Bez textu“ projde validací vzhledu', () => {
    expect(() => validateWorkspaceAppearance({ indicatorSettings: { structure: { textSize: 'none' } } })).not.toThrow();
    expect(() => validateWorkspaceAppearance({ indicatorSettings: { structure: { textSize: 'huge' } } })).toThrow();
  });
});
