import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { assertConnectionNotInArmedCopy, resolveCopierRelayConnectionId } from '../server/tradovateCopierCommandRelay';

// 5. 10. 2026: Mac patří uživateli. Appka najde worker přes kterékoli své
// připojení, i když to, přes které byl Mac spárován, je odpojené.

type Row = Record<string, unknown>;
const fakeDb = (tables: Record<string, Row[]>, failing: string[] = []): SupabaseClient => {
  const query = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    let failed = false;
    const api = {
      select: () => api,
      eq: (column: string, value: unknown) => {
        if (failing.includes(column)) failed = true;
        rows = rows.filter(row => row[column] === value);
        return api;
      },
      is: (column: string, value: unknown) => { rows = rows.filter(row => (row[column] ?? null) === value); return api; },
      in: (column: string, values: unknown[]) => { rows = rows.filter(row => values.includes(row[column])); return api; },
      order: (column: string) => { rows.sort((a, b) => String(b[column]).localeCompare(String(a[column]))); return api; },
      limit: (count: number) => { rows = rows.slice(0, count); return api; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (value: { data: Row[] | null; error: { message: string } | null }) => unknown) => resolve(
        failed ? { data: null, error: { message: 'column scope does not exist' } } : { data: rows, error: null },
      ),
    };
    return api;
  };
  return { from: (table: string) => query(table) } as unknown as SupabaseClient;
};

const base = {
  tradovate_oauth_connections: [
    { id: 'lucid', user_id: 'u' }, { id: 'tradeify', user_id: 'u' }, { id: 'foreign', user_id: 'other' },
  ],
  tradovate_copier_devices: [{ id: 'mac', user_id: 'u', connection_id: 'lucid', scope: 'owner', revoked_at: null }],
  tradovate_copier_device_runtime: [{ device_id: 'mac', user_id: 'u', connection_id: 'lucid', last_seen_at: '2026-10-05T10:00:00Z' }],
};

describe('resolveCopierRelayConnectionId', () => {
  it('připojení se zařízením zůstává beze změny', async () => {
    expect(await resolveCopierRelayConnectionId({ db: fakeDb(base), userId: 'u', connectionId: 'lucid' })).toBe('lucid');
  });

  it('jiné připojení vlastníka najde owner-scope Mac pod jeho kotevním připojením', async () => {
    expect(await resolveCopierRelayConnectionId({ db: fakeDb(base), userId: 'u', connectionId: 'tradeify' })).toBe('lucid');
  });

  it('cizí připojení ani zařízení bez souhlasu nepřesměruje', async () => {
    expect(await resolveCopierRelayConnectionId({ db: fakeDb(base), userId: 'u', connectionId: 'foreign' })).toBe('foreign');
    const connectionScope = {
      ...base,
      tradovate_copier_devices: [{ ...base.tradovate_copier_devices[0], scope: 'connection' }],
    };
    expect(await resolveCopierRelayConnectionId({ db: fakeDb(connectionScope), userId: 'u', connectionId: 'tradeify' })).toBe('tradeify');
  });

  it('starší per-connection zařízení bez runtime nepřebije Mac, který hlásí stav', async () => {
    const withLegacyDevice = {
      ...base,
      tradovate_copier_devices: [
        ...base.tradovate_copier_devices,
        { id: 'legacy', user_id: 'u', connection_id: 'tradeify', scope: 'connection', revoked_at: null },
      ],
    };
    expect(await resolveCopierRelayConnectionId({ db: fakeDb(withLegacyDevice), userId: 'u', connectionId: 'tradeify' })).toBe('lucid');
  });

  it('mrtvé přímé zařízení se starým runtime prohraje s běžícím Macem', async () => {
    const stale = {
      ...base,
      tradovate_copier_devices: [
        ...base.tradovate_copier_devices,
        { id: 'old', user_id: 'u', connection_id: 'tradeify', scope: 'connection', revoked_at: null },
      ],
      tradovate_copier_device_runtime: [
        ...base.tradovate_copier_device_runtime,
        { device_id: 'old', user_id: 'u', connection_id: 'tradeify', last_seen_at: '2026-09-30T10:00:00Z' },
      ],
    };
    expect(await resolveCopierRelayConnectionId({ db: fakeDb(stale), userId: 'u', connectionId: 'tradeify' })).toBe('lucid');
  });

  it('živý přímý worker připojení má přednost i před čerstvějším Macem', async () => {
    const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
    const twoWorkers = {
      ...base,
      tradovate_copier_devices: [
        ...base.tradovate_copier_devices,
        { id: 'direct', user_id: 'u', connection_id: 'tradeify', scope: 'connection', revoked_at: null },
      ],
      tradovate_copier_device_runtime: [
        { device_id: 'mac', user_id: 'u', connection_id: 'lucid', last_seen_at: iso(1_000) },
        { device_id: 'direct', user_id: 'u', connection_id: 'tradeify', last_seen_at: iso(5_000) },
      ],
    };
    expect(await resolveCopierRelayConnectionId({ db: fakeDb(twoWorkers), userId: 'u', connectionId: 'tradeify' })).toBe('tradeify');
  });

  it('databáze bez migrace scope zachová původní chování', async () => {
    expect(await resolveCopierRelayConnectionId({ db: fakeDb(base, ['scope']), userId: 'u', connectionId: 'tradeify' })).toBe('tradeify');
  });
});

