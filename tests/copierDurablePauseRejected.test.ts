// Etapa 2 (6. 10. 2026): vyřazení followera po odmítnutém vstupu je durable.
import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { createBrokerRouter } from '../services/brokerRouter';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';
import { createMockBroker as createLeaderMockBroker } from './_laMock';

const SYM = 'MNQZ6';
const group: CopyGroupConfig = {
  id: 'g', name: 'G', enabled: true, leaderAccountId: 100,
  followers: [200, 300].map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
};
const order = (x: Partial<BrokerOrder>): BrokerOrder => ({
  tag: '', brokerOrderId: 'x', accountId: 100, symbol: SYM, side: 'Buy', orderType: 'Market',
  quantity: 1, filledQuantity: 0, status: 'working', sourceVersion: '1', updatedAt: 1, ...x,
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('etapa 2 — odmítnutý vstup followera', () => {
  it('vyřazení z epizody se zapíše jako durable pauza a ukáže se ve stavu', async () => {
    let now = 1_000_000;
    const leader = createLeaderMockBroker({ behavior: r => r.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' } });
    const follower = createMockBroker({ clock: () => now, behavior: request => {
      if (request.accountId === 200 && request.side === 'Buy') return { kind: 'reject', reason: 'Exceeds max position size' };
      return request.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' };
    } });
    const router = createBrokerRouter([
      { broker: leader, accountIds: [100], critical: true },
      { broker: follower, accountIds: [200, 300], critical: false },
    ], { reconnectGraceMs: 10_000 });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({ broker: router, store, group, clock: () => ++now });
    try {
      leader.setConnected(true); follower.setConnected(true);
      await controller.waitForIdle(); await controller.reconcile(); controller.arm();
      const entry = order({ brokerOrderId: 'e1' });
      leader.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      leader.emitEvent({ type: 'order', order: { ...entry, status: 'filled', filledQuantity: 1, sourceVersion: 'f' } });
      leader.emitEvent({ type: 'fill', fill: { fillId: 'e1f', tag: '', brokerOrderId: 'e1', accountId: 100, symbol: SYM, side: 'Buy', quantity: 1, price: 30_500, filledAt: 1 } });
      leader.setPosition(100, SYM, 1);
      leader.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 1 } });
      await controller.waitForIdle(); await sleep(50); await controller.waitForIdle();
      expect(controller.status().armed).toBe(true);
      expect((await store.load()).safety?.accountSyncPauses).toEqual([
        expect.objectContaining({ accountId: 200, symbol: SYM, reasonCode: 'entry-rejected', leaderEntryOrderId: 'e1' }),
      ]);
      expect(controller.status().accountSyncPauses).toEqual([
        expect.objectContaining({ accountId: 200, symbol: SYM, reasonCode: 'entry-rejected' }),
      ]);
    } finally {
      controller.stop();
    }
  });
});
