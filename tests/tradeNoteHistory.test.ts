import { describe, expect, it } from 'vitest';
import {
  MAX_TRADE_NOTE_TEXT_LENGTH, MAX_TRADE_NOTE_HISTORY_BYTES, appendTradeNoteOperation, buildTradeNoteHistoryPatch, createTradeNoteDrafts,
  emptyTradeNoteHistory, tradeNoteHeads, validateTradeNoteHistory,
  type TradeNoteCaptureContext, type TradeNoteDrafts, type TradeNoteHistory,
} from '../services/tradeNoteHistory';

const context: TradeNoteCaptureContext = {
  marketTime: 90, maxRevealedMarketTime: 90, entryMarketTime: 100, exitMarketTime: 200, closedTradeReview: false,
};
const drafts = (updates: Partial<TradeNoteDrafts> = {}): TradeNoteDrafts => ({ before: '', during: '', after: '', ...updates });
const save = (updates: Partial<TradeNoteDrafts>, history?: TradeNoteHistory, capture = context, operationId = 'op-1') =>
  buildTradeNoteHistoryPatch({ ...createTradeNoteDrafts(history), ...updates }, history, capture, { operationId, clientCapturedAt: 1_788_624_000_000 });

describe('phase note history', () => {
  it('keeps phase identities stable while appending amendments and preserves prior text', () => {
    const first = save({ before: 'Plán A', during: 'Řízení' });
    const original = JSON.stringify(first.history);
    const second = save({ before: 'Plán A – oprava', after: 'Výsledek' }, first.history, { ...context, closedTradeReview: true }, 'op-2');
    expect(second.expectedRevision).toBe(2);
    expect(second.history.revision).toBe(4);
    expect(JSON.stringify(first.history)).toBe(original);
    expect(second.history.revisions.slice(0, 2)).toEqual(first.history.revisions);
    const heads = tradeNoteHeads(second.history);
    expect(heads.before).toMatchObject({ noteId: 'note-op-1-before', supersedesId: 'op-1:before', parentRevision: 2, revision: 3, retrospective: true });
    expect(heads.after).toMatchObject({ supersedesId: null, revision: 4 });
    expect(createTradeNoteDrafts(second.history)).toEqual({ before: 'Plán A – oprava', during: 'Řízení', after: 'Výsledek' });
    expect(validateTradeNoteHistory(second.history)).toBe(second.history);
  });

  it('records clear as a revision without deleting prior text', () => {
    const original = save({ before: 'Neztratit původní plán' }).history;
    const cleared = save({ before: '' }, original, context, 'clear-1');
    expect(cleared.history.revisions).toHaveLength(2);
    expect(cleared.history.revisions[0].text).toBe('Neztratit původní plán');
    expect(tradeNoteHeads(cleared.history).before).toMatchObject({ operation: 'clear', text: '', supersedesId: 'op-1:before' });
    expect(createTradeNoteDrafts(cleared.history).before).toBe('');
  });

  it('does not create a revision for unchanged or empty drafts, or trim user content', () => {
    const empty = emptyTradeNoteHistory();
    expect(save({}, empty).history).toBe(empty);
    expect(save({}, empty).changed).toBe(false);
    const text = `  intro\r\n${'dlouhá poznámka '.repeat(1000)}\n  `;
    const first = save({ before: text });
    expect(first.history.revisions[0].text).toBe(text.replace(/\r\n/g, '\n'));
    expect(save({ before: text }, first.history, context, 'new-id').changed).toBe(false);
  });

  it('retries an identical operation idempotently even after another phase was saved', () => {
    const first = save({ before: 'A', during: 'B' });
    const later = save({ after: 'C' }, first.history, context, 'later');
    expect(appendTradeNoteOperation(later.history, first.operation)).toBe(later.history);
    expect(later.history.revisions).toHaveLength(3);
  });

  it.each([
    ['text', (op: ReturnType<typeof save>['operation']) => ({ ...op, edits: [{ phase: 'before' as const, text: 'other' }] })],
    ['capture time', (op: ReturnType<typeof save>['operation']) => ({ ...op, clientCapturedAt: op.clientCapturedAt + 1 })],
    ['cursor', (op: ReturnType<typeof save>['operation']) => ({ ...op, captureContext: { ...op.captureContext, marketTime: 89 } })],
    ['knowledge horizon', (op: ReturnType<typeof save>['operation']) => ({ ...op, captureContext: { ...op.captureContext, maxRevealedMarketTime: 200 } })],
    ['closed review flag', (op: ReturnType<typeof save>['operation']) => ({ ...op, captureContext: { ...op.captureContext, closedTradeReview: true } })],
    ['expected parent', (op: ReturnType<typeof save>['operation']) => ({ ...op, expectedRevision: 1 })],
  ])('rejects reuse of operation ID with changed %s', (_label, mutate) => {
    const first = save({ before: 'A' });
    expect(() => appendTradeNoteOperation(first.history, mutate(first.operation))).toThrow(/Stejné ID/);
  });

  it('rejects a stale concurrent append even when it edits a different phase; original draft stays intact', () => {
    const base = save({ before: 'Initial' }).history;
    const a = save({ before: 'A' }, base, context, 'a');
    const bDraft = { ...createTradeNoteDrafts(base), after: 'B' };
    const b = buildTradeNoteHistoryPatch(bDraft, base, context, { operationId: 'b', clientCapturedAt: 1234 });
    expect(() => appendTradeNoteOperation(a.history, b.operation)).toThrow(/mezitím změnila/);
    expect(bDraft.after).toBe('B');
    expect(base.revisions).toHaveLength(1);
    // Rebase is explicit: read latest, retain its phases, then apply only B's edit with a new operation.
    const resolved = save({ after: bDraft.after }, a.history, context, 'b-resolved');
    expect(createTradeNoteDrafts(resolved.history)).toEqual({ before: 'A', during: '', after: 'B' });
  });

  it('marks closed review before/during as retrospective even when cursor was rewound', () => {
    const result = save({ before: 'Před', during: 'Během' }, undefined, { ...context, closedTradeReview: true });
    expect(result.history.revisions.every(revision => revision.retrospective && revision.retrospectiveReason === 'closed-trade-review')).toBe(true);
    expect(result.history.revisions[0].marketTime).toBe(90);
    expect(result.history.revisions[0].clientCapturedAt).toBe(1_788_624_000_000);
  });

  it('preserves the revealed horizon through rewind, including amendments to an older phase', () => {
    const initial = save({ during: 'Already saw outcome' }, undefined, { ...context, marketTime: 200, maxRevealedMarketTime: 200 }).history;
    const rewound = save({ before: 'Rewound plan' }, initial, { ...context, marketTime: 80, maxRevealedMarketTime: 80 }, 'rewind');
    const note = tradeNoteHeads(rewound.history).before!;
    expect(note.marketTime).toBe(80);
    expect(note.knowledgeHorizonTime).toBe(200);
    expect(note.retrospectiveReason).toBe('outcome-already-revealed');
    expect(validateTradeNoteHistory(rewound.history)).toBe(rewound.history);
  });

  it('distinguishes a contemporaneous plan, same-candle uncertainty, and after reflection', () => {
    expect(save({ before: 'Known before entry' }).history.revisions[0].retrospective).toBe(false);
    expect(save({ during: 'Manage' }, undefined, { ...context, marketTime: 110, maxRevealedMarketTime: 110 }).history.revisions[0].retrospective).toBe(false);
    expect(save({ before: 'Same candle' }, undefined, { ...context, marketTime: 100, maxRevealedMarketTime: 100 }).history.revisions[0].retrospectiveReason).toBe('phase-already-passed');
    expect(save({ after: 'Reflection' }).history.revisions[0].retrospectiveReason).toBe('after-trade');
    expect(save({ before: 'Unknown timing' }, undefined, { ...context, entryMarketTime: null }).history.revisions[0].retrospectiveReason).toBe('timing-unverified');
  });

  it('never infers verified knowledge from a cursor when the max revealed horizon is unknown', () => {
    const result = save({ before: 'Legacy replay plan' }, undefined, { ...context, maxRevealedMarketTime: null });
    expect(result.history.revisions[0].marketTime).toBe(90);
    expect(result.history.revisions[0].knowledgeHorizonTime).toBe(90);
    expect(result.history.revisions[0].retrospectiveReason).toBe('timing-unverified');
  });

  it('marks a rewound note retrospective even when revealed future precedes trade entry', () => {
    const result = save({ before: 'I have already seen later candles' }, undefined, { ...context, marketTime: 80, maxRevealedMarketTime: 90 });
    expect(result.history.revisions[0].knowledgeHorizonTime).toBe(90);
    expect(result.history.revisions[0].retrospectiveReason).toBe('future-already-revealed');
  });

  it('never reclassifies a previously retrospective phase as contemporaneous', () => {
    const initial = save({ before: 'Late plan' }, undefined, { ...context, closedTradeReview: true }).history;
    const changed = save({ before: 'Earlier-looking plan' }, initial, context, 'changed');
    expect(tradeNoteHeads(changed.history).before!.retrospectiveReason).toBe('previous-retrospective-revision');
  });

  it.each([
    ['missing revision', (h: TradeNoteHistory) => { h.revision++; }],
    ['broken parent', (h: TradeNoteHistory) => { h.revisions[0].parentRevision = 9; }],
    ['forged classification', (h: TradeNoteHistory) => { h.revisions[0].retrospective = true; }],
    ['forged reason', (h: TradeNoteHistory) => { h.revisions[0].retrospectiveReason = 'timing-unverified'; }],
    ['lost horizon', (h: TradeNoteHistory) => { h.revisions[0].knowledgeHorizonTime = null; }],
    ['broken identity', (h: TradeNoteHistory) => { h.revisions[0].noteId = 'other'; }],
    ['missing context', (h: TradeNoteHistory) => { delete (h.revisions[0] as Partial<typeof h.revisions[0]>).captureContext; }],
  ])('refuses %s without silently dropping historical data', (_label, mutate) => {
    const history = structuredClone(save({ before: 'Must survive' }).history);
    mutate(history);
    const original = JSON.stringify(history);
    expect(() => save({ after: 'New' }, history, context, 'new')).toThrow();
    expect(JSON.stringify(history)).toBe(original);
  });

  it('limits new text without truncation, while still allowing an old long note to be inspected and cleared', () => {
    const text = 'a'.repeat(MAX_TRADE_NOTE_TEXT_LENGTH + 1);
    const draft = drafts({ before: text });
    expect(() => buildTradeNoteHistoryPatch(draft, undefined, context, { operationId: 'large', clientCapturedAt: 1234 })).toThrow(/nejvýše/);
    expect(draft.before).toBe(text);
    const old = structuredClone(save({ before: 'Initial' }).history);
    old.revisions[0].text = text;
    expect(createTradeNoteDrafts(old).before).toBe(text);
    const cleared = save({ before: '' }, old, context, 'clear-long');
    expect(cleared.history.revisions[0].text).toBe(text);
    expect(cleared.history.revisions[1].operation).toBe('clear');
  });

  it('refuses an append exceeding total UTF-8 capacity without deleting existing revisions', () => {
    const old = structuredClone(save({ before: 'Initial' }).history);
    // Existing validated data may have originated in a version with a higher limit.
    old.revisions[0].text = 'č'.repeat(MAX_TRADE_NOTE_HISTORY_BYTES / 2);
    const original = JSON.stringify(old);
    expect(() => save({ after: 'New addition' }, old, context, 'over-capacity')).toThrow(/kapacitu/);
    expect(JSON.stringify(old)).toBe(original);
    expect(tradeNoteHeads(old).before!.text.length).toBe(MAX_TRADE_NOTE_HISTORY_BYTES / 2);
  });

  it('rejects invalid timestamps and draft types; a failed build leaves input unchanged', () => {
    expect(() => save({ before: 'A' }, undefined, { ...context, marketTime: Infinity })).toThrow(/platnou/);
    expect(() => buildTradeNoteHistoryPatch(drafts({ before: 'A' }), undefined, context, { operationId: 'op', clientCapturedAt: 9e15 })).toThrow(/platnou/);
    expect(() => save({ before: 42 as unknown as string })).toThrow(/platný text/);
    expect(() => validateTradeNoteHistory({ version: 1, revision: 1, revisions: [null] } as unknown as TradeNoteHistory)).toThrow(/Historii/);
  });
});
