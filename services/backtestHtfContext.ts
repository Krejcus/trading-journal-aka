/**
 * Kontext vyšších časových rámců pro replay.
 *
 * Pine indikátor tohle posílá do AlphaBridge jako `s15`/`s60` (historie zlomů)
 * a `FVG15`/`FVG60` (ghost labely se zónami). Replay to dosud neměl vůbec:
 * HTF struktura se četla jen z hodinových svíček a jen jako poslední událost,
 * HTF FVG nikde. Tvar výstupu je schválně shodný s AlphaBridge, aby ho uměla
 * vykreslit už existující `TradeConfluence`.
 *
 * Na rozdíl od indikátoru tu není žádné „fotka posledního baru" — všechno se
 * ořezává přesně k času vstupu, takže stáří zlomu je skutečné, ne dopočítané
 * přes zpoždění snapshotu.
 */

import {
  aggregateCandles,
  calculateMarketStructure,
  findFairValueGaps,
  type MarketCandle,
  type MarketStructureEvent,
} from './marketData';
import { tradingDayKey, wilderAverageTrueRange } from './liquidityLevels';

/** Kolik HTF zón se ukládá k obchodu — stejný strop jako v AlphaBridge. */
const MAX_HTF_ZONES = 8;

const HTF_SECONDS: Record<HtfTimeframeLabel, number> = {
  '15': 15 * 60,
  '60': 60 * 60,
};

export type HtfTimeframeLabel = '15' | '60';

export interface HtfStructureRead {
  dir: 'bull' | 'bear';
  type: 'BoS' | 'CHoCH';
  /** Minuty mezi zlomem a vstupem. */
  ageMin: number;
  /** Kolikátý zlom v nepřerušené sérii stejného směru. */
  run: number;
}

export interface HtfFvgZone {
  tf: HtfTimeframeLabel;
  dir: 'bull' | 'bear';
  top: number;
  bot: number;
  /** Cena se dotkla bližší hrany, ale zónu nevyplnila. */
  tested: boolean;
  /** Vzdálenost od vstupu v bodech; 0 znamená, že vstup leží uvnitř. */
  dist: number;
}

export interface HtfFvgRead {
  inside15: HtfFvgZone | null;
  inside60: HtfFvgZone | null;
  nearestUntestedAbove: HtfFvgZone | null;
  nearestUntestedBelow: HtfFvgZone | null;
  zones: HtfFvgZone[];
}

const structureType = (event: MarketStructureEvent): HtfStructureRead['type'] =>
  (event.type === 'BOS' ? 'BoS' : 'CHoCH');

const structureDirection = (event: MarketStructureEvent): HtfStructureRead['dir'] =>
  (event.direction === 'bullish' ? 'bull' : 'bear');

/**
 * Poslední zlom, který se stal před vstupem, i s pořadím v sérii.
 *
 * `run` se počítá dozadu přes události stejného směru — první zlom obratu má
 * 1 (to je CHoCH), pokračování série roste. Stejná logika jako `f_structStr`
 * v indikátoru.
 */
export const htfStructureAt = (
  events: readonly MarketStructureEvent[],
  entryTime: number,
  timeframeSeconds = 0,
): HtfStructureRead | null => {
  // HTF timestamp is the bucket OPEN. The structure becomes knowable only when
  // that bucket closes; filtering by breakTime alone leaks the rest of the bar.
  const eligible = events.filter(event => event.breakTime + timeframeSeconds <= entryTime);
  const latest = eligible[eligible.length - 1];
  if (!latest) return null;
  let run = 1;
  for (let index = eligible.length - 2; index >= 0; index -= 1) {
    if (eligible[index].direction !== latest.direction) break;
    run += 1;
  }
  return {
    dir: structureDirection(latest),
    type: structureType(latest),
    ageMin: Math.max(0, Math.round((entryTime - latest.breakTime) / 60)),
    run,
  };
};

/**
 * Nevyplněné FVG zóny na jednom rámci k času vstupu.
 *
 * Vyplněná zóna (cena prošla vzdálenou hranou) mizí stejně jako v indikátoru;
 * dotyk bližší hrany ji jen označí jako testovanou.
 */
