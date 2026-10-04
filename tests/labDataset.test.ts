import { describe, expect, it } from 'vitest';
import { buildLabDecisions, labSession } from '../lib/labDataset';
import type { Trade } from '../types';
import type { TradeExecutionHistory } from '../lib/tradeExecutionHistory';

const at = (iso: string) => Date.parse(iso);
const journal = (id: string, extra: Partial<Trade> & Record<string, unknown>): Trade => ({
  id, accountId: 'lead', copierTradeId: `journal:${id}`, source: 'copier', instrument: 'MNQ', symbol: 'MNQZ6',
  direction: 'Short', pnl: 0, positionSize: 2, entryPrice: 30859.25, exitPrice: 30879.75,
  entryTime: at('2026-10-01T07:44:26Z'), entryDate: '2026-10-01T07:44:26.000Z',
  timestamp: at('2026-10-01T07:53:55Z'), date: '2026-10-01T07:53:55.000Z', exitDate: '2026-10-01T07:53:55.000Z',
  ...extra,
} as unknown as Trade);
const accounts = [{ id: 'lead', type: 'Prop' }, { id: 'f1', type: 'Prop' }, { id: 'bt', type: 'Backtest' }] as never;

describe('buildLabDecisions', () => {
  it('counts a copier group once, with the leader money (copies are not summed)', () => {
    const [decision, ...rest] = buildLabDecisions({ accounts, trades: [
      journal('a', { groupId: 'execution:demo:c:1', isMaster: true, pnl: -253 }),
      journal('b', { groupId: 'execution:demo:c:1', isMaster: false, accountId: 'f1', pnl: -490.8, positionSize: 4 }),
    ] });
    expect(rest).toEqual([]);
    expect(decision).toMatchObject({ id: 'execution:demo:c:1', leaderTradeId: 'a', leaderKnown: true, pnlUsd: -253, size: 2, accountIds: ['lead', 'f1'] });
    expect(decision.groupPnlUsd).toBeCloseTo(-743.8);
  });

  it('joins a simultaneous entry on two accounts without a copier link', () => {
    const decisions = buildLabDecisions({ accounts, trades: [
      journal('x', { accountId: 'lead', pnl: -403.2, positionSize: 8 }),
      journal('y', { accountId: 'f1', pnl: -201.6, positionSize: 4, entryTime: at('2026-10-01T07:44:26.400Z') }),
      journal('z', { accountId: 'f1', pnl: 20, direction: 'Long', entryTime: at('2026-10-01T07:44:27Z') }),
    ] });
    expect(decisions).toHaveLength(2);
    const joined = decisions.find(d => d.memberTradeIds.length === 2)!;
    expect(joined).toMatchObject({ id: 'sync:x', leaderTradeId: 'y', leaderKnown: false, pnlUsd: -201.6, size: 4 });
  });

  it('keeps only Tradovate journal trades from live accounts', () => {
    const decisions = buildLabDecisions({ accounts, trades: [
      journal('a', { pnl: 10 }),
      { ...journal('legacy', { pnl: 99 }), copierTradeId: undefined, source: 'manual' } as Trade,
      journal('bt', { accountId: 'bt', pnl: 5 }),
      journal('untaken', { pnl: 0, untaken: { orderId: '1' } as unknown as Trade['untaken'] }),
    ] });
    expect(decisions.map(d => d.leaderTradeId)).toEqual(['a']);
  });

  it('takes R from the planned SL, then the broker SL, and leaves it empty without one', () => {
    const [planned, broker, none] = buildLabDecisions({ accounts, trades: [
      journal('p', { plannedStopLoss: 30879.25, stopLoss: 30900, pnl: -50 }),
      journal('b', { stopLoss: 30879.25, pnl: -50, entryTime: at('2026-10-01T08:05:00Z'), entryDate: '2026-10-01T08:05:00.000Z', timestamp: at('2026-10-01T08:10:00Z') }),
      journal('n', { pnl: -50, entryTime: at('2026-10-01T09:00:00Z'), entryDate: '2026-10-01T09:00:00.000Z', timestamp: at('2026-10-01T09:05:00Z') }),
    ] });
    expect(planned).toMatchObject({ slSource: 'plan', sl: 30879.25, riskPoints: 20, riskUsd: 80 });
    expect(planned.r).toBeCloseTo(-1.025);
    expect(broker).toMatchObject({ slSource: 'broker', sl: 30879.25 });
    expect(none).toMatchObject({ sl: null, slSource: null, r: null, riskUsd: null });
  });

  it('places the day in Prague and the session by New York time', () => {
    const [morning, open] = buildLabDecisions({ accounts, trades: [
      journal('m', { pnl: -253 }),
      journal('o', { pnl: 120, direction: 'Long', entryPrice: 30800, exitPrice: 30830,
        entryTime: at('2026-10-01T13:35:00Z'), entryDate: '2026-10-01T13:35:00.000Z', timestamp: at('2026-10-01T13:40:00Z'), date: '2026-10-01T13:40:00.000Z', exitDate: '2026-10-01T13:40:00.000Z' }),
    ] });
    expect(morning).toMatchObject({ dayKey: '2026-10-01', weekday: 4, entryMinute: 9 * 60 + 44, session: 'Londýn', orderInDay: 1, minutesSincePrevExit: null });
    expect(open).toMatchObject({ entryMinute: 15 * 60 + 35, session: 'NY open', orderInDay: 2, afterLoss: true, directionFlip: true });
    expect(open.minutesSincePrevExit).toBeCloseTo(341.1, 0);
  });

  it('reads stop management from the leader history', () => {
    const history = {
      fills: [], gaps: [], issues: [], grossPnl: null, fees: 4.2, netPnl: null, complete: true,
      protection: [
        { kind: 'sl', status: 'confirmed', operation: 'new', price: 30879.25, at: at('2026-10-01T07:44:26.900Z'), orderId: '9' },
        { kind: 'sl', status: 'confirmed', operation: 'modify', price: 30870, at: at('2026-10-01T07:48:00Z'), orderId: '9' },
        { kind: 'sl', status: 'confirmed', operation: 'modify', price: 30859, at: at('2026-10-01T07:50:00Z'), orderId: '9' },
      ],
    } as unknown as TradeExecutionHistory;
    const [decision] = buildLabDecisions({ accounts, trades: [journal('a', { pnl: -1 })], histories: new Map([['a', history]]) });
    expect(decision.management).toEqual({ slMoves: 2, movedToBreakEven: true, noStopAtEntry: false });
    expect(decision.feesUsd).toBe(4.2);
  });

  it('marks reviewed decisions and their plan', () => {
    const [ok, pending] = buildLabDecisions({ accounts, trades: [
      journal('ok', { pnl: 5, planAdherence: 'No', executionStatus: 'Invalid', isValid: false, invalidReasons: ['Revenge'], needsReview: false }),
      journal('pending', { pnl: 5, needsReview: true, entryTime: at('2026-10-01T10:00:00Z'), entryDate: '2026-10-01T10:00:00.000Z', timestamp: at('2026-10-01T10:05:00Z') }),
    ] });
    expect(ok).toMatchObject({ plan: 'no', reviewed: true, invalidReasons: ['Revenge'] });
    expect(pending).toMatchObject({ plan: null, reviewed: false });
  });
});

describe('labSession', () => {
  it('follows New York hours across the DST gap', () => {
    // 27. 10. 2026: Praha už v zimním čase, New York ještě v letním — 14:35 Praha = 9:35 ET.
    expect(labSession(at('2026-10-27T13:35:00Z'))).toBe('NY open');
    expect(labSession(at('2026-10-01T15:30:00Z'))).toBe('NY');
    expect(labSession(at('2026-10-01T02:00:00Z'))).toBe('Asie');
  });
});
