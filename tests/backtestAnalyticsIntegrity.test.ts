import { describe, expect, it } from 'vitest';
import { createBacktestOrder, createBacktestRuntime, enqueueBacktestOrder, executeBacktestMarketOrder, processBacktestCandle } from '../services/backtestEngine';
import { DEFAULT_BACKTEST_CONFIG, type BacktestClosedTrade, type BacktestRuntimeState } from '../services/backtestTypes';
import { backtestTradeIntel, backtestClosedTradeToTrade, backtestExecutionPath, backtestExcursion, backtestCounterfactual, simulateBracket } from '../services/backtestIntel';
import { backtestStructuralTrail } from '../services/backtestStructureLevels';
import { createBacktestContextSource } from '../services/backtestEntryContext';
const T = Date.UTC(2026, 8, 4, 12) / 1000;
const config = { ...DEFAULT_BACKTEST_CONFIG, commissionPerSide: { MNQ: 0, NQ: 0 }, slippageTicks: { MNQ: 0, NQ: 0 } };
const bar = (index: number, open: number, high = open, low = open, close = open) => ({ time: T + index * 60, open, high, low, close, volume: 100 });
function market(runtime: BacktestRuntimeState, side: 'buy' | 'sell', quantity: number, quote: ReturnType<typeof bar>, stopLoss?: number, reduceOnly = false) {
  const order = createBacktestOrder({ runId: 'r', instrument: 'MNQ', side, type: 'market', quantity, now: quote.time, stopLoss, reduceOnly });
  return executeBacktestMarketOrder(enqueueBacktestOrder(runtime, order), order.id, quote, config);
}
function trade(long = true): BacktestClosedTrade { return { id: 't', runId: 'r', instrument: 'MNQ', direction: long ? 'Long' : 'Short', quantity: 1, entryPrice: 100, exitPrice: long ? 102 : 98, entryTime: T, exitTime: T + 60, grossPnl: 4, commission: 0, pnl: 4, reason: 'manual', initialStopLoss: long ? 99 : 101, initialTakeProfit: long ? 102 : 98, riskAmount: 2 }; }
const intel = (value: BacktestClosedTrade) => backtestTradeIntel(value, { candles: [], orderEvents: [], timeZone: 'UTC' });

describe('quantity-aware gross open P&L excursion', () => {
  for (const long of [true, false]) {
    const side = long ? 'buy' : 'sell'; const opposite = long ? 'sell' : 'buy';
    const mirror = (p: number) => long ? p : 200 - p;
    const quote = (i: number, p: number) => bar(i, mirror(p));
    it(`${long ? 'long' : 'short'} does not apply added quantity to earlier extrema`, () => {
      let state = market(createBacktestRuntime(10000), side, 1, quote(0, 100));
      state = processBacktestCandle(state, 'r', 'MNQ', quote(1, 120), config);
      state = processBacktestCandle(state, 'r', 'MNQ', quote(2, 80), config);
      state = market(state, side, 1, quote(2, 80));
      state = market(state, opposite, 2, quote(3, 90), undefined, true);
      expect(intel(state.closedTrades[0])).toMatchObject({ runUp: 40, drawdown: 40 });
      expect(state.closedTrades[0]).toMatchObject({ pnl: 0, mfeAmount: 40, maeAmount: 40 });
    });
    it(`${long ? 'long' : 'short'} adding at a favorable price never manufactures past drawdown`, () => {
      let state = market(createBacktestRuntime(10000), side, 1, quote(0, 100));
      state = processBacktestCandle(state, 'r', 'MNQ', quote(1, 120), config);
      state = market(state, side, 1, quote(1, 120));
      state = market(state, opposite, 2, quote(1, 120), undefined, true);
      expect(intel(state.closedTrades[0])).toMatchObject({ runUp: 40, drawdown: 0 });
    });
    it(`${long ? 'long' : 'short'} allocates earlier cash excursion across partials`, () => {
      let state = market(createBacktestRuntime(10000), side, 2, quote(0, 100));
      state = processBacktestCandle(state, 'r', 'MNQ', quote(1, 110), config);
      state = market(state, opposite, 1, quote(1, 110), undefined, true);
      state = market(state, opposite, 1, quote(1, 110), undefined, true);
      expect(state.closedTrades.map(value => intel(value).runUp)).toEqual([20, 20]);
      expect(state.closedTrades.reduce((sum, value) => sum + value.pnl, 0)).toBe(40);
    });
  }
});

