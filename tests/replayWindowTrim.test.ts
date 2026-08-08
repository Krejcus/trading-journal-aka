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
      windowStart: 0, windowEnd: 12_000, viewEndIndex: 900, maxBars, chunk,
    });
    // Bez opravy by vyšlo 12000 − 4500 = 7500, tedy skok o tisíce barů dopředu.
    expect(start).toBe(0);
    expect(start).toBeLessThan(7_500);
  });

  it('okno vždy obsáhne pohled i rezervu na další scroll', () => {
    const windowStart = 1_000;
    const viewEndIndex = 5_800;
    const start = replayTrimStartIndex({
      windowStart, windowEnd: 20_000, viewEndIndex, maxBars, chunk,
    });
    const viewEnd = viewEndIndex;
    expect(start).toBeLessThanOrEqual(viewEnd);          // pohled zůstal uvnitř
    expect(start + maxBars).toBeGreaterThanOrEqual(viewEnd + chunk);
  });

  it('u pohledu na konci dat se chová jako dřív', () => {
    const start = replayTrimStartIndex({
      windowStart: 0, windowEnd: 10_000, viewEndIndex: 9_900, maxBars, chunk,
    });
    expect(start).toBe(10_000 - maxBars);
  });

  // Na hranici historie hlásí graf prázdný viditelný rozsah. Kotva na konec dat
  // tam uživatele odhodila dopředu (z 1. 7. na 3. 7.), takže se ořezává zprava.
  it('bez známého viewportu ořízne zprava a nechá začátek okna být', () => {
    expect(replayTrimStartIndex({
      windowStart: 2_000, windowEnd: 10_000, viewEndIndex: null, maxBars, chunk,
    })).toBe(2_000);
    expect(replayTrimStartIndex({
      windowStart: 2_000, windowEnd: 10_000, viewEndIndex: NaN, maxBars, chunk,
    })).toBe(2_000);
  });

  it('nikdy nevrátí záporný index', () => {
    expect(replayTrimStartIndex({
      windowStart: 0, windowEnd: 100, viewEndIndex: 10, maxBars, chunk,
    })).toBe(0);
  });

  // Prepend posune celé pole: okno i pohled musí být ve STEJNÉ soustavě.
  // Když se index pohledu bral z grafu (staré bary) a okno z nového pole,
  // kotva se posunula o celý prepend a graf odskočil o dny dopředu.
  it('po prependu drží kotvu u pohledu, ne u konce dat', () => {
    const prepended = 8_000;              // přibylo vlevo
    const viewEndIndex = prepended + 600; // uživatel se dívá hned za prependem
    const start = replayTrimStartIndex({
      windowStart: 0, windowEnd: prepended + 12_000, viewEndIndex, maxBars, chunk,
    });
    expect(start).toBeLessThanOrEqual(viewEndIndex);
    expect(start + maxBars).toBeGreaterThanOrEqual(viewEndIndex + chunk);
    expect(start).toBeLessThan(prepended + 12_000 - maxBars); // ne kotva na konci
  });

  it('nepřeteče za konec dat', () => {
    const windowEnd = 6_000;
    const start = replayTrimStartIndex({
      windowStart: 0, windowEnd, viewEndIndex: 99_999, maxBars, chunk,
    });
    expect(start).toBe(windowEnd - maxBars);
  });
});
