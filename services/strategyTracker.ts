import type { MarketCandle } from './marketData';
import type { LiquidityLevel } from './liquidityLevels';
import {
  evaluateStrategySignal,
  type StrategyDirection,
  type StrategyDynamicLevel,
  type StrategySignalOptions,
} from './strategySignal';
import type { BacktestManagedPositionBox } from './backtestManagedPosition';
import { normalizePositionSettings, type PositionDrawingStyle } from './chartPositionDrawing';

/**
 * Papírové pozice detektoru napříč replayem.
 *
 * Detektor sám je snapshot — řekne jen, jestli na téhle svíčce setup platí.
 * Tracker z toho dělá běžící stav: když se objeví signál, otevře pozici a drží
 * ji, dokud cena netrefí stop nebo cíl. Otevřených může být víc naráz.
 *
 * Dvě věci, které to hlídá:
 *
 * Signál drží často několik svíček po sobě, takže bez ochrany by z jednoho
 * setupu vznikla desítka pozic. Klíčem je proto trojice sweep + zlom + mezera —
 * dokud se nezmění, jde pořád o tentýž obchod.
 *
 * A stop má přednost před cílem, když je svíčka trefí obě. Pořadí uvnitř baru
 * z OHLC nepoznáš a stejnou konvenci používá i `processBacktestCandle`, takže
 * papírové pozice nejsou optimističtější než reálný backtest.
 */

export interface StrategyPaperPosition {
  id: string;
  direction: StrategyDirection;
  entry: number;
  stop: number;
  target: number;
  openedAt: number;
  closedAt: number | null;
  outcome: 'stop' | 'target' | null;
  sweepLevel: string;
  fvgOrder: number;
}

export interface StrategyTrackerState {
  positions: StrategyPaperPosition[];
  /** Poslední zpracovaná svíčka, aby se tatáž nepočítala dvakrát. */
  lastTime: number | null;
  /** Podpisy setupů, které už pozici vyrobily. */
  seen: string[];
}

export const emptyStrategyTracker = (): StrategyTrackerState =>
  ({ positions: [], lastTime: null, seen: [] });

/** Kolik R od vstupu leží cíl, když se nenajde žádný magnet. */
const FALLBACK_TARGET_R = 2;
/**
 * Strop vzdálenosti cíle v R.
 *
 * „První netknutý magnet" umí být sto bodů daleko, když jsou všechny bližší
 * úrovně sebrané — při stopce o velikosti hrany mezery to vyjde na desítky R
 * a box zabere celý graf. Takový cíl není TP politika, je to artefakt.
 */
const MAX_TARGET_R = 10;

const targetFor = (
  direction: StrategyDirection,
  entry: number,
  stop: number,
  levels: readonly LiquidityLevel[],
  dynamicLevels: readonly StrategyDynamicLevel[],
  atTime: number,
): number => {
  const risk = Math.abs(entry - stop);
  const long = direction === 'long';
  const cap = long ? entry + risk * MAX_TARGET_R : entry - risk * MAX_TARGET_R;
  const beyond = (price: number) => Number.isFinite(price) && (long ? price > entry : price < entry);

  // Cíl je první magnet po směru obchodu. Sebrané statické úrovně se
  // přeskakují, ale VWAP rodina se počítá vždycky — ta je „živá" a v praxi to
  // bývá ten nejbližší magnet vůbec.
  const magnets = [
    ...levels.filter(level => !level.swept && beyond(level.price)).map(level => level.price),
    ...dynamicLevels
      .map(series => series.points.find(point => point.time === atTime)?.value)
      .filter((value): value is number => value !== undefined && beyond(value)),
  ];
  if (!magnets.length) {
    return long ? entry + risk * FALLBACK_TARGET_R : entry - risk * FALLBACK_TARGET_R;
  }
  const nearest = long ? Math.min(...magnets) : Math.max(...magnets);
  return long ? Math.min(nearest, cap) : Math.max(nearest, cap);
};

export interface StrategyTrackerInput {
  candles: readonly MarketCandle[];
  levels: readonly LiquidityLevel[];
  dynamicLevels?: readonly StrategyDynamicLevel[];
  candles5m?: readonly MarketCandle[];
  candles15m?: readonly MarketCandle[];
}

