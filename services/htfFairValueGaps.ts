import {
  timeframeBucketStart,
  timeframeMinutes,
  type FairValueGap,
  type MarketCandle,
  type MarketTimeframe,
} from './marketDataCalculations';

/**
 * HTF FVG jako v tradingview/alphatrade-fvg-instant-cz.pine (skupina „HTF FVG“):
 * FVG z vyššího timeframe (např. 5m) na grafu s nižším (1m). Vyšší svíčky se
 * skládají ze svíček grafu po CME session (`timeframeBucketStart`, stejně jako
 * 5m/1H graf aplikace); FVG vzniká až z TŘÍ UZAVŘENÝCH vyšších svíček — nic
 * nepředbíhá replay ani se nepřekresluje. Zaplnění pak běží po svíčkách grafu
 * stejně jako Pine (dotyk knotem, šedé zaplnění, konec při úplném zaplnění
 * nebo zavření za zónou). Jen kreslení — do dat, hodnocení ani deníku nejde.
 */

export interface HtfFairValueGap extends FairValueGap {
  /** První svíčka grafu v prostřední vyšší svíčce — odtud se zóna kreslí. */
  drawFrom: number;
}

/** HTF FVG dává smysl jen na grafu s nižším TF, který se do vyššího vejde celý. */
export const htfFvgApplies = (chartTimeframe: MarketTimeframe, htf: MarketTimeframe): boolean => {
  const chart = timeframeMinutes(chartTimeframe);
  const higher = timeframeMinutes(htf);
  return Number.isFinite(chart) && Number.isFinite(higher) && chart > 0 && higher > chart && higher % chart === 0;
};

interface HtfBar {
  time: number;
  high: number;
  low: number;
  firstChartTime: number;
  lastIndex: number;
}

const touchAndShrink = (gap: FairValueGap, active: { top: number; bottom: number }, candle: MarketCandle) => {
  if (candle.high >= active.bottom && candle.low <= active.top) gap.touched = true;
  const nextTop = gap.direction === 'bullish' ? Math.min(active.top, candle.low) : active.top;
  const nextBottom = gap.direction === 'bearish' ? Math.max(active.bottom, candle.high) : active.bottom;
  return { nextTop, nextBottom };
};

/**
 * Je poslední svíčka grafu uzavřená? V replayi se svíčka grafu nad 1m skládá
 * z odkrytých minut, takže je hotová až s kurzorem na její poslední minutě
 * (kurzor = začátek poslední odkryté 1m svíčky). Živě až po uplynutí.
 */
export function htfLastCandleClosed(input: {
  lastTime: number | undefined;
  chartTimeframe: MarketTimeframe;
  replayActive: boolean;
  replayCursorTime: number | null | undefined;
  nowSeconds: number;
}): boolean {
  if (input.lastTime === undefined) return false;
  const end = input.lastTime + timeframeMinutes(input.chartTimeframe) * 60;
  if (input.replayActive) return input.replayCursorTime == null || input.replayCursorTime + 60 >= end;
  return input.nowSeconds >= end;
}

/**
 * `lastClosed`: poslední svíčka grafu je uzavřená (`htfLastCandleClosed`) —
 * pak smí uzavřít i vyšší svíčku, do které patří jako poslední.
 */
