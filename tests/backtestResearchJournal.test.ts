import { describe, expect, it } from 'vitest';
import { createBacktestRuntime } from '../services/backtestEngine';
import {
  appendBacktestResearch, backtestDecisionSummary, captureBacktestResearchContext,
  latestBacktestResearch, reviseBacktestResearch,
  type BacktestResearchContext, type BacktestResearchDraft, type BacktestResearchJournal,
} from '../services/backtestResearchJournal';
import type { MarketCandle } from '../services/marketData';

const WALL = Date.UTC(2026, 8, 5, 10);
const CANDLE: MarketCandle = { time: 120, open: 100, high: 103, low: 99, close: 101, volume: 20 };
const SNAPSHOT = 'data:image/png;base64,YWJjZA==';
const draft: BacktestResearchDraft = { kind: 'decision', action: 'skipped', title: ' Breakout ', text: ' No follow-through ', tags: [' A ', 'A'] };
function runtime(cursorTime = 120, maxRevealedTime: number | undefined = 0) {
  const state = createBacktestRuntime(10_000);
  state.replay.cursorTime = cursorTime;
  state.maxRevealedTime = maxRevealedTime;
  return state;
}
function context(patch: Partial<BacktestResearchContext> = {}): BacktestResearchContext {
  return { ...captureBacktestResearchContext({ runId: 'run', instrument: 'MNQ', runtime: runtime(), candles: [CANDLE], runCompleted: false }), ...patch };
}
const append = () => appendBacktestResearch(undefined, { ...draft, phase: 'before', screenshotDataUrl: SNAPSHOT }, context(), WALL, 'append-1');
function revision() {
  const first = append();
  const input = { journal: first.journal, id: first.record.id, expectedRevisionId: first.record.revisionId,
    patch: { text: 'Reviewed later' }, context: context({ marketTime: 180, knowledgeHorizonTime: 180 }), recordedAt: WALL + 100, opId: 'revise-1' };
  return { first, input, second: reviseBacktestResearch(input) };
}

