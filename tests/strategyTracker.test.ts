import { describe, expect, it } from 'vitest';
import {
  advanceStrategyTracker,
  emptyStrategyTracker,
  strategyPositionBoxes,
  strategyTrackerSummary,
  type StrategyTrackerState,
} from '../services/strategyTracker';
import type { LiquidityLevel } from '../services/liquidityLevels';
import type { MarketCandle } from '../services/marketData';

const bar = (index: number, open: number, high: number, low: number, close: number): MarketCandle =>
  ({ time: 1_000 + index * 60, open, high, low, close, volume: 1 });

const level = (name: string, price: number, swept = false): LiquidityLevel =>
  ({ name, price, color: '#fff', width: 1, style: 'solid', startTime: 0, swept });

const base = (): MarketCandle[] => [
  bar(0, 90, 92.5, 89.5, 92),
  bar(1, 92, 95.0, 93.0, 94.5),
  bar(2, 94.5, 95.2, 91.5, 92),
  bar(3, 92, 96.0, 92.0, 95.5),
  bar(4, 95.5, 98.5, 95.0, 98),
  bar(5, 98, 100.5, 97.5, 99),
  bar(6, 99, 99.2, 95.5, 96),
  bar(7, 96, 96.2, 91.0, 91.2),
  bar(8, 91.2, 91.5, 88.0, 88.5),
];

const levels = () => [level('ON H', 100), level('PDL', 80), level('ASIA L', 82)];

/** Přehraje sérii svíčku po svíčce, jak to dělá replay. */
const replay = (candles: MarketCandle[], all: LiquidityLevel[] = levels()): StrategyTrackerState => {
  let state = emptyStrategyTracker();
  for (let index = 5; index <= candles.length; index += 1) {
    state = advanceStrategyTracker(state, { candles: candles.slice(0, index), levels: all });
  }
  return state;
};

describe('advanceStrategyTracker', () => {
  it('otevře pozici, když se objeví signál', () => {
    const state = replay(base());
    expect(state.positions.length).toBeGreaterThan(0);
    expect(state.positions[0].direction).toBe('short');
  });

  it('tentýž setup neotevře podruhé, i když signál drží víc svíček', () => {
    const held = [...base(), bar(9, 88.5, 88.8, 87.5, 88), bar(10, 88, 88.4, 87.0, 87.5)];
    expect(replay(held).positions).toHaveLength(1);
  });

  it('drží pozici otevřenou, dokud cena netrefí stop ani cíl', () => {
    const state = replay(base());
    expect(state.positions[0].closedAt).toBeNull();
    expect(state.positions[0].outcome).toBeNull();
  });

  it('zavře na stopu, když ho cena trefí', () => {
    const state = replay(base());
    const stop = state.positions[0].stop;
    const withStop = [...base(), bar(9, 88.5, stop + 0.5, 88, stop + 0.2), bar(10, stop, stop + 1, 88, stop + 0.5)];
    const closed = replay(withStop);
    expect(closed.positions[0].outcome).toBe('stop');
    expect(closed.positions[0].closedAt).not.toBeNull();
  });

  it('při souběhu stopu a cíle v jedné svíčce vyhrává stop', () => {
    const opening = replay(base());
    const { stop, target } = opening.positions[0];
    const both = [...base(), bar(9, 89, stop + 1, target - 1, 89)];
    expect(replay(both).positions[0].outcome).toBe('stop');
  });

  it('umí držet víc pozic naráz', () => {
    // Druhá vlna na ON H. Pullback na indexu 11 tam musí být — bez pivot low
    // by druhá otočka neměla co prorazit a signál by se neopakoval.
    const second = [
      ...base(),
      bar(9, 88.5, 92.0, 88.0, 91),
      bar(10, 91, 93.0, 90.5, 92.5),
      bar(11, 92.5, 93.2, 89.5, 90),
      bar(12, 90, 96.5, 90.0, 96),
      bar(13, 96, 100.5, 95.5, 99),
      bar(14, 99, 99.2, 95.0, 95.5),
      bar(15, 95.5, 95.8, 89.0, 89.2),
      bar(16, 89.2, 89.5, 86.0, 86.5),
    ];
    const state = replay(second);
    expect(state.positions.length).toBeGreaterThanOrEqual(2);
  });

  it('stejná svíčka podruhé stav nemění', () => {
    const candles = base();
    const once = advanceStrategyTracker(emptyStrategyTracker(), { candles, levels: levels() });
    const twice = advanceStrategyTracker(once, { candles, levels: levels() });
    expect(twice).toBe(once);
  });

  it('cíl míří na první netknutý magnet po směru', () => {
    const withMagnet = [level('ON H', 100), level('PD MID', 89, false), level('PDL', 80)];
    const state = replay(base(), withMagnet);
    // Short od ~96 — první netknutý magnet pod vstupem je PD MID na 89.
    expect(state.positions[0].target).toBe(89);
  });

  it('bez magnetu použije násobek rizika', () => {
    const state = replay(base(), [level('ON H', 100)]);
    const position = state.positions[0];
    const risk = Math.abs(position.entry - position.stop);
    expect(position.target).toBeCloseTo(position.entry - risk * 2);
  });

  it('vzdálený magnet se ořízne, aby cíl nevyšel na desítky R', () => {
    // Jediný netknutý magnet je sto bodů daleko; stopka je hrana mezery.
    const state = replay(base(), [level('ON H', 100), level('PWL', 0.5)]);
    const position = state.positions[0];
    const risk = Math.abs(position.entry - position.stop);
    expect(Math.abs(position.entry - position.target) / risk).toBeLessThanOrEqual(10);
  });

  it('VWAP pásmo se počítá jako magnet, i když není v levelech', () => {
    const candles = base();
    const points = candles.map(candle => ({ time: candle.time, value: 93 }));
    let state = emptyStrategyTracker();
    for (let index = 5; index <= candles.length; index += 1) {
      state = advanceStrategyTracker(state, {
        candles: candles.slice(0, index),
        levels: [level('ON H', 100)],
        dynamicLevels: [{ name: 'VWAP -1σ', points }],
      });
    }
    // Short od ~96 — pásmo na 93 je blíž než fallback 2R.
    expect(state.positions[0].target).toBe(93);
  });
});

describe('strategyPositionBoxes', () => {
  it('vyrobí boxy ve tvaru, který graf už umí kreslit', () => {
    const boxes = strategyPositionBoxes(replay(base()), 'MNQ');
    expect(boxes[0]).toMatchObject({ tool: 'ShortPosition', state: 'active', terminalTime: null });
    expect(boxes[0].style.position?.targetColor).toBe('#8b5cf6');
  });

  it('zavřená pozice má terminální čas, takže se přestane táhnout', () => {
    const state = replay(base());
    const stop = state.positions[0].stop;
    const closed = replay([...base(), bar(9, 88.5, stop + 1, 88, stop + 0.5)]);
    const boxes = strategyPositionBoxes(closed, 'MNQ');
    expect(boxes[0].state).toBe('closed');
    expect(boxes[0].terminalTime).not.toBeNull();
  });
});

describe('strategyTrackerSummary', () => {
  it('spočítá otevřené, zavřené a jak dopadly', () => {
    expect(strategyTrackerSummary(replay(base()))).toMatchObject({ open: 1, closed: 0 });
  });
});
