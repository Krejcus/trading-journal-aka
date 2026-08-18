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
    await vi.waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ action: 'complete', commandId: 'command-1' })), { timeout: 2_000 });
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
