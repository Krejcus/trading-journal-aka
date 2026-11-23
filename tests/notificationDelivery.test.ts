import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendApnsNotification } from '../server/apns';
import { drainNotificationDeliveries, enqueueNotificationDelivery, NOTIFICATION_DELIVERY_TABLE } from '../server/notificationDelivery';

vi.mock('../server/apns', () => ({ sendApnsNotification: vi.fn(), sendApnsWidgetUpdate: vi.fn(async () => ({ status: 'sent' })) }));
const NOW = Date.parse('2026-09-05T10:00:00Z');
const USER = 'user';

/** In-memory PostgREST adapter: UPDATE filters apply atomically at execution, not selection. */
function database() {
  const tables: Record<string, any[]> = {
    native_push_subscriptions: [{ id: 'phone-a', user_id: USER, expired_at: null, device_token: 'a'.repeat(64), environment: 'development', bundle_id: 'app.alphatrade.native' }],
    push_subscriptions: [],
    [NOTIFICATION_DELIVERY_TABLE]: [],
  };
  let nextId = 1;
  let failEnqueue = false;
  const api = {
    tables, set failEnqueue(value: boolean) { failEnqueue = value; },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/image.png' }, error: null }) }) },
    from(table: string) {
      tables[table] ??= [];
      const filters: Array<(row: any) => boolean> = [];
      let operation = 'select', value: any, limit = Infinity, single = false, onConflict: string | undefined;
      const chain: any = {
        select: () => chain,
        eq: (key: string, expected: any) => { filters.push(row => row[key] === expected); return chain; },
        is: (key: string, expected: any) => { filters.push(row => (row[key] ?? null) === expected); return chain; },
        in: (key: string, values: any[]) => { filters.push(row => values.includes(row[key])); return chain; },
        lte: (key: string, expected: any) => { filters.push(row => row[key] <= expected); return chain; },
        gt: (key: string, expected: any) => { filters.push(row => row[key] > expected); return chain; },
        order: () => chain,
        limit: (count: number) => { limit = count; return chain; },
        maybeSingle: () => { single = true; return chain; },
        update: (next: any) => { operation = 'update'; value = next; return chain; },
        upsert: (next: any, opts: any) => { operation = 'upsert'; value = next; onConflict = opts?.onConflict; return chain; },
        then(resolve: (result: any) => void) {
          if (operation === 'upsert') {
            if (table === NOTIFICATION_DELIVERY_TABLE && failEnqueue) { resolve({ error: { message: 'disk unavailable' }, data: null }); return; }
            const keys = onConflict!.split(',');
            const existing = tables[table].find(row => keys.every(key => row[key] === value[key]));
            if (!existing) tables[table].push({ id: String(nextId++), status: 'pending', attempt_count: 0, created_at: new Date(NOW).toISOString(), ...structuredClone(value) });
            resolve({ data: null, error: null }); return;
          }
          const rows = tables[table].filter(row => filters.every(fn => fn(row))).slice(0, limit);
          if (operation === 'update') rows.forEach(row => Object.assign(row, structuredClone(value)));
          resolve({ data: structuredClone(single ? rows[0] ?? null : rows), error: null });
        },
      };
      return chain;
    },
  };
  return { db: api as unknown as SupabaseClient, api, queue: tables[NOTIFICATION_DELIVERY_TABLE] };
}

beforeEach(() => { vi.restoreAllMocks(); vi.mocked(sendApnsNotification).mockReset().mockResolvedValue({ status: 'sent' }); vi.spyOn(Date, 'now').mockReturnValue(NOW); });

async function enqueue(db: SupabaseClient, subscriptionId = 'phone-a') {
  await enqueueNotificationDelivery({ db, userId: USER, eventKey: 'a'.repeat(64), channel: 'apns', subscriptionId,
    payload: { title: 'Worker offline', body: 'Check LIVE', route: 'live' }, now: NOW });
}

describe('durable notification delivery', () => {
  it('only retries the failed device after partial fan-out success', async () => {
    const { db, api, queue } = database();
    api.tables.native_push_subscriptions.push({ ...api.tables.native_push_subscriptions[0], id: 'phone-b' });
    await enqueue(db); await enqueue(db, 'phone-b');
    vi.mocked(sendApnsNotification).mockImplementation(async device => device.id === 'phone-b' ? { status: 'failed' } : { status: 'sent' });
    expect((await drainNotificationDeliveries({ db, now: NOW })).sent).toBe(1);
    vi.mocked(sendApnsNotification).mockClear().mockResolvedValue({ status: 'sent' });
    expect((await drainNotificationDeliveries({ db, now: NOW + 60_000 })).sent).toBe(1);
    expect(sendApnsNotification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendApnsNotification).mock.calls[0][0].id).toBe('phone-b');
    expect(queue.every(row => row.status === 'sent')).toBe(true);
  });

  it('allows only one concurrent claim and never resends a completed event', async () => {
    const { db } = database(); await enqueue(db);
    await Promise.all([drainNotificationDeliveries({ db, now: NOW }), drainNotificationDeliveries({ db, now: NOW })]);
    expect(sendApnsNotification).toHaveBeenCalledTimes(1);
    await enqueue(db); await drainNotificationDeliveries({ db, now: NOW + 120_000 });
    expect(sendApnsNotification).toHaveBeenCalledTimes(1);
  });

  it('recovers a crashed sending lease after expiry, without taking an active lease', async () => {
    const { db, queue } = database(); await enqueue(db);
    Object.assign(queue[0], { status: 'sending', lease_token: 'lost-process', attempt_count: 1, next_attempt_at: new Date(NOW + 60_000).toISOString() });
    await drainNotificationDeliveries({ db, now: NOW + 59_000 }); expect(sendApnsNotification).not.toHaveBeenCalled();
    await drainNotificationDeliveries({ db, now: NOW + 61_000 }); expect(sendApnsNotification).toHaveBeenCalledTimes(1);
    expect(queue[0]).toMatchObject({ status: 'sent', attempt_count: 2, lease_token: null });
  });

  it('does not deliver a previous user’s queued content to a reassigned device', async () => {
    const { db, api, queue } = database(); await enqueue(db);
    api.tables.native_push_subscriptions[0].user_id = 'another-user';
    await drainNotificationDeliveries({ db, now: NOW });
    expect(sendApnsNotification).not.toHaveBeenCalled(); expect(queue[0].status).toBe('expired');
  });
});
