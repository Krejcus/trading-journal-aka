import { describe, expect, it } from 'vitest';
import { applyTradovateConnectionHealth as apply, tradovateConnectionPresentation as present } from '../lib/tradovateConnectionHealth';

describe('connection reauthorization display', () => {
  it('requires broker verification before showing connected', () => {
    expect(present(true).healthy).toBe(false);
    expect(present(true, apply({}, 'a', 1).a).healthy).toBe(true);
  });
  it('isolates a rejected Tradeify login from a healthy Lucid connection', () => {
    const before = apply({}, 'lucid', 1);
    const next = apply(before, 'tradeify', 2, new Error('tradovate-reauthorization-required'));
    expect(present(true, next.tradeify)).toMatchObject({ reconnect: true, healthy: false });
    expect(present(true, next.lucid)).toMatchObject({ reconnect: false, healthy: true });
  });
  it.each(['Failed to fetch', 'invalid-auth-token', 'tradovate-rate-limited', 'tradovate-preflight-failed', 'tradovate-read-denied'])('does not demand broker reconnect for %s', message => {
    expect(present(true, apply({}, 'a', 1, new Error(message)).a)).toMatchObject({ reconnect: false, healthy: false });
  });
  it('retains a rejected login through a timeout, then clears it after a fresh successful read', () => {
    const rejected = apply({}, 'a', 10, new Error('tradovate-reauthorization-required'));
    expect(apply(rejected, 'a', 11, new Error('timeout'))).toBe(rejected);
    expect(apply(rejected, 'a', 9)).toBe(rejected);
    const recovered = apply(rejected, 'a', 12);
    expect(present(true, recovered.a).healthy).toBe(true);
    expect(apply(recovered, 'a', 10, new Error('tradovate-reauthorization-required'))).toBe(recovered);
  });
  it('offers reconnect for an explicitly disconnected saved connection', () => {
    expect(present(false)).toMatchObject({ label: 'Disconnected', reconnect: true, healthy: false });
  });
});
