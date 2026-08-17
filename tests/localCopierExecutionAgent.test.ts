import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLocalCopierExecutionAgent, type LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';
import type { CopierRuntimeController, CopierControllerStatus } from '../services/copierRuntimeController';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';
import { createMemoryCopierStore } from '../services/copierStore';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';

const origin = 'https://alphatrade-mentor-15.vercel.app';
const group = (): CopyGroupConfig => ({
  id: 'runtime-test',
  name: 'test',
  enabled: true,
  leaderAccountId: 11,
  followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }],
  localOnly: true,
});

const controller = () => {
  let status: CopierControllerStatus = {
    started: true,
    armed: false,
    killSwitch: false,
    shadowMode: true,
    connected: true,
    reconciliationRequired: false,
    divergentAccounts: [],
    workingOrderAccounts: [],
    stuckOutbox: false,
    lastError: null,
    revision: 1,
    lastSequence: 0,
  };
  const value = {
    arm: vi.fn(({ shadowMode = false }: { shadowMode?: boolean } = {}) => {
      status = { ...status, armed: true, shadowMode };
    }),
    disarm: vi.fn(() => { status = { ...status, armed: false }; }),
    engageKillSwitch: vi.fn(() => { status = { ...status, armed: false, killSwitch: true }; }),
    reconcile: vi.fn(async () => ({ divergentAccounts: [], workingOrderAccounts: [] })),
    updateGroup: vi.fn(),
    flattenAccount: vi.fn(async () => ({ flat: true })),
    flattenGroup: vi.fn(async () => ({ flat: true })),
    waiveStuckOperation: vi.fn(),
    status: vi.fn(() => status),
    waitForIdle: vi.fn(),
    stop: vi.fn(),
  };
  return value as unknown as CopierRuntimeController;
};

const post = async (agent: LocalCopierExecutionAgent, nonce: string, command: unknown) => fetch(`${agent.origin}/v1/command`, {
  method: 'POST',
  headers: {
    Origin: origin,
    'Content-Type': 'application/json',
    'X-AlphaTrade-Agent-Nonce': nonce,
  },
  body: JSON.stringify(command),
});