describe('analytics share causal execution and data coverage', () => {
  for (const long of [true, false]) {
    it(`${long ? 'long' : 'short'} stop gap is executed at open, and costs agree with the engine`, () => {
      const entry = market(createBacktestRuntime(10000), long ? 'buy' : 'sell', 1, bar(0, 100), long ? 99 : 101);
      const gap = long ? bar(1, 95, 96, 94, 95) : bar(1, 105, 106, 104, 105);
      const costs = { ...config, commissionPerSide: { MNQ: 1, NQ: 1 }, slippageTicks: { MNQ: 2, NQ: 2 } };
      const state = processBacktestCandle(entry, 'r', 'MNQ', gap, costs);
      const closed = state.closedTrades[0];
      const cf = backtestCounterfactual([gap], closed, [], { slippageTicks: 2 });
      expect(cf.variants?.find(value => value.label === 'initial')?.netRealizedR).toBeCloseTo(closed.pnl / Number(closed.riskAmount));
      const path = backtestExecutionPath([gap], closed, { slippageTicks: 2 });
      expect(path.maxAdverseR).toBe(5.5);
      expect(path.candleStops?.firstComplete?.netRealizedR).toBeCloseTo(closed.pnl / Number(closed.riskAmount));
    });
    it(`${long ? 'long' : 'short'} favorable opening target takes priority over later stop`, () => {
      const value = trade(long); const candle = long ? bar(1, 104, 105, 98, 99) : bar(1, 96, 102, 95, 101);
      const result = simulateBracket([candle], { entryPrice: 100, long, stop: value.initialStopLoss, target: value.initialTakeProfit });
      expect(result).toMatchObject({ outcome: 'tp', exitPrice: candle.open, ambiguous: false });
    });
    it(`${long ? 'long' : 'short'} cutoff ignores the cutoff bar wick in every variant`, () => {
      const options = { flatTimeZone: 'UTC', flatByMinute: 12 * 60 + 2 };
      const candles = [bar(-1, 100), bar(0, 100), bar(1, 100), long ? bar(2, 100, 110, 100, 110) : bar(2, 100, 100, 90, 90)];
      const cf = backtestCounterfactual(candles, trade(long), [{ label: 'level', price: long ? 102 : 98 }], options);
      expect(cf.variants?.every(value => value.realizedR === 0 && value.outcome === 'cutoff' && value.complete)).toBe(true);
      expect(cf.tpTargets?.[0]).toMatchObject({ outcome: 'CUTOFF', realizedR: 0 });
      expect(backtestExcursion(candles, trade(long), { timeZone: 'UTC', ...options })).toMatchObject({ mfePotentialR: 0, complete: true, stopReason: 'cutoff' });
      const trail = backtestStructuralTrail(candles, T, 100, long, long ? 99 : 101, undefined, 0.25, { cutoffTime: T + 120 });
      expect(trail).toMatchObject({ reason: 'cutoff', exit: 100, realizedR: 0, complete: true });
    });
  }
  it('a missing initial hour cannot create any completed win or reached level', () => {
    const candles = [bar(60, 100, 110, 100, 110)];
    expect(backtestExecutionPath(candles, trade())).toMatchObject({ complete: false, hasGaps: true, available: false });
    expect(backtestCounterfactual(candles, trade())).toMatchObject({ complete: false, hasGaps: true, available: false });
    expect(backtestExcursion(candles, trade(), { timeZone: 'UTC' })).toMatchObject({ complete: false, hasGaps: true, available: false });
  });
  it('a later gap stops only unfinished paths, preserving a proven earlier exit', () => {
    const candles = [bar(1, 100, 103, 100, 102), bar(10, 102, 110, 102, 110)];
    expect(backtestExecutionPath(candles, trade())).toMatchObject({ complete: true, hasGaps: false, terminal: 'tp' });
    const cf = backtestCounterfactual(candles, trade());
    expect(cf.variants?.find(value => value.label === 'initial')).toMatchObject({ complete: true });
    expect(cf.variants?.find(value => value.label === 'no_target')).toMatchObject({ complete: false });
  });
  it('end of supplied data is pending, not survived-to-cutoff', () => {
    const mapped = backtestClosedTradeToTrade(trade(), { accountId: 'a', timeZone: 'UTC', orderEvents: [], candles: [bar(1, 100, 101, 100, 101)] });
    expect(mapped.excursionComplete).toBe(false);
    expect(mapped.excursion).toMatchObject({ stopReason: 'end', complete: false });
    expect(mapped.excursion?.survivedToCutoff).toBeUndefined();
  });
  it('changing hidden future data leaves all mapped analytics unchanged, including a cached full context', () => {
    const known = [bar(-1, 100), bar(0, 100), bar(1, 100, 101, 100, 101)];
    const future = [...known, bar(2, 101, 120, 98, 119)];
    const options = { accountId: 'a', timeZone: 'UTC', orderEvents: [], replayHorizonTime: T + 60 };
    const before = backtestClosedTradeToTrade(trade(), { ...options, candles: known });
    const after = backtestClosedTradeToTrade(trade(), { ...options, candles: future, contextSource: createBacktestContextSource({ candles: future, timeZone: 'UTC' }) });
    expect(after).toEqual(before);
    expect(after.executionPath?.bars?.every(value => value.time <= T + 60)).toBe(true);
  });
  it('uncertain favorable wick stays an explicit upper bound, never a proven reached target', () => {
    const candle = bar(1, 100, 110, 98, 98);
    const result = backtestExcursion([candle], trade(), { timeZone: 'UTC' });
    expect(result).toMatchObject({ mfePotentialR: 0, mfePotentialUpperR: 10, ambiguous: true, complete: true });
    expect(result.levels?.every(level => !level.reached && level.possible)).toBe(true);
    expect(backtestCounterfactual([candle], trade()).variants?.find(value => value.label === 'initial')).toMatchObject({ ambiguous: true });
  });
});

