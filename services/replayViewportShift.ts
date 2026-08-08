import type { MarketCandle } from './marketData';

/**
 * O kolik barů se posunulo replay okno, když se vyměnila data grafu.
 *
 * Viewport se po výměně nesmí obnovovat přes časy: `setVisibleRange` vyžaduje,
 * aby hraniční čas padl na existující bar, jenže časová osa je děravá (víkendy,
 * pauzy mezi sessions). Knihovna si pak rozsah upravila po svém a graf skočil —
 * jednou o hodiny doleva, jindy rovnou na poslední svíčku. Posun okna přitom
 * známe přesně, takže se dá obnovit logický rozsah.
 *
 * Kladné číslo = okno se rozrostlo doleva (prepend), bary se posunuly doprava.
 * Záporné = okno se ořízlo zleva (limit vykreslovaných barů).
 */
export const replayBarShift = (params: {
  /** Časy barů, které graf držel PŘED výměnou, v sekundách. */
  previousFirstSeconds: number;
  /** Bary, které graf dostane po výměně. */
  nextCandles: Pick<MarketCandle, 'time'>[];
  /** Časy barů PŘED výměnou (kvůli ořezu zleva), v sekundách, vzestupně. */
  previousTimesSeconds: number[];
}): number => {
  const { previousFirstSeconds, nextCandles, previousTimesSeconds } = params;
  const nextFirst = nextCandles[0]?.time;
  if (nextFirst === undefined || !Number.isFinite(previousFirstSeconds)) return 0;

  if (nextFirst < previousFirstSeconds) {
    let low = 0;
    let high = nextCandles.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (nextCandles[middle].time < previousFirstSeconds) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  if (nextFirst > previousFirstSeconds) {
    const dropped = previousTimesSeconds.findIndex(time => time >= nextFirst);
    return dropped > 0 ? -dropped : 0;
  }

  return 0;
};
