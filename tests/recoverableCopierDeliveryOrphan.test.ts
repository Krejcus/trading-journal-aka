import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { recoverableCopierDelivery } from '../server/recoverableCopierDelivery';
import type { RelayDelivery, RelayDeliveryStore } from '../server/copierRelayDeliveryStore';
import type { LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';
import type { LocalCopierAgentCommand } from '../lib/localCopierAgentProtocol';

/**
 * Checkpoint s delivery, kterou DB nezná nebo svázala s jiným příkazem
 * (obnova DB, ruční zásah) — relay se nesmí zaseknout a nic nesmí provést
 * dvakrát (29. 10. 2026, INV-RELAY-02).
 *
 * Fake fronta se chová jako `claim_tradovate_copier_command_v2` /
 * `complete_tradovate_copier_command_v2`: nejdřív vrátí řádek s danou
 * delivery, jinak naváže nejstarší `pending`.
 */
interface Row {
  id: string; command: LocalCopierAgentCommand; status: string; deliveryId: string | null;
  createdAt: number; expiresAt: number; result?: unknown; error?: string | null;
}

function harness() {
  let now = 10_000;
  let saved: RelayDelivery | null = null;
  const rows: Row[] = [];
  const store: RelayDeliveryStore = {
    read: vi.fn(async () => saved && structuredClone(saved)),
    write: vi.fn(async value => { saved = value && structuredClone(value); }),
  };
  const executed: string[] = [];
  const agent = {
    execute: vi.fn(async (command: LocalCopierAgentCommand) => { executed.push(command.type); return { ok: command.type }; }),
    status: vi.fn(() => ({ startedAt: new Date(0).toISOString() })),
  } as unknown as LocalCopierExecutionAgent;
  const wire = (row: Row) => ({ id: row.id, command: row.command, status: row.status,
    createdAt: new Date(row.createdAt).toISOString(), expiresAt: new Date(row.expiresAt).toISOString() });
  const request = vi.fn(async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (body.action === 'poll-v2') {
      const bound = rows.find(row => row.deliveryId === body.deliveryId);
      if (bound) return { protocol: 2, command: wire(bound), serverNow: new Date(now).toISOString() };
      const pending = rows.filter(row => row.status === 'pending' && row.expiresAt > now)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!pending) return { protocol: 2, command: null, serverNow: new Date(now).toISOString() };
      pending.status = 'claimed'; pending.deliveryId = String(body.deliveryId);
      return { protocol: 2, command: wire(pending), serverNow: new Date(now).toISOString() };
    }
    const row = rows.find(item => item.id === body.commandId && item.deliveryId === body.deliveryId);
    if (!row || row.status !== 'claimed') return { protocol: 2, accepted: false };
    row.status = body.error == null ? 'succeeded' : 'rejected';
    row.result = body.result; row.error = body.error as string | null;
    return { protocol: 2, accepted: true };
  });
  const enqueue = (command: LocalCopierAgentCommand, ageMs = -1) => {
    const row: Row = { id: randomUUID(), command, status: 'pending', deliveryId: null,
      createdAt: now - ageMs, expiresAt: now + 30_000 };
    rows.push(row); return row;
  };
  const options = { store, agent, request, nextRevision: () => 1, onComplete: vi.fn(), now: () => now };
  const acks = () => request.mock.calls.map(([body]) => body).filter(body => body.action === 'complete-v2');
  return {
    rows, executed, options, enqueue, acks, request,
    get saved() { return saved; }, set saved(value) { saved = value; },
    advance: (ms: number) => { now += ms; },
  };
}

const orphanCheckpoint = (phase: 'executing' | 'completed', session = randomUUID()): RelayDelivery => ({
  version: 1, session, deliveryId: randomUUID(), phase, commandId: randomUUID(),
  ...(phase === 'completed' ? { result: { armed: true }, error: 'stary-vysledek' } : {}),
});

