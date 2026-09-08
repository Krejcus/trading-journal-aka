import { describe, expect, it, vi } from 'vitest';
import type { ApnsDevice, ApnsLiveActivityUpdate, ApnsResult } from '../server/apns';
import type { NativeLiveActivityBrokerSnapshot } from '../server/nativeLiveActivityBrokerSnapshot';
import {
  LIVE_ACTIVITY_CRON_STALE_S,
  LIVE_ACTIVITY_TICK_STALE_S,
  liveActivityTickDue,
  liveActivityTickShouldSend,
  tickNativeLiveActivities,
  tickNativeLiveActivitiesWithinBudget,
} from '../server/nativeLiveActivityTick';

const now = Date.parse('2026-09-07T14:30:00.000Z');
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

const status = (controller: Record<string, unknown>) => ({
  startedAt: iso(-60 * 60_000),
  group: {
    id: 'group-main', name: 'Hlavní', leaderAccountId: 10,
    followers: [{ accountId: 11, mode: 'on-fill', multiplier: 1 }],
  },
  controller: { armed: true, connected: true, armedAt: now - 20 * 60_000, dailyStats: { realizedPnlUsd: 120, losingTrades: 0 }, recentCopyEvents: [], ...controller },
});

const broker: NativeLiveActivityBrokerSnapshot = {
  accounts: [
    { accountId: 10, accountName: 'Leader', balance: 0, realizedPnl: 0, openPnl: 0, totalPnl: 0, canTrade: true, changesLocked: false },
    { accountId: 11, accountName: 'Follower', balance: 0, realizedPnl: 0, openPnl: 0, totalPnl: 0, canTrade: true, changesLocked: false },
  ],
  positions: [
    { accountId: 10, symbol: 'MNQZ6', side: 'Long', quantity: 1, entryPrice: 23_400, currentPrice: 23_450, stopPrice: 23_350, targetPrice: 23_550 },
    { accountId: 11, symbol: 'MNQZ6', side: 'Long', quantity: 1, entryPrice: 23_400, currentPrice: 23_450, stopPrice: 23_350, targetPrice: 23_550 },
  ],
  pendingOrder: null,
  workingOrderCount: 4,
  realizedPnl: 120,
  openPnl: 75.5,
  totalPnl: 195.5,
  completeOpenPnl: true,
  completeRealizedPnl: true,
  accountStatusComplete: true,
  accountLockStatusComplete: true,
  capturedAt: now,
};

const subscription = (patch: Record<string, unknown> = {}) => ({
  id: 'sub-1', user_id: 'user', activity_id: 'activity', push_token: 'ab'.repeat(32),
  environment: 'development' as const, bundle_id: 'app.alphatrade.native',
  last_payload_hash: null, last_payload_at: null, updated_at: null, ...patch,
});

const fakeDb = (rows: ReturnType<typeof subscription>[]) => {
  const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const db = {
    from(table: string) {
      expect(table).toBe('native_live_activity_subscriptions');
      return {
        select() {
          return { eq() { return { is: async () => ({ data: rows, error: null }) }; } };
        },
        update(payload: Record<string, unknown>) {
          return { eq: async (_column: string, id: string) => { updates.push({ id, payload }); return { error: null }; } };
        },
      };
    },
  };
  return { db, updates };
};

const okSend = () => vi.fn(async (_device: ApnsDevice, _update: ApnsLiveActivityUpdate): Promise<ApnsResult> => ({ status: 'sent', statusCode: 200 }));

