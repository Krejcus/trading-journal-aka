import { describe, expect, it } from 'vitest';
import {
  evaluateStrategySignal,
  findLatestSweep,
  oppositeLevelPrice,
  selectFvg,
  type StrategyFvgCandidate,
} from '../services/strategySignal';
import type { LiquidityLevel } from '../services/liquidityLevels';
import type { MarketCandle } from '../services/marketData';

const bar = (index: number, open: number, high: number, low: number, close: number): MarketCandle =>
  ({ time: 1_000 + index * 60, open, high, low, close, volume: 1 });

const level = (name: string, price: number, swept = false): LiquidityLevel =>
  ({ name, price, color: '#fff', width: 1, style: 'solid', startTime: 0, swept });

/**
 * Kanonická sekvence pro short: nájezd na ON H (100), dotek knotem, otočka,
 * zavíračka pod pivot low a v tom pohybu vzniknou medvědí mezery.
 *
 * Pullback na indexu 2 tam není pro parádu — vytváří pivot low (91.5), které
 * pak zavíračka na indexu 7 prorazí. Bez něj by v sérii nebyl žádný swing
 * a nebylo by co zlomit; monotónní nájezd zlom nikdy nevyrobí.
 */
const shortSetup = (): MarketCandle[] => [
  bar(0, 90, 92.5, 89.5, 92),
  bar(1, 92, 95.0, 93.0, 94.5),
  bar(2, 94.5, 95.2, 91.5, 92),
  bar(3, 92, 96.0, 92.0, 95.5),
  bar(4, 95.5, 98.5, 95.0, 98),
  bar(5, 98, 100.5, 97.5, 99),
  bar(6, 99, 99.2, 95.5, 96),
  bar(7, 96, 96.2, 91.0, 91.2),
  bar(8, 91.2, 91.5, 88.0, 88.5),
  bar(9, 88.5, 88.8, 86.0, 86.5),
  bar(10, 86.5, 87.0, 85.0, 85.5),
];

const levels = () => [level('ON H', 100), level('PDL', 80), level('ASIA L', 82)];

describe('findLatestSweep', () => {
  it('dotek knotem stačí, proražení closem se nevyžaduje', () => {
    const sweep = findLatestSweep(shortSetup(), levels(), 120);
    expect(sweep).toMatchObject({ level: 'ON H', price: 100, index: 5, direction: 'short' });
  });

  it('svíčka, která nad úrovní zavře, se za sweep nepovažuje', () => {
    const candles = [...shortSetup().slice(0, 5), bar(5, 98, 100.5, 97.5, 100.4)];
    expect(findLatestSweep(candles, levels(), 120)).toBeNull();
  });

  it('bere poslední sweep, ne první', () => {
    const candles = [...shortSetup(), bar(11, 86, 100.5, 85, 88)];
    expect(findLatestSweep(candles, levels(), 120)?.index).toBe(11);
  });

  it('starý sweep mimo okno se ignoruje', () => {
    expect(findLatestSweep(shortSetup(), levels(), 3)).toBeNull();
  });

  it('sweepovat jde libovolná úroveň, i VWAP nebo midpoint', () => {
    const other = [level('PD MID', 100)];
    expect(findLatestSweep(shortSetup(), other, 120)?.level).toBe('PD MID');
  });

  it('pohyblivé pásmo se testuje proti hodnotě v té svíčce', () => {
    const candles = shortSetup();
    // Pásmo leží na 100 jen ve svíčce sweepu, jinde mimo dosah.
    const points = candles.map((candle, index) => ({ time: candle.time, value: index === 5 ? 100 : 140 }));
    const sweep = findLatestSweep(candles, [], 120, [{ name: 'VWAP +2σ', points }]);
    expect(sweep).toMatchObject({ level: 'VWAP +2σ', index: 5, direction: 'short' });
  });

  it('pásmo, které se v dané svíčce nedotklo, sweep nedělá', () => {
    const candles = shortSetup();
    const points = candles.map(candle => ({ time: candle.time, value: 140 }));
    expect(findLatestSweep(candles, [], 120, [{ name: 'VWAP +2σ', points }])).toBeNull();
  });
});

describe('oppositeLevelPrice', () => {
  const sweep = { level: 'ON H', price: 100, time: 0, index: 5, direction: 'short' as const };

  it('pravidlo any bere nejbližší úroveň pod sweepem bez ohledu na sebrání', () => {
    const all = [level('PDL', 80), level('ASIA L', 82, true)];
    expect(oppositeLevelPrice(all, sweep, 'any')).toBe(82);
  });

  it('nearest-untapped sebrané úrovně přeskočí', () => {
    const all = [level('PDL', 80), level('ASIA L', 82, true)];
    expect(oppositeLevelPrice(all, sweep, 'nearest-untapped')).toBe(80);
  });

  it('mirror hledá párovou úroveň téže skupiny', () => {
    const all = [level('ON L', 88), level('PDL', 80)];
    expect(oppositeLevelPrice(all, sweep, 'mirror')).toBe(88);
  });
});

