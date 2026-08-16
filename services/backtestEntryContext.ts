import { DEFAULT_INDICATOR_SETTINGS, type LevelsIndicatorSettings } from '../components/ChartIndicatorSettingsDialog';
import {
  calculateIndicators,
  calculateMarketStructure,
  findFairValueGaps,
  type FairValueGap,
  type MarketCandle,
  type MarketStructureEvent,
} from './marketData';
import {
  calculateLiquidityLevels,
  type LiquidityDayContext,
  type LiquidityLevel,
} from './liquidityLevels';
import {
  createHtfContextSource,
  type HtfContextSource,
  type HtfFvgRead,
  type HtfStructureRead,
} from './backtestHtfContext';
import { backtestTickSize } from './backtestEngine';
import { readBacktestStructure } from './backtestStructureLevels';
import type { BacktestClosedTrade } from './backtestTypes';

/**
 * Kontext vstupu — proč se do obchodu šlo, ne jak dopadl.
 *
 * Všechno se počítá **jen z barů do vstupu včetně**. Kdyby se sáhlo na celé
 * pole, které workspace drží, dostalo by se do „swept" i „untapped" to, co se
 * stalo až potom, a kontext by tiše popisoval budoucnost.
 *
 * Matematika je celá cizí: levely umí `calculateLiquidityLevels`, kotvy
 * `calculateIndicators`, strukturu `calculateMarketStructure` a mezery
 * `findFairValueGaps`. Tenhle modul je jen skládá k okamžiku vstupu.
 */

/**
 * Nastavení levelů pro sběr dat.
 *
 * Uživatel má část levelů vypnutou, protože si nechce zaplácat graf — jenže
 * do analýzy je chceme vždycky všechny. Vizuální nastavení proto zůstává
 * nedotčené a analytika si jede po svém.
 */
export const ANALYSIS_LEVEL_SETTINGS: LevelsIndicatorSettings = {
  ...DEFAULT_INDICATOR_SETTINGS.levels,
  showOvernight: true,
  showCompass: true,
  showInitialBalance: true,
  showBiasTable: true,
  showAsiaLines: true,
  showLondonLines: true,
  showNewYorkLines: true,
  showOpen: true,
};

/**
 * Kolik minut historie se do snapshotu bere.
 *
 * Nejhlubší kotva, kterou levely potřebují, je předchozí den (PDH/PDL/pdVWAP)
 * plus týdenní open — tři dny to bezpečně pokryjí. Bez stropu by cena výpočtu
 * rostla s tím, kolik segmentů má session načtených, a uzavření obchodu na
 * konci dlouhého přehrávání by trhalo přehrávání.
 */
const SNAPSHOT_HISTORY_MINUTES = 3 * 24 * 60;
/** Minimální tolerance „u levelu" v bodech, když není známé riziko. */
const MIN_LEVEL_TOLERANCE = 0.5;
/** Tolerance jako podíl 1R — u širokého stopu je i „blízko" širší. */
const LEVEL_TOLERANCE_R = 0.15;

export interface BacktestLevelProximity {
  label: string;
  price: number;
  /** Vzdálenost od vstupu v bodech (vždy ≥ 0). */
  distancePoints: number;
  /** Totéž v R, když je známé riziko. */
  distanceR: number | null;
  /** Level už byl v době vstupu sebraný. */
  swept: boolean;
}

/**
 * Kontext dne v číslech. Tvar i názvy kopírují CTX label z Pine indikátoru,
 * aby stejná data z replay i z AlphaBridge uměla vykreslit jedna komponenta.
 */
export interface BacktestDayContext {
  ib: LiquidityDayContext['ibState'];
  gapAtr: number | null;
  onWidthAtr: number | null;
  ibWidthAtr: number | null;
  atr: number | null;
  dAtr: number | null;
  /** Poslední zlom struktury na 15m před vstupem. */
  s15: HtfStructureRead | null;
  /** Totéž na hodinovém rámci. */
  s60: HtfStructureRead | null;
}

export interface BacktestSweepAge {
  level: string;
  /** Minuty mezi posledním dotykem levelu a vstupem. */
  minAgo: number;
}

export interface BacktestUntappedLevel {
  level: string;
  /** Vzdálenost od vstupu v bodech, vždy kladná. */
  dist: number;
}