describe('research context knowledge horizon', () => {
  it('captures only the latest revealed bar, regardless of future candles or input order', () => {
    const state = runtime();
    const future = { ...CANDLE, time: 180, high: 99_999 };
    const captured = captureBacktestResearchContext({ runId: 'run', instrument: 'MNQ', runtime: state, candles: [future, CANDLE, { ...CANDLE, time: 60 }], runCompleted: false });
    expect(captured).toMatchObject({ marketTime: 120, knowledgeHorizonTime: 120, knowledgeState: 'current', bar: CANDLE });
    expect(captured).toEqual(context());
    future.high = 1e8; captured.bar!.high = 5;
    expect(CANDLE.high).toBe(103);
    expect(state).toEqual(runtime());
  });
  it.each([undefined, NaN, Infinity, -1])('keeps missing or invalid persistent history unknown: %s', (maximum) => {
    const state = runtime(); state.maxRevealedTime = maximum;
    const captured = captureBacktestResearchContext({ runId: 'run', instrument: 'MNQ', runtime: state, candles: [CANDLE], runCompleted: false });
    const saved = appendBacktestResearch(undefined, { kind: 'prep' }, captured, WALL);
    expect(captured).toMatchObject({ knowledgeState: 'unknown', knowledgeHorizonTime: null });
    expect(saved.record).toMatchObject({ phase: 'before', phaseVerified: false, retrospective: true });
  });
  it('does not certify a pre-trade note after rewind even if runtime execution arrays are empty', () => {
    const captured = captureBacktestResearchContext({ runId: 'run', instrument: 'MNQ', runtime: runtime(120, 600), candles: [CANDLE], runCompleted: false });
    expect(captured).toMatchObject({ knowledgeState: 'rewound', knowledgeHorizonTime: 600, hasExecutionHistory: false });
    expect(appendBacktestResearch(undefined, { kind: 'prep' }, captured, WALL).record).toMatchObject({ phaseVerified: false, retrospective: true });
    expect(appendBacktestResearch(undefined, draft, captured, WALL).record.retrospective).toBe(true);
  });
  it('certifies only evidence appropriate to the explicitly requested phase', () => {
    expect(append().record).toMatchObject({ phaseVerified: true, retrospective: false });
    const active = context({ hasExecutionHistory: true, positionIds: ['position'] });
    expect(appendBacktestResearch(undefined, { kind: 'prep' }, active, WALL).record.phaseVerified).toBe(false);
    expect(appendBacktestResearch(undefined, { kind: 'note', phase: 'during' }, active, WALL).record.phaseVerified).toBe(true);
    const finishedTrade = context({ hasExecutionHistory: true, closedTradeIds: ['closed'] });
    expect(appendBacktestResearch(undefined, { kind: 'note', phase: 'after' }, finishedTrade, WALL).record.phaseVerified).toBe(true);
    expect(appendBacktestResearch(undefined, { kind: 'debrief' }, finishedTrade, WALL).record.phaseVerified).toBe(false);
    expect(appendBacktestResearch(undefined, { kind: 'debrief' }, context({ runCompleted: true }), WALL).record.phaseVerified).toBe(true);
    expect(appendBacktestResearch(undefined, { kind: 'debrief' }, { ...active, runCompleted: true }, WALL).record.phaseVerified).toBe(false);
  });
  it('scopes position/order/closed IDs to the visible instrument and cursor, while retaining cross-instrument history', () => {
    const state = runtime();
    const position = { positionId: 'position-nq', instrument: 'NQ' as const, side: 'long' as const, quantity: 1,
      averagePrice: 100, openedAt: 60, entryFillIds: ['entry'], entryCommission: 0 };
    state.positions = [position];
    const order = { id: 'pending-mnq', runId: 'run', instrument: 'MNQ' as const, side: 'buy' as const, type: 'limit' as const,
      status: 'pending' as const, quantity: 1, remainingQuantity: 1, limitPrice: 90, createdAt: 60, updatedAt: 60 };
    state.orders = [order, { ...order, id: 'cancelled', status: 'cancelled' }, { ...order, id: 'pending-nq', instrument: 'NQ' }];
    const trade = { id: 'closed-mnq', runId: 'run', instrument: 'MNQ' as const, direction: 'Long' as const, quantity: 1,
      entryPrice: 100, exitPrice: 101, entryTime: 60, exitTime: 120, grossPnl: 2, commission: 0, pnl: 2, reason: 'manual' as const };
    state.closedTrades = [trade, { ...trade, id: 'future', exitTime: 180 }, { ...trade, id: 'closed-nq', instrument: 'NQ' }];
    const before = structuredClone(state);
    const captured = captureBacktestResearchContext({ runId: 'run', instrument: 'MNQ', runtime: state, candles: [CANDLE], runCompleted: false });
    expect(captured).toMatchObject({ positionIds: [], pendingOrderIds: ['pending-mnq'], closedTradeIds: ['closed-mnq'], hasExecutionHistory: true });
    expect(appendBacktestResearch(undefined, { kind: 'prep' }, captured, WALL).record.phaseVerified).toBe(false);
    expect(state).toEqual(before);
    state.orders = []; state.closedTrades = [];
    expect(captureBacktestResearchContext({ runId: 'run', instrument: 'MNQ', runtime: state, candles: [], runCompleted: false }).hasExecutionHistory).toBe(true);
  });
  it('rejects absent cursor, future snapshot, malformed OHLC, and contradictory knowledge evidence', () => {
    const state = runtime(); state.replay.cursorTime = null;
    expect(() => captureBacktestResearchContext({ runId: 'run', instrument: 'MNQ', runtime: state, candles: [], runCompleted: false })).toThrow();
    for (const patch of [
      { bar: { ...CANDLE, time: 121 } }, { bar: { ...CANDLE, high: 90 } }, { bar: { ...CANDLE, volume: NaN } },
      { knowledgeHorizonTime: 119 }, { knowledgeState: 'unknown' as const }, { knowledgeHorizonTime: null },
      { hasExecutionHistory: false, positionIds: ['p'] }, { positionIds: ['p', 'p'] },
    ]) expect(() => appendBacktestResearch(undefined, draft, context(patch), WALL)).toThrow();
  });
});

