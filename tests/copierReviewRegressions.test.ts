import { describe, expect, it, vi } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import {
  createCopierState,
  type LeaderEvent,
} from '../services/copierEngine';
import { createRiskGateContext } from '../services/copierRiskGate';
import {
  assertedFollowerQuantity,
  createRuntime,
  processBracketPair,
  processLeaderEvent,
  processOsoPair,
  runtimeFromSnapshot,
} from '../services/copierRunner';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';

const group: CopyGroupConfig = {
  id: 'review-regressions',
  name: 'Review regressions',
  enabled: true,
  leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
  safety: { ...DEFAULT_COPY_GROUP_SAFETY },
};

const stepClock = () => {
  let now = 1_000;
  return () => ++now;
};

const leaderEvent = (partial: Partial<LeaderEvent> = {}): LeaderEvent => ({
  id: 'leader-event-1',
  orderId: 'leader-order-1',
  kind: 'submitted',
  accountId: 100,
  symbol: 'MNQU6',
  side: 'Buy',
  quantity: 5,
  orderType: 'Limit',
  limitPrice: 30_000,
  sequence: 1,
  receivedAt: 1_000,
  ...partial,
});

const leaderOrder = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '',
  brokerOrderId: 'leader-order-1',
  accountId: 100,
  symbol: 'MNQU6',
  side: 'Buy',
  orderType: 'Limit',
  quantity: 5,
  filledQuantity: 0,
  limitPrice: 30_000,
  status: 'working',
  sourceVersion: '1:Working',
  updatedAt: 1_000,
  ...partial,
});

const liveGate = () => createRiskGateContext({
  armed: true,
  armedAt: 1_000,
  now: 1_001,
  connected: true,
  lastHeartbeatAt: 1_001,
  shadowMode: false,
  brokerEnvironment: 'demo',
  expectedEnvironment: 'demo',
});

