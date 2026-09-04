import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WebSocketLike } from '../services/tradovateBroker';
import { startMultiTradovateCopier, startTradovateCopier } from '../services/tradovateCopierService';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const group: CopyGroupConfig = {
  id: 'g1', name: 'Group', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
};

let fakeRevision = 0;
const emptySupabase = {
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: null, error: null }),
      }),
    }),
  }),
  // Každý CAS commit musí vrátit novou revizi; runtime od day-lock pravidel
  // commituje při startu víc než jednou.
  rpc: async () => ({ data: ++fakeRevision, error: null }),
} as unknown as SupabaseClient;

describe('startTradovateCopier', () => {
  it('sestaví DISARMED runtime a token získá až při broker autorizaci', async () => {
    const sent: string[] = [];
    let tokenCalls = 0;
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send: value => sent.push(value), close() {},
    };
    const controller = await startTradovateCopier({
      supabase: emptySupabase,
      runtimeId: '11111111-1111-4111-8111-111111111111',
      fence: () => 1,
      environment: 'demo',
      accountSpec: 'DEMO123',
      group,
      getAccessToken: async () => {
        tokenCalls += 1;
        return 'ephemeral-token';
      },
      transport: {
        webSocketFactory: () => socket,
        setIntervalImpl: (() => 1) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
        setTimeoutImpl: (() => 1) as unknown as typeof setTimeout,
        clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
      },
    });

    expect(tokenCalls).toBe(0);
    expect(controller.status()).toMatchObject({ armed: false, connected: false });
    socket.onopen?.();
    socket.onmessage?.({ data: 'o' });
    await expect.poll(() => tokenCalls).toBe(1);
    expect(sent).toEqual(['authorize\n0\n\nephemeral-token']);
    controller.stop();
  });

  it('odmítne chybějící runtime nebo account identitu před vytvořením spojení', async () => {
    await expect(startTradovateCopier({
      supabase: emptySupabase, runtimeId: '', fence: () => 1,
      environment: 'demo', accountSpec: 'DEMO123', group,
      getAccessToken: async () => 'token',
    })).rejects.toThrow('runtimeId');
    await expect(startTradovateCopier({
      supabase: emptySupabase, runtimeId: '11111111-1111-4111-8111-111111111111',
      fence: () => 1, environment: 'demo', accountSpec: '', group,
      getAccessToken: async () => 'token',
    })).rejects.toThrow('accountSpec');
  });

  it('validates complete and unique account routing across OAuth connections', async () => {
    const base = {
      supabase: emptySupabase,
      runtimeId: '11111111-1111-4111-8111-111111111111',
      fence: () => 1,
      environment: 'demo' as const,
      group,
    };
    await expect(startMultiTradovateCopier({
      ...base,
      connections: [{ id: 'leader', accountIds: [100], getAccessToken: async () => 'a' }],
    })).rejects.toThrow('200 has no OAuth');
    await expect(startMultiTradovateCopier({
      ...base,
      connections: [
        { id: 'leader', accountIds: [100, 200], getAccessToken: async () => 'a' },
        { id: 'duplicate', accountIds: [200], getAccessToken: async () => 'b' },
      ],
    })).rejects.toThrow('multiple OAuth');
  });

  it('opens one authoritative sync stream per OAuth connection', async () => {
    const sockets: WebSocketLike[] = [];
    const connection = (id: string, accountIds: number[], token: string) => ({
      id,
      accountIds,
      getAccessToken: async () => token,
      transport: {
        webSocketFactory: () => {
          const socket: WebSocketLike = {
            readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
            send() {}, close() {},
          };
          sockets.push(socket);
          return socket;
        },
        setIntervalImpl: (() => 1) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
        setTimeoutImpl: (() => 1) as unknown as typeof setTimeout,
        clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
      },
    });
    const runtime = await startMultiTradovateCopier({
      supabase: emptySupabase,
      runtimeId: '11111111-1111-4111-8111-111111111111',
      fence: () => 1,
      environment: 'demo',
      group,
      connections: [connection('leader', [100], 'a'), connection('follower', [200], 'b')],
    });
    expect(sockets).toHaveLength(2);
    expect(runtime.status().connected).toBe(false);
    runtime.stop();
  });
});
