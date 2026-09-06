import { describe, expect, it } from 'vitest';
import type { Trade } from '../types';
import { selectExperimentCohorts, type ExperimentCohortConfig } from '../services/experimentCohorts';
import { selectExperimentCohorts as selectMcpCohorts } from '../supabase/functions/mcp-server/experimentCohorts';
import * as appAnalytics from '../services/labAnalytics';
import * as mcpAnalytics from '../supabase/functions/mcp-server/labAnalytics';

const START = Date.UTC(2026, 8, 5, 12);
const MARKET = Date.UTC(2026, 0, 5, 10);
const reference = { id: 'binding', experimentId: 'case', revisionId: 'revision-2', revisionHash: 'hash-2', role: 'development' as const };
type Row = { id: string; accountId: string; ts: number; raw: { recordedAt?: unknown; createdAt?: unknown; backtestRunId?: string;
  backtestResearch?: { id?: string; experimentId: string; revisionId: string; revisionHash: string; role: string } } };
function item(id: string, patch: Partial<Row> = {}): Row {
  return { id, accountId: 'account', ts: MARKET, ...patch,
    raw: { recordedAt: START + 1000, backtestRunId: 'run', backtestResearch: { ...reference }, ...patch.raw } };
}
function config(patch: Partial<ExperimentCohortConfig> = {}): ExperimentCohortConfig {
  return { id: 'case', startTs: START, baselineTradeIds: ['baseline'], researchRole: 'development', researchRevisionId: 'revision-2',
    research: { revisions: [{ id: 'revision-1', hash: 'hash-1', recordedAt: START }, { id: 'revision-2', hash: 'hash-2', recordedAt: START + 100 }] }, ...patch };
}
const proof = (positionId: string, expectedTradeIds: string[], patch: Partial<NonNullable<ExperimentCohortConfig['researchPositionEvidence']>[number]> = {}) =>
  ({ accountId: 'account', runId: 'run', positionId, expectedTradeIds, closed: true, ...patch });
const ids = (rows: readonly Row[]) => rows.map(row => row.id);
function rawTrade(id: string, pnl: number, recordedAt = START + 1000, patch: Partial<Trade> = {}): Trade {
  return { id, accountId: 'account', backtestRunId: 'run', backtestResearch: { ...reference }, recordedAt, signal: 'test', pnl, riskAmount: 10,
    runUp: 0, drawdown: 0, date: new Date(MARKET).toISOString(), timestamp: MARKET, direction: 'Long', duration: '1m', durationMinutes: 1, ...patch };
}
function positionDataset(slices = 1) {
  const trades: Trade[] = []; const evidence: NonNullable<ExperimentCohortConfig['researchPositionEvidence']>[number][] = []; const baselineTradeIds: string[] = [];
  for (const side of ['before', 'after'] as const) for (let position = 0; position < 5; position += 1) {
    const tradeIds: string[] = [];
    for (let slice = 0; slice < slices; slice += 1) {
      const id = `${side}-${position}-${slice}`; tradeIds.push(id);
      trades.push(rawTrade(id, (side === 'before' ? 10 : 20) / slices, side === 'before' ? START - 1000 : START + 1000,
        { timestamp: MARKET + (side === 'before' ? 0 : 60_000) + position * 1000 + slice }));
      if (side === 'before') baselineTradeIds.push(id);
    }
    evidence.push(proof(`${side}-${position}`, tradeIds));
  }
  return { trades, config: { ...config({ baselineTradeIds, researchPositionEvidence: evidence }), targetTrades: 5 } };
}

const implementations = [
  ['app', { select: selectExperimentCohorts, analytics: appAnalytics }],
  ['local MCP', { select: selectMcpCohorts as typeof selectExperimentCohorts, analytics: mcpAnalytics as unknown as typeof appAnalytics }],
] as const;

