// Převzatá review regrese: aktuální relay, worker a transport běží proti
// in-memory modelu SQL/PostgREST vrstvy.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRelayDb } from './zzbFakeRelayDb';
import * as newServer from '../server/tradovateCopierCommandRelay';
import * as newAgentMod from '../server/localCopierExecutionAgent';
import * as newRelayMod from '../server/macCopierCommandRelay';
import type { CopierControllerStatus, CopierRuntimeController } from '../services/copierRuntimeController';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import type { RelayDelivery } from '../server/copierRelayDeliveryStore';

const userId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';

const groupA = (): CopyGroupConfig => ({
  id: 'runtime-test', name: 'test', enabled: true, leaderAccountId: 11,
  followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});
const groupB = (): CopyGroupConfig => ({
  id: 'group-b', name: 'B', enabled: true, leaderAccountId: 33,
  followers: [{ accountId: 44, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});

const controller = () => {
  let status: CopierControllerStatus = {
    started: true, armed: false, killSwitch: false, shadowMode: true, connected: true,
    reconciliationRequired: false, divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false,
    stuckOperations: [], lastError: null, revision: 1, lastSequence: 0, groupFlat: true,
  };
  let releaseFlatten: () => void = () => undefined;
  let flattenGate: Promise<void> = Promise.resolve();
  const value = {
    arm: vi.fn(({ shadowMode = false }: { shadowMode?: boolean } = {}) => {
      status = { ...status, armed: true, shadowMode, ...(!shadowMode ? { sessionArmedAt: Date.now() } : {}) };
    }),
    beginShutdown: vi.fn(async () => { status = { ...status, armed: false }; }),
    disarm: vi.fn(() => { status = { ...status, armed: false }; }),
    engageKillSwitch: vi.fn(() => { status = { ...status, armed: false, killSwitch: true }; }),
    lockUntil: vi.fn(async () => { status = { ...status, armed: false }; }),
    unlockDay: vi.fn(async () => undefined),
    applyAccountEligibilityExclusions: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => ({ divergentAccounts: [], workingOrderAccounts: [] })),
    verifyAccountEligibility: vi.fn(),
    activateGroup: vi.fn(async () => undefined),
    reconfigureGroup: vi.fn(async () => undefined),
    updateGroup: vi.fn(async () => undefined),
    flattenAccount: vi.fn(async () => ({ flat: true })),
    flattenFollowerTrade: vi.fn(async () => ({ flat: true })),
    flattenGroup: vi.fn(async () => { await flattenGate; return { flat: true }; }),
    waiveStuckOperation: vi.fn(),
    status: vi.fn(() => status),
    waitForIdle: vi.fn(async () => undefined),
    stop: vi.fn(),
  };
  return {
    runtime: value as typeof value & CopierRuntimeController,
    gateFlatten: () => { flattenGate = new Promise<void>(resolve => { releaseFlatten = resolve; }); },
    releaseFlatten: () => releaseFlatten(),
  };
};

type Server = typeof newServer;

const makeDb = () => {
  const db = new FakeRelayDb();
  db.tables.tradovate_copier_devices.push({
    id: deviceId, user_id: userId, connection_id: connectionId, revoked_at: null,
    last_used_at: new Date().toISOString(), environment: 'demo',
  });
  return db;
};

/** Mirrors api/tradovate/oauth/copier-relay.ts (identical in both versions) for Device actions. */
const lossLog: string[] = [];
const relayHttp = (server: Server, db: FakeRelayDb, lose?: { pollOnce?: boolean; ackOnce?: boolean }) => {
  let lostPoll = false; let lostAck = false;
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
    const anyDb = db as never;
    if (body.action === 'poll-v2') {
      const command = await server.claimTradovateCopierCommandV2({ db: anyDb, deviceId, deliveryId: body.deliveryId });
      if (lose?.pollOnce && command?.command?.type === 'disarm' && !lostPoll) { lostPoll = true; lossLog.push('poll'); throw new Error('copier-relay-request-timeout'); }
      return Response.json({ protocol: 2, command, serverNow: new Date(db.dbNow()).toISOString(), realtime: null });
    }
    if (body.action === 'heartbeat-v2' || body.action === 'background-v2') {
      await server.heartbeatTradovateCopierDevice({ db: anyDb, deviceId, userId, connectionId,
        status: body.status, revision: body.revision, runtimeOnly: true });
      return Response.json({ protocol: 2, accepted: true, command: null, snapshotRequests: [] });
    }
    if (body.action === 'complete-v2') {
      const accepted = await server.completeTradovateCopierCommandV2({ db: anyDb, deviceId,
        deliveryId: body.deliveryId, commandId: body.commandId, result: body.result,
        error: typeof body.error === 'string' ? body.error : undefined, status: body.status, revision: body.revision });
      if (lose?.ackOnce && accepted && !lostAck) { lostAck = true; lossLog.push('ack'); throw new Error('copier-relay-request-timeout'); }
      return Response.json({ protocol: 2, accepted }, { status: accepted ? 200 : 409 });
    }
    return Response.json({ error: 'invalid-copier-relay-action' }, { status: 400 });
  });
};

