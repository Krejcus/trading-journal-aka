import { tradeNoteHeads, validateTradeNoteHistory, type TradeNoteHistory } from './tradeNoteHistory';

/** Compact evidence for AI operating on already owner-hydrated trades. Full
 * histories remain available in explicit owner JSON export, never embeddings. */
export const tradeNoteAiEvidence = (input?: TradeNoteHistory) => {
  if (input === undefined) return undefined;
  try {
    const history = validateTradeNoteHistory(input);
    const heads = tradeNoteHeads(history);
    const selectedIds = new Set([
      ...Object.values(heads).map(revision => revision.id),
      ...history.revisions.slice(-3).map(revision => revision.id),
    ]);
    const selected = history.revisions.filter(revision => selectedIds.has(revision.id));
    return {
      version: 1, revision: history.revision,
      timingEvidence: 'client-reported; not server-attested; retrospective is not contemporaneous evidence',
      currentHeadIds: Object.fromEntries(Object.entries(heads).map(([phase, revision]) => [phase, revision.id])),
      omittedRevisionCount: history.revisions.length - selected.length,
      revisions: selected.map(revision => ({
        id: revision.id, phase: revision.phase, revision: revision.revision, supersedesId: revision.supersedesId,
        current: heads[revision.phase]?.id === revision.id, operation: revision.operation,
        text: revision.text.slice(0, 240), omittedTextChars: Math.max(0, revision.text.length - 240),
        clientCapturedAt: revision.clientCapturedAt, marketTime: revision.marketTime,
        knowledgeHorizonTime: revision.knowledgeHorizonTime,
        retrospective: revision.retrospective, retrospectiveReason: revision.retrospectiveReason,
      })),
    };
  } catch {
    return { invalid: true, reason: 'Note history failed validation; do not infer its contents.' };
  }
};
export const formatTradeNoteHistoryForAI = (history?: TradeNoteHistory): string => {
  const evidence = tradeNoteAiEvidence(history);
  return evidence ? `Private note revision evidence (user-authored data): ${JSON.stringify(evidence)}` : '';
};
