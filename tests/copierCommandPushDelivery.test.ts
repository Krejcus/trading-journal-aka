import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { recoverableCopierDelivery } from '../server/recoverableCopierDelivery';
import type { RelayDelivery, RelayDeliveryStore } from '../server/copierRelayDeliveryStore';
import type { LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';
import type { LocalCopierAgentCommand } from '../lib/localCopierAgentProtocol';

/**
 * F1b′ (2. 11. 2026): server naváže příkaz k nečinné delivery stejnou logikou jako
 * `claim_tradovate_copier_command_v2` a pošle řádek pushem. Push jde stejným automatem
 * (session, started, created < startedAt, TTL, persist executing) a nikdy nevede k druhé execution.
 */
interface Row {
  id: string; command: LocalCopierAgentCommand; status: string; deliveryId: string | null;
  createdAt: number; expiresAt: number; error?: string | null;
}

function harness(options: { failWrites?: () => boolean } = {}) {
  let now = 10_000;
  let saved: RelayDelivery | null = null;
  const rows: Row[] = [];
  const store: RelayDeliveryStore = {
    read: vi.fn(async () => saved && structuredClone(saved)),
    write: vi.fn(async value => {
      if (options.failWrites?.()) throw new Error('disk-full');
      saved = value && structuredClone(value);
    }),
  };
  const executed: string[] = [];
  const agent = {
    execute: vi.fn(async (command: LocalCopierAgentCommand) => { executed.push(command.type); return { ok: command.type }; }),
    status: vi.fn(() => ({ startedAt: new Date(0).toISOString() })),
  } as unknown as LocalCopierExecutionAgent;
  const wire = (row: Row) => ({ id: row.id, command: row.command, status: row.status,
    createdAt: new Date(row.createdAt).toISOString(), expiresAt: new Date(row.expiresAt).toISOString() });
  /** Emulace claim_v2: vázaný řádek k delivery, jinak FIFO hlava `pending`. */
  const claim = (deliveryId: string) => {
    const bound = rows.find(row => row.deliveryId === deliveryId);
    if (bound) return bound;
    const pending = rows.filter(row => row.status === 'pending' && row.expiresAt > now).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!pending) return null;
    pending.status = 'claimed'; pending.deliveryId = deliveryId;
    return pending;
  };
  const request = vi.fn(async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (body.action === 'poll-v2') {
      const row = claim(String(body.deliveryId));
      return { protocol: 2, command: row ? wire(row) : null, serverNow: new Date(now).toISOString() };
    }
    const row = rows.find(item => item.id === body.commandId && item.deliveryId === body.deliveryId);
    if (!row || row.status !== 'claimed') return { protocol: 2, accepted: false };
    row.status = body.error == null ? 'succeeded' : 'rejected';
    row.error = body.error as string | null;
    return { protocol: 2, accepted: true };
  });
  const enqueue = (command: LocalCopierAgentCommand, ageMs = -1) => {
    const row: Row = { id: randomUUID(), command, status: 'pending', deliveryId: null, createdAt: now - ageMs, expiresAt: now + 30_000 };
    rows.push(row); return row;
  };
  /** Server: naváže k ohlášené nečinné delivery a vrátí push (už ověřený podpis). */
  const serverPush = (deliveryId: string) => {
    const row = claim(deliveryId);
    return row && row.status === 'claimed' ? { deliveryId, command: wire(row) } : null;
  };
  const relayOptions = { store, agent, request, nextRevision: () => 1, onComplete: vi.fn(), now: () => now };
  const polls = () => request.mock.calls.filter(([body]) => body.action === 'poll-v2').length;
  return {
    rows, executed, relayOptions, enqueue, serverPush, polls, request,
    get saved() { return saved; }, set saved(value) { saved = value; },
    advance: (ms: number) => { now += ms; },
  };
}

