import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';
import { startLocalCopierExecutionAgent, type LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';

const group = (): CopyGroupConfig => ({
  id: 'arm-preparation', name: 'Preparation', enabled: true, leaderAccountId: 11,
  followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});
const groupWithTradingWindow = (from: string, to: string): CopyGroupConfig => ({
  ...group(),
  safety: {
    ...DEFAULT_COPY_GROUP_SAFETY,
    tradingWindow: { enabled: true, from, to, timeZone: 'UTC' },
  },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe('worker read-only ARM preparation', () => {
  let runtime: CopierRuntimeController;
  let agent: LocalCopierExecutionAgent | null = null;
  let now = Date.now();
  const boot = async (config = group(), routeEpoch?: () => number, at = Date.now()) => {
    now = at;
    const broker = createMockBroker({ clock: () => now, behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [] });
    if (routeEpoch) broker.routeEpoch = routeEpoch;
    runtime = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group: config, clock: () => now });
    runtime.startArmPreparation!();
    broker.setConnected(true);
    await runtime.waitForIdle();
    return broker;
  };
  afterEach(async () => {
    vi.useRealTimers();
    await agent?.close();
    agent = null;
    runtime?.stop();
    vi.restoreAllMocks();
  });

  it('startup prepares automatically without placing, canceling or arming; ON reuses that evidence', async () => {
    const broker = await boot();
    expect(runtime.status()).toMatchObject({ armed: false, armPreparation: { state: 'ready' } });
    const positions = vi.spyOn(broker, 'listPositions');
    const orders = vi.spyOn(broker, 'listOrders');
    const reconcile = vi.spyOn(runtime, 'reconcile');
    const risk = vi.spyOn(broker, 'listAccountRiskSnapshots');
    const routes = vi.fn(async () => ({ missingOptional: [] }));
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, prepareGroupAccounts: routes });
    const response = await agent.execute({ type: 'arm-live', group: group() });
    expect(response.status.controller).toMatchObject({ armed: true, shadowMode: false });
    expect(reconcile).not.toHaveBeenCalled();
    expect(routes).not.toHaveBeenCalled();
    expect(positions).not.toHaveBeenCalled();
    expect(orders).not.toHaveBeenCalled();
    expect(risk).not.toHaveBeenCalled();
    expect(broker.placedRequests()).toEqual([]);
    expect(broker.liquidateRequests()).toEqual([]);
    expect(broker.orders()).toEqual([]);
  });

  it('deduplicates background preparation and ON and keeps OFF outside the slow read', async () => {
    const broker = await boot();
    now += 31_000;
    const read = deferred<Awaited<ReturnType<typeof broker.listPositions>>>();
    const positions = vi.spyOn(broker, 'listPositions').mockImplementation(() => read.promise);
    const preparation = runtime.prepareArm!();
    const rejectedPreparation = expect(preparation).rejects.toThrow(/změnil|zneplatnila/);
    expect(runtime.prepareArm!()).toBe(preparation);
    await vi.waitFor(() => expect(positions).toHaveBeenCalledTimes(2));
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const on = agent.execute({ type: 'arm-live' });
    const rejectedOn = expect(on).rejects.toThrow(/DISARM|změnil|zneplatnila/);
    await vi.waitFor(() => expect(runtime.status().armPreparation?.state).toBe('checking'));
    await expect(agent.execute({ type: 'disarm' })).resolves.toMatchObject({ ok: true });
    expect(runtime.status().armed).toBe(false);
    read.resolve([]);
    await rejectedPreparation;
    await rejectedOn;
    await runtime.waitForIdle();
    expect(runtime.status().armed).toBe(false);
    expect(positions).toHaveBeenCalledTimes(2);
  });

  it('expires evidence and refreshes it read-only on the next ON', async () => {
    const broker = await boot();
    const positions = vi.spyOn(broker, 'listPositions');
    now += 31_000;
    expect(runtime.status().armPreparation?.state).toBe('needed');
    expect(() => runtime.arm({ requirePreparation: true })).toThrow('zneplatněno');
    await runtime.prepareArm!();
    expect(positions).toHaveBeenCalledTimes(2);
    expect(runtime.status().armPreparation?.state).toBe('ready');
  });

  it.each(['deadline', 'kill-switch'] as const)('%s prevents a late ARM on the new preparation path', async brake => {
    const broker = await boot();
    now += 31_000;
    const read = deferred<Awaited<ReturnType<typeof broker.listPositions>>>();
    const positions = vi.spyOn(broker, 'listPositions').mockImplementation(() => read.promise);
    const arm = vi.spyOn(runtime, 'arm');
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const on = agent.execute({ type: 'arm-live' }, { deadlineAt: Date.now() + (brake === 'deadline' ? 200 : 5_000) });
    const rejected = expect(on).rejects.toThrow(brake === 'deadline' ? 'deadline' : /kill|změnil|zneplatnila/i);
    await vi.waitFor(() => expect(positions).toHaveBeenCalledTimes(2));
    if (brake === 'kill-switch') {
      await expect(agent.execute({ type: 'kill-switch' })).resolves.toMatchObject({ ok: true });
    } else await rejected;
    read.resolve([]);
    await rejected;
    await runtime.waitForIdle();
    expect(arm).not.toHaveBeenCalled();
    expect(runtime.status().armed).toBe(false);
  });

  it('keeps readiness warm in the trading window and deduplicates heartbeats', async () => {
    const broker = await boot(
      groupWithTradingWindow('11:00', '13:00'),
      undefined,
      Date.parse('2026-10-05T12:00:00Z'),
    );
    const positions = vi.spyOn(broker, 'listPositions');
    now += 21_000;
    broker.emitEvent({ type: 'heartbeat', at: now });
    await runtime.waitForIdle();
    expect(positions).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 10; i++) broker.emitEvent({ type: 'heartbeat', at: now });
    await runtime.waitForIdle();
    expect(positions).toHaveBeenCalledTimes(2);
    expect(runtime.status().armPreparation?.state).toBe('ready');
  });

  it('uses a five-minute idle interval outside the trading window', async () => {
    const broker = await boot(
      groupWithTradingWindow('13:00', '14:00'),
      undefined,
      Date.parse('2026-10-05T12:00:00Z'),
    );
    const positions = vi.spyOn(broker, 'listPositions');
    now += 21_000;
    broker.emitEvent({ type: 'heartbeat', at: now });
    await runtime.waitForIdle();
    expect(positions).not.toHaveBeenCalled();

    now += 5 * 60_000;
    broker.emitEvent({ type: 'heartbeat', at: now });
    await runtime.waitForIdle();
    expect(positions).toHaveBeenCalledTimes(2);
  });

  it('returns to the active interval after the LIVE client reads local status', async () => {
    const broker = await boot(
      groupWithTradingWindow('13:00', '14:00'),
      undefined,
      Date.parse('2026-10-05T12:00:00Z'),
    );
    const positions = vi.spyOn(broker, 'listPositions');
    now += 21_000;
    runtime.noteArmPreparationInterest!();
    await runtime.waitForIdle();
    expect(positions).toHaveBeenCalledTimes(2);
    expect(runtime.status().armPreparation?.state).toBe('ready');
  });

  it('refreshes required risk evidence before ARM and rejects missing risk data', async () => {
    const broker = await boot({ ...group(), followers: [{ ...group().followers[0], dailyLossCutUsd: 500 }] });
    await expect(runtime.prepareArm!()).rejects.toThrow('ověření není aktuální');
    expect(runtime.status().armed).toBe(false);
    const risk = vi.spyOn(broker, 'listAccountRiskSnapshots').mockResolvedValue([{
      accountId: 22, at: now, realizedPnlUsd: 0, openPnlUsd: 0, netLiq: 50_000,
      minNetLiq: null, dailyLossAutoLiq: null, trailingMaxDrawdown: null,
    }]);
    await runtime.prepareArm!();
    expect(risk).toHaveBeenCalledTimes(1);
    const reads = vi.spyOn(broker, 'listPositions');
    runtime.arm({ requirePreparation: true });
    await runtime.waitForIdle();
    expect(risk).toHaveBeenCalledTimes(1);
    expect(reads).not.toHaveBeenCalled();
    expect(runtime.status().armed).toBe(true);
  });

  it('enforces a known follower loss cut immediately on prepared ARM without another broker read', async () => {
    const broker = await boot({ ...group(), followers: [{ ...group().followers[0], dailyLossCutUsd: 500 }] });
    const risk = vi.spyOn(broker, 'listAccountRiskSnapshots').mockResolvedValue([{
      accountId: 22, at: now, realizedPnlUsd: -600, openPnlUsd: 0, netLiq: 50_000,
      minNetLiq: null, dailyLossAutoLiq: null, trailingMaxDrawdown: null,
    }]);
    await runtime.prepareArm!();
    expect(runtime.status().followerCuts).toEqual([]);
    runtime.arm({ requirePreparation: true });
    await runtime.waitForIdle();
    expect(runtime.status().followerCuts).toContainEqual(expect.objectContaining({ accountId: 22, source: 'broker' }));
    expect(runtime.status().followerParticipation).toContainEqual(expect.objectContaining({ accountId: 22, effectiveEnabled: false }));
    expect(risk).toHaveBeenCalledTimes(1);
    expect(broker.placedRequests()).toEqual([]);
  });

  it('a relevant broker event invalidates readiness at ingress, before its event handler runs', async () => {
    const broker = await boot();
    broker.emitEvent({ type: 'position', position: { accountId: 11, symbol: 'MNQ', netQuantity: 0 } });
    expect(runtime.status().armPreparation?.state).toBe('needed');
    expect(() => runtime.arm({ requirePreparation: true })).toThrow('zneplatněno');
    await runtime.waitForIdle();
    await runtime.prepareArm!();
    expect(runtime.status().armPreparation?.state).toBe('ready');
  });

  it('a stream event during the snapshot prevents publication of a clean receipt', async () => {
    const broker = await boot();
    now += 31_000;
    const read = deferred<Awaited<ReturnType<typeof broker.listPositions>>>();
    const positions = vi.spyOn(broker, 'listPositions').mockImplementation(() => read.promise);
    const preparation = runtime.prepareArm!();
    const rejected = expect(preparation).rejects.toThrow('stav se změnil');
    await vi.waitFor(() => expect(positions).toHaveBeenCalledTimes(2));
    broker.emitEvent({ type: 'position', position: { accountId: 22, symbol: 'MNQ', netQuantity: 0 } });
    read.resolve([]);
    await rejected;
    expect(runtime.status().armPreparation?.state).not.toBe('ready');
  });

  it('an account route sync epoch invalidates readiness even without a global disconnect', async () => {
    let epoch = 1;
    await boot(group(), () => epoch);
    await runtime.prepareArm!();
    expect(runtime.status().armPreparation?.state).toBe('ready');
    epoch = 2;
    expect(runtime.status().armPreparation?.state).toBe('needed');
    expect(() => runtime.arm({ requirePreparation: true })).toThrow('zneplatněno');
    await runtime.prepareArm!();
    expect(runtime.status().armPreparation?.state).toBe('ready');
  });

  it('a route epoch change during read-only preparation rejects the old snapshot', async () => {
    let epoch = 1;
    const broker = await boot(group(), () => epoch);
    now += 31_000;
    const read = deferred<Awaited<ReturnType<typeof broker.listPositions>>>();
    const positions = vi.spyOn(broker, 'listPositions').mockImplementation(() => read.promise);
    const preparation = runtime.prepareArm!();
    const rejected = expect(preparation).rejects.toThrow('stav se změnil');
    await vi.waitFor(() => expect(positions).toHaveBeenCalledTimes(2));
    epoch = 2;
    read.resolve([]);
    await rejected;
    expect(runtime.status().armPreparation?.state).not.toBe('ready');
  });

  it('missing optional reconnect accounts cannot authorize a later live ARM', async () => {
    const broker = createMockBroker({ accountCapabilities: [{ accountId: 11, active: true, canTrade: true }] });
    runtime = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group: group(),
      resolveMissingOptionalAccountIds: async () => [22] });
    broker.setConnected(true);
    await runtime.waitForIdle();
    expect(runtime.status().armPreparation?.state).not.toBe('ready');
    await expect(runtime.prepareArm!()).rejects.toThrow('missing=22');
    expect(() => runtime.arm({ requirePreparation: true })).toThrow('zneplatněno');
  });

  it('an incident cannot be cleared by ON, background preparation or a later reconnect', async () => {
    const broker = await boot();
    runtime.reportHostSleep({ unresponsiveSince: now - 1_000, detectedAt: now, sleepDurationMs: 1_000 });
    await runtime.waitForIdle();
    const incident = runtime.status().lastError;
    await expect(runtime.prepareArm!()).rejects.toThrow('incidentu');
    expect(runtime.status().lastError).toBe(incident);
    broker.setConnected(false);
    broker.setConnected(true);
    await runtime.waitForIdle();
    expect(runtime.status().armPreparation?.manualRecoveryRequired).toBe(true);
    const reconcile = vi.spyOn(runtime, 'reconcile');
    agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    await expect(agent.execute({ type: 'arm-live' })).rejects.toThrow('incidentu');
    expect(reconcile).not.toHaveBeenCalled();
    expect(runtime.status().armed).toBe(false);
    await runtime.reconcile();
    await runtime.prepareArm!();
    expect(runtime.status()).toMatchObject({ armed: false, lastError: null, armPreparation: { state: 'ready' } });
  });

  it('keeps an incident blocked across restart until a clean manual reconciliation', async () => {
    now = Date.parse('2026-10-05T12:00:00Z');
    const store = createMemoryCopierStore();
    const broker = createMockBroker({ clock: () => now, behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [] });
    runtime = await bootstrapCopierRuntime({ broker, store, group: group(), clock: () => now });
    broker.setConnected(true);
    await runtime.waitForIdle();
    runtime.reportHostSleep({ unresponsiveSince: now - 1_000, detectedAt: now, sleepDurationMs: 1_000 });
    await runtime.waitForIdle();
    expect((await store.load()).safety?.manualRecoveryRequired).toMatchObject({
      at: now,
      reason: expect.stringContaining('host-sleep'),
    });
    runtime.stop();

    const restarted = await bootstrapCopierRuntime({ broker, store, group: group(), clock: () => now });
    runtime = restarted;
    broker.setConnected(false);
    broker.setConnected(true);
    restarted.startArmPreparation!();
    await restarted.waitForIdle();
    expect(restarted.status()).toMatchObject({
      armed: false,
      lastError: expect.stringContaining('host-sleep'),
      armPreparation: {
        state: 'blocked',
        blockedBy: 'incident',
        manualRecoveryRequired: true,
      },
    });
    await expect(restarted.prepareArm!()).rejects.toThrow('incidentu');

    await restarted.reconcile();
    expect((await store.load()).safety?.manualRecoveryRequired).toBeUndefined();
    await restarted.prepareArm!();
    expect(restarted.status()).toMatchObject({
      lastError: null,
      armPreparation: { state: 'ready', blockedBy: null, manualRecoveryRequired: false },
    });
  });

  it('does not accept open positions as prepared and does not close them automatically', async () => {
    const broker = await boot();
    broker.setPosition(11, 'MNQ', 1);
    runtime.disarm();
    await expect(runtime.prepareArm!()).rejects.toThrow();
    expect(runtime.status().armPreparation?.state).not.toBe('ready');
    expect(broker.placedRequests()).toEqual([]);
    expect(broker.liquidateRequests()).toEqual([]);
  });

  it('configuration changes invalidate preparation and a heartbeat warms the new configuration', async () => {
    const broker = await boot();
    runtime.updateGroup({ ...group(), followers: [{ accountId: 22, mode: 'on-submit', multiplier: 2 }] });
    expect(runtime.status().armPreparation?.state).toBe('needed');
    const positions = vi.spyOn(broker, 'listPositions');
    broker.emitEvent({ type: 'heartbeat', at: now });
    await runtime.waitForIdle();
    expect(runtime.status().armPreparation?.state).toBe('ready');
    expect(positions).toHaveBeenCalledTimes(2);
  });

  it('a timed out read releases the preparation lane; its late result cannot publish readiness', async () => {
    const broker = await boot();
    now += 31_000;
    const read = deferred<Awaited<ReturnType<typeof broker.listPositions>>>();
    const positions = vi.spyOn(broker, 'listPositions').mockImplementation(() => read.promise);
    vi.useFakeTimers();
    const preparation = runtime.prepareArm!();
    const rejected = expect(preparation).rejects.toThrow('překročilo 10 s');
    await vi.waitFor(() => expect(positions).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    read.resolve([]);
    await Promise.resolve();
    expect(runtime.status().armPreparation?.state).not.toBe('ready');
    positions.mockRestore();
    await runtime.prepareArm!();
    expect(runtime.status().armPreparation?.state).toBe('ready');
  });
});
