import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type {
  CopierSnapshotHealthState,
  LocalCopierAgentStatus,
} from '../lib/localCopierAgentProtocol';
import {
  enqueueNativeSnapshotTest,
  selectReadySnapshotTestRuntime,
} from '../server/nativeSnapshotTest';

const status = (state: CopierSnapshotHealthState): LocalCopierAgentStatus => ({
  version: 1,
  environment: 'demo',
  nonce: '',
  startedAt: '2026-08-29T05:00:00.000Z',
  group: {
    id: 'g', name: 'test', enabled: true, leaderAccountId: 1,
    followers: [{ accountId: 2, mode: 'on-submit', multiplier: 1 }], localOnly: true,
  },
  controller: {
    started: true, armed: false, killSwitch: false, shadowMode: false,
    connected: true, reconciliationRequired: false, divergentAccounts: [],
    workingOrderAccounts: [], stuckOutbox: false, stuckOperations: [],
    lastError: null, revision: 1, lastSequence: 0,
  },
  snapshotHealth: {
    enabled: true,
    state,
    layoutName: 'AlphaTrade Snapshoty',
    chartIdConfigured: true,
    cdpReachable: state === 'ready',
    targetFound: state === 'ready',
    lastCheckedAt: 1,
    lastAttemptAt: null,
    lastSuccessAt: null,
  },
});

describe('native snapshot test runtime selection', () => {
  const now = Date.parse('2026-08-29T05:00:05.000Z');

  it('vybere pouze čerstvý DEMO worker s připravenou snapshot kamerou', () => {
    const selected = selectReadySnapshotTestRuntime([
      {
        device_id: 'offline', connection_id: 'c1', status: status('cdp-offline'),
        last_seen_at: new Date(now - 100).toISOString(),
      },
      {
        device_id: 'ready', connection_id: 'c2', status: status('ready'),
        last_seen_at: new Date(now - 200).toISOString(),
      },
    ], now);
    expect(selected?.device_id).toBe('ready');
  });

  it('odmítne stale worker i zdánlivě ready kameru', () => {
    expect(selectReadySnapshotTestRuntime([{
      device_id: 'stale', connection_id: 'c1', status: status('ready'),
      last_seen_at: new Date(now - 10_000).toISOString(),
    }], now)).toBeNull();
  });

  it('připne command na konkrétní ready worker a uloží jen neobchodní typ', async () => {
    const upsert = vi.fn();
    const runtimeRows = [{
      device_id: '33333333-3333-4333-8333-333333333333',
      connection_id: '22222222-2222-4222-8222-222222222222',
      status: status('ready'),
      last_seen_at: new Date(now - 100).toISOString(),
    }];
    const runtimeChain: Record<string, unknown> = {};
    runtimeChain.eq = vi.fn(() => runtimeChain);
    runtimeChain.gte = vi.fn(() => runtimeChain);
    runtimeChain.order = vi.fn(() => runtimeChain);
    runtimeChain.limit = vi.fn(async () => ({ data: runtimeRows, error: null }));

    const recentChain: Record<string, unknown> = {};
    recentChain.eq = vi.fn(() => recentChain);
    recentChain.gte = vi.fn(() => recentChain);
    recentChain.limit = vi.fn(() => recentChain);
    recentChain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));

    const deviceChain: Record<string, unknown> = {};
    deviceChain.eq = vi.fn(() => deviceChain);
    deviceChain.is = vi.fn(() => deviceChain);
    deviceChain.order = vi.fn(() => deviceChain);
    deviceChain.limit = vi.fn(() => deviceChain);
    deviceChain.maybeSingle = vi.fn(async () => ({
      data: { id: '33333333-3333-4333-8333-333333333333' }, error: null,
    }));
    const upsertChain = {
      select: () => ({
        maybeSingle: async () => ({
          data: { id: 'command-1', status: 'pending', expires_at: new Date(now + 30_000).toISOString() },
          error: null,
        }),
      }),
    };
    let commandSelects = 0;
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'tradovate_copier_device_runtime') return { select: () => runtimeChain };
        if (table === 'tradovate_copier_devices') return { select: () => deviceChain };
        if (table === 'tradovate_copier_commands') return {
          select: () => {
            commandSelects += 1;
            return recentChain;
          },
          upsert: (row: unknown, options: unknown) => {
            upsert(row, options);
            return upsertChain;
          },
        };
        throw new Error(`unexpected-table:${table}`);
      }),
    } as unknown as SupabaseClient;

    await expect(enqueueNativeSnapshotTest({
      db,
      userId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: 'snapshot-test-request-1',
      now,
    })).resolves.toMatchObject({ id: 'command-1', deviceId: '33333333-3333-4333-8333-333333333333' });
    expect(commandSelects).toBe(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      device_id: '33333333-3333-4333-8333-333333333333',
      command_type: 'snapshot-test',
      payload: {},
    }), expect.anything());
  });
});
