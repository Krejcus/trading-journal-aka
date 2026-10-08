import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  armNeedsSelfCheck,
  startLocalCopierExecutionAgent,
  type LocalCopierExecutionAgent,
} from '../server/localCopierExecutionAgent';
import type { CopierControllerStatus, CopierRuntimeController } from '../services/copierRuntimeController';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

// Etapa 1 (Filip 6. 10. 2026): Zapnout si samo provede Kontrolu pozic a
// historie nezablokuje; po výpadku spojení se kopírka zapne sama, když
// kontrola u brokera vyjde čistě.

const group = (): CopyGroupConfig => ({
  id: 'arm-self-check', name: 'test', enabled: true, leaderAccountId: 11,
  followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});

type Check = { divergentAccounts: number[]; workingOrderAccounts: number[]; authoritativelyClean: boolean; missingAccounts: number[] };
const clean: Check = { divergentAccounts: [], workingOrderAccounts: [], authoritativelyClean: true, missingAccounts: [] };

const controller = (overrides: Partial<CopierControllerStatus> = {}) => {
  let status: CopierControllerStatus = {
    started: true, armed: false, killSwitch: false, shadowMode: false, connected: true,
    reconciliationRequired: false, divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false,
    stuckOperations: [], lastError: null, revision: 1, lastSequence: 0, groupFlat: true,
    armPreparation: { state: 'ready', verifiedAt: 1, reason: null, blockedBy: null, manualRecoveryRequired: false },
    ...overrides,
  };
  let nextCheck: Check = clean;
  const value = {
    setStatus: (patch: Partial<CopierControllerStatus>) => { status = { ...status, ...patch }; },
    setNextCheck: (check: Check) => { nextCheck = check; },
    arm: vi.fn(() => { status = { ...status, armed: true, shadowMode: false, sessionArmedAt: Date.now() }; }),
    disarm: vi.fn(() => { status = { ...status, armed: false }; }),
    engageKillSwitch: vi.fn(() => { status = { ...status, armed: false, killSwitch: true }; }),
    applyAccountEligibilityExclusions: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => {
      const check = nextCheck;
      if (check.authoritativelyClean) {
        status = {
          ...status, reconciliationRequired: false, lastError: null,
          armPreparation: { state: 'ready', verifiedAt: Date.now(), reason: null, blockedBy: null, manualRecoveryRequired: false },
        };
      }
      return check;
    }),
    prepareArm: vi.fn(async () => {
      if (status.armPreparation?.state !== 'ready') throw new Error(`ARM blokován: ${status.armPreparation?.reason}`);
    }),
    preflightGroupChange: vi.fn(),
    updateGroup: vi.fn(),
    updateGroupMetadata: vi.fn(),
    updateGroupRiskInPlace: vi.fn(async () => undefined),
    reconfigureGroup: vi.fn(async () => undefined),
    activateGroup: vi.fn(async () => undefined),
    status: vi.fn(() => status),
    waitForIdle: vi.fn(async () => undefined),
    stop: vi.fn(),
    beginShutdown: vi.fn(async () => undefined),
  };
  return value as typeof value & CopierRuntimeController;
};

const incident = {
  reconciliationRequired: true,
  lastError: 'Copier fail-closed: nevysvětlená divergence',
  armPreparation: {
    state: 'blocked' as const, verifiedAt: null, reason: 'Po incidentu je potřeba ruční Kontrola pozic',
    blockedBy: 'incident' as const, manualRecoveryRequired: true,
  },
};

describe('etapa 1 — zapnutí s vlastní kontrolou', () => {
  let running: LocalCopierExecutionAgent | null = null;
  afterEach(async () => { await running?.close(); running = null; });

  it('po incidentu Zapnout samo provede Kontrolu pozic a při čistém stavu zapne', async () => {
    const runtime = controller(incident);
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmAfterTransport: false });
    await running.execute({ type: 'arm-live' });
    expect(runtime.reconcile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runtime.reconcile).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(runtime.arm).mock.invocationCallOrder[0]);
    expect(runtime.status().armed).toBe(true);
  });

  it('aktuální nesoulad zapnutí zastaví a jmenuje účet', async () => {
    const runtime = controller(incident);
    runtime.setNextCheck({ ...clean, authoritativelyClean: false, divergentAccounts: [22] });
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmAfterTransport: false });
    await expect(running.execute({ type: 'arm-live' })).rejects.toThrow(/pozice nesedí s leaderem na účtech 22/);
    expect(runtime.arm).not.toHaveBeenCalled();
  });

  it('čistý připravený stav nespouští zbytečnou kontrolu navíc', () => {
    expect(armNeedsSelfCheck({
      reconciliationRequired: false,
      armPreparation: { state: 'ready', blockedBy: null, manualRecoveryRequired: false },
    })).toBe(false);
    expect(armNeedsSelfCheck({ reconciliationRequired: true })).toBe(true);
  });
});