export interface BacktestEntryContext {
  available: boolean;
  reason?: string;
  aboveDO: boolean | null;
  aboveWO: boolean | null;
  aboveVWAP: boolean | null;
  abovePdVWAP: boolean | null;
  /** Kde ve VWAP rozdělení vstup padl (kladné = nad VWAP). */
  vwapDistSigma: number | null;
  sweptLevels: string[];
  untappedAbove: number;
  untappedBelow: number;
  nearestUntappedAbove: string | null;
  nearestUntappedBelow: string | null;
  /** Vzdálenost k nejbližšímu nesebranému magnetu ve směru obchodu, v R. */
  targetMagnetR: number | null;
  londonVsAsia: string | null;
  /** Minuty od půlnoci v zóně session. */
  entryMinutes: number | null;
  /** Levely v dosahu vstupu, seřazené od nejbližšího. */
  nearbyLevels: BacktestLevelProximity[];
  /** Stav initial balance a gapu z bias tabulky. */
  ibState: string | null;
  gapAtr: string | null;
  biasScore: string | null;
  /** Jak dávno před vstupem padl každý sebraný level. Nejčerstvější první. */
  sweepAges: BacktestSweepAge[];
  /** Vzdálenost každého levelu od vstupu v bodech; kladná = nad vstupem. */
  levelDist: Record<string, number>;
  /** Kolikrát se cena levelu dotkla od jeho vzniku. */
  levelHits: Record<string, number>;
  /** Celé seznamy nesebraných levelů nad a pod vstupem, od nejbližšího. */
  untappedAboveList: BacktestUntappedLevel[];
  untappedBelowList: BacktestUntappedLevel[];
  /** Kontext dne v číslech — protějšek CTX labelu z indikátoru. */
  ctx: BacktestDayContext | null;
  /** FVG zóny na 15m a 1h k času vstupu. */
  htfFvg: HtfFvgRead | null;
}

export interface BacktestEntryMap {
  available: boolean;
  reason?: string;
  /** CHoCH = první zlom v sérii mým směrem, BoS = druhý a další. */
  structureType: 'CHoCH' | 'BoS' | null;
  /** Kolikátý zlom ve směru obchodu vstup následuje. */
  structureOrder: number;
  /** Kolik barů před vstupem se struktura naposledy zlomila. */
  structureBarsAgo: number | null;
  /** Úrovně u bodu, ve kterém se pohyb otočil. */
  odrazLevels: string[];
  odrazPrice: number | null;
  odrazLevelPrice: number | null;
  /** Levely, na kterých vstup přímo leží. */
  entryLevels: string[];
  entryLevelPrice: number | null;
  entryFvg: boolean;
  /** Strategie vyžaduje potvrzené FVG z 1m, které existovalo už před entry barem. */
  entryFvgValid: boolean;
  entryFvgTimeframe: '1m' | null;
  entryFvgEdge: 'proximal' | null;
  entryFvgBornTime: number | null;
  entryFvgDistanceTicks: number | null;
  entryFvgSpan: { top: number; bottom: number } | null;
}

export interface BacktestHtfContext {
  available: boolean;
  reason?: string;
  /** Poslední strukturní událost na hodinovém grafu před vstupem. */
  structureType: 'CHoCH' | 'BoS' | null;
  structureDirection: 'bullish' | 'bearish' | null;
  /** Obchod jde ve směru poslední HTF struktury. */
  aligned: boolean | null;
  htfLevels: string[];
}

export interface BacktestPlacementRead {
  /** Kam reálně padl stop: ote | fvg | swing | other. */
  slPlacement: string | null;
  /** Na co cílil TP: deviation | liquidity | session_close | other. */
  targetType: string | null;
  targetLevel: string | null;
  /** Všechny tři přesné kandidáty; `matched` je nejvýš jeden tick od reálného SL. */
  slCandidates: Record<'ote' | 'swing' | 'fvg', {
    price: number | null;
    distanceTicks: number | null;
    matched: boolean;
  }>;
  targetPolicy: {
    expected: 'nearest_level' | 'session_close';
    nearestLevel: string | null;
    nearestPrice: number | null;
    actualPrice: number | null;
    distanceTicks: number | null;
    valid: boolean | null;
  };
}