describe('immutable and idempotent research journal', () => {
  it('retries an append after the cursor and client clock advance without a second record', () => {
    const first = append();
    const retry = appendBacktestResearch(first.journal, { ...draft, phase: 'before', screenshotDataUrl: SNAPSHOT },
      context({ marketTime: 180, knowledgeHorizonTime: 180 }), WALL + 1_000, 'append-1');
    expect(retry).toEqual(first);
    expect(retry.record).toMatchObject({ title: 'Breakout', text: 'No follow-through', tags: ['A'], clockSource: 'client' });
    expect(() => appendBacktestResearch(first.journal, { ...draft, title: 'Different intention' }, context(), WALL, 'append-1')).toThrow(/jinému záměru/);
  });
  it('keeps original context and clock while making every edit explicitly retrospective', () => {
    const { first, second } = revision();
    expect(second.record).toMatchObject({ revision: 2, previousRevisionId: first.record.revisionId, context: first.record.context,
      firstRecordedAt: WALL, recordedAt: WALL + 100, revisionMarketTime: 180, retrospective: true, phaseVerified: false, clockSource: 'client' });
    expect(second.journal.revisions[0]).toEqual(first.record);
    expect(second.record.screenshotDataUrl).toBeUndefined();
    expect(second.journal.revisions.filter(item => item.screenshotDataUrl)).toHaveLength(1);
    expect(latestBacktestResearch(second.journal)[0].screenshotDataUrl).toBe(SNAPSHOT);
  });
  it('retries a committed revision with its original expected ID, including after later edits', () => {
    const { input, second } = revision();
    expect(reviseBacktestResearch({ ...input, journal: second.journal, recordedAt: WALL + 900 })).toEqual(second);
    const third = reviseBacktestResearch({ ...input, journal: second.journal, expectedRevisionId: second.record.revisionId, patch: { title: 'Another edit' }, opId: 'revise-2', recordedAt: WALL + 200 });
    const retried = reviseBacktestResearch({ ...input, journal: third.journal, recordedAt: WALL + 300 });
    expect(retried.journal).toEqual(third.journal);
    expect(retried.record).toEqual(second.record);
    expect(() => reviseBacktestResearch({ ...input, journal: second.journal, opId: 'new-operation' })).toThrow(/jiné okno/);
    expect(() => reviseBacktestResearch({ ...input, journal: second.journal, patch: { text: 'Changed retry' } })).toThrow(/jinému záměru/);
  });
  it('does not let caller mutation alter a previous journal, stored snapshot, or separately returned record', () => {
    const originalContext = context();
    const first = appendBacktestResearch(undefined, draft, originalContext, WALL);
    originalContext.bar!.high = 1_000;
    first.record.context.bar!.high = 2_000;
    expect(first.journal.revisions[0].context.bar!.high).toBe(103);
    const next = appendBacktestResearch(first.journal, { kind: 'bookmark' }, context(), WALL + 1);
    next.journal.revisions[0].tags.push('mutated');
    expect(first.journal.revisions[0].tags).toEqual(['A']);
    const latest = latestBacktestResearch(first.journal); latest[0].title = 'mutated';
    expect(first.journal.revisions[0].title).toBe('Breakout');
  });
  it('rejects cross-session operations, mutation of immutable fields, and backward audit clocks', () => {
    const { first, input } = revision();
    expect(() => appendBacktestResearch(first.journal, draft, context({ runId: 'other' }), WALL)).toThrow(/jiné session/);
    expect(() => reviseBacktestResearch({ ...input, context: context({ runId: 'other' }) })).toThrow();
    expect(() => reviseBacktestResearch({ ...input, recordedAt: WALL - 1 })).toThrow(/hodiny/);
    expect(() => reviseBacktestResearch({ ...input, patch: { context: context() } as never })).toThrow(/pouze obsah/);
    expect(() => reviseBacktestResearch({ ...input, patch: { archived: 'yes' } as never })).toThrow();
  });
  it('counts only latest non-archived manually recorded decisions without changing trading state', () => {
    const state = runtime(); const before = structuredClone(state);
    let journal: BacktestResearchJournal | undefined;
    for (const action of ['taken', 'skipped', 'missed', 'no-setup'] as const) {
      journal = appendBacktestResearch(journal, { kind: 'decision', action }, context(), WALL, action).journal;
    }
    journal = appendBacktestResearch(journal, { kind: 'note', text: 'Narrative only' }, context(), WALL).journal;
    const taken = latestBacktestResearch(journal)[0];
    journal = reviseBacktestResearch({ journal, id: taken.id, expectedRevisionId: taken.revisionId, patch: { archived: true }, context: context(), recordedAt: WALL }).journal;
    expect(backtestDecisionSummary(journal)).toMatchObject({ total: 3, taken: 0, skipped: 1, missed: 1, noSetup: 1, collection: 'manual' });
    expect(backtestDecisionSummary(journal).limitation).toContain('nejde o všechny');
    expect(latestBacktestResearch(journal)).toHaveLength(4);
    expect(latestBacktestResearch(journal, true)).toHaveLength(5);
    expect(state).toEqual(before);
  });
});

