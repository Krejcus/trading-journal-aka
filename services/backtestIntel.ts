import type { Trade } from '../types';
import type { MarketCandle } from './marketData';
import { backtestPointValue, backtestTickSize } from './backtestEngine';
import { tradeManagementStats, type TradeManagementStats } from './backtestOrderJournal';
import {
  createBacktestContextSource,
  type BacktestContextSource,
  type BacktestEntryContext,
  type BacktestEntryMap,
  type BacktestHtfContext,
  type BacktestPlacementRead,
} from './backtestEntryContext';
import { backtestStructuralTrail, readBacktestStructure } from './backtestStructureLevels';
import {
  backtestSessionCutoffSeconds,
  DEFAULT_BACKTEST_FLAT_BY_MINUTE,
  DEFAULT_BACKTEST_FLAT_TIME_ZONE,
} from './backtestSessionClose';
import type { BacktestClosedTrade, BacktestInstrument, BacktestOrderEvent } from './backtestTypes';

/**
 * Odvozená analytika nad uzavřeným backtest obchodem.
 *
 * Rozdíl proti AlphaBridge je v tom, co je k dispozici: extension četla graf
 * v okamžiku obchodu a budoucí bary jí prostě chyběly, takže excursion i
 * execution path zůstávaly rozpracované a dopočítávaly se později. Tady jsou
 * všechny svíčky po ruce hned, takže se každá metrika spočítá napoprvé a
 * úplně — a hlavně se dá skutečně přehrát „co kdyby", ne odhadovat.
 *
 * Tvary `excursion` a `executionPath` schválně kopírují AlphaBridge, protože
 * je Lab už umí číst (`normalizeLabTrade`). Counterfactual kopírovat nejde:
 * swing/OTE/FVG placementy vycházejí ze struktury, kterou backtest nedetekuje.
 * Místo předstírání má vlastní tvar s variantami, které jsou v přehrávání
 * exaktní.
 */

/** Klasifikace session podle UTC hodiny — shodná s AlphaBridge `detectSession`. */
export const detectBacktestSession = (unixSeconds: number): string => {
  const hour = new Date(unixSeconds * 1_000).getUTCHours();
  if (hour >= 12 && hour < 22) return 'NY';
  if (hour >= 7 && hour < 12) return 'London';
  if (hour >= 0 && hour < 7) return 'Asia';
  return 'Overnight';
};

/** Parita s AlphaBridge: prvních 30 dokončených 1m barů po vstupu. */
export const EXECUTION_PATH_MAX_BARS = 30;
const EXECUTION_PATH_VERSION = 1;
/** Pásmo kolem vstupu, ve kterém se cena považuje za „pořád na vstupu". */
const ENTRY_ZONE_R = 0.1;

const riskDistanceOf = (trade: Pick<BacktestClosedTrade, 'entryPrice' | 'initialStopLoss'>): number | null => {
  if (!Number.isFinite(trade.initialStopLoss as number)) return null;
  const distance = Math.abs(trade.entryPrice - Number(trade.initialStopLoss));
  return distance > 0 ? distance : null;
};

/** Bary striktně po vstupní svíčce — ta patří z větší části pohybu před vstupem. */
const barsAfterEntry = (candles: readonly MarketCandle[], entryTime: number): MarketCandle[] =>
  candles.filter(candle => candle.time > entryTime);

export interface BacktestExecutionPathBar {
  minute: number;
  time: number;
  openR: number;
  bestR: number;
  worstR: number;
  closeR: number;
}

export interface BacktestExecutionPath {
  available: boolean;
  version: number;
  reason?: string;
  timeframe?: '1m';
  timeframeSeconds?: number;
  entryBarTime?: number;
  firstCompleteBarTime?: number;
  maxBars?: number;
  bars?: BacktestExecutionPathBar[];
  maxFavorableR?: number;
  maxAdverseR?: number;
  /** Minuta, kdy cena poprvé ušla daný podíl cesty ke stopce (klíč = procenta). */
  timeToSlPct?: Record<string, number | null>;
  /** Minuta, kdy cena poprvé dosáhla daného násobku R (klíč = R). */
  timeToTpPct?: Record<string, number | null>;
  entryTouchBars?: number;
  minutesNearEntry?: number;
  closeCrossCount?: number;
  entryZoneR?: number;
  terminal?: string | null;
  terminalMinute?: number | null;
  terminalAmbiguous?: boolean;
  /** Terminální bar existuje → pořadí zásahů uvnitř něj je neznámé. */
  terminalBarOrderingUnknown?: boolean;
  hasGaps?: boolean;
  complete?: boolean;
  candleStops?: {
    firstComplete: BacktestCandleStopVariant | null;
    firstTwoComplete: BacktestCandleStopVariant | null;
  };
}

export interface BacktestCandleStopVariant {
  formedBars: number;
  stop: number;
  stopDistanceR: number;
  /** WIN | LOSS | OPEN — stejný slovník jako AlphaBridge. */
  outcome: string;
  barsToOutcome: number | null;
  realizedR: number | null;
  ambiguous: boolean;
  /** false = obchod skončil dřív, než se nová stopka stihla aktivovat. */
  activated: boolean;
}

