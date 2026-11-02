import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_PRICE_ALERT, PRICE_ALERTS_STORAGE_KEY, newPriceAlert } from '../lib/priceAlerts';
import { createServerPriceAlertStore, priceAlertToRow } from '../services/priceAlertServerStore';
import { priceAlertWatchLabel } from '../lib/priceAlertWatchLabel';

const USER = '11111111-1111-4111-8111-111111111111';

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return { data, getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => { data[key] = value; } };
};

/** Falešný Supabase: tabulka upozornění jako v DB (stav spouštění mění jen server). */
function fakeClient() {
  const rows = new Map<string, Record<string, unknown>>();
  const upserts: Record<string, unknown>[] = [];
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const realtime: Record<string, (payload: { new?: Record<string, unknown> }) => void> = {};
  let offline = false;
  const fail = { data: null, error: { message: 'offline' } };
  const run = (table: string, op: string, payload: Record<string, unknown> | null) => {
    if (offline) return fail;
    if (table === 'price_alerts' && op === 'upsert') {
      upserts.push(payload!);
      const previous = rows.get(payload!.id as string);
      const conditionChanged = previous && (['price', 'condition', 'frequency', 'expiry'] as const).some(key => previous[key] !== payload![key]);
      const row: Record<string, unknown> = {
        ...payload!, created_at: previous?.created_at ?? new Date(1_000).toISOString(),
        status: previous?.status ?? 'active', trigger_count: previous?.trigger_count ?? 0, last_triggered_at: previous?.last_triggered_at ?? null,
        version: previous ? Number(previous.version) + (conditionChanged ? 1 : 0) : 1,
      };
      rows.set(row.id as string, row);
      return { data: row, error: null };
    }
    if (table === 'price_alerts') return { data: [...rows.values()].filter(row => !row.deleted_at), error: null };
    if (table === 'price_alert_defaults') return { data: null, error: null };
    if (table === 'price_alert_events') return { data: [], error: null };
    return fail;
  };
  const client = {
    from(table: string) {
      let op = 'select';
      let payload: Record<string, unknown> | null = null;
      const api = {
        select: () => api, is: () => api, order: () => api, limit: () => api, gte: () => api, maybeSingle: () => api,
        upsert: (value: Record<string, unknown>) => { op = 'upsert'; payload = value; return api; },
        then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => Promise.resolve(run(table, op, payload)).then(resolve, reject),
      };
      return api;
    },
    rpc(name: string, args: Record<string, unknown>) {
      if (offline) return Promise.resolve(fail);
      rpcs.push({ name, args });
      const row = rows.get(args.p_alert as string);
      const ok = !!row && row.trigger_count === args.p_expected_trigger_count && row.status !== 'active';
      if (ok) rows.set(row!.id as string, { ...row, status: 'active', version: Number(row!.version) + 1 });
      return Promise.resolve({ data: ok, error: null });
    },
    channel() {
      const channel = {
        on: (_type: string, filter: { table: string }, callback: (payload: { new?: Record<string, unknown> }) => void) => { realtime[filter.table] = callback; return channel; },
        subscribe: () => channel,
      };
      return channel;
    },
    removeChannel: () => Promise.resolve('ok'),
  };
  return {
    client: client as unknown as SupabaseClient, rows, upserts, rpcs, realtime,
    setOffline: (value: boolean) => { offline = value; },
  };
}

const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0)); };
const store = (fake: ReturnType<typeof fakeClient>, storage = memory()) => createServerPriceAlertStore({
  client: fake.client, userId: USER, storage, now: () => 50_000, schedule: () => 0, cancel: () => {},
});