describe.each(implementations)('%s research cohorts', (_name, api) => {
  it('requires an exact experiment, revision, hash and declared role', () => {
    const rows = [item('match'), ...[
      { experimentId: 'other' }, { revisionId: 'revision-1' }, { revisionHash: 'wrong-hash' }, { role: 'validation' },
    ].map((patch, index) => item(`wrong-${index}`, { raw: { backtestResearch: { ...reference, ...patch } } })), item('unbound', { raw: { backtestResearch: undefined } })];
    const result = api.select(rows, config(), 'backtest');
    expect(ids(result.after)).toEqual(['match']);
    expect(ids(result.unlinked)).toEqual(['wrong-0', 'wrong-1', 'wrong-2', 'wrong-3', 'unbound']);
  });
  it('selects the latest version by default but does not substitute it for an unknown explicit version', () => {
    const rows = [item('new'), item('old', { raw: { backtestResearch: { ...reference, revisionId: 'revision-1', revisionHash: 'hash-1' } } })];
    expect(ids(api.select(rows, config({ researchRevisionId: undefined }), 'backtest').after)).toEqual(['new']);
    expect(ids(api.select(rows, config({ researchRevisionId: 'revision-1' }), 'backtest').after)).toEqual(['old']);
    const unknown = api.select(rows, config({ researchRevisionId: 'nonexistent' }), 'backtest');
    expect(unknown.after).toHaveLength(0); expect(unknown.unlinked).toHaveLength(2);
  });
  it('does not reassign a frozen baseline ID after relinking or importing a later recorded time', () => {
    const rows = [item('baseline'), item('baseline-unknown', { raw: { recordedAt: null, createdAt: START + 9999 } }),
      item('late-import', { raw: { recordedAt: START - 1000 } }), item('new')];
    const snapshot = structuredClone(rows);
    const result = api.select(rows, config({ baselineTradeIds: ['baseline', 'baseline-unknown'] }), 'backtest');
    expect(ids(result.before)).toEqual(['baseline', 'baseline-unknown']); expect(ids(result.after)).toEqual(['new']);
    expect(ids(result.unknown)).toEqual([]); expect(rows).toEqual(snapshot);
  });
  it('keeps unknown clocks outside before/after and does not replace explicit null with upload time', () => {
    const rows = [item('unknown', { raw: { recordedAt: undefined } }), item('explicit-null', { raw: { recordedAt: null, createdAt: START + 2000 } }),
      item('invalid', { raw: { recordedAt: NaN, createdAt: 'bad-date' } }), item('legacy-created', { raw: { recordedAt: undefined, createdAt: new Date(START + 1000).toISOString() } })];
    const result = api.select(rows, config(), 'backtest');
    expect(ids(result.unknown)).toEqual(['unknown', 'explicit-null', 'invalid']); expect(ids(result.after)).toEqual(['legacy-created']);
  });
  it('rejects an unknown registration time or a replay intent made before the selected rule existed', () => {
    const early = api.select([item('too-early', { raw: { recordedAt: START + 50 } }), item('registered', { raw: { recordedAt: START + 100 } })], config(), 'backtest');
    expect(ids(early.after)).toEqual(['registered']); expect(ids(early.unlinked)).toEqual(['too-early']);
    for (const recordedAt of [null, NaN, Infinity, 0, undefined]) {
      const value = config({ research: { revisions: [{ id: 'revision-2', hash: 'hash-2', recordedAt: recordedAt as number | null }] } });
      expect(api.select([item('trade')], value, 'backtest').after).toHaveLength(0);
    }
  });
  it('applies account scope before frozen membership and respects an inclusive observation end', () => {
    const rows = [item('baseline', { accountId: 'other' }), item('inclusive', { raw: { recordedAt: START + 2000 } }),
      item('later', { raw: { recordedAt: START + 2001 } }), item('other', { accountId: 'other' })];
    const result = api.select(rows, config({ accountIds: ['account'], endTs: START + 2000 }), 'backtest');
    expect(result.before).toHaveLength(0); expect(ids(result.after)).toEqual(['inclusive']);
  });
  it('counts a complete partial lifecycle once and requires every exit in the selected version/role', () => {
    const rows = [item('partial-1'), item('partial-2')];
    const value = config({ researchPositionEvidence: [proof('position', ['partial-1', 'partial-2'])] });
    expect(api.select(rows, value, 'backtest').completePositionN).toBe(1);
    expect(api.select(rows.slice(1), value, 'backtest').completePositionN).toBe(0);
    const wrongRole = [rows[0], item('partial-2', { raw: { backtestResearch: { ...reference, role: 'validation' } } })];
    const result = api.select(wrongRole, value, 'backtest'); expect(result.after).toHaveLength(1); expect(result.completePositionN).toBe(0);
  });
  it('cannot split one position into baseline and after samples', () => {
    const value = config({ baselineTradeIds: ['partial-1'], researchPositionEvidence: [proof('p', ['partial-1', 'partial-2'])] });
    const result = api.select([item('partial-1'), item('partial-2')], value, 'backtest');
    expect(ids(result.before)).toEqual(['partial-1']); expect(ids(result.after)).toEqual(['partial-2']);
    expect(result.completeBeforePositionN).toBe(0); expect(result.completePositionN).toBe(0);
  });
  it('reports an absent ledger as unknown size rather than zero or an inflated exit count', () => {
    const result = api.select([item('a'), item('b')], config(), 'backtest');
    expect(result.completePositionN).toBeNull(); expect(result.completeBeforePositionN).toBeNull();
    expect(api.select([item('a')], config({ researchPositionEvidence: [] }), 'backtest').completePositionN).toBe(0);
  });
  it('does not count open, wrong-run or wrong-account claims', () => {
    for (const patch of [{ closed: false }, { runId: 'other' }, { accountId: 'other' }]) {
      expect(api.select([item('a')], config({ researchPositionEvidence: [proof('p', ['a'], patch)] }), 'backtest').completePositionN).toBe(0);
    }
  });
  it('deduplicates identical evidence, but rejects competing owners and conflicting definitions', () => {
    const rows = [item('a'), item('b')];
    expect(api.select(rows, config({ researchPositionEvidence: [proof('p', ['a', 'b']), proof('p', ['b', 'a'])] }), 'backtest').completePositionN).toBe(1);
    for (const evidence of [
      [proof('p', ['a']), proof('other-position', ['a'])],
      [proof('p', ['a']), proof('p', ['a', 'missing'])],
      [proof('p', ['a']), proof('p', ['a'], { closed: false })],
      [proof('p', ['a', 'a'])],
    ]) expect(api.select(rows, config({ researchPositionEvidence: evidence }), 'backtest').completePositionN).toBe(0);
  });
  it('rejects duplicate exit rows and empty/whitespace position identity', () => {
    const value = config({ researchPositionEvidence: [proof('p', ['a'])] });
    expect(api.select([item('a'), item('a')], value, 'backtest').completePositionN).toBe(0);
    for (const positionId of ['', '   ', ' p ']) expect(api.select([item('a')], config({ researchPositionEvidence: [proof(positionId, ['a'])] }), 'backtest').completePositionN).toBe(0);
  });
  it('separates equal position IDs in different run/account scopes', () => {
    const rows = [item('a'), item('b', { raw: { backtestRunId: 'run-2' } }), item('c', { accountId: 'other' })];
    const value = config({ researchPositionEvidence: [proof('same', ['a']), proof('same', ['b'], { runId: 'run-2' }), proof('same', ['c'], { accountId: 'other' })] });
    expect(api.select(rows, value, 'backtest').completePositionN).toBe(3);
  });
});

