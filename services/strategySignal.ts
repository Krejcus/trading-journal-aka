import { findFairValueGaps, type FairValueGap, type MarketCandle } from './marketData';
import { readBacktestStructure, type BacktestStructureEvent } from './backtestStructureLevels';
import type { LiquidityLevel } from './liquidityLevels';

/**
 * Detektor Filipova vstupního modelu.
 *
 * Sekvence: dotek likviditního extrému knotem → otočka → zlom struktury, který
 * musí přijít dřív, než cena trefí úroveň na opačné straně → vstup na hraně
 * mezery, která v té otočce vznikla. Bez mezery vstup není.
 *
 * Dvě věci, které tenhle modul dělá schválně jinak, než by se nabízelo:
 *
 * Za prvé **nic nezamítá kvůli pravidlům, která jsou zrovna ve zkoušce.** HTF
 * struktura ani odraz z HTF mezery se jen zaznamenají. Kdyby filtrovaly hned,
 * nikdy by nešlo zjistit, jestli filtrují dobře — jen by bylo míň setupů.
 *
 * Za druhé **vrací všechny kandidátní mezery, ne jednu.** Které z nich patří
 * vstup, je otevřená otázka (první vzniklá vs. první dosažená), takže výběr je
 * parametr a druhá varianta se dá dopočítat zpětně z týchž dat, bez nového
 * sběru.
 */

/**
 * Sweepovat jde libovolná úroveň, kterou indikátor umí nakreslit — statické
 * (PDH/PDL, ON H/L, session extrémy, IB, midpointy) i pohyblivá VWAP rodina.
 * Seznam se schválně nefiltruje podle jmen: co je level, to je potenciální
 * likvidita, a čím z toho model doopravdy žije, ukáže až měření.
 */

export type StrategyDirection = 'long' | 'short';

export type StrategyRejection =
  | 'no-sweep'
  | 'no-structure-break'
  | 'opposite-level-first'
  | 'no-fvg';

/** Která mezera z otočky nese vstup. Otevřená otázka, proto parametr. */
export type FvgSelection = 'first-formed' | 'first-reached';

/** Co se počítá jako „opačný level", jehož trefení setup zneškodní. */
export type OppositeLevelRule = 'any' | 'nearest-untapped' | 'mirror';

export interface StrategySignalOptions {
  fvgSelection?: FvgSelection;
  oppositeLevel?: OppositeLevelRule;
  /** Kolik svíček zpět se sweep hledá. */
  sweepLookbackBars?: number;
  tickSize?: number;
}

const DEFAULTS: Required<Omit<StrategySignalOptions, 'tickSize'>> & { tickSize: number } = {
  fvgSelection: 'first-formed',
  oppositeLevel: 'any',
  sweepLookbackBars: 120,
  tickSize: 0.25,
};

export interface StrategySweep {
  level: string;
  price: number;
  /** Čas svíčky, jejíž knot se úrovně dotkl. */
  time: number;
  index: number;
  /** Sweep horní úrovně vede na short, spodní na long. */
  direction: StrategyDirection;
}

export interface StrategyFvgCandidate {
  /** Pořadí vzniku v otočce, od 1. */
  order: number;
  top: number;
  bottom: number;
  /** Hrana, na které se vstupuje — ta bližší ceně při návratu. */
  entryEdge: number;
  /** Hrana pro stop. */
  stopEdge: number;
  formedAt: number;
  /** Mezera vznikla až po zlomu struktury. */
  afterBreak: boolean;
  /** Cena se do mezery od jejího vzniku ještě nevrátila. */
  untouched: boolean;
  /** Vzdálenost hrany od poslední ceny v bodech. */
  distanceFromPrice: number;
}

