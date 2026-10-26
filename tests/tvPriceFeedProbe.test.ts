import { describe, expect, it } from 'vitest';
import {
  analyzeChanges,
  classifyFeed,
  percentile,
  simulateSampling,
  TV_FAST_PRICE_EXPRESSION,
  TV_CHART_META_EXPRESSION,
  tradovateContractSymbol,
} from '../scripts/market-data/tvPriceFeedProbe';

const points = (pairs: Array<[number, number]>) => pairs.map(([at, price]) => ({ at, price }));

describe('TradingView price probe — analysis (pure)', () => {
  it('percentile uses nearest rank and ignores order', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([7], 99)).toBe(7);
  });

  it('counts price changes, gaps and busiest second from a fine sample', () => {
    // 100ms vzorky: změny v 200, 300, 1500 ms.
    const series = points([[0, 10], [100, 10], [200, 11], [300, 12], [400, 12], [1_500, 11], [2_000, 11]]);
    const summary = analyzeChanges(series, []);
    expect(summary.changes).toBe(3);
    expect(summary.durationSec).toBe(2);
    expect(summary.changesPerSec).toBe(1.5);
    expect(summary.busiestSecond).toBe(2);
    expect(summary.gapP50Ms).toBe(100);
    expect(summary.gapMaxMs).toBe(1_200);
  });

  it('simulates coarser sampling: fewer messages, intermediate ticks collapsed, lag until next read', () => {
    const series = points([[0, 10], [100, 11], [200, 12], [300, 12], [600, 13], [1_000, 13]]);
    const every500 = simulateSampling(series, 500);
    // Čtení v 500 ms vidí 12 (sloučí 11), v 1000 ms vidí 13.
    expect(every500.updates).toBe(2);
    expect(every500.collapsed).toBe(1);
    // Změna ve 100 → uvidí se v 500 (400 ms), ve 200 → 300 ms, v 600 → 400 ms.
    expect(every500.meanLagMs).toBeCloseTo((400 + 300 + 400) / 3, 1);
    expect(every500.updatesPerSec).toBe(2);
    expect(every500.updatesPerHour).toBe(7_200);
    // Čtení stejně jemné jako vzorky nic neslučuje a nezpožďuje.
    const every100 = simulateSampling(series, 100);
    expect(every100.updates).toBe(3);
    expect(every100.collapsed).toBe(0);
    expect(every100.meanLagMs).toBe(0);
  });

  it('a price that returns within one interval produces no message', () => {
    const series = points([[0, 10], [100, 11], [200, 10], [500, 10]]);
    const every500 = simulateSampling(series, 500);
    expect(every500.updates).toBe(0);
    expect(every500.collapsed).toBe(2);
  });

  it('classifies realtime vs delayed TradingView data', () => {
    const now = Date.UTC(2026, 9, 26, 6, 15, 30);
    const minute = Math.floor(now / 60_000) * 60;
    const base = { fullName: 'CME_MINI:MNQ1!', currentSession: 'market', interval: '1', nowMs: now };
    expect(classifyFeed({ ...base, updateMode: 'streaming', barTimeSec: minute }).verdict).toBe('realtime');
    const delayed = classifyFeed({ ...base, updateMode: 'delayed_streaming_600', barTimeSec: minute - 600 });
    expect(delayed.verdict).toBe('delayed');
    expect(delayed.delaySec).toBe(600);
    expect(delayed.barLagPeriods).toBe(10);
    expect(classifyFeed({ ...base, fullName: 'CME_MINI_DL:MNQ1!', updateMode: 'streaming', barTimeSec: minute }).verdict).toBe('delayed');
    expect(classifyFeed({ ...base, updateMode: 'endofday', barTimeSec: minute }).verdict).toBe('delayed');
    // Streaming, ale svíčka 5 minut pozadu = stojí (ne realtime).
    expect(classifyFeed({ ...base, updateMode: 'streaming', barTimeSec: minute - 300 }).verdict).toBe('stale');
    // Denní pauza CME: mimo session se zpoždění neodvozuje.
    expect(classifyFeed({ ...base, updateMode: 'streaming', currentSession: 'out_of_session', barTimeSec: minute - 1_800 }).verdict)
      .toBe('market-closed');
    // 5m graf: svíčka z aktuální pětiminutovky je v pořádku.
    expect(classifyFeed({ ...base, interval: '5', updateMode: 'streaming', barTimeSec: Math.floor(now / 300_000) * 300 }).verdict)
      .toBe('realtime');
  });

  it('maps the TradingView front contract to the Tradovate position symbol', () => {
    expect(tradovateContractSymbol('MNQZ2026')).toBe('MNQZ6');
    expect(tradovateContractSymbol('NQH2027')).toBe('NQH7');
    expect(tradovateContractSymbol('MNQ1!')).toBeNull();
    expect(tradovateContractSymbol(null)).toBeNull();
  });

  it('CDP expressions stay read-only (no navigation, symbol or timeframe changes)', () => {
    for (const expression of [TV_FAST_PRICE_EXPRESSION, TV_CHART_META_EXPRESSION]) {
      expect(expression).not.toMatch(/setSymbol|setResolution|setInterval\(|navigate|location|executeAction|click\(|dispatchEvent|localStorage|fetch\(/);
    }
  });
});