describe('evaluateStrategySignal', () => {
  it('projde celou sekvencí a vrátí vstup na hraně mezery', () => {
    const result = evaluateStrategySignal({ candles: shortSetup(), levels: levels() });
    expect(result.kind).toBe('signal');
    if (result.kind !== 'signal') return;
    expect(result.direction).toBe('short');
    expect(result.sweep.level).toBe('ON H');
    expect(result.candidates.length).toBeGreaterThan(0);
    // U shortu se vstupuje na spodní hraně a stop leží nad ní.
    expect(result.entry).toBe(result.selected.bottom);
    expect(result.stop).toBe(result.selected.top);
    expect(result.stop).toBeGreaterThan(result.entry);
  });

  it('bez sweepu se nic dál nepočítá', () => {
    const result = evaluateStrategySignal({
      candles: shortSetup(), levels: [level('ON H', 130), level('PDL', 40)],
    });
    expect(result).toMatchObject({ kind: 'rejected', reason: 'no-sweep' });
  });

  it('po sweepu bez zlomu struktury čeká', () => {
    const result = evaluateStrategySignal({
      candles: shortSetup().slice(0, 7), levels: levels(),
    });
    expect(result).toMatchObject({ kind: 'rejected', reason: 'no-structure-break' });
    if (result.kind !== 'rejected') return;
    // Sweep se přesto vrátí, ať má ověřovací režim co nakreslit.
    expect(result.sweep?.level).toBe('ON H');
  });

  it('trefení opačného levelu před zlomem setup zneškodní', () => {
    // Opačný level těsně pod sweepem — cena ho projde dřív, než zlom nastane.
    const result = evaluateStrategySignal({
      candles: shortSetup(), levels: [level('ON H', 100), level('PDL', 99)],
    });
    expect(result).toMatchObject({ kind: 'rejected', reason: 'opposite-level-first' });
  });

  it('bez mezery v otočce vstup není', () => {
    // Zlom nastane, ale každá svíčka překrývá rozsah té předminulé, takže se
    // žádná medvědí mezera neotevře.
    const candles = [
      ...shortSetup().slice(0, 6),
      bar(6, 99, 99.2, 96.0, 97.0),
      bar(7, 97, 97.6, 91.0, 91.2),
      bar(8, 91.2, 96.1, 90.0, 90.5),
      bar(9, 90.5, 91.2, 89.0, 89.5),
    ];
    const result = evaluateStrategySignal({ candles, levels: levels() });
    expect(result).toMatchObject({ kind: 'rejected', reason: 'no-fvg' });
  });

  it('vyhodnocuje jen z dat do kurzoru, nikdy dopředu', () => {
    const full = shortSetup();
    const early = evaluateStrategySignal({ candles: full.slice(0, 7), levels: levels() });
    const late = evaluateStrategySignal({ candles: full, levels: levels() });
    expect(early.kind).toBe('rejected');
    expect(late.kind).toBe('signal');
  });

  it('HTF kontext se měří, ale vstup neblokuje', () => {
    const withoutHtf = evaluateStrategySignal({ candles: shortSetup(), levels: levels() });
    const withHtf = evaluateStrategySignal({
      candles: shortSetup(), levels: levels(),
      candles5m: shortSetup(), candles15m: shortSetup(),
    });
    expect(withoutHtf.kind).toBe('signal');
    expect(withHtf.kind).toBe('signal');
    if (withHtf.kind !== 'signal') return;
    expect(withHtf.observations).toHaveProperty('htfStructure5m');
    expect(withHtf.observations).toHaveProperty('htfFvgBounce');
  });
});

describe('selectFvg', () => {
  const candidate = (partial: Partial<StrategyFvgCandidate>): StrategyFvgCandidate => ({
    order: 1, top: 96, bottom: 95, entryEdge: 95, stopEdge: 96,
    formedAt: 0, afterBreak: false, untouched: true, distanceFromPrice: 5,
    ...partial,
  });

  it('first-formed bere nejstarší, i když je dál od ceny', () => {
    const pool = [
      candidate({ order: 1, distanceFromPrice: 9 }),
      candidate({ order: 2, distanceFromPrice: 2 }),
    ];
    expect(selectFvg(pool, 'first-formed').order).toBe(1);
  });

  it('first-reached bere nejbližší ceně', () => {
    const pool = [
      candidate({ order: 1, distanceFromPrice: 9 }),
      candidate({ order: 2, distanceFromPrice: 2 }),
    ];
    expect(selectFvg(pool, 'first-reached').order).toBe(2);
  });

  it('dotčené mezery ustupují netknutým', () => {
    const pool = [
      candidate({ order: 1, untouched: false, distanceFromPrice: 1 }),
      candidate({ order: 2, untouched: true, distanceFromPrice: 8 }),
    ];
    expect(selectFvg(pool, 'first-formed').order).toBe(2);
  });
});
