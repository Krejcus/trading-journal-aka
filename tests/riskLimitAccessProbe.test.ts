import { describe, expect, it, vi } from 'vitest';
import {
  assertReadOnlyTradovatePath,
  readOnlyTradovateGet,
} from '../scripts/copier/riskLimitAccessProbe';

describe('Tradovate risk-limit probe read-only allowlist', () => {
  it('accepts only the declared list and numeric master dependency paths', () => {
    expect(() => assertReadOnlyTradovatePath('/userAccountAutoLiq/list')).not.toThrow();
    expect(() => assertReadOnlyTradovatePath('/userAccountAutoLiq/deps?masterid=123')).not.toThrow();
    expect(() => assertReadOnlyTradovatePath('/auth/me')).not.toThrow();
  });

  it('rejects mutation, item, extra-query and order paths', () => {
    expect(() => assertReadOnlyTradovatePath('/userAccountAutoLiq/update'))
      .toThrow('risk-probe-path-denied');
    expect(() => assertReadOnlyTradovatePath('/userAccountAutoLiq/item?id=1'))
      .toThrow('risk-probe-path-denied');
    expect(() => assertReadOnlyTradovatePath('/userAccountAutoLiq/deps?masterid=1&x=2'))
      .toThrow('risk-probe-query-denied');
    expect(() => assertReadOnlyTradovatePath('/order/list'))
      .toThrow('risk-probe-path-denied');
  });

  it('refuses a forbidden path before fetch can run', async () => {
    const fetchImpl = vi.fn();
    await expect(readOnlyTradovateGet({
      baseUrl: 'https://demo.tradovateapi.com/v1',
      path: '/userAccountAutoLiq/update',
      accessToken: 'must-not-be-used',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow('risk-probe-path-denied');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a non-DEMO host before fetch can run', async () => {
    const fetchImpl = vi.fn();
    await expect(readOnlyTradovateGet({
      baseUrl: 'https://example.invalid/v1',
      path: '/account/list',
      accessToken: 'must-not-be-used',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow('risk-probe-host-denied');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
