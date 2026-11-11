import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { tradovateFullRefreshRetry } from '../components/useTradovateLiveData';
import { TradovateRequestError } from '../services/tradovateOAuthConnection';

const now = 1_800_000_000_000;
const precheck = new TradovateRequestError('tradovate-request-budget', 503, 20_000, 'tradovate-request-budget', true);
const midRead = new TradovateRequestError('tradovate-request-budget', 503, 1_000, 'tradovate-request-budget');

describe('opakování úplného načtení připojení', () => {
  it('bezplatné předběžné odmítnutí: stálé tempo po odkladu serveru, počet selhání neroste', () => {
    let failureCount = 0;
    const waits: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const next = tradovateFullRefreshRetry({ now, previousFailureCount: failureCount, deferralUntil: now + 20_000, reason: precheck, random: 0.5 });
      failureCount = next.failureCount;
      waits.push(next.retryAt - now);
    }
    expect(failureCount).toBe(0);
    expect(new Set(waits)).toEqual(new Set([22_500]));
  });

  it('rozptyl drží pokus v okně 0–5 s za odkladem a nikdy před ním', () => {
    for (const random of [0, 0.25, 1, 7, -3]) {
      const { retryAt } = tradovateFullRefreshRetry({ now, previousFailureCount: 3, deferralUntil: now + 60_000, reason: precheck, random });
      expect(retryAt).toBeGreaterThanOrEqual(now + 60_000);
      expect(retryAt).toBeLessThanOrEqual(now + 65_000);
    }
    expect(tradovateFullRefreshRetry({ now, previousFailureCount: 0, deferralUntil: 0, reason: precheck, random: 0 }).retryAt).toBe(now + 15_000);
  });

  it('odmítnutí uprostřed čtení a jiné chyby odstup prodlužují jako dřív', () => {
    expect(tradovateFullRefreshRetry({ now, previousFailureCount: 0, deferralUntil: now + 15_000, reason: midRead })).toEqual({ failureCount: 1, retryAt: now + 15_000 });
    expect(tradovateFullRefreshRetry({ now, previousFailureCount: 3, deferralUntil: 0, reason: new Error('boom') })).toEqual({ failureCount: 4, retryAt: now + 120_000 });
    expect(tradovateFullRefreshRetry({ now, previousFailureCount: 20, deferralUntil: 0, reason: midRead }).retryAt).toBe(now + 600_000);
  });

  it('příznak platí jen pro odmítnutí rozpočtem se stavem 503', () => {
    const other = new TradovateRequestError('tradovate-request-cooldown', 503, 5_000, 'tradovate-request-cooldown', true);
    const rateLimited = new TradovateRequestError('tradovate-request-budget', 429, 5_000, 'tradovate-request-budget', true);
    for (const reason of [other, rateLimited]) expect(tradovateFullRefreshRetry({ now, previousFailureCount: 1, deferralUntil: 0, reason }).failureCount).toBe(2);
  });

  it('načítání v appce bere odstup z této funkce a klient čte příznak ze serveru', () => {
    const hook = readFileSync(new URL('../components/useTradovateLiveData.ts', import.meta.url), 'utf8');
    expect(hook).toMatch(/const \{ failureCount, retryAt \} = tradovateFullRefreshRetry\(\{/);
    expect(hook).not.toContain('const failureCount = previous.failureCount + 1;\n      const rateLimitUntil');
    const client = readFileSync(new URL('../services/tradovateOAuthConnection.ts', import.meta.url), 'utf8');
    expect(client).toContain('body.precheck === true');
  });
});
