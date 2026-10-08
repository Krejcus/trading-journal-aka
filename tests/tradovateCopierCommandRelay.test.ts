import { DEFAULT_COPY_GROUP_SAFETY, sanitizeCopyGroups } from '../services/liveCopyTrading';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { LocalCopierAgentCommand, LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import {
  claimTradovateCopierCommand,
  copierRelayValidationErrorStatus,
  enqueueTradovateCopierCommand,
  heartbeatTradovateCopierDevice,
} from '../server/tradovateCopierCommandRelay';

const userId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
type CopyCommand = Extract<LocalCopierAgentCommand, { type: 'copy-command' }>;

function enqueueDb(
  upsert: (row: unknown, options: unknown) => void,
  runtimeStatus: LocalCopierAgentStatus | null = null,
  inFlight: { id: string; status: string; expires_at: string; payload?: unknown }
    | ((calls: Array<[string, unknown[]]>) => { id: string; status: string; expires_at: string; payload?: unknown } | null)
    | null = null,
  onInFlightLookup?: (calls: Array<[string, unknown[]]>) => void,
  onUpdate?: (value: unknown, calls: Array<[string, unknown[]]>) => void,
): SupabaseClient {
  const deviceQuery = {
    eq: () => deviceQuery,
    is: () => deviceQuery,
    order: () => deviceQuery,
    limit: () => deviceQuery,
    then: (resolve: (value: unknown) => void) => resolve({ data: [{ id: deviceId }], error: null }),
    maybeSingle: async () => ({ data: { id: deviceId }, error: null }),
  };
  const upsertQuery = {
    select: () => upsertQuery,
    maybeSingle: async () => ({
      data: { id: 'command-id', status: 'pending', expires_at: '2026-08-21T12:00:30.000Z' },
      error: null,
    }),
  };
  const runtimeQuery = {
    eq: () => runtimeQuery,
    in: () => runtimeQuery,
    order: () => runtimeQuery,
    limit: () => runtimeQuery,
    maybeSingle: async () => ({
      data: {
        device_id: deviceId,
        status: runtimeStatus ?? ({
          version: 1,
          environment: 'demo',
          nonce: '',
          group: { id: 'group-1' },
          controller: { connected: true },
          startedAt: '2026-08-21T11:00:00.000Z',
        } as unknown as LocalCopierAgentStatus),
        last_seen_at: '2099-01-01T00:00:00.000Z',
      },
      error: null,
    }),
  };

  return {
    from: (table: string) => {
      if (table === 'tradovate_copier_devices') {
        return { select: () => deviceQuery };
      }
      if (table === 'tradovate_copier_commands') {
        const calls: Array<[string, unknown[]]> = [];
        const inFlightQuery: Record<string, unknown> = {};
        for (const method of ['eq', 'in', 'contains', 'gte', 'gt', 'or', 'order', 'limit']) {
          inFlightQuery[method] = (...args: unknown[]) => { calls.push([method, args]); return inFlightQuery; };
        }
        inFlightQuery.maybeSingle = async () => {
          onInFlightLookup?.(calls);
          return { data: typeof inFlight === 'function' ? inFlight(calls) : inFlight, error: null };
        };
        const updateCalls: Array<[string, unknown[]]> = [];
        const updateQuery: Record<string, unknown> = { error: null };
        for (const method of ['eq', 'in', 'lte']) {
          updateQuery[method] = (...args: unknown[]) => { updateCalls.push([method, args]); return updateQuery; };
        }
        return {
          select: () => inFlightQuery,
          upsert: (row: unknown, options: unknown) => {
            upsert(row, options);
            return upsertQuery;
          },
          update: (value: unknown) => {
            onUpdate?.(value, updateCalls);
            return updateQuery;
          },
        };
      }
      if (table === 'tradovate_copier_device_runtime') {
        return { select: () => runtimeQuery };
      }
      throw new Error(`unexpected-table:${table}`);
    },
  } as unknown as SupabaseClient;
}

function claimDb(row: Record<string, unknown>): SupabaseClient {
  return {
    rpc: async () => ({ data: [row], error: null }),
  } as unknown as SupabaseClient;
}

const workerStatus = (
  group: LocalCopierAgentStatus['group'],
  sessionArmedAt: number,
): LocalCopierAgentStatus => ({
  version: 1,
  environment: 'demo',
  nonce: 'device-secret-must-not-persist',
  group,
  controller: { sessionArmedAt, connected: true } as LocalCopierAgentStatus['controller'],
  startedAt: '2026-09-05T08:00:00.000Z',
});

const relayArmPayload = (multiplier = 1) => ({
  group: sanitizeCopyGroups([{
    id: 'group-1', name: 'Hlavní', enabled: true, leaderAccountId: 11,
    followers: [{ accountId: 22, mode: 'on-submit', multiplier }],
  }])![0],
  accountEligibilityExclusions: [],
});

describe('Tradovate copier command relay', () => {
  it('směruje na device z nejčerstvějšího UI runtime snapshotu, ne podle last_used_at', async () => {
    const runtimeDeviceId = '44444444-4444-4444-8444-444444444444';
    const runtimeCalls: Array<[string, unknown[]]> = [];
    const runtimeQuery: Record<string, unknown> = {};
    for (const method of ['eq', 'in', 'order', 'limit']) {
      runtimeQuery[method] = (...args: unknown[]) => { runtimeCalls.push([method, args]); return runtimeQuery; };
    }
    runtimeQuery.maybeSingle = async () => ({ data: {
      device_id: runtimeDeviceId,
      status: { group: { id: 'group-1' }, controller: { connected: true } },
      last_seen_at: '2099-01-01T00:00:00.000Z',
    }, error: null });
    const deviceQuery: Record<string, unknown> = {};
    for (const method of ['eq', 'is']) deviceQuery[method] = () => deviceQuery;
    deviceQuery.then = (resolve: (value: unknown) => void) => resolve({ data: [{ id: runtimeDeviceId }], error: null });
    deviceQuery.maybeSingle = async () => ({ data: { id: runtimeDeviceId }, error: null });
    const upsert = vi.fn();
    const upsertQuery = { select: () => upsertQuery, maybeSingle: async () => ({ data: {
      id: 'command-id', status: 'pending', expires_at: '2026-08-21T12:05:00.000Z',
    }, error: null }) };
    const db = {
      from: (table: string) => {
        if (table === 'tradovate_copier_device_runtime') return { select: () => runtimeQuery };
        if (table === 'tradovate_copier_devices') return { select: () => deviceQuery };
        if (table === 'tradovate_copier_commands') {
          const updateQuery: Record<string, unknown> = { error: null };
          for (const method of ['eq', 'in', 'lte']) updateQuery[method] = () => updateQuery;
          return {
            upsert: (row: unknown, options: unknown) => {
              upsert(row, options); return upsertQuery;
            },
            update: () => updateQuery,
          };
        }
        throw new Error(`unexpected-table:${table}`);
      },
    } as unknown as SupabaseClient;

    const queued = await enqueueTradovateCopierCommand({
      db, userId, connectionId, command: { type: 'disarm' }, now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    expect(queued.deviceId).toBe(runtimeDeviceId);
    expect(upsert.mock.calls[0][0]).toMatchObject({ device_id: runtimeDeviceId });
    expect(runtimeCalls).toContainEqual(['order', ['last_seen_at', { ascending: false }]]);
  });

  it('brzdy mají desetiminutové expiry a opakovaný shodný ARM se přichytí k jednomu rozpracovanému', async () => {
    const safetyUpsert = vi.fn();
    await enqueueTradovateCopierCommand({
      db: enqueueDb(safetyUpsert), userId, connectionId,
      command: { type: 'disarm' }, now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    expect(safetyUpsert.mock.calls[0][0].expires_at).toBe('2026-08-21T12:10:00.000Z');

    const armUpsert = vi.fn();
    const armPayload = relayArmPayload();
    const queued = await enqueueTradovateCopierCommand({
      db: enqueueDb(armUpsert, null, {
        id: 'running-arm', status: 'claimed', expires_at: '2026-08-21T12:00:30.000Z', payload: armPayload,
      }),
      userId,
      connectionId,
      command: { type: 'arm-live', group: {
        id: 'group-1', name: 'Hlavní', enabled: true, leaderAccountId: 11,
        followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }],
      } },
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    expect(queued).toMatchObject({ id: 'running-arm', status: 'claimed', deviceId });
    expect(armUpsert).not.toHaveBeenCalled();
  });

  it('ARM s jiným payloadem se k rozpracovanému ARMu nepřichytí a vrátí 409', async () => {
    const armUpsert = vi.fn();
    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(armUpsert, null, {
        id: 'running-arm', status: 'claimed', expires_at: '2026-08-21T12:00:30.000Z',
        payload: relayArmPayload(2),
      }),
      userId,
      connectionId,
      command: { type: 'arm-live', group: {
        id: 'group-1', name: 'Hlavní', enabled: true, leaderAccountId: 11,
        followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }],
      } },
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    })).rejects.toThrow('copier-relay-arm-config-conflict');
    expect(armUpsert).not.toHaveBeenCalled();
    expect(copierRelayValidationErrorStatus('copier-relay-arm-config-conflict')).toBe(409);
  });

  it('osiřelý claimed ARM po expires_at nepohltí nový ARM', async () => {
    const armUpsert = vi.fn();
    let lookup: Array<[string, unknown[]]> = [];
    await enqueueTradovateCopierCommand({
      db: enqueueDb(armUpsert, null, calls => {
        lookup = calls;
        return calls.some(([method, args]) => method === 'gt'
          && args[0] === 'expires_at'
          && args[1] === '2026-08-21T12:00:00.000Z')
          ? null
          : { id: 'stale-arm', status: 'claimed', expires_at: '2026-08-20T12:00:30.000Z' };
      }),
      userId,
      connectionId,
      command: { type: 'arm-live', group: {
        id: 'group-1', name: 'Hlavní', enabled: true, leaderAccountId: 11,
        followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }],
      } },
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    expect(lookup).toContainEqual(['gt', ['expires_at', '2026-08-21T12:00:00.000Z']]);
    expect(armUpsert).toHaveBeenCalledOnce();
  });

  it('enqueue brzdy expiruje starší pending ARM a SHADOW stejného zařízení', async () => {
    const updates: Array<{ value: unknown; calls: Array<[string, unknown[]]> }> = [];
    await enqueueTradovateCopierCommand({
      db: enqueueDb(vi.fn(), null, null, undefined, (value, calls) => {
        updates.push({ value, calls });
      }),
      userId,
      connectionId,
      command: { type: 'disarm' },
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].value).toEqual(expect.objectContaining({
      status: 'expired', error: 'superseded-by-brake',
    }));
    expect(updates[0].calls).toEqual(expect.arrayContaining([
      ['eq', ['device_id', deviceId]],
      ['eq', ['status', 'pending']],
      ['in', ['command_type', ['arm-live', 'shadow']]],
      ['lte', ['created_at', '2026-08-21T12:00:00.000Z']],
    ]));
  });

  it('souběžně vložený druhý ARM expiruje a vrátí ID nejstaršího canonical ARMu', async () => {
    const runtimeQuery: Record<string, unknown> = {};
    for (const method of ['eq', 'in', 'order', 'limit']) runtimeQuery[method] = () => runtimeQuery;
    runtimeQuery.maybeSingle = async () => ({ data: {
      device_id: deviceId,
      status: { group: { id: 'group-1' }, controller: { connected: true } },
      last_seen_at: '2099-01-01T00:00:00.000Z',
    }, error: null });
    const deviceQuery: Record<string, unknown> = {};
    for (const method of ['eq', 'is']) deviceQuery[method] = () => deviceQuery;
    deviceQuery.then = (resolve: (value: unknown) => void) => resolve({ data: [{ id: deviceId }], error: null });
    deviceQuery.maybeSingle = async () => ({ data: { id: deviceId }, error: null });
    let commandLookup = 0;
    const selected: Record<string, unknown> = {};
    for (const method of ['eq', 'in', 'gt', 'or', 'order', 'limit']) selected[method] = () => selected;
    selected.maybeSingle = async () => ({
      data: ++commandLookup < 4 ? null : {
        id: 'older-arm', status: 'pending', expires_at: '2026-08-21T12:00:30.000Z',
        payload: relayArmPayload(),
      },
      error: null,
    });
    const inserted = {
      select: () => inserted,
      maybeSingle: async () => ({ data: {
        id: 'newer-arm', status: 'pending', expires_at: '2026-08-21T12:00:30.000Z',
      }, error: null }),
    };
    const expiredRows: unknown[] = [];
    const updateQuery: Record<string, unknown> = { error: null };
    updateQuery.eq = () => updateQuery;
    const db = { from: (table: string) => {
      if (table === 'tradovate_copier_device_runtime') return { select: () => runtimeQuery };
      if (table === 'tradovate_copier_devices') return { select: () => deviceQuery };
      if (table === 'tradovate_copier_commands') return {
        select: () => selected,
        upsert: () => inserted,
        update: (value: unknown) => { expiredRows.push(value); return updateQuery; },
      };
      throw new Error(`unexpected-table:${table}`);
    } } as unknown as SupabaseClient;
    const queued = await enqueueTradovateCopierCommand({
      db, userId, connectionId,
      command: { type: 'arm-live', group: {
        id: 'group-1', name: 'Hlavní', enabled: true, leaderAccountId: 11,
        followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }],
      } },
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    expect(queued).toMatchObject({ id: 'older-arm', deviceId });
    expect(expiredRows).toEqual([expect.objectContaining({ status: 'expired', error: 'duplicate-arm-superseded' })]);
  });

  it('ARM odmítne okamžitě, když UI runtime snapshot hlásí odpojený worker', async () => {
    const disconnected = workerStatus({
      id: 'group-1', name: 'Hlavní', enabled: true, leaderAccountId: 11,
      followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }],
    }, 0);
    disconnected.controller.connected = false;
    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(vi.fn(), disconnected), userId, connectionId,
      command: { type: 'arm-live', group: disconnected.group },
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    })).rejects.toThrow('copier-relay-worker-disconnected');
  });

  it('snapshot-test ukládá prázdný neobchodní payload a při claimu dostane ID commandu', async () => {
    const upsert = vi.fn();
    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert),
      userId,
      connectionId,
      deviceId,
      command: { type: 'snapshot-test' },
      idempotencyKey: 'snapshot-test-request-1',
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    expect(upsert.mock.calls[0][0]).toMatchObject({
      command_type: 'snapshot-test',
      payload: {},
      device_id: deviceId,
    });

    const requestId = '44444444-4444-4444-8444-444444444444';
    const claimed = await claimTradovateCopierCommand({
      db: claimDb({
        id: requestId,
        command_type: 'snapshot-test',
        payload: {},
        expires_at: '2026-08-21T12:00:30.000Z',
        status: 'claimed', result: null, error: null,
      }),
      deviceId,
    });
    expect(claimed?.command).toEqual({ type: 'snapshot-test', requestId });
  });

  it('přenese výslovnou opravu snapshot kamery bez nového brokerového command typu', async () => {
    const upsert = vi.fn();
    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert),
      userId,
      connectionId,
      deviceId,
      command: { type: 'snapshot-test', repairCamera: true },
      idempotencyKey: 'snapshot-camera-repair-1',
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    expect(upsert.mock.calls[0][0]).toMatchObject({
      command_type: 'snapshot-test',
      payload: { repairCamera: true },
    });

    const requestId = '66666666-6666-4666-8666-666666666666';
    const claimed = await claimTradovateCopierCommand({
      db: claimDb({
        id: requestId,
        command_type: 'snapshot-test',
        payload: { repairCamera: true },
        expires_at: '2026-08-21T12:00:30.000Z',
        status: 'claimed', result: null, error: null,
      }),
      deviceId,
    });
    expect(claimed?.command).toEqual({ type: 'snapshot-test', requestId, repairCamera: true });
  });

  it('přenese cílené read-only ověření účtu beze změny payloadu', async () => {
    const upsert = vi.fn();
    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert),
      userId,
      connectionId,
      command: { type: 'verify-account-eligibility', accountId: 63338752 },
      idempotencyKey: 'verify-account-63338752',
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    expect(upsert.mock.calls[0][0]).toMatchObject({
      command_type: 'verify-account-eligibility',
      payload: { accountId: 63338752 },
    });

    const claimed = await claimTradovateCopierCommand({
      db: claimDb({
        id: 'verify-command-id',
        command_type: 'verify-account-eligibility',
        payload: { accountId: 63338752 },
        expires_at: '2026-08-21T12:00:30.000Z',
        status: 'claimed', result: null, error: null,
      }),
      deviceId,
    });
    expect(claimed?.command).toEqual({ type: 'verify-account-eligibility', accountId: 63338752 });
  });

  it('přenese read-only Kontrolu pozic z telefonu (reconcile) s prázdným payloadem', async () => {
    const upsert = vi.fn();
    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert),
      userId,
      connectionId,
      command: { type: 'reconcile' },
      idempotencyKey: 'reconcile-from-phone-001',
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    expect(upsert.mock.calls[0][0]).toMatchObject({ command_type: 'reconcile', payload: {} });

    const claimed = await claimTradovateCopierCommand({
      db: claimDb({
        id: 'reconcile-command-id',
        command_type: 'reconcile',
        payload: {},
        expires_at: '2026-08-21T12:00:30.000Z',
        status: 'claimed', result: null, error: null,
      }),
      deviceId,
    });
    expect(claimed?.command).toEqual({ type: 'reconcile' });
  });

  it('odmítne neplatné ID cíleného ověření', async () => {
    const upsert = vi.fn();
    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(upsert), userId, connectionId,
      command: { type: 'verify-account-eligibility', accountId: 0 },
    })).rejects.toThrow('invalid-relay-command-payload');
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each<CopyCommand>([
    {
      type: 'copy-command',
      command: { type: 'set-follower-enabled', groupId: 'group-1', accountId: 42, enabled: false },
    },
    {
      type: 'copy-command',
      command: { type: 'flatten-group', groupId: 'group-1', operationId: 'flatten-all-1' },
    },
    {
      type: 'copy-command',
      command: {
        type: 'flatten-account', groupId: 'group-1', accountId: 42, operationId: 'flatten-one-1',
      },
    },
    {
      type: 'copy-command',
      command: {
        type: 'flatten-follower-trade', groupId: 'group-1', accountId: 42, operationId: 'flatten-trade-1',
      },
    },
  ])('enqueue přijme $command.type a uloží celý command do payloadu', async command => {
    const upsert = vi.fn();

    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert),
      userId,
      connectionId,
      command,
      idempotencyKey: `key-${command.command.type}`,
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });

    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0][0]).toMatchObject({
      command_type: 'copy-command',
      payload: { command: command.command },
    });
  });

  it('relay odmítne neplatný follower toggle ještě před enqueue', async () => {
    const upsert = vi.fn();
    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(upsert), userId, connectionId,
      command: { type: 'copy-command', command: {
        type: 'set-follower-enabled', groupId: 'group-1', accountId: 42, enabled: 'false',
      } } as unknown as LocalCopierAgentCommand,
    })).rejects.toThrow('invalid-relay-command-payload');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('claim validuje a předá follower toggle workeru', async () => {
    const claimed = await claimTradovateCopierCommand({
      db: claimDb({
        id: 'toggle-command-id', command_type: 'copy-command',
        payload: { command: {
          type: 'set-follower-enabled', groupId: 'group-1', accountId: 42, enabled: false,
        } },
        expires_at: '2026-08-21T12:00:30.000Z', status: 'claimed', result: null, error: null,
      }),
      deviceId,
    });
    expect(claimed?.command).toEqual({ type: 'copy-command', command: {
      type: 'set-follower-enabled', groupId: 'group-1', accountId: 42, enabled: false,
    } });
  });

  it('enqueue odmítne vzdálený cancel-order', async () => {
    const upsert = vi.fn();

    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(upsert),
      userId,
      connectionId,
      command: {
        type: 'copy-command',
        command: { type: 'cancel-order', groupId: 'group-1', orderId: 123 },
      },
    })).rejects.toThrow('unsupported-remote-copy-command');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('enqueue odmítne device-paired', async () => {
    const upsert = vi.fn();

    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(upsert),
      userId,
      connectionId,
      command: { type: 'device-paired', deviceId },
    })).rejects.toThrow('unsupported-relay-command');
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each<CopyCommand>([
    { type: 'copy-command', command: { type: 'flatten-group', groupId: 'group-1', operationId: 'flatten-all-2' } },
    { type: 'copy-command', command: { type: 'flatten-account', groupId: 'group-1', accountId: 42, operationId: 'flatten-one-2' } },
    { type: 'copy-command', command: { type: 'flatten-follower-trade', groupId: 'group-1', accountId: 42, operationId: 'flatten-trade-2' } },
  ])('$command.type se přichytí k už běžícímu Flattenu stejného cíle místo druhé likvidace', async command => {
    // 17. 9. 2026: druhý Flatten All vypršel ve frontě, protože worker 265 s
    // vykonával první; UI má čekat na výsledek toho běžícího.
    const upsert = vi.fn();
    let lookup: Array<[string, unknown[]]> = [];
    const queued = await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert, null, { id: 'running-flatten', status: 'claimed', expires_at: '2026-08-21T12:00:30.000Z' }, calls => { lookup = calls; }),
      userId, connectionId, command, now: Date.parse('2026-08-21T12:03:00.000Z'),
    });
    expect(queued).toEqual({ id: 'running-flatten', status: 'claimed', expiresAt: '2026-08-21T12:00:30.000Z', deviceId });
    expect(upsert).not.toHaveBeenCalled();
    expect(lookup).toContainEqual(['contains', ['payload', { command: command.command.type === 'flatten-group'
      ? { type: 'flatten-group', groupId: 'group-1' }
      : { type: command.command.type, groupId: 'group-1', accountId: 42 } }]]);
    expect(lookup).toContainEqual(['or', ['status.eq.claimed,and(status.eq.pending,expires_at.gt.2026-08-21T12:03:00.000Z)']]);
  });

  it('bez běžícího Flattenu vznikne nový příkaz a ARM se k Flattenu nikdy nepřichytí', async () => {
    const upsert = vi.fn();
    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert, null, null), userId, connectionId,
      command: { type: 'copy-command', command: { type: 'flatten-group', groupId: 'group-1', operationId: 'flatten-all-3' } },
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    expect(upsert).toHaveBeenCalledTimes(1);
    const lookups = vi.fn();
    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert, null, { id: 'running-flatten', status: 'claimed', expires_at: '2026-08-21T12:00:30.000Z' }, lookups),
      userId, connectionId, command: { type: 'disarm' }, now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(lookups).not.toHaveBeenCalled();
  });

  it('claim vrátí flatten command beze změny', async () => {
    const command = { type: 'flatten-group', groupId: 'group-1', operationId: 'flatten-all-1' } as const;

    const claimed = await claimTradovateCopierCommand({
      db: claimDb({
        id: 'command-id',
        command_type: 'copy-command',
        payload: { command },
        expires_at: '2026-08-21T12:00:30.000Z',
        status: 'claimed',
        result: null,
        error: null,
      }),
      deviceId,
    });

    expect(claimed?.command).toEqual({ type: 'copy-command', command });
    expect(claimed?.command.type).toBe('copy-command');
    if (claimed?.command.type !== 'copy-command') throw new Error('expected-copy-command');
    expect(claimed.command.command.type).toBe('flatten-group');
    if (claimed.command.command.type !== 'flatten-group') throw new Error('expected-flatten-group');
    expect(claimed.command.command.groupId).toBe('group-1');
    expect(claimed.command.command.operationId).toBe('flatten-all-1');
  });

  it('ownership waiver u update-group zachová jen jako explicitní true', async () => {
    const group = {
      id: 'group-1', name: 'Hlavní', enabled: false, leaderAccountId: 11,
      followers: [{ accountId: 22, mode: 'on-submit' as const, multiplier: 1 }],
    };
    const command = {
      type: 'copy-command' as const,
      command: {
        type: 'update-group' as const,
        group,
        waiveUnverifiableFollowerOwnership: true as const,
      },
    };
    const upsert = vi.fn();
    await enqueueTradovateCopierCommand({ db: enqueueDb(upsert), userId, connectionId, command });
    expect(upsert.mock.calls[0][0].payload).toEqual({ command: command.command });

    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(vi.fn()), userId, connectionId,
      command: {
        type: 'copy-command',
        command: {
          type: 'update-group', group,
          waiveUnverifiableFollowerOwnership: 'yes',
        },
      } as unknown as LocalCopierAgentCommand,
    })).rejects.toThrow('invalid-relay-command-payload');
  });

  it('activate-group přenese uživatelem potvrzené vyřazení breachnutých účtů a odmítne vadné', async () => {
    const group = {
      id: 'group-2', name: 'Nová', enabled: false, leaderAccountId: 11,
      followers: [{ accountId: 22, mode: 'on-submit' as const, multiplier: 1 }],
    };
    const retireMissingOldGroup = { groupId: 'group-1', accountIds: [100, 200], reason: 'Uživatel v appce potvrdil vyřazení účtů 100, 200' };
    const upsert = vi.fn();
    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert), userId, connectionId,
      command: { type: 'activate-group', group, retireMissingOldGroup },
    });
    expect(upsert.mock.calls[0][0].payload).toMatchObject({ retireMissingOldGroup });
    const claimed = await claimTradovateCopierCommand({
      db: claimDb({
        id: 'command-id', command_type: 'activate-group',
        payload: { group, retireMissingOldGroup },
        expires_at: '2026-08-21T12:00:30.000Z', status: 'claimed', result: null, error: null,
      }),
      deviceId,
    });
    expect(claimed?.command).toMatchObject({ type: 'activate-group', retireMissingOldGroup });
    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(vi.fn()), userId, connectionId,
      command: { type: 'activate-group', group, retireMissingOldGroup: { groupId: 'group-1', accountIds: [-1], reason: 'x' } },
    } as never)).rejects.toThrow('invalid-relay-command-payload');
  });

  it('claim odmítne starý nebo ručně vložený cancel-order payload', async () => {
    await expect(claimTradovateCopierCommand({
      db: claimDb({
        id: 'command-id',
        command_type: 'copy-command',
        payload: { command: { type: 'cancel-order', groupId: 'group-1', orderId: 123 } },
        expires_at: '2026-08-21T12:00:30.000Z',
        status: 'claimed',
        result: null,
        error: null,
      }),
      deviceId,
    })).rejects.toThrow('unsupported-remote-copy-command');
  });
});

