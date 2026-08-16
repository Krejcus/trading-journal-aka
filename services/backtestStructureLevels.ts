import type { MarketCandle } from './marketData';

/**
 * Struktura a tři SL úrovně přesně tak, jak je počítá AlphaBridge.
 *
 * Záměrně se **nepoužívá** `calculateMarketStructure` z `marketData.ts`. Ten
 * pracuje s ATR filtrem a vrací jiné zlomy než extension — a když by jedno
 * pole `Trade.slPlacement` nebo `entryMap.structureType` znamenalo u živého
 * obchodu něco jiného než u backtestového, agregáty v Labu by míchaly dvě
 * různé definice a nikdo by si toho nevšiml.
 *
 * Zdroj pravdy je proto extension: pivoty 1/1, zlom se registruje na close
 * přes poslední pivot, swing je chráněný extrém posledního zlomu, OTE je
 * 0,79 impulzní nohy a FVG je vzdálená hrana tříswíčkové mezery u vstupu.
 */

/** Okno barů před vstupem, ve kterém se hledají pivoty. Stejné jako v extension. */
const STRUCTURE_LOOKBACK_BARS = 200;
/** Entry musí ležet na proximální hraně FVG, ne pouze někde poblíž zóny. */
const FVG_ENTRY_TOLERANCE_TICKS = 1;
/** Kolik barů zpět od vstupu se mezery hledají. */
const FVG_LOOKBACK_BARS = 40;
/** Retracement, na kterém leží OTE. */
const OTE_RATIO = 0.79;

export interface BacktestStructureEvent {
  direction: 'bull' | 'bear';
  /** Cena pivotu, který close prorazil. */
  broken: number;
  /** Chráněný protilehlý extrém — kandidát na swing stop. */
  protectedPrice: number | null;
  protectedIndex: number | null;
  atIndex: number;
}

export interface BacktestEntryFvgRead {
  timeframe: '1m';
  direction: 'bull' | 'bear';
  bornTime: number;
  top: number;
  bottom: number;
  /** Hrana, na kterou se limit vrací jako první. */
  proximal: number;
  /** Chráněná vzdálená hrana — kandidát na FVG stop. */
  distal: number;
  entryDistanceTicks: number;
}

export interface BacktestStructureRead {
  available: boolean;
  events: BacktestStructureEvent[];
  /** CHoCH = první zlom v sérii mým směrem, BoS = druhý a další. */
  structureType: 'CHoCH' | 'BoS' | null;
  /** Kolikátý zlom ve směru obchodu vstup následuje. */
  structureOrder: number;
  /** Chráněný extrém prvního zlomu série — bod, od kterého se cena otočila. */
  odrazPrice: number | null;
  odrazIndex: number | null;
  swing: number | null;
  ote: number | null;
  fvg: number | null;
  /** Potvrzené a v okamžiku před vstupní svíčkou stále aktivní 1m FVG. */
  entryFvg: BacktestEntryFvgRead | null;
}

const emptyRead = (): BacktestStructureRead => ({
  available: false, events: [], structureType: null, structureOrder: 0,
  odrazPrice: null, odrazIndex: null, swing: null, ote: null, fvg: null, entryFvg: null,
});

/** Index svíčky, na které obchod vstoupil. `-1` když čas v datech není. */
export const backtestEntryIndex = (candles: readonly MarketCandle[], entryTime: number): number => {
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    if (candles[index].time <= entryTime) return index;
  }
  return -1;
};

