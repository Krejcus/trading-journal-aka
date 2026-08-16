/**
 * Supabase JSONB can return booleans either as booleans or text. Missing
 * validity must stay undefined: coercing it to false incorrectly classifies
 * every replay trade without a manual review as invalid / outside the plan.
 */
export const parseOptionalTradeValidity = (value: unknown): boolean | undefined => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
};