describe('assertConnectionNotInArmedCopy', () => {
  const now = Date.parse('2026-10-05T10:05:00Z');
  const runtime = (patch: Record<string, unknown>) => ({
    user_id: 'u', last_seen_at: '2026-10-05T10:04:00Z',
    status: {
      controller: { armed: true },
      group: { leaderAccountId: 1, followers: [{ accountId: 2, mode: 'on-submit', enabled: true }] },
      accountDisplay: [
        { connectionId: 'lucid', snapshots: [{ accountId: 1 }], pendingAccountIds: [] },
        { connectionId: 'tradeify', snapshots: [{ accountId: 9 }], pendingAccountIds: [] },
      ],
      ...patch,
    },
  });
  const check = (rows: Row[], connectionId: string) => assertConnectionNotInArmedCopy({
    db: fakeDb({ tradovate_copier_device_runtime: rows }), userId: 'u', connectionId, now,
  });

  it('zapnutá kopírka s účty propfirmy odpojení zablokuje', async () => {
    await expect(check([runtime({})], 'lucid')).rejects.toThrow('copier-armed-connection-in-use');
  });

  it('propfirmu bez účtů ve skupině, vypnutou kopírku nebo starý stav odpojit jde', async () => {
    await expect(check([runtime({})], 'tradeify')).resolves.toBeUndefined();
    await expect(check([runtime({ controller: { armed: false } })], 'lucid')).resolves.toBeUndefined();
    await expect(check([{ ...runtime({}), last_seen_at: '2026-10-05T09:00:00Z' }], 'lucid')).resolves.toBeUndefined();
  });

  it('prázdný feed hned po restartu není důkaz, že firma nemá účty skupiny', async () => {
    await expect(check([runtime({
      accountDisplay: [{ connectionId: 'lucid', snapshots: [], pendingAccountIds: [] }],
    })], 'lucid')).rejects.toThrow('copier-armed-connection-in-use');
  });

  it('účty hlášené workerem z adresáře rozhodnou i bez feedu', async () => {
    const discovery = (accountIds: number[]) => ({
      scope: 'owner', deviceId: 'mac', loadedConnectionIds: ['fn'], pendingConnectionIds: [], failedConnections: [],
      connectionAccounts: [{ connectionId: 'fn', accountIds }],
    });
    await expect(check([runtime({ accountDisplay: [], connectionDiscovery: discovery([2]) })], 'fn'))
      .rejects.toThrow('copier-armed-connection-in-use');
    await expect(check([runtime({ accountDisplay: [], connectionDiscovery: discovery([77]) })], 'fn'))
      .resolves.toBeUndefined();
  });

  it('načtené připojení bez známých účtů za ARM blokuje (fail-closed)', async () => {
    await expect(check([runtime({
      accountDisplay: [],
      connectionDiscovery: { scope: 'owner', deviceId: 'mac', loadedConnectionIds: ['fn'], pendingConnectionIds: [], failedConnections: [] },
    })], 'fn')).rejects.toThrow('copier-armed-connection-in-use');
  });
});