const zonesAt = (
  candles: readonly MarketCandle[],
  minuteCandles: readonly MarketCandle[],
  tf: HtfTimeframeLabel,
  entryTime: number,
  entryPrice: number,
): HtfFvgZone[] => {
  const duration = HTF_SECONDS[tf];
  // Pine creates HTF FVGs from [1]/[3], i.e. confirmed HTF bars only.
  const history = candles.filter(candle => candle.time + duration <= entryTime);
  if (history.length < 3) return [];
  return findFairValueGaps([...history])
    .filter(gap => !gap.mitigated && gap.startTime + duration <= entryTime)
    .map(gap => {
      // The indicator mitigates HTF zones on confirmed chart (1m) bars, not only
      // on the next completed HTF candle. Replaying those bars keeps a touch in
      // the current 15m/1h bucket visible without admitting its future minutes.
      let tested = gap.touched;
      let filled = false;
      const bornAt = gap.startTime + duration;
      for (const candle of minuteCandles) {
        // Entry bar is still forming at the fill. Its eventual high/low must
        // not retroactively erase a zone that existed when the order filled.
        if (candle.time < bornAt || candle.time >= entryTime) continue;
        if (gap.direction === 'bullish') {
          if (candle.low <= gap.bottom) { filled = true; break; }
          if (candle.low <= gap.top) tested = true;
        } else {
          if (candle.high >= gap.top) { filled = true; break; }
          if (candle.high >= gap.bottom) tested = true;
        }
      }
      return { gap, tested, filled };
    })
    .filter(item => !item.filled)
    .map(({ gap, tested }) => ({
      tf,
      dir: gap.direction === 'bullish' ? 'bull' as const : 'bear' as const,
      top: gap.top,
      bot: gap.bottom,
      tested,
      dist: entryPrice >= gap.bottom && entryPrice <= gap.top
        ? 0
        : entryPrice < gap.bottom ? gap.bottom - entryPrice : entryPrice - gap.top,
    }));
};

export interface HtfContextInput {
  /** 1m svíčky exekučního instrumentu — 15m rámec se z nich agreguje. */
  candles: readonly MarketCandle[];
  /** Hodinové svíčky. Když chybí, 1h část zůstane prázdná. */
  hourly?: readonly MarketCandle[];
}

export interface HtfContextSource {
  structure(entryTime: number, timeframe: HtfTimeframeLabel): HtfStructureRead | null;
  fvg(entryTime: number, entryPrice: number): HtfFvgRead;
  /** Měsíční magnety z hodinové historie: PMH, PML a MO. */
  monthlyLevels(entryTime: number): MonthlyMagnet[];
  /** Wilderovo denní ATR(14) pouze z dokončených CME obchodních dnů. */
  dailyAtr(entryTime: number): number | null;
  /** Denní a týdenní kotvy z plné hodinové historie, ne z krátkého 1m okna. */
  liquidityAnchors(entryTime: number): HtfLiquidityAnchor[];
}

export interface HtfLiquidityAnchor {
  label: 'PDH' | 'PDL' | 'PDC' | 'PD MID' | 'PWH' | 'PWL' | 'DO' | 'WO';
  price: number;
  startTime: number;
  swept: boolean;
}

export interface MonthlyMagnet {
  label: 'PMH' | 'PML' | 'MO';
  price: number;
  startTime: number;
  swept: boolean;
}

/**
 * Struktura i zóny se počítají přes celý dodaný proud jednou a pak se jen
 * ořezávají časem vstupu. Cachovat je „do času prvního obchodu" by znamenalo,
 * že všechny pozdější obchody čtou zastaralý stav.
 */
