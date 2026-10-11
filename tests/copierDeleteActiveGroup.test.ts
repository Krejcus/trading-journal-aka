import { describe, expect, it, vi } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { createBrokerRouter } from '../services/brokerRouter';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker as createRawMockBroker } from '../services/mockBroker';
import { createMockBroker } from './_laMock';

// 11. 10. 2026: všechny účty skupiny dvsvds breachly a zmizely z OAuth. Worker
// držel skupinu v režimu opravy a smazat ji nešlo. Smazání skupiny workeru je
// teď jen za DISARMED, bez broker zápisu; worker pak běží bez skupiny, dokud
// se neaktivuje jiná.

const SYM = 'MNQZ6';
const deadGroup: CopyGroupConfig = {
  id: 'dvsvds', name: 'dvsvds', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1, enabled: false },
    { accountId: 300, mode: 'on-submit', multiplier: 1 },
  ],
};
const healthyGroup: CopyGroupConfig = {
  id: 'hlavni', name: 'Hlavní', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
};
const newGroup: CopyGroupConfig = {
  id: 'nova', name: 'Nová', enabled: true, leaderAccountId: 400,
  followers: [{ accountId: 500, mode: 'on-submit', multiplier: 1 }],
};
const reason = 'Uživatel v appce smazal skupinu dvsvds';
const stepClock = () => {
  let now = 1_000_000;
  return () => ++now;
};
const order = (patch: Partial<BrokerOrder>): BrokerOrder => ({
  tag: '', brokerOrderId: 'x', accountId: 100, symbol: SYM, side: 'Buy', orderType: 'Market',
  quantity: 1, filledQuantity: 0, status: 'working', sourceVersion: '1', updatedAt: 1, ...patch,
});

/** Leader 100 a follower 300 v OAuth nejsou; 200 (vypnutý follower) a nové účty ano. */
async function bootDeadGroup(store = createMemoryCopierStore(), repair = true) {
  const connection = createRawMockBroker();
  const router = createBrokerRouter([{ broker: connection, accountIds: [200, 400, 500] }]);
  const controller = await bootstrapCopierRuntime({
    broker: router, store, group: deadGroup, clock: stepClock(),
    ...(repair ? { unusableGroupRepairBootstrap: { groupId: deadGroup.id, unavailableAccountIds: [100, 300] } } : {}),
  });
  connection.setConnected(true);
  await controller.waitForIdle();
  return { connection, controller, store };
}

