import { describe, expect, it } from 'vitest';
import type { Trade } from '../types';
import { combinedTradeChanges } from '../services/combinedTradePatch';
import { rollbackTradePatch } from '../services/tradePatch';
const master = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', isMaster: true, pnl: 100, riskAmount: 50, targetAmount: 100, positionSize: 2, notes: 'original', tags: ['keep'] } as Trade;
const follower = { ...master, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', isMaster: false, pnl: 50, riskAmount: 25, targetAmount: 50, positionSize: 1 } as Trade;
describe('combined trade patches', () => {
  it('scales each member while excluding unchanged review fields and identity', () => {
    const changes = combinedTradeChanges([master, follower], { pnl: 120, riskAmount: 60, targetAmount: 120, positionSize: 4, notes: 'original', accountId: 'different' });
    expect(changes[0].patch).toEqual({ pnl: 120, riskAmount: 60, targetAmount: 120, positionSize: 4 });
    expect(changes[1].patch).toEqual({ pnl: 60, riskAmount: 30, targetAmount: 60, positionSize: 2 });
    expect(changes[0].before).toBe(master);
  });
  it('does not invent a patch for unchanged values or a synthetic/nonexistent identity', () => {
    expect(combinedTradeChanges([master], { notes: 'original (Kombinováno z 2 účtů)' })).toEqual([]);
    expect(combinedTradeChanges([{ ...master, id: 'combined_group' }], { notes: 'new' })).toEqual([]);
  });
  it('keeps successful members and later fields when one member rolls back', () => {
    const changes = combinedTradeChanges([master, follower], { notes: 'changed' });
    const current = [{ ...master, ...changes[0].patch }, { ...follower, ...changes[1].patch, tags: ['added later'] }];
    const failed = changes[1];
    const next = current.map(trade => trade.id === failed.id ? rollbackTradePatch(trade, failed.before, failed.patch) : trade);
    expect(next[0].notes).toBe('changed'); expect(next[1].notes).toBe('original'); expect(next[1].tags).toEqual(['added later']);
    expect(rollbackTradePatch({ ...next[1], notes: 'newer own edit' }, failed.before, failed.patch).notes).toBe('newer own edit');
  });
});
