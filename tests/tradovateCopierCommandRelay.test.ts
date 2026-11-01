import { DEFAULT_COPY_GROUP_SAFETY, sanitizeCopyGroups } from '../services/liveCopyTrading';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { LocalCopierAgentCommand, LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import { buildLeaderEntryPlaceCommand } from '../lib/leaderEntryPlace';
import { buildLeaderOrderManageCommand } from '../lib/leaderOrderManage';
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
        for (const method of ['eq', 'in', 'lte', 'contains']) {
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

  it('interní target hint nikdy nezkrátí plný výběr zařízení pro brzdu', async () => {
    const upsert = vi.fn();
    const queued = await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert),
      userId,
      connectionId,
      command: { type: 'disarm' },
      verifiedDevice: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: { startedAt: '2026-10-31T02:00:00.000Z' } as LocalCopierAgentStatus,
        lastSeenAt: '2099-01-01T00:00:00.000Z',
      },
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    expect(queued.deviceId).toBe(deviceId);
    expect(upsert.mock.calls[0][0]).toMatchObject({ device_id: deviceId });
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

  describe('denní strop ručních vstupů (100 za 24 h, Filip 30. 10.; od 1. 11. atomicky v RPC)', () => {
    const entryDb = (resultCode: string, upsert: (row: unknown) => void, rpcCalls: unknown[][] = []): SupabaseClient => {
      const devices = { eq: () => devices, is: () => devices,
        then: (resolve: (value: unknown) => void) => resolve({ data: [{ id: deviceId }], error: null }) };
      const runtime = { eq: () => runtime, in: () => runtime, order: () => runtime, limit: () => runtime,
        maybeSingle: async () => ({ data: { device_id: deviceId, status: { controller: { connected: true } }, last_seen_at: '2099-01-01T00:00:00.000Z' }, error: null }) };
      return { from: (table: string) => {
        if (table === 'tradovate_copier_devices') return { select: () => devices };
        if (table === 'tradovate_copier_device_runtime') return { select: () => runtime };
        if (table === 'tradovate_copier_commands') return { upsert: (row: unknown) => { upsert(row); throw new Error('unexpected-direct-insert'); } };
        throw new Error(`unexpected-table:${table}`);
      }, rpc: async (...call: unknown[]) => {
        rpcCalls.push(call);
        return { data: [{ result_code: resultCode, id: resultCode === 'inserted' ? 'entry-row' : null,
          status: resultCode === 'inserted' ? 'pending' : null,
          expires_at: resultCode === 'inserted' ? '2026-08-21T12:00:15.000Z' : null,
          device_id: resultCode === 'inserted' ? deviceId : null }], error: null };
      } } as unknown as SupabaseClient;
    };
    const entry = (): LocalCopierAgentCommand => ({ type: 'copy-command', command: buildLeaderEntryPlaceCommand({
      type: 'preview-leader-entry', groupId: 'group-1', operationId: 'preview:captest00001', leaderAccountId: 100,
      symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 29_500, stopLoss: 29_480, takeProfit: 29_560,
      intent: { armedAt: 1, groupConfigHash: 'abcdefgh12345678', followerQuantities: [] },
    }, 'entry:captest00001') as CopyCommand['command'] });

    it('strop 100 a rozestupy jdou do RPC; vložení dělá jen RPC, nikdy přímý upsert', async () => {
      const upsert = vi.fn();
      const calls: unknown[][] = [];
      const queued = await enqueueTradovateCopierCommand({ db: entryDb('inserted', upsert, calls), userId, connectionId, command: entry(), now: Date.parse('2026-08-21T12:00:00.000Z') });
      expect(queued).toMatchObject({ id: 'entry-row', status: 'pending', deviceId });
      expect(upsert).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('admit_tradovate_copier_manual_command');
      expect(calls[0][1]).toMatchObject({
        p_user_id: userId, p_device_id: deviceId, p_connection_id: connectionId, p_operation_id: 'entry:captest00001',
        p_now: '2026-08-21T12:00:00.000Z', p_expires_at: '2026-08-21T12:00:15.000Z',
        p_entry_min_interval_ms: 3_000, p_manage_min_interval_ms: 2_000, p_entry_cap: 100, p_manage_cap: 100,
      });
    });

    const manageCmd = (action: 'move-stop' | 'close-position'): LocalCopierAgentCommand => ({ type: 'copy-command', command: buildLeaderOrderManageCommand({
      groupId: 'group-1', operationId: `manage:capcheck-${action}`, leaderAccountId: 100, entryOperationId: 'entry:captest00001', symbol: 'MNQZ6',
      action, expect: { price: 29_480, quantity: 1 }, ...(action === 'move-stop' ? { newPrice: 29_470 } : {}),
    }) as CopyCommand['command'] });

    it('zavření obchodu má platnost 5 s, ostatní správa 15 s', async () => {
      const calls: unknown[][] = [];
      await enqueueTradovateCopierCommand({ db: entryDb('inserted', vi.fn(), calls), userId, connectionId, command: manageCmd('close-position'), now: Date.parse('2026-08-21T12:00:00.000Z') });
      await enqueueTradovateCopierCommand({ db: entryDb('inserted', vi.fn(), calls), userId, connectionId, command: manageCmd('move-stop'), now: Date.parse('2026-08-21T12:00:00.000Z') });
      expect(calls.map(call => (call[1] as { p_expires_at: string }).p_expires_at))
        .toEqual(['2026-08-21T12:00:05.000Z', '2026-08-21T12:00:15.000Z']);
    });

    it('entry-daily-cap z RPC → 409, nic se nevloží', async () => {
      const upsert = vi.fn();
      await expect(enqueueTradovateCopierCommand({ db: entryDb('entry-daily-cap', upsert), userId, connectionId, command: entry(), now: Date.parse('2026-08-21T12:00:00.000Z') }))
        .rejects.toThrow('copier-relay-entry-daily-cap');
      expect(upsert).not.toHaveBeenCalled();
      expect(copierRelayValidationErrorStatus('copier-relay-entry-daily-cap')).toBe(409);
    });
  });

  describe('správa z grafu: souběžná čtení admission (30. 10., F1f)', () => {
    const manageInner = (operationId: string) => buildLeaderOrderManageCommand({
      groupId: 'group-1', operationId, leaderAccountId: 100, entryOperationId: 'entry:relaytest01', symbol: 'MNQZ6',
      action: 'move-stop', expect: { price: 29_000, quantity: 1 }, newPrice: 28_990,
    });
    const manage = (operationId: string): LocalCopierAgentCommand => (
      { type: 'copy-command', command: manageInner(operationId) as CopyCommand['command'] });
    const now = Date.parse('2026-08-21T12:00:00.000Z');

    const rpcDb = (row: Record<string, unknown> | null, upsert = vi.fn(), error: { message: string } | null = null) => Object.assign(
      enqueueDb(upsert, null, null),
      { rpc: vi.fn(async () => ({ data: row ? [row] : [], error })) },
    );

    it('existující operace (i z jiného zařízení) vrátí původní řádek a kick míří na jeho zařízení', async () => {
      const db = rpcDb({ result_code: 'existing', id: 'existing-id', status: 'claimed', expires_at: '2026-08-21T12:00:15.000Z',
        device_id: '44444444-4444-4444-8444-444444444444' });
      const queued = await enqueueTradovateCopierCommand({ db, userId, connectionId, command: manage('manage:replay-01'), now });
      expect(queued).toMatchObject({ id: 'existing-id', status: 'claimed', deviceId: '44444444-4444-4444-8444-444444444444' });
    });

    it('busy z RPC → copier-relay-entry-busy (409)', async () => {
      await expect(enqueueTradovateCopierCommand({ db: rpcDb({ result_code: 'entry-busy' }), userId, connectionId, command: manage('manage:busycheck-01'), now }))
        .rejects.toThrow('copier-relay-entry-busy');
    });

    it('brzda těsně před admission → copier-relay-entry-superseded (409), nic se nevloží', async () => {
      const upsert = vi.fn();
      await expect(enqueueTradovateCopierCommand({ db: rpcDb({ result_code: 'superseded-by-brake' }, upsert), userId, connectionId, command: manage('manage:brakecheck-01'), now }))
        .rejects.toThrow('copier-relay-entry-superseded');
      expect(upsert).not.toHaveBeenCalled();
      expect(copierRelayValidationErrorStatus('copier-relay-entry-superseded')).toBe(409);
    });

    it('chyba RPC = enqueue-failed (5xx) bez fallbacku na přímý insert', async () => {
      const upsert = vi.fn();
      const db = rpcDb(null, upsert, { message: 'canceling statement due to lock timeout' });
      await expect(enqueueTradovateCopierCommand({ db, userId, connectionId, command: manage('manage:rpcdown-001'), now }))
        .rejects.toThrow('copier-relay-enqueue-failed: canceling statement due to lock timeout');
      expect(upsert).not.toHaveBeenCalled();
      expect(copierRelayValidationErrorStatus('copier-relay-enqueue-failed: canceling statement due to lock timeout')).toBeNull();
    });

    it('známé chyby před insertem (RAISE, lock/statement timeout, chybějící funkce) = not-admitted 409 „Neodesláno“', async () => {
      const cases: Array<[{ code: string; message: string }, string]> = [
        [{ code: 'P0001', message: 'copier-admission-clock-skew' }, 'copier-relay-entry-not-admitted: copier-admission-clock-skew'],
        [{ code: 'P0001', message: 'copier-admission-device-invalid' }, 'copier-relay-entry-not-admitted: copier-admission-device-invalid'],
        [{ code: '55P03', message: 'canceling statement due to lock timeout' }, 'copier-relay-entry-not-admitted: lock-timeout'],
        [{ code: '57014', message: 'canceling statement due to statement timeout' }, 'copier-relay-entry-not-admitted: statement-timeout'],
        [{ code: 'PGRST202', message: 'Could not find the function in the schema cache' }, 'copier-relay-entry-not-admitted: admission-unavailable'],
      ];
      for (const [error, expected] of cases) {
        const upsert = vi.fn();
        const failure = await enqueueTradovateCopierCommand({ db: rpcDb(null, upsert, error), userId, connectionId, command: manage('manage:notadmit-01'), now })
          .then(() => null, (reason: Error) => reason.message);
        expect(failure).toBe(expected);
        expect(copierRelayValidationErrorStatus(failure!)).toBe(409);
        expect(failure!.endsWith('not-found')).toBe(false);
        expect(upsert).not.toHaveBeenCalled();
      }
      // Jiný RAISE nebo síť = neznámý výsledek (502), ne „Neodesláno“.
      for (const error of [{ code: 'P0001', message: 'something else' }, { code: '', message: 'TypeError: fetch failed' }]) {
        const failure = await enqueueTradovateCopierCommand({ db: rpcDb(null, vi.fn(), error), userId, connectionId, command: manage('manage:notadmit-02'), now })
          .then(() => null, (reason: Error) => reason.message);
        expect(failure).toMatch(/^copier-relay-enqueue-failed: /);
        expect(copierRelayValidationErrorStatus(failure!)).toBeNull();
      }
    });

    it('neznámý nebo neúplný výsledek RPC = enqueue-failed, nikdy tichý úspěch', async () => {
      for (const row of [null, { result_code: 'weird' }, { result_code: 'inserted', id: 'x', status: 'pending', expires_at: 'y' }]) {
        await expect(enqueueTradovateCopierCommand({ db: rpcDb(row), userId, connectionId, command: manage('manage:badrow-0001'), now }))
          .rejects.toThrow('copier-relay-enqueue-failed: invalid-admission-response');
      }
    });

    it('chyba výběru zařízení má přednost; RPC se vůbec nezavolá', async () => {
      const failing = () => {
        const query: Record<string, unknown> = {};
        for (const method of ['eq', 'in', 'contains', 'gte', 'gt', 'or', 'order', 'limit', 'is']) query[method] = () => query;
        query.maybeSingle = async () => { throw new Error('lookup-down'); };
        query.then = (_resolve: unknown, reject: (reason: unknown) => void) => reject(new Error('lookup-down'));
        return query;
      };
      const noDevices = { eq: () => noDevices, is: () => noDevices,
        then: (resolve: (value: unknown) => void) => resolve({ data: [], error: null }) };
      const db = { from: (table: string) => {
        if (table === 'tradovate_copier_devices') return { select: () => noDevices };
        if (table === 'tradovate_copier_commands') return { select: () => failing(), upsert: vi.fn() };
        throw new Error(`unexpected-table:${table}`);
      } } as unknown as SupabaseClient;
      await expect(enqueueTradovateCopierCommand({ db, userId, connectionId, command: manage('manage:devicefail-01'), now }))
        .rejects.toThrow('copier-relay-device-not-found');
      // Odmítnutá předem spuštěná čtení se nesmí projevit ani po dokončení (vitest padá na unhandled rejection).
      await new Promise(resolve => setTimeout(resolve, 20));
    });

  });

  it('brzda jde jedním atomickým RPC (insert + supersede ARM/SHADOW i ručních příkazů); žádný upsert ani update zvlášť', async () => {
    const updates: unknown[] = [];
    const upsert = vi.fn();
    const rpc = vi.fn(async () => ({ data: [{ result_code: 'inserted', id: 'brake-id', status: 'pending',
      expires_at: '2026-08-21T12:10:00.000Z', device_id: deviceId, superseded_arms: 1, superseded_manual: 2 }], error: null }));
    const db = Object.assign(enqueueDb(upsert, null, null, undefined, value => { updates.push(value); }), { rpc });
    const queued = await enqueueTradovateCopierCommand({ db, userId, connectionId, command: { type: 'kill-switch' }, idempotencyKey: 'brake-key-000000001', now: Date.parse('2026-08-21T12:00:00.000Z') });
    expect(queued).toEqual({ id: 'brake-id', status: 'pending', expiresAt: '2026-08-21T12:10:00.000Z', deviceId });
    expect(rpc).toHaveBeenCalledWith('enqueue_tradovate_copier_brake', {
      p_user_id: userId, p_device_id: deviceId, p_connection_id: connectionId, p_command_type: 'kill-switch',
      p_payload: {}, p_idempotency_key: 'brake-key-000000001',
      p_now: '2026-08-21T12:00:00.000Z', p_expires_at: '2026-08-21T12:10:00.000Z',
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('chyba atomického brzdového RPC: brzda projde dřívější cestou se STEJNÝM klíčem (upsert + supersede per zařízení); connection-invalid a row-vanished se NEpropagují', async () => {
    for (const failure of [
      async () => ({ data: null, error: { message: 'canceling statement due to lock timeout' } }),
      async () => { throw new Error('fetch failed'); },
      async () => ({ data: [{ result_code: 'weird' }], error: null }),
      // Ownership check je pro brzdy advisory (INV-RELAY-03 bod 2): záloha ho
      // vědomě obchází, brzda nesmí skončit 409 kvůli chybě párování.
      async () => ({ data: null, error: { code: 'P0001', message: 'copier-brake-connection-invalid' } }),
      async () => ({ data: null, error: { code: 'P0001', message: 'copier-brake-row-vanished' } }),
    ]) {
      const updates: unknown[] = [];
      const upsert = vi.fn();
      const db = Object.assign(enqueueDb(upsert, null, null, undefined, value => { updates.push(value); }), { rpc: vi.fn(failure) });
      const queued = await enqueueTradovateCopierCommand({ db, userId, connectionId, command: { type: 'disarm' }, idempotencyKey: 'brake-key-000000002', now: Date.parse('2026-08-21T12:00:00.000Z') });
      expect(queued).toMatchObject({ id: 'command-id' });
      expect(upsert.mock.calls[0][0]).toMatchObject({ idempotency_key: 'brake-key-000000002', command_type: 'disarm' });
      expect(updates).toHaveLength(5);
    }
  });

  it('copier-brake-idempotency-conflict z RPC se propaguje (409); žádný fallback, žádný upsert', async () => {
    const upsert = vi.fn();
    const db = Object.assign(enqueueDb(upsert), {
      rpc: vi.fn(async () => ({ data: null, error: { code: 'P0001', message: 'copier-brake-idempotency-conflict' } })),
    });
    await expect(enqueueTradovateCopierCommand({ db, userId, connectionId, command: { type: 'disarm' }, idempotencyKey: 'brake-key-000000003', now: Date.parse('2026-08-21T12:00:00.000Z') }))
      .rejects.toThrow('copier-brake-idempotency-conflict');
    expect(upsert).not.toHaveBeenCalled();
    expect(copierRelayValidationErrorStatus('copier-brake-idempotency-conflict')).toBe(409);
  });

  it('fallback: recyklovaný klíč s jiným typem (arm-live i jiná brzda) = idempotency-conflict, nikdy úspěch starého řádku', async () => {
    // Bez RPC (chybí migrace) upsert narazí na konflikt klíče → existing lookup
    // najde starý řádek jiného typu. Dřív se vrátil jako úspěšná brzda.
    const fallbackConflictDb = (existingType: string) => {
      const db = enqueueDb(vi.fn()) as unknown as { from: (table: string) => Record<string, unknown> };
      const originalFrom = db.from.bind(db);
      db.from = (table: string) => {
        if (table !== 'tradovate_copier_commands') return originalFrom(table);
        const existingQuery: Record<string, unknown> = {};
        for (const method of ['eq', 'in', 'contains', 'gte', 'gt', 'or', 'order', 'limit']) existingQuery[method] = () => existingQuery;
        existingQuery.maybeSingle = async () => ({ data: null, error: null });
        existingQuery.single = async () => ({
          data: { id: 'old-id', status: 'completed', expires_at: '2026-08-21T11:59:00.000Z', command_type: existingType, payload: {} },
          error: null,
        });
        const conflictUpsert = { select: () => conflictUpsert, maybeSingle: async () => ({ data: null, error: null }) };
        const updateQuery: Record<string, unknown> = { error: null };
        for (const method of ['eq', 'in', 'lte', 'contains']) updateQuery[method] = () => updateQuery;
        return { select: () => existingQuery, upsert: () => conflictUpsert, update: () => updateQuery };
      };
      return Object.assign(db, { rpc: vi.fn(async () => { throw new Error('Could not find the function in the schema cache'); }) }) as unknown as SupabaseClient;
    };
    for (const existingType of ['arm-live', 'lock-until-session-end']) {
      await expect(enqueueTradovateCopierCommand({ db: fallbackConflictDb(existingType), userId, connectionId, command: { type: 'disarm' }, idempotencyKey: 'brake-key-000000004', now: Date.parse('2026-08-21T12:00:00.000Z') }))
        .rejects.toThrow('copier-relay-idempotency-conflict');
    }
    // Stejný typ zůstává idempotentní: vrátí se původní řádek brzdy.
    const repeated = await enqueueTradovateCopierCommand({ db: fallbackConflictDb('disarm'), userId, connectionId, command: { type: 'disarm' }, idempotencyKey: 'brake-key-000000004', now: Date.parse('2026-08-21T12:00:00.000Z') });
    expect(repeated).toMatchObject({ id: 'old-id', status: 'completed' });
    expect(copierRelayValidationErrorStatus('copier-relay-idempotency-conflict')).toBe(409);
  });

  it('enqueue brzdy expiruje starší pending ARM a SHADOW stejného zařízení (bez RPC = záloha per zařízení)', async () => {
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
    // ARM/SHADOW + čekající ruční vstupy (1b) + posuny SL/TP (2a) + zavření obchodu (2d); zrušení vstupu brzda neruší.
    expect(updates).toHaveLength(5);
    expect(updates.slice(2).map(update => update.calls.find(([method]) => method === 'contains')?.[1][1]))
      .toEqual([{ command: { type: 'manage-leader-order', action: 'move-stop' } }, { command: { type: 'manage-leader-order', action: 'move-target' } },
        { command: { type: 'manage-leader-order', action: 'close-position' } }]);
    expect(updates[0].value).toEqual(expect.objectContaining({
      status: 'expired', error: 'superseded-by-brake',
    }));
    expect(updates[1].value).toEqual(expect.objectContaining({ status: 'expired', error: 'superseded-by-brake' }));
    expect(updates[1].calls).toEqual(expect.arrayContaining([
      ['eq', ['command_type', 'copy-command']],
      ['contains', ['payload', { command: { type: 'place-leader-entry' } }]],
    ]));
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

  it('relay pustí smazání skupiny (11. 10. 2026) jen s groupId a ničím navíc', async () => {
    const accepted = vi.fn();
    await enqueueTradovateCopierCommand({
      db: enqueueDb(accepted), userId, connectionId,
      command: { type: 'copy-command', command: { type: 'delete-group', groupId: 'group-1' } },
      idempotencyKey: 'key-delete-group',
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    expect(accepted.mock.calls[0][0]).toMatchObject({
      command_type: 'copy-command', payload: { command: { type: 'delete-group', groupId: 'group-1' } },
    });
    for (const bad of [{ groupId: '' }, { groupId: 42 }, { groupId: 'group-1', force: true }]) {
      const upsert = vi.fn();
      await expect(enqueueTradovateCopierCommand({
        db: enqueueDb(upsert), userId, connectionId,
        command: { type: 'copy-command', command: { type: 'delete-group', ...bad } } as unknown as LocalCopierAgentCommand,
      })).rejects.toThrow('invalid-relay-command-payload');
      expect(upsert).not.toHaveBeenCalled();
    }
    const claimed = await claimTradovateCopierCommand({
      db: claimDb({
        id: 'delete-command-id', command_type: 'copy-command',
        payload: { command: { type: 'delete-group', groupId: 'group-1' } },
        expires_at: '2026-08-21T12:00:30.000Z', status: 'claimed', result: null, error: null,
      }),
      deviceId,
    });
    expect(claimed?.command).toEqual({ type: 'copy-command', command: { type: 'delete-group', groupId: 'group-1' } });
  });

  it('relay pustí označení visící operace (17. 10. 2026) jen s přesným tvarem', async () => {
    const resolve = {
      type: 'resolve-stuck-operation', groupId: 'group-1', kind: 'place',
      key: 'cp:group-1:order:1:submitted', reason: 'Ručně potvrzeno v LIVE UI',
    };
    const accepted = vi.fn();
    await enqueueTradovateCopierCommand({
      db: enqueueDb(accepted), userId, connectionId,
      command: { type: 'copy-command', command: resolve } as unknown as LocalCopierAgentCommand,
      idempotencyKey: 'key-resolve-stuck',
      now: Date.parse('2026-08-21T12:00:00.000Z'),
    });
    expect(accepted.mock.calls[0][0]).toMatchObject({ command_type: 'copy-command', payload: { command: resolve } });
    for (const bad of [
      { kind: 'market' }, { kind: 1 }, { key: '' }, { key: 7 }, { reason: 'ok' }, { reason: 42 },
      { groupId: 3 }, { groupId: '' }, { force: true }, { key: 'x'.repeat(401) }, { reason: '    x   ' },
      { reason: 'Ručně\u0000 potvrzeno' },
    ]) {
      const upsert = vi.fn();
      await expect(enqueueTradovateCopierCommand({
        db: enqueueDb(upsert), userId, connectionId,
        command: { type: 'copy-command', command: { ...resolve, ...bad } } as unknown as LocalCopierAgentCommand,
      })).rejects.toThrow('invalid-relay-command-payload');
      expect(upsert).not.toHaveBeenCalled();
    }
    const claimed = await claimTradovateCopierCommand({
      db: claimDb({
        id: 'resolve-command-id', command_type: 'copy-command', payload: { command: resolve },
        expires_at: '2026-08-21T12:00:30.000Z', status: 'claimed', result: null, error: null,
      }),
      deviceId,
    });
    expect(claimed?.command).toEqual({ type: 'copy-command', command: resolve });
    // Ručně vložený řádek s vadným tvarem neprojde ani na claim straně.
    await expect(claimTradovateCopierCommand({
      db: claimDb({
        id: 'resolve-bad-id', command_type: 'copy-command', payload: { command: { ...resolve, kind: 'market' } },
        expires_at: '2026-08-21T12:00:30.000Z', status: 'claimed', result: null, error: null,
      }),
      deviceId,
    })).rejects.toThrow('invalid-relay-command-payload');
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

  it('relay pustí „Zapnout bez tohoto účtu“ jen jako allowOwnExposure:true při vypnutí', async () => {
    for (const bad of [
      { enabled: false, allowOwnExposure: 'yes' },
      { enabled: true, allowOwnExposure: true },
      { enabled: false, allowOwnExposure: false },
    ]) {
      const upsert = vi.fn();
      await expect(enqueueTradovateCopierCommand({
        db: enqueueDb(upsert), userId, connectionId,
        command: { type: 'copy-command', command: {
          type: 'set-follower-enabled', groupId: 'group-1', accountId: 42, ...bad,
        } } as unknown as LocalCopierAgentCommand,
      })).rejects.toThrow('invalid-relay-command-payload');
      expect(upsert).not.toHaveBeenCalled();
    }
    const claimed = await claimTradovateCopierCommand({
      db: claimDb({
        id: 'exclude-command-id', command_type: 'copy-command',
        payload: { command: {
          type: 'set-follower-enabled', groupId: 'group-1', accountId: 42, enabled: false, allowOwnExposure: true,
        } },
        expires_at: '2026-08-21T12:00:30.000Z', status: 'claimed', result: null, error: null,
      }),
      deviceId,
    });
    expect(claimed?.command).toEqual({ type: 'copy-command', command: {
      type: 'set-follower-enabled', groupId: 'group-1', accountId: 42, enabled: false, allowOwnExposure: true,
    } });
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

  it('arm-live přenese potvrzení incidentu; vadné odmítne; Kontrola pozic relay neprojde', async () => {
    const group = {
      id: 'group-1', name: 'Hlavní', enabled: true, leaderAccountId: 11,
      followers: [{ accountId: 22, mode: 'on-submit' as const, multiplier: 1 }],
    };
    const upsert = vi.fn();
    await enqueueTradovateCopierCommand({
      db: enqueueDb(upsert), userId, connectionId,
      command: { type: 'arm-live', group, acknowledgeIncidentId: 'b2c1-incident' },
    });
    expect(upsert.mock.calls[0][0].payload).toMatchObject({ acknowledgeIncidentId: 'b2c1-incident' });
    const claimed = await claimTradovateCopierCommand({
      db: claimDb({
        id: 'command-id', command_type: 'arm-live', payload: { group, acknowledgeIncidentId: 'b2c1-incident' },
        expires_at: '2026-08-21T12:00:30.000Z', status: 'claimed', result: null, error: null,
      }),
      deviceId,
    });
    expect(claimed?.command).toMatchObject({ type: 'arm-live', acknowledgeIncidentId: 'b2c1-incident' });
    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(vi.fn()), userId, connectionId,
      command: { type: 'arm-live', group, acknowledgeIncidentId: 'ne platné!' },
    } as never)).rejects.toThrow('invalid-relay-command-payload');
    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(vi.fn()), userId, connectionId, command: { type: 'reconcile' },
    })).rejects.toThrow('unsupported-relay-command');
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

describe('fáze 1b: relay ručního vstupu', () => {
  const NOW = Date.parse('2026-10-29T15:00:00.000Z');
  const entry = (price = 29_500) => ({
    type: 'copy-command' as const,
    command: buildLeaderEntryPlaceCommand({
      type: 'preview-leader-entry', groupId: 'group-1', operationId: 'preview:relaytest0001', leaderAccountId: 100,
      symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price, stopLoss: 29_480, takeProfit: 29_560,
      intent: { armedAt: 1, groupConfigHash: 'abcdefgh12345678', followerQuantities: [] },
    }, 'entry:relaytest0001'),
  });

  const rpcDb = (row: Record<string, unknown>, calls: unknown[][] = []) => Object.assign(
    enqueueDb(vi.fn(), null, () => null),
    { rpc: async (...call: unknown[]) => { calls.push(call); return { data: [row], error: null }; } },
  );

  it('nový vstup: RPC dostane operationId, celý payload a platnost 15 s', async () => {
    const calls: unknown[][] = [];
    const command = entry();
    await enqueueTradovateCopierCommand({
      db: rpcDb({ result_code: 'inserted', id: 'new', status: 'pending', expires_at: '2026-10-29T15:00:15.000Z', device_id: deviceId }, calls),
      userId, connectionId, command: command as unknown as LocalCopierAgentCommand, now: NOW,
    });
    expect(calls[0][1]).toMatchObject({
      p_operation_id: 'entry:relaytest0001', p_expires_at: '2026-10-29T15:00:15.000Z',
      p_payload: { command: { type: 'place-leader-entry', operationId: 'entry:relaytest0001', payloadHash: command.command.payloadHash } },
    });
  });

  it('stejné operationId: existing vrátí původní řádek, entry-conflict = 409', async () => {
    const same = await enqueueTradovateCopierCommand({
      db: rpcDb({ result_code: 'existing', id: 'old', status: 'succeeded', expires_at: '2026-10-29T15:00:15.000Z', device_id: deviceId }),
      userId, connectionId, command: entry() as unknown as LocalCopierAgentCommand, now: NOW,
    });
    expect(same).toMatchObject({ id: 'old', status: 'succeeded' });
    await expect(enqueueTradovateCopierCommand({
      db: rpcDb({ result_code: 'entry-conflict' }), userId, connectionId,
      command: entry(29_499) as unknown as LocalCopierAgentCommand, now: NOW,
    })).rejects.toThrow('copier-relay-entry-conflict');
  });

  it('ruční vstup projde validací jen s platným otiskem', async () => {
    const tampered = { ...entry(), command: { ...entry().command, price: 29_400 } };
    await expect(enqueueTradovateCopierCommand({
      db: enqueueDb(vi.fn(), null, () => null), userId, connectionId,
      command: tampered as unknown as LocalCopierAgentCommand, now: NOW,
    })).rejects.toThrow('invalid-relay-command-payload');
  });
});