const SL_PROGRESS_KEYS = [25, 50, 75, 100] as const;
/**
 * Podíly R, u kterých se měří čas k zisku.
 *
 * Klíče jsou v procentech R (0,25R → '25'), stejně jako v AlphaBridge. Nejsou
 * to násobky R — kdyby tady bylo 1/2/3, čtenáři nakalibrovaní na živá data by
 * v klíči '50' nenašli nic a tiše by dostali samá null.
 */
const TP_PROGRESS_KEYS = [25, 50, 100] as const;

const round2 = (value: number) => Math.round(value * 100) / 100;

const roundToTick = (price: number, tickSize: number) =>
  tickSize > 0 ? Math.round(price / tickSize) * tickSize : price;

/**
 * Prvních `EXECUTION_PATH_MAX_BARS` minut po vstupu přepočtených na R.
 *
 * Odsud jde vyčíst, jestli obchod šel od začátku, nebo se dlouho mlel kolem
 * vstupu — `minutesNearEntry` a `closeCrossCount` jsou přímé míry toho, jak
 * dlouho byl setup nerozhodnutý.
 *
 * Sken končí na baru, kde obchod skončil. Za výstupem už pozice neexistovala,
 * takže tamní pohyb do `maxFavorableR` nepatří — a na baru se stopkou se
 * příznivý knot nepočítá vůbec, protože pořadí uvnitř baru z OHLC nepoznáš.
 */
export const backtestExecutionPath = (
  candles: readonly MarketCandle[],
  trade: BacktestClosedTrade,
): BacktestExecutionPath => {
  const risk = riskDistanceOf(trade);
  if (risk === null) {
    return { available: false, version: EXECUTION_PATH_VERSION, reason: 'no-initial-stop' };
  }
  const available = barsAfterEntry(candles, trade.entryTime);
  if (available.length === 0) {
    return { available: false, version: EXECUTION_PATH_VERSION, reason: 'no-bars-after-entry' };
  }
  const long = trade.direction === 'Long';
  const toR = (price: number) => round2((long ? price - trade.entryPrice : trade.entryPrice - price) / risk);
  const target = Number.isFinite(trade.initialTakeProfit as number) ? Number(trade.initialTakeProfit) : null;
  const targetR = target === null ? null : Math.abs(target - trade.entryPrice) / risk;

  const bars: BacktestExecutionPathBar[] = [];
  const timeToSlPct: Record<string, number | null> = {};
  SL_PROGRESS_KEYS.forEach(pct => { timeToSlPct[String(pct)] = null; });
  const timeToTpPct: Record<string, number | null> = {};
  TP_PROGRESS_KEYS.forEach(pct => { timeToTpPct[String(pct)] = null; });

  let maxFavorableR = 0;
  let maxAdverseR = 0;
  let entryTouchBars = 0;
  let minutesNearEntry = 0;
  let closeCrossCount = 0;
  let priorCloseSide = 0;
  let hasGaps = false;
  let terminal: string | null = null;
  let terminalMinute: number | null = null;
  let terminalAmbiguous = false;

  for (let index = 0; index < available.length && bars.length < EXECUTION_PATH_MAX_BARS; index += 1) {
    const candle = available[index];
    const previous = index > 0 ? available[index - 1] : null;
    // Díra v datech znamená, že další bary nenavazují po minutě — cesta se
    // radši utne, než aby minuty přeskakovaly.
    if (previous && Math.abs((candle.time - previous.time) - 60) > 2) { hasGaps = true; break; }

    const openR = toR(candle.open);
    const closeR = toR(candle.close);
    const bestR = toR(long ? candle.high : candle.low);
    const worstR = toR(long ? candle.low : candle.high);
    const minute = Math.max(1, Math.round((candle.time - trade.entryTime) / 60));
    bars.push({ minute, time: candle.time, openR, bestR, worstR, closeR });

    const hitStop = worstR <= -1;
    const hitTarget = targetR !== null && bestR >= targetR;
    // Na baru se stopkou nevíme, jestli příznivý knot přišel dřív než zásah,
    // takže se z něj nebere nic. Na baru s cílem se ořízne na cíl — dál už
    // obchod neběžel.
    if (!hitStop) maxFavorableR = Math.max(maxFavorableR, hitTarget ? Math.min(bestR, targetR as number) : bestR);
    // Ztratit se dá nejvýš 1R; hlubší knot po zásahu stopky už pozice nenesla.
    maxAdverseR = Math.max(maxAdverseR, hitStop ? 1 : -worstR);
    if (worstR <= 0 && bestR >= 0) entryTouchBars += 1;
    if (worstR <= ENTRY_ZONE_R && bestR >= -ENTRY_ZONE_R) minutesNearEntry += 1;

    const closeSide = closeR > 0 ? 1 : closeR < 0 ? -1 : 0;
    if (closeSide !== 0) {
      if (priorCloseSide !== 0 && closeSide !== priorCloseSide) closeCrossCount += 1;
      priorCloseSide = closeSide;
    }
    SL_PROGRESS_KEYS.forEach(pct => {
      if (timeToSlPct[String(pct)] === null && worstR <= -(pct / 100)) timeToSlPct[String(pct)] = minute;
    });
    TP_PROGRESS_KEYS.forEach(pct => {
      if (timeToTpPct[String(pct)] === null && bestR >= pct / 100) timeToTpPct[String(pct)] = minute;
    });

    if (hitStop || hitTarget) {
      terminal = hitStop ? 'sl' : 'tp';
      terminalAmbiguous = hitStop && hitTarget;
      terminalMinute = minute;
      break;
    }
  }

  return {
    available: true,
    version: EXECUTION_PATH_VERSION,
    timeframe: '1m',
    timeframeSeconds: 60,
    entryBarTime: trade.entryTime,
    firstCompleteBarTime: bars.length ? bars[0].time : null,
    maxBars: EXECUTION_PATH_MAX_BARS,
    bars,
    maxFavorableR: round2(maxFavorableR),
    maxAdverseR: round2(maxAdverseR),
    timeToSlPct,
    timeToTpPct,
    entryTouchBars,
    minutesNearEntry,
    closeCrossCount,
    entryZoneR: ENTRY_ZONE_R,
    terminal,
    terminalMinute,
    terminalAmbiguous,
    terminalBarOrderingUnknown: terminal !== null,
    hasGaps,
    // Kompletní = buď obchod v okně skončil, nebo okno doběhlo do plné délky.
    complete: terminal !== null || bars.length >= EXECUTION_PATH_MAX_BARS,
    candleStops: {
      firstComplete: candleStopVariant(candles, trade, risk, 1, bars.length),
      firstTwoComplete: candleStopVariant(candles, trade, risk, 2, bars.length),
    },
  };
};