export const createHtfContextSource = (input: HtfContextInput): HtfContextSource => {
  const candles15 = input.candles.length >= 15 ? aggregateCandles([...input.candles], '15m') : [];
  const candles60 = input.hourly ?? [];
  let structure15: MarketStructureEvent[] | null = null;
  let structure60: MarketStructureEvent[] | null = null;
  // Kontext se pro jeden obchod čte víckrát (mapa vstupu, konfluence, deník) a
  // hodinový proud může mít přes osm tisíc svíček. Bez cache by se zóny počítaly
  // znovu při každém dotazu.
  const structureCache = new Map<string, HtfStructureRead | null>();
  const fvgCache = new Map<string, HtfFvgRead>();

  const eventsFor = (timeframe: HtfTimeframeLabel): MarketStructureEvent[] => {
    if (timeframe === '15') {
      structure15 ??= candles15.length >= 3 ? calculateMarketStructure([...candles15]) : [];
      return structure15;
    }
    structure60 ??= candles60.length >= 3 ? calculateMarketStructure([...candles60]) : [];
    return structure60;
  };

  return {
    structure: (entryTime, timeframe) => {
      const key = `${timeframe}:${entryTime}`;
      if (structureCache.has(key)) return structureCache.get(key) ?? null;
      const read = htfStructureAt(eventsFor(timeframe), entryTime, HTF_SECONDS[timeframe]);
      structureCache.set(key, read);
      return read;
    },

    fvg: (entryTime, entryPrice) => {
      const key = `${entryTime}:${entryPrice}`;
      const cached = fvgCache.get(key);
      if (cached) return cached;
      const all = [
        ...zonesAt(candles15, input.candles, '15', entryTime, entryPrice),
        ...zonesAt(candles60, input.candles, '60', entryTime, entryPrice),
      ];
      const inside = (tf: HtfTimeframeLabel) => all.find(zone => zone.tf === tf && zone.dist === 0) ?? null;
      const untested = all.filter(zone => !zone.tested && zone.dist > 0);
      const above = untested
        .filter(zone => zone.bot > entryPrice)
        .sort((left, right) => left.dist - right.dist)[0] ?? null;
      const below = untested
        .filter(zone => zone.top < entryPrice)
        .sort((left, right) => left.dist - right.dist)[0] ?? null;
      const read: HtfFvgRead = {
        inside15: inside('15'),
        inside60: inside('60'),
        nearestUntestedAbove: above,
        nearestUntestedBelow: below,
        zones: [...all].sort((left, right) => left.dist - right.dist).slice(0, MAX_HTF_ZONES),
      };
      fvgCache.set(key, read);
      return read;
    },

    monthlyLevels: entryTime => monthlyMagnets(candles60, entryTime),

    dailyAtr: entryTime => dailyAtrFromHourly(candles60, entryTime),

    liquidityAnchors: entryTime => liquidityAnchorsFromHourly(candles60, input.candles, entryTime),
  };
};

const isoWeekKey = (dayKey: string) => {
  const date = new Date(`${dayKey}T00:00:00Z`);
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday));
  return date.toISOString().slice(0, 10);
};

interface AnchorPeriod {
  open: number;
  high: number;
  low: number;
  close: number;
  startTime: number;
}

/**
 * Kotvy, které nelze spolehlivě vytvořit z třídenního minutového výřezu.
 * Open právě běžící hodiny je známý od jejího začátku; high/low/close se do
 * uzavřených období započítají až po close hodinové svíčky.
 */
export const liquidityAnchorsFromHourly = (
  hourly: readonly MarketCandle[],
  minuteCandles: readonly MarketCandle[],
  entryTime: number,
): HtfLiquidityAnchor[] => {
  const known = hourly.filter(candle => candle.time <= entryTime);
  const completed = known.filter(candle => candle.time + 3_600 <= entryTime);
  if (!known.length) return [];
  const entryDay = tradingDayKey(entryTime);
  const entryWeek = isoWeekKey(entryDay);
  const aggregate = (keyOf: (candle: MarketCandle) => string) => {
    const map = new Map<string, AnchorPeriod>();
    completed.forEach(candle => {
      const key = keyOf(candle);
      const current = map.get(key);
      if (!current) {
        map.set(key, {
          open: candle.open, high: candle.high, low: candle.low,
          close: candle.close, startTime: candle.time,
        });
      } else {
        current.high = Math.max(current.high, candle.high);
        current.low = Math.min(current.low, candle.low);
        current.close = candle.close;
      }
    });
    return map;
  };
  const days = aggregate(candle => tradingDayKey(candle.time));
  const weeks = aggregate(candle => isoWeekKey(tradingDayKey(candle.time)));
  const previous = <T>(map: Map<string, T>, currentKey: string): T | null => {
    const keys = [...map.keys()].filter(key => key < currentKey).sort();
    return keys.length ? map.get(keys[keys.length - 1]) ?? null : null;
  };
  const previousDay = previous(days, entryDay);
  const previousWeek = previous(weeks, entryWeek);
  const currentDayFirst = known.find(candle => tradingDayKey(candle.time) === entryDay);
  const currentWeekFirst = known.find(candle => isoWeekKey(tradingDayKey(candle.time)) === entryWeek);
  const currentMinutes = minuteCandles.filter(candle => candle.time < entryTime);
  const dayMinutes = currentMinutes.filter(candle => tradingDayKey(candle.time) === entryDay);
  const weekMinutes = currentMinutes.filter(candle => isoWeekKey(tradingDayKey(candle.time)) === entryWeek);
  const result: HtfLiquidityAnchor[] = [];
  const add = (label: HtfLiquidityAnchor['label'], price: number | undefined, startTime: number | undefined, swept = false) => {
    if (Number.isFinite(price) && Number.isFinite(startTime)) result.push({ label, price: Number(price), startTime: Number(startTime), swept });
  };
  if (previousDay && currentDayFirst) {
    add('PDH', previousDay.high, currentDayFirst.time, dayMinutes.some(candle => candle.high > previousDay.high));
    add('PDL', previousDay.low, currentDayFirst.time, dayMinutes.some(candle => candle.low < previousDay.low));
    add('PDC', previousDay.close, currentDayFirst.time);
    add('PD MID', (previousDay.high + previousDay.low) / 2, currentDayFirst.time);
  }
  if (previousWeek && currentWeekFirst) {
    add('PWH', previousWeek.high, currentWeekFirst.time, weekMinutes.some(candle => candle.high > previousWeek.high));
    add('PWL', previousWeek.low, currentWeekFirst.time, weekMinutes.some(candle => candle.low < previousWeek.low));
  }
  add('DO', currentDayFirst?.open, currentDayFirst?.time);
  add('WO', currentWeekFirst?.open, currentWeekFirst?.time);
  return result;
};