const emptyPlacement = (): BacktestPlacementRead => ({
  slPlacement: null,
  targetType: null,
  targetLevel: null,
  slCandidates: {
    ote: { price: null, distanceTicks: null, matched: false },
    swing: { price: null, distanceTicks: null, matched: false },
    fvg: { price: null, distanceTicks: null, matched: false },
  },
  targetPolicy: {
    expected: 'nearest_level', nearestLevel: null, nearestPrice: null,
    actualPrice: null, distanceTicks: null, valid: null,
  },
});

const toleranceOf = (riskDistance: number | null): number =>
  riskDistance ? Math.max(MIN_LEVEL_TOLERANCE, riskDistance * LEVEL_TOLERANCE_R) : MIN_LEVEL_TOLERANCE;

const barsAgoLabel = (bars: number): string => {
  const absolute = Math.abs(bars);
  const suffix = absolute === 1 ? 'bar' : absolute >= 2 && absolute <= 4 ? 'bary' : 'barů';
  return `${bars} ${suffix} zpět`;
};

const round2 = (value: number | null | undefined): number | null =>
  (value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 100) / 100);

/** Stejný dosah zpět, jaký počítá indikátor při hledání dotyků. */
const SWEEP_LOOKBACK_BARS = 2_000;
/** Kolik nejčerstvějších sweepů se ukládá k obchodu. */
const MAX_SWEEP_AGES = 10;

const riskDistanceOf = (trade: Pick<BacktestClosedTrade, 'entryPrice' | 'initialStopLoss'>): number | null => {
  if (!Number.isFinite(trade.initialStopLoss as number)) return null;
  const distance = Math.abs(trade.entryPrice - Number(trade.initialStopLoss));
  return distance > 0 ? distance : null;
};

const valueAt = (points: readonly { time: number; value: number }[], time: number): number | null => {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index].time <= time) return points[index].value;
  }
  return null;
};

const above = (price: number, reference: number | null): boolean | null =>
  reference === null ? null : price > reference;

const minuteOfDay = (unixSeconds: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(unixSeconds * 1_000));
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value ?? '0');
  return value('hour') * 60 + value('minute');
};

export interface BacktestContextInput {
  /** 1m svíčky exekučního instrumentu. Musí sahat aspoň den před vstup. */
  candles: readonly MarketCandle[];
  /** Hodinové svíčky pro HTF kontext. Nepovinné. */
  htfCandles?: readonly MarketCandle[];
  timeZone: string;
  levelSettings?: LevelsIndicatorSettings;
}

interface EntrySnapshot {
  history: MarketCandle[];
  levels: LiquidityLevel[];
  /** Pohyblivé VWAP cíle zmrazené přesně v okamžiku vstupu. */
  targetLevels: Array<{ name: string; price: number; type: 'deviation' }>;
  biasRows: { label: string; value: string }[];
  dayContext: LiquidityDayContext;
  structure: MarketStructureEvent[];
  gaps: FairValueGap[];
  vwap: number | null;
  vwapSigma: number | null;
  dayOpen: number | null;
  weekOpen: number | null;
  pdVwap: number | null;
}

/**
 * Zdroj kontextu pro jednu dávku uzavřených obchodů.
 *
 * Snapshoty se drží podle času vstupu: obchody uzavřené na téže svíčce sdílejí
 * jeden výpočet a levely se přes celé pole nepočítají znovu pro každý z nich.
 */
export interface BacktestContextSource {
  entryContext(trade: BacktestClosedTrade): BacktestEntryContext;
  entryMap(trade: BacktestClosedTrade): BacktestEntryMap;
  htfContext(trade: BacktestClosedTrade): BacktestHtfContext;
  confluence(trade: BacktestClosedTrade): { htf: string[]; ltf: string[] };
  placement(trade: BacktestClosedTrade): BacktestPlacementRead;
  /** Pojmenované úrovně ve směru obchodu — cíle pro excursion. */
  favorableLevels(trade: BacktestClosedTrade): { label: string; price: number }[];
}