export const readBacktestStructure = (
  candles: readonly MarketCandle[],
  entryTime: number,
  entryPrice: number,
  long: boolean,
  tickSize: number,
): BacktestStructureRead => {
  const entryIndex = backtestEntryIndex(candles, entryTime);
  if (entryIndex < 3) return emptyRead();
  const windowStart = Math.max(1, entryIndex - STRUCTURE_LOOKBACK_BARS);

  // ── pivoty 1/1 do vstupu ──
  const pivotHighs: { index: number; price: number }[] = [];
  const pivotLows: { index: number; price: number }[] = [];
  // Vstupní 1m bar není v okamžiku fillu hotový. Ani jeho close, ani jeho použití
  // jako pravé strany pivotu proto nesmí rozhodovat o kontextu vstupu.
  for (let index = windowStart; index <= entryIndex - 2; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const next = candles[index + 1];
    if (!current || !previous || !next) continue;
    if (current.high > previous.high && current.high > next.high) pivotHighs.push({ index, price: current.high });
    if (current.low < previous.low && current.low < next.low) pivotLows.push({ index, price: current.low });
  }

  // ── zlomy: close přes poslední pivot, každá cena se registruje jen jednou ──
  const events: BacktestStructureEvent[] = [];
  let lastBrokenHigh: number | null = null;
  let lastBrokenLow: number | null = null;
  let lastBull: BacktestStructureEvent | null = null;
  let lastBear: BacktestStructureEvent | null = null;
  const latestBefore = (pivots: { index: number; price: number }[], limit: number) => {
    for (let k = pivots.length - 1; k >= 0; k -= 1) if (pivots[k].index <= limit) return pivots[k];
    return null;
  };
  for (let index = windowStart + 2; index <= entryIndex - 1; index += 1) {
    const candle = candles[index];
    if (!candle) continue;
    const high = latestBefore(pivotHighs, index - 1);
    const low = latestBefore(pivotLows, index - 1);
    if (high && candle.close > high.price && high.price !== lastBrokenHigh) {
      lastBrokenHigh = high.price;
      lastBull = {
        direction: 'bull', broken: high.price,
        protectedPrice: low?.price ?? null, protectedIndex: low?.index ?? null, atIndex: index,
      };
      events.push(lastBull);
    }
    if (low && candle.close < low.price && low.price !== lastBrokenLow) {
      lastBrokenLow = low.price;
      lastBear = {
        direction: 'bear', broken: low.price,
        protectedPrice: high?.price ?? null, protectedIndex: high?.index ?? null, atIndex: index,
      };
      events.push(lastBear);
    }
  }

  const roundTick = (price: number | null) => price === null || !(tickSize > 0)
    ? price
    : Math.round(price / tickSize) * tickSize;

  // ── swing = chráněný extrém posledního zlomu ve směru obchodu ──
  const directional = long ? lastBull : lastBear;
  const swing = directional?.protectedPrice ?? null;

  // ── OTE = 0,79 impulzní nohy od chráněného extrému k dosaženému vrcholu ──
  let ote: number | null = null;
  if (directional?.protectedPrice != null && directional.protectedIndex != null) {
    if (long) {
      let peak = -Infinity;
      for (let index = directional.protectedIndex; index <= entryIndex - 1; index += 1) {
        const candle = candles[index];
        if (candle && candle.high > peak) peak = candle.high;
      }
      const base = directional.protectedPrice;
      if (peak > base && peak !== -Infinity) ote = peak - OTE_RATIO * (peak - base);
    } else {
      let trough = Infinity;
      for (let index = directional.protectedIndex; index <= entryIndex - 1; index += 1) {
        const candle = candles[index];
        if (candle && candle.low < trough) trough = candle.low;
      }
      const base = directional.protectedPrice;
      if (trough < base && trough !== Infinity) ote = trough + OTE_RATIO * (base - trough);
    }
  }

  // ── FVG = vzdálená hrana mezery, jejíž bližší hrana leží u vstupu ──
  let entryFvg: BacktestEntryFvgRead | null = null;
  let bestDistance = Infinity;
  for (let index = Math.max(1, entryIndex - FVG_LOOKBACK_BARS); index <= entryIndex - 2; index += 1) {
    const before = candles[index - 1];
    const after = candles[index + 1];
    if (!before || !after) continue;
    const bornIndex = index + 1;
    const activeUntilEntry = (direction: 'bull' | 'bear', top: number, bottom: number) => {
      for (let scan = bornIndex + 1; scan < entryIndex; scan += 1) {
        const candle = candles[scan];
        if (!candle) continue;
        if (direction === 'bull' ? candle.low <= bottom : candle.high >= top) return false;
      }
      return true;
    };
    if (long) {
      // Bullish mezera: dno = high první svíčky, strop = low třetí. Vstup leží
      // u stropu, chráněná strana je dno.
      if (after.low > before.high) {
        const top = after.low;
        const bottom = before.high;
        const distance = Math.abs(entryPrice - top);
        if (bottom < entryPrice
          && activeUntilEntry('bull', top, bottom)
          && distance < bestDistance
          && distance <= tickSize * FVG_ENTRY_TOLERANCE_TICKS) {
          bestDistance = distance;
          entryFvg = {
            timeframe: '1m', direction: 'bull', bornTime: after.time,
            top, bottom, proximal: top, distal: bottom,
            entryDistanceTicks: tickSize > 0 ? distance / tickSize : 0,
          };
        }
      }
    } else if (after.high < before.low) {
      const top = before.low;
      const bottom = after.high;
      const distance = Math.abs(entryPrice - bottom);
      if (top > entryPrice
        && activeUntilEntry('bear', top, bottom)
        && distance < bestDistance
        && distance <= tickSize * FVG_ENTRY_TOLERANCE_TICKS) {
        bestDistance = distance;
        entryFvg = {
          timeframe: '1m', direction: 'bear', bornTime: after.time,
          top, bottom, proximal: bottom, distal: top,
          entryDistanceTicks: tickSize > 0 ? distance / tickSize : 0,
        };
      }
    }
  }

  // ── série zlomů mým směrem, na jejímž konci vstup leží ──
  const myDirection = long ? 'bull' : 'bear';
  let lastMine = -1;
  for (let k = events.length - 1; k >= 0; k -= 1) if (events[k].direction === myDirection) { lastMine = k; break; }
  let runStart = lastMine;
  if (lastMine >= 0) {
    for (let k = lastMine; k >= 0; k -= 1) {
      if (events[k].direction === myDirection) runStart = k;
      else break;
    }
  }
  const run = lastMine >= 0 ? events.slice(runStart, lastMine + 1) : [];
  const structureOrder = run.length;

  return {
    available: events.length > 0,
    events,
    // První zlom v sérii je změna charakteru, každý další už jen pokračování.
    structureType: structureOrder >= 1 ? (structureOrder === 1 ? 'CHoCH' : 'BoS') : null,
    structureOrder,
    odrazPrice: run.length ? roundTick(run[0].protectedPrice) : null,
    odrazIndex: run.length ? run[0].protectedIndex : null,
    swing: roundTick(swing),
    ote: roundTick(ote),
    fvg: roundTick(entryFvg?.distal ?? null),
    entryFvg: entryFvg ? {
      ...entryFvg,
      top: roundTick(entryFvg.top) as number,
      bottom: roundTick(entryFvg.bottom) as number,
      proximal: roundTick(entryFvg.proximal) as number,
      distal: roundTick(entryFvg.distal) as number,
    } : null,
  };
};

