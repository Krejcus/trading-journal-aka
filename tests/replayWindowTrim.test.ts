import { describe, expect, it } from 'vitest';
import { replayTrimStartIndex } from '../services/replayWindowTrim';

/**
 * Regrese na skok grafu dopředu po dotažení starší historie.
 *
 * Okno se po prependu ořezávalo vždy na posledních `maxBars`, tedy ke konci
 * dat — jenže historie se dotahuje právě tehdy, když je uživatel scrollem
 * hluboko v minulosti. Reprodukováno na živé session: pohled na 00:00–02:00
 * skončil na 14:00–15:00.
 */
describe('replayTrimStartIndex', () => {
  const maxBars = 4500;
  const chunk = 500;

  it('uživatele v historii nechá na místě (nekotví na konec dat)', () => {
    // Okno 0..12000, uživatel se dívá kolem indexu 900 od začátku okna.
    const start = replayTrimStartIndex({
      windowStart: 0, windowEnd: 12_000, visibleTo: 900, maxBars, chunk,
    });
    // Bez opravy by vyšlo 12000 − 4500 = 7500, tedy skok o tisíce barů dopředu.
    expect(start).toBe(0);
    expect(start).toBeLessThan(7_500);
  });

  it('okno vždy obsáhne pohled i rezervu na další scroll', () => {
    const windowStart = 1_000;
    const visibleTo = 4_800;
    const start = replayTrimStartIndex({
      windowStart, windowEnd: 20_000, visibleTo, maxBars, chunk,
    });
    const viewEnd = windowStart + visibleTo;
    expect(start).toBeLessThanOrEqual(viewEnd);          // pohled zůstal uvnitř
    expect(start + maxBars).toBeGreaterThanOrEqual(viewEnd + chunk);
  });

  it('u pohledu na konci dat se chová jako dřív', () => {
    const start = replayTrimStartIndex({
      windowStart: 0, windowEnd: 10_000, visibleTo: 9_900, maxBars, chunk,
    });
    expect(start).toBe(10_000 - maxBars);
  });

  it('bez známého viewportu zachová původní ořez od konce', () => {
    expect(replayTrimStartIndex({
      windowStart: 0, windowEnd: 10_000, visibleTo: null, maxBars, chunk,
    })).toBe(5_500);
    expect(replayTrimStartIndex({
      windowStart: 0, windowEnd: 10_000, visibleTo: NaN, maxBars, chunk,
    })).toBe(5_500);
  });

  it('nikdy nevrátí záporný index', () => {
    expect(replayTrimStartIndex({
      windowStart: 0, windowEnd: 100, visibleTo: 10, maxBars, chunk,
    })).toBe(0);
  });

  it('nepřeteče za konec dat', () => {
    const windowEnd = 6_000;
    const start = replayTrimStartIndex({
      windowStart: 0, windowEnd, visibleTo: 99_999, maxBars, chunk,
    });
    expect(start).toBe(windowEnd - maxBars);
  });
});
