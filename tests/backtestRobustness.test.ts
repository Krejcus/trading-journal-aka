import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Trade } from '../types';
import type { BacktestRun } from '../services/backtestTypes';
import { createBacktestRuntime } from '../services/backtestEngine';
import { buildBacktestPositionEvidence, computeBacktestRobustness, type BacktestPositionEvidence,
  type BacktestRobustnessOptions } from '../services/backtestRobustness';
import BacktestRobustnessPanel from '../components/BacktestRobustnessPanel';

const START = Date.UTC(2026, 0, 5, 10);
function trade(id: string, pnl: number, timestamp = START, patch: Partial<Trade> = {}): Trade {
  return { id, pnl, timestamp, accountId: 'account', backtestRunId: 'run', instrument: 'MNQ', signal: 'test',
    date: new Date(timestamp).toISOString(), direction: 'Long', runUp: 0, drawdown: 0, duration: '1m', durationMinutes: 1,
    ...patch };
}
function evidence(positionId: string, tradeIds: string[], patch: Partial<BacktestPositionEvidence> = {}): BacktestPositionEvidence {
  return { positionId, expectedTradeIds: tradeIds, accountId: 'account', runId: 'run', closed: true, ...patch };
}
function options(positionEvidence: readonly BacktestPositionEvidence[], patch: Partial<BacktestRobustnessOptions> = {}): BacktestRobustnessOptions {
  return { timeZone: 'UTC', dayStartMinute: 0, currencyByAccount: { account: 'USD' }, positionEvidence, ...patch };
}
function independent(pnls: number[], days = false) {
  const trades = pnls.map((pnl, i) => trade(String(i), pnl, START + i * (days ? 86_400_000 : 60_000)));
  return { trades, options: options(trades.map(row => evidence(`p-${row.id}`, [String(row.id)]))) };
}
function sample() {
  const trades = [trade('a1', 150), trade('a2', -60, START + 60_000), trade('b', 80, START + 120_000),
    trade('c', -40, START + 86_400_000), trade('d', 50, START + 2 * 86_400_000), trade('e', -20, START + 2 * 86_400_000 + 60_000)];
  return { trades, options: options([evidence('a', ['a1', 'a2']), ...['b', 'c', 'd', 'e'].map(key => evidence(key, [key]))]) };
}
const bootstrap = { unit: 'position' as const, blockLength: 2, repetitions: 500, seed: 42 };

describe('exceptional-position and day sensitivity', () => {
  it('retains a net baseline, merges partial exits and removes whole positive positions', () => {
    const data = sample(); const before = structuredClone(data);
    const result = computeBacktestRobustness(data.trades, data.options);
    expect(result.baseline).toMatchObject({ positionN: 5, tradeN: 6, netPnl: 160, expectancy: 32, maxDrawdown: 60, removedN: 0, retainedN: 5 });
    expect(result.baseline!.profitFactor).toBeCloseTo(220 / 60);
    expect(result.positions.find(position => position.positionId === 'a')).toMatchObject({ tradeIds: ['a1', 'a2'], netPnl: 90 });
    const top1 = result.scenarios.find(row => row.id === 'positions-1')!;
    expect(top1).toMatchObject({ removedN: 1, retainedN: 4, netPnl: 70, expectancy: 17.5, maxDrawdown: 40, removedTradeIds: ['a1', 'a2'] });
    expect(top1.removedPositionIds).toEqual([JSON.stringify(['account', 'run', 'a'])]);
    const top3 = result.scenarios.find(row => row.id === 'positions-3')!;
    expect(top3).toMatchObject({ netPnl: -60, removedN: 3, retainedN: 2, profitFactor: 0 });
    expect(result.scenarios.find(row => row.id === 'positions-5')).toMatchObject({ netPnl: -60, removedN: 3, retainedN: 2 });
    expect(data).toEqual(before);
  });
  it('removes whole best days including their losing positions, independently from baseline', () => {
    const data = sample(); const result = computeBacktestRobustness(data.trades, data.options);
    expect(result.scenarios.find(row => row.id === 'days-1')).toMatchObject({ removedUnitIds: ['2026-01-05'], removedTradeIds: ['a1', 'a2', 'b'], removedN: 2, retainedN: 3, netPnl: -10 });
    expect(result.scenarios.find(row => row.id === 'days-3')).toMatchObject({ removedUnitIds: ['2026-01-05', '2026-01-07'], removedN: 4, retainedN: 1, netPnl: -40 });
    expect(result.baseline!.netPnl).toBe(160);
  });
  it('uses pnl after costs, never outcome/BE labels or a second fee subtraction', () => {
    const data = independent([-5, 9]); data.trades[0].isBE = true; data.trades[0].outcome = 'Win';
    expect(computeBacktestRobustness(data.trades, data.options).baseline).toMatchObject({ netPnl: 4, expectancy: 2, profitFactor: 1.8, maxDrawdown: 5 });
  });
  it('does not remove losses when fewer than the requested number of profits exist', () => {
    const data = independent([-10, -20, 0]); const result = computeBacktestRobustness(data.trades, data.options);
    for (const scenario of result.scenarios) expect(scenario).toMatchObject({ removedN: 0, retainedN: 3, netPnl: -30 });
  });
  it('distinguishes no loss from empty/zero-result profit factor', () => {
    for (const [pnls, state] of [[[10, 20], 'no-losses'], [[0, 0], 'no-results']] as const) {
      const data = independent([...pnls]); expect(computeBacktestRobustness(data.trades, data.options).baseline).toMatchObject({ profitFactor: null, profitFactorState: state });
    }
  });
  it('groups simultaneous exits into one ledger event rather than inventing an ID-based drawdown', () => {
    const data = independent([-10, 20]); data.trades[1].timestamp = data.trades[0].timestamp;
    expect(computeBacktestRobustness(data.trades, data.options).baseline!.maxDrawdown).toBe(0);
  });
  it('is invariant to input ordering, including deterministic profit ties', () => {
    const data = independent([10, -5, 10, -2], true);
    const original = computeBacktestRobustness(data.trades, { ...data.options, bootstrap });
    const reversed = computeBacktestRobustness([...data.trades].reverse(), { ...data.options, positionEvidence: [...data.options.positionEvidence!].reverse(), bootstrap });
    expect(reversed).toEqual(original);
  });
});

