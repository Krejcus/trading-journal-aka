/**
 * Index svíčky časově nejbližší `target` (svíčky seřazené vzestupně podle času).
 * Binární hledání — graf ho volá pro každou událost struktury/FVG při každém
 * kroku přehrávání; lineární průchod 15k svíček × stovky událostí sekal graf.
 * Při stejné vzdálenosti vyhrává dřívější svíčka (stejně jako dřívější
 * lineární verze).
 */
export function nearestCandleIndex(candles: ReadonlyArray<{ time: number }>, target: number): number {
  const count = candles.length;
  if (count <= 1) return 0;
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (candles[middle].time < target) low = middle + 1;
    else high = middle;
  }
  if (low <= 0) return 0;
  if (low >= count) return count - 1;
  const before = Math.abs(candles[low - 1].time - target);
  const after = Math.abs(candles[low].time - target);
  return after < before ? low : low - 1;
}