export interface BacktestTrailResult {
  exit: number;
  reason: 'tp' | 'trail+' | 'trail' | 'open';
  bars: number | null;
  realizedR: number | null;
  trailSteps: number;
  trailFinal: number;
  trailStart: number;
}

/**
 * Strukturní trailing od zadané startovní stopky.
 *
 * Na každý vnitřní zlom ve směru obchodu se stopka posune pod nejbližší vyšší
 * dno (u longu), nikdy ale proti obchodu. Výsledek se měří v R **té startovní
 * stopky** — je to alternativní obchod s vlastním rizikem, ne řízení toho
 * původního.
 */
export const backtestStructuralTrail = (
  candles: readonly MarketCandle[],
  entryTime: number,
  entryPrice: number,
  long: boolean,
  start: number,
  takeProfit: number | undefined,
  tickSize: number,
): BacktestTrailResult | null => {
  const entryIndex = backtestEntryIndex(candles, entryTime);
  if (entryIndex < 1 || entryIndex >= candles.length - 1) return null;
  const risk = long ? entryPrice - start : start - entryPrice;
  if (!(risk > 0)) return null;

  const pivotHighs: { index: number; price: number }[] = [];
  const pivotLows: { index: number; price: number }[] = [];
  for (let index = entryIndex; index <= candles.length - 2; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const next = candles[index + 1];
    if (!current || !previous || !next) continue;
    if (current.high > previous.high && current.high > next.high) pivotHighs.push({ index, price: current.high });
    if (current.low < previous.low && current.low < next.low) pivotLows.push({ index, price: current.low });
  }
  const latestBefore = (pivots: { index: number; price: number }[], limit: number) => {
    for (let k = pivots.length - 1; k >= 0; k -= 1) if (pivots[k].index <= limit) return pivots[k];
    return null;
  };

  let trail = start;
  let steps = 0;
  let brokenHigh: number | null = null;
  let brokenLow: number | null = null;
  let exitPrice: number | null = null;
  let exitIndex = -1;
  let reason: BacktestTrailResult['reason'] = 'open';

  for (let index = entryIndex + 1; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!candle) continue;
    if (long) {
      if (candle.low <= trail) { exitPrice = trail; exitIndex = index; reason = trail > entryPrice ? 'trail+' : 'trail'; break; }
      if (takeProfit !== undefined && candle.high >= takeProfit) { exitPrice = takeProfit; exitIndex = index; reason = 'tp'; break; }
    } else {
      if (candle.high >= trail) { exitPrice = trail; exitIndex = index; reason = trail < entryPrice ? 'trail+' : 'trail'; break; }
      if (takeProfit !== undefined && candle.low <= takeProfit) { exitPrice = takeProfit; exitIndex = index; reason = 'tp'; break; }
    }
    const high = latestBefore(pivotHighs, index - 1);
    const low = latestBefore(pivotLows, index - 1);
    if (long) {
      if (high && candle.close > high.price && high.price !== brokenHigh) {
        brokenHigh = high.price;
        if (low && low.price > trail) { trail = low.price; steps += 1; }
      }
    } else if (low && candle.close < low.price && low.price !== brokenLow) {
      brokenLow = low.price;
      if (high && high.price < trail) { trail = high.price; steps += 1; }
    }
  }

  if (exitPrice === null) {
    exitPrice = candles[candles.length - 1]?.close ?? entryPrice;
    reason = 'open';
  }
  const roundTick = (price: number) => tickSize > 0 ? Math.round(price / tickSize) * tickSize : price;
  const realized = long ? (exitPrice - entryPrice) / risk : (entryPrice - exitPrice) / risk;
  return {
    exit: roundTick(exitPrice),
    reason,
    bars: exitIndex > 0 ? exitIndex - entryIndex : null,
    realizedR: Math.round(realized * 100) / 100,
    trailSteps: steps,
    trailFinal: roundTick(trail),
    trailStart: roundTick(start),
  };
};
