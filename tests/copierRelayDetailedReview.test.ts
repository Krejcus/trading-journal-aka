import { describe, expect, it, vi } from 'vitest';
import { startMacCopierCommandRelay } from '../server/macCopierCommandRelay';
import type { LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';
import { executeTradovateCopierRelayCommand } from '../services/tradovateOAuthConnection';

vi.mock('../services/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'mock-token' } } }) } },
}));

const agentWith = (execute = vi.fn()) => ({
  status: () => ({ version: 1, nonce: '', controller: { armed: false } }),
  execute,
}) as unknown as LocalCopierExecutionAgent;

describe('copier relay boundary review', () => {
  it('reports an unconfirmed claimed command as unknown, without re-enqueueing it', async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    vi.stubGlobal('window', { setTimeout });
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(init?.method ?? 'GET');
      return Response.json(init?.method === 'POST'
        ? { id: 'claimed-unconfirmed', expiresAt: new Date(Date.now() + 1_000).toISOString() }
        : { status: 'claimed' });
    }));
    try {
      const result = executeTradovateCopierRelayCommand('mock-connection', { type: 'disarm' }).catch(error => error);
      await vi.advanceTimersByTimeAsync(6_500);
      expect((await result).message).toContain('Výsledek není ověřený');
      expect(requests.filter(method => method === 'POST')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it.each(['not-a-date', 'Infinity', 123, {}, null, undefined])(
    'rejects a command whose expiry cannot be verified: %j', async expiresAt => {
      const execute = vi.fn();
      const completions: Record<string, unknown>[] = [];
      let delivered = false;
      const relay = startMacCopierCommandRelay({
        apiOrigin: 'https://relay.invalid', authorizationHeader: async () => 'Device test.mock',
        agent: agentWith(execute), pollMs: 60_000,
        fetchImpl: (async (_url, init) => {
          const request = JSON.parse(String(init?.body));
          if (request.action === 'complete') completions.push(request);
          if (request.action === 'poll' && !delivered) {
            delivered = true;
            return Response.json({ command: { id: 'invalid-expiry', command: { type: 'arm-live' }, expiresAt } });
          }
          return Response.json({ command: null, accepted: true });
        }) as typeof fetch,
      });
      try {
        await vi.waitFor(() => expect(completions).toHaveLength(1));
        expect(execute).not.toHaveBeenCalled();
        expect(completions[0]).toMatchObject({ error: 'command-expired-before-execution' });
      } finally { await relay.close(); }
    },
  );

  it('preserves a second copy event arriving during an in-flight event heartbeat', async () => {
    const polls: boolean[] = [];
    let release!: () => void;
    const heldResponse = new Promise<void>(resolve => { release = resolve; });
    const relay = startMacCopierCommandRelay({
      apiOrigin: 'https://relay.invalid', authorizationHeader: async () => 'Device test.mock',
      agent: agentWith(), pollMs: 60_000,
      fetchImpl: (async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        if (request.action === 'poll') {
          polls.push(request.copyEvents === true);
          if (polls.length === 2) await heldResponse;
        }
        return Response.json({ command: null });
      }) as typeof fetch,
    });
    try {
      await vi.waitFor(() => expect(polls).toHaveLength(1));
      relay.nudgeCopyEvents();
      await vi.waitFor(() => expect(polls).toHaveLength(2));
      relay.nudgeCopyEvents();
      release();
      await vi.waitFor(() => expect(polls).toHaveLength(3));
      expect(polls).toEqual([false, true, true]);
    } finally { release(); await relay.close(); }
  });
});