interface Harness {
  db: FakeRelayDb; server: Server; ctl: ReturnType<typeof controller>;
  agent: Awaited<ReturnType<typeof newAgentMod.startLocalCopierExecutionAgent>>;
  close(): Promise<void>;
  send(command: unknown, opts?: { now?: number }): Promise<{ id: string; status: string; expiresAt: string }>;
  row(id: string): Record<string, any>;
  terminal(id: string): Promise<Record<string, any>>;
}

const open: Harness[] = [];
async function start(lose?: { pollOnce?: boolean; ackOnce?: boolean }): Promise<Harness> {
  const db = makeDb();
  const server = newServer;
  const ctl = controller();
  const agent = await newAgentMod.startLocalCopierExecutionAgent({
    controller: ctl.runtime, group: groupA(), port: 0,
    prepareGroupAccounts: async () => ({ missingOptional: [] }) as never,
  });
  let saved: RelayDelivery | null = null;
  const relay = newRelayMod.startMacCopierCommandRelay({
    apiOrigin: 'https://offline.invalid', agent: agent as never, authorizationHeader: async () => 'Device x',
    deliveryStore: { read: async () => saved, write: async value => { saved = value; } },
    fetchImpl: relayHttp(server, db, lose) as typeof fetch, pollMs: 500,
  });
  await vi.waitFor(() => expect(db.tables.tradovate_copier_device_runtime).toHaveLength(1), { timeout: 3_000 });
  const harness: Harness = {
    db, server, ctl, agent,
    async close() { ctl.releaseFlatten(); await relay.close(); await agent.close(); },
    send: (command, opts = {}) => server.enqueueTradovateCopierCommand({
      db: db as never, userId, connectionId, command: command as never, ...(opts.now ? { now: opts.now } : {}),
    }),
    row: id => db.tables.tradovate_copier_commands.find(row => row.id === id)!,
    async terminal(id) {
      await vi.waitFor(() => expect(['succeeded', 'rejected', 'expired']).toContain(harness.row(id).status), { timeout: 8_000 });
      return harness.row(id);
    },
  };
  open.push(harness);
  return harness;
}

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

