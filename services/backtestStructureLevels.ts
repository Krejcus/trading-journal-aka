import { calculateMarketStructure, type MarketCandle, type MarketStructureEvent } from './marketData';

/**
 * Struktura a tři SL úrovně ze stejného zdroje, který kreslí replay graf.
 * `calculateMarketStructure` nese i chraneny protilehly pivot, takže CHoCH,
 * BoS, odraz, swing a OTE uz nemaji druhou paralelni implementaci.
 */

/** Entry musí ležet na proximální hraně FVG, ne pouze někde poblíž zóny. */
const FVG_ENTRY_TOLERANCE_TICKS = 1;
/** Kolik barů zpět od vstupu se mezery hledají. */
const FVG_LOOKBACK_BARS = 40;
/** Retracement, na kterém leží OTE. */
const OTE_RATIO = 0.79;

export interface BacktestStructureEvent {
  id: string;
  type: 'CHoCH' | 'BoS';
  direction: 'bull' | 'bear';
  /** Cena pivotu, který close prorazil. */
  broken: number;
  /** Chráněný protilehlý extrém — kandidát na swing stop. */
  protectedPrice: number | null;
  protectedIndex: number | null;
  atIndex: number;
  breakTime: number;
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
  /** Stabilní vazba na CHoCH/BoS, jehož displacement FVG vytvořil. */
  parentStructureId: string | null;
  parentStructureType: 'CHoCH' | 'BoS' | null;
  parentStructureOrder: number;
  parentBreakTime: number | null;
  parentProtectedPrice: number | null;
  parentImpulseExtreme: number | null;
  /** Pořadí vybraného FVG mezi FVG stejného rodiče, počítané od 1. */
  fvgIndexInImpulse: number;
  fvgCountInImpulse: number;
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
  sharedEvents?: readonly MarketStructureEvent[],
): BacktestStructureRead => {
  // OHLC vstupni minuty jeste pri fillu neni zname. Sdileny zdroj proto vidi
  // jen dokoncene bary striktne pred entry timestampem.
  const history = candles.filter(candle => candle.time < entryTime);
  const entryIndex = history.length;
  if (entryIndex < 3) return emptyRead();
  const indexByTime = new Map(history.map((candle, index) => [candle.time, index]));
  const canonicalEvents = sharedEvents ? [...sharedEvents] : calculateMarketStructure(history);
  const events: BacktestStructureEvent[] = canonicalEvents
    .filter(event => event.breakTime < entryTime && indexByTime.has(event.breakTime))
    .map(event => ({
    id: `${event.direction}:${event.breakTime}:${event.price}`,
    type: event.type === 'BOS' ? 'BoS' : 'CHoCH',
    direction: event.direction === 'bullish' ? 'bull' : 'bear',
    broken: event.price,
    protectedPrice: event.protectedPrice ?? null,
    protectedIndex: event.protectedTime == null ? null : indexByTime.get(event.protectedTime) ?? null,
    atIndex: indexByTime.get(event.breakTime) as number,
    breakTime: event.breakTime,
  }));

  const roundTick = (price: number | null) => price === null || !(tickSize > 0)
    ? price
    : Math.round(price / tickSize) * tickSize;

  type FvgCandidate = Omit<BacktestEntryFvgRead,
    'parentStructureId' | 'parentStructureType' | 'parentStructureOrder'
    | 'parentBreakTime' | 'parentProtectedPrice' | 'parentImpulseExtreme'
    | 'fvgIndexInImpulse' | 'fvgCountInImpulse'> & {
      bornIndex: number;
      middleIndex: number;
      parent: BacktestStructureEvent | null;
    };
  const fvgCandidates: FvgCandidate[] = [];
  const parentForGap = (middleIndex: number, bornIndex: number): BacktestStructureEvent | null => {
    const myDirection = long ? 'bull' : 'bear';
    const sameDirection = events.filter(event => event.direction === myDirection && event.protectedIndex !== null);
    // Nejpřesnější případ: prostřední displacement svíčka patří přímo do nohy
    // od chráněného pivotu po potvrzující close CHoCH/BoS.
    const containing = sameDirection
      .filter(event => (event.protectedIndex as number) <= middleIndex && middleIndex <= event.atIndex)
      .sort((left, right) => left.atIndex - right.atIndex)[0];
    if (containing) return containing;

    // FVG může být potvrzeno třetí svíčkou těsně po breaku. Vezmeme poslední
    // stejnosměrný event pouze pokud mezi ním a FVG nevznikl opačný zlom.
    const preceding = [...sameDirection]
      .filter(event => event.atIndex <= bornIndex)
      .sort((left, right) => right.atIndex - left.atIndex)[0] ?? null;
    if (!preceding) return null;
    const contradicted = events.some(event => (
      event.direction !== myDirection
      && event.atIndex > preceding.atIndex
      && event.atIndex <= bornIndex
    ));
    return contradicted ? null : preceding;
  };

  // ── Najdi všechna do vstupu aktivní FVG a přivaž je k rodičovské struktuře ──
  for (let index = Math.max(1, entryIndex - FVG_LOOKBACK_BARS); index <= entryIndex - 2; index += 1) {
    const before = history[index - 1];
    const after = history[index + 1];
    if (!before || !after) continue;
    const bornIndex = index + 1;
    const activeUntilEntry = (direction: 'bull' | 'bear', top: number, bottom: number) => {
      for (let scan = bornIndex + 1; scan < entryIndex; scan += 1) {
        const candle = history[scan];
        if (!candle) continue;
        // Entry model je návrat na dosud netknutou proximální hranu. Jakýkoli
        // dřívější dotyk už by limit vyplnil a gap pro pozdější entry neplatí.
        if (direction === 'bull' ? candle.low <= top : candle.high >= bottom) return false;
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
        if (activeUntilEntry('bull', top, bottom)) {
          fvgCandidates.push({
            timeframe: '1m', direction: 'bull', bornTime: after.time,
            top, bottom, proximal: top, distal: bottom,
            entryDistanceTicks: tickSize > 0 ? distance / tickSize : 0,
            bornIndex, middleIndex: index,
            parent: parentForGap(index, bornIndex),
          });
        }
      }
    } else if (after.high < before.low) {
      const top = before.low;
      const bottom = after.high;
      const distance = Math.abs(entryPrice - bottom);
      if (activeUntilEntry('bear', top, bottom)) {
        fvgCandidates.push({
          timeframe: '1m', direction: 'bear', bornTime: after.time,
          top, bottom, proximal: bottom, distal: top,
          entryDistanceTicks: tickSize > 0 ? distance / tickSize : 0,
          bornIndex, middleIndex: index,
          parent: parentForGap(index, bornIndex),
        });
      }
    }
  }

  const selectedCandidate = fvgCandidates
    .filter(candidate => candidate.entryDistanceTicks <= FVG_ENTRY_TOLERANCE_TICKS)
    .sort((left, right) => (
      left.entryDistanceTicks - right.entryDistanceTicks
      || Number(Boolean(right.parent)) - Number(Boolean(left.parent))
      || right.bornTime - left.bornTime
    ))[0] ?? null;
  const parent = selectedCandidate?.parent ?? null;

  const siblings = parent
    ? fvgCandidates
      .filter(candidate => candidate.parent?.id === parent.id)
      .sort((left, right) => left.bornTime - right.bornTime)
    : [];
  const selectedSiblingIndex = selectedCandidate && parent
    ? siblings.findIndex(candidate => candidate.bornTime === selectedCandidate.bornTime
      && candidate.top === selectedCandidate.top && candidate.bottom === selectedCandidate.bottom)
    : -1;

  // Swing i OTE se počítají výhradně z rodiče vybraného FVG. Nikdy už se
  // nesmí smíchat gap jednoho impulsu s poslední, ale nesouvisející strukturou.
  const swing = parent?.protectedPrice ?? null;
  let impulseExtreme: number | null = null;
  let ote: number | null = null;
  if (parent?.protectedPrice != null && parent.protectedIndex != null) {
    const leg = history.slice(parent.protectedIndex, parent.atIndex + 1);
    if (long) {
      const peak = leg.reduce((value, candle) => Math.max(value, candle.high), -Infinity);
      if (peak > parent.protectedPrice && peak !== -Infinity) {
        impulseExtreme = peak;
        ote = peak - OTE_RATIO * (peak - parent.protectedPrice);
      }
    } else {
      const trough = leg.reduce((value, candle) => Math.min(value, candle.low), Infinity);
      if (trough < parent.protectedPrice && trough !== Infinity) {
        impulseExtreme = trough;
        ote = trough + OTE_RATIO * (parent.protectedPrice - trough);
      }
    }
  }

  // Pořadí rodiče v nepřerušené sérii stejnosměrných zlomů.
  const myDirection = long ? 'bull' : 'bear';
  const parentEventIndex = parent ? events.findIndex(event => event.id === parent.id) : -1;
  let runStart = parentEventIndex;
  if (parentEventIndex >= 0) {
    for (let index = parentEventIndex; index >= 0; index -= 1) {
      if (events[index].direction === myDirection) runStart = index;
      else break;
    }
  }
  const run = parentEventIndex >= 0 ? events.slice(runStart, parentEventIndex + 1) : [];
  const structureOrder = run.length;

  const entryFvg: BacktestEntryFvgRead | null = selectedCandidate ? {
    timeframe: selectedCandidate.timeframe,
    direction: selectedCandidate.direction,
    bornTime: selectedCandidate.bornTime,
    top: selectedCandidate.top,
    bottom: selectedCandidate.bottom,
    proximal: selectedCandidate.proximal,
    distal: selectedCandidate.distal,
    entryDistanceTicks: selectedCandidate.entryDistanceTicks,
    parentStructureId: parent?.id ?? null,
    parentStructureType: parent?.type ?? null,
    parentStructureOrder: structureOrder,
    parentBreakTime: parent?.breakTime ?? null,
    parentProtectedPrice: parent?.protectedPrice ?? null,
    parentImpulseExtreme: impulseExtreme,
    fvgIndexInImpulse: selectedSiblingIndex >= 0 ? selectedSiblingIndex + 1 : 0,
    fvgCountInImpulse: siblings.length,
  } : null;

  return {
    available: events.length > 0 || entryFvg !== null,
    events,
    // První zlom v sérii je změna charakteru, každý další už jen pokračování.
    structureType: parent?.type ?? null,
    structureOrder,
    odrazPrice: roundTick(parent?.protectedPrice ?? null),
    odrazIndex: parent?.protectedIndex ?? null,
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
