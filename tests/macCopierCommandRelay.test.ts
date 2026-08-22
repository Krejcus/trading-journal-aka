import { describe, expect, it, vi } from 'vitest';
import { startMacCopierCommandRelay } from '../server/macCopierCommandRelay';
import type { LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';

const status = (): LocalCopierAgentStatus => ({
  version: 1, environment: 'demo', nonce: 'local-only', startedAt: '2026-08-17T08:00:00.000Z',
  group: { id: 'g', name: 'test', enabled: true, leaderAccountId: 1, followers: [{ accountId: 2, mode: 'on-submit', multiplier: 1 }], localOnly: true },
  controller: { started: true, armed: false, killSwitch: false, shadowMode: true, connected: true, reconciliationRequired: false, divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false, stuckOperations: [], lastError: null, revision: 1, lastSequence: 0 },
});

describe('Mac copier command relay', () => {
  it('snapshot upload retryne nejvýše dvakrát a pak skončí', async () => {
    const snapshotRequests: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? '{}'));
      if (request.action === 'poll') return Response.json({ command: null });
      if (request.action === 'snapshot') {
        snapshotRequests.push(request);
        if (snapshotRequests.length === 1) return Response.json({ accepted: false }, { status: 202 });
        if (snapshotRequests.length === 2) return Response.json({ error: 'temporary' }, { status: 503 });
        return Response.json({ accepted: true }, { status: 202 });
      }
      return Response.json({ accepted: true });
    });
    const agent = { status, execute: vi.fn(), origin: '', close: vi.fn() } as unknown as LocalCopierExecutionAgent;
    const relay = startMacCopierCommandRelay({
      apiOrigin: 'https://alpha.example', authorizationHeader: async () => 'Device id.secret',
      agent, fetchImpl: fetchImpl as typeof fetch, pollMs: 60_000,
    });

    await expect(relay.uploadSnapshot({
      episodeId: '11111111-1111-4111-8111-111111111111', kind: 'entry', at: 1,
      symbol: 'MNQU6', png: 'iVBORw0KGgo=',
    })).resolves.toBeUndefined();
    expect(snapshotRequests).toHaveLength(3);
    await relay.close();
  });

  it('polls, executes one claimed command, and acknowledges the authoritative result', async () => {
    const calls: unknown[] = [];
    let delivered = false;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? '{}'));
      calls.push(request);
      if (request.action === 'poll' && !delivered) {
        delivered = true;
        return Response.json({ command: { id: 'command-1', command: { type: 'shadow' }, expiresAt: new Date(Date.now() + 10_000).toISOString() } });
      }
      return Response.json(request.action === 'poll' ? { command: null } : { accepted: true });
    });
    const execute = vi.fn(async () => ({ ok: true as const, status: status() }));
    const agent = { status, execute, origin: 'http://127.0.0.1:3211', close: vi.fn() } as unknown as LocalCopierExecutionAgent;
    const relay = startMacCopierCommandRelay({ apiOrigin: 'https://alpha.example', authorizationHeader: async () => 'Device id.secret', agent, fetchImpl: fetchImpl as typeof fetch, pollMs: 500 });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith({ type: 'shadow' }), { timeout: 2_000 });
    await vi.waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      action: 'complete', commandId: 'command-1', status: expect.objectContaining({
        controller: expect.objectContaining({ armed: false }),
      }),
    })), { timeout: 2_000 });
    await relay.close();
  });

  it('never executes an already expired claimed command', async () => {
    let delivered = false;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? '{}'));
      if (request.action === 'poll' && !delivered) {
        delivered = true;
        return Response.json({ command: { id: 'expired', command: { type: 'arm-live' }, expiresAt: new Date(Date.now() - 1).toISOString() } });
      }
      return Response.json(request.action === 'poll' ? { command: null } : { accepted: true });
    });
    const execute = vi.fn();
    const agent = { status, execute, origin: '', close: vi.fn() } as unknown as LocalCopierExecutionAgent;
    const relay = startMacCopierCommandRelay({ apiOrigin: 'https://alpha.example', authorizationHeader: async () => 'Device id.secret', agent, fetchImpl: fetchImpl as typeof fetch, pollMs: 500 });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(execute).not.toHaveBeenCalled();
    await relay.close();
  });
});

