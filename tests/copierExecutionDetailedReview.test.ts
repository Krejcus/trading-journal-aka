import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { recoverOutbox, runtimeFromSnapshot, type CopierAuditEntry } from '../services/copierRunner';
import { createMemoryCopierStore, type CopierSnapshot, type CopierStore } from '../services/copierStore';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';

const group: CopyGroupConfig = {
  id: 'execution-review', name: 'Execution review', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
  safety: { ...DEFAULT_COPY_GROUP_SAFETY },
};
const leaderOrder = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-review', accountId: 100, symbol: 'MNQU6', side: 'Buy',
  orderType: 'Market', quantity: 1, filledQuantity: 0, status: 'working',
  sourceVersion: '1:Working', updatedAt: 1, ...partial,
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const writeBarrier = (matches: (snapshot: CopierSnapshot) => boolean) => {
  const underlying = createMemoryCopierStore();
  const started = deferred();
  const release = deferred();
  let intercepted = false;
  const store: CopierStore = {
    load: () => underlying.load(),
    async commit(snapshot, expectedRevision) {
      if (!intercepted && matches(snapshot)) {
        intercepted = true;
        started.resolve();
        await release.promise;
      }
      return underlying.commit(snapshot, expectedRevision);
    },
  };
  return { store, started, release };
};
const emitLegs = (broker: MockBroker) => {
  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: 'review-stop', parentOrderId: 'leader-review', side: 'Sell',
    orderType: 'Stop', stopPrice: 29_950,
  }) });
  broker.emitEvent({ type: 'order', order: leaderOrder({
    brokerOrderId: 'review-target', parentOrderId: 'leader-review', side: 'Sell',
    orderType: 'Limit', limitPrice: 30_100,
  }) });
};
const critical = (audit: CopierAuditEntry[]) => audit.filter(entry => (
  ['unknown', 'abandoned', 'rejected', 'cancel-failed', 'sequence-broken', 'blocked'].includes(entry.kind)
));

