import { describe, expect, it } from 'vitest';
import type { BrokerEvent, BrokerOrder } from '../services/brokerPort';
import { createBrokerRouter } from '../services/brokerRouter';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';

// Review 30. 9. 2026, D1: skutečný výpadek follower route kratší než
// reconnect lhůta routeru (10 s) controller vůbec neviděl. Když se follower
// v mezeře zavřel, exit leadera ho otočil do opačné pozice a kopírka zůstala
// ARMED bez chyby. Broker teď po skutečném reconnectu vrací route snapshot
// a router ho v lhůtě předá controlleru k porovnání s modelem.

const group: CopyGroupConfig = {
  id: 'g', name: 'G', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
};
const order = (x: Partial<BrokerOrder>): BrokerOrder => ({
  tag: '', brokerOrderId: 'x', accountId: 100, symbol: 'MNQU6', side: 'Buy', orderType: 'Market',
  quantity: 1, filledQuantity: 0, status: 'working', updatedAt: 1_500, ...x,
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const reconnectSnapshot = (netQuantity: number): BrokerEvent => ({
  type: 'connection', connected: true, at: 5_000, resynced: true, reconnected: true,
  resync: {
    accountIds: [200],
    positions: netQuantity === 0 ? [] : [{ accountId: 200, symbol: 'MNQU6', netQuantity }],
    orders: [],
    gapFills: netQuantity === 0 ? [{
      fillId: 'ff9', tag: '', brokerOrderId: 'FSL', accountId: 200, symbol: 'MNQU6',
      side: 'Sell', quantity: 1, price: 29_900, filledAt: 4_000,
    }] : [],
    complete: true,
  },
});

async function armedWithCopiedEntry() {
  const leader = createMockBroker({ nativeLiquidate: true });
  const follower = createMockBroker({ nativeLiquidate: true, behavior: () => ({ kind: 'fill', price: 30_000 }) });
  const router = createBrokerRouter([
    { broker: leader, accountIds: [100], critical: true },
    { broker: follower, accountIds: [200], critical: false },
  ], { reconnectGraceMs: 10_000 });
  let now = 1_000;
  const controller = await bootstrapCopierRuntime({
    broker: router, store: createMemoryCopierStore(), group, clock: () => ++now,
  });
  leader.setConnected(true);
  follower.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  leader.emitEvent({ type: 'order', order: order({ brokerOrderId: 'L1', sourceVersion: 'a' }) });
  await controller.waitForIdle(); await sleep(20); await controller.waitForIdle();
  leader.setPosition(100, 'MNQU6', 1);
  leader.emitEvent({ type: 'order', order: order({ brokerOrderId: 'L1', status: 'filled', filledQuantity: 1, sourceVersion: 'b' }) });
  leader.emitEvent({ type: 'fill', fill: {
    fillId: 'lf1', tag: '', brokerOrderId: 'L1', accountId: 100, symbol: 'MNQU6',
    side: 'Buy', quantity: 1, price: 30_000, filledAt: 2_000,
  } });
  leader.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
  await controller.waitForIdle(); await sleep(20); await controller.waitForIdle();
  expect(controller.status().armed).toBe(true);
  expect((await follower.listPositions(200)).find(p => p.symbol === 'MNQU6')?.netQuantity).toBe(1);
  return { leader, follower, controller };
}

describe('D1: skutečný reconnect follower route v reconnect lhůtě', () => {
  it('follower zavřený v mezeře: snapshot vypne kopírku a exit leadera ho neotočí', async () => {
    const { leader, follower, controller } = await armedWithCopiedEntry();
    try {
      follower.setConnected(false);
      follower.setPosition(200, 'MNQU6', 0);
      follower.emitEvent(reconnectSnapshot(0));
      await controller.waitForIdle(); await sleep(20); await controller.waitForIdle();
      expect(controller.status()).toMatchObject({
        armed: false,
        connected: true,
        lastError: expect.stringContaining('route-gap-divergence'),
      });

      const placedBefore = follower.placedRequests().length;
      leader.emitEvent({ type: 'order', order: order({ brokerOrderId: 'L2', side: 'Sell', sourceVersion: 'c' }) });
      await controller.waitForIdle(); await sleep(50); await controller.waitForIdle();
      expect(follower.placedRequests().slice(placedBefore)).toEqual([]);
      expect((await follower.listPositions(200)).find(p => p.symbol === 'MNQU6')?.netQuantity ?? 0).toBe(0);
    } finally {
      controller.stop();
    }
  });

  it('shodný snapshot po mrknutí nechá kopírku zapnutou', async () => {
    const { follower, controller } = await armedWithCopiedEntry();
    try {
      follower.setConnected(false);
      follower.emitEvent(reconnectSnapshot(1));
      await controller.waitForIdle(); await sleep(20); await controller.waitForIdle();
      expect(controller.status()).toMatchObject({ armed: true, connected: true, lastError: null });
    } finally {
      controller.stop();
    }
  });

  it('reconnect snapshot mimo lhůtu (výpadek už controller viděl) router nepředá', async () => {
    const leader = createMockBroker();
    const router = createBrokerRouter([{ broker: leader, accountIds: [100, 200], critical: true }]);
    const seen: BrokerEvent[] = [];
    const unsubscribe = router.subscribe(event => seen.push(event));
    leader.setConnected(true);
    leader.setConnected(false);
    leader.emitEvent({ ...reconnectSnapshot(1), connected: true } as BrokerEvent);
    const connections = seen.filter(event => event.type === 'connection');
    expect(connections.map(event => event.type === 'connection' && event.connected)).toEqual([true, false, true]);
    expect(connections.some(event => event.type === 'connection' && event.resynced)).toBe(false);
    unsubscribe();
  });

  it('přímý broker: reconnect snapshot po viděném výpadku obnoví spojení běžnou recovery cestou', async () => {
    const broker = createMockBroker();
    let now = 1_000;
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: () => ++now,
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      broker.setConnected(false);
      await controller.waitForIdle();
      expect(controller.status().connected).toBe(false);
      broker.emitEvent(reconnectSnapshot(0));
      await controller.waitForIdle();
      expect(controller.status()).toMatchObject({ connected: true, armed: false });
    } finally {
      controller.stop();
    }
  });
});
