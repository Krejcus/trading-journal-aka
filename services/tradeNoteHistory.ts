export const MAX_TRADE_NOTE_TEXT_LENGTH = 20_000;
export const MAX_TRADE_NOTE_HISTORY_BYTES = 2 * 1024 * 1024;

export const TRADE_NOTE_PHASES = ['before', 'during', 'after'] as const;
export type TradeNotePhase = typeof TRADE_NOTE_PHASES[number];
export type TradeNoteDrafts = Record<TradeNotePhase, string>;
export interface TradeNoteCaptureContext {
  /** Actual cursor at capture, in UTC seconds; never an edited chart anchor. */
  marketTime: number | null;
  /** Monotonic maximum actually revealed to the user, including before rewind. */
  maxRevealedMarketTime: number | null;
  entryMarketTime?: number | null;
  exitMarketTime?: number | null;
  closedTradeReview: boolean;
}
export type RetrospectiveReason = 'closed-trade-review' | 'after-trade' | 'phase-already-passed' | 'outcome-already-revealed' | 'future-already-revealed' | 'timing-unverified' | 'previous-retrospective-revision';
export interface TradeNoteRevision {
  id: string;
  noteId: string;
  operationId: string;
  revision: number;
  parentRevision: number;
  supersedesId: string | null;
  phase: TradeNotePhase;
  operation: 'write' | 'clear';
  text: string;
  /** Client wall clock (UTC milliseconds). This is NOT server-authenticated time. */
  clientCapturedAt: number;
  /** Original capture facts; retained to identify a retry exactly. */
  captureContext: TradeNoteCaptureContext;
  marketTime: number | null;
  knowledgeHorizonTime: number | null;
  retrospective: boolean;
  retrospectiveReason: RetrospectiveReason | null;
  source: 'user';
}
export interface TradeNoteHistory {
  version: 1;
  revision: number;
  revisions: TradeNoteRevision[];
}
export interface TradeNoteOperation {
  operationId: string;
  expectedRevision: number;
  clientCapturedAt: number;
  captureContext: TradeNoteCaptureContext;
  edits: Array<{ phase: TradeNotePhase; text: string }>;
}
export interface TradeNoteHistoryPatch {
  history: TradeNoteHistory;
  expectedRevision: number;
  operation: TradeNoteOperation;
  changed: boolean;
}
const blankDrafts = (): TradeNoteDrafts => ({ before: '', during: '', after: '' });
const validTime = (time: unknown) => time === null || (typeof time === 'number' && Number.isFinite(time) && time >= 0 && time <= 8_640_000_000_000);
const validClientTime = (time: unknown) => typeof time === 'number' && Number.isSafeInteger(time) && time > 0 && time <= 8_640_000_000_000_000;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id);
const fail = (message: string): never => { throw new Error(message); };
const textValue = (text: string) => text.replace(/\r\n?/g, '\n');
export const emptyTradeNoteHistory = (): TradeNoteHistory => ({ version: 1, revision: 0, revisions: [] });

const canonicalContext = (context: TradeNoteCaptureContext): TradeNoteCaptureContext => ({
  marketTime: context.marketTime, maxRevealedMarketTime: context.maxRevealedMarketTime,
  entryMarketTime: context.entryMarketTime ?? null, exitMarketTime: context.exitMarketTime ?? null,
  closedTradeReview: context.closedTradeReview,
});
const validContext = (context: TradeNoteCaptureContext | null | undefined) => Boolean(context
  && validTime(context.marketTime) && validTime(context.maxRevealedMarketTime)
  && (context.entryMarketTime == null || validTime(context.entryMarketTime))
  && (context.exitMarketTime == null || validTime(context.exitMarketTime))
  && typeof context.closedTradeReview === 'boolean');
const contextEqual = (a: TradeNoteCaptureContext, b: TradeNoteCaptureContext) => JSON.stringify(canonicalContext(a)) === JSON.stringify(canonicalContext(b));
const knownHorizon = (context: TradeNoteCaptureContext, prior: number | null): number | null => {
  const values = [context.marketTime, context.maxRevealedMarketTime, prior].filter((value): value is number => value !== null);
  return values.length ? Math.max(...values) : null;
};
const retrospectiveReason = (phase: TradeNotePhase, context: TradeNoteCaptureContext, horizon: number | null, previous?: TradeNoteRevision): RetrospectiveReason | null => {
  if (context.closedTradeReview) return 'closed-trade-review';
  if (phase === 'after') return 'after-trade';
  if (previous?.retrospective) return 'previous-retrospective-revision';
  if (horizon === null || context.marketTime === null || context.maxRevealedMarketTime === null || context.entryMarketTime == null) return 'timing-unverified';
  if (context.exitMarketTime != null && horizon >= context.exitMarketTime) return 'outcome-already-revealed';
  if (horizon > context.marketTime) return 'future-already-revealed';
  if (phase === 'before' && horizon >= context.entryMarketTime) return 'phase-already-passed';
  if (phase === 'during' && context.marketTime < context.entryMarketTime) return 'timing-unverified';
  return null;
};

