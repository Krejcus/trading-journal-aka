import { DEFAULT_COPY_GROUP_SAFETY } from '../services/liveCopyTrading';
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
): SupabaseClient {
  const deviceQuery = {
    eq: () => deviceQuery,
    is: () => deviceQuery,
    order: () => deviceQuery,
    limit: () => deviceQuery,
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
    maybeSingle: async () => ({
      data: runtimeStatus ? { status: runtimeStatus } : null,
      error: null,
    }),
  };

  return {
    from: (table: string) => {
      if (table === 'tradovate_copier_devices') {
        return { select: () => deviceQuery };
      }
      if (table === 'tradovate_copier_commands') {
        return { upsert: (row: unknown, options: unknown) => {
          upsert(row, options);
          return upsertQuery;
        } };
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
  controller: { sessionArmedAt } as LocalCopierAgentStatus['controller'],
  startedAt: '2026-09-05T08:00:00.000Z',
});

describe('Tradovate copier command relay', () => {
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
      command: { type: 'flatten-group', groupId: 'group-1', operationId: 'flatten-all-1' },
    },
    {
      type: 'copy-command',
      command: {
        type: 'flatten-account', groupId: 'group-1', accountId: 42, operationId: 'flatten-one-1',
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
