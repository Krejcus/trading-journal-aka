/**
 * Cesta ceny uvnitř 1m svíčky pro animaci přehrávání.
 *
 * Z 1m dat neznáme pořadí high a low. Tam, kde na pořadí záleží — ve svíčce
 * s plněním obchodu — ho ale známe: plnění má přesný čas i cenu, takže cesta
 * jím v tom okamžiku projde („dřív SL než TP“ tak nikdy nebude obráceně).
 * Zbylé extrémy doplní obvyklý odhad (býčí svíčka: nejdřív low, pak high;
 * medvědí naopak). Konec je vždy skutečná svíčka.
 */

export interface ReplayCandle { time: number; open: number; high: number; low: number; close: number; volume: number }
/** Bod cesty: `at` = zlomek minuty 0–1, `price` = cena. */
export interface PathPoint { at: number; price: number }

const EPSILON = 1e-9;

export function candleReplayPath(candle: ReplayCandle, fills: ReadonlyArray<{ at: number; price: number }> = []): PathPoint[] {
  const clamp = (price: number) => Math.min(candle.high, Math.max(candle.low, price));
  const startMs = candle.time * 1000;
  // Plnění uvnitř minuty jako pevné body (cena oříznutá do rozsahu svíčky —
  // chrání před nesouladem kontraktu nebo zaokrouhlení).
  const anchors = fills
    .map(fill => ({ at: (fill.at - startMs) / 60_000, price: clamp(fill.price) }))
    .filter(point => point.at > EPSILON && point.at < 1 - EPSILON)
    .sort((a, b) => a.at - b.at);
  const points: PathPoint[] = [{ at: 0, price: clamp(candle.open) }, ...anchors, { at: 1, price: clamp(candle.close) }];
  const reaches = (price: number) => points.some(point => Math.abs(point.price - price) < EPSILON);
  const bullish = candle.close >= candle.open;
  const order = (bullish ? [candle.low, candle.high] : [candle.high, candle.low]).filter(price => !reaches(price));
  // Každý chybějící extrém do nejdelší volné mezery (druhý až po prvním).
  let after = 0;
  for (const extreme of order) {
    let best: { index: number; length: number } | null = null;
    for (let index = 0; index < points.length - 1; index += 1) {
      if (points[index + 1].at <= after + EPSILON) continue;
      const from = Math.max(points[index].at, after);
      const length = points[index + 1].at - from;
      if (!best || length > best.length) best = { index, length };
    }
    if (!best) break;
    const from = Math.max(points[best.index].at, after);
    const at = from + best.length / 2;
    points.splice(best.index + 1, 0, { at, price: extreme });
    after = at;
  }
  return points;
}

/** Rozpracovaná svíčka v čase `progress` (0–1) podle cesty. */
export function partialReplayCandle(candle: ReplayCandle, path: readonly PathPoint[], progress: number): ReplayCandle {
  const t = Math.min(1, Math.max(0, progress));
  if (t >= 1) return candle;
  let price = path[0].price;
  let high = path[0].price;
  let low = path[0].price;
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const point = path[index];
    if (point.at <= t) {
      high = Math.max(high, point.price); low = Math.min(low, point.price); price = point.price;
      continue;
    }
    const span = point.at - previous.at;
    price = span > 0 ? previous.price + (point.price - previous.price) * ((t - previous.at) / span) : point.price;
    high = Math.max(high, price); low = Math.min(low, price);
    break;
  }
  return { time: candle.time, open: candle.open, high, low, close: price, volume: candle.volume * t };
}