/**
 * Co kdyby stopka ležela tick za extrémem prvních `formedBars` svíček po vstupu.
 *
 * Dvě věci, které nejsou samozřejmé a bez kterých čísla nedávají smysl:
 *
 * Za prvé, výsledek se měří v **původním R**, ne v R té nové stopky. Je to
 * řízení téhož obchodu se stejným vloženým rizikem, ne jiný obchod. Kdyby se
 * dělilo novou vzdáleností, utažená stopka pár ticků od vstupu by vyrobila
 * desítky R z rizika, které nikdo nenesl.
 *
 * Za druhé, řízení nikdy nesmí původní stopku rozšířit — a když obchod skončil
 * ještě během formace svíček, varianta se vůbec neaktivovala a výsledek zůstává
 * ten původní.
 */
const candleStopVariant = (
  candles: readonly MarketCandle[],
  trade: BacktestClosedTrade,
  risk: number,
  formedBars: number,
  pathLength: number,
): BacktestCandleStopVariant | null => {
  const following = barsAfterEntry(candles, trade.entryTime);
  if (following.length < formedBars || pathLength < formedBars) return null;
  const long = trade.direction === 'Long';
  const originalStop = Number(trade.initialStopLoss);
  const target = Number.isFinite(trade.initialTakeProfit as number) ? Number(trade.initialTakeProfit) : undefined;
  const originalTargetR = target === undefined ? null : round2(Math.abs(target - trade.entryPrice) / risk);
  const toR = (price: number) => round2((long ? price - trade.entryPrice : trade.entryPrice - price) / risk);

  for (let index = 0; index < formedBars; index += 1) {
    const candle = following[index];
    if (!candle) return null;
    const hitOriginal = long ? candle.low <= originalStop : candle.high >= originalStop;
    const hitTarget = target !== undefined && (long ? candle.high >= target : candle.low <= target);
    if (!hitOriginal && !hitTarget) continue;
    return {
      formedBars,
      stop: originalStop,
      stopDistanceR: 1,
      outcome: hitOriginal ? 'LOSS' : 'WIN',
      barsToOutcome: index + 1,
      realizedR: hitOriginal ? -1 : originalTargetR,
      ambiguous: hitOriginal && hitTarget,
      activated: false,
    };
  }

  const formed = following.slice(0, formedBars);
  const protective = long
    ? Math.min(...formed.map(candle => candle.low))
    : Math.max(...formed.map(candle => candle.high));
  const tickSize = backtestTickSize(trade.instrument);
  const rawStop = roundToTick(protective + (long ? -tickSize : tickSize), tickSize);
  const stop = long ? Math.max(originalStop, rawStop) : Math.min(originalStop, rawStop);

  let outcome = 'OPEN';
  let barsToOutcome: number | null = null;
  let ambiguous = false;
  const scanLast = Math.min(following.length, pathLength);
  for (let index = formedBars; index < scanLast; index += 1) {
    const candle = following[index];
    if (!candle) continue;
    const hitStop = long ? candle.low <= stop : candle.high >= stop;
    const hitTarget = target !== undefined && (long ? candle.high >= target : candle.low <= target);
    if (!hitStop && !hitTarget) continue;
    ambiguous = hitStop && hitTarget;
    outcome = hitStop ? 'LOSS' : 'WIN';
    barsToOutcome = index + 1;
    break;
  }

  return {
    formedBars,
    stop,
    stopDistanceR: round2(Math.abs(trade.entryPrice - stop) / risk),
    outcome,
    barsToOutcome,
    realizedR: outcome === 'LOSS' ? toR(stop) : outcome === 'WIN' ? originalTargetR : null,
    ambiguous,
    activated: true,
  };
};

interface BracketSimulation {
  entryPrice: number;
  long: boolean;
  stop?: number;
  target?: number;
  /** Po dosažení tohoto násobku R se stop přesune na vstup. */
  breakevenAfterR?: number;
  /** Vzdálenost 1R — nutná jen pro `breakevenAfterR`. */
  riskDistance?: number;
}