describe('serverový store upozornění na cenu', () => {
  it('přidání je hned vidět, po zápisu je na serveru; stav spouštění klient neposílá', async () => {
    const fake = fakeClient();
    const alerts = store(fake);
    await settle();
    const alert = newPriceAlert(21480, 21467.5, DEFAULT_PRICE_ALERT, 40_000);
    alerts.add(alert);
    expect(alerts.getState().alerts.map(item => item.id)).toEqual([alert.id]);
    await settle();
    expect(fake.rows.get(alert.id)).toMatchObject({ user_id: USER, price: 21480, condition: 'up', condition_auto: true });
    expect(Object.keys(fake.upserts[0])).not.toContain('status');
    expect(Object.keys(fake.upserts[0])).not.toContain('trigger_count');
    expect(alerts.getState().sync).toBe('synced');
    alerts.dispose();
  });

  it('offline: úprava čeká ve frontě v zařízení a odejde po dalším spuštění', async () => {
    const fake = fakeClient();
    const storage = memory();
    fake.setOffline(true);
    const first = store(fake, storage);
    await settle();
    const alert = newPriceAlert(21480, 21467.5, DEFAULT_PRICE_ALERT, 40_000);
    first.add(alert);
    await settle();
    expect(first.getState()).toMatchObject({ sync: 'offline' });
    expect(first.getState().alerts).toHaveLength(1);
    first.dispose();
    fake.setOffline(false);
    const second = store(fake, storage);
    expect(second.getState().alerts.map(item => item.id)).toEqual([alert.id]);
    await settle();
    expect(fake.rows.has(alert.id)).toBe(true);
    second.dispose();
  });

  it('spuštěné „jednou“: posun znovu zapne přes rearm s očekávaným počtem spuštění; poznámka ne', async () => {
    const fake = fakeClient();
    const alert = newPriceAlert(21480, 21467.5, DEFAULT_PRICE_ALERT, 40_000);
    fake.rows.set(alert.id, { ...priceAlertToRow(USER, alert, null, 50_000), created_at: new Date(1_000).toISOString(), status: 'triggered', trigger_count: 1, version: 1 });
    const alerts = store(fake);
    await settle();
    expect(alerts.getState().alerts[0]).toMatchObject({ status: 'triggered', triggerCount: 1 });
    alerts.update({ ...alerts.getState().alerts[0], note: 'jen poznámka', updatedAt: 45_000 });
    await settle();
    expect(fake.rpcs).toEqual([]);
    alerts.update({ ...alerts.getState().alerts[0], price: 21490, updatedAt: 46_000 });
    // Do potvrzení serverem se netvrdí „hlídá“.
    expect(alerts.getState().alerts[0].status).toBe('triggered');
    await settle();
    expect(fake.rpcs).toEqual([{ name: 'rearm_price_alert', args: { p_alert: alert.id, p_expected_trigger_count: 1 } }]);
    expect(fake.rows.get(alert.id)).toMatchObject({ status: 'active', price: 21490 });
    expect(alerts.getState().alerts[0].status).toBe('active');
    alerts.dispose();
  });

  it('server znovuzapnutí odmítne (mezitím znovu spustilo): UI dál ukazuje „spuštěno“', async () => {
    const fake = fakeClient();
    const alert = newPriceAlert(21480, 21467.5, DEFAULT_PRICE_ALERT, 40_000);
    fake.rows.set(alert.id, { ...priceAlertToRow(USER, alert, null, 50_000), created_at: new Date(1_000).toISOString(), status: 'triggered', trigger_count: 1, version: 1 });
    const alerts = store(fake);
    await settle();
    alerts.update({ ...alerts.getState().alerts[0], price: 21490, updatedAt: 46_000 });
    // Mezi zápisem a znovuzapnutím upozornění znovu spustilo („pokaždé“ / jiné zařízení).
    fake.rows.set(alert.id, { ...fake.rows.get(alert.id), trigger_count: 2 });
    await settle();
    expect(fake.rpcs).toEqual([{ name: 'rearm_price_alert', args: { p_alert: alert.id, p_expected_trigger_count: 1 } }]);
    expect(alerts.getState().alerts[0].status).toBe('triggered');
    alerts.dispose();
  });

  it('smazání je měkké (deleted_at) a zmizí hned; realtime změna a spuštění se propíšou', async () => {
    const fake = fakeClient();
    const alerts = store(fake);
    await settle();
    const alert = newPriceAlert(21480, 21467.5, DEFAULT_PRICE_ALERT, 40_000);
    alerts.add(alert);
    await settle();
    fake.realtime.price_alert_events({ new: { id: 'ev-1', alert_id: alert.id, level: '21480.00', condition: 'up', triggered_at: new Date(49_000).toISOString(), suppressed_reason: null } });
    expect(alerts.getState().events).toEqual([{ id: 'ev-1', alertId: alert.id, at: 49_000, level: 21480, condition: 'up', suppressed: false }]);
    fake.realtime.price_alerts({ new: { ...fake.rows.get(alert.id), status: 'triggered', trigger_count: 1 } });
    expect(alerts.getState().alerts[0].status).toBe('triggered');
    alerts.remove(alert.id);
    expect(alerts.getState().alerts).toEqual([]);
    await settle();
    expect(fake.upserts.at(-1)).toMatchObject({ id: alert.id, deleted_at: expect.any(String) });
    alerts.dispose();
  });

  it('upozornění založená jen v zařízení převezme jednou na uživatele', async () => {
    const local = newPriceAlert(21400, 21467.5, DEFAULT_PRICE_ALERT, 40_000);
    const storage = memory({ [PRICE_ALERTS_STORAGE_KEY]: JSON.stringify([local]) });
    const fake = fakeClient();
    const first = store(fake, storage);
    await settle();
    expect(fake.rows.has(local.id)).toBe(true);
    first.dispose();
    fake.rows.clear();
    const second = store(fake, storage);
    await settle();
    expect(fake.rows.has(local.id)).toBe(false);
    second.dispose();
  });
});

describe('kdo hlídá upozornění (jen text)', () => {
  const watch = { state: 'watching' as const, alerts: 2, priceAgeMs: 300, syncAgeMs: 2_000 };
  it('jen čerstvý status, stav watching a cena i seznam ≤ 15 s', () => {
    const label = (patch: Partial<Parameters<typeof priceAlertWatchLabel>[0]>) => priceAlertWatchLabel({ fresh: true, watch, statusAgeMs: 1_000, ...patch });
    expect(label({})).toBe('Hlídá Mac z ceny IBKR · 2 upozornění');
    expect(label({ fresh: false })).toBeNull();
    expect(label({ watch: { ...watch, state: 'no-price' } })).toBeNull();
    expect(label({ watch: { ...watch, priceAgeMs: 16_000 } })).toBeNull();
    expect(label({ watch: { ...watch, syncAgeMs: null } })).toBeNull();
    expect(label({ watch: null })).toBeNull();
    // Stáří statusu se přičítá: 8 s starý status s 9 s starou cenou už „hlídá“ netvrdí.
    expect(label({ statusAgeMs: 8_500 })).toBeNull();
    expect(label({ statusAgeMs: 7_000, watch: { ...watch, priceAgeMs: 9_000 } })).toBeNull();
    expect(label({ statusAgeMs: null })).toBeNull();
  });
});