describe('identity, full selection, currencies and trading days', () => {
  it('requires all partial exits and excludes the entire selected remainder of an incomplete position', () => {
    const data = sample(); const result = computeBacktestRobustness(data.trades.filter(row => row.id !== 'a1'), data.options);
    expect(result.exclusions).toContainEqual({ tradeId: 'a2', accountId: 'account', reason: 'incomplete-position-selection' });
    expect(result.positions.map(position => position.positionId)).not.toContain('a');
    expect(result.baseline!.netPnl).toBe(70);
  });
  it('does not invent legacy identity or treat an open position partial as a closed position', () => {
    const data = sample();
    const result = computeBacktestRobustness(data.trades, options([evidence('a', ['a1', 'a2'], { closed: false })]));
    expect(result.status).toBe('empty');
    expect(result.exclusions.filter(row => row.reason === 'open-position')).toHaveLength(2);
    expect(result.exclusions.filter(row => row.reason === 'missing-identity')).toHaveLength(4);
    expect(result.excludedN).toBe(6);
  });
  it('rejects ambiguous evidence and duplicate input rows without double-counting any position', () => {
    const data = sample();
    const result = computeBacktestRobustness([...data.trades, data.trades[0]], data.options);
    expect(result.exclusions.filter(row => row.reason === 'duplicate-trade')).toHaveLength(2);
    expect(result.exclusions).toContainEqual({ tradeId: 'a2', accountId: 'account', reason: 'invalid-position-member' });
    const ambiguous = computeBacktestRobustness(data.trades, options([evidence('a', ['a1', 'a2']), evidence('other', ['a1'])]));
    expect(ambiguous.exclusions).toContainEqual({ tradeId: 'a1', accountId: 'account', reason: 'ambiguous-identity' });
    expect(ambiguous.positions).toHaveLength(0);
  });
  it('rejects disjoint competing definitions for one position', () => {
    const rows = [trade('a', 100), trade('c', -50)];
    const result = computeBacktestRobustness(rows, options([evidence('p', ['a', 'b']), evidence('p', ['c'])]));
    expect(result.status).toBe('empty'); expect(result.exclusions.every(row => row.reason === 'ambiguous-identity')).toBe(true);
  });
  it('cannot merge equal position IDs from different replay sessions', () => {
    const rows = [trade('a', 10), trade('b', -5, START + 60_000, { backtestRunId: 'run2' })];
    const result = computeBacktestRobustness(rows, options([evidence('same', ['a']), evidence('same', ['b'], { runId: 'run2' })]));
    expect(result.positions).toHaveLength(2); expect(new Set(result.positions.map(position => position.key)).size).toBe(2);
    expect(result.warnings.some(warning => warning.includes('více replay'))).toBe(true);
  });
  it('blocks a mixed-currency aggregate and exposes unknown-currency exclusions', () => {
    const rows = [trade('a', 10), trade('b', 100, START + 60_000, { accountId: 'eur' })];
    const proof = [evidence('a', ['a']), evidence('b', ['b'], { accountId: 'eur' })];
    const mixed = computeBacktestRobustness(rows, options(proof, { currencyByAccount: { account: 'USD', eur: 'EUR' }, bootstrap }));
    expect(mixed).toMatchObject({ status: 'mixed-currency', currency: null, currencies: ['EUR', 'USD'], baseline: null, bootstrap: null, scenarios: [] });
    const unknown = computeBacktestRobustness(rows, options(proof));
    expect(unknown.exclusions).toContainEqual({ tradeId: 'b', accountId: 'eur', reason: 'unknown-currency' });
    expect(unknown.baseline!.netPnl).toBe(10);
  });
  it.each([NaN, Infinity])('invalid member pnl %s cannot silently turn a partial position profitable', pnl => {
    const rows = [trade('a', 100), trade('b', pnl, START + 1)];
    const result = computeBacktestRobustness(rows, options([evidence('p', ['a', 'b'])]));
    expect(result.status).toBe('empty'); expect(result.excludedN).toBe(2);
  });
  it('uses an explicit local session boundary through DST, labels the start date and groups whole positions by final exit', () => {
    const rows = [trade('early', 10, Date.parse('2026-03-08T08:30:00Z')), trade('evening', 20, Date.parse('2026-03-08T22:30:00Z'))];
    const result = computeBacktestRobustness(rows, options([evidence('p1', ['early']), evidence('p2', ['evening'])], { timeZone: 'America/New_York', dayStartMinute: 18 * 60 }));
    expect(result.positions.map(position => position.day)).toEqual(['2026-03-07', '2026-03-08']);
    const grouped = computeBacktestRobustness(rows, options([evidence('p', ['early', 'evening'])], { timeZone: 'America/New_York', dayStartMinute: 18 * 60 }));
    expect(grouped.positions[0]).toMatchObject({ day: '2026-03-08', netPnl: 30 });
  });
  it('handles the repeated autumn hour by local date, not a fixed UTC offset', () => {
    const rows = [trade('early', 10, Date.parse('2026-11-01T05:30:00Z')), trade('late', 20, Date.parse('2026-11-01T06:30:00Z'))];
    const result = computeBacktestRobustness(rows, options([evidence('p1', ['early']), evidence('p2', ['late'])], { timeZone: 'America/New_York', dayStartMinute: 120 }));
    expect(result.positions.map(position => position.day)).toEqual(['2026-10-31', '2026-10-31']);
  });
  it('validates time zone, trading-day boundary and bootstrap settings', () => {
    const data = independent([1, -1, 1, -1]);
    for (const patch of [{ timeZone: 'not-a-zone' }, { dayStartMinute: -1 }, { bootstrap: { ...bootstrap, seed: NaN } },
      { bootstrap: { ...bootstrap, repetitions: 0 } }, { bootstrap: { ...bootstrap, blockLength: 1.5 } }, { bootstrap: { ...bootstrap, confidenceLevel: 1 } }]) {
      expect(() => computeBacktestRobustness(data.trades, { ...data.options, ...patch })).toThrow();
    }
  });
});