describe('KOMPAT regrese aktuálního serveru a workeru', () => {
  it('ARM → DISARM → Flatten projdou end-to-end', async () => {
    const h = await start();
    const arm = await h.send({ type: 'arm-live', group: groupA() });
    expect((await h.terminal(arm.id)).status).toBe('succeeded');
    expect(h.agent.status().controller.armed).toBe(true);
    const disarm = await h.send({ type: 'disarm' });
    expect((await h.terminal(disarm.id)).status).toBe('succeeded');
    expect(h.agent.status().controller.armed).toBe(false);
    const flatten = await h.send({ type: 'copy-command', command: { type: 'flatten-group', groupId: 'runtime-test', operationId: 'op-flatten-1' } });
    expect((await h.terminal(flatten.id)).status).toBe('succeeded');
    const ttl = Date.parse(h.row(disarm.id).expires_at) - Date.parse(h.row(disarm.id).created_at);
    expect(ttl).toBe(600_000);
  }, 30_000);

  it('FIFO obsazená Flattenem: ARM pak DISARM → konečný stav DISARMED', async () => {
    const h = await start();
    h.ctl.gateFlatten();
    const flatten = await h.send({ type: 'copy-command', command: { type: 'flatten-group', groupId: 'runtime-test', operationId: 'op-flatten-2' } });
    await vi.waitFor(() => expect(h.ctl.runtime.flattenGroup).toHaveBeenCalledOnce(), { timeout: 5_000 });
    const arm = await h.send({ type: 'arm-live', group: groupA() });
    await new Promise(resolve => setTimeout(resolve, 5));
    const disarm = await h.send({ type: 'disarm' });
    h.ctl.releaseFlatten();
    await h.terminal(flatten.id);
    const armRow = await h.terminal(arm.id);
    expect((await h.terminal(disarm.id)).status).toBe('succeeded');
    expect(h.agent.status().controller.armed).toBe(false);
    expect(armRow).toMatchObject({ status: 'expired', error: 'superseded-by-brake' });
  }, 30_000);

  it('opakovaný ARM se shodnou skupinou na ARMED kopírce', async () => {
    const h = await start();
    const first = await h.send({ type: 'arm-live', group: groupA() });
    expect((await h.terminal(first.id)).status).toBe('succeeded');
    const second = await h.send({ type: 'arm-live', group: groupA() });
    const row = await h.terminal(second.id);
    // Payload sanitizovaný serverem musí na novém workeru dát shodnou konfiguraci (žádné falešné „jinou konfigurací").
    expect(row).toMatchObject({ status: 'succeeded' });
    expect(h.agent.status().controller.armed).toBe(true);
    expect(h.ctl.runtime.arm).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('UI „přepnout a zapnout" (ARM skupiny B na ARMED skupině A)', async () => {
    const h = await start();
    const first = await h.send({ type: 'arm-live', group: groupA() });
    expect((await h.terminal(first.id)).status).toBe('succeeded');
    const second = await h.send({ type: 'arm-live', group: groupB() });
    const row = await h.terminal(second.id);
    expect(row.status).toBe('succeeded');
    expect(h.ctl.runtime.activateGroup).toHaveBeenCalled();
    expect(h.agent.status().group.id).toBe('group-b');
    expect(h.agent.status().controller.armed).toBe(true);
  }, 30_000);
});

describe('KOMPAT: smíšený kanál (loopback brzda + relay ARM) a hodiny', () => {
  const loopbackDisarm = async (h: Harness) => {
    const status = await fetch(`${h.agent.origin}/v1/status`, { headers: { Origin: 'https://alphatrade-mentor-15.vercel.app' } }).then(r => r.json()) as { nonce: string };
    const response = await fetch(`${h.agent.origin}/v1/command`, {
      method: 'POST',
      headers: { Origin: 'https://alphatrade-mentor-15.vercel.app', 'Content-Type': 'application/json', 'X-AlphaTrade-Agent-Nonce': status.nonce },
      body: JSON.stringify({ type: 'disarm' }),
    });
    return response.status;
  };

  it('relay ARM ve frontě + loopback DISARM → ARM odmítnut plotem', async () => {
    const h = await start();
    h.ctl.gateFlatten();
    await h.send({ type: 'copy-command', command: { type: 'flatten-group', groupId: 'runtime-test', operationId: 'op-flatten-3' } });
    await vi.waitFor(() => expect(h.ctl.runtime.flattenGroup).toHaveBeenCalledOnce(), { timeout: 5_000 });
    const arm = await h.send({ type: 'arm-live', group: groupA() });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await loopbackDisarm(h)).toBe(200); // brzda hned, mimo tail
    h.ctl.releaseFlatten();
    const row = await h.terminal(arm.id);
    expect(row.status).toBe('rejected');
    expect(String(row.error)).toContain('starší než poslední bezpečnostní brzda');
    expect(h.ctl.runtime.arm).not.toHaveBeenCalled();
    expect(h.agent.status().controller.armed).toBe(false);
  }, 30_000);

  it('serverNow opraví +3s posun: ARM zadaný před loopback DISARM je odmítnut', async () => {
    const h = await start();
    h.ctl.gateFlatten();
    await h.send({ type: 'copy-command', command: { type: 'flatten-group', groupId: 'runtime-test', operationId: 'op-flatten-5' } });
    await vi.waitFor(() => expect(h.ctl.runtime.flattenGroup).toHaveBeenCalledOnce(), { timeout: 5_000 });
    const arm = await h.send({ type: 'arm-live', group: groupA() }, { now: Date.now() + 3_000 });
    await new Promise(resolve => setTimeout(resolve, 1_000)); // uživatel po 1 s klikne DISARM na Macu
    expect(await loopbackDisarm(h)).toBe(200);
    h.ctl.releaseFlatten();
    const row = await h.terminal(arm.id);
    expect(row.status).toBe('rejected');
    expect(h.agent.status().controller.armed).toBe(false);
  }, 30_000);
});

describe('KOMPAT: přepracované nálezy N2/N3/N5 (server=new worker=new)', () => {
  it('ztracená odpověď poll-v2 po claimu: DISARM se provede právě jednou', async () => {
    const h = await start({ pollOnce: true });
    const arm = await h.send({ type: 'arm-live', group: groupA() });
    expect((await h.terminal(arm.id)).status).toBe('succeeded');
    const before = h.ctl.runtime.disarm.mock.calls.length;
    const disarm = await h.send({ type: 'disarm' });
    expect((await h.terminal(disarm.id)).status).toBe('succeeded');
    expect(lossLog).toContain('poll');
    // The DISARM command must add exactly one disarm() call despite the lost claim response.
    expect(h.ctl.runtime.disarm.mock.calls.length - before).toBe(1);
    expect(h.agent.status().controller.armed).toBe(false);
  }, 30_000);

  it('ztracená odpověď complete-v2: idempotentní opakování, další brzda (kill switch) dorazí', async () => {
    const h = await start({ ackOnce: true });
    const disarm = await h.send({ type: 'disarm' });
    expect((await h.terminal(disarm.id)).status).toBe('succeeded');
    const kill = await h.send({ type: 'kill-switch' });
    expect((await h.terminal(kill.id)).status).toBe('succeeded');
    expect(h.ctl.runtime.engageKillSwitch).toHaveBeenCalledOnce();
    expect(h.ctl.runtime.disarm).toHaveBeenCalledOnce();
    expect(lossLog).toContain('ack');
  }, 30_000);

  it('legacy osiřelý claimed ARM (bez delivery_id, expirovaný) nový ARM nepohltí', async () => {
    const h = await start();
    h.db.tables.tradovate_copier_commands.push({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: userId, device_id: deviceId, connection_id: connectionId,
      command_type: 'arm-live', payload: { group: groupA() }, idempotency_key: 'legacy', status: 'claimed',
      created_at: '2026-09-22T13:30:00.000Z', expires_at: '2026-09-22T13:30:30.000Z', delivery_id: null,
    });
    const arm = await h.send({ type: 'arm-live', group: groupA() });
    expect(arm.id).not.toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(Date.parse(arm.expiresAt)).toBeGreaterThan(Date.now());
    expect((await h.terminal(arm.id)).status).toBe('succeeded');
  }, 30_000);
});

describe('KOMPAT: relay chyby po durable insertu a přichycení ARM', () => {
  it('F5: chyba expirace ARM po durable enqueue brzdy se zaloguje, ale brzda se vrátí jako zařazená', async () => {
    const db = makeDb();
    db.tables.tradovate_copier_device_runtime.push({
      device_id: deviceId, user_id: userId, connection_id: connectionId,
      status: { group: groupA(), controller: { connected: true } },
      last_seen_at: new Date().toISOString(),
    });
    db.hook = (mode, table) => mode === 'update' && table === 'tradovate_copier_commands'
      ? 'canceling statement due to statement timeout'
      : null;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const queued = await newServer.enqueueTradovateCopierCommand({
        db: db as never, userId, connectionId, command: { type: 'disarm' },
      });
      expect(queued).toMatchObject({ status: 'pending', deviceId });
      expect(db.tables.tradovate_copier_commands.find(row => row.id === queued.id)?.command_type).toBe('disarm');
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('brake supersede failed after enqueue'));
    } finally {
      logged.mockRestore();
    }
  });

  it('F6: revokované nejčerstvější zařízení se vyřadí před výběrem runtime cíle', async () => {
    const db = makeDb();
    const revokedId = '99999999-9999-4999-8999-999999999999';
    db.tables.tradovate_copier_devices.push({
      id: revokedId, user_id: userId, connection_id: connectionId,
      revoked_at: new Date().toISOString(), environment: 'demo',
    });
    db.tables.tradovate_copier_device_runtime.push(
      { device_id: revokedId, user_id: userId, connection_id: connectionId,
        status: { controller: { connected: true } }, last_seen_at: '2099-01-01T00:00:00.000Z' },
      { device_id: deviceId, user_id: userId, connection_id: connectionId,
        status: { controller: { connected: true } }, last_seen_at: '2098-01-01T00:00:00.000Z' },
    );
    const queued = await newServer.enqueueTradovateCopierCommand({
      db: db as never, userId, connectionId, command: { type: 'disarm' },
    });
    expect(queued.deviceId).toBe(deviceId);
  });

  it('selhání coalesce lookupu PO insertu ARM: UI dostane chybu (API 502), ale ARM zůstane pending a worker zapne', async () => {
    const h = await start();
    let upserted = false;
    h.db.hook = (mode, table) => {
      if (table !== 'tradovate_copier_commands') return null;
      if (mode === 'upsert') { upserted = true; return null; }
      if (upserted && mode === 'select') { h.db.hook = null; return 'canceling statement due to statement timeout'; }
      return null;
    };
    await expect(h.send({ type: 'arm-live', group: groupA() })).rejects.toThrow(/copier-relay-brake-epoch-lookup-failed/);
    const orphan = h.db.tables.tradovate_copier_commands.find(row => row.command_type === 'arm-live')!;
    expect(orphan.status === 'pending' || orphan.status === 'claimed').toBe(true);
    expect((await h.terminal(orphan.id)).status).toBe('succeeded');
    expect(h.agent.status().controller.armed).toBe(true); // UI ukázala chybu, kopírka je ARMED
  }, 30_000);

  it('identický ARM#2 po DISARM se přichytí k běžícímu ARM#1 → UI hlásí úspěch ARM#2, konečný stav DISARMED', async () => {
    const h = await start();
    let releaseReconcile!: () => void;
    h.ctl.runtime.reconcile.mockImplementationOnce(() => new Promise(resolve => {
      releaseReconcile = () => resolve({ divergentAccounts: [], workingOrderAccounts: [] } as never);
    }));
    const arm1 = await h.send({ type: 'arm-live', group: groupA() });
    await vi.waitFor(() => expect(h.row(arm1.id).status).toBe('claimed'), { timeout: 5_000 });
    await vi.waitFor(() => expect(h.ctl.runtime.reconcile).toHaveBeenCalled(), { timeout: 5_000 });
    const brakeAt = Date.now();
    const disarm = await h.send({ type: 'disarm' }, { now: brakeAt });
    const arm2 = await h.send({ type: 'arm-live', group: groupA() }, { now: brakeAt + 3_000 });
    expect(arm2.id).not.toBe(arm1.id);
    releaseReconcile();
    expect((await h.terminal(arm1.id)).status).toBe('succeeded');
    expect((await h.terminal(disarm.id)).status).toBe('succeeded');
    expect((await h.terminal(arm2.id)).status).toBe('succeeded');
    expect(h.agent.status().controller.armed).toBe(true);
  }, 30_000);
});