describe('copier regressions po review 25. 8.', () => {
  it('1. vlastní navýšení 5→6 v rozletěném modify není cizí zásah', async () => {
    const clock = stepClock();
    const store = createMemoryCopierStore();
    const broker = createMockBroker({ clock, behavior: () => ({ kind: 'working' }) });
    const opened = await processLeaderEvent({
      event: leaderEvent(),
      group,
      runtime: createRuntime(createCopierState()),
      context: liveGate(),
      broker,
      clock,
      store,
    });
    const followerOrder = broker.orders()[0];
    if (!followerOrder) throw new Error('Test setup: follower order qty 5 nevznikl');

    let signalModifySent!: () => void;
    let releaseModify!: () => void;
    const modifySent = new Promise<void>(resolve => { signalModifySent = resolve; });
    const modifyMayFinish = new Promise<void>(resolve => { releaseModify = resolve; });
    const realModifyOrder = broker.modifyOrder.bind(broker);
    const heldBroker = {
      ...broker,
      async modifyOrder(
        accountId: number,
        brokerOrderId: string,
        changes: Parameters<typeof broker.modifyOrder>[2],
      ) {
        await realModifyOrder(accountId, brokerOrderId, changes);
        signalModifySent();
        await modifyMayFinish;
      },
    };

    const replacement = processLeaderEvent({
      event: leaderEvent({
        id: 'leader-event-2',
        kind: 'replaced',
        quantity: 6,
        limitPrice: 30_001,
        sequence: 2,
      }),
      group,
      runtime: opened.runtime,
      context: liveGate(),
      broker: heldBroker,
      clock,
      store,
    });

    try {
      await modifySent;
      const inFlight = runtimeFromSnapshot(await store.load());
      const modifyEntry = [...inFlight.cancelOutbox.values()].find(entry => entry.operation === 'modify');
      const originalLink = inFlight.state.links.get('leader-order-1')?.[0];

      expect(originalLink?.quantity).toBe(5);
      expect(modifyEntry).toMatchObject({
        status: 'sending',
        changes: { quantity: 6 },
      });
      expect(modifyEntry?.neverSent).not.toBe(true);
      expect(followerOrder.quantity).toBe(6);

      const asserted = assertedFollowerQuantity(
        inFlight.state,
        inFlight.cancelOutbox,
        followerOrder.brokerOrderId,
      );
      expect(asserted).toBe(6);
    } finally {
      releaseModify();
      await replacement;
    }

    // Controller publikuje runtime až po dokončení serializovaného leader
    // eventu, proto současný `sending` stav výše ověřuje runner kontrakt.
    // Veřejný controller průchod pak potvrzuje výsledný bezpečnostní stav:
    // jeho vlastní 5→6 event nesmí skupinu odzbrojit ani objednávku rušit.
    const controllerBroker = createMockBroker({ clock, behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker: controllerBroker,
      store: createMemoryCopierStore(),
      group,
      clock,
      osoCorrelationWindowMs: 5,
      wait: async () => undefined,
    });
    try {
      controllerBroker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();

      controllerBroker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-own-increase',
        sourceVersion: '1:Working',
        updatedAt: clock(),
      }) });
      controllerBroker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-own-increase',
        quantity: 6,
        limitPrice: 30_001,
        sourceVersion: '2:Working',
        updatedAt: clock(),
      }) });
      await controller.waitForIdle();

      const controllerFollower = controllerBroker.orders().find(order => order.accountId === 200);
      if (!controllerFollower) throw new Error('Test setup: controller follower qty 6 nevznikl');
      expect(controllerFollower.quantity).toBe(6);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(controllerBroker.cancelRequestCount(controllerFollower.brokerOrderId)).toBe(0);
    } finally {
      controller.stop();
    }
  });

  it('2. potvrzené snížení 5→3 odhalí venue návrat na 5 fail-closed', async () => {
    const clock = stepClock();
    const store = createMemoryCopierStore();
    const broker = createMockBroker({ clock, behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker,
      store,
      group,
      clock,
      osoCorrelationWindowMs: 5,
      wait: async () => undefined,
    });

    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();

      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-downsize',
        sourceVersion: '1:Working',
        updatedAt: clock(),
      }) });
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-downsize',
        quantity: 3,
        limitPrice: 30_001,
        sourceVersion: '2:Working',
        updatedAt: clock(),
      }) });
      await controller.waitForIdle();

      const followerOrder = broker.orders().find(order => order.accountId === 200);
      if (!followerOrder) throw new Error('Test setup: follower order po downsize nevznikl');
      const persisted = await store.load();
      const persistedLink = persisted.links
        .find(([leaderOrderId]) => leaderOrderId === 'leader-downsize')?.[1][0];
      const confirmedModify = persisted.cancelOutbox.find(entry => entry.operation === 'modify');
      expect(followerOrder.quantity).toBe(3);
      expect(persistedLink?.quantity).toBe(3);
      expect(confirmedModify).toMatchObject({
        status: 'confirmed',
        outcome: 'working',
        changes: { quantity: 3 },
      });
      expect(controller.status().armed).toBe(true);

      const venueReturn: BrokerOrder = {
        ...followerOrder,
        quantity: 5,
        status: 'working',
        sourceVersion: 'venue-return-to-5',
        updatedAt: clock(),
      };
      Object.assign(followerOrder, venueReturn);
      broker.emitEvent({ type: 'order', order: venueReturn });
      await controller.waitForIdle();

      expect(controller.status().armed).toBe(false);
      expect(controller.status().lastError).toContain('cizí navýšení');
      expect(controller.status().lastError).toContain('5, uplatnili jsme nejvýš 3');
      expect(broker.cancelRequestCount(followerOrder.brokerOrderId)).toBe(1);
    } finally {
      controller.stop();
    }
  });

  it('3. modify s cílem ≤ filled zruší stále živý zbytek', async () => {
    const clock = stepClock();
    const broker = createMockBroker({ clock, behavior: () => ({ kind: 'working' }) });
    const opened = await processLeaderEvent({
      event: leaderEvent(),
      group,
      runtime: createRuntime(createCopierState()),
      context: liveGate(),
      broker,
      clock,
    });
    const followerOrder = broker.orders()[0];
    if (!followerOrder) throw new Error('Test setup: follower order qty 5 nevznikl');
    followerOrder.filledQuantity = 3;

    const canceled: Array<{ accountId: number; brokerOrderId: string }> = [];
    const modified: Array<{ accountId: number; brokerOrderId: string }> = [];
    const observingBroker = {
      ...broker,
      async cancelOrder(accountId: number, brokerOrderId: string) {
        canceled.push({ accountId, brokerOrderId });
      },
      async modifyOrder(
        accountId: number,
        brokerOrderId: string,
        _changes: Parameters<typeof broker.modifyOrder>[2],
      ) {
        modified.push({ accountId, brokerOrderId });
      },
    };

    const result = await processLeaderEvent({
      event: leaderEvent({
        id: 'leader-event-down-to-filled',
        kind: 'replaced',
        quantity: 3,
        limitPrice: 30_002,
        sequence: 2,
      }),
      group,
      runtime: opened.runtime,
      context: liveGate(),
      broker: observingBroker,
      clock,
    });

    expect(canceled).toEqual([{ accountId: 200, brokerOrderId: followerOrder.brokerOrderId }]);
    expect(modified).toEqual([]);
    const modifyEntry = [...result.runtime.cancelOutbox.values()].find(entry => entry.operation === 'modify');
    expect(modifyEntry?.status).toBe('unknown');
    expect(modifyEntry?.reason).toContain('modify nahrazen cancelem zbytku');
  });

  it('4. preflight refused modify neblokuje Flatten, ale dál blokuje nový ARM', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T10:00:00.000Z'));
    const clock = () => Date.now();
    const store = createMemoryCopierStore();
    const broker = createMockBroker({ clock, behavior: () => ({ kind: 'working' }) });
    let controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>> | undefined;

    try {
      controller = await bootstrapCopierRuntime({
        broker,
        store,
        group,
        clock,
        osoCorrelationWindowMs: 5,
        wait: async () => undefined,
      });
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();

      const realFindOrderById = broker.findOrderById.bind(broker);
      let failNextLookup = true;
      broker.findOrderById = async (accountId, brokerOrderId) => {
        if (failNextLookup) {
          failNextLookup = false;
          throw new Error('lookup preflight unavailable');
        }
        return realFindOrderById(accountId, brokerOrderId);
      };

      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-refused',
        sourceVersion: '1:Working',
        updatedAt: clock(),
      }) });
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-refused',
        limitPrice: 30_001,
        sourceVersion: '2:Working',
        updatedAt: clock(),
      }) });
      await controller.waitForIdle();

      const followerOrder = broker.orders().find(order => order.accountId === 200);
      if (!followerOrder) throw new Error('Test setup: follower order pro refused modify nevznikl');
      const refused = (await store.load()).cancelOutbox.find(entry => entry.operation === 'modify');
      expect(refused).toMatchObject({
        operation: 'modify',
        status: 'unknown',
        neverSent: true,
      });
      expect(refused?.reason).toContain('autoritativní stav nedostupný');
      expect(controller.status()).toMatchObject({ armed: false, stuckOutbox: true });

      await expect(controller.flattenAccount(200, 'manual-flat-refused-001')).resolves.toMatchObject({
        flat: true,
        canceledOrders: 1,
      });
      expect(broker.cancelRequestCount(followerOrder.brokerOrderId)).toBe(1);

      await controller.waitForIdle();
      await controller.reconcile();
      expect(controller.status().stuckOutbox).toBe(true);
      expect(() => controller?.arm()).toThrow('nevyřešený outbox');
    } finally {
      controller?.stop();
      vi.useRealTimers();
    }
  });

  it('5. cizí navýšení ochranné nohy se zruší i při nulové lokální pozici', async () => {
    const clock = stepClock();
    const store = createMemoryCopierStore();
    const broker = createMockBroker({ clock, behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker,
      store,
      group,
      clock,
      osoCorrelationWindowMs: 5,
      wait: async () => undefined,
    });

    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();

      const entryOrderId = 'leader-flat-protective-entry';
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: entryOrderId,
        quantity: 2,
        sourceVersion: '1:WorkingEntry',
        updatedAt: clock(),
      }) });
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-flat-protective-stop',
        parentOrderId: entryOrderId,
        side: 'Sell',
        orderType: 'Stop',
        quantity: 2,
        limitPrice: undefined,
        stopPrice: 29_950,
        sourceVersion: '1:WorkingStop',
        updatedAt: clock(),
      }) });
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-flat-protective-target',
        parentOrderId: entryOrderId,
        side: 'Sell',
        quantity: 2,
        limitPrice: 30_100,
        sourceVersion: '1:WorkingTarget',
        updatedAt: clock(),
      }) });
      await controller.waitForIdle();

      const followerStop = broker.orders().find(order =>
        order.accountId === 200 && order.orderType === 'Stop');
      if (!followerStop) throw new Error('Test setup: follower protective Stop nevznikl');
      expect(await broker.listPositions(200)).toEqual([]);
      expect(controller.status().armed).toBe(true);

      const oversizedStop: BrokerOrder = {
        ...followerStop,
        quantity: 3,
        status: 'working',
        sourceVersion: 'venue-oversized-flat-stop',
        updatedAt: clock(),
      };
      Object.assign(followerStop, oversizedStop);
      broker.emitEvent({ type: 'order', order: oversizedStop });
      await controller.waitForIdle();

      expect(controller.status().armed).toBe(false);
      expect(controller.status().lastError).toContain('cizí navýšení');
      expect(controller.status().autoClose).toBeNull();
      expect(broker.cancelRequestCount(followerStop.brokerOrderId)).toBe(1);
      expect(followerStop.status).toBe('canceled');
      expect(broker.placedRequests().filter(request => request.orderType === 'Market')).toHaveLength(0);
    } finally {
      controller.stop();
    }
  });

  it('6. flat sweep MNQ nezruší ochranné nohy NQ na stejném účtu', async () => {
    const clock = stepClock();
    const store = createMemoryCopierStore();
    const broker = createMockBroker({ clock, behavior: () => ({ kind: 'working' }) });

    const mnqOso = await processOsoPair({
      pair: {
        entryOrderId: 'mnq-entry',
        stopOrderId: 'mnq-stop',
        targetOrderId: 'mnq-target',
        accountId: 100,
        symbol: 'MNQU6',
        entrySide: 'Buy',
        quantity: 2,
        entryOrderType: 'Limit',
        entryLimitPrice: 30_000,
        stopPrice: 29_950,
        targetPrice: 30_100,
        detectedAt: clock(),
        correlation: 'inferred-window',
      },
      event: leaderEvent({
        id: 'mnq-stop-event',
        orderId: 'mnq-stop',
        side: 'Sell',
        orderType: 'Stop',
        quantity: 2,
        limitPrice: undefined,
        stopPrice: 29_950,
        sequence: 1,
      }),
      group,
      runtime: createRuntime(createCopierState()),
      context: liveGate(),
      broker,
      clock,
      store,
    });
    const nqBracket = await processBracketPair({
      pair: {
        entryOrderId: 'nq-entry',
        stopOrderId: 'nq-stop',
        targetOrderId: 'nq-target',
        accountId: 100,
        symbol: 'NQU6',
        side: 'Sell',
        quantity: 2,
        stopPrice: 22_000,
        targetPrice: 21_500,
        detectedAt: clock(),
        correlation: 'inferred-window',
      },
      event: leaderEvent({
        id: 'nq-stop-event',
        orderId: 'nq-stop',
        symbol: 'NQU6',
        side: 'Sell',
        orderType: 'Stop',
        quantity: 2,
        limitPrice: undefined,
        stopPrice: 22_000,
        sequence: 2,
      }),
      group,
      runtime: mnqOso.runtime,
      context: liveGate(),
      broker,
      clock,
      store,
    });

    const mnqEntry = [...mnqOso.runtime.osoOutbox.values()][0];
    const nqEntry = [...nqBracket.runtime.bracketOutbox.values()][0];
    const mnqLegIds = [mnqEntry?.firstBrokerOrderId, mnqEntry?.secondBrokerOrderId]
      .filter((id): id is string => Boolean(id));
    const nqLegIds = [nqEntry?.firstBrokerOrderId, nqEntry?.secondBrokerOrderId]
      .filter((id): id is string => Boolean(id));
    expect(mnqLegIds).toHaveLength(2);
    expect(nqLegIds).toHaveLength(2);

    const controller = await bootstrapCopierRuntime({
      broker,
      store,
      group,
      clock,
      wait: async () => undefined,
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      broker.emitEvent({
        type: 'position',
        position: { accountId: 200, symbol: 'NQU6', netQuantity: 2 },
      });
      broker.emitEvent({
        type: 'position',
        position: { accountId: 200, symbol: 'MNQU6', netQuantity: 2 },
      });
      broker.emitEvent({
        type: 'position',
        position: { accountId: 200, symbol: 'MNQU6', netQuantity: 0 },
      });
      await controller.waitForIdle();

      expect(controller.status().lastError).toBeNull();
      for (const brokerOrderId of mnqLegIds) {
        expect(broker.cancelRequestCount(brokerOrderId)).toBe(1);
        expect(broker.orders().find(order => order.brokerOrderId === brokerOrderId)?.status).toBe('canceled');
      }
      for (const brokerOrderId of nqLegIds) {
        expect(broker.cancelRequestCount(brokerOrderId)).toBe(0);
        expect(broker.orders().find(order => order.brokerOrderId === brokerOrderId)?.status).toBe('working');
      }
    } finally {
      controller.stop();
    }
  });
});