describe('circular block bootstrap', () => {
  it('is deterministic for a seed and preserves adjacent outcomes inside length-two blocks', () => {
    const data = independent([10, -10, 10, -10]);
    const block = computeBacktestRobustness(data.trades, { ...data.options, bootstrap }).bootstrap!;
    expect(block).toMatchObject({ status: 'ready', unitN: 4, sourceBlockN: 4, drawnBlocksPerReplication: 2, seed: 42,
      sampledPositionN: { min: 4, max: 4 }, intervals: { netPnl: { low: 0, high: 0 }, expectancy: { low: 0, high: 0 }, profitFactor: { low: 1, high: 1 } } });
    expect(computeBacktestRobustness(data.trades, { ...data.options, bootstrap }).bootstrap).toEqual(block);
    const individual = computeBacktestRobustness(data.trades, { ...data.options, bootstrap: { ...bootstrap, blockLength: 1 } }).bootstrap!;
    expect(individual.intervals!.netPnl.low!).toBeLessThan(0); expect(individual.intervals!.netPnl.high!).toBeGreaterThan(0);
  });
  it('partial slicing does not increase position units or change position bootstrap intervals', () => {
    const data = independent([10, -5, 20, -10]);
    const whole = computeBacktestRobustness(data.trades, { ...data.options, bootstrap });
    const sliced = computeBacktestRobustness([trade('slice', 6, START - 60_000), ...data.trades.map(row => row.id === '0' ? { ...row, pnl: 4 } : row)], {
      ...data.options, positionEvidence: [evidence('p-0', ['slice', '0']), ...data.options.positionEvidence!.slice(1)], bootstrap });
    expect(sliced.bootstrap!.unitN).toBe(whole.bootstrap!.unitN);
    expect(sliced.bootstrap!.intervals).toEqual(whole.bootstrap!.intervals);
    expect(sliced.baseline!.expectancy).toBe(whole.baseline!.expectancy);
  });
  it('samples entire days and reports varying position counts rather than fixed independent N', () => {
    const rows = [trade('a', 5), trade('b', 10, START + 1), trade('c', 15, START + 2), trade('d', -10, START + 86_400_000)];
    const proof = rows.map(row => evidence(`p-${row.id}`, [String(row.id)]));
    const result = computeBacktestRobustness(rows, { ...options(proof), bootstrap: { ...bootstrap, unit: 'day', blockLength: 1 } }).bootstrap!;
    expect(result).toMatchObject({ unitN: 2, sampledPositionN: { min: 2, max: 6 }, drawdownBasis: 'day-close' });
    expect(result.observed.expectancy).toBe(5);
  });
  it('reports the distinction between partial ledger DD and position-close bootstrap DD', () => {
    const data = independent([10, 20, 30, 40]);
    const result = computeBacktestRobustness([trade('partial', -50, START - 1), ...data.trades.map(row => row.id === '0' ? { ...row, pnl: 60 } : row)], {
      ...data.options, positionEvidence: [evidence('p-0', ['partial', '0']), ...data.options.positionEvidence!.slice(1)], bootstrap });
    expect(result.baseline!.maxDrawdown).toBe(50); expect(result.bootstrap!.observed.maxDrawdown).toBe(0);
    expect(result).toMatchObject({ drawdownBasis: 'realized-exit-ledger', bootstrap: { drawdownBasis: 'position-close' } });
  });
  it('preserves unbounded profit-factor tails and separately counts undefined all-zero replicates', () => {
    const winners = independent([1, 2, 3, 4]);
    expect(computeBacktestRobustness(winners.trades, { ...winners.options, bootstrap }).bootstrap!.intervals!.profitFactor)
      .toMatchObject({ low: null, high: null, lowUnbounded: true, highUnbounded: true, validReplicates: 500, undefinedReplicates: 0 });
    const zero = independent([0, 0, 0, 0]);
    expect(computeBacktestRobustness(zero.trades, { ...zero.options, bootstrap }).bootstrap!.intervals!.profitFactor)
      .toMatchObject({ low: null, high: null, validReplicates: 0, undefinedReplicates: 500, highUnbounded: false });
  });
  it('refuses misleading intervals with fewer than two full blocks', () => {
    const data = independent([1, -1, 2]);
    expect(computeBacktestRobustness(data.trades, { ...data.options, bootstrap }).bootstrap).toMatchObject({ status: 'insufficient-data', intervals: null, unitN: 3 });
  });
});