describe('realtime kick', () => {
  it('kick probudí poll okamžitě a config z poll odpovědi založí odběr jen jednou', async () => {
    const polls: number[] = [];
    let kick: (() => void) | null = null;
    let subscriptions = 0;
    let unsubscribed = 0;
    const started = Date.now();
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { action: string };
      if (body.action === 'poll') polls.push(Date.now() - started);
      return {
        ok: true,
        json: async () => ({
          command: null,
          realtime: { url: 'https://example.supabase.co', anonKey: 'anon', topic: 'copier-kick-d1' },
        }),
      };
    }) as unknown as typeof fetch;
    const relay = startMacCopierCommandRelay({
      apiOrigin: 'https://example.test',
      authorizationHeader: async () => 'Device x',
      agent: { status: () => ({}) as never, execute: async () => ({}) as never, origin: '', close: async () => undefined },
      fetchImpl,
      pollMs: 60_000,
      createKickSubscription: (_config, onKick) => {
        subscriptions += 1;
        kick = onKick;
        return () => { unsubscribed += 1; };
      },
    });

    await new Promise(resolve => setTimeout(resolve, 30));
    expect(polls).toHaveLength(1);
    expect(subscriptions).toBe(1);

    // Kick místo čekání 60 s.
    kick?.();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(polls).toHaveLength(2);
    // Stejný topic z další poll odpovědi odběr neduplikuje.
    expect(subscriptions).toBe(1);

    await relay.close();
    expect(unsubscribed).toBe(1);
  });
});

describe('kick race', () => {
  it('kick doručený během poll requestu se neztratí — další poll jde hned', async () => {
    const polls: number[] = [];
    let kick: (() => void) | null = null;
    const started = Date.now();
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { action: string };
      if (body.action === 'poll') {
        polls.push(Date.now() - started);
        // Kick přijde BĚHEM zpracování pollu (před začátkem spánku) —
        // přesně race, který dřív budíček zahodil.
        if (polls.length === 2) kick?.();
      }
      return {
        ok: true,
        json: async () => ({
          command: null,
          realtime: { url: 'https://example.supabase.co', anonKey: 'anon', topic: 'copier-kick-d1' },
        }),
      };
    }) as unknown as typeof fetch;
    const relay = startMacCopierCommandRelay({
      apiOrigin: 'https://example.test',
      authorizationHeader: async () => 'Device x',
      agent: { status: () => ({}) as never, execute: async () => ({}) as never, origin: '', close: async () => undefined },
      fetchImpl,
      pollMs: 60_000,
      createKickSubscription: (_config, onKick) => {
        kick = onKick;
        return () => undefined;
      },
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    // Subscription vznikla po 1. pollu; normální kick probudí 2. poll…
    kick!();
    await new Promise(resolve => setTimeout(resolve, 60));
    // …a kick vypálený BĚHEM 2. pollu nesmí zapadnout: 3. poll jde hned.
    expect(polls.length).toBeGreaterThanOrEqual(3);
    expect(polls[2]! - polls[1]!).toBeLessThan(1_000);
    await relay.close();
  });
});

describe('okamžité trade eventy', () => {
  it('nudgeCopyEvents probudí poll s příznakem copyEvents a příznak se po odeslání smaže', async () => {
    const polls: Array<{ at: number; copyEvents: boolean }> = [];
    const started = Date.now();
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { action: string; copyEvents?: boolean };
      if (body.action === 'poll') polls.push({ at: Date.now() - started, copyEvents: body.copyEvents === true });
      return { ok: true, json: async () => ({ command: null }) };
    }) as unknown as typeof fetch;
    const relay = startMacCopierCommandRelay({
      apiOrigin: 'https://example.test',
      authorizationHeader: async () => 'Device x',
      agent: { status: () => ({}) as never, execute: async () => ({}) as never, origin: '', close: async () => undefined },
      fetchImpl,
      pollMs: 60_000,
    });

    await new Promise(resolve => setTimeout(resolve, 30));
    expect(polls).toHaveLength(1);
    expect(polls[0].copyEvents).toBe(false);

    relay.nudgeCopyEvents();
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(polls).toHaveLength(2);
    expect(polls[1].copyEvents).toBe(true);
    expect(polls[1].at).toBeLessThan(1_000);
    await relay.close();
  });
});
