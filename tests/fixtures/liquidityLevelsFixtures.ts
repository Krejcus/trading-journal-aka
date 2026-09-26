import { DEFAULT_INDICATOR_SETTINGS, type LevelsIndicatorSettings } from '../../services/chartIndicatorSettings';
import type { MarketCandle } from '../../services/marketData';

const nyHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });

/** Syntetické 1m svíčky jako z CME: denní pauza 17–18 ET, víkend, deterministický šum. */
export function syntheticCandles(startIso: string, count: number, seed = 7, skipEvery = 0): MarketCandle[] {
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const candles: MarketCandle[] = [];
  let time = Math.floor(Date.parse(startIso) / 1000);
  let price = 20_000;
  while (candles.length < count) {
    time += 60;
    const parts = Object.fromEntries(nyHour.formatToParts(new Date(time * 1000)).map(part => [part.type, part.value]));
    const hour = Number(parts.hour); const weekday = parts.weekday;
    if (hour === 17) continue;
    if (weekday === 'Sat' || (weekday === 'Fri' && hour >= 17) || (weekday === 'Sun' && hour < 18)) continue;
    if (skipEvery > 0 && random() < 1 / skipEvery) continue; // chybějící svíčky
    const open = price; const close = open + (random() - 0.5) * 8;
    candles.push({ time, open, close, high: Math.max(open, close) + random() * 3, low: Math.min(open, close) - random() * 3, volume: Math.round(random() * 400) });
    price = close;
  }
  return candles;
}

export function allLevelsSettings(): LevelsIndicatorSettings {
  return { ...structuredClone(DEFAULT_INDICATOR_SETTINGS.levels), showAsia: true, showAsiaLines: true, showLondon: true, showLondonLines: true,
    showNewYork: true, showNewYorkLines: true, showSessionBoxes: true, currentDay: true, priorDay: true, priorWeek: true, dayOpen: true,
    weekOpen: true, sessionHighLow: true, showOpen: true, showZones: true, showOvernight: true, showCompass: true, showInitialBalance: true,
    showBiasTable: true, showVwap: true, showPrevVwap: true, showDeviations: true };
}
