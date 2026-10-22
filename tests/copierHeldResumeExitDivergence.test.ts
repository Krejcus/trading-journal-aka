// Review 22. 10. 2026: za vypnuté kopírky po výpadku spojení (kopie držené
// přes výpadek) nesmí divergence před exitem leadera zmizet jako pouhý audit —
// automatické pokračování by jinak prošlo, i když kopie skončila jinak než
// leader (INV-RECON-04).
import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';

const symbol = 'MNQZ6';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function openBracketTrade() {
  let time = 100;
  const audits: string[] = [];
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(),
    group: { id: 'g', name: 'g', enabled: true, leaderAccountId: 100, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }] },
    clock: () => ++time, leaderFlatGraceMs: 0, leaderFlatExitSettlementGraceMs: 0,
    followerTransitionCorrelationWindowMs: 60_000, osoCorrelationWindowMs: 5,
    onAudit: (e: any[]) => { for (const x of e) audits.push(`${x.kind}:${x.reason}`); },
  } as never);
  const order = (id: string, patch: Partial<BrokerOrder> = {}): BrokerOrder => ({
    tag: '', brokerOrderId: id, accountId: 100, symbol, side: 'Buy', orderType: 'Limit', quantity: 2,
    filledQuantity: 0, limitPrice: 30_000, status: 'working', sourceVersion: '1', updatedAt: 100, ...patch,
  });
  const leaderRest: BrokerOrder[] = [];
  const originalList = broker.listOrders.bind(broker);
  (broker as { listOrders: unknown }).listOrders = async (accountId: number, ...rest: unknown[]) => (
    accountId === 100 ? [...leaderRest] : (originalList as (...args: unknown[]) => Promise<BrokerOrder[]>)(accountId, ...rest)
  );
  const position = (accountId: number, net: number) => {
    broker.setPosition(accountId, symbol, net);
    broker.emitEvent({ type: 'position', position: { accountId, symbol, netQuantity: net } });
  };
  const settle = async (ms = 30) => { await controller.waitForIdle(); await sleep(ms); await controller.waitForIdle(); };
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm({ ttlMs: 3_600_000 });
  const stop = order('stop', { parentOrderId: 'entry', side: 'Sell', orderType: 'Stop', limitPrice: undefined, stopPrice: 29_950 });
  const target = order('target', { parentOrderId: 'entry', side: 'Sell', limitPrice: 30_100 });
  broker.emitEvent({ type: 'order', order: order('entry') });
  broker.emitEvent({ type: 'order', order: stop });
  broker.emitEvent({ type: 'order', order: target });
  await controller.waitForIdle();
  const followerEntry = broker.orders().find(item => item.accountId === 200 && item.side === 'Buy')!;
  followerEntry.filledQuantity = 2;
  followerEntry.status = 'filled';
  broker.emitEvent({ type: 'order', order: { ...followerEntry } });
  broker.emitEvent({ type: 'fill', fill: { fillId: 'f200', tag: '', brokerOrderId: followerEntry.brokerOrderId, accountId: 200, symbol, side: 'Buy', quantity: 2, price: 30_000, filledAt: 1_000 } });
  position(200, 2);
  broker.emitEvent({ type: 'order', order: order('entry', { status: 'filled', filledQuantity: 2, sourceVersion: '2' }) });
  broker.emitEvent({ type: 'fill', fill: { fillId: 'f100', tag: '', brokerOrderId: 'entry', accountId: 100, symbol, side: 'Buy', quantity: 2, price: 30_000, filledAt: 1_000 } });
  position(100, 2);
  leaderRest.push(order('entry', { status: 'filled', filledQuantity: 2 }), stop, target);
  await settle();
  expect(controller.status()).toMatchObject({ armed: true, lastError: null });
  return { broker, controller, order, leaderRest, position, settle, audits };
}

describe('divergence před exitem leadera u kopií držených přes výpadek', () => {
  it('follower skončí jinak, leader zavře ručně → pokračování odmítnuto a incident', async () => {
    const h = await openBracketTrade();
    try {
      for (const order of h.leaderRest) {
        if (order.status !== 'working') continue;
        order.status = 'canceled';
        h.broker.emitEvent({ type: 'order', order: { ...order, sourceVersion: '9' } });
      }
      await h.settle(60);
      for (const order of h.broker.orders().filter(item => item.accountId === 200 && item.status === 'working')) {
        await h.broker.cancelOrder(200, order.brokerOrderId);
      }
      await h.settle();
      h.broker.setConnected(false); await h.settle();
      h.broker.setConnected(true); await h.settle(100);
      expect(h.controller.status().transportResume?.phase).toBe('waiting');
      h.position(200, 0);
      await h.settle(100);
      const exit = h.order('manual-exit', { side: 'Sell', orderType: 'Market', limitPrice: undefined });
      h.leaderRest.push(exit);
      h.broker.emitEvent({ type: 'order', order: exit });
      await h.settle(30);
      h.broker.emitEvent({ type: 'order', order: { ...exit, status: 'filled', filledQuantity: 2, sourceVersion: '2' } });
      h.broker.emitEvent({ type: 'fill', fill: { fillId: 'f100exit', tag: '', brokerOrderId: 'manual-exit', accountId: 100, symbol, side: 'Sell', quantity: 2, price: 30_050, filledAt: 3_000 } });
      h.leaderRest.splice(h.leaderRest.indexOf(exit), 1, { ...exit, status: 'filled', filledQuantity: 2 });
      h.position(100, 0);
      await h.settle(150);
      const status = h.controller.status();
      expect(status.transportResume?.phase).not.toBe('ready');
      expect(status.manualRecovery).not.toBeNull();
    } finally {
      h.controller.stop();
    }
  });
});
