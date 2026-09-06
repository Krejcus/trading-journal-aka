import { describe, expect, it } from 'vitest';
import { selectExperimentCohorts } from '../services/experimentCohorts';
import { buildLabDatasetFromTrades, computeExperimentReport } from '../services/labAnalytics';
import type { Trade } from '../types';

const start = Date.UTC(2026, 8, 5, 12);
const oldMarket = Date.UTC(2026, 7, 3, 14);
const item = (id: string, recordedAt?: number) => ({ id, accountId: 'a', ts: oldMarket, raw: { recordedAt } });

describe('experiment market / research clock', () => {
  it('today’s replay of August belongs after today’s experiment start', () => {
    const result = selectExperimentCohorts([item('before', start - 1), item('after', start + 1)], { startTs: start }, 'backtest');
    expect(result.before.map(t => t.id)).toEqual(['before']);
    expect(result.after.map(t => t.id)).toEqual(['after']);
  });
  it('preserves live market-time cohorts', () => {
    const result = selectExperimentCohorts([{ ...item('past', start + 1) }, { ...item('future'), ts: start + 1 }], { startTs: start }, 'live');
    expect(result.before.map(t => t.id)).toEqual(['past']);
    expect(result.after.map(t => t.id)).toEqual(['future']);
  });
  it('frozen baseline keeps legacy members and does not invent unknown research dates', () => {
    const result = selectExperimentCohorts([item('baseline'), item('unknown'), item('late-import', start - 1)], { startTs: start, baselineTradeIds: ['baseline'] }, 'backtest');
    expect(result.before.map(t => t.id)).toEqual(['baseline']);
    expect(result.unknown.map(t => t.id)).toEqual(['unknown']);
    expect(result.after).toEqual([]);
  });
  it('respects selected accounts and the explicit evaluation boundary', () => {
    const result = selectExperimentCohorts([item('yes', start + 1), item('late', start + 11), { ...item('other', start + 1), accountId: 'b' }], { startTs: start, endTs: start + 10, accountIds: ['a'] }, 'backtest');
    expect(result.after.map(t => t.id)).toEqual(['yes']);
  });
  it('uses persisted database creation time for legacy records and rejects an absent date', () => {
    const result = selectExperimentCohorts([{ ...item('legacy'), raw: { createdAt: new Date(start + 1).toISOString() } }, item('missing')], { startTs: start }, 'backtest');
    expect(result.after.map(t => t.id)).toEqual(['legacy']);
    expect(result.unknown.map(t => t.id)).toEqual(['missing']);
  });
  it('an explicitly unknown replay intent is not replaced by the date of a later upload', () => {
    const result = selectExperimentCohorts([{ ...item('resumed'), raw: { recordedAt: null, createdAt: start + 1 } }], { startTs: start }, 'backtest');
    expect(result.after).toEqual([]); expect(result.unknown.map(t => t.id)).toEqual(['resumed']);
  });

  it('the actual Lab report and evidence IDs use the same research cohorts', () => {
    const trade = (id: string, recordedAt?: number): Trade => ({ id, accountId: 'a', signal: 'test', pnl: 10, runUp: 10, drawdown: 0, direction: 'Long', date: new Date(oldMarket).toISOString(), timestamp: oldMarket, duration: '1m', durationMinutes: 1, recordedAt });
    const ds = buildLabDatasetFromTrades([trade('before', start - 1), trade('after', start + 1), trade('unknown')], 'backtest');
    const report = computeExperimentReport(ds, { startTs: start, targetTrades: 1 });
    expect(report.before.n).toBe(1);
    expect(report.after.n).toBe(1);
    expect(report.cohort).toMatchObject({ clock: 'recorded', beforeTradeIds: ['before'], afterTradeIds: ['after'], unknownTradeIds: ['unknown'] });
    expect(report.limitation).toContain('chybí čas zápisu');
  });
});
