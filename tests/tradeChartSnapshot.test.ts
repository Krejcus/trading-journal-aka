import { describe, expect, it } from 'vitest';
import { barIndexAt, centeredTradeRange, snapshotPriceRange } from '../lib/tradeChartSnapshot';

describe('výřez snímku obchodu', () => {
  it('pevný rozestup svíček: krátký i středně dlouhý obchod mají stejný počet barů, obchod uprostřed', () => {
    const short = centeredTradeRange(100, 105);
    const medium = centeredTradeRange(100, 160);
    expect(short.to - short.from).toBe(100);
    expect(medium.to - medium.from).toBe(100);
    expect((short.from + short.to) / 2).toBe(102.5);
    expect((medium.from + medium.to) / 2).toBe(130);
  });
  it('dlouhý obchod se oddálí, ale s rezervou na obou stranách', () => {
    const long = centeredTradeRange(0, 300);
    expect(long.from).toBeLessThanOrEqual(-10);
    expect(long.to).toBeGreaterThanOrEqual(310);
  });
  it('najde poslední bar, který začal nejpozději v daném čase', () => {
    expect(barIndexAt([0, 60, 120], 90)).toBe(1);
    expect(barIndexAt([0, 60, 120], -1)).toBe(-1);
  });

  it('cenový rozsah vždy obsahuje SL i TP', () => {
    const view = [{ high: 110, low: 100 }, { high: 112, low: 104 }];
    expect(snapshotPriceRange(view, { entryPrice: 105, exitPrice: 108, stopLoss: 98, takeProfit: 160 })).toEqual({ high: 160, low: 98 });
  });
});
