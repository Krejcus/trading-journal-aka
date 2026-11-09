import { describe, expect, it } from 'vitest';
import type { TradovateRequestControlRemote, TradovateRequestControlSnapshot } from '../lib/tradovateRequestControl';
import { workerConnectionReadPlan, type WorkerConnectionDataset } from '../lib/tradovateWorkerCoverage';
import { createTradovateRequestGovernor } from '../services/tradovateRequestControlGovernor';
import { createTradovateControlledFetch } from '../services/tradovateRequestControlFetch';
import { createTradovateBroker } from '../services/tradovateBroker';

describe('steady-state request replay, not a live broker stress test', () => {
  it.each([4, 8])('%i accounts, two OAuth routes and two covered clients fit conservative read capacity', async accountCount => {
    const beganAt = Date.UTC(2026, 10, 9, 15);
    let now = beganAt, mono = 100, reserved = 0, sequence = 0;
    const snapshot = (): TradovateRequestControlSnapshot => ({
      version: 1, brokerUserId: 71000000, serverNow: now, epoch: 0,
      blockedUntil: null, captchaRequired: false, evidence: null, reason: null,
      backgroundReservedHour: reserved, backgroundReservedMinute: reserved,
    });
    const remote: TradovateRequestControlRemote = {
      read: async () => snapshot(),
      reserve: async input => {
        reserved += input.units;
        return { version: 1, grantId: input.grantId, brokerUserId: 71000000, purpose: input.purpose,
          units: input.units, serverNow: now, validUntil: now + input.ttlMs, epoch: 0 };
      },
      penalize: async () => { throw new Error('fixture never returns a broker penalty'); },
    };
    const governor = createTradovateRequestGovernor({
      brokerUserId: 71000000, remote, store: { load: async () => null, save: async () => {} },
      clock: () => now, monotonic: () => mono, uuid: () => `capacity-grant-${++sequence}`,
      wait: async ms => { now += ms; mono += ms; },
    });
    await governor.initialize();
    const accounts = Array.from({ length: accountCount }, (_, i) => 100 + i);
    const wire: string[] = [];
    const upstream: typeof fetch = async input => {
      const path = new URL(String(input)).pathname; wire.push(path);
      const rows = path.endsWith('/currency/list') ? [{ id: 7, name: 'USD' }]
        : path.endsWith('/cashBalance/list') ? accounts.map(accountId => ({
          accountId, currencyId: 7, timestamp: new Date(now).toISOString(), tradeDate: { year: 2026, month: 11, day: 9 }, amount: 50_000, realizedPnL: 0,
        }))
        : [{ id: Number(new URL(String(input)).searchParams.get('masterid')) + 10_000,
          maxNetLiq: 50_000, dailyLossAutoLiq: 1200, trailingMaxDrawdown: 2000 }];
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const routes = [accounts.slice(0, accountCount / 2), accounts.slice(accountCount / 2)].map((ids, route) => ({
      ids, connectionId: `login-${route}`,
      broker: createTradovateBroker({ environment: 'demo', accessToken: `test-token-${route}`,
        connectionId: `login-${route}`, routeAccountIds: ids, requestControl: governor,
        fetchImpl: upstream, clock: () => now, webSocketFactory: () => { throw new Error('no socket in read replay'); } }),
    }));
    const displayFetch = createTradovateControlledFetch(governor, upstream);
    for (let phase = 0; phase < 4; phase++) {
      const scheduledAt = beganAt + phase * 15_000;
      const advance = Math.max(0, scheduledAt - now); now += advance; mono += advance;
      await governor.sync();
      if (phase % 2 === 0) await Promise.all(routes.flatMap(route => route.ids.map(accountId => route.broker.listAccountRiskSnapshots([accountId]))));
      // The display feed runs one serial account batch per30s, per route.
      // Risk currency bootstrap is counted separately, not hidden from wire totals.
      for (const route of routes) {
        if (phase % 2 === 0) {
          await displayFetch('https://example.invalid/cashBalance/getcashbalancesnapshot', { method: 'POST' });
          await displayFetch('https://example.invalid/cashBalance/deps');
        }
        const dataset = { connectionId: route.connectionId, environment: 'demo', accounts: route.ids.map(id => ({ id })),
          coverage: { accounts: { availability: 'available', count: route.ids.length, httpStatus: 200 } } } as WorkerConnectionDataset;
        const receipt = { observedAt: now, status: { controller: { connected: true, exposure: { streamCoverage: route.ids.map(accountId => ({
          accountId, connectionId: route.connectionId, environment: 'demo' as const,
          routeEpoch: 1, currentRouteEpoch: 1, sessionId: 'session', currentSessionId: 'session',
          baselineAt: now - 120_000, lastDataAt: now - 60_000, observedAt: now,
          socketLive: true, synchronized: true, gap: false, backlog: false, mergeInProgress: false,
        })) } } } };
        for (let client = 0; client < 2; client++) expect(workerConnectionReadPlan(dataset, receipt, now).suppressFullTick).toBe(true);
      }
    }
    expect(wire.filter(path => path.endsWith('/accountRiskStatus/deps') || path.endsWith('/userAccountAutoLiq/deps'))).toHaveLength(accountCount * 4);
    expect(wire.filter(path => path.endsWith('/cashBalance/list'))).toHaveLength(4);
    expect(wire.filter(path => path.endsWith('/currency/list'))).toHaveLength(2);
    expect(wire).toHaveLength(accountCount * 4 + 14);
    expect(reserved).toBe(accountCount === 4 ? 32 : 48); // Conservative pool waste is included.
    expect(reserved * 60).toBeLessThan(3000);
    expect(governor.health().counts).toMatchObject({ dispatchAttempts: wire.length, blockedBeforeDispatch: 0 });
  });
});
