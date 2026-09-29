/* Agent B (čočka brzdy/ARM) — PoC proti d226986. Reálný enqueue + claim_v2/complete_v2
 * (in-memory emulátor), reálný macCopierCommandRelay + recoverable transport, reálný agent. */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedLocalArmDeadline,
  startLocalCopierExecutionAgent,
  type LocalCopierExecutionAgent,
} from '../server/localCopierExecutionAgent';
import { startMacCopierCommandRelay } from '../server/macCopierCommandRelay';
import type { RelayDelivery } from '../server/copierRelayDeliveryStore';
import {
  claimTradovateCopierCommandV2,
  completeTradovateCopierCommandV2,
  enqueueTradovateCopierCommand,
} from '../server/tradovateCopierCommandRelay';
import type { CopierRuntimeController, CopierControllerStatus } from '../services/copierRuntimeController';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import type { LocalCopierAgentCommand } from '../lib/localCopierAgentProtocol';
import { createEmu } from './zzAgentBEmu';

const userId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';

const group = (): CopyGroupConfig => ({
  id: 'runtime-test', name: 'test', enabled: true, leaderAccountId: 11,
  followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});

const controller = (overrides: Partial<CopierControllerStatus> = {}) => {
  let status: CopierControllerStatus = {
    started: true, armed: false, killSwitch: false, shadowMode: true, connected: true,
    reconciliationRequired: false, divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false,
    stuckOperations: [], lastError: null, revision: 1, lastSequence: 0, groupFlat: true, ...overrides,
  };
  const value = {
    arm: vi.fn(({ shadowMode = false }: { shadowMode?: boolean } = {}) => {
      status = { ...status, armed: true, shadowMode, ...(!shadowMode ? { sessionArmedAt: 1 } : {}) };
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
    preflightGroupChange: vi.fn(),
    updateGroup: vi.fn(),
    updateGroupMetadata: vi.fn(),
    flattenAccount: vi.fn(async () => ({ flat: true })),
    flattenFollowerTrade: vi.fn(async () => ({ flat: true })),
    flattenGroup: vi.fn(async () => ({ flat: true })),
    waiveStuckOperation: vi.fn(),
    status: vi.fn(() => status),
    waitForIdle: vi.fn(async () => undefined),
    stop: vi.fn(),
  };
  return value as typeof value & CopierRuntimeController;
};

const gate = () => { let open!: () => void; const p = new Promise<void>(r => { open = r; }); return { p, open }; };

function world(serverSkewMs = 0) {
  const serverClock = () => Date.now() + serverSkewMs;
  const emu = createEmu(serverClock);
  emu.tables.tradovate_copier_devices.push({ id: deviceId, user_id: userId, connection_id: connectionId, revoked_at: null });
  emu.tables.tradovate_copier_device_runtime.push({
    device_id: deviceId, user_id: userId, connection_id: connectionId,
    status: { group: group(), controller: { connected: true } }, last_seen_at: '2099-01-01T00:00:00.000Z',
  });
  const enqueue = (command: LocalCopierAgentCommand, now = serverClock()) =>
    enqueueTradovateCopierCommand({ db: emu.db, userId, connectionId, command, now });
  let loseNextPollResponse = false;
  let loseNextAckResponse = false;
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
    if (body.action === 'poll-v2') {
      const command = await claimTradovateCopierCommandV2({ db: emu.db, deviceId, deliveryId: body.deliveryId });
      if (command && loseNextPollResponse) { loseNextPollResponse = false; throw new Error('copier-relay-request-timeout'); }
      return Response.json({ protocol: 2, command, serverNow: new Date(serverClock()).toISOString() });
    }
    if (body.action === 'complete-v2') {
      const accepted = await completeTradovateCopierCommandV2({ db: emu.db, deviceId, deliveryId: body.deliveryId,
        commandId: body.commandId, result: body.result, error: body.error ?? undefined, status: body.status, revision: body.revision });
      if (loseNextAckResponse) { loseNextAckResponse = false; throw new Error('copier-relay-request-timeout'); }
      return Response.json({ protocol: 2, accepted }, { status: accepted ? 200 : 409 });
    }
    return Response.json({ protocol: 2, accepted: true });
  });
  let saved: RelayDelivery | null = null;
  const startRelay = (agent: LocalCopierExecutionAgent) => startMacCopierCommandRelay({
    apiOrigin: 'https://offline.invalid', agent, authorizationHeader: async () => 'Device x',
    deliveryStore: { read: async () => saved, write: async row => { saved = row; } },
    fetchImpl: fetchImpl as typeof fetch, pollMs: 500,
  });
  const row = (id: string) => emu.tables.tradovate_copier_commands.find(r => r.id === id)!;
  return {
    emu, enqueue, startRelay, row, serverClock,
    loseNextPoll: () => { loseNextPollResponse = true; },
    loseNextAck: () => { loseNextAckResponse = true; },
  };
}

