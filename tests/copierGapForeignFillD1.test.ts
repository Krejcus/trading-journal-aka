// Ověřovací review 30. 9. (D1): cizí fill v mezeře nesmí vysvětlit změnu followera.
import { describe, expect, it } from 'vitest';
import type { BrokerEvent, BrokerOrder } from '../services/brokerPort';
import { createBrokerRouter } from '../services/brokerRouter';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';
import { createMockBroker as createLeaderMockBroker } from './_laMock';

const group: CopyGroupConfig = {
  id: 'g', name: 'G', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
};
const order = (x: Partial<BrokerOrder>): BrokerOrder => ({
  tag: '', brokerOrderId: 'x', accountId: 100, symbol: 'MNQU6', side: 'Buy', orderType: 'Limit', limitPrice: 29_900,
  quantity: 1, filledQuantity: 0, status: 'working', updatedAt: 1_500, ...x,
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('V3 D1 probe: foreign gap fill lands on leader target while own copy still working', () => {
  it('should be a route-gap divergence', async () => {
    const leader = createLeaderMockBroker({ nativeLiquidate: true });
    const follower = createMockBroker({ nativeLiquidate: true, behavior: () => ({ kind: 'working' }) });
    const router = createBrokerRouter([
      { broker: leader, accountIds: [100], critical: true },
      { broker: follower, accountIds: [200], critical: false },
    ], { reconnectGraceMs: 10_000 });
    let now = 1_000;
    const controller = await bootstrapCopierRuntime({
      broker: router, store: createMemoryCopierStore(), group, clock: () => ++now,
      followerTransitionCorrelationWindowMs: 2_000,
    });
    try {
      leader.setConnected(true);
      follower.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      leader.emitEvent({ type: 'order', order: order({ brokerOrderId: 'L1', sourceVersion: 'a' }) });
      await controller.waitForIdle(); await sleep(20); await controller.waitForIdle();
      const copy = follower.orders().find(item => item.accountId === 200)!;
      expect(copy.status).toBe('working');

      leader.setPosition(100, 'MNQU6', 1);
      leader.emitEvent({ type: 'order', order: order({ brokerOrderId: 'L1', status: 'filled', filledQuantity: 1, sourceVersion: 'b' }) });
      leader.emitEvent({ type: 'fill', fill: {
        fillId: 'lf1', tag: '', brokerOrderId: 'L1', accountId: 100, symbol: 'MNQU6',
        side: 'Buy', quantity: 1, price: 30_000, filledAt: 2_000,
      } });
      leader.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
      await controller.waitForIdle(); await sleep(50); await controller.waitForIdle();
      follower.setConnected(false);
      // In the gap a FOREIGN (manual) order MANUAL fills Buy 1; our copy is still working.
      follower.setPosition(200, 'MNQU6', 1);
      follower.emitEvent({
        type: 'connection', connected: true, at: 5_000, resynced: true, reconnected: true,
        resync: {
          accountIds: [200], complete: true,
          orders: [{ ...copy }],
          positions: [{ accountId: 200, symbol: 'MNQU6', netQuantity: 1 }],
          gapFills: [{
            fillId: 'fx1', tag: '', brokerOrderId: 'MANUAL', accountId: 200, symbol: 'MNQU6',
            side: 'Buy', quantity: 1, price: 30_000, filledAt: 4_000,
          }],
        },
      } as BrokerEvent);
      await controller.waitForIdle(); await sleep(50); await controller.waitForIdle();
      const status = controller.status();
      // eslint-disable-next-line no-console
      // Our own copy now fills too (it was never cancelled).
      Object.assign(copy, { status: 'filled', filledQuantity: 1, sourceVersion: 'cf' });
      follower.setPosition(200, 'MNQU6', 2);
      follower.emitEvent({ type: 'order', order: { ...copy } });
      follower.emitEvent({ type: 'fill', fill: { fillId: 'cf1', tag: copy.tag, brokerOrderId: copy.brokerOrderId, accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 29_900, filledAt: 6_000 } });
      follower.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 2 } });
      await controller.waitForIdle(); await sleep(3_000); await controller.waitForIdle();
      const after = controller.status();
      expect(status.armed).toBe(false);
    } finally {
      controller.stop();
    }
  });
});
