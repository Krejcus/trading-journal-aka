import { describe, expect, it } from 'vitest';
import { replayBarShift } from '../services/replayViewportShift';

const times = (...seconds: number[]) => seconds.map(time => ({ time }));

/**
 * Regrese na skákání grafu po načtení starší historie.
 *
 * Naměřeno na živé session: obnova viewportu přes `setVisibleRange` (časy)
 * skončila jednou o 13 hodin vedle a jednou rovnou na poslední svíčce, protože
 * hraniční čas nepadl na existující bar. Posun se proto počítá v barech.
 */
describe('replayBarShift', () => {
  it('prepend posune bary doprava o počet přidaných', () => {
    expect(replayBarShift({
      previousFirstSeconds: 300,
      nextCandles: times(60, 120, 180, 240, 300, 360),
      previousTimesSeconds: [300, 360],
    })).toBe(4);
  });

  it('ořez zleva posune bary doleva o počet odebraných', () => {
    expect(replayBarShift({
      previousFirstSeconds: 60,
      nextCandles: times(180, 240, 300),
      previousTimesSeconds: [60, 120, 180, 240, 300],
    })).toBe(-2);
  });

  it('beze změny prvního baru je posun nulový', () => {
    expect(replayBarShift({
      previousFirstSeconds: 120,
      nextCandles: times(120, 180, 240),
      previousTimesSeconds: [120, 180],
    })).toBe(0);
  });

  it('zvládne díru v časové ose (víkend) — počítá bary, ne čas', () => {
    // Mezi 180 a 100 000 je pauza; posun musí odpovídat počtu barů, ne rozdílu času.
    expect(replayBarShift({
      previousFirstSeconds: 100_000,
      nextCandles: times(60, 120, 180, 100_000, 100_060),
      previousTimesSeconds: [100_000, 100_060],
    })).toBe(3);
  });

  it('prázdná data nebo neplatný čas nic neposunou', () => {
    expect(replayBarShift({ previousFirstSeconds: 120, nextCandles: [], previousTimesSeconds: [] })).toBe(0);
    expect(replayBarShift({ previousFirstSeconds: NaN, nextCandles: times(60), previousTimesSeconds: [] })).toBe(0);
  });

  it('ořez až za konec starých dat neposune (nelze určit)', () => {
    expect(replayBarShift({
      previousFirstSeconds: 60,
      nextCandles: times(9_999),
      previousTimesSeconds: [60, 120],
    })).toBe(0);
  });
});