const armCmd = (): LocalCopierAgentCommand => ({ type: 'arm-live', group: group() });
const flattenCmd = (): LocalCopierAgentCommand => ({
  type: 'copy-command', command: { type: 'flatten-group', groupId: 'runtime-test', operationId: `flatten-${randomUUID()}` },
} as never);

describe('AGENT B — re-test N1–N6 proti d226986 (očekává se bezpečný výsledek)', () => {
  let agent: LocalCopierExecutionAgent | null = null;
  let relay: { close(): Promise<void> } | null = null;
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  afterEach(async () => { await relay?.close(); await agent?.close(); relay = null; agent = null; errors.mockClear(); });

  it('S1 (N1): ARM čeká za dlouhým Flattenem, DISARM relayem ho expiruje (superseded-by-brake); výsledek DISARMED', async () => {
    const runtime = controller();
    const flat = gate();
    runtime.flattenGroup.mockImplementationOnce(async () => { await flat.p; return { flat: true }; });
    agent = await startLocalCopierExecutionAgent({
      controller: runtime, group: group(), port: 0,
      prepareGroupAccounts: async () => ({ missingOptional: [] }),
      previewGroupAccounts: async () => ({ missingOptional: [] }),
    });
    const w = world();
    relay = w.startRelay(agent);
    await new Promise(r => setTimeout(r, 10));
    await w.enqueue(flattenCmd());
    await vi.waitFor(() => expect(runtime.flattenGroup).toHaveBeenCalledOnce(), { timeout: 5_000 });
    const arm = await w.enqueue(armCmd());
    await new Promise(r => setTimeout(r, 5));
    const disarm = await w.enqueue({ type: 'disarm' });
    expect(w.row(arm.id)).toMatchObject({ status: 'expired', error: 'superseded-by-brake' });
    flat.open();
    await vi.waitFor(() => expect(w.row(disarm.id).status).toBe('succeeded'), { timeout: 8_000 });
    expect(runtime.arm).not.toHaveBeenCalled();
    expect(runtime.status().armed).toBe(false);
  }, 20_000);

  it('S1b (N1 race enqueue): ARM se starším created_at vložený AŽ po provedené brzdě worker odmítne (brake fence)', async () => {
    const runtime = controller();
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const w = world();
    relay = w.startRelay(agent);
    await new Promise(r => setTimeout(r, 1_500));
    const armStartedAt = w.serverClock() - 700; // pomalý ARM request začal dřív než DISARM (po startu workeru)
    const disarm = await w.enqueue({ type: 'disarm' });
    await vi.waitFor(() => expect(w.row(disarm.id).status).toBe('succeeded'), { timeout: 5_000 });
    const arm = await w.enqueue(armCmd(), armStartedAt);
    await vi.waitFor(() => expect(['rejected', 'expired']).toContain(w.row(arm.id).status), { timeout: 5_000 });
    expect(String(w.row(arm.id).error)).toMatch(/starší než poslední bezpečnostní brzda/);
    expect(runtime.arm).not.toHaveBeenCalled();
  }, 15_000);

  it('S1c (N1 lokální brzda): relay ARM ve frontě, DISARM přes loopback; synchronní hodiny => ARM odmítnut', async () => {
    const runtime = controller();
    const flat = gate();
    runtime.flattenGroup.mockImplementationOnce(async () => { await flat.p; return { flat: true }; });
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const w = world(0);
    relay = w.startRelay(agent);
    await new Promise(r => setTimeout(r, 10));
    await w.enqueue(flattenCmd());
    await vi.waitFor(() => expect(runtime.flattenGroup).toHaveBeenCalledOnce(), { timeout: 5_000 });
    const arm = await w.enqueue(armCmd());
    await new Promise(r => setTimeout(r, 1_000));
    await agent.execute({ type: 'disarm' }); // lokální ingress: createdAt = hodiny workeru
    flat.open();
    await vi.waitFor(() => expect(['rejected', 'succeeded']).toContain(w.row(arm.id).status), { timeout: 8_000 });
    expect(w.row(arm.id).status).toBe('rejected');
    expect(runtime.status().armed).toBe(false);
  }, 20_000);

  it('S2/K1: ARMED(A) + jiná konfigurace provede plnou cestu; shodný ARM je no-op', async () => {
    const runtime = controller({ armed: true, shadowMode: false, sessionArmedAt: 1 });
    agent = await startLocalCopierExecutionAgent({
      controller: runtime, group: group(), port: 0,
      prepareGroupAccounts: async () => ({ missingOptional: [] }),
      previewGroupAccounts: async () => ({ missingOptional: [] }),
    });
    await expect(agent.execute({ type: 'arm-live', group: { ...group(), id: 'group-b', leaderAccountId: 33,
      followers: [{ accountId: 44, mode: 'on-submit', multiplier: 1 }] } })).resolves.toMatchObject({ ok: true });
    await expect(agent.execute({ type: 'arm-live', group: group(),
      accountEligibilityExclusions: [{ accountId: 22, state: 'dll-locked', reason: 'DLL hit dnes' }] }))
      .resolves.toMatchObject({ ok: true });
    await expect(agent.execute({ type: 'arm-live', group: group() })).resolves.toMatchObject({ ok: true });
    expect(runtime.activateGroup).toHaveBeenCalledTimes(2);
    expect(runtime.disarm).toHaveBeenCalled();
  });

  it('S3 (N3): starý claimed ARM (expires v minulosti) nový ARM nepohltí', async () => {
    const w = world();
    w.emu.tables.tradovate_copier_commands.push({ id: randomUUID(), user_id: userId, device_id: deviceId,
      command_type: 'arm-live', payload: {}, idempotency_key: 'legacy', status: 'claimed', delivery_id: null,
      created_at: '2026-09-22T13:30:00.000Z', expires_at: '2026-09-22T13:30:30.000Z' });
    const queued = await w.enqueue(armCmd());
    expect(queued.status).toBe('pending');
    expect(Date.parse(queued.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('S4 (N4): ztracená odpověď poll-v2 s brzdou => obnova stejným deliveryId, DISARM proveden právě jednou', async () => {
    const runtime = controller({ armed: true, shadowMode: false, sessionArmedAt: 1 });
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const w = world();
    w.loseNextPoll();
    relay = w.startRelay(agent);
    await new Promise(r => setTimeout(r, 10));
    const disarm = await w.enqueue({ type: 'disarm' });
    await vi.waitFor(() => expect(w.row(disarm.id).status).toBe('succeeded'), { timeout: 8_000 });
    expect(runtime.disarm).toHaveBeenCalledTimes(1);
    expect(runtime.status().armed).toBe(false);
  }, 15_000);

  it('S5 (N5): ztracená odpověď complete-v2 nezasekne linku; další brzda projde', async () => {
    const runtime = controller({ armed: true, shadowMode: false, sessionArmedAt: 1 });
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const w = world();
    w.loseNextAck();
    relay = w.startRelay(agent);
    await new Promise(r => setTimeout(r, 10));
    const first = await w.enqueue({ type: 'disarm' });
    await vi.waitFor(() => expect(w.row(first.id).status).toBe('succeeded'), { timeout: 8_000 });
    const second = await w.enqueue({ type: 'kill-switch' });
    await vi.waitFor(() => expect(w.row(second.id).status).toBe('succeeded'), { timeout: 8_000 });
    expect(runtime.disarm).toHaveBeenCalledTimes(1);
    expect(runtime.engageKillSwitch).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('S6 (N6): relay ARM s méně než 10 s do expirace se neprovede; lokální deadline hlavička má strop 30 s', async () => {
    const runtime = controller();
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    await expect(agent.execute(armCmd(), { createdAt: Date.now(), deadlineAt: Date.now() + 5_000 - 10_000 }))
      .rejects.toThrow(/deadline/);
    expect(runtime.arm).not.toHaveBeenCalled();
    const received = 1_000_000;
    expect(boundedLocalArmDeadline(String(Number.MAX_SAFE_INTEGER), received)).toBe(received + 30_000);
    expect(boundedLocalArmDeadline(undefined, received)).toBe(received + 30_000);
  });
});

describe('AGENT B — regrese nových nálezů', () => {
  let agent: LocalCopierExecutionAgent | null = null;
  let relay: { close(): Promise<void> } | null = null;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  afterEach(async () => { vi.useRealTimers(); await relay?.close(); await agent?.close(); relay = null; agent = null; });

  it('F1: nový ARM po DISARM se nepřichytí ke staršímu claimed ARM', async () => {
    const runtime = controller();
    const slow = gate();
    runtime.reconcile.mockImplementationOnce(async () => { await slow.p; return { divergentAccounts: [], workingOrderAccounts: [] }; });
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const w = world();
    relay = w.startRelay(agent);
    await new Promise(r => setTimeout(r, 10));
    const armA = await w.enqueue(armCmd());
    await vi.waitFor(() => expect(runtime.reconcile).toHaveBeenCalled(), { timeout: 5_000 }); // A claimed, běží
    const brakeAt = w.serverClock();
    const disarm = await w.enqueue({ type: 'disarm' }, brakeAt);
    const armC = await w.enqueue(armCmd(), brakeAt + 3_000);
    expect(armC.id).not.toBe(armA.id);
    slow.open();
    await vi.waitFor(() => expect(w.row(disarm.id).status).toBe('succeeded'), { timeout: 8_000 });
    await vi.waitFor(() => expect(w.row(armC.id).status).toBe('succeeded'), { timeout: 8_000 });
    expect(runtime.status().armed).toBe(true);
  }, 20_000);

  it('F2: serverNow + rezerva odmítne starší relay ARM po lokálním DISARM při +3s posunu', async () => {
    const runtime = controller();
    const flat = gate();
    runtime.flattenGroup.mockImplementationOnce(async () => { await flat.p; return { flat: true }; });
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const w = world(3_000); // serverové hodiny +3 s proti workeru
    relay = w.startRelay(agent);
    await new Promise(r => setTimeout(r, 10));
    await w.enqueue(flattenCmd());
    await vi.waitFor(() => expect(runtime.flattenGroup).toHaveBeenCalledOnce(), { timeout: 5_000 });
    const arm = await w.enqueue(armCmd());        // telefon: ARM (reálně DŘÍV)
    await new Promise(r => setTimeout(r, 1_000));
    await agent.execute({ type: 'disarm' });      // Mac web: DISARM přes loopback (reálně POZDĚJI)
    flat.open();
    await vi.waitFor(() => expect(w.row(arm.id).status).toBe('rejected'), { timeout: 8_000 });
    expect(runtime.arm).not.toHaveBeenCalled();
    expect(runtime.status().armed).toBe(false);
  }, 20_000);

  it('F3: denní lock doručený po konci své session další session nezamkne', async () => {
    const runtime = controller({ armed: true, shadowMode: false, sessionArmedAt: 1 });
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T22:04:00.000Z')); // 17:04 CDT, lock kliknut 16:57 CDT
    await expect(agent.execute({ type: 'lock-until-session-end', reason: 'Ruční zámek dne z AlphaTrade LIVE UI' },
      { createdAt: Date.parse('2026-09-29T21:57:00.000Z') })).rejects.toThrow(/session skončila/);
    expect(runtime.lockUntil).not.toHaveBeenCalled();
  });
});
