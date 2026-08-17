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

  it('kill switch okamžitě disarmuje a v aktuální session už nedovolí nový ARM', async () => {
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    controller.engageKillSwitch('Nouzové zastavení operátorem');

    expect(controller.status()).toMatchObject({
      armed: false,
      killSwitch: true,
      reconciliationRequired: true,
      lastError: 'Nouzové zastavení operátorem',
    });
    expect(() => controller.arm({ shadowMode: true })).toThrow('kill switch je aktivní');
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

  it('pilot pustí lifecycle první objednávky, ale druhou novou leader objednávku fail-closed zablokuje', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const audits: Array<{ kind: string; reason?: string }> = [];
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock: stepClock(),
      maxLeaderOrders: 1,
      onAudit: entries => audits.push(...entries),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-1' }) });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(1);

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-1', sourceVersion: '2:Canceled', status: 'canceled',
    }) });
    await controller.waitForIdle();
    expect(controller.status().lastError).toBeNull();

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-2', sourceVersion: '1:Working', status: 'working',
    }) });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(1);
    expect(controller.status()).toMatchObject({
      armed: false,
      connected: false,
      lastError: 'Pilot limit nových leader objednávek byl překročen (1)',
    });
    expect(audits).toContainEqual(expect.objectContaining({
      kind: 'blocked', reason: 'leader-order-session-limit',
    }));
    controller.stop();
  });

  it('pilot může povolit právě jeden opačný order, který přesně zavře známou leader pozici', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock: stepClock(),
      maxLeaderOrders: 1,
      allowSingleFlatExit: true,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-entry', quantity: 1, orderType: 'Market', limitPrice: undefined,
    }) });
    broker.emitEvent({ type: 'position', position: {
      accountId: 100, symbol: 'MNQU6', netQuantity: 1,
    } });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-exit', side: 'Sell', quantity: 1,
      orderType: 'Market', limitPrice: undefined,
    }) });
    await controller.waitForIdle();

    expect(broker.placedRequests()).toHaveLength(2);
    expect(broker.placedRequests()[1]).toMatchObject({ accountId: 200, side: 'Sell', quantity: 1 });
    expect(controller.status().lastError).toBeNull();

    broker.emitEvent({ type: 'position', position: {
      accountId: 100, symbol: 'MNQU6', netQuantity: 0,
    } });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-third', quantity: 1, orderType: 'Market', limitPrice: undefined,
    }) });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(2);
    expect(controller.status()).toMatchObject({ armed: false, connected: false });
    controller.stop();
  });

  it('protective TP+SL nepočítá jako nové entry a odešle je jedním OCO', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock: stepClock(),
      maxLeaderOrders: 1,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'entry-1', quantity: 1, orderType: 'Market', limitPrice: undefined,
    }) });
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'fill-entry-1', tag: 'leader-entry-1', brokerOrderId: 'entry-1', accountId: 100,
      symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 30_000, filledAt: 101,
    } });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'target-1', side: 'Sell', quantity: 1, orderType: 'Limit',
      limitPrice: 30_100, sourceVersion: '1:Working',
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'stop-1', side: 'Sell', quantity: 1, orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_950, sourceVersion: '1:Working',
    }) });
    await controller.waitForIdle();

    expect(broker.placedRequests()).toHaveLength(1);
    expect(broker.placedOcoRequests()).toHaveLength(1);
    expect(broker.placedOcoRequests()[0]).toMatchObject({
      accountId: 200,
      first: { orderType: 'Stop', stopPrice: 29_950 },
      second: { orderType: 'Limit', limitPrice: 30_100 },
    });
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'stop-1', side: 'Sell', quantity: 1, orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_960, sourceVersion: '2:Working',
    }) });
    await controller.waitForIdle();
    expect(broker.orders().some(item => item.accountId === 200 && item.stopPrice === 29_960)).toBe(true);

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'target-1', side: 'Sell', quantity: 1, orderType: 'Limit',
      limitPrice: 30_100, status: 'canceled', sourceVersion: '2:Canceled',
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'stop-1', side: 'Sell', quantity: 1, orderType: 'Stop',
      limitPrice: undefined, stopPrice: 29_960, status: 'canceled', sourceVersion: '3:Canceled',
    }) });
    await controller.waitForIdle();
    const followerProtectiveOrders = broker.orders().filter(item => (
      item.accountId === 200 && (item.orderType === 'Stop' || item.orderType === 'Limit')
    ));
    expect(followerProtectiveOrders).toHaveLength(2);
    expect(followerProtectiveOrders.every(item => item.status === 'canceled')).toBe(true);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });

  it('čekající entry + SL + TP odešle followerovi jedním nativním OSO a uloží všechny vazby', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({
      broker, store, group, clock: stepClock(), maxLeaderOrders: 1,
      osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'oso-entry', quantity: 1, limitPrice: 30_000,
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'oso-stop', parentOrderId: 'oso-entry', side: 'Sell', quantity: 1,
      orderType: 'Stop', limitPrice: undefined, stopPrice: 29_950,
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'oso-target', parentOrderId: 'oso-entry', side: 'Sell', quantity: 1,
      orderType: 'Limit', limitPrice: 30_100,
    }) });
    await controller.waitForIdle();

    expect(broker.placedRequests()).toHaveLength(0);
    expect(broker.placedOsoRequests()).toEqual([expect.objectContaining({
      accountId: 200,
      orderType: 'Limit',
      limitPrice: 30_000,
      first: expect.objectContaining({ orderType: 'Stop', stopPrice: 29_950 }),
      second: expect.objectContaining({ orderType: 'Limit', limitPrice: 30_100 }),
    })]);
    const snapshot = await store.load();
    expect(snapshot.osoOutbox).toEqual([expect.objectContaining({ status: 'acknowledged' })]);
    expect(new Map(snapshot.links).get('oso-entry')).toHaveLength(1);
    expect(new Map(snapshot.links).get('oso-stop')).toHaveLength(1);
    expect(new Map(snapshot.links).get('oso-target')).toHaveLength(1);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });

  it('obyčejný limit po krátkém OSO okně odešle jednou a uvolní korelační stav', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
      osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'plain-limit' }) });
    await controller.waitForIdle();

    expect(broker.placedRequests()).toHaveLength(1);
    expect(broker.placedOsoRequests()).toHaveLength(0);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });

  it('změna limitu během OSO okna nejdřív dokončí entry a až potom bezpečně změní follower order', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
      osoCorrelationWindowMs: 50,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'modified-during-window', limitPrice: 29_500,
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'modified-during-window', sourceVersion: '2:Working', limitPrice: 29_501,
    }) });
    await controller.waitForIdle();

    expect(broker.placedRequests()).toHaveLength(1);
    expect(broker.placedOsoRequests()).toHaveLength(0);
    expect(broker.orders().find(order => order.accountId === 200)).toMatchObject({
      status: 'working', limitPrice: 29_501,
    });
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });

  it('pilot nepovolí domnělý exit, který by známou pozici přetočil nebo nezavřel přesně', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock: stepClock(),
      maxLeaderOrders: 1,
      allowSingleFlatExit: true,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-entry', quantity: 1 }) });
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'leader-oversized-exit', side: 'Sell', quantity: 2,
    }) });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(1);
    expect(controller.status()).toMatchObject({ armed: false, connected: false });
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

  it('explicitní Flatten účtu nejdřív zruší working order a potom durable zavře pozici', async () => {
    const broker = createMockBroker({
      behavior: request => request.tag === 'seed-position' || request.tag.startsWith('fl')
        ? { kind: 'fill', price: 30_000 }
        : { kind: 'working' },
    });
    await broker.placeOrder({
      tag: 'seed-position', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 2, orderType: 'Market',
    });
    const working = await broker.placeOrder({
      tag: 'seed-working', accountId: 200, symbol: 'MNQU6', side: 'Sell', quantity: 2,
      orderType: 'Limit', limitPrice: 31_000,
    });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({ broker, store, group, clock: stepClock() });
    broker.setConnected(true);
    await controller.waitForIdle();

    const result = await controller.flattenAccount(200, 'manual-flat-account-001');

    expect(result).toMatchObject({
      accountIds: [200], canceledOrders: 1, submittedClosures: 1, flat: true,
    });
    expect((await broker.findOrderById(200, working.brokerOrderId)).order?.status).toBe('canceled');
    expect(await broker.listPositions(200)).toEqual([expect.objectContaining({ netQuantity: 0 })]);
    const saved = await store.load();
    expect(saved.cancelOutbox).toEqual([expect.objectContaining({ status: 'confirmed' })]);
    expect(saved.outbox).toEqual([expect.objectContaining({ status: 'acknowledged' })]);
    expect(controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
    controller.stop();
  });

  it('explicitní Flatten All zavře leadera i followery a neopakuje stejnou operaci', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 30_000 }) });
    await broker.placeOrder({
      tag: 'seed-leader', accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    await broker.placeOrder({
      tag: 'seed-follower', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 2, orderType: 'Market',
    });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({ broker, store, group, clock: stepClock() });
    broker.setConnected(true);
    await controller.waitForIdle();

    const first = await controller.flattenGroup('manual-flat-group-001');
    const placedAfterFirst = broker.placedRequests().length;
    const second = await controller.flattenGroup('manual-flat-group-001');

    expect(first).toMatchObject({ accountIds: [100, 200], submittedClosures: 2, flat: true });
    expect(second).toMatchObject({ submittedClosures: 0, flat: true });
    expect(broker.placedRequests()).toHaveLength(placedAfterFirst);
    expect((await store.load()).outbox).toHaveLength(2);
    controller.stop();
  });

  it('Flatten čeká na opožděnou autoritativní Position projekci místo falešného ne-flat výsledku', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 30_000 }) });
    await broker.placeOrder({
      tag: 'seed-position-delayed', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    const originalPlace = broker.placeOrder.bind(broker);
    const originalListPositions = broker.listPositions.bind(broker);
    let closeSubmitted = false;
    let staleReads = 2;
    broker.placeOrder = async request => {
      const ack = await originalPlace(request);
      if (request.tag.startsWith('fl')) closeSubmitted = true;
      return ack;
    };
    broker.listPositions = async accountId => {
      const actual = await originalListPositions(accountId);
      if (closeSubmitted && accountId === 200 && staleReads-- > 0) {
        return [{ accountId: 200, symbol: 'MNQU6', netQuantity: 1 }];
      }
      return actual;
    };
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock: stepClock(),
      flattenConfirmationAttempts: 5,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    await expect(controller.flattenAccount(200, 'manual-flat-delayed-position-001')).resolves.toMatchObject({ flat: true });
    expect(staleReads).toBeLessThan(0);
    controller.stop();
  });

  it('Flatten čeká na opožděné autoritativní potvrzení cancelu bez druhého cancel requestu', async () => {
    const broker = createMockBroker({
      behavior: request => request.tag === 'seed-position-delayed-cancel' || request.tag.startsWith('fl')
        ? { kind: 'fill', price: 30_000 }
        : { kind: 'working' },
    });
    await broker.placeOrder({
      tag: 'seed-position-delayed-cancel', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    const working = await broker.placeOrder({
      tag: 'seed-working-delayed-cancel', accountId: 200, symbol: 'MNQU6', side: 'Sell', quantity: 1,
      orderType: 'Limit', limitPrice: 31_000,
    });
    const originalLookup = broker.findOrderById.bind(broker);
    const originalCancel = broker.cancelOrder.bind(broker);
    let cancelCalls = 0;
    let staleReads = 2;
    broker.cancelOrder = async (accountId, brokerOrderId) => {
      cancelCalls += 1;
      return originalCancel(accountId, brokerOrderId);
    };
    broker.findOrderById = async (accountId, brokerOrderId) => {
      const actual = await originalLookup(accountId, brokerOrderId);
      if (brokerOrderId === working.brokerOrderId && staleReads-- > 0 && actual.order) {
        return { ...actual, order: { ...actual.order, status: 'working' } };
      }
      return actual;
    };
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock: stepClock(),
      flattenConfirmationAttempts: 5,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    await expect(controller.flattenAccount(200, 'manual-flat-delayed-cancel-001')).resolves.toMatchObject({
      canceledOrders: 1, flat: true,
    });
    expect(cancelCalls).toBe(1);
    controller.stop();
  });

  it('Flatten timeout vrací chybu a failne runtime zavřeně místo falešného úspěchu', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 30_000 }) });
    await broker.placeOrder({
      tag: 'seed-position-stuck', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    const originalPlace = broker.placeOrder.bind(broker);
    let closeSubmitted = false;
    broker.placeOrder = async request => {
      const ack = await originalPlace(request);
      if (request.tag.startsWith('fl')) closeSubmitted = true;
      return ack;
    };
    const originalListPositions = broker.listPositions.bind(broker);
    broker.listPositions = async accountId => closeSubmitted && accountId === 200
      ? [{ accountId: 200, symbol: 'MNQU6', netQuantity: 1 }]
      : originalListPositions(accountId);
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock: stepClock(),
      flattenConfirmationAttempts: 3,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    await expect(controller.flattenAccount(200, 'manual-flat-stuck-position-001')).rejects.toThrow('čeká na reconciliation');
    expect(controller.status()).toMatchObject({ armed: false, connected: false });
    controller.stop();
  });

  it('Flatten při nejasném cancelu failne zavřeně a neodešle close order', async () => {
    const broker = createMockBroker({
      behavior: request => request.tag === 'seed-position'
        ? { kind: 'fill', price: 30_000 }
        : { kind: 'working' },
      cancelBehavior: () => 'timeout-before-cancel',
      lookupCompleteness: 'eventual',
    });
    await broker.placeOrder({
      tag: 'seed-position', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    await broker.placeOrder({
      tag: 'seed-working', accountId: 200, symbol: 'MNQU6', side: 'Sell', quantity: 1,
      orderType: 'Limit', limitPrice: 31_000,
    });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({ broker, store, group, clock: stepClock() });
    broker.setConnected(true);
    await controller.waitForIdle();

    await expect(controller.flattenAccount(200, 'manual-flat-unknown-001')).rejects.toThrow('není autoritativně potvrzen');
    expect(broker.placedRequests().filter(request => request.tag.startsWith('fl'))).toHaveLength(0);
    expect((await store.load()).cancelOutbox).toEqual([expect.objectContaining({ status: 'unknown' })]);
    expect(controller.status()).toMatchObject({ armed: false, connected: false, stuckOutbox: true });
    controller.stop();
  });

  it('anti-revenge cooldown po zavření pozice odzbrojí a blokuje ostrý re-ARM', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const cooldownGroup: CopyGroupConfig = {
      ...group,
      safety: {
        positionReconciler: true, disableReplicationOnBreach: true,
        autoCloseFollowerPositions: true, preventHedging: true,
        entryCooldownMinutes: 10,
      },
    };
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: cooldownGroup, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    expect(controller.status().armed).toBe(true);

    // Otevření pozice cooldown nespouští.
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
    await controller.waitForIdle();
    expect(controller.status().armed).toBe(true);

    // Návrat na flat = okamžitý DISARM a blokovaný ostrý re-ARM.
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 } });
    await controller.waitForIdle();
    expect(controller.status().armed).toBe(false);
    await controller.reconcile();
    expect(() => controller.arm()).toThrow('cooldown');

    // Shadow režim zůstává dostupný — pozorování není obchodování.
    controller.arm({ shadowMode: true });
    expect(controller.status()).toMatchObject({ armed: true, shadowMode: true });
    controller.stop();
  });

  it('flat událost followera cooldown nespouští', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const cooldownGroup: CopyGroupConfig = {
      ...group,
      safety: {
        positionReconciler: true, disableReplicationOnBreach: true,
        autoCloseFollowerPositions: true, preventHedging: true,
        entryCooldownMinutes: 10,
      },
    };
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: cooldownGroup, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 1 } });
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 0 } });
    await controller.waitForIdle();
    expect(controller.status().armed).toBe(true);
    controller.stop();
  });
});