describe('relay: osiřelá delivery (DB ji nezná)', () => {
  it.each(['executing', 'completed'] as const)('%s checkpoint bez řádku v DB a bez fronty: zahodí se, nic neprovede ani neACKne', async phase => {
    const h = harness(); h.saved = orphanCheckpoint(phase);
    const orphanDelivery = h.saved.deliveryId;
    const step = recoverableCopierDelivery(h.options);
    await expect(step()).resolves.toMatchObject({ command: null });
    expect(h.saved).toBeNull();
    expect(h.acks()).toHaveLength(0);
    // Další příkaz jde pod novou delivery standardní cestou.
    const disarm = h.enqueue({ type: 'disarm' });
    await step();
    expect(h.request.mock.calls.at(-2)![0].deliveryId).not.toBe(orphanDelivery);
    expect(h.executed).toEqual(['disarm']);
    expect(disarm.status).toBe('succeeded');
  });

  it('DISARM svázaný s osiřelou delivery se provede a ACKne vlastním výsledkem (už neuvízne v claimed)', async () => {
    const h = harness(); h.saved = orphanCheckpoint('completed');
    const disarm = h.enqueue({ type: 'disarm' });
    await recoverableCopierDelivery(h.options)();
    expect(h.executed).toEqual(['disarm']);
    expect(disarm.status).toBe('succeeded');
    expect(h.acks()).toHaveLength(1);
    expect(h.acks()[0]).toMatchObject({ commandId: disarm.id, result: { ok: 'disarm' }, error: null });
    expect(h.saved).toBeNull();
  });

  it.each([
    { type: 'arm-live' }, { type: 'reconcile' },
  ] as LocalCopierAgentCommand[])('ne-brzda $type svázaná s osiřelou delivery se neprovede, ACK s chybou zotavení bez cizího výsledku', async command => {
    const h = harness(); h.saved = orphanCheckpoint('completed');
    const row = h.enqueue(command);
    await recoverableCopierDelivery(h.options)();
    expect(h.executed).toEqual([]);
    expect(row.status).toBe('rejected');
    expect(h.acks()[0]).toMatchObject({ commandId: row.id, result: null, error: 'command-rejected-relay-delivery-recovered' });
    expect(h.saved).toBeNull();
  });

  it('svázaný příkaz už terminální: checkpoint se zahodí bez execution a ACK', async () => {
    const h = harness(); h.saved = orphanCheckpoint('executing');
    const row = h.enqueue({ type: 'disarm' });
    row.status = 'succeeded'; row.deliveryId = h.saved.deliveryId;
    await recoverableCopierDelivery(h.options)();
    expect(h.executed).toEqual([]); expect(h.acks()).toHaveLength(0); expect(h.saved).toBeNull();
  });

  it('řádek s naší delivery zase pending (ruční zásah): neuvízne a ne-brzdu podruhé neprovede', async () => {
    const h = harness(); const step = recoverableCopierDelivery(h.options);
    const row = h.enqueue({ type: 'reconcile' });
    // Provedeno a ACK ztraceno → checkpoint completed; pak někdo řádek vrátí na pending.
    h.request.mockImplementationOnce(h.request.getMockImplementation()!)
      .mockImplementationOnce(async () => { throw new Error('ack-lost'); });
    await expect(step()).rejects.toThrow('ack-lost');
    expect(h.executed).toEqual(['reconcile']);
    row.status = 'pending';
    await step();
    expect(h.saved).toBeNull();
    await step();
    expect(h.executed).toEqual(['reconcile']);
    expect(row.status).toBe('rejected');
    expect(row.error).toBe('command-outcome-unknown-already-started-this-session');
  });
});

