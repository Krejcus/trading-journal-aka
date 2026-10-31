import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import { verifyCopierRelayTargetHint } from '../server/tradovateCopierCommandRelay';

const userId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
const startedAt = '2026-10-31T02:00:00.000Z';
const now = Date.parse('2026-10-31T02:05:00.000Z');

type Row = Record<string, unknown>;

function hintDb(options: {
  device?: Row | null;
  runtime?: Row | null;
  deviceError?: string;
  runtimeError?: string;
} = {}): SupabaseClient {
  const device = options.device === undefined
    ? { id: deviceId, user_id: userId, connection_id: connectionId, revoked_at: null }
    : options.device;
  const runtime = options.runtime === undefined
    ? {
      device_id: deviceId,
      user_id: userId,
      connection_id: connectionId,
      status: { startedAt, controller: { connected: true } } as LocalCopierAgentStatus,
      last_seen_at: new Date(now - 1_000).toISOString(),
    }
    : options.runtime;
  const query = (rows: Row[], error?: string) => {
    let filtered = [...rows];
    const api = {
      select: () => api,
      eq: (column: string, value: unknown) => { filtered = filtered.filter(row => row[column] === value); return api; },
      is: (column: string, value: unknown) => { filtered = filtered.filter(row => (row[column] ?? null) === value); return api; },
      in: (column: string, values: unknown[]) => { filtered = filtered.filter(row => values.includes(row[column])); return api; },
      order: () => api,
      limit: (count: number) => { filtered = filtered.slice(0, count); return api; },
      maybeSingle: async () => ({ data: filtered[0] ?? null, error: error ? { message: error } : null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: filtered, error: error ? { message: error } : null }),
    };
    return api;
  };
  return {
    from: (table: string) => {
      if (table === 'tradovate_copier_devices') return query(device ? [device] : [], options.deviceError);
      if (table === 'tradovate_copier_device_runtime') return query(runtime ? [runtime] : [], options.runtimeError);
      throw new Error(`unexpected-table:${table}`);
    },
  } as unknown as SupabaseClient;
}

const validHint = (patch: Record<string, unknown> = {}) => ({
  kind: 'copier-relay-target',
  v: 1,
  userId,
  deviceId,
  connectionId,
  startedAt,
  expiresAt: now + 8_000,
  ...patch,
});

describe('copier relay target hint', () => {
  it('accepts only the same non-revoked device, connection and worker instance with a fresh heartbeat', async () => {
    await expect(verifyCopierRelayTargetHint({ db: hintDb(), userId, hint: validHint(), now }))
      .resolves.toMatchObject({
        connectionId,
        device: { id: deviceId, status: { startedAt } },
      });
  });

  it.each([
    ['expired', validHint({ expiresAt: now - 1 })],
    ['too-far-future', validHint({ expiresAt: now + 10_001 })],
    ['wrong-device-shape', validHint({ deviceId: 'not-a-uuid' })],
    ['wrong-connection-shape', validHint({ connectionId: 'not-a-uuid' })],
    ['wrong-user', validHint({ userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })],
    ['wrong-worker-instance', validHint({ startedAt: '2026-10-31T01:00:00.000Z' })],
  ])('rejects %s before it can select a target', async (_label, hint) => {
    await expect(verifyCopierRelayTargetHint({ db: hintDb(), userId, hint, now })).resolves.toBeNull();
  });

  it('rejects a foreign or revoked device and a stale runtime', async () => {
    await expect(verifyCopierRelayTargetHint({
      db: hintDb({ device: { id: deviceId, user_id: 'other', connection_id: connectionId, revoked_at: null } }),
      userId,
      hint: validHint(),
      now,
    })).resolves.toBeNull();
    await expect(verifyCopierRelayTargetHint({
      db: hintDb({ device: { id: deviceId, user_id: userId, connection_id: connectionId, revoked_at: '2026-10-31T01:00:00Z' } }),
      userId,
      hint: validHint(),
      now,
    })).resolves.toBeNull();
    await expect(verifyCopierRelayTargetHint({
      db: hintDb({
        runtime: {
          device_id: deviceId, user_id: userId, connection_id: connectionId,
          status: { startedAt }, last_seen_at: new Date(now - 10_000).toISOString(),
        },
      }),
      userId,
      hint: validHint(),
      now,
    })).resolves.toBeNull();
  });

  it('fails closed on database errors instead of treating them as a harmless stale hint', async () => {
    await expect(verifyCopierRelayTargetHint({
      db: hintDb({ runtimeError: 'database offline' }),
      userId,
      hint: validHint(),
      now,
    })).rejects.toThrow('copier-relay-runtime-status-failed: database offline');
  });
});
