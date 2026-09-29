import { describe, expect, it, vi } from 'vitest';
import { createBrokerRouter } from '../services/brokerRouter';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';

// 29. 9. 2026: breached leader 66142378 a tři breached followeři shodili nový
// worker do launchd crash loopu. Worker má naběhnout DISARMED v režimu opravy
// a dovolit vyřadit právě nedostupné účty, zatímco dostupné projdou kontrolou.
const brokenGroup: CopyGroupConfig = {
  id: 'hlavni', name: 'Hlavní', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-submit', multiplier: 1 },
  ],
};
const repairedGroup: CopyGroupConfig = {
  ...brokenGroup,
  leaderAccountId: 400,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 500, mode: 'on-submit', multiplier: 1 },
  ],
};
const stepClock = () => {
  let now = 1_000;
  return () => ++now;
};
const reason = 'UI oprava skupiny po startu: účty 100, 300 nejsou v OAuth (breached)';

async function bootRepairMode() {
  const connection = createMockBroker();
  const listPositions = vi.spyOn(connection, 'listPositions');
  const router = createBrokerRouter([{ broker: connection, accountIds: [200, 400, 500] }]);
  const controller = await bootstrapCopierRuntime({
    broker: router, store: createMemoryCopierStore(), group: brokenGroup, clock: stepClock(),
    unusableGroupRepairBootstrap: { groupId: brokenGroup.id, unavailableAccountIds: [300, 100] },
  });
  connection.setConnected(true);
  await controller.waitForIdle();
  return { connection, controller, listPositions };
}

describe('start s částečně nedostupnou uloženou skupinou', () => {
  it('naběhne DISARMED v režimu opravy, ARM blokuje a po vyřazení nedostupných účtů jde zapnout', async () => {
    const { controller, listPositions } = await bootRepairMode();
    try {
      expect(controller.status()).toMatchObject({
        armed: false,
        startupGroupRepair: { groupId: 'hlavni', unavailableAccountIds: [100, 300] },
        lastError: expect.stringContaining('nedostupné účty (100, 300)'),
      });
      expect(() => controller.arm()).toThrow('nedostupné účty (100, 300)');

      listPositions.mockClear();
      await controller.activateGroup(repairedGroup, {
        missingOptionalAccountIds: [300],
        retireMissingOldGroup: { groupId: 'hlavni', accountIds: [100, 300], reason },
      });
      expect(listPositions).toHaveBeenCalledWith(200);
      expect(listPositions).toHaveBeenCalledWith(400);
      expect(listPositions).not.toHaveBeenCalledWith(100);
      expect(listPositions).not.toHaveBeenCalledWith(300);
      expect(controller.status().startupGroupRepair).toBeNull();
      await controller.reconcile();
      controller.arm();
      expect(controller.status().armed).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it('vyřadit smí jen přesně účty nedostupné při startu, ne dostupného followera', async () => {
    const { controller } = await bootRepairMode();
    try {
      await expect(controller.activateGroup({ ...repairedGroup, followers: [{ accountId: 500, mode: 'on-submit', multiplier: 1 }] }, {
        missingOptionalAccountIds: [200, 300],
        retireMissingOldGroup: { groupId: 'hlavni', accountIds: [100, 200, 300], reason },
      })).rejects.toThrow();
      await expect(controller.activateGroup(repairedGroup, {
        missingOptionalAccountIds: [],
        retireMissingOldGroup: { groupId: 'hlavni', accountIds: [100], reason },
      })).rejects.toThrow();
      expect(controller.status()).toMatchObject({
        armed: false,
        startupGroupRepair: { unavailableAccountIds: [100, 300] },
      });
    } finally {
      controller.stop();
    }
  });

  it('režim opravy jiné skupiny chybějícího leadera nepovolí', async () => {
    const connection = createMockBroker();
    const router = createBrokerRouter([{ broker: connection, accountIds: [200, 400, 500] }]);
    await expect(bootstrapCopierRuntime({
      broker: router, store: createMemoryCopierStore(), group: brokenGroup, clock: stepClock(),
      unusableGroupRepairBootstrap: { groupId: 'jina', unavailableAccountIds: [100, 300] },
    })).rejects.toThrow('Pro účet 100 není nakonfigurované OAuth spojení');
  });
});
