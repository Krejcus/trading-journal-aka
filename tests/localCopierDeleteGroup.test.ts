import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLocalCopierExecutionAgent, type LocalCopierExecutionAgent, type PrepareGroupAccountsRequest } from '../server/localCopierExecutionAgent';
import { createBrokerRouter } from '../services/brokerRouter';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';
import { copierWorkerExecutionGroup, supportsCopierGroupDelete } from '../lib/copierWorkerCapabilities';

// 11. 10. 2026: „Smazat skupinu“ u skupiny workeru. Agent zjistí, které účty
// OAuth nevrací, controller skupinu smaže a worker běží bez skupiny, dokud UI
// nezapne jinou (nebo tutéž jako čerstvou skupinu).

const deadGroup = (): CopyGroupConfig => ({
  id: 'dvsvds', name: 'dvsvds', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1, enabled: false },
    { accountId: 300, mode: 'on-submit', multiplier: 1 },
  ],
  localOnly: true,
});
const newGroup = (): CopyGroupConfig => ({
  id: 'nova', name: 'Nová', enabled: true, leaderAccountId: 400,
  followers: [{ accountId: 500, mode: 'on-submit', multiplier: 1 }],
  localOnly: true,
});

let running: LocalCopierExecutionAgent | null = null;
afterEach(async () => { await running?.close(); running = null; });

async function setup(options: { incident?: boolean } = {}) {
  const connection = createMockBroker();
  const visible = new Set([200, 400, 500]);
  const router = createBrokerRouter([{ broker: connection, accountIds: [...visible] }]);
  const snapshot = emptySnapshot();
  if (options.incident) {
    snapshot.safety = {
      ...snapshot.safety!,
      manualRecoveryRequired: { at: 42, reason: 'follower 200 má pozici 4, leader 0', id: 'incident-1' },
    };
  }
  let now = 1_000_000;
  const runtime = await bootstrapCopierRuntime({
    broker: router, store: createMemoryCopierStore(snapshot), group: deadGroup(), clock: () => ++now,
    unusableGroupRepairBootstrap: { groupId: 'dvsvds', unavailableAccountIds: [100, 300] },
  });
  connection.setConnected(true);
  await runtime.waitForIdle();
  const routing = (request: PrepareGroupAccountsRequest) => {
    for (const accountId of request.required) {
      if (!visible.has(accountId)) throw new Error(`Účet ${accountId} není viditelný v žádném připojeném OAuth.`);
    }
    return {
      missingOptional: request.optional.filter(accountId => !visible.has(accountId)),
      inactiveOptional: [] as number[],
    };
  };
  const previewGroupAccounts = vi.fn(async (request: PrepareGroupAccountsRequest) => routing(request));
  const prepareGroupAccounts = vi.fn(async (request: PrepareGroupAccountsRequest) => routing(request));
  running = await startLocalCopierExecutionAgent({
    controller: runtime, group: deadGroup(), port: 0, autoRearmAfterTransport: false,
    previewGroupAccounts, prepareGroupAccounts,
  });
  return { connection, runtime, previewGroupAccounts, prepareGroupAccounts };
}

const deleteGroup = (groupId = 'dvsvds') => running!.execute({
  type: 'copy-command', command: { type: 'delete-group', groupId },
});

describe('agent: smazání skupiny workeru', () => {
  it('smaže skupinu, chybějící účty pozná z OAuth a UI ji přestane brát jako execution skupinu', async () => {
    const h = await setup();
    expect(supportsCopierGroupDelete(running!.status())).toBe(true);
    const retire = vi.spyOn(h.runtime, 'retireGroup');
    const result = await deleteGroup();
    expect(retire).toHaveBeenCalledWith(expect.objectContaining({
      missingAccountIds: [100, 300], inactiveAccountIds: [],
    }));
    expect(h.previewGroupAccounts).toHaveBeenCalledWith({
      required: [], optional: [100, 200, 300], inactiveOptionalAsMissing: true,
    });
    expect(h.prepareGroupAccounts).toHaveBeenCalledWith({ required: [200], optional: [] });
    expect(result.status.controller).toMatchObject({
      armed: false, retiredGroup: { groupId: 'dvsvds' }, startupGroupRepair: null, lastError: null,
    });
    expect(copierWorkerExecutionGroup(result.status)).toBeNull();
    // Opakované smazání (druhé zařízení, retry relaye) projde bez účinku.
    await deleteGroup();
  });

  it('po smazání odmítne úpravy i Flatten staré skupiny', async () => {
    await setup();
    await deleteGroup();
    for (const command of [
      { type: 'update-group' as const, group: deadGroup() },
      { type: 'set-multiplier' as const, groupId: 'dvsvds', accountId: 300, multiplier: 2 },
      { type: 'flatten-group' as const, groupId: 'dvsvds', operationId: 'op-flatten-1' },
    ]) {
      await expect(running!.execute({ type: 'copy-command', command })).rejects.toThrow('Skupina byla smazána');
    }
  });

  it('zapnutí jiné skupiny ze stavu bez skupiny ji aktivuje a zapne', async () => {
    const h = await setup();
    await deleteGroup();
    await running!.execute({ type: 'arm-live', group: newGroup() });
    expect(h.runtime.status()).toMatchObject({ armed: true, retiredGroup: null });
    expect(running!.status().group.id).toBe('nova');
    expect(copierWorkerExecutionGroup(running!.status())?.id).toBe('nova');
  });

  it('zapnutí bez skupiny bez nové konfigurace nic nezapne', async () => {
    const h = await setup();
    await deleteGroup();
    await expect(running!.execute({ type: 'arm-live' })).rejects.toThrow('Skupina byla smazána');
    expect(h.runtime.status().armed).toBe(false);
  });

  it('po smazání skupiny s incidentem vyžaduje ON nové skupiny jeho potvrzení', async () => {
    const h = await setup({ incident: true });
    await deleteGroup();
    expect(h.runtime.status().manualRecovery?.id).toBe('incident-1');
    await expect(running!.execute({ type: 'arm-live', group: newGroup() })).rejects.toThrow('vyžaduje tvoje potvrzení');
    expect(h.runtime.status().armed).toBe(false);
    await running!.execute({ type: 'arm-live', group: newGroup(), acknowledgeIncidentId: 'incident-1' });
    expect(h.runtime.status()).toMatchObject({ armed: true, manualRecovery: null });
  });

  it('jinou skupinu ani zapnutou kopírku smazat nejde', async () => {
    const h = await setup();
    await expect(deleteGroup('cizi')).rejects.toThrow('jinou skupinu');
    expect(h.runtime.status().retiredGroup).toBeNull();
    await deleteGroup();
    await running!.execute({ type: 'arm-live', group: newGroup() });
    expect(h.runtime.status().armed).toBe(true);
    await expect(deleteGroup('nova')).rejects.toThrow('dokud kopírka jede');
    expect(h.runtime.status()).toMatchObject({ armed: true, retiredGroup: null });
  });
});