describe('relay: druhá execution po vrácení DB ve stejné session', () => {
  it('ACKnutý příkaz vrácený do pending se znovu neprovede (výsledek neznámý)', async () => {
    const h = harness(); const step = recoverableCopierDelivery(h.options);
    const row = h.enqueue({ type: 'reconcile' });
    await step();
    expect(row.status).toBe('succeeded');
    Object.assign(row, { status: 'pending', deliveryId: null, result: undefined, error: undefined });
    await step();
    expect(h.executed).toEqual(['reconcile']);
    expect(row.status).toBe('rejected');
    expect(row.error).toBe('command-outcome-unknown-already-started-this-session');
  });

  it('brzda vrácená do pending se smí provést znovu (jen zpřísňuje)', async () => {
    const h = harness(); const step = recoverableCopierDelivery(h.options);
    const row = h.enqueue({ type: 'disarm' });
    await step();
    Object.assign(row, { status: 'pending', deliveryId: null });
    await step();
    expect(h.executed).toEqual(['disarm', 'disarm']);
    expect(row.status).toBe('succeeded');
  });

  it('P provedený dřív pod jinou delivery a po vrácení DB svázaný s osiřelou delivery: výsledek neznámý, ne „odmítnuto“', async () => {
    const h = harness(); const step = recoverableCopierDelivery(h.options);
    const p = h.enqueue({ type: 'reconcile' });
    await step();
    const c = h.enqueue({ type: 'reconcile' });
    h.request.mockImplementationOnce(h.request.getMockImplementation()!)
      .mockImplementationOnce(async () => { throw new Error('ack-lost'); });
    await expect(step()).rejects.toThrow('ack-lost');
    expect(h.saved).toMatchObject({ phase: 'completed', commandId: c.id });
    // Obnova DB: P je zase pending, C neexistuje.
    h.rows.splice(h.rows.indexOf(c), 1);
    Object.assign(p, { status: 'pending', deliveryId: null, result: undefined, error: undefined });
    await step();
    expect(h.executed).toEqual(['reconcile', 'reconcile']);
    expect(p.status).toBe('rejected');
    expect(p.error).toBe('command-outcome-unknown-already-started-this-session');
    expect(h.saved).toBeNull();
  });
});

