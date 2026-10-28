import { describe, expect, it } from 'vitest';
import { fairValueGapsWithFormingBar, updateFairValueGapAccumulator, type MarketCandle } from '../services/marketDataCalculations';

const bar = (time: number, open: number, high: number, low: number, close: number): MarketCandle => ({ time, open, high, low, close, volume: 10 });

describe('FVG s tvořící se svíčkou (živě jako v TradingView)', () => {
  // c0 high 100, c1 silný růst, c2 low 105 → býčí FVG 100–105 (vzniká na c2).
  const c0 = bar(60, 98, 100, 97, 99);
  const c1 = bar(120, 99, 110, 99, 109);
  const c2 = bar(180, 109, 112, 105, 111);
  const c3 = bar(240, 111, 113, 108, 112);
  const stored = [c0, c1, c2, c3];

  it('dotek ceny zaplní FVG hned, ne až po uzavření svíčky; uložený výsledek se nemění', () => {
    const base = updateFairValueGapAccumulator(null, stored);
    expect(base.gaps).toHaveLength(1);
    expect(base.gaps[0]).toMatchObject({ direction: 'bullish', top: 105, bottom: 100, touched: false, mitigationSteps: [] });
    // Tvořící se c4 sjede do FVG na 103.
    const live = fairValueGapsWithFormingBar(base, stored, bar(300, 112, 112, 103, 104));
    expect(live[0]).toMatchObject({ touched: true, mitigated: false });
    expect(live[0].mitigationSteps).toEqual([expect.objectContaining({ time: 300, remainingTop: 103, remainingBottom: 100 })]);
    // Dokončená data (a tím magnet, hodnocení…) beze změny.
    expect(base.gaps[0]).toMatchObject({ touched: false, mitigationSteps: [] });
    // Svíčka se vrátí nad FVG: zaplnění zůstane jen z nejnižšího bodu (low svíčky drží 103).
    const later = fairValueGapsWithFormingBar(base, stored, bar(300, 112, 112, 103, 110));
    expect(later[0].mitigationSteps[0]).toMatchObject({ remainingTop: 103 });
    // Proražení celého FVG = zaplněno hned.
    expect(fairValueGapsWithFormingBar(base, stored, bar(300, 112, 112, 99, 101))[0].mitigated).toBe(true);
  });

  it('nové FVG vzniká už během tvořící se svíčky a dynamicky se zmenšuje', () => {
    const base = updateFairValueGapAccumulator(null, [c0, c1]);
    expect(base.gaps).toHaveLength(0);
    const forming = (low: number) => fairValueGapsWithFormingBar(base, [c0, c1], bar(180, 109, 112, low, 111));
    expect(forming(105)).toEqual([expect.objectContaining({ direction: 'bullish', top: 105, bottom: 100, startTime: 180 })]);
    // Svíčka jde níž → FVG menší.
    expect(forming(102)[0]).toMatchObject({ top: 102, bottom: 100 });
    // Pod high c0 → žádné FVG.
    expect(forming(99)).toHaveLength(0);
  });

  it('tvořící se bar se stejným časem jako poslední svíčka dat přepočítá jen ji', () => {
    const base = updateFairValueGapAccumulator(null, stored);
    // Poslední svíčka dat (c3) se ještě tvoří a teď sahá do FVG.
    const live = fairValueGapsWithFormingBar(base, stored, { ...c3, low: 101 });
    expect(live[0].mitigationSteps).toEqual([expect.objectContaining({ time: 240, remainingTop: 101 })]);
    // Beze změny OHLC = výsledek dat.
    expect(fairValueGapsWithFormingBar(base, stored, { ...c3 })).toBe(base.gaps);
    // Starší bar než data, nebo žádný = výsledek dat.
    expect(fairValueGapsWithFormingBar(base, stored, bar(180, 1, 2, 0, 1))).toBe(base.gaps);
    expect(fairValueGapsWithFormingBar(base, stored, null)).toBe(base.gaps);
    expect(fairValueGapsWithFormingBar(null, stored, bar(300, 1, 2, 0, 1))).toEqual([]);
  });
});
