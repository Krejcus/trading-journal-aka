import { describe, expect, it, vi } from 'vitest';
import { startMacCopierCommandRelay } from '../server/macCopierCommandRelay';
import type { LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';
import { executeTradovateCopierRelayCommand } from '../services/tradovateOAuthConnection';
import { CopierBrakeQueuedError } from '../lib/copierBrakeDelivery';

vi.mock('../services/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'mock-token' } } }) } },
}));

const agentWith = (execute = vi.fn()) => ({
  status: () => ({ version: 1, nonce: '', controller: { armed: false } }),
  execute,
}) as unknown as LocalCopierExecutionAgent;

describe('copier relay boundary review', () => {
  it('ukončí polling i když abort přijde těsně mezi GET odpovědí a čekáním', async () => {
    const controller = new AbortController();
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Response.json({ id: 'abort-race', expiresAt: new Date(Date.now() + 5_000).toISOString() });
      }
      controller.abort(new Error('test-abort'));
      return Response.json({ status: 'claimed' });
    }));
    try {
      await expect(executeTradovateCopierRelayCommand(
        'mock-connection',
        { type: 'disarm' },
        { signal: controller.signal },
      )).rejects.toThrow('test-abort');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { type: 'disarm' } as const,
    { type: 'kill-switch' } as const,
    { type: 'lock-until-session-end', reason: 'Ruční zámek dne' } as const,
  ])('after 35 s keeps queued brake $type visible until its 10 minute TTL', async command => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    vi.stubGlobal('window', { setTimeout });
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(init?.method ?? 'GET');
      return Response.json(init?.method === 'POST'
        ? { id: 'claimed-unconfirmed', expiresAt }
        : { status: 'claimed' });
    }));
    try {
      const result = executeTradovateCopierRelayCommand('mock-connection', command).catch(error => error);
      await vi.advanceTimersByTimeAsync(35_500);
      const error = await result;
      expect(error).toBeInstanceOf(CopierBrakeQueuedError);
      expect(error).toMatchObject({ commandType: command.type, expiresAt });
      expect(error.message).toContain('Brzda čeká ve frontě workeru');
      expect(error.message).toContain('AlphaTrade dál sleduje stav');
      expect(error.message).not.toContain('nebude automaticky opakován');
      expect(requests.filter(method => method === 'POST')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('keeps a timed-out ARM outcome unknown instead of claiming a rejection', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout });
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => Response.json(
      init?.method === 'POST'
        ? { id: 'arm-unconfirmed', expiresAt: new Date(Date.now() + 1_000).toISOString() }
        : { status: 'claimed' },
    )));
    try {
      const result = executeTradovateCopierRelayCommand('mock-connection', { type: 'arm-live' }).catch(error => error);
      await vi.advanceTimersByTimeAsync(6_500);
      expect((await result).message).toContain('Výsledek není ověřený');
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
