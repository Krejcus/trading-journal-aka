import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from './_laMock';

const SYM = 'MNQU6';
const group: CopyGroupConfig = {
  id: 'probe-a-v18', name: 'probe A v18', enabled: true, leaderAccountId: 100,
  followers: [200, 300].map(accountId => ({ accountId, mode: 'on-submit', multiplier: 1 })),
};
const order = (patch: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-order', accountId: 100, symbol: SYM, side: 'Buy',
  orderType: 'Market', quantity: 1, filledQuantity: 0,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...patch,
});

async function leaderTrade(broker: any, controller: any, source: BrokerOrder, net: number, fillId: string) {
  broker.emitEvent({ type: 'order', order: source });
  await controller.waitForIdle();
  broker.emitEvent({ type: 'order', order: { ...source, status: 'filled', filledQuantity: source.quantity, sourceVersion: `f:${fillId}` } });
  broker.emitEvent({ type: 'fill', fill: {
    fillId, tag: '', brokerOrderId: source.brokerOrderId, accountId: 100, symbol: SYM,
    side: source.side, quantity: source.quantity, price: 30_500, filledAt: 1,
  } });
  broker.setPosition(100, SYM, net);
  broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: net } });
  await controller.waitForIdle();
}

// Review 30. 9. 2026, A2: nulová výjimka vyřazeného followera (V17 reject
// vstupu) zanikla při jakékoli další události jeho účtu, i neškodné. Nový SL
// leadera pak nedostal nikdo a skupina se vypnula se zdravým followerem bez SL.
describe('A2: vyřazený follower a neškodné události jeho účtu', () => {
  it.each(['none', 'position-resend', 'rejected-order-late-ws'] as const)('po vyřazení + %s dostane zdravý follower 300 SL leadera', async extra => {
    let now = 1_000_000;
    const clock = () => ++now;
    let rejectEntryFor200 = false;
    const broker: any = createMockBroker({
      behavior: request => {
        if (rejectEntryFor200 && request.accountId === 200 && request.side === 'Buy') {
          return { kind: 'reject', reason: 'Exceeds max position size' };
        }
        return request.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' };
      },
    });
    const controller = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group, clock });
    const tick = async (ms: number) => {
      now += ms;
      broker.emitEvent({ type: 'heartbeat', at: now });
      await controller.waitForIdle();
    };
    const pos = async (a: number) => (await broker.listPositions(a)).find((p: any) => p.symbol === SYM)?.netQuantity ?? 0;
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      rejectEntryFor200 = true;
      await leaderTrade(broker, controller, order({ brokerOrderId: 'e2' }), 1, 'e2f');
      await tick(3_000);
      expect(controller.status().armed).toBe(true);
      expect(await pos(300)).toBe(1);
      if (extra === 'position-resend') {
        broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYM, netQuantity: 0 } });
        await controller.waitForIdle();
      } else if (extra === 'rejected-order-late-ws') {
        const rejected = broker.orders().find((o: BrokerOrder) => o.accountId === 200 && o.status === 'rejected');
        broker.emitEvent({ type: 'order', order: { ...rejected, sourceVersion: 'ws-late' } });
        await controller.waitForIdle();
      }
      await tick(1_000);
      // Leader adds a standalone protective stop.
      broker.emitEvent({ type: 'order', order: order({
        brokerOrderId: 'sl', side: 'Sell', orderType: 'Stop', stopPrice: 30_400,
      }) });
      await controller.waitForIdle();
      await tick(3_000);
      const stops300 = broker.orders().filter((o: BrokerOrder) => o.accountId === 300 && o.orderType === 'Stop' && o.status === 'working').length;
      const result = { extra, armed: controller.status().armed, lastError: controller.status().lastError, stops300, f300: await pos(300) };
      expect(result.stops300).toBe(1);
      expect(result.armed).toBe(true);
    } finally {
      controller.stop();
    }
  });
  it('skutečná pozice na vyřazeném účtu výjimku dál zneplatní a kopírka se vypne', async () => {
    let now = 1_000_000;
    const clock = () => ++now;
    let rejectEntryFor200 = false;
    const broker: any = createMockBroker({
      behavior: request => {
        if (rejectEntryFor200 && request.accountId === 200 && request.side === 'Buy') {
          return { kind: 'reject', reason: 'Exceeds max position size' };
        }
        return request.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' };
      },
    });
    const controller = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group, clock });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      rejectEntryFor200 = true;
      await leaderTrade(broker, controller, order({ brokerOrderId: 'e2' }), 1, 'e2f');
      now += 3_000;
      broker.emitEvent({ type: 'heartbeat', at: now });
      await controller.waitForIdle();
      expect(controller.status().armed).toBe(true);
      // Ruční vstup na vyřazeném followerovi: už nejde o neškodnou událost.
      broker.setPosition(200, SYM, 2);
      broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYM, netQuantity: 2 } });
      await controller.waitForIdle();
      broker.emitEvent({ type: 'order', order: order({
        brokerOrderId: 'sl', side: 'Sell', orderType: 'Stop', stopPrice: 30_400,
      }) });
      await controller.waitForIdle();
      expect(controller.status().armed).toBe(false);
    } finally {
      controller.stop();
    }
  });
});