const monthKey = (unixSeconds: number) => tradingDayKey(unixSeconds).slice(0, 7);

export const dailyAtrFromHourly = (hourly: readonly MarketCandle[], entryTime: number): number | null => {
  const completed = hourly.filter(candle => candle.time + 3_600 <= entryTime);
  const entryDay = tradingDayKey(entryTime);
  const days = new Map<string, { high: number; low: number; close: number }>();
  completed.forEach(candle => {
    const key = tradingDayKey(candle.time);
    if (key === entryDay) return;
    const current = days.get(key);
    if (!current) {
      days.set(key, { high: candle.high, low: candle.low, close: candle.close });
      return;
    }
    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
  });
  return wilderAverageTrueRange([...days.values()], 14);
};

/**
 * PMH/PML/MO z hodinové historie. Indikátor je bere přes `request.security`
 * na měsíčním rámci; tady je stačí složit z hodin, protože měsíční extrém je
 * jen maximum a minimum přes svíčky měsíce.
 */
export const monthlyMagnets = (
  hourly: readonly MarketCandle[],
  entryTime: number,
): MonthlyMagnet[] => {
  // Open právě běžící hodiny je známý okamžitě (potřebujeme ho pro MO), ale
  // její high/low se do měsíčního extrému smí propsat až po close.
  const known = hourly.filter(candle => candle.time <= entryTime);
  if (!known.length) return [];
  const months = new Map<string, { high: number; low: number; open: number; startTime: number }>();
  const order: string[] = [];
  known.forEach(candle => {
    const key = monthKey(candle.time);
    const current = months.get(key);
    if (!current) {
      months.set(key, {
        high: candle.time + 3_600 <= entryTime ? candle.high : -Infinity,
        low: candle.time + 3_600 <= entryTime ? candle.low : Infinity,
        open: candle.open,
        startTime: candle.time,
      });
      order.push(key);
      return;
    }
    if (candle.time + 3_600 > entryTime) return;
    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
  });
  const currentMonth = months.get(order[order.length - 1]);
  const previousMonth = order.length >= 2 ? months.get(order[order.length - 2]) : undefined;
  const levels: MonthlyMagnet[] = [];
  if (previousMonth && currentMonth && Number.isFinite(previousMonth.high) && Number.isFinite(previousMonth.low)) {
    levels.push({ label: 'PMH', price: previousMonth.high, startTime: currentMonth.startTime, swept: currentMonth.high > previousMonth.high });
    levels.push({ label: 'PML', price: previousMonth.low, startTime: currentMonth.startTime, swept: currentMonth.low < previousMonth.low });
  }
  if (currentMonth) levels.push({ label: 'MO', price: currentMonth.open, startTime: currentMonth.startTime, swept: false });
  return levels;
};