describe('Live Activity tik z relay pollu', () => {
  it('bez ARM neběží: žádný Tradovate snapshot, žádný push', async () => {
    const loader = vi.fn(async () => broker);
    const { db } = fakeDb([subscription()]);
    const send = okSend();
    const result = await tickNativeLiveActivities({
      db: db as never, userId: 'user', deviceId: 'device', connectionId: 'connection',
      status: status({ armed: false }), config: {} as never, now, brokerSnapshot: loader, send,
    });
    expect(result.reason).toBe('not-armed');
    expect(loader).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('drží rozestup 5 s: pokus mladší než 4,5 s nevolá broker ani APNs', async () => {
    expect(liveActivityTickDue([{ last_payload_at: null, updated_at: iso(-2_000) }], now)).toBe(false);
    expect(liveActivityTickDue([{ last_payload_at: iso(-6_000), updated_at: null }], now)).toBe(true);
    expect(liveActivityTickDue([{ last_payload_at: null, updated_at: null }], now)).toBe(true);
    const loader = vi.fn(async () => broker);
    const { db } = fakeDb([subscription({ updated_at: iso(-2_000) })]);
    const send = okSend();
    const result = await tickNativeLiveActivities({
      db: db as never, userId: 'user', deviceId: 'device', connectionId: 'connection',
      status: status({}), config: {} as never, now, brokerSnapshot: loader, send,
    });
    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0, reason: 'throttled' });
    expect(loader).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('při otevřené pozici pošle změněné P&L se stale-date 30 s a uloží hash', async () => {
    const { db, updates } = fakeDb([subscription({ last_payload_hash: 'stale-hash', last_payload_at: iso(-7_000) })]);
    const send = okSend();
    const result = await tickNativeLiveActivities({
      db: db as never, userId: 'user', deviceId: 'device', connectionId: 'connection',
      status: status({}), config: {} as never, now, brokerSnapshot: async () => broker, send,
    });
    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0, reason: 'ticked' });
    expect(send).toHaveBeenCalledOnce();
    const update = send.mock.calls[0][1];
    expect(update.staleAt).toBe(now / 1_000 + LIVE_ACTIVITY_TICK_STALE_S);
    expect(update.state.pnlText).toBe('+$75.50');
    expect(updates[0].payload).toMatchObject({ last_payload_at: iso(0), last_error: null });
    expect(typeof updates[0].payload.last_payload_hash).toBe('string');
  });

  it('nezměněný obsah bez heartbeat lhůty jen zapíše pokus, ale po 20 s pošle znovu', async () => {
    const plan = { payloadHash: 'same', shouldEnd: false };
    expect(liveActivityTickShouldSend({ plan, subscription: { last_payload_hash: 'same', last_payload_at: iso(-10_000) }, positionsOpen: true, now })).toBe(false);
    expect(liveActivityTickShouldSend({ plan, subscription: { last_payload_hash: 'same', last_payload_at: iso(-21_000) }, positionsOpen: true, now })).toBe(true);
    // Bez pozice heartbeat po 45 s, aby „před X s“ na zámku nerostlo do minuty cronu.
    expect(liveActivityTickShouldSend({ plan, subscription: { last_payload_hash: 'same', last_payload_at: iso(-30_000) }, positionsOpen: false, now })).toBe(false);
    expect(liveActivityTickShouldSend({ plan, subscription: { last_payload_hash: 'same', last_payload_at: iso(-60_000) }, positionsOpen: false, now })).toBe(true);
    expect(liveActivityTickShouldSend({ plan: { payloadHash: 'same', shouldEnd: true }, subscription: { last_payload_hash: 'same', last_payload_at: iso(0) }, positionsOpen: false, now })).toBe(true);

    // Stejný obsah do 20 s: druhý tik jen zapíše pokus, nepošle.
    const send = okSend();
    const first = await tickNativeLiveActivities({
      db: fakeDb([subscription({ last_payload_at: iso(-7_000) })]).db as never,
      userId: 'user', deviceId: 'device', connectionId: 'connection',
      status: status({}), config: {} as never, now, brokerSnapshot: async () => broker, send,
    });
    expect(first.sent).toBe(1);
    const { db, updates } = fakeDb([subscription({ last_payload_hash: 'unknown', last_payload_at: iso(-7_000) })]);
    const second = await tickNativeLiveActivities({
      db: db as never, userId: 'user', deviceId: 'device', connectionId: 'connection',
      status: status({}), config: {} as never, now, brokerSnapshot: async () => broker, send,
    });
    expect(second.sent).toBe(1);
    expect(updates.at(-1)?.payload).toMatchObject({ last_payload_at: iso(0) });
  });

  it('bez otevřené pozice nechává stale-date cronu (180 s)', async () => {
    const { db } = fakeDb([subscription({ last_payload_at: iso(-7_000) })]);
    const send = okSend();
    await tickNativeLiveActivities({
      db: db as never, userId: 'user', deviceId: 'device', connectionId: 'connection',
      status: status({}), config: {} as never, now, brokerSnapshot: async () => ({ ...broker, positions: [], openPnl: 0, totalPnl: 120 }), send,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1].staleAt).toBe(now / 1_000 + LIVE_ACTIVITY_CRON_STALE_S);
  });

  it('chybějící broker snapshot nic nepošle a zapíše jen pokus', async () => {
    const { db, updates } = fakeDb([subscription({ last_payload_at: iso(-7_000) })]);
    const send = okSend();
    const result = await tickNativeLiveActivities({
      db: db as never, userId: 'user', deviceId: 'device', connectionId: 'connection',
      status: status({}), config: {} as never, now, brokerSnapshot: async () => null, send,
    });
    expect(result.reason).toBe('no-broker');
    expect(send).not.toHaveBeenCalled();
    expect(updates).toEqual([{ id: 'sub-1', payload: { updated_at: iso(0) } }]);
  });

  it('časový rozpočet vrátí timeout místo blokování pollu', async () => {
    const { db } = fakeDb([subscription({ last_payload_at: iso(-7_000) })]);
    const result = await tickNativeLiveActivitiesWithinBudget({
      db: db as never, userId: 'user', deviceId: 'device', connectionId: 'connection',
      status: status({}), config: {} as never, now, budgetMs: 20,
      brokerSnapshot: () => new Promise(resolve => setTimeout(() => resolve(broker), 200)),
      send: okSend(),
    });
    expect(result).toEqual({ reason: 'timeout' });
  });
});