/**
 * Posune tracker na aktuální svíčku.
 *
 * Volá se při každém replay kroku. Vrací nový stav, původní nemění — díky tomu
 * jde stav bezpečně držet v refu a porovnávat identitou.
 */
export const advanceStrategyTracker = (
  state: StrategyTrackerState,
  input: StrategyTrackerInput,
  options: StrategySignalOptions = {},
): StrategyTrackerState => {
  const { candles, levels } = input;
  const last = candles[candles.length - 1];
  if (!last || state.lastTime === last.time) return state;

  // Nejdřív dořešit otevřené pozice na téhle svíčce, teprve pak otevírat nové.
  let changed = false;
  const positions = state.positions.map(position => {
    if (position.closedAt !== null || last.time <= position.openedAt) return position;
    const long = position.direction === 'long';
    const hitStop = long ? last.low <= position.stop : last.high >= position.stop;
    const hitTarget = long ? last.high >= position.target : last.low <= position.target;
    if (!hitStop && !hitTarget) return position;
    changed = true;
    return { ...position, closedAt: last.time, outcome: hitStop ? 'stop' as const : 'target' as const };
  });

  const evaluation = evaluateStrategySignal(input, options);
  if (evaluation.kind === 'signal') {
    const signature = [
      evaluation.sweep.time, evaluation.sweep.level,
      evaluation.breakEvent.atIndex, evaluation.selected.formedAt,
    ].join('|');
    if (!state.seen.includes(signature)) {
      const target = targetFor(
        evaluation.direction, evaluation.entry, evaluation.stop,
        levels, input.dynamicLevels ?? [], last.time,
      );
      positions.push({
        id: `strategy-${evaluation.sweep.time}-${evaluation.selected.formedAt}`,
        direction: evaluation.direction,
        entry: evaluation.entry,
        stop: evaluation.stop,
        target,
        openedAt: last.time,
        closedAt: null,
        outcome: null,
        sweepLevel: evaluation.sweep.level,
        fvgOrder: evaluation.selected.order,
      });
      return { positions, lastTime: last.time, seen: [...state.seen, signature] };
    }
  }

  return changed || state.lastTime !== last.time
    ? { positions, lastTime: last.time, seen: state.seen }
    : state;
};

/** Odstín, kterým se papírové pozice odliší od těch, co obchoduješ ty. */
export const STRATEGY_BOX_COLORS = {
  long: { target: '#8b5cf6', stop: '#c4b5fd' },
  short: { target: '#8b5cf6', stop: '#c4b5fd' },
} as const;

/**
 * Papírové pozice ve tvaru, který graf už umí kreslit.
 *
 * Vrací se `BacktestManagedPositionBox`, takže se použije tatáž cesta jako
 * u boxů z reálného backtestu — včetně toho, že se pravá hrana táhne s replayem
 * a po zavření se zastaví na terminálním čase.
 */
export const strategyPositionBoxes = (
  state: StrategyTrackerState,
  instrumentRoot: string,
): BacktestManagedPositionBox[] => state.positions.map(position => {
  const long = position.direction === 'long';
  const colors = long ? STRATEGY_BOX_COLORS.long : STRATEGY_BOX_COLORS.short;
  const style: PositionDrawingStyle = {
    position: {
      ...normalizePositionSettings(undefined, instrumentRoot),
      stopColor: colors.stop,
      targetColor: colors.target,
      compactStats: true,
    },
  } as PositionDrawingStyle;
  return {
    id: position.id,
    orderId: position.id,
    instrument: instrumentRoot as BacktestManagedPositionBox['instrument'],
    tool: long ? 'LongPosition' : 'ShortPosition',
    startTime: position.openedAt,
    initialEndTime: position.openedAt + 5 * 60,
    entryPrice: position.entry,
    targetPrice: position.target,
    stopPrice: position.stop,
    style,
    terminalTime: position.closedAt,
    state: position.closedAt === null ? 'active' : 'closed',
  };
});

export interface StrategyTrackerSummary {
  open: number;
  closed: number;
  targets: number;
  stops: number;
}

export const strategyTrackerSummary = (state: StrategyTrackerState): StrategyTrackerSummary => ({
  open: state.positions.filter(position => position.closedAt === null).length,
  closed: state.positions.filter(position => position.closedAt !== null).length,
  targets: state.positions.filter(position => position.outcome === 'target').length,
  stops: state.positions.filter(position => position.outcome === 'stop').length,
});