describe('local copier execution agent', () => {
  let running: LocalCopierExecutionAgent | null = null;
  afterEach(async () => {
    await running?.close();
    running = null;
  });

  it('is loopback-only, exposes status to the approved origin and updates the follower multiplier', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    expect(running.origin).toMatch(/^http:\/\/127\.0\.0\.1:/);

    const statusResponse = await fetch(`${running.origin}/v1/status`, { headers: { Origin: origin } });
    expect(statusResponse.status).toBe(200);
    const status = await statusResponse.json();
    const response = await post(running, status.nonce, {
      type: 'copy-command',
      command: { type: 'set-multiplier', groupId: 'ui-test', accountId: 22, multiplier: 1.5 },
    });
    expect(response.status).toBe(200);
    expect(runtime.updateGroup).toHaveBeenCalledWith(expect.objectContaining({
      followers: [expect.objectContaining({ accountId: 22, multiplier: 1.5 })],
    }));
  });

  it('forwards only explicit Flatten and Flatten All commands with their stable operation id', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const nonce = running.status().nonce;

    expect((await post(running, nonce, {
      type: 'copy-command',
      command: { type: 'flatten-account', groupId: 'ui-test', accountId: 22, operationId: 'flatten-one-123' },
    })).status).toBe(200);
    expect(runtime.flattenAccount).toHaveBeenCalledWith(22, 'flatten-one-123');

    expect((await post(running, nonce, {
      type: 'copy-command',
      command: { type: 'flatten-group', groupId: 'ui-test', operationId: 'flatten-all-123' },
    })).status).toBe(200);
    expect(runtime.flattenGroup).toHaveBeenCalledWith('flatten-all-123');
  });

  it('rejects foreign origins, invalid nonce and accounts outside the runtime group', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const foreign = await fetch(`${running.origin}/v1/status`, { headers: { Origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);

    const wrongNonce = await post(running, 'wrong', {
      type: 'copy-command',
      command: { type: 'flatten-account', groupId: 'ui-test', accountId: 22, operationId: 'flatten-one-123' },
    });
    expect(wrongNonce.status).toBe(401);

    const outside = await post(running, running.status().nonce, {
      type: 'copy-command',
      command: { type: 'flatten-account', groupId: 'ui-test', accountId: 33, operationId: 'flatten-one-123' },
    });
    expect(outside.status).toBe(409);
    expect(runtime.flattenAccount).not.toHaveBeenCalled();

    const swappedTopology = await post(running, running.status().nonce, {
      type: 'copy-command',
      command: {
        type: 'update-group',
        group: {
          ...group(),
          id: 'ui-test',
          leaderAccountId: 22,
          followers: [{ accountId: 11, mode: 'on-submit', multiplier: 1 }],
        },
      },
    });
    expect(swappedTopology.status).toBe(409);
    expect(runtime.updateGroup).not.toHaveBeenCalled();
  });

  it('reconciles before ARM and remains disarmed when reconciliation fails', async () => {
    const runtime = controller();
    vi.mocked(runtime.reconcile).mockResolvedValueOnce({ divergentAccounts: [22], workingOrderAccounts: [] });
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const response = await post(running, running.status().nonce, { type: 'arm-live' });
    expect(response.status).toBe(409);
    expect(runtime.arm).not.toHaveBeenCalled();
  });

  it('exposes a pending Mac pairing only until the authenticated UI confirms it', async () => {
    const runtime = controller();
    const onDevicePaired = vi.fn(async () => undefined);
    running = await startLocalCopierExecutionAgent({
      controller: runtime,
      group: group(),
      port: 0,
      device: {
        state: 'pairing-required',
        deviceId: '00000000-0000-4000-8000-000000000001',
        connectionId: '00000000-0000-4000-8000-000000000002',
        deviceName: 'Filipův Mac',
        deviceSecret: 'secret-only-before-pairing',
        publicKey: 'public-key',
      },
      onDevicePaired,
    });
    expect(running.status().device).toMatchObject({
      state: 'pairing-required',
      deviceSecret: 'secret-only-before-pairing',
    });
    const response = await post(running, running.status().nonce, {
      type: 'device-paired',
      deviceId: '00000000-0000-4000-8000-000000000001',
    });
    expect(response.status).toBe(200);
    expect(onDevicePaired).toHaveBeenCalledTimes(1);
    expect((await response.json()).status.device).toEqual({
      state: 'paired',
      deviceId: '00000000-0000-4000-8000-000000000001',
      connectionId: '00000000-0000-4000-8000-000000000002',
      deviceName: 'Filipův Mac',
    });
  });

  it('drives 2x replication, Flatten and Flatten All through HTTP into the real durable runtime', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 30_000 }) });
    const store = createMemoryCopierStore();
    const runtime = await bootstrapCopierRuntime({
      broker,
      store,
      group: group(),
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await runtime.waitForIdle();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const nonce = running.status().nonce;

    const multiplierResponse = await post(running, nonce, {
      type: 'copy-command',
      command: { type: 'set-multiplier', groupId: 'ui-test', accountId: 22, multiplier: 2 },
    });
    expect(multiplierResponse.status).toBe(200);
    expect((await multiplierResponse.json()).result).toMatchObject({
      type: 'configuration',
      group: { followers: [{ accountId: 22, multiplier: 2 }] },
    });
    expect((await post(running, nonce, { type: 'arm-live' })).status).toBe(200);

    broker.emitEvent({
      type: 'order',
      order: {
        tag: 'external-leader-order', brokerOrderId: 'leader-e2e-1', accountId: 11, symbol: 'MNQU6',
        side: 'Buy', quantity: 1, filledQuantity: 0, orderType: 'Market', status: 'working',
        sourceVersion: '1:Working', updatedAt: 1,
      },
    });
    await runtime.waitForIdle();
    expect(await broker.listPositions(22)).toEqual([expect.objectContaining({ netQuantity: 2 })]);

    const flattenFollower = await post(running, nonce, {
      type: 'copy-command',
      command: { type: 'flatten-account', groupId: 'ui-test', accountId: 22, operationId: 'e2e-flatten-one-001' },
    });
    expect(flattenFollower.status).toBe(200);
    expect((await flattenFollower.json()).result).toMatchObject({
      type: 'flatten', accountIds: [22], submittedClosures: 1, flat: true,
    });
    expect(await broker.listPositions(22)).toEqual([expect.objectContaining({ netQuantity: 0 })]);

    // Po Flatten účtu je runtime DISARMED. Seed leader pozice proto nemůže
    // vytvořit další follower order a slouží jen k ověření Flatten All.
    await broker.placeOrder({
      tag: 'seed-leader-after-disarm', accountId: 11, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    await runtime.waitForIdle();
    expect(await broker.listPositions(11)).toEqual([expect.objectContaining({ netQuantity: 1 })]);

    const flattenAll = await post(running, nonce, {
      type: 'copy-command',
      command: { type: 'flatten-group', groupId: 'ui-test', operationId: 'e2e-flatten-all-001' },
    });
    expect(flattenAll.status).toBe(200);
    expect((await flattenAll.json()).result).toMatchObject({
      type: 'flatten', accountIds: [11, 22], submittedClosures: 1, flat: true,
    });
    expect(await broker.listPositions(11)).toEqual([expect.objectContaining({ netQuantity: 0 })]);
    expect(await broker.listPositions(22)).toEqual([expect.objectContaining({ netQuantity: 0 })]);
    expect((await store.load()).outbox).toHaveLength(3);
    runtime.stop();
  });
});
