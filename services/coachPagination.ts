export interface CoachPagination {
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
}

/**
 * Build one lossless cursor-like page from a result that was fetched with one
 * look-ahead row. App Coach and MCP share this exact contract.
 */
export function createCoachPage<T>(rowsWithLookahead: T[], offset: number, limit: number): {
  rows: T[];
  pagination: CoachPagination;
} {
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 50), 200));
  const hasMore = rowsWithLookahead.length > safeLimit;
  return {
    rows: rowsWithLookahead.slice(0, safeLimit),
    pagination: {
      offset: safeOffset,
      limit: safeLimit,
      has_more: hasMore,
      next_offset: hasMore ? safeOffset + safeLimit : null,
    },
  };
}
