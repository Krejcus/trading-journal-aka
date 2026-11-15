import { describe, expect, it } from 'vitest';
import { backtestAddOns } from '../services/backtestIntel';
import { readBacktestStructure } from '../services/backtestStructureLevels';
import type { MarketCandle, MarketStructureEvent } from '../services/marketDataCalculations';
import type { BacktestClosedTrade, BacktestOrderEvent } from '../services/backtestTypes';

const bar = (time: number, open: number, high: number, low: number, close: number): MarketCandle => ({ time, open, high, low, close, volume: 1 });

/** CHoCH (1–4) s mezerou 101–103, pak BoS (5–8) s mezerou 106–108,5 a návrat na její hranu. */
const series = (pullbackLow: number) => [
  bar(1, 100, 101, 99, 100.5),
  bar(2, 100.5, 105, 100.5, 104.5),
  bar(3, 104, 104.5, 103, 104),
  bar(4, 104, 106, 103.5, 105.5),
  bar(5, 105.5, 106, pullbackLow, 105),
  bar(6, 105, 111, 105, 110.5),
  bar(7, 110, 111.5, 108.5, 111),
  bar(8, 111, 112, 110, 111.5),
  bar(9, 111.5, 111.5, 109, 109.5),
];
const events = (pullbackLow: number): MarketStructureEvent[] => [
  { type: 'CHoCH', direction: 'bullish', pivotTime: 3, breakTime: 4, price: 104.5, labelPrice: 104.75, protectedPrice: 99, protectedTime: 1 },
  { type: 'BOS', direction: 'bullish', pivotTime: 7, breakTime: 8, price: 111.5, labelPrice: 111.75, protectedPrice: pullbackLow, protectedTime: 5 },
];
const read = (pullbackLow: number) => readBacktestStructure(series(pullbackLow), 10, 108.5, true, 0.25, events(pullbackLow));

describe('otevřená FVG z dřívějších zlomů téže série', () => {
  it('vstup po druhém zlomu vidí netknuté FVG z prvního', () => {
    const structure = read(104.5);
    expect(structure).toMatchObject({ structureType: 'BoS', structureOrder: 2, entryFvg: { proximal: 108.5, fvgCountInImpulse: 1 } });
    expect(structure.priorOpenFvgs).toEqual([
      { parentOrder: 1, parentType: 'CHoCH', bornTime: 3, top: 103, bottom: 101, tested: false, distanceTicks: 22 },
    ]);
  });

  it('dotyk bližší hrany FVG jen označí jako testované', () => {
    expect(read(102.5).priorOpenFvgs).toMatchObject([{ parentOrder: 1, tested: true }]);
  });

  it('vyplněné FVG se nepočítá', () => {
    expect(read(100.5).priorOpenFvgs).toEqual([]);
  });

  it('FVG vlastního impulsu vstupu mezi dřívější nepatří', () => {
    expect(read(104.5).priorOpenFvgs.some(zone => zone.parentOrder === 2)).toBe(false);
  });

  it('bez vstupního FVG bere všechny zlomy poslední série', () => {
    const structure = readBacktestStructure(series(104.5), 10, 110.25, true, 0.25, events(104.5));
    expect(structure.entryFvg).toBeNull();
    expect(structure.priorOpenFvgs.map(zone => zone.parentOrder)).toEqual([1, 2]);
  });
});

describe('přikoupení do pozice', () => {
  const trade = { id: 't', runId: 'r', positionId: 'p', instrument: 'MNQ', direction: 'Short', quantity: 29, entryPrice: 25103, exitPrice: 25000,
    entryTime: 100, exitTime: 400, grossPnl: 0, commission: 0, pnl: 0, reason: 'stop-loss' } as BacktestClosedTrade;
  const fill = (id: string, marketTime: number, extra: Partial<BacktestOrderEvent>): BacktestOrderEvent => ({
    id, runId: 'r', orderId: id, kind: 'filled', instrument: 'MNQ', marketTime, side: 'sell', positionId: 'p', closedQuantity: 0, ...extra,
  });
  const context = {
    entryMap: (at: BacktestClosedTrade) => ({ structureType: 'BoS', structureOrder: at.entryTime === 250 ? 3 : 1, structureBarsAgo: 2,
      odrazLevels: ['VWAP'], entryFvgValid: true, priorFvgs: at.entryTime === 250 ? [{}, {}] : [] }),
    entryContext: (at: BacktestClosedTrade) => ({ vwapDistSigma: at.entryPrice === 25076.25 ? -1.1 : 0,
      ctx: { s1: { dir: 'bear', type: 'BoS', ageMin: 2, run: 3 }, s5: null, s15: null }, htfFvg: { inside5: {}, inside15: null, inside60: null } }),
  } as unknown as Parameters<typeof backtestAddOns>[2];

  it('spočítá vstupy a přikoupení popíše k jeho vlastnímu času a ceně', () => {
    const result = backtestAddOns(trade, [
      fill('a', 100, { price: 25128.75, quantity: 15 }),
      fill('b', 250, { price: 25076.25, quantity: 14 }),
      fill('x', 400, { side: 'buy', price: 25000, quantity: 29, positionId: undefined, closedPositionId: 'p', closedQuantity: 29 }),
      fill('other', 260, { price: 1, quantity: 1, positionId: 'jiná' }),
    ], context);
    expect(result.entryCount).toBe(2);
    expect(result.addOns).toEqual([{
      time: 250, price: 25076.25, quantity: 14, structureType: 'BoS', structureOrder: 3, structureBarsAgo: 2,
      reactionLevels: ['VWAP'], entryFvgValid: true, priorFvgs: 2, vwapDistSigma: -1.1,
      s1: { dir: 'bear', type: 'BoS', ageMin: 2, run: 3 }, s5: null, s15: null, inFvg5: true, inFvg15: false, inFvg60: false,
    }]);
  });

  it('jediný vstup nebo starý záznam bez vazby na pozici = žádné přikoupení', () => {
    expect(backtestAddOns(trade, [fill('a', 100, { price: 25128.75, quantity: 15 })], context)).toEqual({ entryCount: 1, addOns: [] });
    expect(backtestAddOns({ ...trade, positionId: undefined }, [], context)).toEqual({ entryCount: 1, addOns: [] });
  });
});
