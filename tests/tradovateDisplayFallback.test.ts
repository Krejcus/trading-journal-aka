import { describe, expect, it, vi } from 'vitest';
import { createTradovateDisplayFallback } from '../lib/tradovateDisplayFallback';
import type { TradovatePreflightResult } from '../services/tradovateOAuthConnection';
const requestedAt = '2026-09-11T12:00:00.000Z';
const confirmedAt = '2026-09-11T12:00:01.000Z';
const legacyData = {connectionId:'c',environment:'demo',requestedAt,accounts:[
  {id:10,readState:{requestedAt,cashAsOf:confirmedAt},balance:{coverage:{availability:'available'},totalCashValue:50000,realizedPnL:0}},
  {id:11,readState:{requestedAt,cashAsOf:null},balance:{coverage:{availability:'unavailable'},totalCashValue:0}},
]} as unknown as TradovatePreflightResult;
describe('display compatibility reads', () => {
  it('uses only a targeted account when supported', async () => {
    const snapshot = {connectionId:'c',environment:'demo' as const,accountId:10,requestedAt,confirmedAt,fields:{totalCashValue:1}};
    const targeted = vi.fn().mockResolvedValue(snapshot); const legacy=vi.fn();
    const read=createTradovateDisplayFallback({targeted,legacy});
    expect(await read('c','demo',10)).toEqual({snapshots:[snapshot],legacy:false});
    expect(legacy).not.toHaveBeenCalled();
  });
  it('detects the old endpoint once and preserves exact legacy provenance and zero', async () => {
    const targeted=vi.fn().mockResolvedValue(null); const legacy=vi.fn().mockResolvedValue(legacyData);
    const read=createTradovateDisplayFallback({targeted,legacy});
    const result=await read('c','demo',10);
    expect(result.legacy).toBe(true);
    expect(result.snapshots).toEqual([{connectionId:'c',environment:'demo',accountId:10,requestedAt,confirmedAt,fields:{totalCashValue:50000,realizedPnL:0}}]);
    await read('c','demo',10); expect(targeted).toHaveBeenCalledTimes(1);
  });
  it('does not fall through a rate limit into an additional full request', async () => {
    const error=Object.assign(new Error('limited'),{status:429,retryAfterMs:90000});
    const legacy=vi.fn(); const read=createTradovateDisplayFallback({targeted:vi.fn().mockRejectedValue(error),legacy});
    await expect(read('c','demo',10)).rejects.toBe(error); expect(legacy).not.toHaveBeenCalled();
  });
  it('rejects a wrong environment and starts capability detection again for a new reader', async () => {
    const targeted=vi.fn().mockResolvedValue(null); const legacy=vi.fn().mockResolvedValue({...legacyData,environment:'live'});
    await expect(createTradovateDisplayFallback({targeted,legacy})('c','demo',10)).rejects.toThrow('display-connection-mismatch');
    await expect(createTradovateDisplayFallback({targeted,legacy})('c','demo',10)).rejects.toThrow();
    expect(targeted).toHaveBeenCalledTimes(2);
  });
});