interface BracketOutcome {
  outcome: 'sl' | 'tp' | 'breakeven' | 'open';
  exitPrice: number | null;
  exitTime: number | null;
  bars: number | null;
  ambiguous: boolean;
}

/**
 * Přehraje bary přes zadaný bracket se stejnou konzervativní konvencí jako
 * `processBacktestCandle`: když jeden bar trefí stopku i cíl, vyhrává stopka,
 * protože pořadí uvnitř baru z OHLC nezjistíš.
 */
export const simulateBracket = (
  candles: readonly MarketCandle[],
  setup: BracketSimulation,
): BracketOutcome => {
  let stop = setup.stop;
  let movedToBreakeven = false;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const favorable = setup.long ? candle.high : candle.low;
    const adverse = setup.long ? candle.low : candle.high;
    const hitStop = stop !== undefined && (setup.long ? adverse <= stop : adverse >= stop);
    const hitTarget = setup.target !== undefined && (setup.long ? favorable >= setup.target : favorable <= setup.target);
    if (hitStop) {
      return {
        outcome: movedToBreakeven && stop === setup.entryPrice ? 'breakeven' : 'sl',
        exitPrice: stop as number,
        exitTime: candle.time,
        bars: index + 1,
        ambiguous: hitTarget,
      };
    }
    if (hitTarget) {
      return { outcome: 'tp', exitPrice: setup.target as number, exitTime: candle.time, bars: index + 1, ambiguous: false };
    }
    if (
      !movedToBreakeven
      && setup.breakevenAfterR !== undefined
      && setup.riskDistance
      && ((setup.long ? favorable - setup.entryPrice : setup.entryPrice - favorable) / setup.riskDistance) >= setup.breakevenAfterR
    ) {
      stop = setup.entryPrice;
      movedToBreakeven = true;
    }
  }
  const last = candles[candles.length - 1];
  return { outcome: 'open', exitPrice: last ? last.close : null, exitTime: last ? last.time : null, bars: candles.length || null, ambiguous: false };
};

export interface BacktestCounterfactualVariant {
  label: string;
  description: string;
  stop: number | null;
  target: number | null;
  outcome: string;
  bars: number | null;
  realizedR: number | null;
  /** Rozdíl proti skutečně realizovanému R. Kladné = varianta byla lepší. */
  deltaR: number | null;
}

/**
 * Jedna SL varianta ve tvaru, který čte `normalizeLabTrade` v Labu.
 *
 * `realizedR` je záměrně v R **té varianty**, ne v původním: je to jiný obchod
 * s jiným vloženým rizikem, a otázka zní „jaké R bych udělal, kdybych dal stop
 * sem". Tím se liší od `candleStops`, kde jde o řízení téhož obchodu a měří se
 * proto v původním R.
 */
export interface BacktestSlVariant {
  ok: boolean;
  valid?: boolean;
  sl?: number;
  rr?: number | null;
  outcome?: string | null;
  bars?: number | null;
  realizedR?: number | null;
  trail?: { exit: number; reason: string; bars: number | null; realizedR: number | null; trailSteps: number; trailFinal: number; trailStart: number } | null;
}

export interface BacktestTpTarget {
  label: string;
  price: number;
  outcome: string;
  bars: number | null;
  rr: number | null;
  realizedR: number | null;
}

export interface BacktestCounterfactual {
  available: boolean;
  reason?: string;
  isLong?: boolean;
  entry?: number;
  tp?: number;
  /** Tři SL placementy ve stejném tvaru i pojmenování jako AlphaBridge. */
  swing?: BacktestSlVariant;
  ote?: BacktestSlVariant;
  fvg?: BacktestSlVariant;
  /** Co kdyby cíl mířil na jednotlivé likviditní úrovně. */
  tpTargets?: BacktestTpTarget[];
  realizedR?: number | null;
  /** Backtestové varianty navíc — mění řízení, ne umístění stopky. */
  variants?: BacktestCounterfactualVariant[];
  /** Nejlepší varianta podle realizovaného R. */
  best?: { label: string; r: number } | null;
}

/**
 * Přehraje bary přes jednu alternativní SL úroveň.
 *
 * Neplatná úroveň (stopka na špatné straně vstupu) se nesimuluje a nevykazuje
 * jako ztráta — jinak by do průměrů variant padaly umělé −1R z placementů,
 * které nikdy nemohly existovat.
 */
const scanSlVariant = (
  candles: readonly MarketCandle[],
  trade: BacktestClosedTrade,
  level: number | null,
  long: boolean,
  target: number | undefined,
): BacktestSlVariant => {
  if (level === null) return { ok: false };
  const valid = long ? level < trade.entryPrice : level > trade.entryPrice;
  if (!valid) return { ok: true, valid: false, sl: round2(level), rr: null, outcome: null, bars: null, realizedR: null, trail: null };
  const following = barsAfterEntry(candles, trade.entryTime);
  const riskDistance = long ? trade.entryPrice - level : level - trade.entryPrice;
  const rr = target === undefined
    ? null
    : round2((long ? target - trade.entryPrice : trade.entryPrice - target) / riskDistance);
  let outcome = 'OPEN';
  let held: number | null = null;
  for (let index = 0; index < following.length; index += 1) {
    const candle = following[index];
    const hitStop = long ? candle.low <= level : candle.high >= level;
    const hitTarget = target !== undefined && (long ? candle.high >= target : candle.low <= target);
    if (!hitStop && !hitTarget) continue;
    // Stejná konzervativní konvence jako engine: stopka vyhrává.
    outcome = hitStop ? 'LOSS' : 'WIN';
    held = index + 1;
    break;
  }
  const trail = backtestStructuralTrail(
    candles, trade.entryTime, trade.entryPrice, long, level, target,
    backtestTickSize(trade.instrument),
  );
  return {
    ok: true,
    valid: true,
    sl: round2(level),
    rr,
    outcome,
    bars: held,
    realizedR: outcome === 'WIN' ? rr : outcome === 'LOSS' ? -1 : null,
    trail,
  };
};

