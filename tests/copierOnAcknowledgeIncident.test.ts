// 8. 10. 2026: tlačítko Kontrola pozic zmizelo. Zapnout si kontrolu dělá samo,
// durable incident ale smaže jen s výslovným potvrzením (INV-DEFAULT-03).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLocalCopierExecutionAgent, type LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';
import { bootstrapCopierRuntime, type CopierControllerStatus, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { copierArmRejection } from '../lib/copierArmPreparation';

const group = (): CopyGroupConfig => ({
  id: 'g', name: 'G', enabled: true, leaderAccountId: 11,
  followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});
type Check = { divergentAccounts: number[]; workingOrderAccounts: number[]; authoritativelyClean: boolean; missingAccounts: number[] };
const clean: Check = { divergentAccounts: [], workingOrderAccounts: [], authoritativelyClean: true, missingAccounts: [] };
const INCIDENT = { id: 'incident-1', at: 1_791_000_000_000, reason: 'leader-flat guard: follower 22 nesedí' };

const mockController = (nextCheck: Check = clean) => {
  let status: CopierControllerStatus = {
    started: true, armed: false, killSwitch: false, shadowMode: false, connected: true,
    reconciliationRequired: true, divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false,
    stuckOperations: [], lastError: INCIDENT.reason, revision: 1, lastSequence: 0, groupFlat: true,
    manualRecovery: { ...INCIDENT },
    armPreparation: { state: 'blocked', verifiedAt: null, reason: 'Po incidentu je potřeba ruční Kontrola pozic', blockedBy: 'incident', manualRecoveryRequired: true },
  };
  const value = {
    arm: vi.fn(() => { status = { ...status, armed: true, shadowMode: false, sessionArmedAt: Date.now() }; }),
    disarm: vi.fn(() => { status = { ...status, armed: false }; }),
    engageKillSwitch: vi.fn(),
    applyAccountEligibilityExclusions: vi.fn(async () => undefined),
    reconcile: vi.fn(async (options?: { acknowledgedIncidentId?: string; internal?: true }) => {
      if (nextCheck.authoritativelyClean && !options?.internal) {
        status = {
          ...status, reconciliationRequired: false, lastError: null, manualRecovery: null,
          armPreparation: { state: 'ready', verifiedAt: Date.now(), reason: null, blockedBy: null, manualRecoveryRequired: false },
        };
      }
      return nextCheck;
    }),
    prepareArm: vi.fn(async () => {
      if (status.armPreparation?.state !== 'ready') throw new Error(`ARM blokován: ${status.armPreparation?.reason}`);
    }),
    preflightGroupChange: vi.fn(), updateGroup: vi.fn(), updateGroupMetadata: vi.fn(),
    updateGroupRiskInPlace: vi.fn(async () => undefined), reconfigureGroup: vi.fn(async () => undefined),
    activateGroup: vi.fn(async () => undefined), status: vi.fn(() => status),
    waitForIdle: vi.fn(async () => undefined), stop: vi.fn(), beginShutdown: vi.fn(async () => undefined),
  };
  return value as typeof value & CopierRuntimeController;
};

describe('Zapnout po incidentu', () => {
  let running: LocalCopierExecutionAgent | null = null;
  afterEach(async () => { await running?.close(); running = null; });

  it('bez potvrzení odmítne, nic nezkontroluje ani nezapne a incident trvá', async () => {
    const runtime = mockController();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmAfterTransport: false });
    const error = await running.execute({ type: 'arm-live' }).catch(reason => reason as Error);
    expect(String(error)).toContain(`[ack-incident:${INCIDENT.id}]`);
    expect(copierArmRejection(error)).toContain('Mezitím vznikl incident: leader-flat guard');
    expect(copierArmRejection(error)).not.toContain('starší appka');
    expect(runtime.reconcile).not.toHaveBeenCalled();
    expect(runtime.arm).not.toHaveBeenCalled();
    expect(runtime.status().manualRecovery).toEqual(INCIDENT);
  });

  it('potvrzení jiného (staršího) incidentu nestačí', async () => {
    const runtime = mockController();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmAfterTransport: false });
    await expect(running.execute({ type: 'arm-live', acknowledgeIncidentId: 'incident-0' })).rejects.toThrow('[ack-incident:');
    expect(runtime.arm).not.toHaveBeenCalled();
  });

  it('s potvrzením: kontrola vázaná na tento incident, čistá → zapne', async () => {
    const runtime = mockController();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmAfterTransport: false });
    await running.execute({ type: 'arm-live', acknowledgeIncidentId: INCIDENT.id });
    expect(runtime.reconcile).toHaveBeenCalledWith({ acknowledgedIncidentId: INCIDENT.id });
    expect(runtime.status().armed).toBe(true);
  });

  it('s potvrzením, ale nečistá kontrola → nezapne, vypíše účty, incident trvá', async () => {
    const runtime = mockController({ ...clean, authoritativelyClean: false, divergentAccounts: [22] });
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmAfterTransport: false });
    await expect(running.execute({ type: 'arm-live', acknowledgeIncidentId: INCIDENT.id })).rejects.toThrow(/účtech 22/);
    expect(runtime.arm).not.toHaveBeenCalled();
    expect(runtime.status().manualRecovery).toEqual(INCIDENT);
  });

  it('SHADOW incident nesmaže (jen interní kontrola)', async () => {
    const runtime = mockController();
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: group(), port: 0, autoRearmAfterTransport: false,
      prepareGroupAccounts: async () => ({ missingOptional: [] }),
    });
    await running.execute({ type: 'shadow' }).catch(() => undefined);
    expect(runtime.reconcile).toHaveBeenCalledWith({ internal: true });
    expect(runtime.status().manualRecovery).toEqual(INCIDENT);
  });
});

