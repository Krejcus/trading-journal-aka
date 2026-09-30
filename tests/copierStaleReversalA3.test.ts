import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from './_laMock';


const SYM = 'MNQU6';
const group = (followers = [200, 300]): CopyGroupConfig => ({
  id: 'probe-a', name: 'probe A', enabled: true, leaderAccountId: 100,
  followers: followers.map(accountId => ({ accountId, mode: 'on-submit', multiplier: 1 })),
});
const order = (patch: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-order', accountId: 100, symbol: SYM, side: 'Buy',
  orderType: 'Market', quantity: 2, filledQuantity: 0,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...patch,
});

async function leaderFill(broker: any, controller: any, source: BrokerOrder, net: number, fillId: string) {
  broker.emitEvent({ type: 'order', order: { ...source, status: 'filled', filledQuantity: source.quantity, sourceVersion: `f:${fillId}` } });
  broker.emitEvent({ type: 'fill', fill: {
    fillId, tag: '', brokerOrderId: source.brokerOrderId, accountId: 100, symbol: SYM,
    side: source.side, quantity: source.quantity, price: 30_500, filledAt: 1,
  } });
  broker.setPosition(100, SYM, net);
  broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: net } });
  await controller.waitForIdle();
}

// Review 30. 9. 2026, A3: leader reversal (Market Sell 4 z long 2) zdržený
// ve frontě přes 5 s se zablokoval celý včetně exitu. Followeři zůstali long,
// leader short a nic je nezavřelo. Exit slice teď odejde, pozdě se nekopíruje
// jen vstupní část a kopírka se potom vypne.
describe('A3: zpožděný reversal leadera', () => {
  it.each([6_000, 0])('reversal Market Sell 4 (long 2 -> short 2) delayed %i ms in the queue', async delay => {
    let now = 1_000_000;
    const clock = () => ++now;
    const broker: any = createMockBroker({ behavior: r => r.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' } });
    const audit: any[] = [];
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: group(), clock,
      onAudit: entries => audit.push(...entries),
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      const entry = order({ brokerOrderId: 'entry' });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      await leaderFill(broker, controller, entry, 2, 'entry-fill');
      now += 20_000;
      broker.emitEvent({ type: 'heartbeat', at: now });
      await controller.waitForIdle();
      const pos = async (a: number) => (await broker.listPositions(a)).find((p: any) => p.symbol === SYM)?.netQuantity ?? 0;
      expect(await pos(200)).toBe(2);
      expect(await pos(300)).toBe(2);

      // Leader reverses; the event sat 6 s behind a slow sweep/S1b in eventTail.
      const reverse = order({ brokerOrderId: 'reverse', side: 'Sell', quantity: 4 });
      broker.emitEvent({ type: 'order', order: reverse, receivedAt: now - delay } as any);
      await controller.waitForIdle();
      await leaderFill(broker, controller, reverse, -2, 'reverse-fill');
      for (let i = 0; i < 12; i += 1) {
        now += 5_000;
        broker.emitEvent({ type: 'heartbeat', at: now });
        await controller.waitForIdle();
        await new Promise(r => setTimeout(r, 20));
      }

      const result = {
        armed: controller.status().armed,
        lastError: controller.status().lastError,
        follower200: await pos(200),
        follower300: await pos(300),
        leader: await pos(100),
        sells: broker.placedRequests().filter((r: any) => r.side === 'Sell').map((r: any) => `${r.accountId}:${r.quantity}`),
        liquidations: broker.liquidateRequests().length,
      };
      if (delay > 0) {
        expect(result).toMatchObject({
          follower200: 0, follower300: 0, leader: -2, armed: false,
          lastError: expect.stringContaining('followerům odešel jen exit'),
        });
        expect(audit.some(entry => String(entry.reason).startsWith('stale-exposure-increase-entry-slice:'))).toBe(true);
      } else {
        expect(result).toMatchObject({ follower200: -2, follower300: -2, armed: true });
      }
    } finally {
      controller.stop();
    }
  });
});
