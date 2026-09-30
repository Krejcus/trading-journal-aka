// Ověřovací review 30. 9. (D1): cizí fill v mezeře nesmí vysvětlit změnu followera.
import { describe, expect, it } from 'vitest';
import type { BrokerEvent, BrokerOrder } from '../services/brokerPort';
import { createBrokerRouter } from '../services/brokerRouter';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';
import { createMockBroker as createLeaderMockBroker } from './_laMock';

const SYM = 'MNQU6';
const group: CopyGroupConfig = {
  id: 'g', name: 'G', enabled: true, leaderAccountId: 100,
  followers: [200, 300].map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
};
const order = (x: Partial<BrokerOrder>): BrokerOrder => ({
  tag: '', brokerOrderId: 'x', accountId: 100, symbol: SYM, side: 'Buy', orderType: 'Market',
  quantity: 1, filledQuantity: 0, status: 'working', sourceVersion: '1', updatedAt: 1, ...x,
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('V3 D1 probe: sidelined (zero-suppressed) follower manually entered during router gap', () => {
  it('should be a route-gap divergence', async () => {
    let now = 1_000_000;
    const leader = createLeaderMockBroker({ behavior: r => r.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' } });
    let reject200 = false;
    const follower = createMockBroker({ nativeLiquidate: true, clock: () => now, behavior: request => {
      if (reject200 && request.accountId === 200 && request.side === 'Buy') return { kind: 'reject', reason: 'Exceeds max position size' };
      return request.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' };
    } } as any);
    const router = createBrokerRouter([
      { broker: leader, accountIds: [100], critical: true },
      { broker: follower, accountIds: [200, 300], critical: false },
    ], { reconnectGraceMs: 10_000 });
    const controller = await bootstrapCopierRuntime({ broker: router, store: createMemoryCopierStore(), group, clock: () => ++now });
    const pos = async (b: any, a: number) => (await b.listPositions(a)).find((p: any) => p.symbol === SYM)?.netQuantity ?? 0;
    try {
      leader.setConnected(true); follower.setConnected(true);
      await controller.waitForIdle(); await controller.reconcile(); controller.arm();
      reject200 = true;
      const e = order({ brokerOrderId: 'e1' });
      leader.emitEvent({ type: 'order', order: e });
      await controller.waitForIdle();
      leader.emitEvent({ type: 'order', order: { ...e, status: 'filled', filledQuantity: 1, sourceVersion: 'f' } });
      leader.emitEvent({ type: 'fill', fill: { fillId: 'e1f', tag: '', brokerOrderId: 'e1', accountId: 100, symbol: SYM, side: 'Buy', quantity: 1, price: 30_500, filledAt: 1 } });
      leader.setPosition(100, SYM, 1);
      leader.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 1 } });
      await controller.waitForIdle();
      now += 3_000; leader.emitEvent({ type: 'heartbeat', at: now } as any); await controller.waitForIdle(); await sleep(50); await controller.waitForIdle();
      expect(controller.status().armed).toBe(true);
      // Router grace gap on follower route; user manually buys 1 on sidelined 200.
      follower.setConnected(false);
      follower.setPosition(200, SYM, 1);
      const orders300 = follower.orders().filter(o => o.accountId === 300 && (o.status === 'working'));
      follower.emitEvent({
        type: 'connection', connected: true, at: now, resynced: true, reconnected: true,
        resync: {
          accountIds: [200, 300], complete: true,
          orders: orders300.map(o => ({ ...o })),
          positions: [{ accountId: 200, symbol: SYM, netQuantity: 1 }, { accountId: 300, symbol: SYM, netQuantity: 1 }],
          gapFills: [{ fillId: 'manual1', tag: '', brokerOrderId: 'MANUAL', accountId: 200, symbol: SYM, side: 'Buy', quantity: 1, price: 30_600, filledAt: now }],
        },
      } as BrokerEvent);
      await controller.waitForIdle(); await sleep(100); await controller.waitForIdle();
      const st = controller.status();
      follower.setConnected(true);
      await controller.waitForIdle(); await sleep(50); await controller.waitForIdle();
      // Leader exits
      const x = order({ brokerOrderId: 'x1', side: 'Sell' });
      leader.emitEvent({ type: 'order', order: x });
      await controller.waitForIdle();
      leader.emitEvent({ type: 'order', order: { ...x, status: 'filled', filledQuantity: 1, sourceVersion: 'f' } });
      leader.emitEvent({ type: 'fill', fill: { fillId: 'x1f', tag: '', brokerOrderId: 'x1', accountId: 100, symbol: SYM, side: 'Sell', quantity: 1, price: 30_500, filledAt: 2 } });
      leader.setPosition(100, SYM, 0);
      leader.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 0 } });
      await controller.waitForIdle(); await sleep(2_500); await controller.waitForIdle();
      expect(st.armed).toBe(false);
    } finally {
      controller.stop();
    }
  });
});
