import { describe, expect, it } from 'vitest';
import { TradovateRequestError } from '../services/tradovateOAuthConnection';
import { createTradovateSoftReadDeferrals, tradovateSoftReadDelay } from '../lib/tradovateSoftReadDeferrals';

describe('display-only local-budget deferrals', () => {
  it.each([null, undefined, -1, NaN, Infinity, 3_615_001])('invalid retry %s uses15s without creating a broker penalty', retry => {
    expect(tradovateSoftReadDelay(new TradovateRequestError('tradovate-request-budget',503,retry as number))).toBe(15_000);
  });
  it('honors a full-hour authority retry including its grantTTL', () => {
    expect(tradovateSoftReadDelay(new TradovateRequestError('tradovate-request-budget',503,3_605_000))).toBe(3_605_000);
  });
  it('preserves a longer verified minimum and leaves another connection live', () => {
    const deferred = createTradovateSoftReadDeferrals();
    deferred.record('limited',new TradovateRequestError('tradovate-request-budget',503,45_000),100_000);
    deferred.record('limited',new TradovateRequestError('tradovate-request-budget',503,1_000),101_000);
    expect(deferred.resumeAt('limited')).toBe(145_000);
    expect(deferred.resumeAt('healthy')).toBe(0);
    expect(deferred.resumeAt('limited',3_700_000)).toBe(3_700_000);
  });
  it.each([new Error('tradovate-request-budget'),new TradovateRequestError('tradovate-request-budget',429,45_000),new TradovateRequestError('tradovate-request-unavailable',503,45_000)])('does not reclassify unavailable, OAuth or429', error => {
    expect(tradovateSoftReadDelay(error)).toBeNull();
  });
});