describe('etapa 1 — automatické zapnutí po výpadku spojení', () => {
  let running: LocalCopierExecutionAgent | null = null;
  afterEach(async () => { await running?.close(); running = null; });

  const transportDisarm = (runtime: ReturnType<typeof controller>) => runtime.setStatus({
    armed: false, connected: false, reconciliationRequired: true,
    lastDisarm: {
      at: Date.now() + 1, trigger: 'transport', title: 'Spojení k brokerovi bylo přerušeno',
      detail: 'Spojení k brokerovi bylo přerušeno', copiesOutcome: 'flat',
    } as CopierControllerStatus['lastDisarm'],
  });

  it('po obnovení spojení a čisté kontrole se zapne samo', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmTickMs: 20, autoRearmGraceMs: 0, autoRearmAfterTransport: true });
    running.setRemoteQueueProbe?.(() => Date.now());
    await running.execute({ type: 'arm-live' });
    expect(runtime.arm).toHaveBeenCalledTimes(1);
    transportDisarm(runtime);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(runtime.arm).toHaveBeenCalledTimes(1);
    runtime.setStatus({ connected: true });
    await vi.waitFor(() => expect(runtime.arm).toHaveBeenCalledTimes(2), { timeout: 1_000 });
    expect(runtime.reconcile).toHaveBeenCalled();
    expect(runtime.status().armed).toBe(true);
  });

  it('nečistá kontrola po obnovení nechá kopírku vypnutou', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmTickMs: 20, autoRearmGraceMs: 0, autoRearmAfterTransport: true });
    running.setRemoteQueueProbe?.(() => Date.now());
    await running.execute({ type: 'arm-live' });
    transportDisarm(runtime);
    runtime.setNextCheck({ ...clean, authoritativelyClean: false, workingOrderAccounts: [22] });
    runtime.setStatus({ connected: true });
    await vi.waitFor(() => expect(runtime.reconcile).toHaveBeenCalled(), { timeout: 1_000 });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(runtime.arm).toHaveBeenCalledTimes(1);
    expect(runtime.status().armed).toBe(false);
  });

  it('ruční vypnutí po výpadku automatické zapnutí zruší', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmTickMs: 20, autoRearmGraceMs: 0, autoRearmAfterTransport: true });
    running.setRemoteQueueProbe?.(() => Date.now());
    await running.execute({ type: 'arm-live' });
    transportDisarm(runtime);
    await new Promise(resolve => setTimeout(resolve, 60));
    await running.execute({ type: 'disarm' });
    runtime.setStatus({ connected: true });
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(runtime.arm).toHaveBeenCalledTimes(1);
  });

  it('vypnutí hned po výpadku, ještě před prvním tickem, návrat zruší', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmTickMs: 50, autoRearmGraceMs: 0, autoRearmAfterTransport: true });
    running.setRemoteQueueProbe?.(() => Date.now());
    await running.execute({ type: 'arm-live' });
    transportDisarm(runtime);
    await running.execute({ type: 'disarm' });
    runtime.setStatus({ connected: true });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(runtime.arm).toHaveBeenCalledTimes(1);
  });

  it('změna skupiny během výpadku návrat zruší (zapnula by se jiná konfigurace)', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmTickMs: 20, autoRearmGraceMs: 0, autoRearmAfterTransport: true });
    running.setRemoteQueueProbe?.(() => Date.now());
    await running.execute({ type: 'arm-live' });
    transportDisarm(runtime);
    await running.execute({ type: 'copy-command', command: { type: 'update-group', group: {
      ...group(), followers: [{ accountId: 22, mode: 'on-submit', multiplier: 2 }],
    } } });
    expect(running.status().group.followers[0].multiplier).toBe(2);
    runtime.setStatus({ connected: true });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(runtime.arm).toHaveBeenCalledTimes(1);
  });

  it('nový incident po výpadku automatický návrat zastaví a nesmaže ho', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmTickMs: 20, autoRearmGraceMs: 0, autoRearmAfterTransport: true });
    running.setRemoteQueueProbe?.(() => Date.now());
    await running.execute({ type: 'arm-live' });
    transportDisarm(runtime);
    runtime.setStatus({
      connected: true,
      lastError: 'Copier fail-closed: store CAS',
      armPreparation: { state: 'blocked', verifiedAt: null, reason: 'incident', blockedBy: 'incident', manualRecoveryRequired: true },
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(runtime.arm).toHaveBeenCalledTimes(1);
    expect(runtime.reconcile).not.toHaveBeenCalled();
  });

  it('ruční vypnutí (ne výpadek) se nikdy samo nezapne', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmTickMs: 20, autoRearmGraceMs: 0, autoRearmAfterTransport: true });
    running.setRemoteQueueProbe?.(() => Date.now());
    await running.execute({ type: 'arm-live' });
    runtime.setStatus({
      armed: false,
      lastDisarm: { at: Date.now() + 1, trigger: 'manual', title: 'ručně', detail: 'ručně', copiesOutcome: 'flat' } as CopierControllerStatus['lastDisarm'],
    });
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(runtime.arm).toHaveBeenCalledTimes(1);
  });

  it('čekající brzda z telefonu: bez prázdného vyzvednutí fronty po obnovení se nezapne', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmTickMs: 20, autoRearmGraceMs: 0, autoRearmAfterTransport: true });
    let lastEmptyPoll = Date.now();
    running.setRemoteQueueProbe?.(() => lastEmptyPoll);
    await running.execute({ type: 'arm-live' });
    transportDisarm(runtime);
    runtime.setStatus({ connected: true });
    // Relay po obnovení ještě neodbavilo frontu (brzda může čekat).
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(runtime.arm).toHaveBeenCalledTimes(1);
    // Relay dokončí prázdné vyzvednutí až teď → teprve pak se smí zapnout.
    lastEmptyPoll = Date.now() + 5;
    await vi.waitFor(() => expect(runtime.arm).toHaveBeenCalledTimes(2), { timeout: 1_000 });
  });

  it('bez napojeného relay se po výpadku nikdy samo nezapne', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmTickMs: 20, autoRearmGraceMs: 0, autoRearmAfterTransport: true });
    await running.execute({ type: 'arm-live' });
    transportDisarm(runtime);
    runtime.setStatus({ connected: true });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(runtime.arm).toHaveBeenCalledTimes(1);
  });

  it('ve výchozím nastavení se po výpadku samo nezapne', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmTickMs: 20 });
    running.setRemoteQueueProbe?.(() => Date.now());
    await running.execute({ type: 'arm-live' });
    transportDisarm(runtime);
    runtime.setStatus({ connected: true });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(runtime.arm).toHaveBeenCalledTimes(1);
  });
});

