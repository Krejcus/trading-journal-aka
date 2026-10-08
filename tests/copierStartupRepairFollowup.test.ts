import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLocalCopierExecutionAgent, type LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';
import { createBrokerRouter } from '../services/brokerRouter';
import {
  bootstrapCopierRuntime,
  type CopierControllerStatus,
  type CopierRuntimeController,
} from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import {
  refreshDynamicBrokerRoutes,
  resolveDynamicBrokerRoutes,
  type DynamicOAuthConnection,
} from '../services/dynamicBrokerRouting';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';
import type { TradovateVisibleAccount } from '../services/tradovateBroker';

// Review 30. 9. 2026 (E1–E3, E6, C4): režim opravy po startu v běžném
// případě nefungoval. Oprava ponechávající starého followera padla na
// routingu (účet současně required i optional), breached účet viditelný jako
// neaktivní nešel vyřadit, restart s otevřenou kopií zablokoval opravu přes
// connection recovery a jediný ARM z telefonu provedl vyřazení i ARM naráz.

const brokenGroup = (): CopyGroupConfig => ({
  id: 'hlavni', name: 'Hlavní', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-submit', multiplier: 1 },
  ],
  localOnly: true,
});
const keepFollower = (): CopyGroupConfig => ({
  ...brokenGroup(), leaderAccountId: 400, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
});

const mockController = () => {
  const status: CopierControllerStatus = {
    started: true, armed: false, killSwitch: false, shadowMode: true, connected: true,
    reconciliationRequired: true, divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false,
    stuckOperations: [], lastError: 'Uložená skupina má nedostupné účty (100, 300)', revision: 1,
    lastSequence: 0, groupFlat: true,
    startupGroupRepair: { groupId: 'hlavni', unavailableAccountIds: [100, 300] },
  };
  const value = {
    arm: vi.fn(), disarm: vi.fn(), engageKillSwitch: vi.fn(), beginShutdown: vi.fn(async () => undefined),
    lockUntil: vi.fn(async () => undefined), unlockDay: vi.fn(async () => undefined),
    applyAccountEligibilityExclusions: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => ({ divergentAccounts: [], workingOrderAccounts: [] })),
    verifyAccountEligibility: vi.fn(), activateGroup: vi.fn(async () => undefined),
    reconfigureGroup: vi.fn(async () => undefined), updateGroup: vi.fn(async () => undefined),
    preflightGroupChange: vi.fn(), updateGroupMetadata: vi.fn(),
    flattenAccount: vi.fn(), flattenFollowerTrade: vi.fn(), flattenGroup: vi.fn(),
    waiveStuckOperation: vi.fn(),
    status: vi.fn(() => status), waitForIdle: vi.fn(async () => undefined), stop: vi.fn(),
  };
  return value as typeof value & CopierRuntimeController;
};

const visible = (id: number, active = true): TradovateVisibleAccount => ({
  accountId: id, accountSpec: `ACC${id}`, active, canTrade: true,
} as TradovateVisibleAccount);
const connection = (directory: () => TradovateVisibleAccount[]) => ({
  connectionId: 'c1',
  broker: { refreshAccountDirectory: async () => directory() },
} as unknown as DynamicOAuthConnection);
// Stejné zapojení jako scripts/copier/pilot.ts: skutečný routing nad adresáři OAuth.
const productionRouting = (directory: () => TradovateVisibleAccount[]) => {
  const oauth = connection(directory);
  const router = { replaceRoutes: vi.fn() } as never;
  return {
    prepareGroupAccounts: vi.fn(async (request: Parameters<typeof refreshDynamicBrokerRoutes>[2]) => (
      { missingOptional: (await refreshDynamicBrokerRoutes([oauth], router, request)).missingOptional }
    )),
    previewGroupAccounts: vi.fn(async (request: Parameters<typeof refreshDynamicBrokerRoutes>[2]) => (
      { missingOptional: (await refreshDynamicBrokerRoutes([oauth], router, request)).missingOptional }
    )),
  };
};

let running: LocalCopierExecutionAgent | null = null;
afterEach(async () => { await running?.close(); running = null; });

