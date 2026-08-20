import { describe, expect, it, vi } from 'vitest';

import { buildApnsLiveActivityPayload, buildApnsLiveActivityStartPayload } from '../server/apns';
import { loadNativeLiveActivityBrokerSnapshot } from '../server/nativeLiveActivityBrokerSnapshot';
import {
  liveActivityAccountIds,
  planNativeLiveActivityUpdate,
  type NativeLiveActivityRuntimeRow,
} from '../server/nativeLiveActivityUpdater';
import {
  planNativeLiveActivityStart,
  startNativeLiveActivities,
} from '../server/nativeLiveActivityStarter';

const runtime = (controller: Record<string, unknown>): NativeLiveActivityRuntimeRow => ({
  device_id: 'device',
  user_id: 'user',
  connection_id: 'connection',
  last_seen_at: '2026-08-20T10:00:00.000Z',
  started_at: '2026-08-20T09:00:00.000Z',
  status: {
    group: {
      leaderAccountId: 10,
      followers: [{ accountId: 11 }, { accountId: 12 }],
    },
    controller,
  },
});

const broker = {
  accounts: [],
  positions: [
    { accountId: 10, symbol: 'MNQU6', side: 'Long' as const, quantity: 1 },
    { accountId: 11, symbol: 'MNQU6', side: 'Long' as const, quantity: 2 },
  ],
  workingOrderCount: 4,
  realizedPnl: 250,
  openPnl: 75.5,
  totalPnl: 325.5,
  completeOpenPnl: true,
  capturedAt: Date.parse('2026-08-20T10:00:00.000Z'),
};

