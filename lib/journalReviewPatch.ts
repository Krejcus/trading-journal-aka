import type { Trade } from '../types.js';

/** Review labels are editable; executions and their provenance belong to the broker. */
export const JOURNAL_REVIEW_FIELDS = new Set([
  'notes', 'sessionPreNotes', 'sessionPostNotes', 'screenshot', 'screenshots', 'drawings',
  'signal', 'emotions', 'mistakes', 'planAdherence', 'isValid', 'executionStatus', 'needsReview',
  'setupType', 'tags', 'htfConfluence', 'ltfConfluence', 'enrichmentSkipped', 'isBE',
  'slPlacement', 'targetType', 'targetLevel', 'management', 'shareNotes', 'isPublic',
  'miniViewRange', 'miniViewLayout', 'miniViewSecondaryRange', 'miniViewSecondaryTimeframe',
]);
export const journalReviewOnly = (trade: Partial<Trade>) => trade.copierTradeId?.startsWith('journal:') === true;

export function journalReviewPatch(before: Partial<Trade>, proposed: Partial<Trade>): Partial<Trade> {
  if (!journalReviewOnly(before)) return proposed;
  return Object.fromEntries(Object.entries(proposed).filter(([key, value]) => JOURNAL_REVIEW_FIELDS.has(key)
    && (key !== 'executionStatus' || value === 'Valid' || value === 'Invalid')));
}