/**
 * Co kdyby — exaktní, ne odhadnuté.
 *
 * Dvě rodiny vedle sebe. `swing`/`ote`/`fvg` mění **umístění stopky** a jsou
 * spočítané stejným postupem jako v AlphaBridge, aby Lab mohl backtest a živé
 * obchody porovnávat v jedné tabulce. `variants` mění **řízení** — cíl,
 * breakeven, fixní RR — což je otázka, kterou umí položit jen přehrávání.
 */
/**
 * Co kdyby cíl mířil na jednotlivé likviditní úrovně.
 *
 * Riziko je pro všechny cíle stejné — swing stopka (nebo původní, když swing
 * nevyšel). Bez společné základny by se varianty nedaly porovnat: každý cíl by
 * měl vlastní R a „nejlepší" by vyhrál ten s nejtěsnější stopkou.
 */
const backtestTpTargets = (
  candles: readonly MarketCandle[],
  trade: BacktestClosedTrade,
  long: boolean,
  stop: number,
  levels: readonly { label: string; price: number }[],
): BacktestTpTarget[] => {
  const riskDistance = long ? trade.entryPrice - stop : stop - trade.entryPrice;
  if (!(riskDistance > 0)) return [];
  const following = barsAfterEntry(candles, trade.entryTime);
  return levels
    .filter(level => long ? level.price > trade.entryPrice : level.price < trade.entryPrice)
    .map(level => {
      const rr = round2(Math.abs(level.price - trade.entryPrice) / riskDistance);
      let outcome = 'OPEN';
      let bars: number | null = null;
      for (let index = 0; index < following.length; index += 1) {
        const candle = following[index];
        const hitStop = long ? candle.low <= stop : candle.high >= stop;
        const hitTarget = long ? candle.high >= level.price : candle.low <= level.price;
        if (!hitStop && !hitTarget) continue;
        outcome = hitStop ? 'LOSS' : 'WIN';
        bars = index + 1;
        break;
      }
      return {
        label: level.label,
        price: level.price,
        outcome,
        bars,
        rr,
        realizedR: outcome === 'WIN' ? rr : outcome === 'LOSS' ? -1 : null,
      };
    })
    .sort((left, right) => (left.rr ?? 0) - (right.rr ?? 0));
};

export const backtestCounterfactual = (
  candles: readonly MarketCandle[],
  trade: BacktestClosedTrade,
  namedLevels: readonly { label: string; price: number }[] = [],
): BacktestCounterfactual => {
  const risk = riskDistanceOf(trade);
  if (risk === null) return { available: false, reason: 'no-initial-stop' };
  const following = barsAfterEntry(candles, trade.entryTime);
  if (following.length === 0) return { available: false, reason: 'no-bars-after-entry' };

  const long = trade.direction === 'Long';
  const pointValue = backtestPointValue(trade.instrument);
  const realizedR = trade.riskAmount
    ? (trade.grossPnl / pointValue / trade.quantity) / risk
    : null;
  const initialStop = Number(trade.initialStopLoss);
  const initialTarget = Number.isFinite(trade.initialTakeProfit as number) ? Number(trade.initialTakeProfit) : undefined;

  const run = (
    label: string,
    description: string,
    setup: Omit<BracketSimulation, 'entryPrice' | 'long'>,
  ): BacktestCounterfactualVariant => {
    const result = simulateBracket(following, { entryPrice: trade.entryPrice, long, ...setup });
    const variantR = result.exitPrice === null
      ? null
      : (long ? result.exitPrice - trade.entryPrice : trade.entryPrice - result.exitPrice) / risk;
    return {
      label,
      description,
      stop: setup.stop ?? null,
      target: setup.target ?? null,
      outcome: result.outcome,
      bars: result.bars,
      realizedR: variantR,
      deltaR: variantR !== null && realizedR !== null ? variantR - realizedR : null,
    };
  };

  const variants: BacktestCounterfactualVariant[] = [
    run('initial', 'Nehýbat se stopkou ani cílem', { stop: initialStop, target: initialTarget }),
    run('no_target', 'Bez cíle, držet na původní stopce do konce dat', { stop: initialStop }),
    run('breakeven_1r', 'Po 1R přesunout stopku na vstup', {
      stop: initialStop, target: initialTarget, breakevenAfterR: 1, riskDistance: risk,
    }),
  ];
  if (initialTarget !== undefined) {
    [2, 3].forEach(multiple => {
      const target = long ? trade.entryPrice + risk * multiple : trade.entryPrice - risk * multiple;
      variants.push(run(`fixed_${multiple}r`, `Fixní cíl ${multiple}R`, { stop: initialStop, target }));
    });
  }

  const scored = variants.filter(variant => variant.realizedR !== null);
  const best = scored.length
    ? scored.reduce((top, variant) => (variant.realizedR as number) > (top.realizedR as number) ? variant : top)
    : null;

  const structure = readBacktestStructure(
    candles, trade.entryTime, trade.entryPrice, long, backtestTickSize(trade.instrument),
  );

  return {
    available: true,
    isLong: long,
    entry: trade.entryPrice,
    tp: initialTarget,
    swing: scanSlVariant(candles, trade, structure.swing, long, initialTarget),
    ote: scanSlVariant(candles, trade, structure.ote, long, initialTarget),
    fvg: scanSlVariant(candles, trade, structure.fvg, long, initialTarget),
    tpTargets: backtestTpTargets(candles, trade, long, structure.swing ?? initialStop, namedLevels),
    realizedR,
    variants,
    best: best ? { label: best.label, r: best.realizedR as number } : null,
  };
};

