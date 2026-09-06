import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendApnsNotification } from '../server/apns';
import { copierEventDeliveryKey, drainNotificationDeliveries, enqueueNotificationDelivery, incidentDeliveryKey, NOTIFICATION_DELIVERY_TABLE, persistNotificationMarkers } from '../server/notificationDelivery';
import { sendImmediateCopyEventPushes } from '../server/nativeCopierStatePush';
import { sendCopierSnapshotFollowUp } from '../server/snapshotImagePush';

vi.mock('../server/apns', () => ({ sendApnsNotification: vi.fn(), sendApnsWidgetUpdate: vi.fn(async () => ({ status: 'sent' })) }));
const NOW = Date.parse('2026-09-05T10:00:00Z');
const USER = 'user';
const DEVICE = 'worker';
const event = { id: 'entry-1', at: NOW - 2000, kind: 'entry', episodeId: 'e1111111-1111-4111-8111-111111111111',
  symbol: 'MNQ', side: 'Long', quantity: 1, followers: 1, price: 24000 };

/** In-memory PostgREST adapter: UPDATE filters apply atomically at execution, not selection. */
function database() {
  const tables: Record<string, any[]> = {
    native_push_subscriptions: [{ id: 'phone-a', user_id: USER, expired_at: null, device_token: 'a'.repeat(64), environment: 'development', bundle_id: 'app.alphatrade.native' }],
    push_subscriptions: [],
    copier_alert_state: [{ user_id: USER, device_id: DEVICE, incident_key: 'state:copy-events', active: false, detail: String(NOW - 10_000), updated_at: 'initial-version' }],
    tradovate_copier_device_runtime: [{ device_id: DEVICE, status: { controller: { recentCopyEvents: [event] } } }],
    [NOTIFICATION_DELIVERY_TABLE]: [],
  };
  let nextId = 1;
  let failEnqueue = false;
  const api = {
    tables, set failEnqueue(value: boolean) { failEnqueue = value; },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/image.png' }, error: null }) }) },
    rpc: vi.fn(async (_name: string, args: any) => {
      const old = tables.copier_alert_state.find(row => row.user_id === args.p_user_id && row.device_id === args.p_device_id && row.incident_key === 'state:copy-events');
      if (old) {
        if (args.p_at > Number(old.detail)) old.active = Boolean(args.p_silent_baseline);
        old.detail = String(Math.max(Number(old.detail), args.p_at));
      }
      else tables.copier_alert_state.push({ user_id: args.p_user_id, device_id: args.p_device_id, incident_key: 'state:copy-events', detail: String(args.p_at), active: Boolean(args.p_silent_baseline) });
      return { data: null, error: null };
    }),
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
  it('keeps a failed event after discovery advances and retries without the runtime event', async () => {
    const { db, api, queue } = database();
    vi.mocked(sendApnsNotification).mockResolvedValueOnce({ status: 'failed', error: 'apns-timeout' });
    const first = await sendImmediateCopyEventPushes({ db, userId: USER, deviceId: DEVICE, status: { controller: { recentCopyEvents: [event] } } });
    expect(first).toEqual({ notifications: 1, sent: 0 });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ status: 'retry', attempt_count: 1 });
    expect(api.tables.copier_alert_state[0].notified_at).toBeUndefined();
    vi.mocked(Date.now).mockReturnValue(NOW + 60_000);
    const retry = await sendImmediateCopyEventPushes({ db, userId: USER, deviceId: DEVICE, status: { controller: { recentCopyEvents: [] } } });
    expect(retry).toEqual({ notifications: 0, sent: 1 });
    expect(queue[0]).toMatchObject({ status: 'sent', attempt_count: 2 });
  });

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

  it('does not advance discovery if durable enqueue fails', async () => {
    const { db, api } = database(); api.failEnqueue = true;
    await expect(sendImmediateCopyEventPushes({ db, userId: USER, deviceId: DEVICE, status: { controller: { recentCopyEvents: [event] } } })).rejects.toThrow('notification-enqueue-failed');
    expect(api.rpc).not.toHaveBeenCalled(); expect(sendApnsNotification).not.toHaveBeenCalled();
  });

  it('shares one claim between image, immediate and cron representations without skipping earlier events', async () => {
    const { db, api, queue } = database();
    const imageResult = await sendCopierSnapshotFollowUp({ db, userId: USER, deviceId: DEVICE, storagePath: 'u/chart.png', input: { ...event, notifyDeadlineAt: NOW + 1000 } as any });
    expect(imageResult?.sent).toBe(1); expect(api.rpc).not.toHaveBeenCalled();
    const textKey = copierEventDeliveryKey({ ...event, deviceId: DEVICE, eventId: event.id });
    expect(queue[0].event_key).toBe(textKey);
    await sendImmediateCopyEventPushes({ db, userId: USER, deviceId: DEVICE, status: { controller: { recentCopyEvents: [event] } } });
    expect(queue).toHaveLength(1); expect(sendApnsNotification).toHaveBeenCalledTimes(1);
  });

  it('preserves distinct moves even at the same millisecond and episode', async () => {
    const { db, queue } = database();
    const moves = [
      { ...event, id: 'move-1', kind: 'sl-moved', price: 24010 },
      { ...event, id: 'move-2', kind: 'sl-moved', price: 24020 },
    ];
    await sendImmediateCopyEventPushes({ db, userId: USER, deviceId: DEVICE, status: { controller: { recentCopyEvents: moves } } });
    expect(queue).toHaveLength(2);
    expect(new Set(queue.map(row => row.event_key)).size).toBe(2);
    expect(new Set(queue.map(row => row.payload.collapseId)).size).toBe(2);
    expect(sendApnsNotification).toHaveBeenCalledTimes(2);
  });

  it('correlates a legacy SL image to its exact move, never another move in the same second', async () => {
    const { db, api, queue } = database();
    const moves = [
      { ...event, id: 'move-1', kind: 'sl-moved', price: 24010 },
      { ...event, id: 'move-2', kind: 'sl-moved', at: event.at + 200, price: 24020 },
    ];
    api.tables.tradovate_copier_device_runtime[0].status.controller.recentCopyEvents = moves;
    await sendCopierSnapshotFollowUp({ db, userId: USER, deviceId: DEVICE, storagePath: 'u/sl.png', input: moves[1] as any });
    expect(queue[0].event_key).toBe(copierEventDeliveryKey({ ...moves[1], eventId: moves[1].id, deviceId: DEVICE }));
    await sendImmediateCopyEventPushes({ db, userId: USER, deviceId: DEVICE, status: { controller: { recentCopyEvents: moves } } });
    expect(queue).toHaveLength(2); expect(sendApnsNotification).toHaveBeenCalledTimes(2);
  });

  it('does not resume an old sender after a slow image preparation loses its lease', async () => {
    const { db, api, queue } = database();
    await enqueue(db); queue[0].payload.imageStoragePath = 'u/chart.png';
    let release!: (value: any) => void;
    const signing = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValue({ data: { signedUrl: 'https://example.test/image.png' }, error: null });
    api.storage.from = () => ({ createSignedUrl: signing });
    const slow = drainNotificationDeliveries({ db });
    await vi.waitFor(() => expect(signing).toHaveBeenCalledTimes(1));
    vi.mocked(Date.now).mockReturnValue(NOW + 61_000);
    expect((await drainNotificationDeliveries({ db })).sent).toBe(1);
    release({ data: { signedUrl: 'https://example.test/late.png' }, error: null });
    expect((await slow).skipped).toBe(1);
    expect(sendApnsNotification).toHaveBeenCalledTimes(1);
    expect(queue[0]).toMatchObject({ status: 'sent', attempt_count: 2 });
  });

  it('times out hung preparation without sending later when the abandoned read resolves', async () => {
    vi.useFakeTimers();
    try {
      const { db, api, queue } = database(); await enqueue(db);
      queue[0].payload.imageStoragePath = 'u/chart.png';
      let release!: (value: any) => void;
      api.storage.from = () => ({ createSignedUrl: () => new Promise(resolve => { release = resolve; }) as any });
      const pending = drainNotificationDeliveries({ db, now: NOW });
      await vi.advanceTimersByTimeAsync(10_001);
      expect((await pending).failed).toBe(1);
      expect(queue[0]).toMatchObject({ status: 'retry', last_error: 'notification-preparation-timeout' });
      release({ data: { signedUrl: 'https://example.test/late.png' }, error: null });
      await vi.advanceTimersByTimeAsync(1);
      expect(sendApnsNotification).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('rejects a stale marker update and creates new incident identity after a resolved cycle', async () => {
    const { db, api } = database();
    const old = { user_id: USER, device_id: DEVICE, incident_key: 'worker-offline', active: false, updated_at: 'v1' };
    api.tables.copier_alert_state.push({ ...old, active: true, updated_at: 'v2' });
    await persistNotificationMarkers(db, [{ userId: USER, deviceId: DEVICE, incidentKey: 'worker-offline', active: false, detail: null, notified: true }], [old]);
    expect(api.tables.copier_alert_state.at(-1)).toMatchObject({ active: true, updated_at: 'v2' });
    const incident = { deviceId: DEVICE, key: 'worker-offline', kind: 'opened' };
    expect(incidentDeliveryKey(incident, old)).not.toBe(incidentDeliveryKey(incident, { ...old, updated_at: 'v3' }));
  });
});
