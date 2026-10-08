import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverableCopierDelivery } from '../server/recoverableCopierDelivery';
import { fileRelayDeliveryStore, type RelayDelivery, type RelayDeliveryStore } from '../server/copierRelayDeliveryStore';
import type { LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';
import type { LocalCopierAgentCommand } from '../lib/localCopierAgentProtocol';

function fixture() {
  let saved: RelayDelivery | null = null;
  let now = 1_000;
  const store: RelayDeliveryStore = { read: vi.fn(async () => saved && structuredClone(saved)),
    write: vi.fn(async value => { saved = value && structuredClone(value); }) };
  const remote: { id: string; command: LocalCopierAgentCommand; status: string; createdAt: string; expiresAt: string } = {
    id: randomUUID(), command: { type: 'disarm' }, status: 'claimed',
    createdAt: new Date(now + 1).toISOString(), expiresAt: new Date(now + 30_000).toISOString() };
  const agent = { execute: vi.fn(async () => ({ ok: true })), status: vi.fn(() => ({ startedAt: new Date(0).toISOString() })) } as unknown as LocalCopierExecutionAgent;
  const request = vi.fn(async (body: Record<string, unknown>): Promise<Record<string, unknown>> => body.action === 'poll-v2'
    ? { protocol: 2, command: remote } : { protocol: 2, accepted: true });
  const options = { store, agent, request, nextRevision: () => 1, onComplete: vi.fn(), now: () => now };
  return { options, remote, get saved() { return saved; }, set saved(v) { saved = v; }, setNow: (v: number) => { now = v; } };
}
describe('recoverable copier delivery', () => {
  it('persists delivery before claiming and execution intent before executing', async () => {
    const f = fixture(); const step = recoverableCopierDelivery(f.options);
    f.options.request.mockImplementation(async body => {
      expect(f.saved?.deliveryId).toBe(body.deliveryId);
      expect(f.saved?.phase).toBe(body.action === 'poll-v2' ? 'polling' : 'completed');
      return body.action === 'poll-v2' ? { protocol: 2, command: f.remote } : { protocol: 2, accepted: true };
    });
    vi.mocked(f.options.agent.execute).mockImplementation(async () => { expect(f.saved?.phase).toBe('executing'); return { ok: true } as never; });
    await step(); expect(f.options.agent.execute).toHaveBeenCalledTimes(1); expect(f.saved).toBeNull();
  });
  it('předá ARM deadline s desetisekundovou rezervou na durable ACK a serverový createdAt', async () => {
    const f = fixture();
    f.remote.command = { type: 'arm-live' };
    await recoverableCopierDelivery(f.options)();
    expect(f.options.agent.execute).toHaveBeenCalledWith(
      { type: 'arm-live' },
      {
        source: 'relay',
        createdAt: Date.parse(f.remote.createdAt),
        clockSkewReserveMs: 2_000,
        deadlineAt: Date.parse(f.remote.expiresAt) - 10_000,
      },
    );
  });
  it('provede pre-start day-lock, pokud session z jeho createdAt stále trvá', async () => {
    const f = fixture();
    const now = Date.parse('2026-09-29T20:00:00.000Z');
    f.setNow(now);
    f.remote.command = { type: 'lock-until-session-end', reason: 'Ruční zámek dne' };
    f.remote.createdAt = new Date(now - 1_000).toISOString();
    f.remote.expiresAt = new Date(now + 60_000).toISOString();
    f.options.request.mockImplementation(async body => body.action === 'poll-v2'
      ? { protocol: 2, command: f.remote, serverNow: new Date(now).toISOString() }
      : { protocol: 2, accepted: true });
    await recoverableCopierDelivery(f.options)();
    expect(f.options.agent.execute).toHaveBeenCalledWith(
      f.remote.command,
      expect.objectContaining({ createdAt: now - 1_000 }),
    );
  });
  it('po ztracené odpovědi obnoví stejný DISARM delivery_id a brzdu provede právě jednou', async () => {
    const f = fixture(); const step = recoverableCopierDelivery(f.options);
    f.options.request.mockRejectedValueOnce(new Error('response-lost'));
    await expect(step()).rejects.toThrow('response-lost');
    const deliveryId = f.saved?.deliveryId;
    await step();
    expect(f.options.request.mock.calls[1][0].deliveryId).toBe(deliveryId);
    expect(f.options.agent.execute).toHaveBeenCalledTimes(1);
  });
  it('po ztraceném DISARM ACK opakuje jen complete-v2 a relay se nezasekne', async () => {
    const f = fixture(); const step = recoverableCopierDelivery(f.options);
    f.options.request.mockResolvedValueOnce({ protocol: 2, command: f.remote }).mockRejectedValueOnce(new Error('ACK-lost'));
    await expect(step()).rejects.toThrow('ACK-lost');
    expect(f.saved?.phase).toBe('completed'); await step();
    expect(f.options.agent.execute).toHaveBeenCalledTimes(1);
    const acks = f.options.request.mock.calls.filter(([body]) => body.action === 'complete-v2');
    expect(acks).toHaveLength(2); expect(acks[1][0]).toEqual(acks[0][0]);
  });
  it('clears a terminal server ACK whose response was lost, without execution or another ACK', async () => {
    const f = fixture(); const step = recoverableCopierDelivery(f.options);
    f.options.request.mockResolvedValueOnce({ protocol: 2, command: f.remote }).mockRejectedValueOnce(new Error('lost'));
    await expect(step()).rejects.toThrow(); f.remote.status = 'succeeded'; await step();
    expect(f.options.agent.execute).toHaveBeenCalledTimes(1); expect(f.saved).toBeNull();
    expect(f.options.request).toHaveBeenCalledTimes(3);
  });
  it.each(['polling', 'executing', 'completed'] as const)('never executes a persisted %s command after restart', async phase => {
    const f = fixture(); f.remote.command = { type: 'reconcile' };
    f.saved = { version: 1, session: randomUUID(), deliveryId: randomUUID(), phase,
      ...(phase !== 'polling' ? { commandId: f.remote.id, result: { armed: true } } : {}) };
    await recoverableCopierDelivery(f.options)();
    expect(f.options.agent.execute).not.toHaveBeenCalled();
    // 8. 10. 2026: durable výsledek z předchozí session se jen znovu potvrdí.
    expect(f.options.request.mock.calls[1][0]).toMatchObject(phase === 'completed'
      ? { result: { armed: true } }
      : { error: 'command-outcome-unknown-worker-session-changed', result: null });
  });
  it('does not repeat execution if saving its result fails', async () => {
    const f = fixture(); const step = recoverableCopierDelivery(f.options);
    const write = f.options.store.write;
    let fail = true;
    f.options.store.write = async row => {
      if (row?.phase === 'completed' && fail) { fail = false; throw new Error('disk-full'); }
      await write(row);
    };
    await expect(step()).rejects.toThrow('disk-full'); await step();
    expect(f.options.agent.execute).toHaveBeenCalledTimes(1);
  });
  it('will not execute after its intent could not be synced to disk', async () => {
    // Neidempotentní příkaz; DISARM/kill switch se smí zopakovat (jen zpřísňují).
    const f = fixture(); f.remote.command = { type: 'reconcile' }; const step = recoverableCopierDelivery(f.options);
    const write = f.options.store.write; let fail = true;
    f.options.store.write = async row => { if (row?.phase === 'executing' && fail) { fail = false; throw new Error('disk'); } await write(row); };
    await expect(step()).rejects.toThrow('disk'); await step();
    expect(f.options.agent.execute).not.toHaveBeenCalled();
  });
  it.each(['expired', 'old', 'invalid'])('rejects a %s command rather than extending its TTL', async kind => {
    const f = fixture();
    // Brzdy (disarm/kill switch) zadané před restartem se provádějí; test
    // stáří proto používá příkaz, který brzdou není.
    f.remote.command = { type: 'reconcile' };
    if (kind === 'expired') f.remote.expiresAt = new Date(999).toISOString();
    if (kind === 'old') f.remote.createdAt = new Date(999).toISOString();
    if (kind === 'invalid') f.remote.expiresAt = 'invalid';
    await recoverableCopierDelivery(f.options)(); expect(f.options.agent.execute).not.toHaveBeenCalled();
  });
  it.each([
    ['disarm', 'polling'], ['disarm', 'executing'], ['kill-switch', 'polling'], ['kill-switch', 'executing'],
  ] as const)('claim brzdy %s z předchozí session (%s) se po restartu provede', async (type, phase) => {
    const f = fixture(); f.remote.command = { type } as never;
    f.saved = { version: 1, session: randomUUID(), deliveryId: randomUUID(), phase,
      ...(phase !== 'polling' ? { commandId: f.remote.id } : {}) };
    await recoverableCopierDelivery(f.options)();
    expect(f.options.agent.execute).toHaveBeenCalledTimes(1);
    expect(f.options.request.mock.calls[1][0]).not.toMatchObject({ error: 'command-outcome-unknown-worker-session-changed' });
  });
  it.each(['disarm', 'kill-switch'] as const)('brzda %s se po neúspěšném zápisu checkpointu provede (nikdy se nezahodí)', async type => {
    const f = fixture(); f.remote.command = { type };
    const write = f.options.store.write; let fail = true;
    f.options.store.write = async row => { if (row?.phase === 'executing' && fail) { fail = false; throw new Error('disk'); } await write(row); };
    const step = recoverableCopierDelivery(f.options);
    await expect(step()).rejects.toThrow('disk');
    await step();
    expect(f.options.agent.execute).toHaveBeenCalledTimes(1);
  });
  it('denní zámek: server o 300 ms napřed, normalizovaný čas přes hranici 17:00 CT → odmítnut', async () => {
    const f = fixture();
    f.remote.command = { type: 'lock-until-session-end', reason: 'test' } as never;
    f.remote.createdAt = '2026-10-08T22:00:00.200Z'; // serverový čas (server +300 ms)
    f.remote.expiresAt = '2026-10-08T22:10:00.000Z';
    f.setNow(Date.parse('2026-10-08T21:59:58.000Z'));
    const step = recoverableCopierDelivery(f.options);
    const localNow = Date.parse('2026-10-08T21:59:59.950Z');
    f.setNow(localNow);
    // Server hlásí serverNow o 300 ms napřed; skutečný vznik byl 16:59:59.900 CT.
    f.options.request.mockImplementation(async (body: { action: string }) => body.action === 'poll-v2'
      ? { protocol: 2, command: f.remote, serverNow: new Date(localNow + 300).toISOString() }
      : { protocol: 2, accepted: true });
    await step();
    expect(f.options.agent.execute).not.toHaveBeenCalled();
  });
  it('denní zámek těsně u hranice session (17:00 CT) se odmítne, ať nezamkne další den', async () => {
    const f = fixture();
    f.remote.command = { type: 'lock-until-session-end', reason: 'test' } as never;
    // 16:59:59.900 Chicago; nejistota posunu hodin přesahuje hranici session.
    f.remote.createdAt = '2026-10-08T21:59:59.900Z';
    f.remote.expiresAt = '2026-10-08T22:10:00.000Z';
    f.setNow(Date.parse('2026-10-08T21:59:58.000Z')); // worker běží už před vznikem zámku
    const step = recoverableCopierDelivery(f.options);
    f.setNow(Date.parse('2026-10-08T21:59:59.950Z'));
    await step();
    expect(f.options.agent.execute).not.toHaveBeenCalled();
  });
  it.each(['disarm', 'kill-switch'] as const)('brzda %s zadaná před restartem workeru se provede', async type => {
    const f = fixture();
    f.remote.command = { type };
    f.remote.createdAt = new Date(999).toISOString();
    await recoverableCopierDelivery(f.options)();
    expect(f.options.agent.execute).toHaveBeenCalledTimes(1);
  });
  it('checks expiry again after disk writes', async () => {
    const f = fixture(); const write = f.options.store.write;
    f.options.store.write = async row => { await write(row); if (row?.phase === 'executing') f.setNow(40_000); };
    await recoverableCopierDelivery(f.options)(); expect(f.options.agent.execute).not.toHaveBeenCalled();
  });
  it('fails closed with an old server or an unreadable checkpoint', async () => {
    const f = fixture(); f.options.request.mockResolvedValue({ command: f.remote });
    await expect(recoverableCopierDelivery(f.options)()).rejects.toThrow('protocol-unavailable');
    expect(f.options.agent.execute).not.toHaveBeenCalled();
    f.options.store.read = async () => { throw new Error('corrupt'); };
    await expect(recoverableCopierDelivery(f.options)()).rejects.toThrow('corrupt');
  });
  it('durably stores private checkpoints and rejects corruption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-checkpoint-'));
    try {
      const path = join(directory, 'delivery.json'); const store = fileRelayDeliveryStore(path);
      expect(await store.read()).toBeNull();
      const row: RelayDelivery = { version: 1, session: randomUUID(), deliveryId: randomUUID(), phase: 'polling' };
      await store.write(row); expect(await store.read()).toEqual(row); expect((await stat(path)).mode & 0o777).toBe(0o600);
      await store.write(null); expect(await readFile(path, 'utf8')).toBe('null');
      await writeFile(path, '{}'); await expect(store.read()).rejects.toThrow('checkpoint-invalid');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('delivery shutdown guard', () => {
  it('does not execute when shutdown arrives while the intent is syncing', async () => {
    const f = fixture(); const write = f.options.store.write; let active = true;
    f.options.store.write = async row => { await write(row); if (row?.phase === 'executing') active = false; };
    await recoverableCopierDelivery({ ...f.options, isActive: () => active })();
    expect(f.options.agent.execute).not.toHaveBeenCalled();
    expect(f.options.request.mock.calls[1][0]).toMatchObject({ error: 'command-cancelled-worker-shutdown' });
  });
  it('preserves the delivery ID on a malformed empty response', async () => {
    const f = fixture(); const step = recoverableCopierDelivery(f.options);
    f.options.request.mockResolvedValueOnce({ protocol: 2 });
    await expect(step()).rejects.toThrow('response-invalid');
    const id = f.saved?.deliveryId; await step();
    expect(f.options.request.mock.calls[1][0].deliveryId).toBe(id);
  });
});