describe('ARM přes relay nese konfiguraci skupiny', () => {
  const skupina = {
    id: 'group-1',
    name: 'Hlavní',
    enabled: true,
    leaderAccountId: 62364058,
    followers: [{ accountId: 62364057, mode: 'on-submit' as const, multiplier: 2 }],
    safety: {
      dayRuleActions: DEFAULT_COPY_GROUP_SAFETY.dayRuleActions,
      dailyLossLimitUsd: 500,
      dailyMaxLosingTrades: 0,
      dailyMaxTrades: 10,
      tradingWindow: { enabled: true, from: '15:30', to: '22:00', timeZone: 'Europe/Prague' },
      entryCooldownMinutes: 15,
      armExpiryFlatten: 'followers' as const,
      positionReconciler: true,
      disableReplicationOnBreach: true,
      autoCloseFollowerPositions: true,
      preventHedging: true,
    },
  };

  it('uloží safety do payloadu — bez toho worker ARMuje bez denního limitu', async () => {
    const upsert = vi.fn();
    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert),
      userId,
      connectionId,
      command: {
        type: 'arm-live',
        group: skupina,
        accountEligibilityExclusions: [{
          accountId: 62364057,
          state: 'dll-locked',
          reason: 'LIVE denní P&L dosáhlo DLL',
        }],
      } as LocalCopierAgentCommand,
      idempotencyKey: 'arm-1',
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });

    expect(upsert).toHaveBeenCalledOnce();
    const payload = upsert.mock.calls[0][0].payload as {
      group?: { safety?: Record<string, unknown> };
      accountEligibilityExclusions?: unknown[];
    };
    expect(upsert.mock.calls[0][0].command_type).toBe('arm-live');
    expect(payload.group?.safety).toMatchObject({
      dailyLossLimitUsd: 500,
      dailyMaxTrades: 10,
      tradingWindow: { enabled: true, from: '15:30', to: '22:00', timeZone: 'Europe/Prague' },
      entryCooldownMinutes: 15,
      armExpiryFlatten: 'followers',
    });
    expect(payload.accountEligibilityExclusions).toEqual([{
      accountId: 62364057,
      state: 'dll-locked',
      reason: 'LIVE denní P&L dosáhlo DLL',
    }]);
  });

  it('odmítne pokus přes relay eligibility aktivovat nebo odemknout', async () => {
    const upsert = vi.fn();
    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(upsert),
      userId,
      connectionId,
      command: {
        type: 'arm-live',
        group: skupina,
        accountEligibilityExclusions: [{ accountId: 62364057, state: 'active', reason: 'odemknout' }],
      } as unknown as LocalCopierAgentCommand,
    })).rejects.toThrow('invalid-relay-command-payload');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('claim vrátí ARM safety exclusions beze ztráty', async () => {
    const claimed = await claimTradovateCopierCommand({
      db: claimDb({
        id: 'arm-command-id',
        command_type: 'arm-live',
        payload: {
          group: skupina,
          accountEligibilityExclusions: [{
            accountId: 62364057,
            state: 'dll-locked',
            reason: 'LIVE denní P&L dosáhlo DLL',
          }],
        },
        expires_at: '2026-08-21T12:00:30.000Z',
        status: 'claimed',
        result: null,
        error: null,
      }),
      deviceId,
    });

    expect(claimed?.command).toMatchObject({
      type: 'arm-live',
      group: skupina,
      accountEligibilityExclusions: [{
        accountId: 62364057,
        state: 'dll-locked',
        reason: 'LIVE denní P&L dosáhlo DLL',
      }],
    });
  });

  it('odmítne ARM úplně bez skupiny — nikdy ho tiše nepřevede na {}', async () => {
    // 24. 8.: payload {} → worker se ozbrojil se zastaralou konfigurací
    // (enabled:false) a první obchod se nezkopíroval.
    const upsert = vi.fn();
    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(upsert),
      userId,
      connectionId,
      command: { type: 'arm-live' } as unknown as LocalCopierAgentCommand,
    })).rejects.toThrow('invalid-relay-command');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('odmítne strukturálně vadnou skupinu místo tichého zahození', async () => {
    const upsert = vi.fn();
    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(upsert),
      userId,
      connectionId,
      command: { type: 'arm-live', group: { id: 'x' } } as unknown as LocalCopierAgentCommand,
    })).rejects.toThrow('invalid-relay-command');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('activate-group projde relay beze ztráty konfigurace a nejde zaměnit za ARM', async () => {
    const upsert = vi.fn();
    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert),
      userId,
      connectionId,
      command: { type: 'activate-group', group: skupina },
      idempotencyKey: 'activate-group-1',
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });

    expect(upsert.mock.calls[0][0]).toMatchObject({
      command_type: 'activate-group',
      payload: { group: skupina },
    });

    const claimed = await claimTradovateCopierCommand({
      db: claimDb({
        id: 'command-id',
        command_type: 'activate-group',
        payload: { group: skupina },
        expires_at: '2026-08-21T12:00:30.000Z',
        status: 'claimed',
        result: null,
        error: null,
      }),
      deviceId,
    });
    expect(claimed?.command).toMatchObject({ type: 'activate-group', group: skupina });
  });

  it('lock-until-session-end projde relay jako riziko snižující příkaz s očištěným důvodem', async () => {
    const upsert = vi.fn();
    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert),
      userId,
      connectionId,
      deviceId,
      command: { type: 'lock-until-session-end', reason: '  Ruční denní lock z AlphaTrade LIVE UI  ' },
      idempotencyKey: 'day-lock-1',
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    expect(upsert.mock.calls[0][0]).toMatchObject({
      command_type: 'lock-until-session-end',
      payload: { reason: 'Ruční denní lock z AlphaTrade LIVE UI' },
      device_id: deviceId,
    });

    const claimed = await claimTradovateCopierCommand({
      db: claimDb({
        id: '77777777-7777-4777-8777-777777777777',
        command_type: 'lock-until-session-end',
        payload: { reason: 'Ruční denní lock z AlphaTrade LIVE UI', extra: 'ignored' },
        expires_at: '2026-08-21T12:00:30.000Z',
        status: 'claimed', result: null, error: null,
      }),
      deviceId,
    });
    expect(claimed?.command).toEqual({
      type: 'lock-until-session-end',
      reason: 'Ruční denní lock z AlphaTrade LIVE UI',
    });
  });

  it('lock-until-session-end odmítá chybějící, krátký, dlouhý nebo řídicími znaky znečištěný důvod', async () => {
    const attempt = (reason: unknown) => enqueueTradovateCopierCommand({
      db: enqueueDb(vi.fn()),
      userId,
      connectionId,
      deviceId,
      command: { type: 'lock-until-session-end', reason } as LocalCopierAgentCommand,
      idempotencyKey: 'day-lock-invalid',
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    await expect(attempt(undefined)).rejects.toThrow('invalid-relay-command-payload');
    await expect(attempt(42)).rejects.toThrow('invalid-relay-command-payload');
    await expect(attempt('  ab ')).rejects.toThrow('invalid-relay-command-payload');
    await expect(attempt('x'.repeat(201))).rejects.toThrow('invalid-relay-command-payload');
    await expect(attempt('lock\u0000injected')).rejects.toThrow('invalid-relay-command-payload');

    await expect(claimTradovateCopierCommand({
      db: claimDb({
        id: '88888888-8888-4888-8888-888888888888',
        command_type: 'lock-until-session-end',
        payload: {},
        expires_at: '2026-08-21T12:00:30.000Z',
        status: 'claimed', result: null, error: null,
      }),
      deviceId,
    })).rejects.toThrow('invalid-relay-command-payload');
  });

  it('unlock-day odmítne enqueue i ručně vložený claim jako unsupported-command', async () => {
    const upsert = vi.fn();
    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(upsert), userId, connectionId, deviceId,
      command: { type: 'unlock-day', reason: '  Vědomé odemknutí po pauze  ' },
    })).rejects.toThrow('unsupported-command');
    expect(upsert).not.toHaveBeenCalled();

    await expect(claimTradovateCopierCommand({
      db: claimDb({
        id: '99999999-9999-4999-8999-999999999999',
        command_type: 'unlock-day',
        payload: { reason: 'Vědomé odemknutí po pauze' },
        expires_at: '2026-08-21T12:00:30.000Z',
        status: 'claimed', result: null, error: null,
      }),
      deviceId,
    })).rejects.toThrow('unsupported-command');

    expect(copierRelayValidationErrorStatus('unsupported-command')).toBe(400);
  });

  it('mapuje tighten-only na HTTP 409 a neznámou serverovou chybu nemaskuje', () => {
    expect(copierRelayValidationErrorStatus('tighten-only')).toBe(409);
    expect(copierRelayValidationErrorStatus('store-unavailable')).toBeNull();
  });

  it('heartbeat/report zachová poslední group + sessionArmedAt pro relay bránu', async () => {
    const runtimeUpsert = vi.fn();
    const status = workerStatus(skupina, 1_788_595_200_000);
    const db = {
      from: (table: string) => {
        if (table !== 'tradovate_copier_device_runtime') throw new Error(`unexpected-table:${table}`);
        return {
          upsert: async (row: unknown, options: unknown) => {
            runtimeUpsert(row, options);
            return { error: null };
          },
        };
      },
    } as unknown as SupabaseClient;

    await heartbeatTradovateCopierDevice({ db, deviceId, userId, connectionId, status });

    expect(runtimeUpsert).toHaveBeenCalledOnce();
    expect(runtimeUpsert.mock.calls[0][0]).toMatchObject({
      device_id: deviceId,
      user_id: userId,
      connection_id: connectionId,
      status: {
        nonce: '',
        group: skupina,
        controller: { sessionArmedAt: 1_788_595_200_000 },
      },
    });
  });

  it.each([
    ['update-group', (group: typeof skupina): LocalCopierAgentCommand => ({
      type: 'copy-command', command: { type: 'update-group', group },
    })],
    ['activate-group', (group: typeof skupina): LocalCopierAgentCommand => ({ type: 'activate-group', group })],
    ['arm-live', (group: typeof skupina): LocalCopierAgentCommand => ({ type: 'arm-live', group })],
  ] as const)('tighten-only odmítne mírnější %s ještě před enqueue', async (_type, commandFor) => {
    const upsert = vi.fn();
    const weaker = {
      ...skupina,
      safety: { ...skupina.safety, dailyMaxTrades: skupina.safety.dailyMaxTrades + 1 },
    };

    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(upsert, workerStatus(skupina, 1_788_595_200_000)),
      userId,
      connectionId,
      deviceId,
      command: commandFor(weaker),
    })).rejects.toThrow('tighten-only');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('tighten-only dál odmítne zvýšení násobku před enqueue', async () => {
    const upsert = vi.fn();
    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(upsert, workerStatus(skupina, 1_788_595_200_000)),
      userId,
      connectionId,
      deviceId,
      command: {
        type: 'copy-command',
        command: { type: 'set-multiplier', groupId: skupina.id, accountId: 62364057, multiplier: 3 },
      },
    })).rejects.toThrow('tighten-only');
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['re-enable followera', {
      ...skupina,
      followers: [{ ...skupina.followers[0], enabled: false }],
    }, {
      type: 'copy-command',
      command: { type: 'set-follower-enabled', groupId: skupina.id, accountId: 62364057, enabled: true },
    }],
    ['on-submit → on-fill', skupina, {
      type: 'copy-command',
      command: { type: 'set-replication', groupId: skupina.id, accountId: 62364057, mode: 'on-fill' },
    }],
  ] as const)('P-B relay dovolí %s a worker pak autoritativně ověří flat', async (_label, current, command) => {
    const upsert = vi.fn();
    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert, workerStatus({ ...current, followers: [...current.followers] }, 1_788_595_200_000)),
      userId,
      connectionId,
      deviceId,
      command: command as LocalCopierAgentCommand,
    });
    expect(upsert).toHaveBeenCalledOnce();
  });

  it.each([
    ['vypnutí followera bez čitelné group', {
      type: 'copy-command',
      command: { type: 'set-follower-enabled', groupId: skupina.id, accountId: 62364057, enabled: false },
    }],
    ['mode off při statusu jiné group', {
      type: 'copy-command',
      command: { type: 'set-replication', groupId: skupina.id, accountId: 62364057, mode: 'off' },
    }],
  ] as const)('risk-snižující %s projde relay bez baseline', async (_label, command) => {
    const upsert = vi.fn();
    const unreadable = _label.includes('nečitelné')
      ? ({ id: 'broken' } as LocalCopierAgentStatus['group'])
      : ({ ...skupina, id: 'other-group' } as LocalCopierAgentStatus['group']);
    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert, workerStatus(unreadable, 1_788_595_200_000)),
      userId,
      connectionId,
      deviceId,
      command: command as LocalCopierAgentCommand,
    });
    expect(upsert).toHaveBeenCalledOnce();
  });

  it.each(['update-group', 'arm-live'] as const)('%s mapuje stale enabled z runtime baseline', async type => {
    const upsert = vi.fn();
    const runtimeGroup = {
      ...skupina,
      followers: [{ ...skupina.followers[0], enabled: false }],
    };
    const command = type === 'arm-live'
      ? { type, group: skupina }
      : { type: 'copy-command', command: { type, group: { ...skupina, name: 'Přejmenováno' } } };
    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert, workerStatus(runtimeGroup, 1_788_595_200_000)),
      userId,
      connectionId,
      deviceId,
      command: command as LocalCopierAgentCommand,
    });
    expect(upsert).toHaveBeenCalledOnce();
  });

  it('před prvním ARM relay dovolí i zmírnění a worker zůstává autoritou', async () => {
    const upsert = vi.fn();
    const weaker = {
      ...skupina,
      safety: { ...skupina.safety, dailyMaxTrades: skupina.safety.dailyMaxTrades + 1 },
    };

    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert, workerStatus(skupina, 0)),
      userId,
      connectionId,
      deviceId,
      command: { type: 'arm-live', group: weaker },
    });

    expect(upsert).toHaveBeenCalledOnce();
  });

  it('za tighten-only session povolí skutečné zpřísnění', async () => {
    const upsert = vi.fn();
    const tighter = {
      ...skupina,
      safety: { ...skupina.safety, dailyMaxTrades: skupina.safety.dailyMaxTrades - 1 },
    };

    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert, workerStatus(skupina, 1_788_595_200_000)),
      userId,
      connectionId,
      deviceId,
      command: { type: 'arm-live', group: tighter },
    });

    expect(upsert).toHaveBeenCalledOnce();
  });
});