/** Reject malformed history; never normalize it by deleting unknown revisions.
 * Validation verifies internal consistency, not a trustworthy server timestamp. */
export const validateTradeNoteHistory = (history: TradeNoteHistory | undefined): TradeNoteHistory => {
  if (history === undefined) return emptyTradeNoteHistory();
  if (!history || history.version !== 1 || !Array.isArray(history.revisions)
    || !Number.isSafeInteger(history.revision) || history.revision !== history.revisions.length) {
    return fail('Historie poznámek má nepodporovaný formát. Původní data musí zůstat zachovaná.');
  }
  const heads = new Map<TradeNotePhase, TradeNoteRevision>();
  const ids = new Set<string>();
  const operations = new Set<string>();
  let horizon: number | null = null;
  let previousEntry: TradeNoteRevision | undefined;
  history.revisions.forEach((entry, index) => {
    if (!entry || !TRADE_NOTE_PHASES.includes(entry.phase) || !validContext(entry.captureContext)) {
      fail('Řetězec revizí poznámky není platný. Historii nelze přepsat.');
    }
    const previous = heads.get(entry.phase);
    const reason = retrospectiveReason(entry.phase, entry.captureContext, knownHorizon(entry.captureContext, horizon), previous);
    const sameOperation = previousEntry?.operationId === entry.operationId;
    if (!validId(entry.operationId)
      || entry.id !== `${entry.operationId}:${entry.phase}` || ids.has(entry.id)
      || entry.revision !== index + 1 || entry.parentRevision !== index
      || entry.supersedesId !== (previous?.id ?? null)
      || entry.noteId !== (previous?.noteId ?? `note-${entry.operationId}-${entry.phase}`)
      || typeof entry.text !== 'string' || textValue(entry.text) !== entry.text
      || !['write', 'clear'].includes(entry.operation) || (entry.operation === 'clear') !== (entry.text.length === 0)
      || !validClientTime(entry.clientCapturedAt)
      || !validTime(entry.marketTime) || !validTime(entry.knowledgeHorizonTime)
      || entry.marketTime !== entry.captureContext.marketTime
      || entry.knowledgeHorizonTime !== knownHorizon(entry.captureContext, horizon)
      || entry.retrospective !== (reason !== null) || entry.retrospectiveReason !== reason || entry.source !== 'user'
      || (!sameOperation && operations.has(entry.operationId))
      || (sameOperation && (!contextEqual(entry.captureContext, previousEntry!.captureContext)
        || entry.clientCapturedAt !== previousEntry!.clientCapturedAt
        || TRADE_NOTE_PHASES.indexOf(entry.phase) <= TRADE_NOTE_PHASES.indexOf(previousEntry!.phase)))) {
      fail('Řetězec revizí poznámky není platný. Historii nelze přepsat.');
    }
    horizon = entry.knowledgeHorizonTime; previousEntry = entry;
    ids.add(entry.id); operations.add(entry.operationId); heads.set(entry.phase, entry);
  });
  return history;
};
export const tradeNoteHeads = (history?: TradeNoteHistory): Partial<Record<TradeNotePhase, TradeNoteRevision>> => {
  const result: Partial<Record<TradeNotePhase, TradeNoteRevision>> = {};
  for (const revision of validateTradeNoteHistory(history).revisions) result[revision.phase] = revision;
  return result;
};
export const createTradeNoteDrafts = (history?: TradeNoteHistory): TradeNoteDrafts => {
  const drafts = blankDrafts();
  for (const entry of Object.values(tradeNoteHeads(history))) drafts[entry.phase] = entry.text;
  return drafts;
};
const validateOperation = (operation: TradeNoteOperation) => {
  if (!operation || !validId(operation.operationId) || !Number.isSafeInteger(operation.expectedRevision) || operation.expectedRevision < 0
    || !validClientTime(operation.clientCapturedAt) || !validContext(operation.captureContext)
    || !Array.isArray(operation.edits) || operation.edits.length > TRADE_NOTE_PHASES.length
    || operation.edits.some(edit => !edit || !TRADE_NOTE_PHASES.includes(edit.phase) || typeof edit.text !== 'string')
    || new Set(operation.edits.map(edit => edit.phase)).size !== operation.edits.length) {
    fail('Poznámka nemá platnou identitu, čas nebo fázi.');
  }
};
/** Atomic command reducer. Storage must separately compare the original whole
 * history value/revision. A matching existing operation is acknowledged unchanged. */