export const createBacktestContextSource = (input: BacktestContextInput): BacktestContextSource => {
  // Výpočet a graf musí používat stejné časové pásmo. Dřív analytika vždy
  // zdědila Europe/Prague z defaultu i u session s jinou zónou, takže session
  // high/low, DO, VWAP i jejich swept stav mohly být posunuté.
  const settings: LevelsIndicatorSettings = {
    ...(input.levelSettings ?? ANALYSIS_LEVEL_SETTINGS),
    timezone: input.timeZone,
  };
  const snapshots = new Map<number, EntrySnapshot | null>();
  const htf: HtfContextSource = createHtfContextSource({
    candles: input.candles,
    hourly: input.htfCandles,
  });

  /**
   * Měsíční magnety se do inventáře přidávají zvlášť — `calculateLiquidityLevels`
   * je nezná, protože pracuje s minutovým oknem posledních dní a měsíční extrém
   * z něj složit nejde. Swept stav se počítá z celé dokončené hodinové
   * historie aktuálního měsíce, ne z krátkého minutového snapshotu.
   */
  const monthlyLevelsAt = (entryTime: number): LiquidityLevel[] =>
    htf.monthlyLevels(entryTime).map(level => ({
      name: level.label,
      price: level.price,
      color: 'transparent',
      width: 1 as const,
      style: 'dotted' as const,
      startTime: level.startTime,
      swept: level.swept,
    }));

  const snapshotAt = (entryTime: number): EntrySnapshot | null => {
    if (snapshots.has(entryTime)) return snapshots.get(entryTime) ?? null;
    const history = input.candles
      .filter(candle => candle.time <= entryTime)
      .slice(-SNAPSHOT_HISTORY_MINUTES);
    // Pod jedním dnem minut nemá smysl počítat PDH/PDL ani pdVWAP — vyšla by
    // jen část levelů a kontext by tvrdil, že zbytek neexistuje.
    if (history.length < 60) {
      snapshots.set(entryTime, null);
      return null;
    }
    const levelsResult = calculateLiquidityLevels(history, settings);
    const fullDailyAtr = htf.dailyAtr(entryTime);
    const partialDay = levelsResult.dayContext;
    const widthInAtr = (high: number | null, low: number | null) => (
      high === null || low === null || fullDailyAtr === null || fullDailyAtr <= 0
        ? null
        : (high - low) / fullDailyAtr
    );
    const dayContext = fullDailyAtr === null ? partialDay : {
      ...partialDay,
      dailyAtr: fullDailyAtr,
      gapAtr: partialDay.rthOpen === null || partialDay.pdClose === null
        ? null
        : (partialDay.rthOpen - partialDay.pdClose) / fullDailyAtr,
      onWidthAtr: widthInAtr(partialDay.onHigh, partialDay.onLow),
      ibWidthAtr: widthInAtr(partialDay.ibHigh, partialDay.ibLow),
    };
    const indicators = calculateIndicators(history);
    const pdVwapLevel = levelsResult.levels.find(level => level.name === 'pdVWAP');
    // Pro audit používáme stejné křivky i stejné násobky jako vykreslený
    // Levels indikátor. Hodnoty zmrazíme v entry baru; pozdější pohyb VWAP
    // nesmí zpětně změnit, kam byl původní fixní TP položený.
    const vwap = valueAt(levelsResult.vwap, entryTime);
    const upper1 = valueAt(levelsResult.upper1, entryTime);
    const targetLevels = [
      ['VWAP', vwap],
      ['VWAP +1σ', valueAt(levelsResult.upper1, entryTime)],
      ['VWAP -1σ', valueAt(levelsResult.lower1, entryTime)],
      ['VWAP +2σ', valueAt(levelsResult.upper2, entryTime)],
      ['VWAP -2σ', valueAt(levelsResult.lower2, entryTime)],
    ].flatMap(([name, price]) => typeof price === 'number' && Number.isFinite(price)
      ? [{ name: String(name), price, type: 'deviation' as const }]
      : []);
    const snapshot: EntrySnapshot = {
      history,
      levels: [...levelsResult.levels, ...monthlyLevelsAt(entryTime)],
      targetLevels,
      biasRows: levelsResult.biasRows,
      dayContext,
      structure: calculateMarketStructure(history),
      gaps: findFairValueGaps(history),
      vwap,
      vwapSigma: vwap !== null && upper1 !== null && upper1 > vwap
        ? (upper1 - vwap) / Math.max(settings.dev1Multiplier, Number.EPSILON)
        : null,
      dayOpen: valueAt(indicators.dayOpen, entryTime),
      weekOpen: valueAt(indicators.weekOpen, entryTime),
      pdVwap: pdVwapLevel?.price ?? null,
    };
    snapshots.set(entryTime, snapshot);
    return snapshot;
  };

  const proximities = (
    snapshot: EntrySnapshot,
    price: number,
    riskDistance: number | null,
  ): BacktestLevelProximity[] => snapshot.levels
    .map(level => ({
      label: level.name,
      price: level.price,
      distancePoints: Math.abs(price - level.price),
      distanceR: riskDistance ? Math.abs(price - level.price) / riskDistance : null,
      swept: level.swept,
    }))
    .sort((left, right) => left.distancePoints - right.distancePoints);

  /**
   * Jak dávno cena naposled protla každý sebraný level.
   *
   * Indikátor sice do labelu píše `[2x @15:42]`, ale to je poslední dotyk
   * VŮBEC — u levelu, kterým cena prošla až po vstupu, je ten čas k ničemu.
   * Replay má celé svíčky, takže se dotyk hledá zpět od vstupu a platí pro
   * všechny levely včetně dHigh/dLow, které v labelu čas nikdy neměly.
   */
  const sweepAges = (snapshot: EntrySnapshot, entryTime: number): BacktestSweepAge[] => {
    const wanted = new Map<string, number>();
    snapshot.levels.forEach(level => {
      if (level.swept && !wanted.has(level.name)) wanted.set(level.name, level.price);
    });
    if (!wanted.size) return [];
    let entryIndex = -1;
    for (let index = snapshot.history.length - 1; index >= 0; index -= 1) {
      if (snapshot.history[index].time <= entryTime) { entryIndex = index; break; }
    }
    if (entryIndex < 0) return [];
    const limit = Math.max(0, entryIndex - SWEEP_LOOKBACK_BARS);
    const found: BacktestSweepAge[] = [];
    for (let index = entryIndex; index >= limit && wanted.size; index -= 1) {
      const candle = snapshot.history[index];
      wanted.forEach((levelPrice, name) => {
        if (candle.low <= levelPrice && candle.high >= levelPrice) {
          found.push({ level: name, minAgo: Math.max(0, Math.round((entryTime - candle.time) / 60)) });
          wanted.delete(name);
        }
      });
    }
    return found.sort((left, right) => left.minAgo - right.minAgo).slice(0, MAX_SWEEP_AGES);
  };

  /** Vzdálenost každého levelu od vstupu; kladná nad vstupem, záporná pod ním. */
  const levelDistances = (snapshot: EntrySnapshot, price: number): Record<string, number> => {
    const distances: Record<string, number> = {};
    snapshot.levels.forEach(level => {
      // První výskyt vyhrává — stejný název se může objevit u víc rámců.
      if (distances[level.name] === undefined) distances[level.name] = round2(level.price - price) ?? 0;
    });
    return distances;
  };

  const levelHitCounts = (snapshot: EntrySnapshot): Record<string, number> => {
    const counts: Record<string, number> = {};
    snapshot.levels.forEach(level => {
      if (level.hits !== undefined && counts[level.name] === undefined) counts[level.name] = level.hits;
    });
    return counts;
  };

  const entryContext = (trade: BacktestClosedTrade): BacktestEntryContext => {
    const snapshot = snapshotAt(trade.entryTime);
    if (!snapshot) {
      return {
        available: false, reason: 'not-enough-history',
        aboveDO: null, aboveWO: null, aboveVWAP: null, abovePdVWAP: null, vwapDistSigma: null,
        sweptLevels: [], untappedAbove: 0, untappedBelow: 0,
        nearestUntappedAbove: null, nearestUntappedBelow: null, targetMagnetR: null,
        londonVsAsia: null, entryMinutes: null, nearbyLevels: [],
        ibState: null, gapAtr: null, biasScore: null,
        sweepAges: [], levelDist: {}, levelHits: {},
        untappedAboveList: [], untappedBelowList: [],
        ctx: null, htfFvg: null,
      };
    }
    const risk = riskDistanceOf(trade);
    const tolerance = toleranceOf(risk);
    const price = trade.entryPrice;
    const untapped = snapshot.levels.filter(level => !level.swept);
    const untappedAbove = untapped.filter(level => level.price > price).sort((a, b) => a.price - b.price);
    const untappedBelow = untapped.filter(level => level.price < price).sort((a, b) => b.price - a.price);
    const magnet = trade.direction === 'Long' ? untappedAbove[0] : untappedBelow[0];
    const asia = snapshot.levels.find(level => level.name === 'ASIA H');
    const london = snapshot.levels.find(level => level.name === 'LON H');
    const biasValue = (label: string) => snapshot.biasRows.find(row => row.label === label)?.value ?? null;

    return {
      available: true,
      aboveDO: above(price, snapshot.dayOpen),
      aboveWO: above(price, snapshot.weekOpen),
      aboveVWAP: above(price, snapshot.vwap),
      abovePdVWAP: above(price, snapshot.pdVwap),
      vwapDistSigma: snapshot.vwap !== null && snapshot.vwapSigma
        ? (price - snapshot.vwap) / snapshot.vwapSigma
        : null,
      sweptLevels: snapshot.levels.filter(level => level.swept).map(level => level.name),
      untappedAbove: untappedAbove.length,
      untappedBelow: untappedBelow.length,
      nearestUntappedAbove: untappedAbove[0]?.name ?? null,
      nearestUntappedBelow: untappedBelow[0]?.name ?? null,
      targetMagnetR: magnet && risk ? Math.abs(magnet.price - price) / risk : null,
      londonVsAsia: london && asia ? (london.price > asia.price ? 'above' : 'below') : null,
      entryMinutes: minuteOfDay(trade.entryTime, input.timeZone),
      nearbyLevels: proximities(snapshot, price, risk).filter(item => item.distancePoints <= tolerance * 4),
      ibState: biasValue('IB'),
      gapAtr: biasValue('Gap') ?? biasValue('Gap ~'),
      biasScore: snapshot.biasRows.find(row => row.label.startsWith('SKÓRE'))?.value ?? null,
      sweepAges: sweepAges(snapshot, trade.entryTime),
      levelDist: levelDistances(snapshot, price),
      levelHits: levelHitCounts(snapshot),
      untappedAboveList: untappedAbove.map(level => ({
        level: level.name,
        dist: round2(level.price - price),
      })),
      untappedBelowList: untappedBelow.map(level => ({
        level: level.name,
        dist: round2(price - level.price),
      })),
      ctx: {
        ib: snapshot.dayContext.ibState,
        gapAtr: round2(snapshot.dayContext.gapAtr),
        onWidthAtr: round2(snapshot.dayContext.onWidthAtr),
        ibWidthAtr: round2(snapshot.dayContext.ibWidthAtr),
        atr: round2(snapshot.dayContext.atr),
        dAtr: round2(snapshot.dayContext.dailyAtr),
        s15: htf.structure(trade.entryTime, '15'),
        s60: htf.structure(trade.entryTime, '60'),
      },
      htfFvg: htf.fvg(trade.entryTime, price),
    };
  };

  const entryMap = (trade: BacktestClosedTrade): BacktestEntryMap => {
    const snapshot = snapshotAt(trade.entryTime);
    if (!snapshot) {
      return {
        available: false, reason: 'not-enough-history',
        structureType: null, structureOrder: 0, structureBarsAgo: null,
        odrazLevels: [], odrazPrice: null, odrazLevelPrice: null,
        entryLevels: [], entryLevelPrice: null,
        entryFvg: false, entryFvgValid: false, entryFvgTimeframe: null,
        entryFvgEdge: null, entryFvgBornTime: null, entryFvgDistanceTicks: null,
        entryFvgSpan: null,
      };
    }
    const long = trade.direction === 'Long';
    const risk = riskDistanceOf(trade);
    const tolerance = toleranceOf(risk);
    const structure = readBacktestStructure(
      snapshot.history, trade.entryTime, trade.entryPrice, long, backtestTickSize(trade.instrument),
    );
    const lastEvent = structure.events.filter(event => event.direction === (long ? 'bull' : 'bear')).at(-1);
    const barsAgo = lastEvent ? Math.max(0, snapshot.history.length - 1 - lastEvent.atIndex) : null;

    const entryLevels = snapshot.levels
      .filter(level => Math.abs(level.price - trade.entryPrice) <= tolerance)
      .sort((a, b) => Math.abs(a.price - trade.entryPrice) - Math.abs(b.price - trade.entryPrice));

    // Odraz = úrovně u bodu, ve kterém se pohyb doopravdy otočil. Indikátor
    // v události nese jen proražený pivot, ne chráněný extrém — ten se ale dá
    // z replay svíček dopočítat: je to nejnižší low (resp. nejvyšší high) mezi
    // pivotem a jeho proražením. Není to „knot do levelu a zpět" pár barů před
    // vstupem, to by označilo každý průlet kolem úrovně.
    const odrazPrice = structure.odrazPrice;
    const odrazLevels: string[] = [];
    let odrazLevelPrice: number | null = null;
    if (odrazPrice !== null) {
      const nearest = [...snapshot.levels]
        .sort((a, b) => Math.abs(a.price - odrazPrice) - Math.abs(b.price - odrazPrice))[0];
      if (nearest && Math.abs(nearest.price - odrazPrice) <= tolerance) {
        // Konfluence: úrovně naskládané na témže místě se tagují všechny.
        const band = Math.max(MIN_LEVEL_TOLERANCE, tolerance * 0.6);
        snapshot.levels.forEach(level => {
          if (Math.abs(level.price - nearest.price) <= band && !odrazLevels.includes(level.name)) {
            odrazLevels.push(level.name);
          }
        });
        odrazLevelPrice = nearest.price;
      }
    }

    return {
      available: structure.available || structure.entryFvg !== null || entryLevels.length > 0,
      structureType: structure.structureType,
      structureOrder: structure.structureOrder,
      structureBarsAgo: barsAgo,
      odrazLevels,
      odrazPrice,
      odrazLevelPrice,
      entryLevels: entryLevels.map(level => level.name),
      entryLevelPrice: entryLevels[0]?.price ?? null,
      entryFvg: structure.entryFvg !== null,
      entryFvgValid: structure.entryFvg !== null,
      entryFvgTimeframe: structure.entryFvg?.timeframe ?? null,
      entryFvgEdge: structure.entryFvg ? 'proximal' : null,
      entryFvgBornTime: structure.entryFvg?.bornTime ?? null,
      entryFvgDistanceTicks: round2(structure.entryFvg?.entryDistanceTicks),
      entryFvgSpan: structure.entryFvg
        ? { bottom: structure.entryFvg.bottom, top: structure.entryFvg.top }
        : null,
    };
  };

  /** Pojmenované úrovně ve směru obchodu — vstup pro excursion. */
  const favorableLevels = (trade: BacktestClosedTrade) => {
    const snapshot = snapshotAt(trade.entryTime);
    if (!snapshot) return [];
    const long = trade.direction === 'Long';
    return [
      ...snapshot.levels
        .filter(level => !level.swept)
        .map(level => ({ label: level.name, price: level.price })),
      ...snapshot.targetLevels.map(level => ({ label: level.name, price: level.price })),
    ].filter(level => long ? level.price > trade.entryPrice : level.price < trade.entryPrice);
  };

  const htfContext = (trade: BacktestClosedTrade): BacktestHtfContext => {
    if (!input.htfCandles || input.htfCandles.length < 3) {
      return { available: false, reason: 'no-htf-candles', structureType: null, structureDirection: null, aligned: null, htfLevels: [] };
    }
    const long = trade.direction === 'Long';
    // Stejný zdroj jako `ctx.s60`, aby chip v deníku a tahle sekce nikdy
    // netvrdily o téže hodině dvě různé věci.
    const latest = htf.structure(trade.entryTime, '60');
    const snapshot = snapshotAt(trade.entryTime);
    const risk = riskDistanceOf(trade);
    const htfLabels = new Set(['PDH', 'PDL', 'PWH', 'PWL', 'PMH', 'PML', 'MO', 'WO', 'DO', 'PDC', 'PD MID']);
    const htfLevels = snapshot
      ? proximities(snapshot, trade.entryPrice, risk)
        .filter(item => htfLabels.has(item.label) && item.distancePoints <= toleranceOf(risk) * 4)
        .map(item => item.label)
      : [];
    return {
      available: true,
      structureType: latest?.type ?? null,
      structureDirection: latest ? (latest.dir === 'bull' ? 'bullish' : 'bearish') : null,
      aligned: latest ? (latest.dir === 'bull') === long : null,
      htfLevels,
    };
  };

  const confluence = (trade: BacktestClosedTrade) => {
    const context = entryContext(trade);
    const map = entryMap(trade);
    const htf = htfContext(trade);
    const htfTags: string[] = [];
    if (htf.structureType && htf.structureDirection) {
      htfTags.push(`1h ${htf.structureType} ${htf.structureDirection === 'bullish' ? 'bullish' : 'bearish'}`);
    }
    if (context.ctx?.s15) {
      htfTags.push(`15m ${context.ctx.s15.type} ${context.ctx.s15.dir === 'bull' ? 'bullish' : 'bearish'}`);
    }
    htf.htfLevels.forEach(label => htfTags.push(`u ${label}`));
    if (context.htfFvg?.inside15) htfTags.push('v 15m FVG');
    if (context.htfFvg?.inside60) htfTags.push('v 1h FVG');
    if (context.aboveDO !== null) htfTags.push(context.aboveDO ? 'nad Day Open' : 'pod Day Open');
    if (context.aboveWO !== null) htfTags.push(context.aboveWO ? 'nad Week Open' : 'pod Week Open');

    const ltfTags: string[] = [];
    if (map.structureType) {
      ltfTags.push(map.structureBarsAgo === null
        ? `1m ${map.structureType}`
        : `1m ${map.structureType} (${barsAgoLabel(map.structureBarsAgo)})`);
    }
    if (map.entryFvg) ltfTags.push('vstup ve FVG');
    map.odrazLevels.forEach(label => ltfTags.push(`odraz od ${label}`));
    if (context.aboveVWAP !== null) ltfTags.push(context.aboveVWAP ? 'nad VWAP' : 'pod VWAP');
    if (context.vwapDistSigma !== null) ltfTags.push(`VWAP ${context.vwapDistSigma >= 0 ? '+' : ''}${context.vwapDistSigma.toFixed(1)}σ`);

    return { htf: [...new Set(htfTags)], ltf: [...new Set(ltfTags)] };
  };

  const placement = (trade: BacktestClosedTrade): BacktestPlacementRead => {
    const snapshot = snapshotAt(trade.entryTime);
    const risk = riskDistanceOf(trade);
    if (!snapshot || !Number.isFinite(trade.initialStopLoss as number)) {
      return emptyPlacement();
    }
    const long = trade.direction === 'Long';
    const tickSize = backtestTickSize(trade.instrument);
    const tolerance = tickSize;
    const stop = Number(trade.initialStopLoss);
    const structure = readBacktestStructure(
      snapshot.history, trade.entryTime, trade.entryPrice, long, tickSize,
    );
    const candidate = (price: number | null) => ({
      price,
      distanceTicks: price === null ? null : round2(Math.abs(stop - price) / tickSize),
      matched: price !== null && Math.abs(stop - price) <= tolerance,
    });
    const slCandidates = {
      ote: candidate(structure.ote),
      swing: candidate(structure.swing),
      fvg: candidate(structure.fvg),
    };
    const matched = (Object.entries(slCandidates) as Array<['ote' | 'swing' | 'fvg', typeof slCandidates.ote]>)
      .filter(([, value]) => value.matched)
      .sort((left, right) => (left[1].distanceTicks ?? Infinity) - (right[1].distanceTicks ?? Infinity));
    const slPlacement = matched[0]?.[0] ?? 'other';

    const favorable = [
      ...snapshot.levels
        .filter(level => !level.swept)
        .map(level => ({ name: level.name, price: level.price, type: 'liquidity' as const })),
      ...snapshot.targetLevels,
    ]
      .filter(level => long ? level.price > trade.entryPrice : level.price < trade.entryPrice)
      .sort((left, right) => Math.abs(left.price - trade.entryPrice) - Math.abs(right.price - trade.entryPrice));
    const nearest = favorable[0] ?? null;

    if (!Number.isFinite(trade.initialTakeProfit as number)) {
      return {
        slPlacement, targetType: 'session_close', targetLevel: 'EOD', slCandidates,
        targetPolicy: {
          expected: 'session_close', nearestLevel: nearest?.name ?? null,
          nearestPrice: nearest?.price ?? null, actualPrice: null,
          distanceTicks: null, valid: true,
        },
      };
    }
    const target = Number(trade.initialTakeProfit);
    const distanceTicks = nearest ? Math.abs(target - nearest.price) / tickSize : null;
    const targetValid = distanceTicks !== null ? distanceTicks <= 1 : false;
    return {
      slPlacement,
      targetType: targetValid ? nearest?.type ?? 'liquidity' : 'other',
      targetLevel: targetValid ? nearest?.name ?? null : null,
      slCandidates,
      targetPolicy: {
        expected: 'nearest_level', nearestLevel: nearest?.name ?? null,
        nearestPrice: nearest?.price ?? null, actualPrice: target,
        distanceTicks: round2(distanceTicks), valid: targetValid,
      },
    };
  };

  return { entryContext, entryMap, htfContext, confluence, placement, favorableLevels };
};
