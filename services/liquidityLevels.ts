import type { LevelsIndicatorSettings } from '../components/ChartIndicatorSettingsDialog';
import type { IndicatorPoint, MarketCandle } from './marketData';

export type LiquidityLineStyle = 'solid' | 'dashed' | 'dotted';

export interface LiquidityLevel {
  name: string;
  price: number;
  color: string;
  width: 1 | 2 | 3 | 4;
  style: LiquidityLineStyle;
  startTime: number;
  swept: boolean;
  hits?: number;
  zone?: { top: number; bottom: number };
}

export interface LiquiditySessionBox {
  name: 'ASIA' | 'LONDON' | 'NEW YORK';
  color: string;
  startTime: number;
  endTime: number;
  high: number;
  low: number;
}

export interface LiquidityBiasRow {
  label: string;
  value: string;
  tone: 'bull' | 'bear' | 'muted' | 'warning';
  strong?: boolean;
}

/**
 * Kontext dne v číslech — tytéž hodnoty, jaké Pine indikátor posílá do
 * AlphaBridge v CTX labelu. Bias tabulka je jen jejich formátovaná podoba;
 * analytika potřebuje čísla, aby se s nimi dalo počítat.
 */
export interface LiquidityDayContext {
  /** pre = před RTH, form = IB se tvoří, in/up/down/both = stav po uzavření IB. */
  ibState: 'pre' | 'form' | 'in' | 'up' | 'down' | 'both';
  /** (RTH open − PDC) v denním ATR. */
  gapAtr: number | null;
  /** Šířka overnight range v denním ATR. */
  onWidthAtr: number | null;
  /** Šířka initial balance v denním ATR. */
  ibWidthAtr: number | null;
  /** ATR(14) na svíčkách grafu. */
  atr: number | null;
  /** ATR(14) na denních svíčkách. */
  dailyAtr: number | null;
  onHigh: number | null;
  onLow: number | null;
  ibHigh: number | null;
  ibLow: number | null;
  rthOpen: number | null;
  pdClose: number | null;
  /** Začátek denní seance (unix s) — kotva pro dHigh/dLow k času vstupu. */
  dayStartTime: number | null;
}

export interface LiquidityLevelsResult {
  levels: LiquidityLevel[];
  sessionBoxes: LiquiditySessionBox[];
  vwap: IndicatorPoint[];
  upper1: IndicatorPoint[];
  lower1: IndicatorPoint[];
  upper2: IndicatorPoint[];
  lower2: IndicatorPoint[];
  biasRows: LiquidityBiasRow[];
  dayContext: LiquidityDayContext;
}

const nyParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const formatters = new Map<string, Intl.DateTimeFormat>();
const zonedPartsCache = new Map<string, ReturnType<typeof uncachedZonedParts>>();
const tradingDayKeyCache = new Map<number, string>();
const MAX_TIMEZONE_CACHE_ENTRIES = 200_000;

function uncachedZonedParts(time: number, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
    } catch {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
    }
    formatters.set(timeZone, formatter);
  }
  const value = Object.fromEntries(formatter.formatToParts(new Date(time * 1000)).map(part => [part.type, part.value]));
  return { year: +value.year, month: +value.month, day: +value.day, hour: +value.hour, minute: +value.minute };
}

const zonedParts = (time: number, timeZone: string) => {
  const key = `${timeZone}:${time}`;
  const cached = zonedPartsCache.get(key);
  if (cached) return cached;
  const value = uncachedZonedParts(time, timeZone);
  if (zonedPartsCache.size >= MAX_TIMEZONE_CACHE_ENTRIES) zonedPartsCache.clear();
  zonedPartsCache.set(key, value);
  return value;
};

export const tradingDayKey = (time: number) => {
  const cached = tradingDayKeyCache.get(time);
  if (cached) return cached;
  const value = Object.fromEntries(nyParts.formatToParts(new Date(time * 1000)).map(part => [part.type, part.value]));
  const shifted = new Date(Date.UTC(+value.year, +value.month - 1, +value.day + (+value.hour >= 18 ? 1 : 0)));
  const key = shifted.toISOString().slice(0, 10);
  if (tradingDayKeyCache.size >= MAX_TIMEZONE_CACHE_ENTRIES) tradingDayKeyCache.clear();
  tradingDayKeyCache.set(time, key);
  return key;
};

