import { describe, expect, it } from 'vitest';
import type { LabExperiment, Trade } from '../types';
import type { BacktestRun } from '../services/backtestTypes';
import { createBacktestRuntime } from '../services/backtestEngine';
import { DEFAULT_BACKTEST_CONFIG } from '../services/backtestTypes';
import { appendResearchRule, bindResearchRule, researchExposureAtBinding, researchTradeReference,
  validateResearchCase, validateResearchRule, type BacktestResearchCase, type BacktestResearchRule } from '../services/backtestResearchCases';
import { hashBacktestEvidence } from '../services/backtestEvidenceIdentity';

const WALL = Date.UTC(2026, 8, 5, 10);
const MARKET = Date.UTC(2026, 0, 5, 10);
const definition: BacktestResearchRule = {
  hypothesis: ' Fewer impulsive entries improve execution. ', rule: ' Wait for a retest. ', falsification: ' No improvement after the declared sample. ',
  targetPositions: 20, timeZone: 'UTC', development: { from: '2026-01-01', through: '2026-01-31' }, validation: { from: '2026-02-01', through: '2026-02-28' },
};
const initialInput = () => ({ definition: structuredClone(definition), reason: 'Initial preregistration', recordedAt: WALL, operationId: 'r1' });
async function history() {
  const first = await appendResearchRule(initialInput());
  const second = await appendResearchRule({ previous: first, expectedHeadId: 'r1', definition: { ...definition, rule: 'Wait for a retest and rejection.' }, reason: 'Clarify entry', recordedAt: WALL + 1, operationId: 'r2' });
  return { first, second };
}
function run(patch: Partial<BacktestRun> = {}): BacktestRun {
  return { id: 'run', accountId: 'account', name: 'Replay', status: 'draft', initialCapital: 10_000, baseCurrency: 'USD', startAt: MARKET, endAt: MARKET + 3_600_000,
    executionSymbol: 'MNQ', replayInterval: '1m', cursorAt: null, config: structuredClone(DEFAULT_BACKTEST_CONFIG), workspaceState: {} as BacktestRun['workspaceState'],
    runtimeState: createBacktestRuntime(10_000), revision: 1, schemaVersion: 1, createdAt: WALL, updatedAt: WALL, lastOpenedAt: WALL, ...patch };
}
function trade(patch: Partial<Trade> = {}): Trade {
  return { id: 'trade', accountId: 'account', backtestRunId: 'run', signal: 'test', pnl: 10, runUp: 10, drawdown: 0, date: new Date(MARKET).toISOString(),
    direction: 'Long', timestamp: MARKET, duration: '1m', durationMinutes: 1, ...patch };
}
async function experiment(): Promise<LabExperiment> {
  return { id: 'experiment', createdAt: WALL, world: 'backtest', title: 'Retest', hypothesis: 'original', rule: 'original', targetTrades: 20,
    startTs: WALL, status: 'running', research: await appendResearchRule(initialInput()) };
}
const exposure = (runs: readonly BacktestRun[] = [], trades: readonly Trade[] = [], historyComplete = true) => researchExposureAtBinding({ marketStart: MARKET, marketEnd: MARKET + 3_600_000, runs, trades, historyComplete });

