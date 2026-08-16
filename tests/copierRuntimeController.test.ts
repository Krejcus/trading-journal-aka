import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createOutboxEntry, markUnknown } from '../services/copierOutbox';
import { createMockBroker } from '../services/mockBroker';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const group: CopyGroupConfig = {
  id: 'g1', name: 'Group', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
};

const leaderOrder = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-1', accountId: 100, symbol: 'MNQU6', side: 'Buy',
  orderType: 'Limit', quantity: 2, filledQuantity: 0, limitPrice: 29_500,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...partial,
});

const stepClock = () => {
  let value = 100;
  return () => ++value;
};

describe('bootstrapCopierRuntime', () => {
  it('odmítne neplatnou skupinu před subscribem nebo broker akcí', async () => {
    const broker = createMockBroker();
    await expect(bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: { ...group, followers: [{ accountId: 100, mode: 'on-submit', multiplier: 1 }] },
    })).rejects.toThrow('Leader nemůže');
    expect(broker.placedRequests()).toHaveLength(0);
  });

  it('ignoruje historický sync, startuje DISARMED a live event pustí až po kontrole pozic a ARM', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });

    broker.emitEvent({ type: 'order', order: leaderOrder() });
    broker.setConnected(true);
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(0);
    expect(controller.status()).toMatchObject({ armed: false, connected: true, reconciliationRequired: true });
    expect(() => controller.arm()).toThrow('kontrolu pozic');

    await controller.reconcile();
    controller.arm();
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-2', sourceVersion: '2:Working' }) });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(1);
    expect(broker.placedRequests()[0]).toMatchObject({ accountId: 200, quantity: 2 });
    controller.stop();
  });

  it('disconnect okamžitě zruší ARM a reconnect vyžaduje novou reconciliation', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    expect(controller.status().armed).toBe(true);

    broker.setConnected(false);
    broker.setConnected(true);
    await controller.waitForIdle();
    expect(controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
    expect(() => controller.arm()).toThrow('kontrola pozic');
    controller.stop();
  });

  it('broker transport error okamžitě zavře gate a zachová důvod', async () => {
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'error', error: new Error('rate-limit penalty'), at: 123 });
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({
      armed: false, connected: false, lastError: 'rate-limit penalty',
    });
    controller.stop();
  });

  it('změna konfigurace vždy disarmuje a neplatnou změnu vůbec nepřijme', async () => {
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    expect(() => controller.updateGroup({
      ...group, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 0 }],
    })).toThrow('multiplier');
    expect(controller.status().armed).toBe(false);

    controller.arm();
    controller.updateGroup({
      ...group, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 0.5 }],
    });
    expect(controller.status().armed).toBe(false);
    controller.stop();
  });

  it('shadow režim lze armovat bez position confirmation a nikdy neposílá objednávku', async () => {
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    controller.arm({ shadowMode: true });
    broker.emitEvent({ type: 'order', order: leaderOrder() });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(0);
    expect(controller.status()).toMatchObject({ armed: true, shadowMode: true, lastSequence: 1 });
    controller.stop();
  });

  it('ostrý ARM odmítne rozdílné pozice i pracovní příkazy', async () => {
    const broker = createMockBroker({ behavior: request => request.tag === 'position'
      ? { kind: 'fill', price: 29_500 }
      : { kind: 'working' } });
    await broker.placeOrder({
      tag: 'position', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    await broker.placeOrder({
      tag: 'existing', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    const reconciliation = await controller.reconcile();
    expect(reconciliation).toEqual({ divergentAccounts: [200], workingOrderAccounts: [200] });
    expect(() => controller.arm()).toThrow();
    controller.stop();
  });

  it('reconciliation failne před pozicemi, když OAuth follower chybí nebo je read-only', async () => {
    const broker = createMockBroker({
      accountCapabilities: [
        { accountId: 100, active: true, canTrade: true },
        { accountId: 200, active: true, canTrade: false },
      ],
    });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await expect(controller.reconcile()).rejects.toThrow('readOnlyFollowers=200');
    expect(controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
    controller.stop();
  });

  it('ruční waive je durable, disarmuje a vynutí novou reconciliation', async () => {
    const broker = createMockBroker({ lookupCompleteness: 'eventual' });
    const base = createMemoryCopierStore();
    const request = {
      tag: 'cpabc123', accountId: 200, symbol: 'MNQU6', side: 'Buy' as const,
      quantity: 1, orderType: 'Market' as const,
    };
    const unknown = markUnknown(
      createOutboxEntry('cp:g1:e1:200', 'cpabc123', 'leader-1', request, 1, false, 'e1', 1),
      'timeout',
      2,
    );
    await base.commit({
      revision: 0, replicated: [], lastSequence: 0, outbox: [unknown], cancelOutbox: [],
      links: [], leaderCumQty: [], followerFillTargets: [],
    }, 0);
    const controller = await bootstrapCopierRuntime({ broker, store: base, group, clock: stepClock() });
    broker.setConnected(true);
    await controller.waitForIdle();

    await controller.waiveStuckOperation({
      kind: 'place', key: unknown.key, reason: 'ověřeno ručně v broker UI',
    });
    expect(controller.status()).toMatchObject({ armed: false, stuckOutbox: false, reconciliationRequired: true });
    const stored = await base.load();
    expect(stored.outbox[0].status).toBe('waived');
    expect(stored.replicated).toContain(unknown.key);
    await controller.reconcile();
    controller.arm();
    expect(controller.status().armed).toBe(true);
    controller.stop();
  });
});