/** Kontext, který se jen měří a o platnosti setupu nerozhoduje. */
export interface StrategyObservations {
  htfStructure5m: 'bullish' | 'bearish' | null;
  htfStructure15m: 'bullish' | 'bearish' | null;
  /** Poslední svíčka reaguje z 5m nebo 15m mezery. */
  htfFvgBounce: boolean;
  /** Zlom je prvním v sérii svým směrem. */
  structureType: 'CHoCH' | 'BoS' | null;
  barsFromSweepToBreak: number | null;
}

export interface StrategySignal {
  kind: 'signal';
  direction: StrategyDirection;
  sweep: StrategySweep;
  breakEvent: BacktestStructureEvent;
  candidates: StrategyFvgCandidate[];
  /** Vybraný kandidát podle `fvgSelection`. */
  selected: StrategyFvgCandidate;
  entry: number;
  stop: number;
  observations: StrategyObservations;
}

export interface StrategyRejected {
  kind: 'rejected';
  reason: StrategyRejection;
  /** Co se stihlo najít, než to spadlo — pro kreslení v ověřovacím režimu. */
  sweep?: StrategySweep;
  breakEvent?: BacktestStructureEvent;
  candidates?: StrategyFvgCandidate[];
  observations?: StrategyObservations;
}

export type StrategyEvaluation = StrategySignal | StrategyRejected;

/**
 * Pohyblivá úroveň (VWAP a jeho deviace).
 *
 * Na rozdíl od PDH se hýbe s každou svíčkou, takže se dotek testuje proti
 * hodnotě pásma V TÉ svíčce, ne proti poslední. Jinak by se sweep z rána
 * porovnával s odpolední polohou VWAPu.
 */
export interface StrategyDynamicLevel {
  name: string;
  points: readonly { time: number; value: number }[];
}

export interface StrategyInput {
  /** Minutové svíčky POUZE do kurzoru. Cokoli navíc by bylo nahlédnutí dopředu. */
  candles: readonly MarketCandle[];
  /** Likviditní úrovně platné k témuž okamžiku. */
  levels: readonly LiquidityLevel[];
  /** VWAP a deviace jako časové řady. */
  dynamicLevels?: readonly StrategyDynamicLevel[];
  /** Agregované svíčky pro měřený HTF kontext. Nepovinné. */
  candles5m?: readonly MarketCandle[];
  candles15m?: readonly MarketCandle[];
}

/**
 * Nejnovější dotek některé z likviditních úrovní.
 *
 * Bere se poslední, ne první: setup vzniká z aktuální otočky, a starší sweep
 * z rána už dávno nemá s tím, co cena dělá teď, nic společného.
 */
export const findLatestSweep = (
  candles: readonly MarketCandle[],
  levels: readonly LiquidityLevel[],
  lookbackBars: number,
  dynamicLevels: readonly StrategyDynamicLevel[] = [],
): StrategySweep | null => {
  const cleanName = (name: string) => name.replace(/\s*\[.*?\]\s*$/, '').trim();
  const usable = levels.filter(level => Number.isFinite(level.price));
  const dynamic = dynamicLevels.map(series => ({
    name: series.name,
    byTime: new Map(series.points.map(point => [point.time, point.value])),
  }));
  if (usable.length === 0 && dynamic.length === 0) return null;
  if (candles.length === 0) return null;
  const from = Math.max(0, candles.length - Math.max(1, lookbackBars));
  // Dotek knotem stačí — proražení closem se nevyžaduje. Svíčka ale musí být
  // celým tělem na jedné straně, jinak by se za sweep počítal každý bar, který
  // se kolem úrovně motá.
  const hit = (candle: MarketCandle, price: number, name: string, index: number): StrategySweep | null => {
    if (!Number.isFinite(price)) return null;
    if (candle.high >= price && candle.open < price && candle.close < price) {
      return { level: name, price, time: candle.time, index, direction: 'short' };
    }
    if (candle.low <= price && candle.open > price && candle.close > price) {
      return { level: name, price, time: candle.time, index, direction: 'long' };
    }
    return null;
  };
  for (let index = candles.length - 1; index >= from; index -= 1) {
    const candle = candles[index];
    for (const level of usable) {
      const found = hit(candle, level.price, cleanName(level.name), index);
      if (found) return found;
    }
    for (const series of dynamic) {
      const value = series.byTime.get(candle.time);
      if (value === undefined) continue;
      const found = hit(candle, value, series.name, index);
      if (found) return found;
    }
  }
  return null;
};