describe('runtime evidence and panel contract', () => {
  it('builds scoped evidence and refuses closure when an identity is still open or legacy-unknown', () => {
    const state = createBacktestRuntime(1000);
    const closed = { id: 'a', runId: 'run', positionId: 'p', instrument: 'MNQ' as const, direction: 'Long' as const,
      quantity: 1, entryPrice: 100, exitPrice: 101, entryTime: 60, exitTime: 120, grossPnl: 2, commission: 0, pnl: 2, reason: 'manual' as const };
    state.closedTrades = [closed, { ...closed, id: 'b' }, { ...closed, id: 'unknown', positionId: undefined }];
    const run: Pick<BacktestRun, 'id' | 'accountId' | 'runtimeState'> = { id: 'run', accountId: 'account', runtimeState: state };
    expect(buildBacktestPositionEvidence([run])).toEqual([evidence('p', ['a', 'b'])]);
    state.positions = [{ positionId: 'p', instrument: 'MNQ', side: 'long', quantity: 1, averagePrice: 100, openedAt: 60, entryFillIds: ['entry'], entryCommission: 0 }];
    expect(buildBacktestPositionEvidence([run])[0].closed).toBe(false);
    state.positions[0].positionId = undefined;
    expect(buildBacktestPositionEvidence([run])[0].closed).toBe(false);
  });
  it('renders baseline, scope exclusions and methodological distinctions without mutating input', () => {
    const data = sample(); data.trades.push(trade('legacy', 999));
    const html = renderToStaticMarkup(createElement(BacktestRobustnessPanel, { trades: data.trades, options: { ...data.options, bootstrap }, isDark: true }));
    expect(html).toContain('Baseline'); expect(html).toContain('legacy'); expect(html).toContain('Chybí doložená identita');
    expect(html).toContain('realizovaných výstupech'); expect(html).toContain('Nejde o počet nezávislých vzorků');
    expect(html).toContain('Seed'); expect(html).not.toContain('NaN');
  });
  it('renders mixed-currency and insufficient evidence as visible states', () => {
    const data = independent([10]);
    const html = renderToStaticMarkup(createElement(BacktestRobustnessPanel, { trades: data.trades, options: options([]), isDark: false }));
    expect(html).toContain('Chybí úplné uzavřené pozice'); expect(html).not.toContain('Spočítat intervaly');
  });
});