describe('all alternative placement families include the same recorded costs', () => {
  for (const long of [true, false]) it(`${long ? 'long' : 'short'} SL, structural trail, fixed and dynamic targets use gap slippage and net R`, () => {
    const prices = [[100,100.5,99.5,100],[100,102,99.8,101.5],[101.5,101.8,100.5,101],[101,101.2,98,98.5],[98.5,99.5,98.2,99.2],[99.2,103.5,99,103],[103,103.2,100.5,100.8],[100.5,100.5,100.5,100.5],[95,96,94,95]];
    const candles = prices.map(([o,h,l,c],i) => long ? bar(i-7,o,h,l,c) : bar(i-7,200-o,200-l,200-h,200-c));
    const value = { ...trade(long), entryPrice: long ? 100.5 : 99.5, initialStopLoss: long ? 98 : 102, initialTakeProfit: long ? 104 : 96, commission: 2 };
    const result = backtestCounterfactual(candles,value,[{label:'target',price:long?104:96}],{slippageTicks:2,dynamicTargets:[{label:'VWAP',kind:'dynamic',points:[{time:T-60,price:long?104:96}]}]});
    for (const variant of [result.swing,result.ote,result.fvg]) {
      expect(variant?.valid).toBe(true);
      const risk = Math.abs(value.entryPrice - Number(variant?.sl));
      expect(variant?.netRealizedR).toBeCloseTo(-7/risk);
      expect(variant?.trail?.netRealizedR).toBeCloseTo(-7/risk);
      expect(variant?.trail).toMatchObject({complete:true,ambiguous:false});
    }
    expect(result.tpTargets).toHaveLength(2);
    for (const target of result.tpTargets ?? []) expect(target.netRealizedR).toBeCloseTo(-7/2.5);
  });
  it('a gap after the requested thirty-minute path does not invalidate the completed window', () => {
    const candles = [...Array.from({length:30},(_,i)=>bar(i+1,100,100.1,99.9,100)),bar(60,100)];
    expect(backtestExecutionPath(candles,trade())).toMatchObject({complete:true,hasGaps:false});
  });
});

for (const long of [true, false]) it(`${long ? 'long' : 'short'} breakeven stop followed by a gap is a loss, not breakeven`, () => {
  const candles = long ? [bar(1,100,101,100,101),bar(2,95,96,94,95)] : [bar(1,100,100,99,99),bar(2,105,106,104,105)];
  expect(simulateBracket(candles,{long,entryPrice:100,stop:long?99:101,breakevenAfterR:1,riskDistance:1})).toMatchObject({outcome:'sl',exitPrice:long?95:105});
});
