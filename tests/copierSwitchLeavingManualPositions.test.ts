import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from './_laMock';

// 5. 10. 2026: Filip měl na dvou followerech vypnuté skupiny ruční obchody
// a novou skupinu s jinými účty nešlo zapnout. Odcházející účet bez kopie
// kopírky přepnutí neblokuje; účty nové skupiny a účty s kopií ano.

const SYM = 'MNQZ6';
const oldGroup: CopyGroupConfig = {
  id: 'hlavni', name: 'Hlavní', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-submit', multiplier: 1 },
  ],
};
const newGroup: CopyGroupConfig = {
  id: 'fundednext', name: 'FundedNext', enabled: true, leaderAccountId: 400,
  followers: [{ accountId: 500, mode: 'on-submit', multiplier: 1 }],
};
const order = (patch: Partial<BrokerOrder>): BrokerOrder => ({
  tag: '', brokerOrderId: 'x', accountId: 100, symbol: SYM, side: 'Buy', orderType: 'Market',
  quantity: 1, filledQuantity: 0, status: 'working', sourceVersion: '1', updatedAt: 1, ...patch,
});

async function boot(behavior?: Parameters<typeof createMockBroker>[0]) {
  let now = 1_000_000;
  const broker = createMockBroker(behavior);
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(), group: oldGroup, clock: () => ++now,
    followerTransitionCorrelationWindowMs: 10,
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  return { broker, controller };
}

describe('přepnutí skupiny a ruční pozice na odcházejících účtech', () => {
  it('ruční pozice na followerovi vypnuté skupiny přepnutí neblokuje a nová skupina jde zapnout', async () => {
    const { broker, controller } = await boot();
    try {
      // Ruční obchod mimo kopírku (DISARMED) na dvou followerech staré skupiny.
      broker.setPosition(200, SYM, 1);
      broker.setPosition(300, SYM, -2);
      broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYM, netQuantity: 1 } });
      broker.emitEvent({ type: 'position', position: { accountId: 300, symbol: SYM, netQuantity: -2 } });
      await controller.waitForIdle();
      await new Promise(resolve => setTimeout(resolve, 50));
      await controller.waitForIdle();
      expect(controller.status().reconciliationRequired).toBe(true);
      await controller.activateGroup(newGroup);
      await controller.reconcile();
      controller.arm();
      expect(controller.status().armed).toBe(true);
      // Ruční pozice zůstaly netknuté.
      expect((await broker.listPositions(200))[0]?.netQuantity).toBe(1);
      expect((await broker.listPositions(300))[0]?.netQuantity).toBe(-2);
    } finally {
      controller.stop();
    }
  });

  it('ruční pozice na účtu nové skupiny přepnutí dál blokuje', async () => {
    const { broker, controller } = await boot();
    try {
      broker.setPosition(500, SYM, 1);
      await expect(controller.activateGroup(newGroup)).rejects.toThrow('nonFlat=500');
    } finally {
      controller.stop();
    }
  });

  it('otevřená kopie kopírky na odcházejícím followerovi přepnutí blokuje', async () => {
    const { broker, controller } = await boot({ behavior: () => ({ kind: 'fill', price: 30_000 }) });
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
      await expect(controller.activateGroup(newGroup)).rejects.toThrow(/nonFlat=.*200/);
    } finally {
      controller.stop();
    }
  });

  it('pracovní příkaz kopírky na odcházejícím followerovi přepnutí blokuje', async () => {
    const { broker, controller } = await boot({ behavior: () => ({ kind: 'working' }) });
    try {
      controller.arm();
      broker.emitEvent({ type: 'order', order: order({ brokerOrderId: 'limit', orderType: 'Limit', limitPrice: 29_000 }) });
      await controller.waitForIdle();
      expect(broker.orders().some(item => item.accountId === 200 && item.status === 'working')).toBe(true);
      controller.disarm();
      await expect(controller.activateGroup(newGroup)).rejects.toThrow(/200/);
    } finally {
      controller.stop();
    }
  });
});
