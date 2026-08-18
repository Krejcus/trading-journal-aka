import { describe, expect, it } from 'vitest';
import { isAllowedLocalTradovateRead } from '../server/localTradovateReadOnlyProxy';

describe('local Tradovate read-only proxy', () => {
  it('allows only account observation endpoints', () => {
    expect(isAllowedLocalTradovateRead('GET', '/api/tradovate/oauth/status')).toBe(true);
    expect(isAllowedLocalTradovateRead('POST', '/api/tradovate/oauth/preflight')).toBe(true);
    expect(isAllowedLocalTradovateRead('POST', '/api/tradovate/oauth/live-pnl')).toBe(true);
    expect(isAllowedLocalTradovateRead('GET', '/api/tradovate/account-profiles')).toBe(true);
  });

  it('blocks OAuth, disconnects, profile writes, and unrelated APIs', () => {
    expect(isAllowedLocalTradovateRead('POST', '/api/tradovate/oauth/start')).toBe(false);
    expect(isAllowedLocalTradovateRead('DELETE', '/api/tradovate/oauth/status')).toBe(false);
    expect(isAllowedLocalTradovateRead('PUT', '/api/tradovate/account-profiles')).toBe(false);
    expect(isAllowedLocalTradovateRead('POST', '/api/cron/send-alerts')).toBe(false);
  });
});