export const appendTradeNoteOperation = (baseHistory: TradeNoteHistory | undefined, operation: TradeNoteOperation): TradeNoteHistory => {
  const base = validateTradeNoteHistory(baseHistory);
  validateOperation(operation);
  const existing = base.revisions.filter(entry => entry.operationId === operation.operationId);
  if (existing.length) {
    const expectedEdits = [...operation.edits].sort((a, b) => TRADE_NOTE_PHASES.indexOf(a.phase) - TRADE_NOTE_PHASES.indexOf(b.phase));
    const same = existing.length === expectedEdits.length && existing.every((entry, index) =>
      entry.phase === expectedEdits[index].phase && entry.text === textValue(expectedEdits[index].text)
      && entry.clientCapturedAt === operation.clientCapturedAt
      && contextEqual(entry.captureContext, operation.captureContext)
      && existing[0].parentRevision === operation.expectedRevision);
    if (!same) return fail('Stejné ID ukládání už patří jiné poznámce. Nová úprava potřebuje nové ID.');
    return base;
  }
  if (operation.edits.some(edit => textValue(edit.text).length > MAX_TRADE_NOTE_TEXT_LENGTH)) {
    return fail(`Jedna poznámka může mít nejvýše ${MAX_TRADE_NOTE_TEXT_LENGTH.toLocaleString('cs-CZ')} znaků. Rozepsaný text zůstává zachovaný.`);
  }
  if (base.revision !== operation.expectedRevision) return fail('Historie poznámek se mezitím změnila. Porovnejte nové revize a svůj rozepsaný text.');
  const context = operation.captureContext;
  const horizon = knownHorizon(context, base.revisions.at(-1)?.knowledgeHorizonTime ?? null);
  const heads = tradeNoteHeads(base);
  const revisions = [...base.revisions];
  for (const phase of TRADE_NOTE_PHASES) {
    const edit = operation.edits.find(item => item.phase === phase);
    if (!edit) continue;
    const previous = heads[phase];
    const reason = retrospectiveReason(phase, context, horizon, previous);
    const text = textValue(edit.text);
    const revision: TradeNoteRevision = {
      id: `${operation.operationId}:${phase}`, noteId: previous?.noteId ?? `note-${operation.operationId}-${phase}`,
      operationId: operation.operationId, revision: revisions.length + 1, parentRevision: revisions.length,
      supersedesId: previous?.id ?? null, phase, operation: text.length ? 'write' : 'clear', text,
      clientCapturedAt: operation.clientCapturedAt, captureContext: canonicalContext(context), marketTime: context.marketTime,
      knowledgeHorizonTime: horizon, retrospective: reason !== null, retrospectiveReason: reason, source: 'user',
    };
    revisions.push(revision); heads[phase] = revision;
  }
  if (revisions.length === base.revision) return base;
  const history: TradeNoteHistory = { version: 1, revision: revisions.length, revisions };
  if (new TextEncoder().encode(JSON.stringify(history)).byteLength > MAX_TRADE_NOTE_HISTORY_BYTES) {
    return fail('Historie poznámek překročila kapacitu 2 MiB. Původní historie i rozepsaný text zůstávají zachované; další revizi nyní nelze uložit.');
  }
  return history;
};

/** Call only at Save. Keep options and returned operation stable across retries;
 * create a new operation ID only when the user changes the draft. */
export const buildTradeNoteHistoryPatch = (
  drafts: TradeNoteDrafts, baseHistory: TradeNoteHistory | undefined,
  captureContext: TradeNoteCaptureContext, options: { operationId: string; clientCapturedAt: number },
): TradeNoteHistoryPatch => {
  const base = validateTradeNoteHistory(baseHistory);
  if (!drafts || TRADE_NOTE_PHASES.some(phase => typeof drafts[phase] !== 'string')) {
    fail('Rozepsané poznámky nemají platný text.');
  }
  const current = createTradeNoteDrafts(base);
  const operation: TradeNoteOperation = {
    ...options, expectedRevision: base.revision, captureContext: { ...captureContext },
    edits: TRADE_NOTE_PHASES.filter(phase => textValue(drafts[phase]) !== current[phase])
      .map(phase => ({ phase, text: textValue(drafts[phase]) })),
  };
  const history = appendTradeNoteOperation(base, operation);
  return { history, expectedRevision: base.revision, operation, changed: history !== base };
};