export interface BacktestExcursionLevel {
  label: string;
  price: number;
  reached: boolean;
  bars: number | null;
  r: number;
}

export interface BacktestExcursion {
  available: boolean;
  reason?: string;
  flatByMin?: number;
  stopReason?: 'cutoff' | 'sl' | 'end';
  survivedToCutoff?: boolean;
  mfePotential?: number | null;
  mfePotentialR?: number | null;
  tpR?: number;
  leftOnTableR?: number | null;
  levels?: BacktestExcursionLevel[];
  topReached?: { label: string; r: number } | null;
  trail?: { exit: number; exitR: number | null; reason: string; bars: number | null } | null;
}

/** Náhradní cíle, když nejsou k dispozici pojmenované likviditní úrovně. */
const FALLBACK_EXCURSION_R_LEVELS = [1, 2, 3, 5] as const;
/** Kolik nejbližších úrovní se ukládá do blobu. */
const EXCURSION_LEVEL_LIMIT = 10;

export interface BacktestExcursionOptions {
  timeZone: string;
  flatByMinute?: number;
  flatTimeZone?: string;
  /**
   * Pojmenované likviditní úrovně nad (u longu) nebo pod vstupem. Bez nich se
   * použijí násobky R, ale `topReached` pak nese jen „3R" místo „PDH".
   */
  namedLevels?: readonly { label: string; price: number }[];
}

/**
 * Kam by obchod došel, kdyby se nechal běžet do konce dne.
 *
 * Sken končí na původní stopce (dál by pozice neexistovala) nebo v `flatByMin`
 * podle časové zóny session. Na rozdíl od AlphaBridge nemá „pending" stav:
 * bary do konce dne v backtestu vždycky existují, takže `leftOnTableR` je
 * konečné číslo hned.
 */
export const backtestExcursion = (
  candles: readonly MarketCandle[],
  trade: BacktestClosedTrade,
  options: BacktestExcursionOptions,
): BacktestExcursion => {
  const risk = riskDistanceOf(trade);
  if (risk === null) return { available: false, reason: 'no-initial-stop' };
  const flatByMin = options.flatByMinute ?? DEFAULT_BACKTEST_FLAT_BY_MINUTE;
  const flatTimeZone = options.flatTimeZone ?? DEFAULT_BACKTEST_FLAT_TIME_ZONE;
  const cutoff = backtestSessionCutoffSeconds(trade.entryTime, flatTimeZone, flatByMin);
  const all = barsAfterEntry(candles, trade.entryTime);
  const following = all.filter(candle => candle.time <= cutoff);
  if (following.length === 0) return { available: false, reason: 'no-bars-after-entry' };

  const long = trade.direction === 'Long';
  const initialStop = Number(trade.initialStopLoss);
  let best = trade.entryPrice;
  let stopReason: BacktestExcursion['stopReason'] = 'end';
  let scanned = 0;
  for (const candle of following) {
    scanned += 1;
    const favorable = long ? candle.high : candle.low;
    const adverse = long ? candle.low : candle.high;
    best = long ? Math.max(best, favorable) : Math.min(best, favorable);
    if (long ? adverse <= initialStop : adverse >= initialStop) { stopReason = 'sl'; break; }
  }
  if (stopReason === 'end' && scanned === following.length) {
    // Okno doběhlo na konec dat, nebo na cutoff — rozlišuje se podle toho,
    // jestli za posledním barem ještě nějaké byly.
    stopReason = all.length > following.length ? 'cutoff' : 'end';
  }

  const mfePotential = long ? best - trade.entryPrice : trade.entryPrice - best;
  const mfePotentialR = round2(mfePotential / risk);
  const tpR = Number.isFinite(trade.initialTakeProfit as number)
    ? round2(Math.abs(Number(trade.initialTakeProfit) - trade.entryPrice) / risk)
    : 0;

  const candidates = options.namedLevels?.length
    ? options.namedLevels
      .filter(level => long ? level.price > trade.entryPrice : level.price < trade.entryPrice)
      .map(level => ({ label: level.label, price: level.price }))
    : FALLBACK_EXCURSION_R_LEVELS.map(multiple => ({
      label: `${multiple}R`,
      price: long ? trade.entryPrice + risk * multiple : trade.entryPrice - risk * multiple,
    }));

  const levels: BacktestExcursionLevel[] = candidates
    .map(candidate => {
      const index = following.findIndex(candle =>
        long ? candle.high >= candidate.price : candle.low <= candidate.price);
      const reached = index >= 0 && index < scanned;
      return {
        label: candidate.label,
        price: candidate.price,
        reached,
        bars: reached ? index + 1 : null,
        r: round2(Math.abs(candidate.price - trade.entryPrice) / risk),
      };
    })
    .sort((left, right) => left.r - right.r);

  // `topReached` se musí hledat v PLNÉM poli — ořez na deset nejbližších je jen
  // pro velikost blobu a dojezd na jedenáctou úroveň by jinak zmizel a
  // `leftOnTableR` vyšlo podhodnocené.
  let topReached: { label: string; r: number } | null = null;
  levels.forEach(level => {
    if (level.reached && (topReached === null || level.r > topReached.r)) {
      topReached = { label: level.label, r: level.r };
    }
  });
  const achievableR = topReached ? (topReached as { r: number }).r : mfePotentialR;
  const trail = backtestStructuralTrail(
    candles, trade.entryTime, trade.entryPrice, long, initialStop,
    Number.isFinite(trade.initialTakeProfit as number) ? Number(trade.initialTakeProfit) : undefined,
    backtestTickSize(trade.instrument),
  );

  return {
    available: true,
    flatByMin,
    stopReason,
    // Přežil = nezemřel na stopce. Dojezd na cutoff i na konec dat jsou obojí
    // „ještě žil", takže se nesmí rozlišovat jen podle cutoffu.
    survivedToCutoff: stopReason !== 'sl',
    mfePotential,
    mfePotentialR,
    tpR,
    // „Co zbylo na stole" = kolik R navíc bylo dosažitelné ZA tvým cílem.
    // Base je nejvyšší skutečně dosažená úroveň (realistický výstup), ne knot.
    // Clamp na nulu: na ztrátě nebo bez překonání cíle se nenechalo nic.
    leftOnTableR: Math.max(0, round2(achievableR - tpR)),
    levels: levels.slice(0, EXCURSION_LEVEL_LIMIT),
    topReached,
    trail: trail ? { exit: trail.exit, exitR: trail.realizedR, reason: trail.reason, bars: trail.bars } : null,
  };
};

