import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import type { CopierAuditEntry } from '../services/copierRunner';

const symbol = 'MNQU6';
const group: CopyGroupConfig = {
  id: 'management-only-regression',
  name: 'Incident 2026-09-21',
  enabled: true,
  leaderAccountId: 100,
  followers: Array.from({ length: 6 }, (_, index) => ({
    accountId: 200 + index,
    mode: 'on-submit' as const,
    multiplier: 1,
  })),
};

const leaderOrder = (brokerOrderId: string, patch: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '',
  brokerOrderId,
  accountId: 100,
  symbol,
  side: 'Buy',
  orderType: 'Limit',
  quantity: 13,
  filledQuantity: 0,
  limitPrice: 30_128.25,
  status: 'working',
  sourceVersion: '1:Working',
  updatedAt: 1,
  ...patch,
});

describe('management-only after a protected target modify race', () => {
  it('13→14→15→18 on six followers blocks new entries, keeps exits live, and never auto-flattens', async () => {
    let now = 1_000;
    const clock = () => ++now;
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }), clock });
    const store = createMemoryCopierStore();
    const audit: CopierAuditEntry[] = [];
    const controller = await bootstrapCopierRuntime({
      broker,
      store,
      group,
      clock,
      osoCorrelationWindowMs: 5,
      leaderFlatGraceMs: 60_000,
      followerTransitionCorrelationWindowMs: 60_000,
      onAudit: entries => audit.push(...entries),
    });
    const emitPosition = (accountId: number, netQuantity: number) => {
      broker.setPosition(accountId, symbol, netQuantity);
      broker.emitEvent({ type: 'position', position: { accountId, symbol, netQuantity } });
    };
    const emitEntryFill = (accountId: number, quantity: number, stage: string) => {
      const brokerOrderId = accountId === 100
        ? 'leader-entry'
        : broker.orders().find(order => (
          order.accountId === accountId && order.parentOrderId == null && order.side === 'Buy'
        ))?.brokerOrderId;
      if (!brokerOrderId) throw new Error(`Chybí entry order pro účet ${accountId}`);
      broker.emitEvent({ type: 'fill', fill: {
        fillId: `entry-fill-${accountId}-${stage}`,
        tag: '', brokerOrderId, accountId, symbol, side: 'Buy', quantity,
        price: 30_128.25, filledAt: clock(),
      } });
    };

    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();

      broker.emitEvent({ type: 'order', order: leaderOrder('leader-entry') });
      broker.emitEvent({ type: 'order', order: leaderOrder('leader-stop', {
        parentOrderId: 'leader-entry',
        side: 'Sell',
        orderType: 'Stop',
        limitPrice: undefined,
        stopPrice: 30_100,
      }) });
      broker.emitEvent({ type: 'order', order: leaderOrder('leader-target', {
        parentOrderId: 'leader-entry',
        side: 'Sell',
        limitPrice: 30_170.25,
      }) });
      await controller.waitForIdle();
      expect(broker.placedOsoRequests()).toHaveLength(6);

      emitEntryFill(100, 13, '13');
      emitPosition(100, 13);
      for (const follower of group.followers) {
        emitEntryFill(follower.accountId, 13, '13');
        emitPosition(follower.accountId, 13);
      }
      await controller.waitForIdle();

      // The leader moves TP while the controller still knows qty=13. Before
      // that queued event reaches the broker, venue-managed child quantities
      // and actual positions advance to 15. This is the production race that
      // previously triggered six market closes.
      broker.emitEvent({ type: 'order', order: leaderOrder('leader-target', {
        parentOrderId: 'leader-entry',
        side: 'Sell',
        limitPrice: 30_180.25,
        sourceVersion: '2:Working',
        updatedAt: 2,
      }) });
      for (const netQuantity of [14, 15]) {
        emitEntryFill(100, 1, String(netQuantity));
        emitPosition(100, netQuantity);
        for (const follower of group.followers) {
          emitEntryFill(follower.accountId, 1, String(netQuantity));
          emitPosition(follower.accountId, netQuantity);
        }
      }
      for (const order of broker.orders()) {
        if (order.accountId === 100 || order.parentOrderId == null
          || (order.orderType !== 'Stop' && order.orderType !== 'Limit')) continue;
        order.quantity = 15;
      }
      // Keep the broker's authoritative positions at the latest fill while
      // preserving queued 14/15 stream transitions above.
      broker.setPosition(100, symbol, 15);
      for (const follower of group.followers) broker.setPosition(follower.accountId, symbol, 15);
      await controller.waitForIdle();

      expect(controller.status()).toMatchObject({
        armed: true,
        shadowMode: false,
        stuckOutbox: false,
        autoClose: null,
        managementOnly: {
          source: 'protected-target-modify',
          accountIds: group.followers.map(follower => follower.accountId),
        },
      });
      expect(broker.liquidateRequests()).toEqual([]);
      expect((await store.load()).cancelOutbox.filter(entry => entry.operation === 'modify'))
        .toHaveLength(6);
      expect((await store.load()).cancelOutbox.filter(entry => entry.operation === 'modify'))
        .toEqual(expect.arrayContaining(Array.from({ length: 6 }, () => (
          expect.objectContaining({ status: 'waived', reason: expect.stringContaining('management-only') })
        ))));

      await expect(controller.reconcile()).rejects.toThrow('správy otevřených kopií');
      expect(controller.status()).toMatchObject({ armed: true, managementOnly: expect.any(Object) });

      // Later partial fills reach the final 18. Venue protection catches up;
      // this must not clear management-only or create any market auto-close.
      emitEntryFill(100, 3, '18');
      emitPosition(100, 18);
      for (const follower of group.followers) {
        emitEntryFill(follower.accountId, 3, '18');
        emitPosition(follower.accountId, 18);
      }
      for (const order of broker.orders()) {
        if (order.accountId === 100 || order.parentOrderId == null
          || (order.orderType !== 'Stop' && order.orderType !== 'Limit')) continue;
        order.quantity = 18;
        broker.emitEvent({ type: 'order', order: { ...order, updatedAt: clock() } });
      }
      await controller.waitForIdle();
      expect(controller.status()).toMatchObject({ armed: true, managementOnly: expect.any(Object) });
      expect(broker.liquidateRequests()).toEqual([]);

      const ordinaryOrdersBeforeBlockedEntry = broker.placedRequests().length;
      broker.emitEvent({ type: 'order', order: leaderOrder('blocked-new-entry', {
        quantity: 1,
        limitPrice: 30_120,
        sourceVersion: '1:Working',
        updatedAt: 3,
      }) });
      await controller.waitForIdle();
      expect(broker.placedRequests()).toHaveLength(ordinaryOrdersBeforeBlockedEntry);
      expect(controller.status()).toMatchObject({ armed: true, managementOnly: expect.any(Object) });

      // A full reducing leader order remains copyable to all six followers.
      broker.emitEvent({ type: 'order', order: leaderOrder('leader-manual-exit', {
        side: 'Sell',
        orderType: 'Market',
        quantity: 18,
        limitPrice: undefined,
        sourceVersion: '1:Working',
        updatedAt: 4,
      }) });
      await controller.waitForIdle();
      expect({
        requests: broker.placedRequests().slice(ordinaryOrdersBeforeBlockedEntry),
        recentAudit: audit.slice(-20),
        status: controller.status(),
      }).toMatchObject({
        requests: expect.arrayContaining(group.followers.map(follower => expect.objectContaining({
          accountId: follower.accountId, side: 'Sell', quantity: 18,
        }))),
      });
      expect(broker.placedRequests().length - ordinaryOrdersBeforeBlockedEntry).toBe(6);
      expect(controller.status()).toMatchObject({ armed: true, managementOnly: expect.any(Object) });
      expect(broker.liquidateRequests()).toEqual([]);
    } finally {
      controller.stop();
    }
  }, 20_000);

  it('never enters management-only when the exact stop is not working', async () => {
    let now = 10_000;
    const clock = () => ++now;
    const oneFollower: CopyGroupConfig = {
      ...group,
      id: 'management-only-negative',
      followers: [group.followers[0]],
    };
    const broker = createMockBroker({
      behavior: () => ({ kind: 'working' }),
      clock,
      nativeLiquidate: true,
    });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: oneFollower,
      clock,
      osoCorrelationWindowMs: 5,
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      broker.emitEvent({ type: 'order', order: leaderOrder('unsafe-entry', { quantity: 1 }) });
      broker.emitEvent({ type: 'order', order: leaderOrder('unsafe-stop', {
        parentOrderId: 'unsafe-entry', side: 'Sell', orderType: 'Stop', quantity: 1,
        limitPrice: undefined, stopPrice: 30_100,
      }) });
      broker.emitEvent({ type: 'order', order: leaderOrder('unsafe-target', {
        parentOrderId: 'unsafe-entry', side: 'Sell', quantity: 1, limitPrice: 30_170.25,
      }) });
      await controller.waitForIdle();
      broker.setPosition(100, symbol, 1);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol, netQuantity: 1 } });
      broker.setPosition(200, symbol, 2);
      broker.emitEvent({ type: 'position', position: { accountId: 200, symbol, netQuantity: 1 } });
      await controller.waitForIdle();

      const followerStop = broker.orders().find(order => (
        order.accountId === 200 && order.orderType === 'Stop'
      ));
      const followerTarget = broker.orders().find(order => (
        order.accountId === 200 && order.orderType === 'Limit' && order.parentOrderId != null
      ));
      expect(followerStop).toBeDefined();
      expect(followerTarget).toBeDefined();
      followerStop!.quantity = 2;
      followerStop!.status = 'canceled';
      followerTarget!.quantity = 2;

      broker.emitEvent({ type: 'order', order: leaderOrder('unsafe-target', {
        parentOrderId: 'unsafe-entry', side: 'Sell', quantity: 1,
        limitPrice: 30_180.25, sourceVersion: '2:Working', updatedAt: 2,
      }) });
      await controller.waitForIdle();

      expect(controller.status()).toMatchObject({
        armed: false,
        reconciliationRequired: true,
        managementOnly: null,
      });
      expect(broker.liquidateRequests()).toEqual([
        expect.objectContaining({ accountId: 200, symbol }),
      ]);
    } finally {
      controller.stop();
    }
  });

  it('refuses management-only when any other exposed follower lacks full working protection', async () => {
    let now = 20_000;
    const clock = () => ++now;
    const twoFollowers: CopyGroupConfig = {
      ...group,
      id: 'management-only-whole-group-proof',
      followers: group.followers.slice(0, 2),
    };
    const broker = createMockBroker({
      behavior: () => ({ kind: 'working' }),
      clock,
      nativeLiquidate: true,
    });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: twoFollowers,
      clock,
      osoCorrelationWindowMs: 5,
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      broker.emitEvent({ type: 'order', order: leaderOrder('group-entry', { quantity: 1 }) });
      broker.emitEvent({ type: 'order', order: leaderOrder('group-stop', {
        parentOrderId: 'group-entry', side: 'Sell', orderType: 'Stop', quantity: 1,
        limitPrice: undefined, stopPrice: 30_100,
      }) });
      broker.emitEvent({ type: 'order', order: leaderOrder('group-target', {
        parentOrderId: 'group-entry', side: 'Sell', quantity: 1, limitPrice: 30_170.25,
      }) });
      await controller.waitForIdle();

      broker.setPosition(100, symbol, 1);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol, netQuantity: 1 } });
      for (const accountId of [200, 201]) {
        broker.setPosition(accountId, symbol, accountId === 200 ? 2 : 1);
        broker.emitEvent({ type: 'position', position: { accountId, symbol, netQuantity: 1 } });
      }
      await controller.waitForIdle();

      const failedTarget = broker.orders().find(order => (
        order.accountId === 200 && order.orderType === 'Limit' && order.parentOrderId != null
      ));
      const failedStop = broker.orders().find(order => order.accountId === 200 && order.orderType === 'Stop');
      const siblingStop = broker.orders().find(order => order.accountId === 201 && order.orderType === 'Stop');
      expect(failedTarget).toBeDefined();
      expect(failedStop).toBeDefined();
      expect(siblingStop).toBeDefined();
      failedTarget!.quantity = 2;
      failedStop!.quantity = 2;
      siblingStop!.status = 'canceled';

      broker.emitEvent({ type: 'order', order: leaderOrder('group-target', {
        parentOrderId: 'group-entry', side: 'Sell', quantity: 1,
        limitPrice: 30_180.25, sourceVersion: '2:Working', updatedAt: 2,
      }) });
      await controller.waitForIdle();

      expect(controller.status()).toMatchObject({
        armed: false,
        reconciliationRequired: true,
        managementOnly: null,
      });
      expect(broker.liquidateRequests()).toEqual(expect.arrayContaining([
        expect.objectContaining({ accountId: 200, symbol }),
        expect.objectContaining({ accountId: 201, symbol }),
      ]));
    } finally {
      controller.stop();
    }
  });

  it('clears the durable block only after an authoritative flat reconciliation', async () => {
    const snapshot = emptySnapshot();
    snapshot.safety = {
      ...snapshot.safety!,
      managementOnly: {
        at: 1,
        reason: 'restart during management-only',
        source: 'protected-target-modify',
        accountIds: [200],
      },
    };
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(snapshot),
      group: { ...group, id: 'management-only-restart', followers: [group.followers[0]] },
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      expect(controller.status().managementOnly).toMatchObject({ accountIds: [200] });
      await controller.reconcile();
      expect(controller.status()).toMatchObject({
        armed: false,
        reconciliationRequired: false,
        managementOnly: null,
        groupFlat: true,
      });
      expect(() => controller.arm()).not.toThrow();
      expect(controller.status().armed).toBe(true);
    } finally {
      controller.stop();
    }
  });
});