/**
 * Cena, jejíž dosažení setup zneškodní.
 *
 * `any` je nejpřísnější — bere nejbližší pojmenovanou úroveň v protisměru bez
 * ohledu na to, jestli už byla sebraná. Okno na zlom je pak nejkratší.
 */
export const oppositeLevelPrice = (
  levels: readonly LiquidityLevel[],
  sweep: StrategySweep,
  rule: OppositeLevelRule,
): number | null => {
  const long = sweep.direction === 'long';
  const beyond = levels.filter(level => Number.isFinite(level.price)
    && (long ? level.price > sweep.price : level.price < sweep.price));
  if (rule === 'mirror') {
    const mirror = sweep.level.replace(/H$/, 'L#').replace(/L$/, 'H').replace('H#', 'H').replace('L#', 'L');
    const found = levels.find(level => level.name === mirror);
    return found?.price ?? null;
  }
  const pool = rule === 'nearest-untapped' ? beyond.filter(level => !level.swept) : beyond;
  if (pool.length === 0) return null;
  return long
    ? Math.min(...pool.map(level => level.price))
    : Math.max(...pool.map(level => level.price));
};

const touchedOpposite = (
  candles: readonly MarketCandle[],
  fromIndex: number,
  toIndex: number,
  price: number | null,
  direction: StrategyDirection,
): number | null => {
  if (price === null) return null;
  for (let index = fromIndex; index <= toIndex && index < candles.length; index += 1) {
    const candle = candles[index];
    if (direction === 'long' ? candle.high >= price : candle.low <= price) return index;
  }
  return null;
};

const structureDirectionOf = (candles: readonly MarketCandle[], tickSize: number) => {
  if (candles.length < 4) return null;
  const last = candles[candles.length - 1];
  const read = readBacktestStructure(candles, last.time, last.close, true, tickSize);
  const event = read.events[read.events.length - 1];
  return event ? (event.direction === 'bull' ? 'bullish' as const : 'bearish' as const) : null;
};

const bouncesFromHtfGap = (candles: readonly MarketCandle[] | undefined, price: number): boolean => {
  if (!candles || candles.length < 3) return false;
  return findFairValueGaps([...candles]).some(gap =>
    !gap.mitigated && price >= gap.bottom && price <= gap.top);
};

