import { describe, expect, it } from 'vitest';
import { changedTradeFields, rollbackTradePatch } from '../services/tradePatch';
import type { Trade } from '../types';

describe('review patch boundaries', () => {
  it('a notes edit does not send untouched tags, images, analytics or immutable identity', () => {
    const before = { id: 't', accountId: 'a', notes: 'old', tags: ['A'], screenshot: 'original', entryContext: { b: 2, a: 1 } };
    expect(changedTradeFields(before, { ...before, id: 'other', notes: 'new', entryContext: { a: 1, b: 2 } })).toEqual({ notes: 'new' });
  });
  it('omission is not clearing; empty arrays and null are deliberate changes', () => {
    expect(changedTradeFields({ tags: ['A'], notes: 'kept' }, { tags: [], notes: undefined })).toEqual({ tags: [] });
    expect(changedTradeFields({ entryContext: { a: 1 } }, { entryContext: null })).toEqual({ entryContext: null });
  });
  it('a failed earlier save cannot roll back later notes or unrelated tags', () => {
    const before = { id: 't', notes: 'old', tags: ['A'] } as Trade;
    const current = { ...before, notes: 'third edit', tags: ['B'] };
    expect(rollbackTradePatch(current, before, { notes: 'second edit' })).toEqual(current);
    expect(rollbackTradePatch({ ...current, notes: 'second edit' }, before, { notes: 'second edit' })).toEqual({ ...current, notes: 'old' });
  });
});