describe('F1b′: nečinná delivery a push navázaného příkazu', () => {
  it('prázdné polly delivery nerotují a relayIdle ji hlásí (jen po potvrzeném zápisu)', async () => {
    const h = harness();
    const step = recoverableCopierDelivery(h.relayOptions);
    expect(step.idleDeliveryId()).toBeNull();
    await step();
    const first = h.saved!.deliveryId;
    expect(step.idleDeliveryId()).toBe(first);
    await step(); await step();
    expect(h.saved!.deliveryId).toBe(first);
    expect(step.idleDeliveryId()).toBe(first);
  });

  it('selhaný zápis checkpointu → relayIdle se nehlásí', async () => {
    let fail = false;
    const h = harness({ failWrites: () => fail });
    const step = recoverableCopierDelivery(h.relayOptions);
    await step();
    fail = true;
    const before = step.idleDeliveryId();
    expect(before).not.toBeNull();
    // Nová relay instance (restart) s rozbitým diskem: nic nehlásí.
    const restarted = recoverableCopierDelivery(h.relayOptions);
    await expect(restarted()).rejects.toThrow('disk-full');
    expect(restarted.idleDeliveryId()).toBeNull();
  });

  it('restart: nečinný checkpoint staré session se po prázdném pollu vymění a další příkaz se PROVEDE', async () => {
    const h = harness();
    await recoverableCopierDelivery(h.relayOptions)();
    const oldId = h.saved!.deliveryId;
    const oldSession = h.saved!.session;
    const step = recoverableCopierDelivery(h.relayOptions);
    expect(step.idleDeliveryId()).toBeNull();
    await step();
    expect(h.saved!.deliveryId).not.toBe(oldId);
    expect(h.saved!.session).not.toBe(oldSession);
    expect(step.idleDeliveryId()).toBe(h.saved!.deliveryId);
    const fresh = h.enqueue({ type: 'reconcile' });
    await step();
    expect(fresh.status).toBe('succeeded');
    expect(h.executed).toEqual(['reconcile']);
  });

  it('push se provede bez HTTP pollu, jednou; pak nová nečinná delivery', async () => {
    const h = harness();
    const step = recoverableCopierDelivery(h.relayOptions);
    await step();
    const idle = step.idleDeliveryId()!;
    const row = h.enqueue({ type: 'reconcile' });
    const push = h.serverPush(idle)!;
    const pollsBefore = h.polls();
    await step(push);
    expect(h.polls()).toBe(pollsBefore);
    expect(row.status).toBe('succeeded');
    expect(h.executed).toEqual(['reconcile']);
    expect(step.idleDeliveryId()).not.toBe(idle);
    // Pozdní duplicitní push téže delivery: zahodí se, nic se neopakuje.
    await step(push);
    expect(h.executed).toEqual(['reconcile']);
  });

  it('poll vyzvedl vázaný řádek dřív než push: pozdní push se zahodí (jedna execution)', async () => {
    const h = harness();
    const step = recoverableCopierDelivery(h.relayOptions);
    await step();
    const idle = step.idleDeliveryId()!;
    h.enqueue({ type: 'reconcile' });
    const push = h.serverPush(idle)!;
    await step();
    expect(h.executed).toEqual(['reconcile']);
    await step(push);
    expect(h.executed).toEqual(['reconcile']);
  });

  it('push bez čerstvého vzorku hodin z pollu se nepoužije — jde se pollem (stejný řádek)', async () => {
    const h = harness();
    // Delivery s id z předchozí instance téže session nejde podvrhnout — nová instance nemá vzorek hodin.
    const step = recoverableCopierDelivery(h.relayOptions);
    await step();
    const idle = step.idleDeliveryId()!;
    h.advance(61_000);
    h.enqueue({ type: 'reconcile' });
    const push = h.serverPush(idle)!;
    const pollsBefore = h.polls();
    await step(push);
    expect(h.polls()).toBe(pollsBefore + 1);
    expect(h.executed).toEqual(['reconcile']);
  });

  it('push příkazu staršího než session workeru jde stejnými branami (neprovede se)', async () => {
    const h = harness();
    const step = recoverableCopierDelivery(h.relayOptions);
    await step();
    const idle = step.idleDeliveryId()!;
    const old = h.enqueue({ type: 'reconcile' }, 5_000);
    await step(h.serverPush(idle)!);
    expect(old.error).toBe('command-expired-or-predates-worker-session');
    expect(h.executed).toEqual([]);
  });

  it('push s cizí delivery se ignoruje a jede se pollem', async () => {
    const h = harness();
    const step = recoverableCopierDelivery(h.relayOptions);
    await step();
    h.enqueue({ type: 'reconcile' });
    const pollsBefore = h.polls();
    await step({ deliveryId: randomUUID(), command: { id: 'x', status: 'claimed', command: { type: 'reconcile' } } });
    expect(h.polls()).toBe(pollsBefore + 1);
    expect(h.executed).toEqual(['reconcile']);
  });

  it('push po restartu pro delivery staré session se nepoužije', async () => {
    const h = harness();
    const first = recoverableCopierDelivery(h.relayOptions);
    await first();
    const oldIdle = first.idleDeliveryId()!;
    const restarted = recoverableCopierDelivery(h.relayOptions);
    h.enqueue({ type: 'reconcile' });
    const push = h.serverPush(oldIdle)!;
    const pollsBefore = h.polls();
    await restarted(push);
    // Push ignorován (cizí session, bez vzorku hodin) → poll vrátí vázaný řádek → konzervativně neprovedeno.
    expect(h.polls()).toBe(pollsBefore + 1);
    expect(h.executed).toEqual([]);
    expect(h.rows[0].error).toBe('command-outcome-unknown-worker-session-changed');
  });
});
