// 15. 10. 2026 (produkce): po incidentu (stale-heartbeat při uspání Macu)
// a dalším výpadku spojení nešlo kopírku zapnout ani s potvrzením incidentu.
// Automatická read-only kontrola po reconnectu se při nepotvrzeném incidentu
// přeskočí a její požadavek zůstane viset; ARM z UI posílá i konfiguraci
// skupiny a `preflightGroupChange` ho odmítl („blokuje probíhající connection
// recovery/reconciliation“) dřív, než ON stihl kontrolu s potvrzením provést.
// Nepomohl ani restart workeru (incident i reconnect se obnoví).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { startLocalCopierExecutionAgent, type LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';

const group = (): CopyGroupConfig => ({
  id: 'incident-reconnect', name: 'Incident', enabled: true, leaderAccountId: 11,
  followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});

describe('Zapnout po incidentu a následném výpadku spojení', () => {
  let runtime: CopierRuntimeController;
  let agent: LocalCopierExecutionAgent | null = null;
  let now = Date.now();
  afterEach(async () => {
    await agent?.close();
    agent = null;
    runtime?.stop();
    vi.restoreAllMocks();
  });

  const incidentThenReconnect = async (store = createMemoryCopierStore()) => {
    now = Date.now();
    const broker = createMockBroker({ clock: () => now, behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [] });
    runtime = await bootstrapCopierRuntime({ broker, store, group: group(), clock: () => now });
    runtime.startArmPreparation!();
    broker.setConnected(true);
    await runtime.waitForIdle();
    runtime.reportHostSleep({ unresponsiveSince: now - 1_000, detectedAt: now, sleepDurationMs: 1_000 });
    await runtime.waitForIdle();
    broker.setConnected(false);
    broker.setConnected(true);
    await runtime.waitForIdle();
    return { broker, store };
  };

  it('ARM s konfigurací skupiny a potvrzením incidentu projde; bez potvrzení dál odmítne', async () => {
    await incidentThenReconnect();
    expect(runtime.status()).toMatchObject({ armed: false, armPreparation: { blockedBy: 'incident', manualRecoveryRequired: true } });
    // Brána změny konfigurace zůstává (požadavek kontroly visí) — ON s
    // potvrzením si kontrolu udělá před ní.
    expect(() => runtime.preflightGroupChange(group())).toThrow('probíhající connection recovery');
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmAfterTransport: false });
    await expect(agent.execute({ type: 'arm-live', group: group() })).rejects.toThrow('[ack-incident:');
    expect(runtime.status()).toMatchObject({ armed: false, armPreparation: { manualRecoveryRequired: true } });
    const reconcile = vi.spyOn(runtime, 'reconcile');
    const acknowledgeIncidentId = runtime.status().manualRecovery!.id;
    await agent.execute({ type: 'arm-live', group: group(), acknowledgeIncidentId });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ acknowledgedIncidentId: acknowledgeIncidentId }));
    expect(runtime.status()).toMatchObject({ armed: true, shadowMode: false, lastError: null, manualRecovery: null });
  });

  it('po restartu workeru (incident + reconnect se obnoví) ARM s potvrzením taky projde', async () => {
    const { broker, store } = await incidentThenReconnect();
    runtime.stop();
    runtime = await bootstrapCopierRuntime({ broker, store, group: group(), clock: () => now });
    runtime.startArmPreparation!();
    broker.setConnected(false);
    broker.setConnected(true);
    await runtime.waitForIdle();
    expect(runtime.status().armPreparation?.manualRecoveryRequired).toBe(true);
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmAfterTransport: false });
    await agent.execute({ type: 'arm-live', group: group(), acknowledgeIncidentId: runtime.status().manualRecovery!.id });
    expect(runtime.status()).toMatchObject({ armed: true, manualRecovery: null });
  });

  it('běžící read-only kontrolu po reconnectu změna konfigurace dál nepředběhne', async () => {
    now = Date.now();
    const broker = createMockBroker({ clock: () => now, behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [] });
    runtime = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group: group(), clock: () => now });
    broker.setConnected(true);
    await runtime.waitForIdle();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = broker.listPositions.bind(broker);
    vi.spyOn(broker, 'listPositions').mockImplementation(async accountId => { await gate; return original(accountId); });
    broker.setConnected(false);
    broker.setConnected(true);
    await vi.waitFor(() => expect(() => runtime.preflightGroupChange(group())).toThrow('probíhající connection recovery'));
    release();
    await runtime.waitForIdle();
    expect(() => runtime.preflightGroupChange(group())).not.toThrow();
  });
  it('bez incidentu: reconnect s ruční pozicí leadera nechá kontrolu viset; po zavření jde ON se skupinou zapnout', async () => {
    now = Date.now();
    const broker = createMockBroker({ clock: () => now, behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [] });
    runtime = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group: group(), clock: () => now });
    runtime.startArmPreparation!();
    broker.setConnected(true);
    await runtime.waitForIdle();
    broker.setPosition(11, 'MNQZ6', 1);
    broker.setConnected(false);
    broker.setConnected(true);
    await runtime.waitForIdle();
    broker.setPosition(11, 'MNQZ6', 0);
    await runtime.waitForIdle();
    expect(runtime.status().manualRecovery ?? null).toBeNull();
    expect(() => runtime.preflightGroupChange(group())).toThrow('probíhající connection recovery');
    const reconcile = vi.spyOn(runtime, 'reconcile');
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmAfterTransport: false });
    await agent.execute({ type: 'arm-live', group: group() });
    // Časná kontrola + Etapa 1 (příprava zůstala „needed“): obě read-only.
    expect(reconcile).toHaveBeenCalled();
    expect(runtime.status()).toMatchObject({ armed: true, shadowMode: false });
  });

  it('bez incidentu: 5× selhaná read-only kontrola po reconnectu ON se skupinou nezablokuje', async () => {
    now = Date.now();
    const broker = createMockBroker({ clock: () => now, behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [] });
    runtime = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group: group(), clock: () => now, wait: async () => undefined });
    runtime.startArmPreparation!();
    broker.setConnected(true);
    await runtime.waitForIdle();
    const original = broker.listPositions.bind(broker);
    let failing = true;
    vi.spyOn(broker, 'listPositions').mockImplementation(async accountId => {
      if (failing) throw new Error('broker timeout');
      return original(accountId);
    });
    broker.setConnected(false);
    broker.setConnected(true);
    await runtime.waitForIdle();
    expect(runtime.status().manualRecovery ?? null).toBeNull();
    expect(() => runtime.preflightGroupChange(group())).toThrow('probíhající connection recovery');
    failing = false;
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmAfterTransport: false });
    await agent.execute({ type: 'arm-live', group: group() });
    expect(runtime.status()).toMatchObject({ armed: true, shadowMode: false });
  });

  it('nepřečtený follower: časná kontrola není čistá, incident zůstane a kopírka se nezapne', async () => {
    const { broker } = await incidentThenReconnect();
    const original = broker.listPositions.bind(broker);
    vi.spyOn(broker, 'listPositions').mockImplementation(async accountId => {
      if (accountId === 22) throw new Error('route missing for 22');
      return original(accountId);
    });
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmAfterTransport: false });
    const incidentId = runtime.status().manualRecovery!.id;
    await expect(agent.execute({ type: 'arm-live', group: group(), acknowledgeIncidentId: incidentId })).rejects.toThrow();
    expect(runtime.status()).toMatchObject({ armed: false, manualRecovery: { id: incidentId } });
  });

  it('potvrzení jiného (zastaralého) incidentu se skupinou odmítne bez kontroly', async () => {
    await incidentThenReconnect();
    const reconcile = vi.spyOn(runtime, 'reconcile');
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmAfterTransport: false });
    await expect(agent.execute({ type: 'arm-live', group: group(), acknowledgeIncidentId: 'incident-0' })).rejects.toThrow('[ack-incident:');
    expect(reconcile).not.toHaveBeenCalled();
    expect(runtime.status().manualRecovery).not.toBeNull();
  });

  it('potvrzený a čistě zkontrolovaný incident zmizí, i když ON pak skončí na neplatné konfiguraci (INV-DEFAULT-03)', async () => {
    await incidentThenReconnect();
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, autoRearmAfterTransport: false });
    const invalid: CopyGroupConfig = { ...group(), followers: [{ accountId: 11, mode: 'on-submit', multiplier: 1 }] };
    await expect(agent.execute({ type: 'arm-live', group: invalid, acknowledgeIncidentId: runtime.status().manualRecovery!.id })).rejects.toThrow();
    expect(runtime.status()).toMatchObject({ armed: false, manualRecovery: null });
  });
});
