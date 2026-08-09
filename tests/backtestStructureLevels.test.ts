import { describe, expect, it } from 'vitest';
import {
  backtestEntryIndex,
  backtestStructuralTrail,
  readBacktestStructure,
} from '../services/backtestStructureLevels';
import type { MarketCandle } from '../services/marketData';

const bar = (index: number, open: number, high: number, low: number, close: number): MarketCandle =>
  ({ time: 1_000 + index * 60, open, high, low, close, volume: 1 });

/**
 * Ruční série s jedním býčím zlomem.
 *
 * idx 1 dělá pivot high 102, idx 3 pivot low 98 a idx 5 zavře nad 102 →
 * zlom vzhůru s chráněným dnem na 98. Mezi idx 4 a 6 je navíc býčí mezera
 * 99.5–100.5, jejíž horní hrana leží u vstupu.
 */
const bullBreakSeries = (): MarketCandle[] => [
  bar(0, 100, 100.5, 99.5, 100),
  bar(1, 100, 102.0, 99.8, 101.5),
  bar(2, 101.5, 101.8, 100.5, 101),
  bar(3, 101, 101.2, 98.0, 98.5),
  bar(4, 98.5, 99.5, 98.2, 99.2),
  bar(5, 99.2, 103.5, 99.0, 103.0),
  bar(6, 103, 103.2, 100.5, 100.8),
  bar(7, 100.8, 101.5, 100.4, 101.0),
];

const ENTRY_TIME = 1_000 + 6 * 60;

describe('readBacktestStructure', () => {
  it('najde býčí zlom a jeho chráněné dno jako swing', () => {
    const read = readBacktestStructure(bullBreakSeries(), ENTRY_TIME, 100.5, true, 0.25);
    expect(read.available).toBe(true);
    expect(read.swing).toBe(98);
  });

  it('první zlom v sérii je CHoCH, druhý už BoS', () => {
    const first = readBacktestStructure(bullBreakSeries(), ENTRY_TIME, 100.5, true, 0.25);
    expect(first).toMatchObject({ structureType: 'CHoCH', structureOrder: 1 });

    // Druhý pivot high a druhý průraz → série o dvou zlomech mým směrem.
    const extended = [
      ...bullBreakSeries(),
      bar(8, 101, 104.5, 100.8, 104.0),
      bar(9, 104, 104.2, 103.0, 103.5),
      bar(10, 103.5, 103.8, 102.0, 102.5),
      bar(11, 102.5, 105.5, 102.3, 105.0),
      bar(12, 105, 105.2, 104.0, 104.5),
    ];
    const second = readBacktestStructure(extended, 1_000 + 12 * 60, 104.5, true, 0.25);
    expect(second.structureOrder).toBeGreaterThanOrEqual(2);
    expect(second.structureType).toBe('BoS');
  });

  it('odraz je chráněný extrém PRVNÍHO zlomu série, ne posledního', () => {
    const read = readBacktestStructure(bullBreakSeries(), ENTRY_TIME, 100.5, true, 0.25);
    expect(read.odrazPrice).toBe(98);
  });

  it('OTE leží na 0,79 impulzní nohy', () => {
    const read = readBacktestStructure(bullBreakSeries(), ENTRY_TIME, 100.5, true, 0.25);
    // Noha 98 → 103.5; 103.5 − 0.79 × 5.5 = 99.155, na tick 0.25 → 99.25.
    expect(read.ote).toBe(99.25);
  });

  it('FVG vrací vzdálenou hranu mezery, ne tu u vstupu', () => {
    const read = readBacktestStructure(bullBreakSeries(), ENTRY_TIME, 100.5, true, 0.25);
    // Mezera mezi high idx 4 (99.5) a low idx 6 (100.5); chráněná strana je dno.
    expect(read.fvg).toBe(99.5);
  });

  it('bez zlomu nevrací vymyšlené úrovně', () => {
    const flat = Array.from({ length: 40 }, (_, index) => bar(index, 100, 100.1, 99.9, 100));
    const read = readBacktestStructure(flat, 1_000 + 39 * 60, 100, true, 0.25);
    expect(read).toMatchObject({ available: false, structureType: null, swing: null, ote: null });
  });

  it('krátká historie se nevyhodnocuje', () => {
    const read = readBacktestStructure([bar(0, 100, 101, 99, 100)], 1_000, 100, true, 0.25);
    expect(read.available).toBe(false);
  });
});

describe('backtestEntryIndex', () => {
  it('vrací poslední svíčku na nebo před vstupem', () => {
    expect(backtestEntryIndex(bullBreakSeries(), ENTRY_TIME)).toBe(6);
    expect(backtestEntryIndex(bullBreakSeries(), ENTRY_TIME + 30)).toBe(6);
  });

  it('vstup před daty vrací −1', () => {
    expect(backtestEntryIndex(bullBreakSeries(), 500)).toBe(-1);
  });
});

describe('backtestStructuralTrail', () => {
  /**
   * Vstup na idx 6 za 100,5. Dál idx 7 tvoří pivot high 104, idx 8 pivot low
   * 100,9 a idx 10 zavře nad 104 → vnitřní zlom posune stopku na 100,9. Idx 11
   * se pro ni vrátí.
   */
  const trailSeries = (): MarketCandle[] => [
    ...bullBreakSeries().slice(0, 6),
    bar(6, 103, 103.25, 100.5, 101.5),
    bar(7, 101.5, 104.0, 101.25, 103.75),
    bar(8, 103.75, 103.75, 100.75, 101.25),
    bar(9, 101.25, 103.0, 101.0, 102.75),
    bar(10, 102.75, 106.0, 102.5, 105.5),
    bar(11, 105.5, 106.25, 100.0, 100.25),
  ];

  it('posune stopku na vnitřní zlom a vystoupí v plusu', () => {
    const trail = backtestStructuralTrail(trailSeries(), ENTRY_TIME, 100.5, true, 98, undefined, 0.25);
    expect(trail).not.toBeNull();
    expect(trail!.trailSteps).toBe(1);
    expect(trail!.trailFinal).toBe(100.75);
    expect(trail!.reason).toBe('trail+');
    // Měří se v R STARTOVNÍ stopky: (100.75 − 100.5) / (100.5 − 98) = 0.1.
    expect(trail!.realizedR).toBeCloseTo(0.1);
  });

  it('zásah cíle má přednost před trailingem', () => {
    const candles = [...bullBreakSeries(), bar(8, 101, 108, 100.9, 107), bar(9, 107, 107.5, 106.5, 107)];
    const trail = backtestStructuralTrail(candles, ENTRY_TIME, 100.5, true, 98, 106, 0.25);
    expect(trail).toMatchObject({ reason: 'tp', exit: 106 });
  });

  it('stopka na špatné straně vstupu se nesimuluje', () => {
    expect(backtestStructuralTrail(bullBreakSeries(), ENTRY_TIME, 100.5, true, 105, undefined, 0.25)).toBeNull();
  });
});
