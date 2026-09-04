import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startLocalCopierExecutionAgent,
  type LocalCopierExecutionAgent,
  type PrepareGroupAccountsRequest,
} from '../server/localCopierExecutionAgent';
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

const controller = (overrides: Partial<CopierControllerStatus> = {}) => {
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
    stuckOperations: [],
    lastError: null,
    revision: 1,
    lastSequence: 0,
    groupFlat: true,
    ...overrides,
  };
  const value = {
    arm: vi.fn(({ shadowMode = false }: { shadowMode?: boolean } = {}) => {
      status = { ...status, armed: true, shadowMode };
    }),
    beginShutdown: vi.fn(async () => { status = { ...status, armed: false }; }),
    disarm: vi.fn(() => { status = { ...status, armed: false }; }),
    engageKillSwitch: vi.fn(() => { status = { ...status, armed: false, killSwitch: true }; }),
    lockUntil: vi.fn(async () => { status = { ...status, armed: false }; }),
    unlockDay: vi.fn(async () => { status = { ...status, armed: false }; }),
    applyAccountEligibilityExclusions: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => ({ divergentAccounts: [], workingOrderAccounts: [] })),
    verifyAccountEligibility: vi.fn(async accountId => ({
      accountId, state: 'active' as const, reason: 'ověřeno', at: 1,
    })),
    activateGroup: vi.fn(async () => undefined),
    reconfigureGroup: vi.fn(async () => undefined),
    updateGroup: vi.fn(),
    flattenAccount: vi.fn(async () => ({ flat: true })),
    flattenGroup: vi.fn(async () => ({ flat: true })),
    waiveStuckOperation: vi.fn(),
    status: vi.fn(() => status),
    waitForIdle: vi.fn(),
    stop: vi.fn(),
  };
  return value as typeof value & CopierRuntimeController;
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

  it('publishes current snapshot health without coupling it to controller state', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({
      controller: runtime,
      group: group(),
      port: 0,
      snapshotHealth: () => ({
        enabled: true,
        state: 'ready',
        layoutName: 'AlphaTrade Snapshoty',
        chartIdConfigured: true,
        cdpReachable: true,
        targetFound: true,
        lastCheckedAt: 10,
        lastAttemptAt: 20,
        lastSuccessAt: 30,
      }),
    });
    expect(running.status().snapshotHealth).toEqual(expect.objectContaining({
      state: 'ready', layoutName: 'AlphaTrade Snapshoty', lastSuccessAt: 30,
    }));
    expect(runtime.status()).toMatchObject({ armed: false, connected: true });
  });

  it('snapshot-test pouze naplánuje focení a nikdy nevolá broker/controller akci', async () => {
    const runtime = controller();
    const onSnapshotTest = vi.fn();
    running = await startLocalCopierExecutionAgent({
      controller: runtime,
      group: group(),
      port: 0,
      onSnapshotTest,
    });
    const requestId = '44444444-4444-4444-8444-444444444444';
    const result = await running.execute({ type: 'snapshot-test', requestId });

    expect(result.ok).toBe(true);
    expect(onSnapshotTest).toHaveBeenCalledWith(requestId, { repairCamera: false });
    expect(runtime.arm).not.toHaveBeenCalled();
    expect(runtime.disarm).not.toHaveBeenCalled();
    expect(runtime.reconcile).not.toHaveBeenCalled();
    expect(runtime.flattenAccount).not.toHaveBeenCalled();
    expect(runtime.flattenGroup).not.toHaveBeenCalled();
  });

  it('repair snapshot kamery naplánuje jen v bezpečném DISARMED/flat stavu', async () => {
    const runtime = controller();
    const onSnapshotTest = vi.fn();
    running = await startLocalCopierExecutionAgent({
      controller: runtime,
      group: group(),
      port: 0,
      onSnapshotTest,
    });
    const requestId = '55555555-5555-4555-8555-555555555555';
    await expect(running.execute({
      type: 'snapshot-test', requestId, repairCamera: true,
    })).resolves.toMatchObject({ ok: true });
    expect(onSnapshotTest).toHaveBeenCalledWith(requestId, { repairCamera: true });
    expect(runtime.arm).not.toHaveBeenCalled();
    expect(runtime.flattenAccount).not.toHaveBeenCalled();
    expect(runtime.flattenGroup).not.toHaveBeenCalled();

    runtime.arm();
    await expect(running.execute({
      type: 'snapshot-test', requestId, repairCamera: true,
    })).rejects.toThrow('DISARMED');
    expect(onSnapshotTest).toHaveBeenCalledTimes(1);
  });

  it('repair snapshot vrátí strukturované restart blokery a account preflight detaily', async () => {
    const runtime = controller({
      reconciliationRequired: true,
      divergentAccounts: [22],
      oauthPreflight: {
        missingAccounts: [33],
        inactiveAccounts: [44],
        readOnlyFollowerAccounts: [55],
      },
    });
    running = await startLocalCopierExecutionAgent({
      controller: runtime,
      group: group(),
      port: 0,
      onSnapshotTest: vi.fn(),
    });

    await expect(running.execute({
      type: 'snapshot-test',
      requestId: '66666666-6666-4666-8666-666666666666',
      repairCamera: true,
    })).rejects.toMatchObject({
      message: 'TradingView lze obnovit pouze při připojeném, reconciled, DISARMED a flat workeru bez pracovních příkazů.',
      details: {
        code: 'snapshot-repair-blocked',
        blockers: expect.arrayContaining([
          'reconciliation-required',
          'divergent-accounts',
          'preflight-missing',
          'preflight-inactive',
          'preflight-read-only-followers',
        ]),
        divergentAccounts: [22],
        missingAccounts: [33],
        inactiveAccounts: [44],
        readOnlyFollowerAccounts: [55],
      },
    });
  });

  it('snapshot-test odmítne chybějící request ID i worker bez camera callbacku', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    await expect(running.execute({ type: 'snapshot-test' })).rejects.toThrow('snapshot-test-invalid-request');
    await expect(running.execute({
      type: 'snapshot-test', requestId: '44444444-4444-4444-8444-444444444444',
    })).rejects.toThrow('snapshot-test-unavailable');
    expect(runtime.arm).not.toHaveBeenCalled();
  });

  it('beginShutdown synchronně zmrazí nový command ingress před graceful drainem', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });

    running.beginShutdown();
    await expect(running.execute({ type: 'arm-live' })).rejects.toThrow('bezpečně ukončuje');
    expect(runtime.arm).not.toHaveBeenCalled();
    expect(runtime.flattenAccount).not.toHaveBeenCalled();
    expect(runtime.flattenGroup).not.toHaveBeenCalled();
    await expect(running.close()).resolves.toBeUndefined();
  });

  it('forwards only explicit Flatten and Flatten All commands with their stable operation id', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const nonce = running.status().nonce;

    expect((await post(running, nonce, {
      type: 'copy-command',
      command: { type: 'flatten-account', groupId: 'runtime-test', accountId: 22, operationId: 'flatten-one-123' },
    })).status).toBe(200);
    expect(runtime.flattenAccount).toHaveBeenCalledWith(22, 'flatten-one-123');

    expect((await post(running, nonce, {
      type: 'copy-command',
      command: { type: 'flatten-group', groupId: 'runtime-test', operationId: 'flatten-all-123' },
    })).status).toBe(200);
    expect(runtime.flattenGroup).toHaveBeenCalledWith('flatten-all-123');
  });

  it('rejects Flatten aimed at a different group than the runtime one', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const nonce = running.status().nonce;

    const account = await post(running, nonce, {
      type: 'copy-command',
      command: { type: 'flatten-account', groupId: 'jina-skupina', accountId: 22, operationId: 'flatten-one-123' },
    });
    expect(account.status).toBe(409);
    const wholeGroup = await post(running, nonce, {
      type: 'copy-command',
      command: { type: 'flatten-group', groupId: 'jina-skupina', operationId: 'flatten-all-123' },
    });
    expect(wholeGroup.status).toBe(409);
    expect(runtime.flattenAccount).not.toHaveBeenCalled();
    expect(runtime.flattenGroup).not.toHaveBeenCalled();
  });

  it('rejects foreign origins, invalid nonce and accounts outside the runtime group', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const foreign = await fetch(`${running.origin}/v1/status`, { headers: { Origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);

    const wrongNonce = await post(running, 'wrong', {
      type: 'copy-command',
      command: { type: 'flatten-account', groupId: 'runtime-test', accountId: 22, operationId: 'flatten-one-123' },
    });
    expect(wrongNonce.status).toBe(401);

    const outside = await post(running, running.status().nonce, {
      type: 'copy-command',
      command: { type: 'flatten-account', groupId: 'runtime-test', accountId: 33, operationId: 'flatten-one-123' },
    });
    expect(outside.status).toBe(409);
    expect(runtime.flattenAccount).not.toHaveBeenCalled();

  });

  it('mění follower topologii přes DISARM, dynamický routing a bezpečnou epochu', async () => {
    const runtime = controller();
    const onGroupChanged = vi.fn(async () => undefined);
    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [] }));
    runtime.arm({ shadowMode: false });
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: group(), port: 0, onGroupChanged, prepareGroupAccounts,
    });
    const expanded = {
      ...group(),
      id: 'ui-test',
      followers: [
        { accountId: 22, mode: 'on-submit' as const, multiplier: 1 },
        { accountId: 33, mode: 'on-fill' as const, multiplier: 0.5 },
      ],
    };
    const response = await post(running, running.status().nonce, {
      type: 'copy-command', command: { type: 'update-group', group: expanded },
    });
    expect(response.status).toBe(200);
    expect(runtime.disarm).toHaveBeenCalled();
    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [11, 22, 33], optional: [] });
    expect(runtime.reconfigureGroup).toHaveBeenCalledWith(expect.objectContaining({
      leaderAccountId: 11,
      followers: expect.arrayContaining([expect.objectContaining({ accountId: 33 })]),
    }), { missingOptionalAccountIds: [] });
    expect(runtime.updateGroup).not.toHaveBeenCalled();
    expect(vi.mocked(runtime.disarm).mock.invocationCallOrder[0])
      .toBeLessThan(prepareGroupAccounts.mock.invocationCallOrder[0]);
    expect(prepareGroupAccounts.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(runtime.reconfigureGroup).mock.invocationCallOrder[0]);
    expect(running.status().group.followers).toHaveLength(2);
    expect(onGroupChanged).toHaveBeenCalledWith(expect.objectContaining({
      followers: expect.arrayContaining([expect.objectContaining({ accountId: 33 })]),
    }));
  });

  it('neviditelný nový účet skončí DISARMED ještě před změnou runtime', async () => {
    const runtime = controller();
    runtime.arm({ shadowMode: false });
    const prepareGroupAccounts = vi.fn(async () => {
      throw new Error('Účet 33 není viditelný v žádném připojeném OAuth');
    });
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
    });

    const response = await post(running, running.status().nonce, {
      type: 'copy-command',
      command: {
        type: 'update-group',
        group: {
          ...group(),
          followers: [
            { accountId: 22, mode: 'on-submit', multiplier: 1 },
            { accountId: 33, mode: 'on-submit', multiplier: 1 },
          ],
        },
      },
    });

    expect(response.status).toBe(409);
    expect(runtime.status().armed).toBe(false);
    expect(runtime.reconfigureGroup).not.toHaveBeenCalled();
    expect(runtime.updateGroup).not.toHaveBeenCalled();
    expect(running.status().group.followers).toHaveLength(1);
  });

  it('dovolí odebrat followera bez eligibility záznamu, kterého OAuth už nevrací', async () => {
    const runtime = controller();
    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [22] }));
    running = await startLocalCopierExecutionAgent({
      controller: runtime,
      group: group(),
      port: 0,
      prepareGroupAccounts,
    });

    const withoutFollower = {
      ...group(),
      followers: [],
    };
    const response = await post(running, running.status().nonce, {
      type: 'copy-command',
      command: { type: 'update-group', group: withoutFollower },
    });

    expect(response.status).toBe(200);
    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [11], optional: [22] });
    expect(runtime.reconfigureGroup).toHaveBeenCalledWith(expect.objectContaining({
      followers: [],
    }), { missingOptionalAccountIds: [22] });
    expect(running.status().group.followers).toEqual([]);
  });

  it('ownership waiver předá controlleru jen po explicitním UI commandu', async () => {
    const runtime = controller();
    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [22] }));
    running = await startLocalCopierExecutionAgent({
      controller: runtime,
      group: group(),
      port: 0,
      prepareGroupAccounts,
    });

    const response = await post(running, running.status().nonce, {
      type: 'copy-command',
      command: {
        type: 'update-group',
        group: { ...group(), followers: [] },
        waiveUnverifiableFollowerOwnership: true,
      },
    });

    expect(response.status).toBe(200);
    expect(runtime.reconfigureGroup).toHaveBeenCalledWith(
      expect.objectContaining({ followers: [] }),
      {
        missingOptionalAccountIds: [22],
        waiveUnverifiableFollowerOwnership: true,
      },
    );
  });

  it('dovolí nahradit zmizelého followera, ale nový follower zůstává required', async () => {
    const runtime = controller();
    const prepareGroupAccounts = vi.fn(async (request: PrepareGroupAccountsRequest) => {
      expect(request).toEqual({ required: [11, 33], optional: [22] });
      return { missingOptional: [22] };
    });
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
    });

    const response = await post(running, running.status().nonce, {
      type: 'copy-command',
      command: {
        type: 'update-group',
        group: { ...group(), followers: [{ accountId: 33, mode: 'on-submit', multiplier: 1 }] },
      },
    });

    expect(response.status).toBe(200);
    expect(runtime.reconfigureGroup).toHaveBeenCalledWith(expect.objectContaining({
      followers: [expect.objectContaining({ accountId: 33 })],
    }), { missingOptionalAccountIds: [22] });
  });

  it('odmítne routing výsledek, který by označil required účet jako chybějící optional', async () => {
    const runtime = controller();
    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [11] }));
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
    });

    const response = await post(running, running.status().nonce, {
      type: 'copy-command',
      command: { type: 'update-group', group: { ...group(), followers: [] } },
    });

    expect(response.status).toBe(409);
    expect(runtime.reconfigureGroup).not.toHaveBeenCalled();
  });

  it('zmizelý leader zůstává při routing change povinný', async () => {
    const runtime = controller();
    const prepareGroupAccounts = vi.fn(async (request: PrepareGroupAccountsRequest) => {
      expect(request.required).toContain(11);
      throw new Error('Účet 11 není viditelný v žádném připojeném OAuth');
    });
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
    });

    const response = await post(running, running.status().nonce, {
      type: 'copy-command',
      command: {
        type: 'update-group',
        group: {
          ...group(),
          leaderAccountId: 33,
          followers: [{ accountId: 22, mode: 'on-submit', multiplier: 1 }],
        },
      },
    });

    expect(response.status).toBe(409);
    expect(runtime.reconfigureGroup).not.toHaveBeenCalled();
  });

  it('zmizelý follower, který v next zůstává, není optional', async () => {
    const runtime = controller();
    const prepareGroupAccounts = vi.fn(async (request: PrepareGroupAccountsRequest) => {
      expect(request).toEqual({ required: [11, 22, 33], optional: [] });
      throw new Error('Účet 22 není viditelný v žádném připojeném OAuth');
    });
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
    });

    const response = await post(running, running.status().nonce, {
      type: 'copy-command',
      command: {
        type: 'update-group',
        group: {
          ...group(),
          followers: [
            ...group().followers,
            { accountId: 33, mode: 'on-submit', multiplier: 1 },
          ],
        },
      },
    });

    expect(response.status).toBe(409);
    expect(runtime.reconfigureGroup).not.toHaveBeenCalled();
  });

  it('changes the leader from UI through the safe epoch transition', async () => {
    const runtime = controller();
    const onGroupChanged = vi.fn(async () => undefined);
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0, onGroupChanged });
    const swapped = {
      ...group(),
      id: 'ui-test',
      leaderAccountId: 22,
      followers: [{ accountId: 11, mode: 'on-submit' as const, multiplier: 1 }],
    };

    const response = await post(running, running.status().nonce, {
      type: 'copy-command', command: { type: 'update-group', group: swapped },
    });

    expect(response.status).toBe(200);
    expect(runtime.reconfigureGroup).toHaveBeenCalledWith(expect.objectContaining({
      id: 'runtime-test',
      leaderAccountId: 22,
      followers: [expect.objectContaining({ accountId: 11 })],
    }), { missingOptionalAccountIds: [] });
    expect(runtime.updateGroup).not.toHaveBeenCalled();
    expect(running.status().group).toMatchObject({ leaderAccountId: 22 });
    expect(onGroupChanged).toHaveBeenCalledWith(expect.objectContaining({ leaderAccountId: 22 }));
  });

  it('aktivuje jiný uložený profil přes samostatný fail-closed příkaz a zůstane DISARMED', async () => {
    const runtime = controller();
    const onGroupChanged = vi.fn(async () => undefined);
    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [] }));
    running = await startLocalCopierExecutionAgent({
      controller: runtime,
      group: group(),
      port: 0,
      onGroupChanged,
      prepareGroupAccounts,
    });
    const next: CopyGroupConfig = {
      id: 'lucid-profile',
      name: 'Lucid profil',
      enabled: false,
      leaderAccountId: 33,
      followers: [{ accountId: 44, mode: 'on-submit', multiplier: 1 }],
      localOnly: true,
    };

    const result = await running.execute({ type: 'activate-group', group: next });

    expect(result.ok).toBe(true);
    expect(runtime.disarm).toHaveBeenCalled();
    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [11, 33, 44], optional: [22] });
    expect(vi.mocked(runtime.disarm).mock.invocationCallOrder[0])
      .toBeLessThan(prepareGroupAccounts.mock.invocationCallOrder[0]);
    expect(prepareGroupAccounts.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(runtime.activateGroup).mock.invocationCallOrder[0]);
    expect(runtime.activateGroup).toHaveBeenCalledWith(expect.objectContaining({
      ...next,
      enabled: true,
      localOnly: true,
      safety: expect.objectContaining({
        dailyMaxTrades: 0,
        tradingWindow: expect.objectContaining({ timeZone: 'Europe/Prague' }),
      }),
    }), { missingOptionalAccountIds: [] });
    expect(runtime.arm).not.toHaveBeenCalled();
    expect(running.status().controller.armed).toBe(false);
    expect(running.status().group).toMatchObject({ id: 'lucid-profile', enabled: true });
    expect(onGroupChanged).toHaveBeenCalledWith(expect.objectContaining({ id: 'lucid-profile' }));
  });

  it('rolls configuration back and remains disarmed when persistence fails', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({
      controller: runtime,
      group: group(),
      port: 0,
      onGroupChanged: async () => { throw new Error('disk-full'); },
    });
    const response = await post(running, running.status().nonce, {
      type: 'copy-command',
      command: { type: 'set-multiplier', groupId: 'runtime-test', accountId: 22, multiplier: 2 },
    });
    expect(response.status).toBe(409);
    expect(running.status().group.followers[0].multiplier).toBe(1);
    expect(runtime.updateGroup).toHaveBeenNthCalledWith(1, expect.objectContaining({
      followers: [expect.objectContaining({ multiplier: 2 })],
    }));
    expect(runtime.updateGroup).toHaveBeenNthCalledWith(2, expect.objectContaining({
      followers: [expect.objectContaining({ multiplier: 1 })],
    }));
  });

  it('rolls a leader epoch back through the same safe path when persistence fails', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({
      controller: runtime,
      group: group(),
      port: 0,
      onGroupChanged: async () => { throw new Error('disk-full'); },
    });
    const response = await post(running, running.status().nonce, {
      type: 'copy-command',
      command: {
        type: 'update-group',
        group: {
          ...group(),
          leaderAccountId: 22,
          followers: [{ accountId: 11, mode: 'on-submit', multiplier: 1 }],
        },
      },
    });

    expect(response.status).toBe(409);
    expect(running.status().group.leaderAccountId).toBe(11);
    expect(runtime.reconfigureGroup).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ leaderAccountId: 22 }),
      { missingOptionalAccountIds: [] },
    );
    expect(runtime.reconfigureGroup).toHaveBeenNthCalledWith(2, expect.objectContaining({ leaderAccountId: 11 }));
  });

  it('reconciles before ARM and remains disarmed when reconciliation fails', async () => {
    const runtime = controller();
    vi.mocked(runtime.reconcile).mockResolvedValueOnce({ divergentAccounts: [22], workingOrderAccounts: [] });
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const response = await post(running, running.status().nonce, { type: 'arm-live' });
    expect(response.status).toBe(409);
    expect(runtime.arm).not.toHaveBeenCalled();
  });

  it('před každým ARM obnoví routing a až potom provede reconciliation', async () => {
    const runtime = controller();
    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [] }));
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
    });

    const response = await post(running, running.status().nonce, { type: 'arm-live' });
    expect(response.status).toBe(200);
    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [11, 22], optional: [] });
    expect(prepareGroupAccounts.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(runtime.reconcile).mock.invocationCallOrder[0]);
    expect(vi.mocked(runtime.reconcile).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(runtime.arm).mock.invocationCallOrder[0]);
  });

  it('cíleně ověří účet bez změny execution skupiny nebo ARM', async () => {
    const runtime = controller();
    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [] }));
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
    });

    const result = await running.execute({ type: 'verify-account-eligibility', accountId: 63338752 });

    expect(result.ok).toBe(true);
    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [63338752], optional: [] });
    expect(prepareGroupAccounts.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(runtime.verifyAccountEligibility).mock.invocationCallOrder[0]);
    expect(runtime.verifyAccountEligibility).toHaveBeenCalledWith(63338752);
    expect(runtime.activateGroup).not.toHaveBeenCalled();
    expect(runtime.arm).not.toHaveBeenCalled();
  });

  it('executes the same serialized command path for the authenticated server relay', async () => {
    const runtime = controller();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const result = await running.execute({ type: 'shadow' });
    expect(result.ok).toBe(true);
    expect(result.status.controller).toMatchObject({ armed: true, shadowMode: true });
    expect(runtime.reconcile).toHaveBeenCalledTimes(1);
    expect(runtime.arm).toHaveBeenCalledWith({ shadowMode: true });
  });

  it('předá unlock-day controlleru bez jakéhokoli následného ARMu', async () => {
    const runtime = controller({ armed: false, dayLockUntil: Date.now() + 60_000 });
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });
    const result = await running.execute({ type: 'unlock-day', reason: 'Vědomé odemknutí dne' });
    expect(result.ok).toBe(true);
    expect(runtime.unlockDay).toHaveBeenCalledWith('Vědomé odemknutí dne');
    expect(runtime.arm).not.toHaveBeenCalled();
    expect(result.status.controller.armed).toBe(false);
  });

  it('exposes read-only reconciliation and audited stuck resolution as separate commands', async () => {
    const runtime = controller();
    const prepareGroupAccounts = vi.fn(async () => ({ missingOptional: [22] }));
    running = await startLocalCopierExecutionAgent({
      controller: runtime, group: group(), port: 0, prepareGroupAccounts,
    });

    expect((await post(running, running.status().nonce, { type: 'reconcile' })).status).toBe(200);
    expect(prepareGroupAccounts).toHaveBeenCalledWith({ required: [11], optional: [22] });
    expect(prepareGroupAccounts.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(runtime.reconcile).mock.invocationCallOrder[0]);
    expect(runtime.reconcile).toHaveBeenCalledTimes(1);
    expect(runtime.reconcile).toHaveBeenCalledWith({ missingOptionalAccountIds: [22] });

    expect((await post(running, running.status().nonce, {
      type: 'resolve-stuck-operation',
      kind: 'cancel-or-modify',
      key: 'cm:test:22',
      reason: 'ručně ověřeno proti brokerovi',
    })).status).toBe(200);
    expect(runtime.waiveStuckOperation).toHaveBeenCalledWith({
      kind: 'cancel-or-modify',
      key: 'cm:test:22',
      reason: 'ručně ověřeno proti brokerovi',
    });
  });

  it('resolve-stuck-operation projde i jako copy-command z LIVE UI', async () => {
    const runtime = controller();
    const testGroup = group();
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: testGroup, port: 0 });

    const response = await post(running, running.status().nonce, {
      type: 'copy-command',
      command: {
        type: 'resolve-stuck-operation',
        groupId: testGroup.id,
        kind: 'oso',
        key: 'oso:test:625378680572:62364057',
        reason: 'Ručně potvrzeno v LIVE UI (oso oso:test:625378680572:62364057)',
      },
    });
    expect(response.status).toBe(200);
    expect(runtime.waiveStuckOperation).toHaveBeenCalledWith({
      kind: 'oso',
      key: 'oso:test:625378680572:62364057',
      reason: 'Ručně potvrzeno v LIVE UI (oso oso:test:625378680572:62364057)',
    });
  });

  it('keeps SHADOW disarmed when reconciliation finds divergence or working orders', async () => {
    const runtime = controller();
    vi.mocked(runtime.reconcile).mockResolvedValueOnce({ divergentAccounts: [], workingOrderAccounts: [22] });
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: group(), port: 0 });

    await expect(running.execute({ type: 'shadow' })).rejects.toThrow('SHADOW odmítnut');
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
    // Pairing confirmation alone must not freeze risk-reducing ingress while
    // the pilot is waiting for its final fresh flat check.
    await expect(running.execute({ type: 'disarm' })).resolves.toMatchObject({ ok: true });
    expect(runtime.disarm).toHaveBeenCalled();
  });

  it('odmítne pairing restart bez čerstvého connected, reconciled a flat stavu', async () => {
    const runtime = controller();
    vi.mocked(runtime.status).mockReturnValue({
      ...runtime.status(),
      groupFlat: false,
    });
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

    await expect(running.execute({
      type: 'device-paired',
      deviceId: '00000000-0000-4000-8000-000000000001',
    })).rejects.toThrow('připojený, reconciled, DISARMED, flat');
    expect(onDevicePaired).not.toHaveBeenCalled();
  });

  it('pairs multiple OAuth devices independently and keeps the primary compatibility field', async () => {
    const runtime = controller();
    const onDevicePaired = vi.fn(async () => undefined);
    running = await startLocalCopierExecutionAgent({
      controller: runtime,
      group: group(),
      port: 0,
      devices: [
        {
          state: 'paired', deviceId: 'device-one', connectionId: 'connection-one', deviceName: 'Primary Mac',
        },
        {
          state: 'pairing-required', deviceId: 'device-two', connectionId: 'connection-two', deviceName: 'Second OAuth',
          deviceSecret: 'pair-secret', publicKey: 'pair-key',
        },
      ],
      onDevicePaired,
    });
    expect(running.status().device).toMatchObject({ deviceId: 'device-one' });
    expect(running.status().devices).toHaveLength(2);
    const result = await running.execute({ type: 'device-paired', deviceId: 'device-two' });
    expect(result.status.devices?.[1]).toEqual({
      state: 'paired', deviceId: 'device-two', connectionId: 'connection-two', deviceName: 'Second OAuth',
    });
    expect(onDevicePaired).toHaveBeenCalledWith('device-two');
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
      command: { type: 'flatten-account', groupId: 'runtime-test', accountId: 22, operationId: 'e2e-flatten-one-001' },
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
      command: { type: 'flatten-group', groupId: 'runtime-test', operationId: 'e2e-flatten-all-001' },
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

describe('atomický arm-live s konfigurací', () => {
  it('arm-live s group nejdřív synchronizuje konfiguraci, pak reconcile a ARM', async () => {
    const runtime = controller();
    const saved: CopyGroupConfig[] = [];
    const agent = await startLocalCopierExecutionAgent({
      controller: runtime,
      group: group(),
      onGroupChanged: async changed => { saved.push(changed); },
    });
    try {
      const next: CopyGroupConfig = {
        ...group(),
        followers: [{ accountId: 22, mode: 'on-submit', multiplier: 2 }],
      };
      const result = await agent.execute({ type: 'arm-live', group: next });
      expect(result.ok).toBe(true);
      // Konfigurace prošla před ARMem a durable persist proběhl.
      expect(runtime.updateGroup).toHaveBeenCalled();
      expect(saved).toHaveLength(1);
      expect(saved[0].followers[0].multiplier).toBe(2);
      expect(runtime.reconcile).toHaveBeenCalled();
      expect(runtime.arm).toHaveBeenCalledWith(expect.objectContaining({ shadowMode: false }));
      expect(agent.status().group.followers[0].multiplier).toBe(2);
    } finally {
      await agent.close();
    }
  });

  it('arm-live před reconciliation durable předá jen safety exclusions', async () => {
    const runtime = controller();
    const agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group() });
    try {
      await agent.execute({
        type: 'arm-live',
        group: group(),
        accountEligibilityExclusions: [{
          accountId: 22,
          state: 'dll-locked',
          reason: 'LIVE denní P&L dosáhlo DLL',
        }],
      });
      expect(runtime.applyAccountEligibilityExclusions).toHaveBeenCalledWith([{
        accountId: 22,
        state: 'dll-locked',
        reason: 'LIVE denní P&L dosáhlo DLL',
      }]);
      expect(runtime.applyAccountEligibilityExclusions.mock.invocationCallOrder[0])
        .toBeLessThan(runtime.reconcile.mock.invocationCallOrder[0]);
    } finally {
      await agent.close();
    }
  });

  it('odmítne active nebo účet mimo runtime skupinu ještě před ARM', async () => {
    const runtime = controller();
    const agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group() });
    try {
      await expect(agent.execute({
        type: 'arm-live',
        group: group(),
        accountEligibilityExclusions: [{ accountId: 22, state: 'active', reason: 'nepovoleno' }],
      } as never)).rejects.toThrow('nepovolený stav');
      expect(runtime.arm).not.toHaveBeenCalled();
    } finally {
      await agent.close();
    }
  });

  it('arm-live bez group armuje beze změny konfigurace', async () => {
    const runtime = controller();
    const agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group() });
    try {
      await agent.execute({ type: 'arm-live' });
      expect(runtime.updateGroup).not.toHaveBeenCalled();
      expect(runtime.arm).toHaveBeenCalled();
    } finally {
      await agent.close();
    }
  });

  it('arm-live přepne jiný čistý profil výhradně přes activate-group preflight a až potom ARM', async () => {
    const runtime = controller();
    const agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group() });
    try {
      await agent.execute({
        type: 'arm-live',
        group: { ...group(), id: 'jiny-profil' },
      });
      expect(runtime.disarm).toHaveBeenCalled();
      expect(runtime.activateGroup).toHaveBeenCalledWith(expect.objectContaining({
        id: 'jiny-profil', enabled: true,
      }), { missingOptionalAccountIds: [] });
      expect(runtime.activateGroup.mock.invocationCallOrder[0])
        .toBeLessThan(runtime.reconcile.mock.invocationCallOrder[0]);
      expect(runtime.reconcile.mock.invocationCallOrder[0])
        .toBeLessThan(runtime.arm.mock.invocationCallOrder[0]);
      expect(agent.status().group.id).toBe('jiny-profil');
    } finally {
      await agent.close();
    }
  });

  it('arm-live zůstane DISARMED, když bezpečný preflight jiného profilu selže', async () => {
    const runtime = controller();
    runtime.activateGroup.mockRejectedValueOnce(new Error('working=22'));
    const agent = await startLocalCopierExecutionAgent({ controller: runtime, group: group() });
    try {
      await expect(agent.execute({
        type: 'arm-live',
        group: { ...group(), id: 'jiny-profil' },
      })).rejects.toThrow('working=22');
      expect(runtime.disarm).toHaveBeenCalled();
      expect(runtime.reconcile).not.toHaveBeenCalled();
      expect(runtime.arm).not.toHaveBeenCalled();
      expect(agent.status().group.id).toBe('runtime-test');
    } finally {
      await agent.close();
    }
  });
});
