import { describe, expect, it, vi } from 'vitest';
import { BACKTEST_REVIEW_RPC, requestBacktestReviewPatch } from '../services/backtestReviewPersistence';
const snapshot = { ownerId: 'user-a', authVersion: 2, data: { notes: 'original', tags: ['old'] } };
describe('backtest atomic review transport', () => {
  it('sends only changed expected fields in the RPC POST body and strips identity changes', async () => {
    const rpc = vi.fn(async () => ({ data: { id: 'trade-1', data: { notes: 'new', tags: ['current'] } }, error: null }));
    const result = await requestBacktestReviewPatch({ rpc }, 'trade-1', snapshot, { id: 'other', notes: 'new' });
    expect(rpc).toHaveBeenCalledWith(BACKTEST_REVIEW_RPC, { p_trade_id: 'trade-1', p_owner_id: 'user-a', p_updates: { notes: 'new' }, p_expected: { notes: 'original' }, p_append_screenshot: null });
    expect(result.tags).toEqual(['current']);
  });
  it('requires database activation instead of falling back to a blind update', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: 'PGRST202' } }));
    await expect(requestBacktestReviewPatch({ rpc }, 'trade-1', snapshot, {})).rejects.toThrow('není aktivované');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('surfaces an edited-field conflict without retrying', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: '40001' } }));
    await expect(requestBacktestReviewPatch({ rpc }, 'trade-1', snapshot, { notes: 'new' })).rejects.toThrow('jiné okno');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects an unrelated or absent acknowledgement', async () => {
    const rpc = vi.fn(async () => ({ data: { id: 'different', data: {} }, error: null }));
    await expect(requestBacktestReviewPatch({ rpc }, 'trade-1', snapshot, {})).rejects.toThrow('nebylo potvrzeno');
  });
});