describe('relay: zotavení a chyby disku', () => {
  it('brzda v zotavení: selže zápis executing → neprovede se, další krok ji provede právě jednou', async () => {
    const h = harness(); h.saved = orphanCheckpoint('completed');
    const disarm = h.enqueue({ type: 'disarm' });
    const write = h.options.store.write; let fail = true;
    h.options.store.write = vi.fn(async (row: RelayDelivery | null) => {
      if (row?.phase === 'executing' && fail) { fail = false; throw new Error('disk'); }
      await write(row);
    });
    const step = recoverableCopierDelivery(h.options);
    await expect(step()).rejects.toThrow('disk');
    expect(h.executed).toEqual([]);
    await step();
    expect(h.executed).toEqual(['disarm']);
    expect(disarm.status).toBe('succeeded');
    expect(h.acks().at(-1)).toMatchObject({ commandId: disarm.id, result: { ok: 'disarm' } });
  });

  it('ne-brzda v zotavení: selže zápis výsledku a worker se restartuje → pořád neprovedena', async () => {
    const h = harness(); h.saved = orphanCheckpoint('completed');
    const row = h.enqueue({ type: 'reconcile' });
    const write = h.options.store.write; let fail = true;
    h.options.store.write = vi.fn(async (value: RelayDelivery | null) => {
      if (value?.phase === 'completed' && value.commandId === row.id && fail) { fail = false; throw new Error('disk'); }
      await write(value);
    });
    await expect(recoverableCopierDelivery(h.options)()).rejects.toThrow('disk');
    h.advance(1_000);
    await recoverableCopierDelivery(h.options)();
    expect(h.executed).toEqual([]);
    expect(row.status).toBe('rejected');
    expect(h.saved).toBeNull();
  });

  it('ne-brzda v zotavení: selže zápis výsledku ve stejné session → další krok ji pořád odmítne', async () => {
    const h = harness(); h.saved = orphanCheckpoint('completed');
    const row = h.enqueue({ type: 'arm-live' });
    const write = h.options.store.write; let fail = true;
    h.options.store.write = vi.fn(async (value: RelayDelivery | null) => {
      if (value?.commandId === row.id && fail) { fail = false; throw new Error('disk'); }
      await write(value);
    });
    const step = recoverableCopierDelivery(h.options);
    await expect(step()).rejects.toThrow('disk');
    await step();
    expect(h.executed).toEqual([]);
    expect(row.status).toBe('rejected');
    expect(row.error).toBe('command-rejected-relay-delivery-recovered');
  });

  it('čerstvý checkpoint zotavení se samostatně nezapisuje (na disku zůstane osiřelý, dokud nepřijde výsledek)', async () => {
    const h = harness(); h.saved = orphanCheckpoint('completed');
    h.enqueue({ type: 'reconcile' });
    await recoverableCopierDelivery(h.options)();
    const writes = vi.mocked(h.options.store.write).mock.calls.map(([value]) => value);
    expect(writes.some(value => value?.phase === 'polling' && value.commandId === undefined && value.deliveryId === writes[0]?.deliveryId)).toBe(false);
  });

  it('brzda v zotavení, kterou už tato session jednou provedla, se provede znovu', async () => {
    const h = harness(); const step = recoverableCopierDelivery(h.options);
    const disarm = h.enqueue({ type: 'disarm' });
    await step();
    const c = h.enqueue({ type: 'reconcile' });
    h.request.mockImplementationOnce(h.request.getMockImplementation()!)
      .mockImplementationOnce(async () => { throw new Error('ack-lost'); });
    await expect(step()).rejects.toThrow('ack-lost');
    h.rows.splice(h.rows.indexOf(c), 1);
    Object.assign(disarm, { status: 'pending', deliveryId: null });
    await step();
    expect(h.executed).toEqual(['disarm', 'reconcile', 'disarm']);
    expect(disarm.status).toBe('succeeded');
  });

  it('brzda na řádku s naší delivery zase pending se pod novou delivery provede', async () => {
    const h = harness(); const step = recoverableCopierDelivery(h.options);
    const row = h.enqueue({ type: 'kill-switch' });
    h.request.mockImplementationOnce(h.request.getMockImplementation()!)
      .mockImplementationOnce(async () => { throw new Error('ack-lost'); });
    await expect(step()).rejects.toThrow('ack-lost');
    row.status = 'pending';
    await step(); await step();
    expect(h.executed).toEqual(['kill-switch', 'kill-switch']);
    expect(row.status).toBe('succeeded');
  });

  it('ACK zotavení s 409 se opakuje se stejným tělem bez execution', async () => {
    const h = harness(); h.saved = orphanCheckpoint('completed');
    const row = h.enqueue({ type: 'reconcile' });
    const step = recoverableCopierDelivery(h.options);
    h.request.mockImplementationOnce(h.request.getMockImplementation()!)
      .mockImplementationOnce(async () => { throw new Error('copier-relay-http-409'); });
    await expect(step()).rejects.toThrow('409');
    await step();
    expect(h.executed).toEqual([]);
    const [first, second] = h.acks();
    expect(second).toEqual(first);
    expect(row.status).toBe('rejected');
  });

  it('osiřelý executing checkpoint z předchozí session: nový příkaz po restartu jde standardní cestou', async () => {
    const h = harness(); h.saved = orphanCheckpoint('executing');
    await recoverableCopierDelivery(h.options)();
    expect(h.saved).toBeNull();
    const old = h.enqueue({ type: 'reconcile' }, 5_000);
    const fresh = h.enqueue({ type: 'reconcile' });
    const step = recoverableCopierDelivery(h.options);
    await step(); await step();
    expect(old.error).toBe('command-expired-or-predates-worker-session');
    expect(fresh.status).toBe('succeeded');
    expect(h.executed).toEqual(['reconcile']);
  });
});