describe('research rule history, content hash and operation identity', () => {
  it('appends immutable ordered versions with canonical content hashes and preserved parents', async () => {
    const input = initialInput(); const first = await appendResearchRule(input); const snapshot = structuredClone(first);
    expect(first.revisions[0]).toMatchObject({ id: 'r1', version: 1, source: 'created', recordedAt: WALL,
      definition: { hypothesis: definition.hypothesis.trim(), rule: definition.rule.trim() } });
    expect(first.revisions[0].hash).toBe(await hashBacktestEvidence(validateResearchRule(definition)));
    const second = await appendResearchRule({ ...initialInput(), previous: first, expectedHeadId: 'r1', operationId: 'r2', recordedAt: WALL + 1, reason: 'Clarified condition' });
    expect(second.revisions[1]).toMatchObject({ version: 2, source: 'edited', parentId: 'r1' });
    expect(first).toEqual(snapshot); expect(second.revisions[0]).toEqual(snapshot.revisions[0]);
    input.definition.rule = 'Mutated caller draft'; second.revisions[0].definition.rule = 'Mutated output';
    expect(first).toEqual(snapshot);
  });
  it('returns the whole current history on a stable retry, even after subsequent edits', async () => {
    const { first, second } = await history();
    expect(await appendResearchRule({ ...initialInput(), previous: first })).toEqual(first);
    expect(await appendResearchRule({ ...initialInput(), previous: second })).toEqual(second);
    expect(await appendResearchRule({ previous: second, expectedHeadId: 'r1', definition: { ...definition, rule: 'Wait for a retest and rejection.' }, reason: 'Clarify entry', recordedAt: WALL + 1, operationId: 'r2' })).toEqual(second);
  });
  it('rejects stale heads and operation IDs reused with another parent, body, reason or clock', async () => {
    const { second } = await history();
    await expect(appendResearchRule({ ...initialInput(), previous: second, expectedHeadId: 'r1', operationId: 'r3', recordedAt: WALL + 2 })).rejects.toThrow();
    for (const patch of [{ expectedHeadId: 'not-the-original-parent' }, { reason: 'Different reason' }, { recordedAt: WALL + 999 }, { definition: { ...definition, rule: 'Different rule' } }]) {
      await expect(appendResearchRule({ ...initialInput(), previous: second, ...patch })).rejects.toThrow();
    }
  });
  it('retains legacy text without manufacturing a historical registration date', async () => {
    const input = { ...initialInput(), legacy: { hypothesis: 'Old hypothesis', rule: 'Old rule', targetTrades: 12 } };
    const result = await appendResearchRule(input);
    expect(result.revisions).toHaveLength(2);
    expect(result.revisions[0]).toMatchObject({ id: 'r1-legacy', source: 'legacy-import', recordedAt: null, definition: { rule: 'Old rule', targetPositions: 12 } });
    expect(result.revisions[1]).toMatchObject({ id: 'r1', source: 'edited', parentId: 'r1-legacy', recordedAt: WALL });
    expect(await appendResearchRule({ ...input, previous: result })).toEqual(result);
  });
  it('detects content mutation, forged hashes and invalid lineage without extending it', async () => {
    const { second } = await history();
    const corruptions: Array<(value: BacktestResearchCase) => void> = [
      value => { value.revisions[0].definition.rule = 'Undocumented edit'; }, value => { value.revisions[1].hash = 'sha256:fake'; },
      value => { value.revisions[1].parentId = 'wrong'; }, value => { value.revisions[1].version = 3; },
      value => { value.revisions[1].id = 'r1'; }, value => { value.revisions[1].recordedAt = WALL - 1; },
      value => { value.revisions[0].source = 'edited'; }, value => { value.revisions[1].source = 'created'; },
      value => { value.revisions[0].recordedAt = null; }, value => { value.revisions.reverse(); },
    ];
    for (const corrupt of corruptions) {
      const value = structuredClone(second); corrupt(value);
      await expect(validateResearchCase(value)).rejects.toThrow();
      await expect(appendResearchRule({ ...initialInput(), previous: value, expectedHeadId: 'r2', operationId: 'r3', recordedAt: WALL + 2 })).rejects.toThrow();
    }
  });
  it('uses UTF-8 serialized history size, not character count, for the 2 MiB limit', async () => {
    const largeDefinition = validateResearchRule({ ...definition, rule: 'ž'.repeat(20_000) });
    const first = (await appendResearchRule({ ...initialInput(), definition: largeDefinition })).revisions[0];
    const revisions = Array.from({ length: 54 }, (_, index) => ({ ...structuredClone(first), id: `revision-${index}`, version: index + 1,
      parentId: index ? `revision-${index - 1}` : undefined, source: index ? 'edited' as const : 'created' as const, recordedAt: WALL + index }));
    const result: BacktestResearchCase = { version: 1, revisions };
    expect(JSON.stringify(result).length).toBeLessThan(2 * 1024 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeGreaterThan(2 * 1024 * 1024);
    await expect(validateResearchCase({ version: 1, revisions: revisions.slice(0, 2) })).resolves.toBeUndefined();
    await expect(validateResearchCase(result)).rejects.toThrow();
  });
});

describe('research dates and declaration', () => {
  it.each(['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-01-32', '2026-1-01'])('rejects nonexistent/noncanonical date %s', from => {
    expect(() => validateResearchRule({ ...definition, development: { from, through: '2026-12-31' }, validation: undefined })).toThrow();
  });
  it('accepts a leap day but rejects reversed/inclusively overlapping windows and invalid time zones', () => {
    expect(validateResearchRule({ ...definition, development: { from: '2024-02-29', through: '2024-02-29' } }).development!.from).toBe('2024-02-29');
    expect(() => validateResearchRule({ ...definition, development: { from: '2026-01-31', through: '2026-01-01' } })).toThrow();
    expect(() => validateResearchRule({ ...definition, validation: { from: '2026-01-31', through: '2026-02-28' } })).toThrow();
    expect(() => validateResearchRule({ ...definition, timeZone: 'invalid-zone' })).toThrow();
    expect(() => validateResearchRule({ ...definition, targetPositions: 4 })).toThrow();
    expect(() => validateResearchRule({ ...definition, falsification: '   ' })).toThrow();
  });
});

describe('known exposure and immutable binding', () => {
  it('distinguishes a new never-revealed run, incomplete history and an already revealed overlapping session', () => {
    expect(exposure([run()]).status).toBe('no-known-exposure');
    expect(exposure([], [], false).status).toBe('unknown');
    const seen = run(); seen.runtimeState.maxRevealedTime = (MARKET + 60_000) / 1000;
    expect(exposure([seen])).toMatchObject({ status: 'already-observed', priorRunIds: ['run'] });
    const distant = run({ startAt: MARKET + 2 * 86_400_000, endAt: MARKET + 3 * 86_400_000 }); distant.runtimeState.maxRevealedTime = (MARKET + 3 * 86_400_000) / 1000;
    expect(exposure([distant]).status).toBe('no-known-exposure');
  });
  it('uses a nonzero visible cursor even if the stored maximum is the fresh zero sentinel', () => {
    const seen = run(); seen.runtimeState.replay.cursorTime = (MARKET + 60_000) / 1000;
    expect(exposure([seen]).status).toBe('already-observed');
  });
  it.each([undefined, NaN, Infinity, -1])('never certifies missing/invalid observation history: %s', max => {
    const legacy = run(); legacy.runtimeState.maxRevealedTime = max;
    expect(exposure([legacy]).status).toBe('unknown');
  });
  it('keeps the previous knowledge horizon after rewind and prioritizes observed evidence over incomplete history', () => {
    const seen = run(); seen.runtimeState.maxRevealedTime = (MARKET + 3_600_000) / 1000; seen.runtimeState.replay.cursorTime = MARKET / 1000 - 60;
    expect(exposure([seen], [], false).status).toBe('already-observed');
  });
  it('recognizes overlapping known outcomes including trades spanning the target interval', () => {
    expect(exposure([], [trade({ entryTime: MARKET - 60_000, timestamp: MARKET + 4_000_000 })])).toMatchObject({ status: 'already-observed', priorRunIds: ['run'] });
    expect(exposure([], [trade({ entryTime: NaN, timestamp: MARKET + 60_000 })]).status).toBe('already-observed');
    expect(exposure([], [trade({ timestamp: MARKET - 60_000 })]).status).toBe('no-known-exposure');
  });
  it('binds an exact immutable version/hash and exposes only a minimal trade reference', async () => {
    const exp = await experiment();
    const input = { experiment: exp, revisionId: 'r1', role: 'validation' as const, marketStart: Date.UTC(2026, 1, 2, 10), marketEnd: Date.UTC(2026, 1, 2, 11),
      recordedAt: WALL + 1, operationId: 'binding', runs: [], trades: [], historyComplete: true };
    const bound = await bindResearchRule(input);
    expect(bound).toMatchObject({ experimentId: 'experiment', revisionId: 'r1', revisionHash: exp.research!.revisions[0].hash, exposureAtBinding: 'no-known-exposure', role: 'validation' });
    const reference = researchTradeReference(bound)!;
    expect(Object.keys(reference).sort()).toEqual(['experimentId', 'id', 'revisionHash', 'revisionId', 'role']);
    expect(researchTradeReference()).toBeUndefined();
    bound.definition.rule = 'Changed local copy';
    expect(exp.research!.revisions[0].definition.rule).toBe('Wait for a retest.');
  });
  it('checks validation windows in the declared zone, not the browser/UTC calendar', async () => {
    const exp = await experiment();
    exp.research = await appendResearchRule({ ...initialInput(), definition: { ...definition, timeZone: 'America/New_York', validation: { from: '2026-02-01', through: '2026-02-01' } } });
    const input = { experiment: exp, revisionId: 'r1', role: 'validation' as const, marketStart: Date.parse('2026-02-02T00:30:00Z'), marketEnd: Date.parse('2026-02-02T02:00:00Z'), recordedAt: WALL,
      operationId: 'binding', runs: [], trades: [], historyComplete: true };
    await expect(bindResearchRule(input)).resolves.toMatchObject({ role: 'validation' });
    await expect(bindResearchRule({ ...input, marketEnd: Date.parse('2026-02-02T05:00:00Z') })).rejects.toThrow();
  });
  it('does not turn a known historical outcome into unexposed validation when binding', async () => {
    const exp = await experiment();
    const marketStart = Date.UTC(2026, 1, 2, 10), marketEnd = marketStart + 3_600_000;
    const result = await bindResearchRule({ experiment: exp, revisionId: 'r1', role: 'validation', marketStart, marketEnd, recordedAt: WALL,
      operationId: 'binding', runs: [], trades: [trade({ timestamp: marketStart })], historyComplete: true });
    expect(result.exposureAtBinding).toBe('already-observed'); expect(result.exposureReasons.length).toBeGreaterThan(0);
  });
  it('rejects missing validation plans, unknown revisions, legacy undated rules and clocks preceding registration', async () => {
    const exp = await experiment();
    const input = { experiment: exp, revisionId: 'r1', role: 'validation' as const, marketStart: Date.UTC(2026, 1, 2, 10), marketEnd: Date.UTC(2026, 1, 2, 11),
      recordedAt: WALL, operationId: 'binding', runs: [], trades: [], historyComplete: true };
    await expect(bindResearchRule({ ...input, revisionId: 'missing' })).rejects.toThrow();
    await expect(bindResearchRule({ ...input, recordedAt: WALL - 1 })).rejects.toThrow();
    await expect(bindResearchRule({ ...input, experiment: { ...exp, world: 'live' } })).rejects.toThrow();
    const withoutPlan = await appendResearchRule({ ...initialInput(), definition: { ...definition, validation: undefined } });
    await expect(bindResearchRule({ ...input, experiment: { ...exp, research: withoutPlan } })).rejects.toThrow();
    const legacy = await appendResearchRule({ ...initialInput(), legacy: { hypothesis: 'Old', rule: 'Old', targetTrades: 20 } });
    await expect(bindResearchRule({ ...input, experiment: { ...exp, research: legacy }, revisionId: 'r1-legacy' })).rejects.toThrow();
  });
});