describe('execution review: safety changes while durable sending commit is pending', () => {
  for (const kind of ['standard', 'oso', 'oco', 'modify', 'staged-modify', 'protective-cancel'] as const) {
    it.each(['disarm', 'kill-switch'] as const)(`${kind}: %s blocks the planned broker write without auto-close`, async operation => {
      let barrierEnabled = kind !== 'protective-cancel' && kind !== 'staged-modify';
      const barrier = writeBarrier(snapshot => barrierEnabled && (
        kind === 'standard' ? snapshot.outbox.some(entry => entry.status === 'sending')
          : kind === 'oso' ? snapshot.osoOutbox?.some(entry => entry.status === 'sending') === true
          : kind === 'oco' ? snapshot.bracketOutbox?.some(entry => entry.status === 'sending') === true
          : snapshot.cancelOutbox.some(entry => entry.status === 'sending')
      ));
      const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
      if (kind === 'staged-modify') {
        const lookup = broker.findOrderById.bind(broker);
        broker.findOrderById = async (accountId, orderId) => accountId === 100 ? {
          completeness: 'authoritative', observedAt: 1,
          order: leaderOrder(orderId === 'review-stop' ? {
            brokerOrderId: 'review-stop', parentOrderId: 'leader-review', side: 'Sell', orderType: 'Stop', stopPrice: 29_950,
          } : {
            brokerOrderId: 'review-target', parentOrderId: 'leader-review', side: 'Sell', orderType: 'Limit', limitPrice: 30_100,
          }),
        } : lookup(accountId, orderId);
      }
      const audit: CopierAuditEntry[] = [];
      let now = 100;
      const controller = await bootstrapCopierRuntime({ broker, store: barrier.store, group,
        clock: () => ++now, osoCorrelationWindowMs: 500, onAudit: entries => audit.push(...entries) });
      try {
        broker.setConnected(true);
        await controller.waitForIdle();
        await controller.reconcile();
        controller.arm();
        broker.emitEvent({ type: 'order', order: leaderOrder(kind === 'oso' || kind === 'modify' || kind === 'staged-modify' || kind === 'protective-cancel'
          ? { orderType: 'Limit', limitPrice: 30_000 } : {}) });
        if (kind === 'oso' || kind === 'staged-modify' || kind === 'protective-cancel') emitLegs(broker);
        if (kind === 'oco') {
          broker.emitEvent({ type: 'fill', fill: {
            fillId: 'review-fill', tag: '', brokerOrderId: 'leader-review', accountId: 100,
            symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 30_000, filledAt: 102,
          } });
          emitLegs(broker);
        }
        if (kind === 'modify' || kind === 'staged-modify' || kind === 'protective-cancel') {
          await controller.waitForIdle();
          barrierEnabled = true;
          broker.emitEvent({ type: 'order', order: leaderOrder(kind === 'modify' || kind === 'staged-modify' ? {
            orderType: 'Limit', limitPrice: 30_010, sourceVersion: '2:Working', updatedAt: 2,
          } : {
            brokerOrderId: 'review-stop', parentOrderId: 'leader-review', side: 'Sell', orderType: 'Stop',
            stopPrice: 29_950, status: 'canceled', sourceVersion: '2:Canceled', updatedAt: 2,
          }) });
        }
        await barrier.started.promise;
        const placeCount = broker.placedRequests().length;
        const osoCount = broker.placedOsoRequests().length;
        const ocoCount = broker.placedOcoRequests().length;
        const modifyCount = broker.modifyRequests().length;
        const cancelCount = broker.orders().reduce((sum, order) => sum + broker.cancelRequestCount(order.brokerOrderId), 0);
        audit.length = 0;
        if (operation === 'disarm') controller.disarm();
        else controller.engageKillSwitch('deterministic review interruption');
        expect(controller.status().armed).toBe(false);
        barrier.release.resolve();
        await controller.waitForIdle();
        expect(broker.placedRequests()).toHaveLength(placeCount);
        expect(broker.placedOsoRequests()).toHaveLength(osoCount);
        expect(broker.placedOcoRequests()).toHaveLength(ocoCount);
        expect(broker.modifyRequests()).toHaveLength(modifyCount);
        expect(broker.orders().reduce((sum, order) => sum + broker.cancelRequestCount(order.brokerOrderId), 0)).toBe(cancelCount);
        expect(broker.liquidateRequests()).toHaveLength(0);
        expect(critical(audit)).toEqual([]);
        expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'skipped', reason: expect.stringContaining('dispatch-revoked:') })]));
        const snapshot = await barrier.store.load();
        const entries = kind === 'standard' ? snapshot.outbox : kind === 'oso' ? snapshot.osoOutbox
          : kind === 'oco' ? snapshot.bracketOutbox : snapshot.cancelOutbox;
        expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'waived' })]));
        if (kind === 'staged-modify') {
          expect(entries).toHaveLength(3);
          expect(entries?.every(entry => entry.status === 'waived')).toBe(true);
        }
      } finally {
        barrier.release.resolve();
        controller.stop();
      }
    });
  }

  it('DISARM then ARM cannot resurrect an old admission or replay it after restart', async () => {
    const barrier = writeBarrier(snapshot => snapshot.outbox.some(entry => entry.status === 'sending'));
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const audit: CopierAuditEntry[] = [];
    let now = 100;
    const clock = () => ++now;
    const controller = await bootstrapCopierRuntime({ broker, store: barrier.store, group, clock,
      onAudit: entries => audit.push(...entries) });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      broker.emitEvent({ type: 'order', order: leaderOrder() });
      await barrier.started.promise;
      // Another old event is queued, not even planned yet.
      broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'old-queued' }) });
      controller.disarm();
      controller.arm();
      barrier.release.resolve();
      await controller.waitForIdle();
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(broker.placedRequests()).toHaveLength(0);
      expect(broker.liquidateRequests()).toHaveLength(0);
      expect(critical(audit)).toEqual([]);
      // Same old leader version is deduplicated; a new admission still works.
      broker.emitEvent({ type: 'order', order: leaderOrder() });
      await controller.waitForIdle();
      expect(broker.placedRequests()).toHaveLength(0);
      broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'fresh-after-arm' }) });
      await controller.waitForIdle();
      expect(broker.placedRequests()).toHaveLength(1);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      controller.stop();
      const snapshot = await barrier.store.load();
      expect(snapshot.outbox.filter(entry => entry.status === 'waived')).toHaveLength(2);
      await recoverOutbox({ runtime: runtimeFromSnapshot(snapshot), broker, clock, store: barrier.store });
      expect(broker.placedRequests()).toHaveLength(1);
    } finally {
      barrier.release.resolve();
      controller.stop();
    }
  });

  it.each(['success', 'lookup-error'] as const)('checks safety after exposure cap I/O (%s), with revocation taking priority', async outcome => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const started = deferred();
    const release = deferred();
    const listPositions = broker.listPositions.bind(broker);
    let intercept = false;
    broker.listPositions = async accountId => {
      if (intercept && accountId === 200) {
        intercept = false;
        started.resolve();
        await release.promise;
        if (outcome === 'lookup-error') throw new Error('injected exposure lookup failure');
      }
      return listPositions(accountId);
    };
    const audit: CopierAuditEntry[] = [];
    let now = 100;
    const controller = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(),
      group: { ...group, followers: [{ ...group.followers[0], maxContracts: 3 }] }, clock: () => ++now,
      onAudit: entries => audit.push(...entries) });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      intercept = true;
      broker.emitEvent({ type: 'order', order: leaderOrder() });
      await started.promise;
      controller.disarm();
      controller.arm();
      release.resolve();
      await controller.waitForIdle();
      expect(broker.placedRequests()).toHaveLength(0);
      expect(broker.liquidateRequests()).toHaveLength(0);
      expect(critical(audit)).toEqual([]);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      release.resolve();
      controller.stop();
    }
  });


  it.each([0, 1, 2])('modify lookup %s failure after DISARM/re-ARM is terminal no-send, not auto-close', async lookupNumber => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const started = deferred();
    const release = deferred();
    const lookup = broker.findOrderById.bind(broker);
    let intercept = false;
    let calls = 0;
    broker.findOrderById = async (accountId, orderId) => {
      if (intercept && ++calls === Math.max(1, lookupNumber)) {
        intercept = false;
        started.resolve();
        await release.promise;
        throw new Error('injected modify lookup failure');
      }
      return lookup(accountId, orderId);
    };
    const store = createMemoryCopierStore();
    const audit: CopierAuditEntry[] = [];
    let now = 100;
    const controller = await bootstrapCopierRuntime({ broker, store, group, clock: () => ++now,
      osoCorrelationWindowMs: 500, onAudit: entries => audit.push(...entries) });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      broker.emitEvent({ type: 'order', order: leaderOrder({ orderType: 'Limit', limitPrice: 30_000 }) });
      if (lookupNumber === 0) emitLegs(broker);
      await controller.waitForIdle();
      const baselinePlaceCount = broker.placedRequests().length;
      expect(baselinePlaceCount).toBe(lookupNumber === 0 ? 0 : 1);
      intercept = true;
      audit.length = 0;
      broker.emitEvent({ type: 'order', order: leaderOrder({ orderType: 'Limit', limitPrice: 30_010,
        sourceVersion: '2:Working', updatedAt: 2 }) });
      await started.promise;
      controller.disarm();
      controller.arm();
      release.resolve();
      await controller.waitForIdle();
      expect(broker.placedRequests()).toHaveLength(baselinePlaceCount);
      expect(broker.modifyRequests()).toHaveLength(0);
      expect(broker.liquidateRequests()).toHaveLength(0);
      expect(critical(audit)).toEqual([]);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      expect((await store.load()).cancelOutbox).toEqual([
        expect.objectContaining({ status: 'waived', neverSent: true }),
      ]);
    } finally {
      release.resolve();
      controller.stop();
    }
  });

  it.each(['ack', 'timeout-after-accept'] as const)('stops queued fanout while preserving an already sent %s outcome', async outcome => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const started = deferred();
    const release = deferred();
    const placeOrder = broker.placeOrder.bind(broker);
    broker.placeOrder = async request => {
      const ack = await placeOrder(request);
      if (broker.placedRequests().length === 1) {
        started.resolve();
        await release.promise;
        if (outcome === 'timeout-after-accept') throw new Error('ack lost after accepted order');
      }
      return ack;
    };
    const store = createMemoryCopierStore();
    let now = 100;
    const controller = await bootstrapCopierRuntime({ broker, store,
      group: { ...group, followers: [200, 201, 202, 203, 204].map(accountId => ({ accountId, mode: 'on-submit', multiplier: 1 })) },
      clock: () => ++now, maxConcurrentDispatches: 1 });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      broker.emitEvent({ type: 'order', order: leaderOrder() });
      await started.promise;
      controller.disarm();
      release.resolve();
      await controller.waitForIdle();
      expect(broker.placedRequests()).toHaveLength(1);
      expect(broker.liquidateRequests()).toHaveLength(0);
      const snapshot = await store.load();
      expect(snapshot.outbox.filter(entry => entry.status === 'waived')).toHaveLength(4);
      expect(snapshot.outbox.find(entry => entry.request.accountId === 200)?.status).toBe(outcome === 'ack' ? 'acknowledged' : 'unknown');
    } finally {
      release.resolve();
      controller.stop();
    }
  });
});