describe('Live Activity tik: push-to-start bez běžící aktivity', () => {
  it('bez odběru aktualizací zavolá starter (dedup podle session triggeru) a vrátí started', async () => {
    const updates: Array<{ table: string; id: string; payload: Record<string, unknown> }> = [];
    const startRow = {
      id: 'start-1', user_id: 'user-start', installation_id: 'inst', push_token: 'cd'.repeat(32),
      environment: 'development', bundle_id: 'app.alphatrade.native', last_start_trigger: null, last_started_at: null,
    };
    const db = {
      from(table: string) {
        return {
          select() {
            return {
              eq() { return { is: async () => ({ data: [], error: null }) }; },
              is: async () => ({ data: table === 'native_live_activity_start_subscriptions' ? [startRow] : [], error: null }),
            };
          },
          update(payload: Record<string, unknown>) {
            return { eq: async (_c: string, id: string) => { updates.push({ table, id, payload }); return { error: null }; } };
          },
        };
      },
    };
    const sendStart = vi.fn(async () => ({ status: 'sent' as const, statusCode: 200 }));
    const result = await tickNativeLiveActivities({
      db: db as never, userId: 'user-start', deviceId: 'device', connectionId: 'connection',
      status: status({}), config: {} as never, now, brokerSnapshot: async () => broker, send: okSend(), sendStart,
    });
    expect(result.reason).toBe('started');
    expect(sendStart).toHaveBeenCalledOnce();
    expect(updates).toContainEqual(expect.objectContaining({ table: 'native_live_activity_start_subscriptions', id: 'start-1' }));

    // Do 15 s se starter nevolá znovu (throttle per instance).
    const again = await tickNativeLiveActivities({
      db: db as never, userId: 'user-start', deviceId: 'device', connectionId: 'connection',
      status: status({}), config: {} as never, now: now + 5_000, brokerSnapshot: async () => broker, send: okSend(), sendStart,
    });
    expect(again.reason).toBe('no-subscription');
    expect(sendStart).toHaveBeenCalledOnce();
  });
});

describe('Live Activity tik: jedna aktivita na uživatele', () => {
  it('starší odběry ukončí (end + expires_at) a aktualizuje jen nejnovější', async () => {
    const older = subscription({ id: 'sub-old', activity_id: 'old', last_payload_at: iso(-7_000), created_at: iso(-600_000) });
    const newest = subscription({ id: 'sub-new', activity_id: 'new', last_payload_at: iso(-7_000), last_payload_hash: 'stale', created_at: iso(-30_000) });
    const { db, updates } = fakeDb([older, newest]);
    const send = vi.fn(async (_device: ApnsDevice, _update: ApnsLiveActivityUpdate): Promise<ApnsResult> => ({ status: 'sent', statusCode: 200 }));
    const result = await tickNativeLiveActivities({
      db: db as never, userId: 'user', deviceId: 'device', connectionId: 'connection',
      status: status({}), config: {} as never, now, brokerSnapshot: async () => broker, send,
    });
    expect(result.sent).toBe(2);
    const endCall = send.mock.calls.find(call => call[0].id === 'old');
    expect(endCall?.[1].event).toBe('end');
    expect(send.mock.calls.find(call => call[0].id === 'new')?.[1].event).toBe('update');
    expect(updates).toContainEqual(expect.objectContaining({ id: 'sub-old', payload: expect.objectContaining({ last_error: 'ended-duplicate:sent' }) }));
  });
});
