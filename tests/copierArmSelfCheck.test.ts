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

describe('automatické pokračování po výpadku spojení (10. 10. 2026)', () => {
  let running: LocalCopierExecutionAgent | null = null;
  afterEach(async () => { await running?.close(); running = null; });

  const realSetup = async (agentOptions: Record<string, unknown> = { autoRearmAfterTransport: true }) => {
    const { createMemoryCopierStore } = await import('../services/copierStore');
    const { createMockBroker } = await import('../services/mockBroker');
    const { bootstrapCopierRuntime } = await import('../services/copierRuntimeController');
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const runtime = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group: group() });
    broker.setConnected(true);
    await runtime.waitForIdle();
    await runtime.reconcile();
    const reconcileSpy = vi.spyOn(runtime, 'reconcile');
    const armSpy = vi.spyOn(runtime, 'arm');
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: group(), port: 0, autoRearmTickMs: 15, autoRearmGraceMs: 0, ...agentOptions,
    });
    const admit = vi.fn(async (_since: number) => ({ admitted: true, reason: null as string | null }));
    return { broker, runtime, reconcileSpy, armSpy, admit };
  };
  const outageAndReturn = async (broker: { setConnected(next: boolean): void }) => {
    await new Promise(resolve => setTimeout(resolve, 5));
    broker.setConnected(false);
    await new Promise(resolve => setTimeout(resolve, 40));
    broker.setConnected(true);
  };

  it('flat výpadek: po čisté kontrole jeden pokus, bez reconcile(), pojistka s časem ručního ON', async () => {
    const h = await realSetup();
    running!.setRemoteQueueProbe?.(() => Date.now());
    running!.setAutoResumeAdmission?.(h.admit);
    expect(running!.status().capabilities).toContain('transport-auto-resume-v1');
    await running!.execute({ type: 'arm-live' });
    expect(h.runtime.status().armed).toBe(true);
    h.reconcileSpy.mockClear();
    await outageAndReturn(h.broker);
    await vi.waitFor(() => expect(h.runtime.status().armed).toBe(true), { timeout: 2_000 });
    expect(h.runtime.status().transportResume?.phase).toBe('resumed');
    expect(h.admit).toHaveBeenCalledTimes(1);
    expect(h.reconcileSpy).not.toHaveBeenCalled();
    expect(h.armSpy.mock.calls.at(-1)?.[0]).toMatchObject({ autoResume: expect.any(Object), requirePreparation: true });
  });

  it('server pojistku odmítne (brzda z telefonu) → zůstane vypnutá a důvod je vidět', async () => {
    const h = await realSetup();
    running!.setRemoteQueueProbe?.(() => Date.now());
    h.admit.mockResolvedValue({ admitted: false, reason: 'od posledního zapnutí přišla brzda' });
    running!.setAutoResumeAdmission?.(h.admit);
    await running!.execute({ type: 'arm-live' });
    await outageAndReturn(h.broker);
    await vi.waitFor(() => expect(h.runtime.status().transportResume?.phase).toBe('declined'), { timeout: 2_000 });
    expect(h.runtime.status().transportResume?.reason).toContain('přišla brzda');
    expect(h.runtime.status().armed).toBe(false);
  });

  it('brzda během výpadku, chybějící pojistka i výchozí nastavení = nikdy samo', async () => {
    const braked = await realSetup();
    running!.setRemoteQueueProbe?.(() => Date.now());
    running!.setAutoResumeAdmission?.(braked.admit);
    await running!.execute({ type: 'arm-live' });
    await new Promise(resolve => setTimeout(resolve, 5));
    braked.broker.setConnected(false);
    await new Promise(resolve => setTimeout(resolve, 30));
    await running!.execute({ type: 'disarm' });
    braked.broker.setConnected(true);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(braked.runtime.status().armed).toBe(false);
    expect(braked.admit).not.toHaveBeenCalled();
    await running!.close(); running = null;

    const noFence = await realSetup();
    running!.setRemoteQueueProbe?.(() => Date.now());
    expect(running!.status().capabilities).not.toContain('transport-auto-resume-v1');
    await running!.execute({ type: 'arm-live' });
    await outageAndReturn(noFence.broker);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(noFence.runtime.status().armed).toBe(false);
    await running!.close(); running = null;

    const byDefault = await realSetup({});
    running!.setRemoteQueueProbe?.(() => Date.now());
    running!.setAutoResumeAdmission?.(byDefault.admit);
    expect(running!.status().capabilities).not.toContain('transport-auto-resume-v1');
    await running!.execute({ type: 'arm-live' });
    await outageAndReturn(byDefault.broker);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(byDefault.runtime.status().armed).toBe(false);
    expect(byDefault.admit).not.toHaveBeenCalled();
  });

  it('čeká na prázdné vyzvednutí fronty relay po obnovení spojení', async () => {
    const h = await realSetup();
    let lastEmptyPoll = Date.now();
    running!.setRemoteQueueProbe?.(() => lastEmptyPoll);
    running!.setAutoResumeAdmission?.(h.admit);
    await running!.execute({ type: 'arm-live' });
    await outageAndReturn(h.broker);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(h.runtime.status().armed).toBe(false);
    lastEmptyPoll = Date.now() + 5;
    await vi.waitFor(() => expect(h.runtime.status().armed).toBe(true), { timeout: 2_000 });
  });

  it('strop: nejvýš 2 automatická pokračování na jedno ruční zapnutí', async () => {
    const h = await realSetup();
    running!.setRemoteQueueProbe?.(() => Date.now() + 60_000);
    running!.setAutoResumeAdmission?.(h.admit);
    await running!.execute({ type: 'arm-live' });
    for (let round = 0; round < 2; round += 1) {
      await outageAndReturn(h.broker);
      await vi.waitFor(() => expect(h.runtime.status().armed).toBe(true), { timeout: 2_000 });
    }
    await outageAndReturn(h.broker);
    await vi.waitFor(() => expect(h.runtime.status().transportResume?.phase).toBe('declined'), { timeout: 2_000 });
    expect(h.runtime.status().transportResume?.reason).toContain('zapni ji ručně');
    expect(h.runtime.status().armed).toBe(false);
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