const weekKey = (dayKey: string) => {
  const date = new Date(`${dayKey}T00:00:00Z`);
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday));
  return date.toISOString().slice(0, 10);
};

const inSession = (hour: number, start: number, end: number) => start < end
  ? hour >= start && hour < end
  : hour >= start || hour < end;

const hitCount = (candles: MarketCandle[], from: number, price: number) => {
  let hits = 0;
  for (let index = Math.max(0, from); index < candles.length; index += 1) {
    if (candles[index].low <= price && candles[index].high >= price) hits += 1;
  }
  return hits;
};

const line = (
  name: string, price: number | undefined, color: string, width: 1 | 2 | 3 | 4,
  style: LiquidityLineStyle, startIndex: number, candles: MarketCandle[], swept = false,
  zoneSize = 0,
): LiquidityLevel | null => {
  if (!Number.isFinite(price)) return null;
  const resolved = Number(price);
  return {
    name, price: resolved, color, width, style,
    startTime: candles[Math.max(0, startIndex)]?.time ?? candles[0]?.time ?? 0,
    swept,
    hits: startIndex >= 0 ? hitCount(candles, startIndex, resolved) : undefined,
    zone: zoneSize > 0 ? (name.includes('H')
      ? { top: resolved + zoneSize, bottom: resolved }
      : { top: resolved, bottom: resolved - zoneSize }) : undefined,
  };
};

type Period = { open: number; high: number; low: number; close: number; start: number; end: number; volume: number; pv: number; pv2: number };

const wilderAverage = (values: readonly number[], length: number): number | null => {
  if (values.length < length) return null;
  let value = values.slice(0, length).reduce((sum, item) => sum + item, 0) / length;
  for (let index = length; index < values.length; index += 1) {
    value = (value * (length - 1) + values[index]) / length;
  }
  return value;
};

export const wilderAverageTrueRange = (
  periods: readonly Pick<Period, 'high' | 'low' | 'close'>[],
  length = 14,
): number | null => {
  if (!periods.length) return null;
  const ranges = periods.map((period, index) => {
    const previousClose = periods[index - 1]?.close;
    return previousClose === undefined
      ? period.high - period.low
      : Math.max(period.high - period.low, Math.abs(period.high - previousClose), Math.abs(period.low - previousClose));
  });
  return wilderAverage(ranges, length);
};

/** ATR(14) přímo na svíčkách grafu — protějšek `atrVal` z Pine indikátoru. */
const candleAverageTrueRange = (candles: MarketCandle[], length = 14) => {
  return wilderAverageTrueRange(candles, length);
};

export const EMPTY_LIQUIDITY_DAY_CONTEXT: LiquidityDayContext = {
  ibState: 'pre', gapAtr: null, onWidthAtr: null, ibWidthAtr: null, atr: null, dailyAtr: null,
  onHigh: null, onLow: null, ibHigh: null, ibLow: null, rthOpen: null, pdClose: null, dayStartTime: null,
};

const widthInAtr = (high: number | undefined, low: number | undefined, atr: number | null) => (
  high === undefined || low === undefined || !atr || atr <= 0 ? null : (high - low) / atr
);