export const evaluateStrategySignal = (
  input: StrategyInput,
  options: StrategySignalOptions = {},
): StrategyEvaluation => {
  const config = { ...DEFAULTS, ...options };
  const { candles, levels } = input;
  const last = candles[candles.length - 1];

  const sweep = findLatestSweep(candles, levels, config.sweepLookbackBars, input.dynamicLevels ?? []);
  if (!sweep) return { kind: 'rejected', reason: 'no-sweep' };

  const long = sweep.direction === 'long';
  const structure = readBacktestStructure(
    candles, last.time, last.close, long, config.tickSize,
  );
  // Zlom musí být ve směru obchodu, tedy proti swepnuté straně, a až po sweepu.
  const wanted = long ? 'bull' : 'bear';
  const breakEvent = structure.events.find(event =>
    event.direction === wanted && event.atIndex > sweep.index);

  const observationsOf = (event?: BacktestStructureEvent): StrategyObservations => ({
    htfStructure5m: structureDirectionOf(input.candles5m ?? [], config.tickSize),
    htfStructure15m: structureDirectionOf(input.candles15m ?? [], config.tickSize),
    htfFvgBounce: bouncesFromHtfGap(input.candles5m, last.close)
      || bouncesFromHtfGap(input.candles15m, last.close),
    structureType: event ? structure.structureType : null,
    barsFromSweepToBreak: event ? event.atIndex - sweep.index : null,
  });

  if (!breakEvent) {
    return { kind: 'rejected', reason: 'no-structure-break', sweep, observations: observationsOf() };
  }

  const opposite = oppositeLevelPrice(levels, sweep, config.oppositeLevel);
  const oppositeHit = touchedOpposite(candles, sweep.index, breakEvent.atIndex, opposite, sweep.direction);
  if (oppositeHit !== null && oppositeHit < breakEvent.atIndex) {
    return {
      kind: 'rejected', reason: 'opposite-level-first',
      sweep, breakEvent, observations: observationsOf(breakEvent),
    };
  }

  const candidates = collectTurnFvgs(candles, sweep, breakEvent, long, last.close);
  if (candidates.length === 0) {
    return {
      kind: 'rejected', reason: 'no-fvg',
      sweep, breakEvent, candidates: [], observations: observationsOf(breakEvent),
    };
  }

  const selected = selectFvg(candidates, config.fvgSelection);
  return {
    kind: 'signal',
    direction: sweep.direction,
    sweep,
    breakEvent,
    candidates,
    selected,
    entry: selected.entryEdge,
    stop: selected.stopEdge,
    observations: observationsOf(breakEvent),
  };
};

/**
 * Mezery vzniklé v otočce, tedy od sweepu dál.
 *
 * Sbírají se i ty, které vznikly až za zlomem — `afterBreak` je odliší. Kde
 * přesně otočka končí, je další otevřená otázka, a data na ni odpoví jen když
 * se obě skupiny zaznamenají.
 */
const collectTurnFvgs = (
  candles: readonly MarketCandle[],
  sweep: StrategySweep,
  breakEvent: BacktestStructureEvent,
  long: boolean,
  price: number,
): StrategyFvgCandidate[] => {
  const wanted: FairValueGap['direction'] = long ? 'bullish' : 'bearish';
  const sweepTime = candles[sweep.index]?.time ?? 0;
  const breakTime = candles[breakEvent.atIndex]?.time ?? 0;
  return findFairValueGaps([...candles])
    .filter(gap => gap.direction === wanted && gap.startTime >= sweepTime)
    .sort((left, right) => left.startTime - right.startTime)
    .map((gap, index) => {
      // U longu se cena vrací shora dolů, takže první potká strop mezery.
      const entryEdge = long ? gap.top : gap.bottom;
      const stopEdge = long ? gap.bottom : gap.top;
      return {
        order: index + 1,
        top: gap.top,
        bottom: gap.bottom,
        entryEdge,
        stopEdge,
        formedAt: gap.startTime,
        afterBreak: gap.startTime > breakTime,
        untouched: !gap.touched,
        distanceFromPrice: Math.abs(price - entryEdge),
      };
    });
};

export const selectFvg = (
  candidates: readonly StrategyFvgCandidate[],
  selection: FvgSelection,
): StrategyFvgCandidate => {
  const untouched = candidates.filter(candidate => candidate.untouched);
  const pool = untouched.length ? untouched : candidates;
  if (selection === 'first-reached') {
    return pool.reduce((best, candidate) =>
      candidate.distanceFromPrice < best.distanceFromPrice ? candidate : best);
  }
  return pool.reduce((best, candidate) => candidate.order < best.order ? candidate : best);
};

export const STRATEGY_REJECTION_LABELS: Record<StrategyRejection, string> = {
  'no-sweep': 'bez sweepu',
  'no-structure-break': 'zlom struktury zatím nepřišel',
  'opposite-level-first': 'cena trefila opačný level dřív než zlom',
  'no-fvg': 'mezera v otočce nevznikla',
};