export const backtestPointValueOf = (instrument: BacktestInstrument) => backtestPointValue(instrument);

export interface BacktestTradeIntel {
  session: string;
  riskAmount?: number;
  targetAmount?: number;
  runUp: number;
  drawdown: number;
  mfeR?: number;
  maeR?: number;
  management: TradeManagementStats;
  excursion: BacktestExcursion;
  executionPath: BacktestExecutionPath;
  counterfactual: BacktestCounterfactual;
  entryContext: BacktestEntryContext;
  entryMap: BacktestEntryMap;
  htfContext: BacktestHtfContext;
  placement: BacktestPlacementRead;
  htfConfluence: string[];
  ltfConfluence: string[];
}

export interface BacktestIntelOptions {
  candles: readonly MarketCandle[];
  orderEvents: readonly BacktestOrderEvent[];
  timeZone: string;
  flatByMinute?: number;
  flatTimeZone?: string;
  /** Hodinové svíčky pro HTF kontext. Bez nich se HTF označí za nedostupný. */
  htfCandles?: readonly MarketCandle[];
  /**
   * Sdílený zdroj kontextu. Předej ho, když se v jedné dávce mapuje víc
   * obchodů — levely a struktura se pak nepočítají znovu pro každý z nich.
   */
  contextSource?: BacktestContextSource;
}

/** Vše odvozené k jednomu uzavřenému obchodu, spočítané z jednoho průchodu daty. */
export const backtestTradeIntel = (
  trade: BacktestClosedTrade,
  options: BacktestIntelOptions,
): BacktestTradeIntel => {
  const pointValue = backtestPointValue(trade.instrument);
  const dollars = (points: number | undefined) =>
    Number.isFinite(points as number) ? Number(points) * pointValue * trade.quantity : 0;
  const context = options.contextSource ?? createBacktestContextSource({
    candles: options.candles,
    htfCandles: options.htfCandles,
    timeZone: options.timeZone,
  });
  const confluence = context.confluence(trade);
  return {
    session: detectBacktestSession(trade.entryTime),
    riskAmount: trade.riskAmount,
    targetAmount: Number.isFinite(trade.initialTakeProfit as number)
      ? Math.abs(Number(trade.initialTakeProfit) - trade.entryPrice) * pointValue * trade.quantity
      : undefined,
    runUp: dollars(trade.mfePoints),
    drawdown: dollars(trade.maePoints),
    mfeR: trade.mfeR,
    maeR: trade.maeR,
    management: tradeManagementStats(options.orderEvents, trade),
    excursion: backtestExcursion(options.candles, trade, {
      timeZone: options.timeZone,
      flatByMinute: options.flatByMinute,
      flatTimeZone: options.flatTimeZone,
      namedLevels: context.favorableLevels(trade),
    }),
    executionPath: backtestExecutionPath(options.candles, trade),
    counterfactual: backtestCounterfactual(options.candles, trade, context.favorableLevels(trade)),
    entryContext: context.entryContext(trade),
    entryMap: context.entryMap(trade),
    htfContext: context.htfContext(trade),
    placement: context.placement(trade),
    htfConfluence: confluence.htf,
    ltfConfluence: confluence.ltf,
  };
};