describe('research journal history validation', () => {
  it.each<[string, (journal: BacktestResearchJournal) => void]>([
    ['skipped revision', (j: BacktestResearchJournal) => { j.revisions[1].revision = 3; }],
    ['orphan revision', (j: BacktestResearchJournal) => { j.revisions.shift(); }],
    ['incorrect parent', (j: BacktestResearchJournal) => { j.revisions[1].previousRevisionId = 'unrelated'; }],
    ['duplicate revision identity', (j: BacktestResearchJournal) => { j.revisions[1].revisionId = j.revisions[0].revisionId; }],
    ['duplicate operation identity', (j: BacktestResearchJournal) => { j.revisions[1].opId = j.revisions[0].opId; }],
    ['altered initial context', (j: BacktestResearchJournal) => { j.revisions[1].context.bar!.close = 102; }],
    ['altered phase', (j: BacktestResearchJournal) => { j.revisions[1].phase = 'after'; }],
    ['altered initial clock', (j: BacktestResearchJournal) => { j.revisions[1].firstRecordedAt -= 1; }],
    ['backward clock', (j: BacktestResearchJournal) => { j.revisions[1].recordedAt = WALL - 1; }],
    ['non-retrospective revision', (j: BacktestResearchJournal) => { j.revisions[1].retrospective = false; }],
    ['false verified revision', (j: BacktestResearchJournal) => { j.revisions[1].phaseVerified = true; }],
    ['duplicate screenshot', (j: BacktestResearchJournal) => { j.revisions[1].screenshotDataUrl = SNAPSHOT; }],
    ['false first evidence', (j: BacktestResearchJournal) => { j.revisions[0].phaseVerified = false; }],
    ['cross-run history', (j: BacktestResearchJournal) => { j.revisions[1].context.runId = 'other'; }],
    ['claimed server clock', (j: BacktestResearchJournal) => { j.revisions[0].clockSource = 'server' as never; }],
  ])('refuses %s before returning or extending history', (_name, corrupt) => {
    const journal = structuredClone(revision().second.journal); corrupt(journal);
    expect(() => latestBacktestResearch(journal)).toThrow();
    expect(() => appendBacktestResearch(journal, draft, context(), WALL + 1_000)).toThrow();
  });
  it.each([
    { kind: 'decision', action: 'unknown' }, { kind: 'note', action: 'taken' }, { kind: 'note', text: 42 },
    { kind: 'note', tags: 'single' }, { kind: 'note', tags: [42] }, { kind: 'note', title: 'x'.repeat(121) },
    { kind: 'note', tags: Array.from({ length: 31 }, (_, i) => String(i)) },
    { kind: 'note', screenshotDataUrl: 'https://external/image.png' },
    { kind: 'note', screenshotDataUrl: `data:image/png;base64,${'a'.repeat(700_001)}` },
  ])('rejects malformed or over-limit content %#', (invalid) => {
    expect(() => appendBacktestResearch(undefined, invalid as BacktestResearchDraft, context(), WALL)).toThrow();
  });
  it('enforces the aggregate storage limit without modifying the existing history', () => {
    const screenshotDataUrl = `data:image/png;base64,${'a'.repeat(680_000)}`;
    const initial = appendBacktestResearch(undefined, { kind: 'bookmark', screenshotDataUrl }, context(), WALL).record;
    // Seven distinct records with the same valid content; avoid repeatedly cloning megabytes during fixture setup.
    const journal: BacktestResearchJournal = { version: 1, revisions: Array.from({ length: 7 }, (_, i) => ({
      ...structuredClone(initial), id: `record-${i}`, revisionId: `revision-${i}`, opId: `operation-${i}`,
    })) };
    const before = JSON.stringify(journal);
    expect(() => appendBacktestResearch(journal, { kind: 'bookmark', screenshotDataUrl }, context(), WALL)).toThrow(/5 MB/);
    expect(JSON.stringify(journal)).toBe(before);
  }, 20_000);
});