describe('režim opravy po startu: navazující opravy', () => {
  it('E1: oprava ponechávající zdravého starého followera projde produkčním routingem', async () => {
    const runtime = mockController();
    const routing = productionRouting(() => [visible(200), visible(400)]);
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: brokenGroup(), port: 0, ...routing });
    await running.execute({ type: 'copy-command', command: { type: 'update-group', group: keepFollower() } });
    expect(routing.prepareGroupAccounts).toHaveBeenCalledWith({
      required: [200, 400], optional: [100, 300], inactiveOptionalAsMissing: false,
    });
    expect(runtime.activateGroup).toHaveBeenCalledWith(
      expect.objectContaining({ leaderAccountId: 400 }),
      expect.objectContaining({
        missingOptionalAccountIds: [300],
        retireMissingOldGroup: expect.objectContaining({ accountIds: [100, 300] }),
      }),
    );
  });

  it('C4: breached účet viditelný jako neaktivní jde vyřadit, jinde routing dál blokuje', () => {
    const oauth = connection(() => []);
    const snapshots = new Map([['c1', [visible(100, false), visible(400)]]]);
    expect(resolveDynamicBrokerRoutes([oauth], snapshots, {
      required: [400], optional: [100], inactiveOptionalAsMissing: true,
    }).missingOptional).toEqual([100]);
    expect(() => resolveDynamicBrokerRoutes([oauth], snapshots, { required: [400], optional: [100] }))
      .toThrow('není u Tradovate aktivní');
  });

  it('E3: účty znovu dostupné po výpadku při startu → rada restartovat worker, ne je odebrat', async () => {
    const runtime = mockController();
    const routing = productionRouting(() => [100, 200, 300, 400].map(id => visible(id)));
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: brokenGroup(), port: 0, ...routing });
    await expect(running.execute({
      type: 'copy-command', command: { type: 'update-group', group: { ...brokenGroup(), name: 'Hlavní 2' } },
    })).rejects.toThrow('Restartuj Mac worker');
    expect(runtime.activateGroup).not.toHaveBeenCalled();
  });

  it('E6: ARM se skupinou v režimu opravy nic nevyřadí ani nezapne', async () => {
    const runtime = mockController();
    const routing = productionRouting(() => [visible(200), visible(400)]);
    running = await startLocalCopierExecutionAgent({ controller: runtime, group: brokenGroup(), port: 0, ...routing });
    await expect(running.execute({
      type: 'arm-live', group: keepFollower(), accountEligibilityExclusions: [],
    } as never)).rejects.toThrow('Nejdřív ulož opravenou skupinu');
    expect(runtime.activateGroup).not.toHaveBeenCalled();
    expect(runtime.arm).not.toHaveBeenCalled();
  });

  it('E2: restart s durable stopou živé kopie nezablokuje opravu přes connection recovery', async () => {
    const initial = emptySnapshot();
    initial.safety = { entryCooldownUntil: 0, dayLockUntil: 0, liveCopyOpenSince: 1 };
    const broker = createMockBroker();
    const router = createBrokerRouter([{ broker, accountIds: [200, 400, 500] }]);
    let now = 1_000;
    const controller = await bootstrapCopierRuntime({
      broker: router, store: createMemoryCopierStore(initial), group: brokenGroup(), clock: () => ++now,
      wait: async () => undefined,
      resolveMissingOptionalAccountIds: async () => { throw new Error('Účet 100 není viditelný v žádném připojeném OAuth'); },
      unusableGroupRepairBootstrap: { groupId: 'hlavni', unavailableAccountIds: [100, 300] },
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      expect(controller.status().startupGroupRepair).not.toBeNull();
      await controller.activateGroup({
        ...brokenGroup(), leaderAccountId: 400, followers: [{ accountId: 500, mode: 'on-submit', multiplier: 1 }],
      }, {
        missingOptionalAccountIds: [300],
        retireMissingOldGroup: {
          groupId: 'hlavni', accountIds: [100, 300],
          reason: 'UI oprava skupiny po startu: účty 100, 300 nejsou v OAuth (breached)',
        },
      });
      expect(controller.status()).toMatchObject({ armed: false, startupGroupRepair: null });
    } finally {
      controller.stop();
    }
  });
});