describe('remote native Live Activity', () => {
  it('builds the exact ActivityKit APNs payload keys', () => {
    expect(buildApnsLiveActivityPayload({
      state: {
        status: 'ARM LIVE', headline: 'LONG 3 MNQ', detail: '2 pozice',
        pnlText: '+$325.50', isPositive: true, progress: 0.75, updatedAt: 1_777_000_000.4,
      },
      staleAt: 1_777_000_180.9,
    })).toEqual({
      aps: {
        timestamp: 1_777_000_000,
        event: 'update',
        'content-state': {
          status: 'ARM LIVE', headline: 'LONG 3 MNQ', detail: '2 pozice',
          pnlText: '+$325.50', isPositive: true, progress: 0.75, updatedAt: 1_777_000_000.4,
        },
        'stale-date': 1_777_000_180,
      },
    });
  });

  it('builds the exact ActivityKit push-to-start payload', () => {
    expect(buildApnsLiveActivityStartPayload({
      attributes: { sessionID: 'remote-session', symbol: 'MNQ' },
      state: {
        status: 'ARM LIVE', headline: 'ARM · 2 followeři', detail: '0 pozic',
        pnlText: '+$0.00', isPositive: true, progress: 0.75, updatedAt: 1_777_000_000.4,
      },
      alert: { title: 'Copier je ARM', body: 'ARM · 2 followeři' },
      staleAt: 1_777_000_180.9,
    })).toEqual({
      aps: {
        timestamp: 1_777_000_000,
        event: 'start',
        'content-state': {
          status: 'ARM LIVE', headline: 'ARM · 2 followeři', detail: '0 pozic',
          pnlText: '+$0.00', isPositive: true, progress: 0.75, updatedAt: 1_777_000_000.4,
        },
        'attributes-type': 'AlphaTradeLiveActivityAttributes',
        attributes: { sessionID: 'remote-session', symbol: 'MNQ' },
        alert: { title: 'Copier je ARM', body: 'ARM · 2 followeři', sound: 'default' },
        'input-push-token': 1,
        'stale-date': 1_777_000_180,
      },
    });
  });

  it('starts once per stable ARM session and rejects stale state', () => {
    const now = Date.parse('2026-08-20T10:00:30.000Z');
    const fresh = runtime({ armed: true, armedAt: now - 20_000, connected: true });
    expect(planNativeLiveActivityStart({ runtime: fresh, broker, now })).toEqual({
      trigger: `arm:device:${now - 20_000}`,
      reason: 'armed',
    });
    expect(planNativeLiveActivityStart({
      runtime: { ...fresh, last_seen_at: '2026-08-20T09:58:00.000Z' },
      broker,
      now,
    })).toEqual({ trigger: null, reason: 'stale' });
  });

  it('uses a stable open-position trigger when DISARMED', () => {
    const now = Date.parse('2026-08-20T10:00:30.000Z');
    const positionRuntime = runtime({
      armed: false,
      connected: true,
      recentCopyEvents: [{ id: 'entry-42', kind: 'entry', at: now - 10_000 }],
    });
    expect(planNativeLiveActivityStart({ runtime: positionRuntime, broker, now })).toEqual({
      trigger: 'position:device:entry-42',
      reason: 'position',
    });
    expect(planNativeLiveActivityStart({
      runtime: positionRuntime,
      broker: { ...broker, positions: [] },
      now,
    })).toEqual({ trigger: null, reason: 'inactive' });
  });

  it('sends one remote start and persists the session trigger', async () => {
    const now = Date.parse('2026-08-20T10:00:30.000Z');
    const updates: Array<{ table: string; payload: Record<string, unknown>; id: string }> = [];
    const startRow = {
      id: '123e4567-e89b-42d3-a456-426614174000', user_id: 'user',
      installation_id: '223e4567-e89b-42d3-a456-426614174000', push_token: 'ab'.repeat(32),
      environment: 'development' as const, bundle_id: 'app.alphatrade.native',
      last_start_trigger: null, last_started_at: null,
    };
    const db = {
      from(table: string) {
        return {
          select() {
            return {
              is: async () => ({
                data: table === 'native_live_activity_start_subscriptions' ? [startRow] : [],
                error: null,
              }),
            };
          },
          update(payload: Record<string, unknown>) {
            return { eq: async (_column: string, id: string) => {
              updates.push({ table, payload, id });
              return { error: null };
            } };
          },
        };
      },
    };
    const send = vi.fn(async () => ({ status: 'sent' as const, statusCode: 200 }));
    const result = await startNativeLiveActivities({
      db: db as never,
      runtimes: [runtime({ armed: true, armedAt: now - 20_000, connected: true })],
      brokerSnapshot: async () => broker,
      now,
      send,
    });
    expect(result).toEqual({ registered: 1, sent: 1, skipped: 0, failed: 0, expired: 0 });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]).toMatchObject({
      attributes: { symbol: 'MNQ' },
      alert: { title: 'Copier je ARM' },
      state: { status: 'ARM LIVE' },
    });
    expect(updates).toContainEqual(expect.objectContaining({
      table: 'native_live_activity_start_subscriptions',
      id: startRow.id,
      payload: expect.objectContaining({ last_start_trigger: `arm:device:${now - 20_000}` }),
    }));
  });

  it('records an already covered session without creating a duplicate activity', async () => {
    const now = Date.parse('2026-08-20T10:00:30.000Z');
    const updates: Record<string, unknown>[] = [];
    const db = {
      from(table: string) {
        return {
          select() {
            return { is: async () => ({
              data: table === 'native_live_activity_start_subscriptions'
                ? [{
                  id: 'start-id', user_id: 'user', installation_id: 'install-id',
                  push_token: 'ab'.repeat(32), environment: 'development',
                  bundle_id: 'app.alphatrade.native', last_start_trigger: null,
                  last_started_at: null,
                }]
                : [{ user_id: 'user' }],
              error: null,
            }) };
          },
          update(payload: Record<string, unknown>) {
            return { eq: async () => { updates.push(payload); return { error: null }; } };
          },
        };
      },
    };
    const send = vi.fn();
    const result = await startNativeLiveActivities({
      db: db as never,
      runtimes: [runtime({ armed: true, armedAt: now - 20_000, connected: true })],
      brokerSnapshot: async () => broker,
      now,
      send,
    });
    expect(result).toEqual({ registered: 1, sent: 0, skipped: 1, failed: 0, expired: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ last_start_trigger: `arm:device:${now - 20_000}` });
  });

  it('uses authoritative positions and total PnL while ARM is active', () => {
    const now = Date.parse('2026-08-20T10:00:30.000Z');
    const plan = planNativeLiveActivityUpdate({
      runtime: runtime({ armed: true, connected: true, shadowMode: false }),
      broker,
      now,
    });
    expect(liveActivityAccountIds(runtime({}))).toEqual([10, 11, 12]);
    expect(plan.shouldEnd).toBe(false);
    expect(plan.symbol).toBe('MNQ');
    expect(plan.update.state).toMatchObject({
      status: 'ARM LIVE',
      headline: 'LONG 3 MNQU6 · 2 účtů',
      detail: '2 pozic · 4 příkazů · Celkové P&L',
      pnlText: '+$325.50',
      isPositive: true,
    });
  });

  it('ends only after a broker snapshot confirms flat', () => {
    const now = Date.parse('2026-08-20T10:00:30.000Z');
    const controller = { armed: false, connected: true, killSwitch: false };
    const flat = { ...broker, positions: [], openPnl: 0, totalPnl: 250 };
    expect(planNativeLiveActivityUpdate({ runtime: runtime(controller), broker: flat, now }).shouldEnd).toBe(true);
    expect(planNativeLiveActivityUpdate({ runtime: runtime(controller), broker: null, now }).shouldEnd).toBe(false);
  });

  it('loads bounded broker state and aggregates current PnL', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/position/list')) return new Response(JSON.stringify([
        { accountId: 10, contractId: 99, netPos: 1 },
        { accountId: 11, contractId: 99, netPos: 2 },
        { accountId: 999, contractId: 99, netPos: 100 },
      ]));
      if (path.endsWith('/order/list')) return new Response(JSON.stringify([
        { accountId: 10, ordStatus: 'Working' },
        { accountId: 10, ordStatus: 'Filled' },
        { accountId: 999, ordStatus: 'Working' },
      ]));
      if (path.endsWith('/cashBalance/list')) return new Response(JSON.stringify([
        { accountId: 10, timestamp: '2026-08-20T09:00:00Z', realizedPnL: 100 },
        { accountId: 10, timestamp: '2026-08-20T10:00:00Z', realizedPnL: 125 },
        { accountId: 11, timestamp: '2026-08-20T10:00:00Z', realizedPnL: 75 },
      ]));
      if (path.endsWith('/account/list')) return new Response(JSON.stringify([
        { id: 10, name: 'Leader', canTrade: true },
        { id: 11, name: 'Follower', canTrade: false },
      ]));
      if (path.endsWith('/userAccountAutoLiq/list')) return new Response(JSON.stringify([
        { accountId: 10, changesLocked: true },
        { accountId: 11, changesLocked: false },
      ]));
      if (path.endsWith('/contract/items')) return new Response(JSON.stringify([{ id: 99, name: 'MNQU6' }]));
      if (path.endsWith('/cashBalance/getcashbalancesnapshot')) {
        const accountId = JSON.parse(String(init?.body)).accountId;
        return new Response(JSON.stringify({ openPnL: accountId === 10 ? 20 : 30 }));
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const snapshot = await loadNativeLiveActivityBrokerSnapshot({
      baseUrl: 'https://demo.tradovateapi.com/v1',
      accessToken: 'secret',
      accountIds: [10, 11],
      fetchImpl,
      now: 123,
    });
    expect(snapshot).toMatchObject({
      workingOrderCount: 1,
      realizedPnl: 200,
      openPnl: 50,
      totalPnl: 250,
      completeOpenPnl: true,
      accountStatusComplete: true,
      accountLockStatusComplete: true,
      capturedAt: 123,
    });
    expect(snapshot.accounts).toEqual([
      expect.objectContaining({ accountId: 10, accountName: 'Leader', canTrade: true, changesLocked: true }),
      expect.objectContaining({ accountId: 11, accountName: 'Follower', canTrade: false, changesLocked: false }),
    ]);
    expect(snapshot.positions).toEqual([
      { accountId: 10, symbol: 'MNQU6', side: 'Long', quantity: 1 },
      { accountId: 11, symbol: 'MNQU6', side: 'Long', quantity: 2 },
    ]);
  });

  it('marks account lock coverage incomplete instead of inventing unlocks', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/position/list') || path.endsWith('/order/list') || path.endsWith('/cashBalance/list')) {
        return new Response('[]');
      }
      return new Response('{}', { status: 503 });
    }) as unknown as typeof fetch;
    const snapshot = await loadNativeLiveActivityBrokerSnapshot({
      baseUrl: 'https://demo.tradovateapi.com/v1',
      accessToken: 'secret',
      accountIds: [10],
      fetchImpl,
      now: 123,
    });
    expect(snapshot).toMatchObject({
      accountStatusComplete: false,
      accountLockStatusComplete: false,
    });
  });
});
