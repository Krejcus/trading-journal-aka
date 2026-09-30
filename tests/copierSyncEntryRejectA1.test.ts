import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from './_laMock';

const SYM = 'MNQU6';
const group: CopyGroupConfig = {
  id: 'probe-a-v17', name: 'probe A v17', enabled: true, leaderAccountId: 100,
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

// Review 30. 9. 2026, A1: synchronní reject vstupu jednoho followera po
// dřívějším obchodu na symbolu vypnul skupinu a auto-close zavřel i zdravé
// followery (V17 platil jen pro první obchod). Follower se má vyřadit jen
// z této epizody, skupina zůstane ARMED a v dalším obchodu vstoupí znovu.
describe('A1: synchronní reject vstupu followera po dřívějším obchodu', () => {
  it.each([false, true])('druhý obchod: broker synchronně odmítne followera 200 (dřívější obchod=%s)', async earlierTrade => {
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
    const audit: any[] = [];
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock,
      onAudit: entries => audit.push(...entries),
    });
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
      if (earlierTrade) {
        await leaderTrade(broker, controller, order({ brokerOrderId: 'e1' }), 1, 'e1f');
        await tick(20_000);
        await leaderTrade(broker, controller, order({ brokerOrderId: 'x1', side: 'Sell' }), 0, 'x1f');
        await tick(20_000);
        expect(await pos(200)).toBe(0);
        expect(await pos(300)).toBe(0);
        expect(controller.status().armed).toBe(true);
      }
      rejectEntryFor200 = true;
      await leaderTrade(broker, controller, order({ brokerOrderId: 'e2' }), 1, 'e2f');
      await tick(3_000);
      await new Promise(r => setTimeout(r, 50));
      await controller.waitForIdle();
      const result = {
        earlierTrade,
        armed: controller.status().armed,
        lastError: controller.status().lastError,
        f200: await pos(200),
        f300: await pos(300),
        liquidations: broker.liquidateRequests().map((r: any) => r.accountId),
        sells: broker.placedRequests().filter((r: any) => r.side === 'Sell').map((r: any) => `${r.accountId}:${r.quantity}`),
      };
      expect(result).toMatchObject({ armed: true, f200: 0, f300: 1, liquidations: [] });

      // Exit leadera: zdravý 300 vystoupí, vyřazený 200 se přeskočí.
      rejectEntryFor200 = false;
      await leaderTrade(broker, controller, order({ brokerOrderId: 'x2', side: 'Sell' }), 0, 'x2f');
      await tick(20_000);
      expect(await pos(300)).toBe(0);
      expect(await pos(200)).toBe(0);
      expect(controller.status().armed).toBe(true);

      // Další obchod: vyřazení platilo jen pro minulou epizodu.
      await leaderTrade(broker, controller, order({ brokerOrderId: 'e3' }), 1, 'e3f');
      await tick(3_000);
      expect(await pos(200)).toBe(1);
      expect(await pos(300)).toBe(1);
      expect(controller.status().armed).toBe(true);
    } finally {
      controller.stop();
    }
  });
});