describe.each(implementations)('%s research experiment report', (_name, api) => {
  it('bases readiness and sample quality on complete positions, invariant to partial slicing', () => {
    const whole = positionDataset(); const sliced = positionDataset(10);
    const left = api.analytics.computeExperimentReport(api.analytics.buildLabDatasetFromTrades(whole.trades, 'backtest'), whole.config);
    const right = api.analytics.computeExperimentReport(api.analytics.buildLabDatasetFromTrades(sliced.trades, 'backtest'), sliced.config);
    expect(left).toMatchObject({ sampleUnit: 'position', targetProgressN: 5, ready: true, progress: 1, sampleQuality: 'low' });
    expect(right).toMatchObject({ targetProgressN: 5, ready: true, sampleQuality: left.sampleQuality, before: { n: 50, pnl: left.before.pnl }, after: { n: 50, pnl: left.after.pnl } });
    // These remain descriptive EXIT metrics, which are allowed to change when the bookkeeping is sliced.
    expect(right.after.avgPnl).toBe(left.after.avgPnl / 10);
    expect(right.limitation).toContain('výstupních záznamů'); expect(right.limitation).toContain('celé doložené pozice');
  });
  it('does not report a high-quality baseline from many exits without its complete position ledger', () => {
    const data = positionDataset(10);
    data.config.researchPositionEvidence = data.config.researchPositionEvidence!.filter(evidence => evidence.positionId.startsWith('after'));
    const report = api.analytics.computeExperimentReport(api.analytics.buildLabDatasetFromTrades(data.trades, 'backtest'), data.config);
    expect(report).toMatchObject({ targetProgressN: 5, ready: true, sampleQuality: 'insufficient' });
  });
  it('cannot complete a research target when position history is absent', () => {
    const data = positionDataset(10); const value = { ...data.config, researchPositionEvidence: undefined };
    const report = api.analytics.computeExperimentReport(api.analytics.buildLabDatasetFromTrades(data.trades, 'backtest'), value);
    expect(report).toMatchObject({ after: { n: 50 }, targetProgressN: null, ready: false, progress: 0, sampleQuality: 'insufficient' });
    expect(report.limitation).toContain('Bez historie pozic');
    expect(api.analytics.buildExperimentCoachPrompt({ title: 'Rule', hypothesis: 'Hypothesis', rule: 'Entry rule', targetTrades: 5 }, report)).toContain('neznámý počet');
  });
  it('reports unknown clocks and unrelated versions explicitly without contaminating P&L', () => {
    const rows = [rawTrade('valid', 20), rawTrade('unlinked', 999, START + 1000, { backtestResearch: { ...reference, revisionHash: 'other' } }),
      rawTrade('unknown', 999, START + 1000, { recordedAt: undefined, createdAt: undefined })];
    const report = api.analytics.computeExperimentReport(api.analytics.buildLabDatasetFromTrades(rows, 'backtest'), { ...config(), targetTrades: 5 });
    expect(report.after).toMatchObject({ n: 1, pnl: 20 });
    expect(report.cohort).toMatchObject({ afterTradeIds: ['valid'], unlinkedTradeIds: ['unlinked'], unknownTradeIds: ['unknown'] });
    expect(report.limitation).toContain('vyřazené'); expect(report.limitation).toContain('chybí čas zápisu');
  });
  it('treats a validation role as a declared purpose, not proof of a clean unseen holdout', () => {
    const data = positionDataset(); data.trades.forEach(trade => { trade.backtestResearch = { ...reference, role: 'validation' }; });
    const report = api.analytics.computeExperimentReport(api.analytics.buildLabDatasetFromTrades(data.trades, 'backtest'), { ...data.config, researchRole: 'validation' });
    expect(report.ready).toBe(true);
    expect(report.limitation).toMatch(/OOS|dříve pozor|nepozorovan/);
  });
  it('never completes a malformed research target, while legacy exit experiments retain a positive target of one', () => {
    const data = positionDataset(); const ds = api.analytics.buildLabDatasetFromTrades(data.trades, 'backtest');
    for (const targetTrades of [0, -1, 1, 4, 5.5, NaN, Infinity, 100001]) {
      expect(api.analytics.computeExperimentReport(ds, { ...data.config, targetTrades }).ready).toBe(false);
    }
    const legacy = api.analytics.computeExperimentReport(ds, { startTs: START, targetTrades: 1 });
    expect(legacy).toMatchObject({ sampleUnit: 'exit', targetProgressN: 5, ready: true });
  });
  it('keeps live market-clock experiments independent of research binding requirements', () => {
    const rows = [rawTrade('before', 10, START + 1000, { timestamp: START - 1 }), rawTrade('after', -5, START - 1000, { timestamp: START + 1, backtestResearch: undefined })];
    const report = api.analytics.computeExperimentReport(api.analytics.buildLabDatasetFromTrades(rows, 'live'), { startTs: START, targetTrades: 1 });
    expect(report).toMatchObject({ sampleUnit: 'exit', ready: true, before: { n: 1, pnl: 10 }, after: { n: 1, pnl: -5 }, cohort: { clock: 'market' } });
  });
});

it('keeps the app and local MCP report, source IDs and quality byte-for-byte equivalent', () => {
  const data = positionDataset(3);
  data.trades.push(rawTrade('wrong-version', 999, START + 1000, { backtestResearch: { ...reference, revisionId: 'revision-1', revisionHash: 'hash-1' } }));
  const left = appAnalytics.computeExperimentReport(appAnalytics.buildLabDatasetFromTrades(data.trades, 'backtest'), data.config);
  const right = mcpAnalytics.computeExperimentReport(mcpAnalytics.buildLabDatasetFromTrades(data.trades, 'backtest'), data.config);
  expect(right).toEqual(left);
});
