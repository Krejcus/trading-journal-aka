import { describe, expect, it } from 'vitest';
import type { MarketCandle } from '../services/marketData';
import { logicalRangeCenteredOn, logicalRangeForLastSeconds } from '../services/chartWorkspaceRange';

const minuteSeries = (count: number, start = 1_700_000_000): MarketCandle[] =>
  Array.from({ length: count }, (_, index) => ({
    time: start + index * 60, open: 1, high: 1, low: 1, close: 1, volume: 0,
  }));

describe('logicalRangeForLastSeconds — rychlé rozsahy ve spodním řádku', () => {
  it('hodina na 1m grafu ukáže posledních 60 svíček a místo vpravo', () => {
    const candles = minuteSeries(500);
    expect(logicalRangeForLastSeconds(candles, 3_600)).toEqual({ from: 439, to: 505 });
  });

  it('„Vše“ začíná první svíčkou', () => {
    expect(logicalRangeForLastSeconds(minuteSeries(500), null)).toEqual({ from: 0, to: 505 });
  });

  it('počítá přes indexy, takže díra v datech rozsah nerozbije', () => {
    const candles = [...minuteSeries(100), ...minuteSeries(100, 1_700_000_000 + 100 * 60 + 3_600)];
    const range = logicalRangeForLastSeconds(candles, 3_600)!;
    // Poslední hodina reálného času = jen svíčky po díře.
    expect(range.from).toBe(139);
    expect(range.to).toBe(205);
  });

  it('krátký rozsah na hrubém timeframu nechá aspoň deset svíček', () => {
    const fiveMinute = Array.from({ length: 50 }, (_, index) => ({
      time: 1_700_000_000 + index * 300, open: 1, high: 1, low: 1, close: 1, volume: 0,
    }));
    expect(logicalRangeForLastSeconds(fiveMinute, 1_800)!.from).toBe(39);
  });

  it('bez dat nic', () => {
    expect(logicalRangeForLastSeconds([], 3_600)).toBeNull();
  });
});

describe('logicalRangeCenteredOn — Go to datum', () => {
  it('vycentruje nejbližší svíčku a drží šířku pohledu', () => {
    const candles = minuteSeries(500);
    expect(logicalRangeCenteredOn(candles, candles[200].time + 20, 100)).toEqual({ from: 150, to: 250 });
    expect(logicalRangeCenteredOn(candles, candles[200].time + 40, 100)).toEqual({ from: 151, to: 251 });
  });

  it('čas mimo načtená data vrací null', () => {
    const candles = minuteSeries(10);
    expect(logicalRangeCenteredOn(candles, candles[0].time - 60, 100)).toBeNull();
    expect(logicalRangeCenteredOn(candles, candles[9].time + 60, 100)).toBeNull();
  });
});
