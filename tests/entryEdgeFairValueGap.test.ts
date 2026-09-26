import { describe, expect, it } from 'vitest';
import { findEntryEdgeFairValueGap, type MarketCandle } from '../services/marketDataCalculations';

const T0 = 1_790_000_000 - (1_790_000_000 % 60);
const bar = (minute: number, low: number, high: number, open = low, close = high): MarketCandle => ({ time: T0 + minute * 60, open, high, low, close, volume: 1 });
// Býčí FVG [100, 102]: 1. svíčka high 100, 3. svíčka low 102.
const bullish = (after: MarketCandle[]) => [bar(0, 98, 100), bar(1, 99.5, 106, 100, 105), bar(2, 102, 107), ...after];

describe('FVG vstupu na hraně (±1 tick, nevyplněný, do dne)', () => {
  it('long přesně na horní hraně i o tick vedle', () => {
    const candles = bullish([bar(3, 104, 108), bar(4, 103, 107)]);
    expect(findEntryEdgeFairValueGap(candles, T0 + 5 * 60 + 12, 102, 'long')).toMatchObject({ direction: 'bullish', top: 102, bottom: 100 });
    expect(findEntryEdgeFairValueGap(candles, T0 + 5 * 60 + 12, 102.25, 'long')).not.toBeNull();
    expect(findEntryEdgeFairValueGap(candles, T0 + 5 * 60 + 12, 102.5, 'long')).toBeNull();
  });
  it('vstup uprostřed zóny není „na hraně“', () => {
    expect(findEntryEdgeFairValueGap(bullish([bar(3, 104, 108)]), T0 + 4 * 60, 101, 'long')).toBeNull();
  });
  it('po částečném vyplnění platí zbývající hrana', () => {
    const candles = bullish([bar(3, 101.5, 106)]);
    expect(findEntryEdgeFairValueGap(candles, T0 + 4 * 60, 101.5, 'long')).not.toBeNull();
    expect(findEntryEdgeFairValueGap(candles, T0 + 4 * 60, 102, 'long')).toBeNull();
  });
  it('vyplněný před vstupem se nepočítá; svíčka vstupu se do stavu nezapočítá', () => {
    expect(findEntryEdgeFairValueGap(bullish([bar(3, 99.5, 106)]), T0 + 4 * 60, 100, 'long')).toBeNull();
    // Vyplnění až ve svíčce vstupu (minuta 3) — v okamžiku vstupu ještě platil.
    expect(findEntryEdgeFairValueGap(bullish([bar(3, 99.5, 106)]), T0 + 3 * 60 + 20, 102, 'long')).not.toBeNull();
  });
  it('starší než den se nehledá', () => {
    const candles = bullish([bar(3, 104, 108)]);
    expect(findEntryEdgeFairValueGap(candles, T0 + 27 * 3600, 102, 'long')).toBeNull();
    expect(findEntryEdgeFairValueGap(candles, T0 + 20 * 3600, 102, 'long')).not.toBeNull();
  });
  it('short na spodní hraně medvědího FVG; long na medvědím nic', () => {
    // Medvědí FVG [98, 100]: 1. svíčka low 100, 3. svíčka high 98.
    const candles = [bar(0, 100, 102), bar(1, 94, 100.5, 100, 95), bar(2, 93, 98), bar(3, 92, 96)];
    expect(findEntryEdgeFairValueGap(candles, T0 + 4 * 60, 98, 'short')).toMatchObject({ direction: 'bearish' });
    expect(findEntryEdgeFairValueGap(candles, T0 + 4 * 60, 98, 'long')).toBeNull();
  });
});
