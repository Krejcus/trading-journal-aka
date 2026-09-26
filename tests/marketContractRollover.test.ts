import { describe, expect, it } from 'vitest';
import { priceDistanceFromCandle, quarterlyContractsAround } from '../services/marketDataCalculations';

describe('kontrakt obchodu v týdnu rolloveru', () => {
  it('aktuální a příští čtvrtletní kontrakt', () => {
    // 15. 9. 2026 — zářijový ještě neexpiroval (třetí pátek = 18. 9.).
    expect(quarterlyContractsAround('MNQ', Date.UTC(2026, 8, 15, 7, 23))).toEqual(['MNQU6', 'MNQZ6']);
    // Po expiraci září je aktuální prosinec.
    expect(quarterlyContractsAround('NQ', Date.UTC(2026, 8, 21, 14))).toEqual(['NQZ6', 'NQH7']);
    expect(quarterlyContractsAround('MNQ', Date.UTC(2026, 11, 30))).toEqual(['MNQH7', 'MNQM7']);
    expect(quarterlyContractsAround('MNQ', Date.UTC(2027, 0, 5))).toEqual(['MNQH7', 'MNQM7']);
  });

  it('vzdálenost ceny plnění od svíčky, ve které proběhlo', () => {
    const at = Date.UTC(2026, 8, 15, 7, 23, 40);
    const candles = [{ time: Math.floor(at / 60_000) * 60, open: 29059.5, high: 29080, low: 29055, close: 29077.25, volume: 1 }];
    expect(priceDistanceFromCandle(candles, at, 29070)).toBe(0);
    expect(priceDistanceFromCandle(candles, at, 29364.5)).toBeCloseTo(284.5);
    expect(priceDistanceFromCandle(candles, at + 3_600_000, 29070)).toBeNull();
  });
});