async function bootHealthy(
  behavior?: Parameters<typeof createMockBroker>[0],
  store = createMemoryCopierStore(),
  onLeaderEvent?: () => void,
) {
  const broker = createMockBroker(behavior);
  const controller = await bootstrapCopierRuntime({
    broker, store, group: healthyGroup, clock: stepClock(), onLeaderEvent,
    followerTransitionCorrelationWindowMs: 10,
    copierSettlementQuietMs: 5,
    copierSettlementMinAgeMs: 0,
    copierSettlementTerminalAgeMs: 0,
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  return { broker, controller, store };
}

describe('smazání skupiny workeru', () => {
  it('skupinu s breachnutými účty smaže bez broker zápisu a worker běží bez skupiny', async () => {
    const { connection, controller, store } = await bootDeadGroup();
    const placeOrder = vi.spyOn(connection, 'placeOrder');
    const cancelOrder = vi.spyOn(connection, 'cancelOrder');
    try {
      // Ruční pozice na viditelném účtu bez stopy kopírky smazání nebrání.
      connection.setPosition(200, SYM, 2);
      expect(controller.status().startupGroupRepair).not.toBeNull();

      await controller.retireGroup({ reason, missingAccountIds: [100, 300] });

      expect(placeOrder).not.toHaveBeenCalled();
      expect(cancelOrder).not.toHaveBeenCalled();
      expect((await connection.listPositions(200))[0]?.netQuantity).toBe(2);
      expect(controller.status()).toMatchObject({
        armed: false,
        retiredGroup: { groupId: 'dvsvds' },
        startupGroupRepair: null,
        lastError: null,
        reconciliationRequired: false,
        groupFlat: true,
        divergentAccounts: [],
        workingOrderAccounts: [],
        exposure: null,
        followerParticipation: [],
        armPreparation: { state: 'blocked', blockedBy: 'configuration' },
      });
      expect((await store.load()).safety?.retiredGroup).toMatchObject({ groupId: 'dvsvds', reason });
      expect(() => controller.arm()).toThrow('skupina byla smazána');
      await expect(controller.reconcile()).rejects.toThrow('nemá skupinu');
      await expect(controller.flattenGroup('op-delete-1')).rejects.toThrow('nemá skupinu');
      // Opakované smazání je bez účinku.
      await controller.retireGroup({ reason, missingAccountIds: [100, 300] });
      expect(controller.status().retiredGroup?.groupId).toBe('dvsvds');
    } finally {
      controller.stop();
    }
  });

  it('restart po smazání naběhne bez skupiny i bez režimu opravy a bez pádu na chybějícím leaderovi', async () => {
    const first = await bootDeadGroup();
    await first.controller.retireGroup({ reason, missingAccountIds: [100, 300] });
    first.controller.stop();

    const { controller } = await bootDeadGroup(first.store, false);
    try {
      expect(controller.status()).toMatchObject({
        armed: false,
        retiredGroup: { groupId: 'dvsvds' },
        startupGroupRepair: null,
        lastError: null,
        reconciliationRequired: false,
        groupFlat: true,
      });
      expect(() => controller.arm()).toThrow('skupina byla smazána');
    } finally {
      controller.stop();
    }
  });

  it('po smazání jde aktivovat a zapnout novou skupinu; značka zmizí ve stejném commitu', async () => {
    const { connection, controller, store } = await bootDeadGroup();
    try {
      await controller.retireGroup({ reason, missingAccountIds: [100, 300] });
      const listPositions = vi.spyOn(connection, 'listPositions');
      await controller.activateGroup(newGroup);
      expect(listPositions).toHaveBeenCalledWith(400);
      expect(listPositions).toHaveBeenCalledWith(500);
      // Staré účty se při aktivaci z „bez skupiny“ vůbec nečtou.
      expect(listPositions).not.toHaveBeenCalledWith(200);
      expect(controller.status().retiredGroup).toBeNull();
      expect((await store.load()).safety?.retiredGroup).toBeUndefined();
      await controller.reconcile();
      controller.arm();
      expect(controller.status().armed).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it('aktivace nové skupiny po smazání vyžaduje její účty flat; jinak zůstane bez skupiny', async () => {
    const { connection, controller } = await bootDeadGroup();
    try {
      await controller.retireGroup({ reason, missingAccountIds: [100, 300] });
      connection.setPosition(500, SYM, 1);
      await expect(controller.activateGroup(newGroup)).rejects.toThrow('nonFlat=500');
      expect(controller.status().retiredGroup?.groupId).toBe('dvsvds');
      expect(() => controller.arm()).toThrow('skupina byla smazána');
    } finally {
      controller.stop();
    }
  });

  it('obchodní event účtu nové skupiny během aktivace z „bez skupiny“ aktivaci odmítne', async () => {
    const { connection, controller } = await bootDeadGroup();
    try {
      await controller.retireGroup({ reason, missingAccountIds: [100, 300] });
      const read = connection.listPositions.bind(connection);
      let injected = false;
      vi.spyOn(connection, 'listPositions').mockImplementation(async accountId => {
        const positions = await read(accountId);
        if (!injected && accountId === 400) {
          injected = true;
          connection.emitEvent({ type: 'position', position: { accountId: 400, symbol: SYM, netQuantity: 1 } });
        }
        return positions;
      });
      await expect(controller.activateGroup(newGroup)).rejects.toThrow('stav se změnil');
      expect(injected).toBe(true);
      expect(controller.status().retiredGroup?.groupId).toBe('dvsvds');
    } finally {
      controller.stop();
    }
  });

  it('ze stavu bez skupiny nejde skupinu jen upravit, jen aktivovat', async () => {
    const { controller } = await bootDeadGroup();
    try {
      await controller.retireGroup({ reason, missingAccountIds: [100, 300] });
      await expect(controller.reconfigureGroup(newGroup)).rejects.toThrow('nemá skupinu');
      expect(() => controller.updateGroup(deadGroup)).toThrow('nemá skupinu');
      expect(controller.status().retiredGroup?.groupId).toBe('dvsvds');
    } finally {
      controller.stop();
    }
  });

  it('zapnutou kopírku smazat nejde a nic se nevypne', async () => {
    const { controller } = await bootHealthy();
    try {
      controller.arm();
      await expect(controller.retireGroup({ reason, missingAccountIds: [] })).rejects.toThrow('dokud kopírka jede');
      expect(controller.status()).toMatchObject({ armed: true, retiredGroup: null });
    } finally {
      controller.stop();
    }
  });

  it('viditelný účet s otevřenou kopií kopírky smazání blokuje a smazání nezanechá incident', async () => {
    const { broker, controller } = await bootHealthy({ behavior: () => ({ kind: 'fill', price: 30_000 }) });
    try {
      controller.arm();
      const entry = order({ brokerOrderId: 'entry' });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      broker.setPosition(100, SYM, 1);
      broker.emitEvent({ type: 'order', order: { ...entry, status: 'filled', filledQuantity: 1, sourceVersion: '2' } });
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'f1', tag: '', brokerOrderId: 'entry', accountId: 100, symbol: SYM, side: 'Buy', quantity: 1, price: 30_000, filledAt: 1,
      } });
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 1 } });
      await controller.waitForIdle();
      expect((await broker.listPositions(200))[0]?.netQuantity).toBe(1);
      controller.disarm();
      const lastErrorBefore = controller.status().lastError;
      await expect(controller.retireGroup({ reason, missingAccountIds: [] })).rejects.toThrow(/nonFlat=.*200/);
      expect(controller.status()).toMatchObject({ retiredGroup: null, lastError: lastErrorBefore });
    } finally {
      controller.stop();
    }
  });

  it('účet chybějící v OAuth lze vyřadit, i když na něm kopírka měla kopii', async () => {
    const { broker, controller } = await bootHealthy({ behavior: () => ({ kind: 'fill', price: 30_000 }) });
    try {
      controller.arm();
      broker.emitEvent({ type: 'order', order: order({ brokerOrderId: 'limit', orderType: 'Limit', limitPrice: 29_000 }) });
      await controller.waitForIdle();
      expect((await broker.listPositions(200))[0]?.netQuantity).toBe(1);
      controller.disarm();
      await controller.waitForIdle();
      // Neaktivní (ale viditelný) účet může držet pozici: se stopou kopírky ne.
      await expect(controller.retireGroup({ reason, missingAccountIds: [200], inactiveAccountIds: [200] }))
        .rejects.toThrow('neaktivní');
      // Bez rozlišení agentem se bere konzervativně jako neaktivní.
      await expect(controller.retireGroup({ reason, missingAccountIds: [200] })).rejects.toThrow('neaktivní');
      expect(controller.status().retiredGroup).toBeNull();
      // Agent ho v OAuth vůbec nenašel (breach): auditované vyřazení bez flat důkazu.
      await controller.retireGroup({ reason, missingAccountIds: [200], inactiveAccountIds: [] });
      expect(controller.status().retiredGroup?.groupId).toBe('hlavni');
    } finally {
      controller.stop();
    }
  });

  it('bez skupiny se obchodní eventy starých účtů nezpracují', async () => {
    const onLeaderEvent = vi.fn();
    const { broker, controller } = await bootHealthy(undefined, createMemoryCopierStore(), onLeaderEvent);
    try {
      await controller.retireGroup({ reason, missingAccountIds: [] });
      onLeaderEvent.mockClear();
      // Heartbeat bez skupiny dokládá jen liveness: žádný risk poll starých účtů.
      const riskPoll = vi.spyOn(broker, 'listAccountRiskSnapshots');
      broker.emitEvent({ type: 'heartbeat', at: Date.now() });
      await controller.waitForIdle();
      expect(riskPoll).not.toHaveBeenCalled();
      broker.setPosition(100, SYM, 3);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 3 } });
      broker.emitEvent({ type: 'order', order: order({ brokerOrderId: 'manual', status: 'working' }) });
      await controller.waitForIdle();
      expect(controller.status()).toMatchObject({
        lastError: null,
        reconciliationRequired: false,
        divergentAccounts: [],
        workingOrderAccounts: [],
        exposure: null,
        groupFlat: true,
        manualRecovery: null,
      });
      expect(onLeaderEvent).not.toHaveBeenCalled();
    } finally {
      controller.stop();
    }
  });

  it('výpadek spojení bez skupiny nic nečte a po návratu spojení nezůstane chyba', async () => {
    const { broker, controller } = await bootHealthy();
    try {
      await controller.retireGroup({ reason, missingAccountIds: [] });
      const listPositions = vi.spyOn(broker, 'listPositions');
      broker.emitEvent({ type: 'error', error: new Error('Tradovate WebSocket transport error'), at: Date.now() });
      broker.setConnected(false);
      await controller.waitForIdle();
      expect(controller.status().lastError).toContain('transport error');
      broker.setConnected(true);
      await controller.waitForIdle();
      expect(controller.status()).toMatchObject({ connected: true, lastError: null, reconciliationRequired: false });
      expect(listPositions).not.toHaveBeenCalled();
    } finally {
      controller.stop();
    }
  });

  it('smazanou skupinu jde znovu aktivovat se stejným ID jako čerstvou skupinu', async () => {
    const { controller } = await bootHealthy();
    try {
      await controller.retireGroup({ reason, missingAccountIds: [] });
      await controller.activateGroup(healthyGroup);
      expect(controller.status().retiredGroup).toBeNull();
      await controller.reconcile();
      controller.arm();
      expect(controller.status().armed).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it('durable incident smazání nemaže; ON nové skupiny ho dál vyžaduje potvrdit', async () => {
    const snapshot = emptySnapshot();
    const incident = { at: 42, reason: 'follower 200 má pozici 4, leader 0', id: 'incident-1' };
    snapshot.safety = { ...snapshot.safety!, manualRecoveryRequired: { ...incident } };
    const store = createMemoryCopierStore(snapshot);
    const { controller } = await bootHealthy(undefined, store);
    try {
      await controller.retireGroup({ reason, missingAccountIds: [] });
      expect(controller.status()).toMatchObject({
        retiredGroup: { groupId: 'hlavni' },
        lastError: null,
        manualRecovery: { id: 'incident-1' },
      });
      expect((await store.load()).safety?.manualRecoveryRequired).toMatchObject({ id: 'incident-1' });
    } finally {
      controller.stop();
    }
  });
});

describe('start pilota se smazanou skupinou', () => {
  it('bez skupiny startuje jen při značce přesně uložené skupiny', async () => {
    const { isRetiredDurableGroup } = await import('../services/copierPilotGroup');
    expect(isRetiredDurableGroup(deadGroup, { retiredGroup: { groupId: 'dvsvds', at: 5 } })).toBe(true);
    expect(isRetiredDurableGroup(deadGroup, { retiredGroup: { groupId: 'jina', at: 5 } })).toBe(false);
    // Poškozená značka (bez času) se nepoužije — shodně s bootstrapem controlleru.
    expect(isRetiredDurableGroup(deadGroup, { retiredGroup: { groupId: 'dvsvds' } })).toBe(false);
    expect(isRetiredDurableGroup(deadGroup, {})).toBe(false);
    expect(isRetiredDurableGroup(deadGroup, null)).toBe(false);
    // Bez uložené skupiny (první instalace) se značka nepoužije.
    expect(isRetiredDurableGroup(null, { retiredGroup: { groupId: 'dvsvds' } })).toBe(false);
  });
});
