import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { assertTradovateBackgroundCapacity, BACKGROUND_CAPACITY_RETRY_MS, TradovateRequestControlError } from '../server/tradovateServerRequestControl';
import { loadTradovateAccountData } from '../server/tradovateAccountData';
import { preflightReadCost } from '../api/tradovate/oauth/preflight';
import { TRADOVATE_REQUEST_CONTROL_POLICY as POLICY, type TradovateRequestControlSnapshot } from '../lib/tradovateRequestControl';

const snapshot = (overrides: Partial<TradovateRequestControlSnapshot> = {}): TradovateRequestControlSnapshot => ({
  version: 1, brokerUserId: 42, serverNow: 1_000, epoch: 0, blockedUntil: null, captchaRequired: false, evidence: null, reason: null,
  backgroundReservedHour: 0, backgroundReservedMinute: 0, policyVersion: 2, riskReservedHour: 0, riskReservedMinute: 0,
  controlReservedHour: 0, controlReservedMinute: 0, totalReservedHour: 0, ...overrides,
});
const context = (state: TradovateRequestControlSnapshot | Error, brokerUserId: number | null = 42) => {
  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => state instanceof Error
    ? { data: null, error: { message: state.message } }
    : { data: { allowed: true, snapshot: { ...state } }, error: null, args });
  return { rpc, context: { db: { rpc } as unknown as SupabaseClient, userId: 'owner', connectionId: 'connection', brokerUserId } };
};
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('poradní kontrola kapacity zobrazovacího čtení', () => {
  it('čtení, které se vejde, projde a nic nerezervuje', async () => {
    const f = context(snapshot({ backgroundReservedMinute: 15, backgroundReservedHour: 700 }));
    await expect(assertTradovateBackgroundCapacity(f.context, 25)).resolves.toBeUndefined();
    expect(f.rpc.mock.calls.map(([, args]) => args.p_mode)).toEqual(['read']);
  });

  it('nad minutový strop odmítne předem typovaným odmítnutím rozpočtu, bez odeslání', async () => {
    const f = context(snapshot({ backgroundReservedMinute: 16 }));
    await expect(assertTradovateBackgroundCapacity(f.context, 25)).rejects.toMatchObject({
      code: 'tradovate-request-budget', status: 503, notDispatched: true, retryAfterMs: BACKGROUND_CAPACITY_RETRY_MS,
    });
    expect(f.rpc.mock.calls.every(([, args]) => args.p_mode === 'read')).toBe(true);
  });

  it('nad hodinový nebo celkový strop odmítne s delším odkladem', async () => {
    for (const state of [snapshot({ backgroundReservedHour: POLICY.backgroundHour - 10 }), snapshot({ totalReservedHour: POLICY.totalSoftHour - 10 })]) {
      await expect(assertTradovateBackgroundCapacity(context(state).context, 25)).rejects.toMatchObject({ code: 'tradovate-request-budget', retryAfterMs: 60_000 });
    }
  });

  it('čtení větší než celý minutový strop smí jen do prázdné minuty', async () => {
    await expect(assertTradovateBackgroundCapacity(context(snapshot()).context, 89)).resolves.toBeUndefined();
    await expect(assertTradovateBackgroundCapacity(context(snapshot({ backgroundReservedMinute: 1 })).context, 89)).rejects.toMatchObject({ code: 'tradovate-request-budget' });
  });

  it('cooldown, captcha, výpadek kontroly a chybějící identita nechává rozhodnout původní cestu', async () => {
    await expect(assertTradovateBackgroundCapacity(context(snapshot({ blockedUntil: 90_000, backgroundReservedMinute: 40 })).context, 25)).resolves.toBeUndefined();
    await expect(assertTradovateBackgroundCapacity(context(snapshot({ captchaRequired: true, backgroundReservedMinute: 40 })).context, 25)).resolves.toBeUndefined();
    await expect(assertTradovateBackgroundCapacity(context(new Error('rpc down')).context, 25)).resolves.toBeUndefined();
    const noIdentity = context(snapshot({ backgroundReservedMinute: 40 }), null);
    await expect(assertTradovateBackgroundCapacity(noIdentity.context, 25)).resolves.toBeUndefined();
    expect(noIdentity.rpc).not.toHaveBeenCalled();
    await expect(assertTradovateBackgroundCapacity(context(snapshot({ backgroundReservedMinute: 40 })).context, 0)).resolves.toBeUndefined();
  });

  it('cena čtení odpovídá skutečnému počtu dotazů u brokera', async () => {
    for (const detail of ['full', 'bootstrap'] as const) {
      const seen: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname.replace('/v1', '');
        seen.push(path);
        return json(path === '/account/list' ? [{ id: 1, name: 'A1' }, { id: 2, name: 'A2' }, { id: 3, name: 'A3' }]
          : path === '/cashBalance/getcashbalancesnapshot' ? {} : []);
      }) as typeof fetch;
      await loadTradovateAccountData({ baseUrl: 'https://demo.tradovateapi.com/v1', accessToken: 't', fetchImpl, detail });
      const cost = preflightReadCost(detail);
      const perAccountPaths = new Set(['/cashBalance/getcashbalancesnapshot', '/cashBalanceLog/deps', '/accountRiskStatus/deps', '/userAccountAutoLiq/deps']);
      expect(seen.filter(path => perAccountPaths.has(path)).length).toBe(cost.perAccount * 3);
      // Flat účty bez příkazů: společných seznamů je přesně `base` (kontrakty a další se čtou jen s pozicí).
      expect(seen.filter(path => !perAccountPaths.has(path)).length).toBe(cost.base);
    }
  });
});

describe('odmítnutí před čteními po účtech', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  afterEach(() => { process.off('unhandledRejection', onUnhandled); unhandled.length = 0; });

  it('nespustí žádné čtení na účet a vrátí původní odmítnutí bez neodchycené chyby', async () => {
    process.on('unhandledRejection', onUnhandled);
    const seen: string[] = [];
    const counts: number[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname.replace('/v1', '');
      seen.push(path);
      return json(path === '/account/list' ? [{ id: 1, name: 'A1' }, { id: 2, name: 'A2' }] : []);
    }) as typeof fetch;
    await expect(loadTradovateAccountData({
      baseUrl: 'https://demo.tradovateapi.com/v1', accessToken: 't', fetchImpl, detail: 'full',
      beforeAccountReads: async count => { counts.push(count); throw new TradovateRequestControlError('tradovate-request-budget', 20_000); },
    })).rejects.toMatchObject({ code: 'tradovate-request-budget', retryAfterMs: 20_000 });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(counts).toEqual([2]);
    expect(unhandled).toEqual([]);
    expect(seen.some(path => /getcashbalancesnapshot|\/deps$/.test(path))).toBe(false);
  });

  it('bez háčku a s procházejícím háčkem se čte jako dřív', async () => {
    const run = async (hook?: (count: number) => Promise<void>) => {
      const seen: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname.replace('/v1', '');
        seen.push(path);
        return json(path === '/account/list' ? [{ id: 1, name: 'A1' }] : path === '/cashBalance/getcashbalancesnapshot' ? {} : []);
      }) as typeof fetch;
      await loadTradovateAccountData({ baseUrl: 'https://demo.tradovateapi.com/v1', accessToken: 't', fetchImpl, detail: 'full', beforeAccountReads: hook });
      return seen.sort();
    };
    expect(await run(async () => undefined)).toEqual(await run());
  });
});
