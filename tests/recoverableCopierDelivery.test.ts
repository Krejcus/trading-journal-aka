import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverableCopierDelivery } from '../server/recoverableCopierDelivery';
import { fileRelayDeliveryStore, type RelayDelivery, type RelayDeliveryStore } from '../server/copierRelayDeliveryStore';
import type { LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';

function fixture() {
  let saved: RelayDelivery | null = null;
  let now = 1_000;
  const store: RelayDeliveryStore = { read: vi.fn(async () => saved && structuredClone(saved)),
    write: vi.fn(async value => { saved = value && structuredClone(value); }) };
  const remote = { id: randomUUID(), command: { type: 'disarm' }, status: 'claimed',
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
  it('recovers the SAME delivery after a claim response is lost', async () => {
    const f = fixture(); const step = recoverableCopierDelivery(f.options);
    f.options.request.mockRejectedValueOnce(new Error('response-lost'));
    await expect(step()).rejects.toThrow('response-lost');
    const deliveryId = f.saved?.deliveryId;
    await step();
    expect(f.options.request.mock.calls[1][0].deliveryId).toBe(deliveryId);
    expect(f.options.agent.execute).toHaveBeenCalledTimes(1);
  });
  it('retries only the completion when the ACK did not reach the database', async () => {
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
    const f = fixture(); f.saved = { version: 1, session: randomUUID(), deliveryId: randomUUID(), phase,
      ...(phase !== 'polling' ? { commandId: f.remote.id, result: { armed: true } } : {}) };
    await recoverableCopierDelivery(f.options)();
    expect(f.options.agent.execute).not.toHaveBeenCalled();
    expect(f.options.request.mock.calls[1][0]).toMatchObject({ error: 'command-outcome-unknown-worker-session-changed', result: null });
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
    const f = fixture(); const step = recoverableCopierDelivery(f.options);
    const write = f.options.store.write; let fail = true;
    f.options.store.write = async row => { if (row?.phase === 'executing' && fail) { fail = false; throw new Error('disk'); } await write(row); };
    await expect(step()).rejects.toThrow('disk'); await step();
    expect(f.options.agent.execute).not.toHaveBeenCalled();
  });
  it.each(['expired', 'old', 'invalid'])('rejects a %s command rather than extending its TTL', async kind => {
    const f = fixture();
    if (kind === 'expired') f.remote.expiresAt = new Date(999).toISOString();
    if (kind === 'old') f.remote.createdAt = new Date(999).toISOString();
    if (kind === 'invalid') f.remote.expiresAt = 'invalid';
    await recoverableCopierDelivery(f.options)(); expect(f.options.agent.execute).not.toHaveBeenCalled();
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
