import { DEFAULT_INDICATOR_SETTINGS, type LevelsIndicatorSettings } from '../components/ChartIndicatorSettingsDialog';
import {
  calculateIndicators,
  calculateMarketStructure,
  findFairValueGaps,
  type FairValueGap,
  type MarketCandle,
  type MarketStructureEvent,
} from './marketData';
import { calculateLiquidityLevels, type LiquidityLevel } from './liquidityLevels';
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

/** Kolik svíček před vstupem se prohlíží při hledání odrazu. */
const BOUNCE_LOOKBACK_BARS = 5;
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
  /** Kam reálně padl stop: fvg | swing | level | other. */
  slPlacement: string | null;
  /** Na co cílil TP: level | fixed_rr | other. */
  targetType: string | null;
  targetLevel: string | null;
}

const toleranceOf = (riskDistance: number | null): number =>
  riskDistance ? Math.max(MIN_LEVEL_TOLERANCE, riskDistance * LEVEL_TOLERANCE_R) : MIN_LEVEL_TOLERANCE;

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
  biasRows: { label: string; value: string }[];
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
  const settings = input.levelSettings ?? ANALYSIS_LEVEL_SETTINGS;
  const snapshots = new Map<number, EntrySnapshot | null>();

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
    const indicators = calculateIndicators(history);
    const pdVwapLevel = levelsResult.levels.find(level => level.name === 'pdVWAP');
    const vwap = valueAt(indicators.vwap, entryTime);
    const upper = valueAt(indicators.upperDeviation, entryTime);
    const snapshot: EntrySnapshot = {
      history,
      levels: levelsResult.levels,
      biasRows: levelsResult.biasRows,
      structure: calculateMarketStructure(history),
      gaps: findFairValueGaps(history),
      vwap,
      vwapSigma: vwap !== null && upper !== null && upper > vwap ? upper - vwap : null,
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
        entryFvg: false, entryFvgSpan: null,
      };
    }
    const long = trade.direction === 'Long';
    const risk = riskDistanceOf(trade);
    const tolerance = toleranceOf(risk);
    const tickSize = backtestTickSize(trade.instrument);
    // Struktura se čte stejným postupem jako v extension, ne přes
    // `calculateMarketStructure` — viz komentář v backtestStructureLevels.
    const structure = readBacktestStructure(
      snapshot.history, trade.entryTime, trade.entryPrice, long, tickSize,
    );
    const lastEvent = structure.events[structure.events.length - 1];
    const barsAgo = lastEvent
      ? snapshot.history.length - 1 - lastEvent.atIndex
      : null;

    const entryLevels = snapshot.levels
      .filter(level => Math.abs(level.price - trade.entryPrice) <= tolerance)
      .sort((a, b) => Math.abs(a.price - trade.entryPrice) - Math.abs(b.price - trade.entryPrice));

    // Odraz = úrovně u chráněného extrému PRVNÍHO zlomu série, tedy tam, kde se
    // pohyb doopravdy otočil. Není to „knot do levelu a zpět" pár barů před
    // vstupem — to by označilo každý průlet kolem úrovně.
    const odrazLevels: string[] = [];
    let odrazLevelPrice: number | null = null;
    if (structure.odrazPrice !== null) {
      const nearest = [...snapshot.levels]
        .sort((a, b) => Math.abs(a.price - Number(structure.odrazPrice)) - Math.abs(b.price - Number(structure.odrazPrice)))[0];
      if (nearest && Math.abs(nearest.price - Number(structure.odrazPrice)) <= tolerance) {
        // Konfluence: úrovně naskládané na témže místě se tagují všechny.
        const band = Math.max(tickSize * 16, tolerance * 0.6);
        snapshot.levels.forEach(level => {
          if (Math.abs(level.price - nearest.price) <= band && !odrazLevels.includes(level.name)) {
            odrazLevels.push(level.name);
          }
        });
        odrazLevelPrice = nearest.price;
      }
    }

    return {
      available: structure.available,
      structureType: structure.structureType,
      structureOrder: structure.structureOrder,
      structureBarsAgo: barsAgo,
      odrazLevels,
      odrazPrice: structure.odrazPrice,
      odrazLevelPrice,
      entryLevels: entryLevels.map(level => level.name),
      entryLevelPrice: entryLevels[0]?.price ?? null,
      // Stejné pravidlo jako v extension: mezera, jejíž bližší hrana leží
      // u vstupu, a jejíž vzdálená hrana je kandidát na stopku.
      entryFvg: structure.fvg !== null,
      entryFvgSpan: structure.fvg === null
        ? null
        : long
          ? { bottom: structure.fvg, top: trade.entryPrice }
          : { bottom: trade.entryPrice, top: structure.fvg },
    };
  };

  /** Pojmenované úrovně ve směru obchodu — vstup pro excursion. */
  const favorableLevels = (trade: BacktestClosedTrade) => {
    const snapshot = snapshotAt(trade.entryTime);
    if (!snapshot) return [];
    const long = trade.direction === 'Long';
    return snapshot.levels
      .filter(level => long ? level.price > trade.entryPrice : level.price < trade.entryPrice)
      .map(level => ({ label: level.name, price: level.price }));
  };

  let htfStructure: MarketStructureEvent[] | null = null;
  const htfContext = (trade: BacktestClosedTrade): BacktestHtfContext => {
    if (!input.htfCandles || input.htfCandles.length < 3) {
      return { available: false, reason: 'no-htf-candles', structureType: null, structureDirection: null, aligned: null, htfLevels: [] };
    }
    if (htfStructure === null) {
      htfStructure = calculateMarketStructure(input.htfCandles.filter(candle => candle.time <= trade.entryTime));
    }
    const long = trade.direction === 'Long';
    // `findEntryStructureEvent` filtruje na směr obchodu; tady nás zajímá
    // poslední událost bez ohledu na směr, ať se pozná i vstup proti HTF.
    const latest = [...htfStructure]
      .filter(event => event.breakTime <= trade.entryTime)
      .sort((left, right) => right.breakTime - left.breakTime)[0];
    const snapshot = snapshotAt(trade.entryTime);
    const risk = riskDistanceOf(trade);
    const htfLabels = new Set(['PDH', 'PDL', 'PWH', 'PWL', 'WO', 'DO', 'PDC', 'PD MID']);
    const htfLevels = snapshot
      ? proximities(snapshot, trade.entryPrice, risk)
        .filter(item => htfLabels.has(item.label) && item.distancePoints <= toleranceOf(risk) * 4)
        .map(item => item.label)
      : [];
    return {
      available: true,
      structureType: latest ? (latest.type === 'BOS' ? 'BoS' : 'CHoCH') : null,
      structureDirection: latest?.direction ?? null,
      aligned: latest ? (latest.direction === 'bullish') === long : null,
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
    htf.htfLevels.forEach(label => htfTags.push(`u ${label}`));
    if (context.aboveDO !== null) htfTags.push(context.aboveDO ? 'nad Day Open' : 'pod Day Open');
    if (context.aboveWO !== null) htfTags.push(context.aboveWO ? 'nad Week Open' : 'pod Week Open');

    const ltfTags: string[] = [];
    if (map.structureType) {
      ltfTags.push(map.structureBarsAgo === null
        ? `1m ${map.structureType}`
        : `1m ${map.structureType} (${map.structureBarsAgo} barů zpět)`);
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
      return { slPlacement: null, targetType: null, targetLevel: null };
    }
    const long = trade.direction === 'Long';
    const tolerance = toleranceOf(risk);
    const stop = Number(trade.initialStopLoss);

    const stopLevel = proximities(snapshot, stop, risk).find(item => item.distancePoints <= tolerance);
    // „SL na FVG" znamená za vzdálenou hranou mezery, ne kdekoli uvnitř ní.
    // Kdyby stačilo být v rozsahu, spadla by pod FVG skoro každá stopka —
    // mezer je na minutovém grafu spousta a bývají široké.
    const stopGap = snapshot.gaps.find(gap => gap.startTime <= trade.entryTime
      && Math.abs(stop - (long ? gap.bottom : gap.top)) <= tolerance);
    // Swing = stopka leží za extrémem posledních barů, tedy tam, kde by ji
    // struktura popřela.
    const lookback = snapshot.history.slice(-BOUNCE_LOOKBACK_BARS * 4);
    const extreme = lookback.length
      ? long ? Math.min(...lookback.map(candle => candle.low)) : Math.max(...lookback.map(candle => candle.high))
      : null;
    const atSwing = extreme !== null && Math.abs(stop - extreme) <= tolerance;

    // Struktura má přednost: když stopka sedí na swingu i na hraně mezery, jde
    // o tutéž cenu a swing je silnější důvod, proč tam trader stop dal.
    const slPlacement = atSwing ? 'swing' : stopGap ? 'fvg' : stopLevel ? 'level' : 'other';

    if (!Number.isFinite(trade.initialTakeProfit as number)) {
      return { slPlacement, targetType: null, targetLevel: null };
    }
    const target = Number(trade.initialTakeProfit);
    const targetLevel = proximities(snapshot, target, risk).find(item => item.distancePoints <= tolerance);
    const multiple = risk ? Math.abs(target - trade.entryPrice) / risk : null;
    // Kulatý násobek rizika (±0,05R) je fixní RR, ne cíl na úrovni.
    const roundMultiple = multiple !== null && Math.abs(multiple - Math.round(multiple)) <= 0.05 && Math.round(multiple) >= 1;
    return {
      slPlacement,
      targetType: targetLevel ? 'level' : roundMultiple ? 'fixed_rr' : 'other',
      targetLevel: targetLevel?.label ?? (roundMultiple ? `${Math.round(multiple as number)}R` : null),
    };
  };

  return { entryContext, entryMap, htfContext, confluence, placement, favorableLevels };
};
