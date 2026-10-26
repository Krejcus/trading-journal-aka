import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { readTradovateCopierDeviceRuntime } from '../server/tradovateCopierCommandRelay';

/** Minimální fake řetězce dotazu: zapíše select/eq a vrátí připravený řádek. */
const fakeDb = (row: Record<string, unknown> | null) => {
  const calls: Array<[string, unknown[]]> = [];
  const builder = {
    select: (...args: unknown[]) => { calls.push(['select', args]); return builder; },
    eq: (...args: unknown[]) => { calls.push(['eq', args]); return builder; },
    order: (...args: unknown[]) => { calls.push(['order', args]); return builder; },
    limit: (...args: unknown[]) => { calls.push(['limit', args]); return builder; },
    maybeSingle: async () => ({ data: row, error: null }),
  };
  const db = { from: (table: string) => { calls.push(['from', [table]]); return builder; } } as unknown as SupabaseClient;
  return { db, calls };
};

describe('čtení runtime workeru pro GET statusu', () => {
  it('čte i device_id (jen pro serverové odvození kanálu ceny) a hlásí stáří', async () => {
    const seen = new Date(Date.now() - 3_000).toISOString();
    const { db, calls } = fakeDb({ device_id: 'dev-1', status: { startedAt: 'x' }, last_seen_at: seen });
    const runtime = await readTradovateCopierDeviceRuntime({ db, userId: 'user', connectionId: 'conn' });
    expect(calls).toContainEqual(['select', ['device_id,status,last_seen_at']]);
    expect(calls).toContainEqual(['eq', ['user_id', 'user']]);
    expect(calls).toContainEqual(['eq', ['connection_id', 'conn']]);
    expect(runtime).toMatchObject({ deviceId: 'dev-1', status: { startedAt: 'x' }, lastSeenAt: seen, connected: true });
    expect(runtime!.ageMs).toBeGreaterThanOrEqual(3_000);
  });

  it('starý heartbeat není connected (relay pak kanál ceny nevydá)', async () => {
    const { db } = fakeDb({ device_id: 'dev-1', status: {}, last_seen_at: new Date(Date.now() - 60_000).toISOString() });
    expect((await readTradovateCopierDeviceRuntime({ db, userId: 'user', connectionId: 'conn' }))!.connected).toBe(false);
  });

  it('bez řádku vrací null', async () => {
    expect(await readTradovateCopierDeviceRuntime({ db: fakeDb(null).db, userId: 'user', connectionId: 'conn' })).toBeNull();
  });
});