export function calculateLiquidityLevels(candles: MarketCandle[], settings: LevelsIndicatorSettings): LiquidityLevelsResult {
  const empty: LiquidityLevelsResult = {
    levels: [], sessionBoxes: [], vwap: [], upper1: [], lower1: [], upper2: [], lower2: [],
    biasRows: [], dayContext: EMPTY_LIQUIDITY_DAY_CONTEXT,
  };
  if (!candles.length) return empty;

  const days: Period[] = [];
  const weeks: Period[] = [];
  let dayKey = '';
  let week = '';
  let day: Period | null = null;
  let weekPeriod: Period | null = null;
  const vwap: IndicatorPoint[] = [];
  const upper1: IndicatorPoint[] = [];
  const lower1: IndicatorPoint[] = [];
  const upper2: IndicatorPoint[] = [];
  const lower2: IndicatorPoint[] = [];
  const dayStartIndices: number[] = [];

  candles.forEach((candle, index) => {
    const nextDay = tradingDayKey(candle.time);
    const nextWeek = weekKey(nextDay);
    if (nextDay !== dayKey) {
      if (day) days.push(day);
      dayKey = nextDay;
      day = { open: candle.open, high: candle.high, low: candle.low, close: candle.close, start: index, end: index, volume: 0, pv: 0, pv2: 0 };
      dayStartIndices.push(index);
    }
    if (nextWeek !== week) {
      if (weekPeriod) weeks.push(weekPeriod);
      week = nextWeek;
      weekPeriod = { open: candle.open, high: candle.high, low: candle.low, close: candle.close, start: index, end: index, volume: 0, pv: 0, pv2: 0 };
    }
    const typical = (candle.high + candle.low + candle.close) / 3;
    const volume = Math.max(0, candle.volume);
    day!.high = Math.max(day!.high, candle.high); day!.low = Math.min(day!.low, candle.low); day!.close = candle.close; day!.end = index;
    day!.volume += volume; day!.pv += typical * volume; day!.pv2 += typical * typical * volume;
    weekPeriod!.high = Math.max(weekPeriod!.high, candle.high); weekPeriod!.low = Math.min(weekPeriod!.low, candle.low); weekPeriod!.close = candle.close; weekPeriod!.end = index;
    const mean = day!.volume > 0 ? day!.pv / day!.volume : typical;
    const variance = day!.volume > 0 ? Math.max(0, day!.pv2 / day!.volume - mean * mean) : 0;
    const deviation = Math.sqrt(variance);
    vwap.push({ time: candle.time, value: mean });
    upper1.push({ time: candle.time, value: mean + deviation * settings.dev1Multiplier });
    lower1.push({ time: candle.time, value: mean - deviation * settings.dev1Multiplier });
    upper2.push({ time: candle.time, value: mean + deviation * settings.dev2Multiplier });
    lower2.push({ time: candle.time, value: mean - deviation * settings.dev2Multiplier });
  });
  if (day) days.push(day);
  if (weekPeriod) weeks.push(weekPeriod);

  const currentDay = days.at(-1)!;
  const previousDay = days.at(-2);
  const currentWeek = weeks.at(-1)!;
  const previousWeek = weeks.at(-2);
  const latest = candles.at(-1)!;
  const currentDayCandles = candles.slice(currentDay.start);
  const levels: LiquidityLevel[] = [];
  const push = (value: LiquidityLevel | null) => { if (value) levels.push(value); };
  const wasSweptHigh = (price?: number) => Number.isFinite(price) && currentDayCandles.some(candle => candle.high > Number(price));
  const wasSweptLow = (price?: number) => Number.isFinite(price) && currentDayCandles.some(candle => candle.low < Number(price));

  if (settings.currentDay) {
    const dayHigh = line('dHigh', currentDay.high, settings.currentDayColor, settings.currentDayWidth, settings.currentDayStyle, -1, candles);
    const dayLow = line('dLow', currentDay.low, settings.currentDayColor, settings.currentDayWidth, settings.currentDayStyle, -1, candles);
    if (dayHigh) dayHigh.startTime = candles[currentDay.start].time;
    if (dayLow) dayLow.startTime = candles[currentDay.start].time;
    push(dayHigh);
    push(dayLow);
  }
  if (settings.priorDay && previousDay) {
    const highSwept = wasSweptHigh(previousDay.high); const lowSwept = wasSweptLow(previousDay.low);
    push(line('PDH', previousDay.high, settings.priorDayColor, settings.priorDayWidth, settings.priorDayStyle, currentDay.start, candles, highSwept, settings.showZones && !highSwept ? settings.zoneSize : 0));
    push(line('PDL', previousDay.low, settings.priorDayColor, settings.priorDayWidth, settings.priorDayStyle, currentDay.start, candles, lowSwept, settings.showZones && !lowSwept ? settings.zoneSize : 0));
  }
  if (settings.priorWeek && previousWeek) {
    const highSwept = candles.slice(currentWeek.start).some(candle => candle.high > previousWeek.high);
    const lowSwept = candles.slice(currentWeek.start).some(candle => candle.low < previousWeek.low);
    push(line('PWH', previousWeek.high, settings.priorWeekColor, settings.priorWeekWidth, settings.priorWeekStyle, currentWeek.start, candles, highSwept, settings.showZones && !highSwept ? settings.zoneSize : 0));
    push(line('PWL', previousWeek.low, settings.priorWeekColor, settings.priorWeekWidth, settings.priorWeekStyle, currentWeek.start, candles, lowSwept, settings.showZones && !lowSwept ? settings.zoneSize : 0));
  }
  if (settings.showOpen) {
    push(line('DO', currentDay.open, settings.dayOpenColor, settings.openWidth, settings.openStyle, currentDay.start, candles));
    push(line('WO', currentWeek.open, settings.weekOpenColor, settings.openWidth, settings.openStyle, currentWeek.start, candles));
  }

  const sessionBoxes: LiquiditySessionBox[] = [];
  const processSession = (name: LiquiditySessionBox['name'], enabled: boolean, showLines: boolean, color: string, startHour: number, endHour: number) => {
    if (!enabled) return;
    let active: LiquiditySessionBox | null = null;
    const finished: Array<{ box: LiquiditySessionBox; completionIndex: number }> = [];
    const sessionCandles = candles.slice(currentDay.start);
    sessionCandles.forEach((candle, localIndex) => {
      const part = zonedParts(candle.time, settings.timezone);
      const inside = inSession(part.hour, startHour, endHour);
      if (inside && !active) active = { name, color, startTime: candle.time, endTime: candle.time, high: candle.high, low: candle.low };
      else if (inside && active) { active.endTime = candle.time; active.high = Math.max(active.high, candle.high); active.low = Math.min(active.low, candle.low); }
      else if (!inside && active) {
        // Teprve první bar mimo časové okno potvrzuje, že session skončila.
        // Do té chvíle jsou high/low jen průběžné a nesmí se vydávat za level.
        finished.push({ box: active, completionIndex: currentDay.start + localIndex });
        active = null;
      }
    });
    const completed = finished.at(-1);
    const visibleBox = active ?? completed?.box;
    // Box se může během session průběžně zvětšovat; pojmenované H/L levely ne.
    if (settings.showSessionBoxes && visibleBox) sessionBoxes.push(visibleBox);
    if (!showLines || !completed) return;
    const { box, completionIndex } = completed;
    const after = candles.slice(completionIndex);
    const highSwept = after.some(candle => candle.high > box.high);
    const lowSwept = after.some(candle => candle.low < box.low);
    if (!highSwept) push(line(`${name === 'LONDON' ? 'LON' : name === 'NEW YORK' ? 'NY' : 'ASIA'} H`, box.high, color, settings.sessionLineWidth, settings.sessionLineStyle, completionIndex, candles));
    if (!lowSwept) push(line(`${name === 'LONDON' ? 'LON' : name === 'NEW YORK' ? 'NY' : 'ASIA'} L`, box.low, color, settings.sessionLineWidth, settings.sessionLineStyle, completionIndex, candles));
  };
  processSession('ASIA', settings.showAsia, settings.showAsiaLines, settings.asiaColor, settings.asiaStart, settings.asiaEnd);
  processSession('LONDON', settings.showLondon, settings.showLondonLines, settings.londonColor, settings.londonStart, settings.londonEnd);
  processSession('NEW YORK', settings.showNewYork, settings.showNewYorkLines, settings.newYorkColor, settings.newYorkStart, settings.newYorkEnd);

  const lastDayStart = currentDay.start;
  const rthOpenMinutes = settings.rthOpenHour * 60 + settings.rthOpenMinute;
  const rthIndex = candles.findIndex((candle, index) => {
    if (index < lastDayStart) return false;
    const part = zonedParts(candle.time, settings.timezone);
    return part.hour * 60 + part.minute >= rthOpenMinutes && part.hour * 60 + part.minute < settings.newYorkEnd * 60;
  });
  let onHigh: number | undefined; let onLow: number | undefined; let ibHigh: number | undefined; let ibLow: number | undefined;
  if (rthIndex >= 0) {
    const overnight = candles.slice(lastDayStart, Math.max(lastDayStart + 1, rthIndex + 1));
    onHigh = Math.max(...overnight.map(c => c.high)); onLow = Math.min(...overnight.map(c => c.low));
    const rthOpen = candles[rthIndex].open;
    const endIndex = candles.findIndex((candle, index) => index > rthIndex && candle.time >= candles[rthIndex].time + 3600);
    if (endIndex >= 0) {
      const ib = candles.slice(rthIndex, endIndex);
      ibHigh = Math.max(...ib.map(c => c.high)); ibLow = Math.min(...ib.map(c => c.low));
      if (settings.showInitialBalance) {
        push(line('IB H', ibHigh, settings.initialBalanceColor, 1, 'dashed', endIndex, candles));
        push(line('IB L', ibLow, settings.initialBalanceColor, 1, 'dashed', endIndex, candles));
      }
    }
    if (settings.showOvernight && Number.isFinite(onHigh) && Number.isFinite(onLow)) {
      push(line('ON H', onHigh, settings.overnightColor, 2, 'solid', rthIndex, candles, candles.slice(rthIndex).some(c => c.high > Number(onHigh))));
      push(line('ON L', onLow, settings.overnightColor, 2, 'solid', rthIndex, candles, candles.slice(rthIndex).some(c => c.low < Number(onLow))));
    }
    if (settings.showCompass && previousDay) {
      push(line('PDC', previousDay.close, settings.compassColor, 1, 'dotted', currentDay.start, candles));
      push(line('PD MID', (previousDay.high + previousDay.low) / 2, settings.compassColor, 1, 'dotted', currentDay.start, candles));
      push(line('ON MID', (Number(onHigh) + Number(onLow)) / 2, settings.compassColor, 1, 'dotted', rthIndex, candles));
      push(line('RTH Open', rthOpen, settings.compassColor, 1, 'dotted', rthIndex, candles));
    }
  }

  const previousVwap = previousDay && previousDay.volume > 0 ? previousDay.pv / previousDay.volume : undefined;
  if (settings.showPrevVwap) {
    const previousVwapLevel = line('pdVWAP', previousVwap, settings.vwapColor, settings.prevVwapWidth, settings.prevVwapStyle, currentDay.start, candles);
    if (previousVwapLevel && (previousVwapLevel.hits ?? 0) > 0) previousVwapLevel.swept = true;
    push(previousVwapLevel);
  }

  // Kontext dne se počítá vždy, i když je bias tabulka schovaná — analytika ho
  // potřebuje v číslech a vizuální přepínač nesmí rozhodovat o tom, co se sbírá.
  const dailyAtr = wilderAverageTrueRange(days.slice(0, -1));
  const pdClose = previousDay?.close;
  const rthOpen = rthIndex >= 0 ? candles[rthIndex].open : latest.close;
  const gap = pdClose !== undefined && dailyAtr !== null && dailyAtr > 0 ? (rthOpen - pdClose) / dailyAtr : undefined;
  const afterIb = ibHigh !== undefined && ibLow !== undefined && rthIndex >= 0
    ? candles.filter(candle => candle.time >= candles[rthIndex].time + 3600)
    : [];
  const brokeUp = ibHigh !== undefined && afterIb.some(candle => candle.high > Number(ibHigh));
  const brokeDown = ibLow !== undefined && afterIb.some(candle => candle.low < Number(ibLow));
  const dayContext: LiquidityDayContext = {
    ibState: rthIndex < 0 ? 'pre'
      : ibHigh === undefined ? 'form'
        : brokeUp && brokeDown ? 'both'
          : brokeUp ? 'up'
            : brokeDown ? 'down'
              : 'in',
    gapAtr: gap ?? null,
    onWidthAtr: widthInAtr(onHigh, onLow, dailyAtr),
    ibWidthAtr: widthInAtr(ibHigh, ibLow, dailyAtr),
    atr: candleAverageTrueRange(candles),
    dailyAtr: dailyAtr !== null && dailyAtr > 0 ? dailyAtr : null,
    onHigh: onHigh ?? null,
    onLow: onLow ?? null,
    ibHigh: ibHigh ?? null,
    ibLow: ibLow ?? null,
    rthOpen: rthIndex >= 0 ? candles[rthIndex].open : null,
    pdClose: pdClose ?? null,
    dayStartTime: candles[currentDay.start]?.time ?? null,
  };

  const biasRows: LiquidityBiasRow[] = [];
  if (settings.showBiasTable) {
    const gapAbs = Math.abs(gap ?? 0);
    const gapClass = gapAbs < .3 ? 'drobný' : gapAbs < .7 ? 'malý' : gapAbs < 1.2 ? 'střední' : 'VELKÝ';
    biasRows.push({ label: `Gap${rthIndex >= 0 ? '' : ' ~'}`, value: gap === undefined ? '—' : `${gap > 0 ? '▲ +' : '▼ '}${gap.toFixed(2)} ATR (${gapClass})`, tone: gap === undefined ? 'muted' : gap > 0 ? 'bull' : 'bear' });
    const anchors: Array<[string, number | undefined]> = [['PDC', pdClose], ['ON MID', onHigh !== undefined && onLow !== undefined ? (onHigh + onLow) / 2 : undefined], ['PD MID', previousDay ? (previousDay.high + previousDay.low) / 2 : undefined], ['RTH Open', rthIndex >= 0 ? candles[rthIndex].open : undefined], ['pdVWAP', previousVwap], ['VWAP', vwap.at(-1)?.value]];
    let bull = 0; let valid = 0;
    anchors.forEach(([label, price]) => {
      const above = price !== undefined && latest.close > price;
      if (price !== undefined) { valid += 1; if (above) bull += 1; }
      biasRows.push({ label, value: price === undefined ? '—' : above ? '▲ nad' : '▼ pod', tone: price === undefined ? 'muted' : above ? 'bull' : 'bear' });
    });
    const ratio = valid ? bull / valid : .5;
    const verdict = !valid ? '—' : ratio >= .7 ? 'BULLISH' : ratio <= .3 ? 'BEARISH' : 'NEUTRAL';
    biasRows.push({ label: `SKÓRE ${bull}/${valid}`, value: `${verdict === 'BULLISH' ? '▲' : verdict === 'BEARISH' ? '▼' : '◆'} ${verdict}`, tone: verdict === 'BULLISH' ? 'bull' : verdict === 'BEARISH' ? 'bear' : 'muted', strong: true });
    const ibText = rthIndex < 0 ? 'před RTH' : ibHigh === undefined ? 'tvoří se…' : brokeUp && brokeDown ? 'ROTACE (obě strany)' : brokeUp ? '↑ BREAK — trend?' : brokeDown ? '↓ BREAK — trend?' : 'uvnitř range';
    biasRows.push({ label: 'IB', value: ibText, tone: brokeUp && !brokeDown ? 'bull' : brokeDown && !brokeUp ? 'bear' : brokeUp && brokeDown ? 'warning' : 'muted' });
    if (gap !== undefined && Math.abs(gap) >= .15) biasRows.push({ label: '⛔', value: gap > 0 ? 'PDL dnes není target' : 'PDH dnes není target', tone: 'warning' });
  }

  return { levels, sessionBoxes, vwap, upper1, lower1, upper2, lower2, biasRows, dayContext };
}
