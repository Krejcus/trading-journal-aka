import { describe, expect, it } from 'vitest';
import { isTradovateRequestGrant, monotonicGrantDeadline, parseTradovateRequestPenalty } from '../lib/tradovateRequestControl';

describe('Tradovate penalty evidence', () => {
  it('does not invent captcha or a broker duration from an empty raw429', () => {
    expect(parseTradovateRequestPenalty(429, null)).toEqual({ evidence: 'raw-429', reason: expect.any(String),
      retryAfterMs: 3_600_000, brokerMinimumMs: null, policyFallbackMs: 3_600_000 });
  });
  it('keeps explicit broker minima; a short header never shortens raw429 policy', () => {
    expect(parseTradovateRequestPenalty(429, {}, '30')).toMatchObject({ retryAfterMs: 3_600_000, brokerMinimumMs: 30_000 });
    expect(parseTradovateRequestPenalty(429, {}, '7200')).toMatchObject({ retryAfterMs: 7_200_000, brokerMinimumMs: 7_200_000 });
  });
  it('distinguishes endpoint penalty and actual captcha, including HTTP200', () => {
    expect(parseTradovateRequestPenalty(200, { 'p-ticket': 'opaque', 'p-time': 15 })).toMatchObject({ evidence: 'p-time', retryAfterMs: 15_000, brokerMinimumMs: 15_000 });
    expect(parseTradovateRequestPenalty(200, { 'p-ticket': 'opaque', 'p-time': 15, 'p-captcha': true })).toMatchObject({ evidence: 'captcha', captchaRequired: true });
  });
  it('uses the larger conflicting minimum and never treats normal HTTP200 as permission to clear state', () => {
    expect(parseTradovateRequestPenalty(200, { 'p-ticket': 'opaque', 'p-time': 15 }, '30')).toMatchObject({ retryAfterMs: 30_000 });
    expect(parseTradovateRequestPenalty(200, { ok: true })).toBeNull();
    expect(parseTradovateRequestPenalty(503, { errorText: 'overloaded' }, '30')).toBeNull();
  });
  it('invalid p-time cannot become an immediate retry', () => {
    for (const value of [0, -1, NaN, '15', null]) expect(parseTradovateRequestPenalty(200, { 'p-ticket': 'opaque', 'p-time': value })).toMatchObject({ retryAfterMs: 3_600_000, brokerMinimumMs: null });
  });
  it('an overflowing duration serializes as a practically permanent stop, never null', () => {
    const penalty = parseTradovateRequestPenalty(200, { 'p-ticket': 'opaque', 'p-time': Number.MAX_VALUE });
    expect(penalty?.retryAfterMs).toBe(8e15);
    expect(JSON.parse(JSON.stringify(penalty)).retryAfterMs).toBe(8e15);
    expect(parseTradovateRequestPenalty(429, {}, String(Number.MAX_VALUE))?.brokerMinimumMs).toBe(8e15);
  });
});

describe('bounded remote grant', () => {
  const grant = () => ({ version: 1, grantId: 'grant:test00001', brokerUserId: 71000000, purpose: 'background', units: 4, serverNow: 1_000, validUntil: 6_000, epoch: 1 });
  it('accepts only a bounded grant from a positive broker identity', () => {
    expect(isTradovateRequestGrant(grant())).toBe(true);
    for (const patch of [{ brokerUserId: null }, { units: 0 }, { units: 65 }, { validUntil: 1_000 }, { validUntil: 20_000 }, { purpose: 'unlimited' }, { epoch: -1 }])
      expect(isTradovateRequestGrant({ ...grant(), ...patch })).toBe(false);
  });
  it('charges roundtrip time against grant life without trusting local wall clock', () => {
    const deadline = monotonicGrantDeadline(100, 1_000, 6_000);
    expect(deadline).toBe(5_100);
    expect(deadline - 300).toBe(4_800);
    expect(monotonicGrantDeadline(100, 6_000, 5_000)).toBe(100);
  });
});