describe('etapa 1 — zablokovaná epocha po incidentu', () => {
  it('po čisté Kontrole pozic se všemi účty flat zablokovaná epocha zapnutí nebrzdí (záznam zůstává)', async () => {
    const { createMemoryCopierStore, emptySnapshot } = await import('../services/copierStore');
    const { createMockBroker } = await import('../services/mockBroker');
    const { createLeaderFlatEpoch } = await import('../services/copierLeaderFlatGuard');
    const { bootstrapCopierRuntime } = await import('../services/copierRuntimeController');
    const runtimeGroup: CopyGroupConfig = {
      id: 'epoch-blocked', name: 'Hlavní', enabled: true, leaderAccountId: 11,
      followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }],
    };
    const snapshot = emptySnapshot();
    snapshot.safety = { ...snapshot.safety!, leaderExposureEpochs: [{
      ...createLeaderFlatEpoch({ id: 'incident-epoch', groupId: runtimeGroup.id, leaderAccountId: 11, symbol: 'MNQZ6',
        openedAt: 1, leaderNet: 6, followers: [{ accountId: 22, replicationModeAtOpen: 'on-submit', eligibleAtOpen: true,
          copyLineage: 'confirmed', confirmedNetQuantity: 1 }] }),
      phase: 'blocked', terminalAt: 2, terminalReason: 'neověřený zbytek',
    }] };
    const store = createMemoryCopierStore(snapshot);
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    let time = 100;
    const runtime = await bootstrapCopierRuntime({ broker, store, group: runtimeGroup, clock: () => ++time });
    try {
      broker.setConnected(true);
      await runtime.waitForIdle();
      const result = await runtime.reconcile();
      expect(result.authoritativelyClean).toBe(true);
      const epochs = (await store.load()).safety!.leaderExposureEpochs ?? [];
      // Unresolved záznam se nemaže ani nepřepisuje (rozhodnutí 10. 9.).
      expect(epochs.find(epoch => epoch.id === 'incident-epoch')?.phase).toBe('blocked');
      await runtime.prepareArm?.();
      runtime.arm({ shadowMode: false, ttlMs: 60_000, requirePreparation: true });
      await runtime.waitForIdle();
      expect(runtime.status().armed).toBe(true);
    } finally {
      runtime.stop();
    }
  });
});