describe('controller: kdo smí durable incident smazat', () => {
  const boot = async () => {
    let now = 1_800_000_000_000;
    const snapshot = emptySnapshot();
    snapshot.safety = { ...snapshot.safety!, manualRecoveryRequired: { ...INCIDENT } };
    const store = createMemoryCopierStore(snapshot);
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const audit: { kind: string; reason?: string }[] = [];
    const controller = await bootstrapCopierRuntime({
      broker, store, group: group(), clock: () => ++now, onAudit: entries => audit.push(...entries),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    return { controller, store, audit };
  };

  it('kontrola bez potvrzení (CLI / lokální reconcile) incident ani chybu nesmaže', async () => {
    const { controller, store } = await boot();
    try {
      const result = await controller.reconcile();
      expect(result.authoritativelyClean).toBe(true);
      expect(controller.status().manualRecovery).toEqual(INCIDENT);
      expect(controller.status().lastError).toContain(INCIDENT.reason);
      expect((await store.load()).safety?.manualRecoveryRequired).toEqual(INCIDENT);
    } finally {
      controller.stop();
    }
  });

  it('starší marker bez ID dostane deterministické ID platné i po restartu', async () => {
    let now = 1_800_000_000_000;
    const snapshot = emptySnapshot();
    snapshot.safety = { ...snapshot.safety!, manualRecoveryRequired: { at: 42, reason: 'starý' } };
    const controller = await bootstrapCopierRuntime({
      broker: createMockBroker({ behavior: () => ({ kind: 'working' }) }),
      store: createMemoryCopierStore(snapshot), group: group(), clock: () => ++now,
    });
    try {
      expect(controller.status().manualRecovery).toEqual({ id: 'legacy-42', at: 42, reason: 'starý' });
    } finally {
      controller.stop();
    }
  });

  it('poškozený marker: potvrzení ho durable smaže a teprve pak i z paměti (stabilní ID)', async () => {
    let now = 1_800_000_000_000;
    const snapshot = emptySnapshot();
    snapshot.safety = { ...snapshot.safety!, manualRecoveryRequired: { at: 0, reason: '' } };
    const store = createMemoryCopierStore(snapshot);
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({ broker, store, group: group(), clock: () => ++now });
    broker.setConnected(true);
    await controller.waitForIdle();
    try {
      const incident = controller.status().manualRecovery!;
      expect(incident.id).toBe('invalid-marker');
      await controller.reconcile({ acknowledgedIncidentId: incident.id });
      const saved = (await store.load()).safety;
      expect(saved?.manualRecoveryRequired).toBeUndefined();
      expect(saved?.lastIncidentAcknowledgement).toMatchObject({ id: 'invalid-marker' });
      expect(controller.status().manualRecovery).toBeNull();
    } finally {
      controller.stop();
    }
  });

  it('interní kontrola (SHADOW / kompatibilní ARM) incident ani chybu nesmaže', async () => {
    const { controller, store } = await boot();
    try {
      const result = await controller.reconcile({ internal: true });
      expect(result.authoritativelyClean).toBe(true);
      expect(controller.status().manualRecovery).toEqual(INCIDENT);
      expect(controller.status().lastError).toContain(INCIDENT.reason);
      expect((await store.load()).safety?.manualRecoveryRequired).toEqual(INCIDENT);
    } finally {
      controller.stop();
    }
  });

  it('potvrzený incident čistá kontrola smaže a zapíše audit „potvrdil uživatel přes Zapnout“', async () => {
    const { controller, store, audit } = await boot();
    try {
      await controller.reconcile({ acknowledgedIncidentId: INCIDENT.id });
      expect(controller.status().manualRecovery).toBeNull();
      const saved = (await store.load()).safety;
      expect(saved?.manualRecoveryRequired).toBeUndefined();
      // Crash-safe audit: potvrzení je ve stejném durable zápisu jako smazání.
      expect(saved?.lastIncidentAcknowledgement).toMatchObject({ id: INCIDENT.id, reason: INCIDENT.reason, via: 'arm' });
      expect(audit.some(entry => entry.kind === 'recovered' && entry.reason?.includes('potvrdil uživatel přes Zapnout'))).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it('potvrzení jiného incidentu kontrolu odmítne a nic nesmaže', async () => {
    const { controller, store } = await boot();
    try {
      await expect(controller.reconcile({ acknowledgedIncidentId: 'jiny-incident' })).rejects.toThrow('Incident se mezitím změnil');
      expect((await store.load()).safety?.manualRecoveryRequired).toEqual(INCIDENT);
    } finally {
      controller.stop();
    }
  });

  it('restart před dokončením kontroly incident zachová (durable)', async () => {
    const first = await boot();
    first.controller.stop();
    const snapshot = await first.store.load();
    expect(snapshot.safety?.manualRecoveryRequired).toEqual(INCIDENT);
    let now = 1_900_000_000_000;
    const again = await bootstrapCopierRuntime({
      broker: createMockBroker({ behavior: () => ({ kind: 'working' }) }),
      store: createMemoryCopierStore(snapshot), group: group(), clock: () => ++now,
    });
    try {
      expect(again.status().manualRecovery).toEqual(INCIDENT);
    } finally {
      again.stop();
    }
  });
});
