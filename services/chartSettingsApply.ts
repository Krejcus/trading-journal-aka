/**
 * Převod nastavení grafu na věci, které Lightweight Charts neumí popsat jedním
 * `applyOptions`: cenové čáry předchozího close a extrémů, vodoznak, předěly
 * seancí a odpočet do uzavření svíčky.
 *
 * Výpočty jsou oddělené od zápisu do grafu, aby se daly testovat bez plátna.
 */

import type { IPriceLine, ISeriesApi, SeriesType } from 'lightweight-charts';
import type { MarketCandle } from './marketData';
import {
  chartLineStyle,
  type ChartLineStyleName,
  type ChartPriceLabelSettings,
} from './chartSettings';
import { zonedTimeParts } from './chartTimeAxisFormat';

/** Kalendářní den v dané zóně jako `YYYY-MM-DD`, aby se dal porovnávat. */
export const zonedDayKey = (unixSeconds: number, timeZone: string): string => {
  const parts = zonedTimeParts(unixSeconds, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

/**
 * Close posledního dokončeného dne před nejnovější svíčkou. Bere se poslední
 * svíčka předchozího kalendářního dne, ne první dnešní — u futures se den láme
 * uprostřed obchodování a otevírací cena by nesouhlasila s PDC.
 */
export const previousDayClosePrice = (
  candles: readonly MarketCandle[],
  timeZone: string,
): number | null => previousDayCloseAnchor(candles, timeZone)?.price ?? null;

/** Cena i čas svíčky, ze které pochází — čára "od svíčky doprava" potřebuje obojí. */
export const previousDayCloseAnchor = (
  candles: readonly MarketCandle[],
  timeZone: string,
): { price: number; time: number } | null => {
  const last = candles.at(-1);
  if (!last) return null;
  const currentDay = zonedDayKey(last.time, timeZone);
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    const candle = candles[index];
    if (zonedDayKey(candle.time, timeZone) !== currentDay) {
      return { price: candle.close, time: candle.time };
    }
  }
  return null;
};

/** Maximum a minimum ve viditelném úseku; mimo data vrací `null`. */
export const visibleHighLow = (
  candles: readonly MarketCandle[],
  range: { from: number; to: number } | null,
): { high: number; low: number } | null => {
  const anchors = visibleHighLowAnchors(candles, range);
  return anchors ? { high: anchors.high.price, low: anchors.low.price } : null;
};

/**
 * Extrémy i časy svíček, na kterých padly. První výskyt vyhrává — čára pak
 * začíná tam, kde se úroveň zrodila, ne u pozdějšího doteku stejné ceny.
 */
export const visibleHighLowAnchors = (
  candles: readonly MarketCandle[],
  range: { from: number; to: number } | null,
): { high: { price: number; time: number }; low: { price: number; time: number } } | null => {
  if (!candles.length) return null;
  let high = { price: Number.NEGATIVE_INFINITY, time: 0 };
  let low = { price: Number.POSITIVE_INFINITY, time: 0 };
  candles.forEach(candle => {
    if (range && (candle.time < range.from || candle.time > range.to)) return;
    if (candle.high > high.price) high = { price: candle.high, time: candle.time };
    if (candle.low < low.price) low = { price: candle.low, time: candle.time };
  });
  return Number.isFinite(high.price) && Number.isFinite(low.price) ? { high, low } : null;
};

export interface ShortenedPriceLine {
  /** Svíčka, od které se kreslí doprava. */
  time: number;
  price: number;
  color: string;
  width: number;
  style: ChartLineStyleName;
}

/**
 * Které cenové čáry se mají kreslit zkráceně — jen od své svíčky doprava.
 *
 * Knihovní price line vede vždy přes celý graf, takže tyhle se z ní vypnou a
 * překreslí je primitive. Funkce je oddělená právě proto, aby výběr a kotvy
 * šly otestovat bez plátna.
 */
export const shortenedPriceLines = (params: {
  scales: {
    symbolLabel: ChartPriceLabelSettings;
    previousDayClose: ChartPriceLabelSettings;
    highAndLow: ChartPriceLabelSettings;
  };
  candles: readonly MarketCandle[];
  timeZone: string;
  visibleRange: { from: number; to: number } | null;
}): ShortenedPriceLine[] => {
  const { scales, candles, timeZone, visibleRange } = params;
  const result: ShortenedPriceLine[] = [];
  const wantsShort = (settings: ChartPriceLabelSettings) =>
    settings.line && (settings.lineExtent ?? 'full') === 'fromPoint';
  const push = (settings: ChartPriceLabelSettings, anchor: { price: number; time: number } | null) => {
    if (!anchor || !Number.isFinite(anchor.price)) return;
    const appearance = settings.appearance ?? { color: '#787b86', width: 1 as const, style: 'dashed' as const };
    result.push({
      time: anchor.time,
      price: anchor.price,
      color: appearance.color,
      width: appearance.width,
      style: appearance.style,
    });
  };

  if (wantsShort(scales.symbolLabel)) {
    const last = candles.at(-1);
    push(scales.symbolLabel, last ? { price: last.close, time: last.time } : null);
  }
  if (wantsShort(scales.previousDayClose)) {
    push(scales.previousDayClose, previousDayCloseAnchor(candles, timeZone));
  }
  if (wantsShort(scales.highAndLow)) {
    const anchors = visibleHighLowAnchors(candles, visibleRange);
    push(scales.highAndLow, anchors?.high ?? null);
    push(scales.highAndLow, anchors?.low ?? null);
  }
  return result;
};

/** Vzor čárkování pro canvas; knihovní `LineStyle` je enum pro její vlastní kreslení. */
export const canvasLineDash = (style: ChartLineStyleName): number[] => {
  switch (style) {
    case 'dotted': return [1, 2];
    case 'dashed': return [4, 3];
    case 'large-dashed': return [8, 5];
    case 'sparse-dotted': return [1, 5];
    default: return [];
  }
};

/**
 * Časy svíček, které otevírají nový kalendářní den — tam TradingView kreslí
 * předěl seance. První svíčka se nepočítá, předěl před začátkem dat nedává smysl.
 */
export const sessionBreakTimes = (
  candles: readonly MarketCandle[],
  timeZone: string,
): number[] => {
  const breaks: number[] = [];
  let previousDay: string | null = null;
  candles.forEach(candle => {
    const day = zonedDayKey(candle.time, timeZone);
    if (previousDay !== null && day !== previousDay) breaks.push(candle.time);
    previousDay = day;
  });
  return breaks;
};

/** Kolik sekund zbývá do konce svíčky, která začala v `barTime`. */
export const secondsToBarClose = (params: {
  barTime: number;
  timeframeMinutes: number;
  nowSeconds: number;
}): number => {
  const { barTime, timeframeMinutes, nowSeconds } = params;
  const span = timeframeMinutes * 60;
  if (!(span > 0)) return 0;
  return Math.max(0, barTime + span - nowSeconds);
};

export interface ManagedPriceLine {
  line: IPriceLine;
  price: number;
}

/**
 * Udrží jednu cenovou čáru v souladu s nastavením. Vrací aktuální úchyt, nebo
 * `null`, když se čára nemá kreslit; volající si ho uloží pro příští běh.
 */
export const syncManagedPriceLine = (params: {
  series: ISeriesApi<SeriesType>;
  previous: ManagedPriceLine | null;
  settings: ChartPriceLabelSettings;
  price: number | null;
  title: string;
}): ManagedPriceLine | null => {
  const { series, previous, settings, price, title } = params;
  const wanted = price !== null && Number.isFinite(price) && (settings.value || settings.line);
  if (!wanted) {
    if (previous) {
      try { series.removePriceLine(previous.line); } catch { /* série už zmizela */ }
    }
    return null;
  }
  const appearance = settings.appearance ?? { color: '#787b86', width: 1 as const, style: 'dashed' as const };
  const options = {
    price: price as number,
    color: appearance.color,
    lineWidth: appearance.width,
    lineStyle: chartLineStyle(appearance.style),
    // Čára bez zaškrtnuté „Čára" zůstává jen popiskem na ose, proto průhledná.
    // Zkrácenou čáru („od svíčky doprava") knihovní price line neumí — kreslí
    // ji primitive v grafu, takže tady se schová i když je „Čára" zaškrtnutá.
    lineVisible: settings.line && (settings.lineExtent ?? 'full') === 'full',
    axisLabelVisible: settings.value,
    title: settings.name ? title : '',
  };
  if (previous) {
    previous.line.applyOptions(options);
    return { line: previous.line, price: price as number };
  }
  return { line: series.createPriceLine(options), price: price as number };
};
