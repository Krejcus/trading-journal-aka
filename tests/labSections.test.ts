import { describe, expect, it } from 'vitest';
import { labHeldValueUsd, labManagement, labSetups, labTime } from '../lib/labSections';
import type { LabDecision } from '../lib/labDataset';
import type { LabExcursion } from '../lib/labExcursion';

let seq = 0;
const decision = (extra: Partial<LabDecision>): LabDecision => ({
  id: `d${++seq}`, leaderTradeId: `t${seq}`, memberTradeIds: [], accountIds: ['a'], leaderAccountId: 'a', leaderKnown: true,
  instrument: 'MNQ', symbol: 'MNQZ6', pointValue: 2, direction: 'Long', entryAt: 0, exitAt: 60_000, holdMs: 60_000,
  dayKey: '2026-10-01', weekday: 4, entryMinute: 15 * 60 + 40, session: 'NY open', orderInDay: 1, minutesSincePrevExit: null,
  afterLoss: false, directionFlip: false, size: 2, entryPrice: 100, exitPrice: 100, points: 0, pnlUsd: 0, feesUsd: null, groupPnlUsd: 0,
  sl: 90, slSource: 'broker', tp: 130, riskPoints: 10, riskUsd: 40, r: 0, plannedRR: 3, exitKind: 'manual', plan: null, reviewed: false,
  invalidReasons: [], htf: [], ltf: [], emotions: [], mistakes: [], management: { slMoves: 0, movedToBreakEven: false, stopDelaySec: 0.5 },
  ...extra,
});
const exc = (extra: Partial<LabExcursion>): LabExcursion => ({ mfePoints: 0, maePoints: 0, afterExitPoints: null, heldOutcome: null, candles: 5, ...extra });

describe('labManagement', () => {
  it('prices the break-even stops that would have reached the planned TP', () => {
    const be = decision({ exitKind: 'sl', points: 0.25, pnlUsd: 1, management: { slMoves: 2, movedToBreakEven: true, stopDelaySec: 0.5 } });
    const beLost = decision({ exitKind: 'sl', points: 0, pnlUsd: 0, management: { slMoves: 1, movedToBreakEven: true, stopDelaySec: 0.5 } });
    const summary = labManagement([be, beLost], new Map([[be.id, exc({ heldOutcome: 'tp' })], [beLost.id, exc({ heldOutcome: 'sl' })]]));
    expect(summary.beStopped).toHaveLength(2);
    expect(summary.beThenTp).toEqual([be]);
    expect(summary.beCostUsd).toBe(119); // TP 30 b. × $2 × 2 ks − $1
  });

  it('compares manual exits with holding the original plan and keeps coverage', () => {
    const won = decision({ pnlUsd: 20, points: 5 });
    const lost = decision({ pnlUsd: -10, points: -2.5 });
    const unknown = decision({ pnlUsd: 5 });
    const summary = labManagement([won, lost, unknown], new Map([[won.id, exc({ heldOutcome: 'tp', afterExitPoints: 40 })], [lost.id, exc({ heldOutcome: 'sl', afterExitPoints: 4 })]]));
    expect(summary.manual.averageUsd).toBe(5);
    expect(summary.manual.covered).toHaveLength(2);
    expect(summary.manual.heldAverageUsd).toBe(40); // (120 − 40) / 2
    expect(summary.afterExit.medianPoints).toBe(22);
    expect(summary.holdWinners).toMatchObject({ reached: 1, extraUsd: 100, reversed: 0 });
  });

  it('counts trades without a stop at entry', () => {
    const naked = decision({ pnlUsd: -300, management: { slMoves: 0, movedToBreakEven: false, stopDelaySec: null } });
    const summary = labManagement([naked, decision({ pnlUsd: -40 })], new Map());
    expect(summary.noStop).toMatchObject({ totalUsd: -300, avgLossUsd: -300, avgLossWithStopUsd: -40 });
    expect(labHeldValueUsd(naked, undefined)).toBeNull();
  });
});

describe('labTime + labSetups', () => {
  it('splits by hour, weekday, session and order in the day', () => {
    const time = labTime([decision({ pnlUsd: 50 }), decision({ pnlUsd: -20, orderInDay: 4, entryMinute: 17 * 60 + 5, session: 'NY' })], 'usd');
    expect(time.hours).toEqual([15, 17]);
    expect(time.heat.find(row => row.weekday === 4)!.cells.map(c => c.stats.total)).toEqual([50, -20]);
    expect(time.order.map(o => o.decisions.length)).toEqual([1, 0, 0, 1]);
    expect(time.bySession.map(s => s.session)).toEqual(['NY open', 'NY']);
  });

  it('shows tags only with enough reviewed trades and combos from 30', () => {
    const list = Array.from({ length: 6 }, (_, i) => decision({ reviewed: true, plan: 'yes', htf: ['15m BoS'], ltf: i % 2 ? ['1m FVG'] : ['Sweep'], pnlUsd: 10 }));
    const setups = labSetups(list, 'usd');
    expect(setups).toMatchObject({ tagged: 6, largestCombo: 3, combos: [] });
    expect(setups.tags.map(t => [t.kind, t.tag, t.decisions.length])).toEqual([['HTF', '15m BoS', 6]]);
  });
});
