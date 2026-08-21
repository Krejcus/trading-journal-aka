import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { LocalCopierAgentCommand } from '../lib/localCopierAgentProtocol';
import {
  claimTradovateCopierCommand,
  enqueueTradovateCopierCommand,
} from '../server/tradovateCopierCommandRelay';

const userId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
type CopyCommand = Extract<LocalCopierAgentCommand, { type: 'copy-command' }>;

function enqueueDb(upsert: (row: unknown, options: unknown) => void): SupabaseClient {
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
      throw new Error(`unexpected-table:${table}`);
    },
  } as unknown as SupabaseClient;
}

function claimDb(row: Record<string, unknown>): SupabaseClient {
  return {
    rpc: async () => ({ data: [row], error: null }),
  } as unknown as SupabaseClient;
}

describe('Tradovate copier command relay', () => {
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
