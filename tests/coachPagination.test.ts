import { describe, expect, it } from 'vitest';
import { createCoachPage } from '../services/coachPagination';

describe('Coach canonical record pagination', () => {
  it('vrátí next_offset jen když existuje look-ahead záznam', () => {
    expect(createCoachPage([1, 2, 3], 0, 2)).toEqual({
      rows: [1, 2],
      pagination: { offset: 0, limit: 2, has_more: true, next_offset: 2 },
    });
    expect(createCoachPage([3], 2, 2)).toEqual({
      rows: [3],
      pagination: { offset: 2, limit: 2, has_more: false, next_offset: null },
    });
  });

  it('normalizuje nebezpečné hodnoty stejně pro app i MCP', () => {
    const result = createCoachPage(Array.from({ length: 205 }, (_, index) => index), -4, 999);
    expect(result.rows).toHaveLength(200);
    expect(result.pagination).toEqual({ offset: 0, limit: 200, has_more: true, next_offset: 200 });
  });
});