export interface BacktestTradeMappingOptions extends BacktestIntelOptions {
  accountId: string;
  sessionBias?: 'Long' | 'Short' | 'Neutral' | null;
  sessionPreNotes?: string | null;
  sessionPostNotes?: string | null;
  strategy?: string;
}

/** Verze data blobu; drží krok s AlphaBridge, ať AI ví, co kde čekat. */
export const BACKTEST_TRADE_SCHEMA_VERSION = 4;

/** HH:MM v zóně session — AlphaBridge i importy tohle pole plní. */
const clockTime = (unixSeconds: number, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone, hour12: false, hour: '2-digit', minute: '2-digit',
    }).format(new Date(unixSeconds * 1_000));
  } catch {
    return new Date(unixSeconds * 1_000).toISOString().slice(11, 16);
  }
};

/**
 * Uzavřený backtest obchod jako plnohodnotný `Trade`.
 *
 * Dřív se tady zahazovalo skoro všechno — obchod dorazil do deníku bez rizika,
 * takže mu v Labu chyběly R metriky a s nimi i většina detektorů. Teď nese
 * všechno, co engine i journal vědí, včetně polí, která historicky plnil
 * AlphaBridge (`excursion`, `executionPath`, `management`).
 */
export const backtestClosedTradeToTrade = (
  closed: BacktestClosedTrade,
  options: BacktestTradeMappingOptions,
): Trade => {
  const intel = backtestTradeIntel(closed, options);
  const durationMinutes = Math.max(0, Math.round((closed.exitTime - closed.entryTime) / 60));
  const bias = options.sessionBias ?? null;
  const direction = closed.direction;
  return {
    id: closed.id,
    accountId: options.accountId,
    backtestRunId: closed.runId,
    instrument: closed.instrument,
    symbol: closed.instrument,
    signal: options.strategy || 'Bar Replay',
    pnl: closed.pnl,
    riskAmount: intel.riskAmount,
    targetAmount: intel.targetAmount,
    runUp: intel.runUp,
    drawdown: intel.drawdown,
    date: new Date(closed.exitTime * 1_000).toISOString(),
    entryDate: new Date(closed.entryTime * 1_000).toISOString(),
    exitDate: new Date(closed.exitTime * 1_000).toISOString(),
    entryTime: closed.entryTime * 1_000,
    timestamp: closed.exitTime * 1_000,
    direction,
    outcome: closed.pnl > 0 ? 'Win' : closed.pnl < 0 ? 'Loss' : 'BE',
    duration: `${durationMinutes}m`,
    durationMinutes,
    entryPrice: closed.entryPrice,
    exitPrice: closed.exitPrice,
    // Obchody z doby před zavedením vstupního bracketu mají jen bracket platný
    // při výstupu. Pro zobrazení je to pořád lepší než prázdno; do rizika a R
    // se ale nepromítá — posunutá stopka by 1R nafoukla nebo vynulovala.
    stopLoss: closed.initialStopLoss ?? closed.stopLoss,
    takeProfit: closed.initialTakeProfit ?? closed.takeProfit,
    positionSize: closed.quantity,
    session: intel.session,
    sessionBias: bias,
    // Neutral ani chybějící bias nejdou vyhodnotit — `null` znamená „nevíme",
    // ne „proti biasu".
    biasAligned: bias === 'Long' || bias === 'Short' ? direction === bias : null,
    mfeR: intel.mfeR,
    maeR: intel.maeR,
    mfePoints: closed.mfePoints,
    maePoints: closed.maePoints,
    excursionAvailable: intel.excursion.available,
    excursionComplete: intel.excursion.available ? true : null,
    excursion: intel.excursion,
    executionPath: intel.executionPath,
    executionPathComplete: intel.executionPath.available ? intel.executionPath.complete === true : null,
    counterfactual: intel.counterfactual,
    entryMap: intel.entryMap,
    // Placement zůstává uvnitř entryContext, aby přesné OTE/swing/FVG
    // kandidáty i target policy přežily uložení a byly auditovatelné v review.
    entryContext: { ...intel.entryContext, htf: intel.htfContext, placement: intel.placement },
    htfConfluence: intel.htfConfluence,
    ltfConfluence: intel.ltfConfluence,
    slPlacement: intel.placement.slPlacement ?? undefined,
    targetType: intel.placement.targetType ?? undefined,
    targetLevel: intel.placement.targetLevel ?? undefined,
    management: intel.management.label,
    notes: `Backtest session · ${closed.reason}`,
    // Pole, která AlphaBridge plní u každého obchodu a replay je dosud
    // vynechával — bez nich se replay obchody chovaly v deníku i v analytice
    // jinak než ty živé.
    // `status: 'CLOSED'` z AlphaBridge záměrně nepřebírám — v datech je, ale
    // žádná read-path ho nečte a replay obchod jiný stav ani mít nemůže.
    time: clockTime(closed.entryTime, options.timeZone),
    outcomeAmbiguous: closed.outcomeAmbiguous ?? false,
    isBE: closed.pnl === 0 ? true : undefined,
    // `phase` AlphaBridge do obchodu kopíruje, ale aplikace ho ignoruje —
    // TradeHistory bere fázi z účtu jako ze zdroje pravdy.
    sessionPreNotes: options.sessionPreNotes ?? null,
    sessionPostNotes: options.sessionPostNotes ?? null,
    schemaVersion: BACKTEST_TRADE_SCHEMA_VERSION,
    source: 'backtest-replay',
  };
};