export function calculateHtfFairValueGaps(
  candles: readonly MarketCandle[],
  chartTimeframe: MarketTimeframe,
  htf: MarketTimeframe,
  lastClosed: boolean,
): HtfFairValueGap[] {
  if (!htfFvgApplies(chartTimeframe, htf) || candles.length < 3) return [];
  const chartSeconds = timeframeMinutes(chartTimeframe) * 60;
  const htfSeconds = timeframeMinutes(htf) * 60;
  const bars: HtfBar[] = [];
  // Session CME začíná v celou hodinu (18:00 NY) a posun NY je v celých hodinách,
  // takže 5m–1h jsou prosté zaokrouhlení; 4h jede přes hodiny session (DST).
  // 4h: Intl jen jednou na vyšší svíčku (cache hodin session by sekvenční
  // průchod přes ~32k svíček vyhazoval → sekundy na krok).
  let sessionBucketStart = Number.NaN;
  let sessionBucketEnd = Number.NEGATIVE_INFINITY;
  const bucket = 3_600 % htfSeconds === 0
    ? (time: number) => time - (((time % htfSeconds) + htfSeconds) % htfSeconds)
    : (time: number) => {
      if (time >= sessionBucketStart && time < sessionBucketEnd) return sessionBucketStart;
      sessionBucketStart = timeframeBucketStart(time, htf);
      sessionBucketEnd = sessionBucketStart + htfSeconds;
      return sessionBucketStart;
    };
  candles.forEach((candle, index) => {
    const time = bucket(candle.time);
    const current = bars[bars.length - 1];
    if (!current || current.time !== time) {
      bars.push({ time, high: candle.high, low: candle.low, firstChartTime: candle.time, lastIndex: index });
      return;
    }
    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.lastIndex = index;
  });
  const last = candles[candles.length - 1];
  // Poslední vyšší svíčka je hotová jen tehdy, když její poslední svíčka grafu
  // je uzavřená a končí s ní (u zkrácené svíčky před pauzou až s další seancí).
  const closedCount = lastClosed && last.time + chartSeconds >= bars[bars.length - 1].time + htfSeconds
    ? bars.length
    : bars.length - 1;

  const gaps: HtfFairValueGap[] = [];
  // Zóny se zaplňují jen svíčkami grafu PO uzavření třetí vyšší svíčky.
  const active: Array<{ gap: HtfFairValueGap; top: number; bottom: number; from: number }> = [];
  let nextBar = 2;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    for (let slot = active.length - 1; slot >= 0; slot -= 1) {
      const zone = active[slot];
      if (index <= zone.from) continue;
      const { gap } = zone;
      gap.endTime = candle.time;
      const { nextTop, nextBottom } = touchAndShrink(gap, zone, candle);
      const fullyFilled = gap.direction === 'bullish' ? nextTop <= gap.bottom : nextBottom >= gap.top;
      const closeInvalidated = gap.direction === 'bullish' ? candle.close < gap.bottom : candle.close > gap.top;
      if (fullyFilled || closeInvalidated) {
        gap.mitigated = true;
        active.splice(slot, 1);
        continue;
      }
      if (nextTop === zone.top && nextBottom === zone.bottom) continue;
      gap.mitigationSteps.push({
        time: candle.time,
        remainingTop: nextTop,
        remainingBottom: nextBottom,
        filledTop: gap.direction === 'bullish' ? zone.top : nextBottom,
        filledBottom: gap.direction === 'bullish' ? nextTop : zone.bottom,
      });
      zone.top = nextTop;
      zone.bottom = nextBottom;
    }
    // Nová zóna z vyšší svíčky, jejíž poslední svíčka grafu je právě tahle.
    while (nextBar < closedCount && bars[nextBar].lastIndex === index) {
      const first = bars[nextBar - 2];
      const middle = bars[nextBar - 1];
      const third = bars[nextBar];
      const base = { startTime: candle.time, endTime: candle.time, mitigated: false, touched: false, mitigationSteps: [], drawFrom: middle.firstChartTime };
      const gap: HtfFairValueGap | null = third.low > first.high
        ? { ...base, direction: 'bullish', top: third.low, bottom: first.high }
        : third.high < first.low
          ? { ...base, direction: 'bearish', top: first.low, bottom: third.high }
          : null;
      if (gap) {
        gaps.push(gap);
        active.push({ gap, top: gap.top, bottom: gap.bottom, from: index });
      }
      nextBar += 1;
    }
  }
  return gaps;
}

/**
 * Tvořící se svíčka grafu (živá / přehrávaná) za daty: jen dotyk a zúžení
 * otevřených zón, nikdy konec zóny ani nová zóna — Pine uzavírá zónu až na
 * potvrzené svíčce a vyšší svíčka se uzavře až s daty.
 */
export function htfFairValueGapsWithFormingBars(
  gaps: readonly HtfFairValueGap[],
  lastDataTime: number | undefined,
  forming: readonly MarketCandle[],
): HtfFairValueGap[] {
  const bars = lastDataTime === undefined ? [] : forming.filter(bar => bar.time > lastDataTime);
  if (!bars.length || !gaps.some(gap => !gap.mitigated)) return gaps.slice();
  return gaps.map(source => {
    if (source.mitigated) return source;
    const gap: HtfFairValueGap = { ...source, mitigationSteps: source.mitigationSteps.slice() };
    const lastStep = gap.mitigationSteps.at(-1);
    const zone = { top: lastStep?.remainingTop ?? gap.top, bottom: lastStep?.remainingBottom ?? gap.bottom };
    for (const bar of bars) {
      gap.endTime = bar.time;
      const { nextTop, nextBottom } = touchAndShrink(gap, zone, bar);
      const clampedTop = Math.max(nextTop, gap.bottom);
      const clampedBottom = Math.min(nextBottom, gap.top);
      if (clampedTop === zone.top && clampedBottom === zone.bottom) continue;
      gap.mitigationSteps.push({
        time: bar.time,
        remainingTop: clampedTop,
        remainingBottom: clampedBottom,
        filledTop: gap.direction === 'bullish' ? zone.top : clampedBottom,
        filledBottom: gap.direction === 'bullish' ? clampedTop : zone.bottom,
      });
      zone.top = clampedTop;
      zone.bottom = clampedBottom;
    }
    return gap;
  });
}
