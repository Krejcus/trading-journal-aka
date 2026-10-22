// 21.–22. 10. 2026 (produkce): druhý incident se zapsal do paměti, ale do
// durable stavu ho přepsal pozdější zápis se zastaralou kopií bezpečnostního
// stavu (persistSafety ukládal celou kopii načtenou při volání). UI pak
// potvrzovalo jiný incident, než byl uložený, a Zapnout selhávalo dokola.
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore, type CopierStore } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const group = (): CopyGroupConfig => ({
  id: 'lost-update', name: 'Lost update', enabled: true, leaderAccountId: 11,
  followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});

/** Store, jehož commity jde podržet — simuluje pomalý disk mezi zápisy. */
const holdableStore = () => {
  const inner = createMemoryCopierStore();
  let gate: Promise<void> | null = null;
  let release: () => void = () => undefined;
  const store: CopierStore = {
    ...inner,
    load: () => inner.load(),
    commit: async (snapshot, revision) => {
      if (gate) await gate;
      return inner.commit(snapshot, revision);
    },
  };
  return {
    store,
    hold: () => { gate = new Promise<void>(resolve => { release = resolve; }); },
    release: () => { const done = release; gate = null; done(); },
  };
};

describe('incident se nesmí ztratit pozdějším zápisem bezpečnostního stavu', () => {
  let runtime: CopierRuntimeController | null = null;
  afterEach(() => { runtime?.stop(); runtime = null; });

  it('zápis epochy leadera za čekajícím incidentem incident nepřepíše', async () => {
    let now = Date.now();
    const holdable = holdableStore();
    const broker = createMockBroker({ clock: () => now, behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [] });
    runtime = await bootstrapCopierRuntime({ broker, store: holdable.store, group: group(), clock: () => now });
    broker.setConnected(true);
    await runtime.waitForIdle();
    await runtime.reconcile();
    runtime.arm({ shadowMode: false });
    expect(runtime.status().armed).toBe(true);

    // Leader otevře pozici → durable epocha.
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'lead-1', tag: '', brokerOrderId: 'lead-order', accountId: 11,
      symbol: 'MNQZ6', side: 'Buy', quantity: 1, price: 30_000, filledAt: now,
    } });
    broker.emitEvent({ type: 'position', position: { accountId: 11, symbol: 'MNQZ6', netQuantity: 1 } });
    await runtime.waitForIdle();
    const epochsBefore = (await holdable.store.load()).safety?.leaderExposureEpochs ?? [];

    // Incident se zapisuje pomalu; mezitím leader zavře a epocha se aktualizuje.
    holdable.hold();
    now += 1_000;
    runtime.reportHostSleep({ unresponsiveSince: now - 1_000, detectedAt: now, sleepDurationMs: 1_000 });
    const incident = runtime.status().manualRecovery!;
    expect(incident).not.toBeNull();
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'lead-2', tag: '', brokerOrderId: 'lead-exit', accountId: 11,
      symbol: 'MNQZ6', side: 'Sell', quantity: 1, price: 30_010, filledAt: now,
    } });
    broker.emitEvent({ type: 'position', position: { accountId: 11, symbol: 'MNQZ6', netQuantity: 0 } });
    await new Promise(resolve => setTimeout(resolve, 20));
    holdable.release();
    await runtime.waitForIdle();
    await new Promise(resolve => setTimeout(resolve, 20));
    await runtime.waitForIdle();

    const safety = (await holdable.store.load()).safety;
    expect(epochsBefore.length).toBeGreaterThan(0);
    // Zápis epochy se nepřepsal opačným směrem: leader zavřel → epocha už není open.
    expect((safety?.leaderExposureEpochs ?? []).some(epoch => epoch.phase !== 'open')).toBe(true);
    expect((safety?.manualRecoveryRequired as { id?: string } | undefined)?.id).toBe(incident.id);
    expect(runtime.status().manualRecovery?.id).toBe(incident.id);
  });

  it('nesoulad paměti a uloženého incidentu se sám srovná — Zapnout pak potvrdí uložený', async () => {
    let now = Date.now();
    const inner = createMemoryCopierStore();
    let failCommits = false;
    const store: CopierStore = {
      ...inner,
      load: () => inner.load(),
      commit: async (snapshot, revision) => {
        if (failCommits) throw new Error('disk plný');
        return inner.commit(snapshot, revision);
      },
    };
    const broker = createMockBroker({ clock: () => now, behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [] });
    runtime = await bootstrapCopierRuntime({ broker, store, group: group(), clock: () => now, onError: () => undefined });
    broker.setConnected(true);
    await runtime.waitForIdle();
    runtime.reportHostSleep({ unresponsiveSince: now - 1_000, detectedAt: now, sleepDurationMs: 1_000 });
    await runtime.waitForIdle();
    const stored = runtime.status().manualRecovery!;

    // Druhý incident se do durable stavu nezapíše.
    failCommits = true;
    now += 60_000;
    runtime.reportHostSleep({ unresponsiveSince: now - 1_000, detectedAt: now, sleepDurationMs: 1_000 });
    await runtime.waitForIdle();
    failCommits = false;
    const shown = runtime.status().manualRecovery!;
    expect(shown.id).not.toBe(stored.id);

    // Potvrzení zobrazeného incidentu nic nesmaže, ale srovná paměť na uložený.
    await expect(runtime.reconcile({ acknowledgedIncidentId: shown.id })).rejects.toThrow('liší od zobrazeného');
    expect(runtime.status().manualRecovery?.id).toBe(stored.id);
    // Incident je zase vidět i jako chyba (jako po restartu).
    expect(runtime.status().lastError).toBe(stored.reason);
    expect((await store.load()).safety?.manualRecoveryRequired).toMatchObject({ id: stored.id });

    // Výslovné potvrzení uloženého incidentu projde.
    const result = await runtime.reconcile({ acknowledgedIncidentId: stored.id });
    expect(result.authoritativelyClean).toBe(true);
    expect(runtime.status().manualRecovery).toBeNull();
    expect((await store.load()).safety?.manualRecoveryRequired).toBeUndefined();
  });
});
