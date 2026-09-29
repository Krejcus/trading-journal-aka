import { describe, expect, it, vi } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { markBracketAcknowledged, createBracketOutboxEntry } from '../services/copierBracketOutbox';
import { createOsoOutboxEntry, markOsoAcknowledged } from '../services/copierOsoOutbox';
import { createOutboxEntry, markAcknowledged, waiveOutboxEntry } from '../services/copierOutbox';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';

const MNQ = 'MNQU6';
const NQ = 'NQU6';

const leaderOrder = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-entry', accountId: 100, symbol: MNQ, side: 'Buy',
  orderType: 'Market', quantity: 2, filledQuantity: 0,
  status: 'working', sourceVersion: '1:Working', updatedAt: 100, ...partial,
});

const groupWith = (
  followers: CopyGroupConfig['followers'],
  safety: Partial<NonNullable<CopyGroupConfig['safety']>> = {},
): CopyGroupConfig => ({
  id: 'v9-v4', name: 'V9 V4', enabled: true, leaderAccountId: 100, followers,
  safety: { ...DEFAULT_COPY_GROUP_SAFETY, armExpiryFlatten: 'followers', ...safety },
});

const activeFollower = (accountId: number) => ({
  accountId, mode: 'on-submit' as const, multiplier: 1,
});

const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

describe('V9 ownership-scoped auto-close', () => {
  it('ARM expiry zavře aktivní kopii, ale vypnutého followera ani jeho ruční pozici neobchoduje', async () => {
    let now = 100;
    const broker = createMockBroker({
      nativeLiquidate: true,
      clock: () => now,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: groupWith([
        activeFollower(200),
        { ...activeFollower(300), enabled: false },
      ]),
      clock: () => now,
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm({ ttlMs: 10 });

    broker.emitEvent({ type: 'order', order: leaderOrder() });
    await controller.waitForIdle();
    broker.setPosition(300, MNQ, 1);
    broker.emitEvent({
      type: 'position', position: { accountId: 300, symbol: MNQ, netQuantity: 1 },
    });
    await controller.waitForIdle();

    now = 200;
    broker.emitEvent({ type: 'heartbeat', at: now });
    await controller.waitForIdle();

    expect(broker.liquidateRequests()).toEqual([
      expect.objectContaining({ accountId: 200, symbol: MNQ }),
    ]);
    expect(await broker.listPositions(300)).toEqual([
      expect.objectContaining({ accountId: 300, symbol: MNQ, netQuantity: 1 }),
    ]);
    expect(controller.status().lastDisarm).toMatchObject({
      trigger: 'arm-expiry', copiesOutcome: 'auto-closed',
    });
    controller.stop();
  });

  it('bez známé copier stopy zachová fail-safe account-wide fallback', async () => {
    let now = 100;
    const broker = createMockBroker({ nativeLiquidate: true, clock: () => now });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: groupWith([activeFollower(200)]),
      clock: () => now,
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm({ ttlMs: 10 });
    broker.setPosition(200, NQ, 1);
    broker.emitEvent({
      type: 'position', position: { accountId: 200, symbol: NQ, netQuantity: 1 },
    });
    await controller.waitForIdle();

    now = 200;
    broker.emitEvent({ type: 'heartbeat', at: now });
    await controller.waitForIdle();

    expect(broker.liquidateRequests()).toEqual([
      expect.objectContaining({ accountId: 200, symbol: NQ }),
    ]);
    controller.stop();
  });

  it('bez skutečné auto-close akce zapíše copiesOutcome flat, ne auto-closed', async () => {
    let now = 100;
    const broker = createMockBroker({ nativeLiquidate: true, clock: () => now });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: groupWith([
        activeFollower(200),
        { ...activeFollower(300), enabled: false },
      ]),
      clock: () => now,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm({ ttlMs: 10 });
    broker.setPosition(300, NQ, 1);
    broker.emitEvent({
      type: 'position', position: { accountId: 300, symbol: NQ, netQuantity: 1 },
    });
    await controller.waitForIdle();

    now = 200;
    broker.emitEvent({ type: 'heartbeat', at: now });
    await controller.waitForIdle();

    expect(broker.liquidateRequests()).toEqual([]);
    expect(controller.status()).toMatchObject({
      autoClose: null,
      lastDisarm: { trigger: 'arm-expiry', copiesOutcome: 'flat' },
    });
    controller.stop();
  });

  it('známá copier stopa omezí auto-close na její symbol a nechá ruční NQ pozici i limit nedotčené', async () => {
    let now = 100;
    const broker = createMockBroker({
      nativeLiquidate: true,
      clock: () => now,
      behavior: request => request.tag === 'manual-nq-limit'
        ? { kind: 'working' }
        : { kind: 'fill', price: 20_000 },
    });
    const store = createMemoryCopierStore();
    const audit = vi.fn();
    const errors: Error[] = [];
    const controller = await bootstrapCopierRuntime({
      broker,
      store,
      group: groupWith([activeFollower(200)]),
      clock: () => now,
      onAudit: audit,
      onError: error => errors.push(error),
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm({ ttlMs: 10 });

    broker.emitEvent({ type: 'order', order: leaderOrder() });
    await controller.waitForIdle();
    broker.setPosition(200, NQ, 1);
    broker.emitEvent({
      type: 'position', position: { accountId: 200, symbol: NQ, netQuantity: 1 },
    });
    const manualLimit = await broker.placeOrder({
      tag: 'manual-nq-limit', accountId: 200, symbol: NQ, side: 'Buy',
      quantity: 1, orderType: 'Limit', limitPrice: 19_000,
    });
    await controller.waitForIdle();

    now = 200;
    broker.emitEvent({ type: 'heartbeat', at: now });
    await controller.waitForIdle();

    expect(broker.liquidateRequests()).toEqual([
      expect.objectContaining({ accountId: 200, symbol: MNQ }),
    ]);
    expect(await broker.listPositions(200)).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: MNQ, netQuantity: 0 }),
      expect.objectContaining({ symbol: NQ, netQuantity: 1 }),
    ]));
    expect((await broker.findOrderById(200, manualLimit.brokerOrderId!)).order)
      .toMatchObject({ symbol: NQ, status: 'working' });
    expect(broker.cancelRequestCount(manualLimit.brokerOrderId!)).toBe(0);
    expect(controller.status()).toMatchObject({
      autoClose: { flat: false },
      lastDisarm: { trigger: 'arm-expiry', copiesOutcome: 'unknown' },
    });
    expect((await store.load()).safety?.liveCopyOpenSince).toBeDefined();
    expect(errors.some(error => error.message.includes('mimo doloženou copier stopu'))).toBe(true);
    expect(audit.mock.calls.flatMap(call => call[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: 200,
        kind: 'blocked',
        reason: expect.stringContaining('mimo doloženou copier stopu'),
      }),
    ]));
    controller.stop();
  });

  it('reconnect drží synchronní zdravou kopii a vypnutou ruční expozici jen hlásí bez auto-close', async () => {
    const broker = createMockBroker({ nativeLiquidate: true });
    broker.setPosition(100, MNQ, 2);
    broker.setPosition(200, MNQ, 2);
    broker.setPosition(300, MNQ, 1);
    const audit = vi.fn();
    const snapshot = emptySnapshot();
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore({
        ...snapshot,
        safety: { ...snapshot.safety!, liveCopyOpenSince: 50 },
      }),
      group: groupWith([
        activeFollower(200),
        { ...activeFollower(300), enabled: false },
      ]),
      onAudit: audit,
    });

    broker.setConnected(true);
    await controller.waitForIdle();

    expect(controller.status()).toMatchObject({ armed: false, autoClose: null });
    expect(broker.liquidateRequests()).toEqual([]);
    expect(await broker.listPositions(200)).toEqual([
      expect.objectContaining({ symbol: MNQ, netQuantity: 2 }),
    ]);
    expect(await broker.listPositions(300)).toEqual([
      expect.objectContaining({ symbol: MNQ, netQuantity: 1 }),
    ]);
    expect(audit.mock.calls.flatMap(call => call[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: 300,
        reason: expect.stringContaining('vypnutý follower'),
      }),
    ]));
    controller.stop();
  });

  it('eligibility-vyřazený follower se známou kopií zůstává cílem fail-closed auto-close', async () => {
    const now = 100;
    const broker = createMockBroker({
      nativeLiquidate: true,
      clock: () => now,
      behavior: request => request.accountId === 201
        ? { kind: 'timeout-before-accept' }
        : { kind: 'fill', price: 20_000 },
    });
    const snapshot = emptySnapshot();
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore({
        ...snapshot,
        safety: {
          ...snapshot.safety!,
          accountEligibility: [{
            accountId: 200, state: 'breached', reason: 'prop breach', at: 50,
          }],
          leaderExposureEpochs: [{
            id: 'owned-before-breach', groupId: 'v9-v4', leaderAccountId: 100,
            symbol: MNQ, openedAt: 40, lastLeaderNet: 2, generation: 1, phase: 'open',
            followers: [{
              accountId: 200, replicationModeAtOpen: 'on-submit', eligibleAtOpen: true,
              copyLineage: 'confirmed', confirmedNetQuantity: 2,
            }],
            leaderEntryOrderIds: ['old-entry'], leaderExitOrderIds: [],
          }],
        },
      }),
      group: groupWith([activeFollower(200), activeFollower(201)]),
      clock: () => now,
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.setPosition(200, MNQ, 2);
    broker.emitEvent({
      type: 'position', position: { accountId: 200, symbol: MNQ, netQuantity: 2 },
    });
    await controller.waitForIdle();
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'trigger-failure' }) });
    await controller.waitForIdle();

    expect(controller.status().armed).toBe(false);
    expect(broker.liquidateRequests()).toEqual([
      expect.objectContaining({ accountId: 200, symbol: MNQ }),
    ]);
    expect(await broker.listPositions(200)).toEqual([
      expect.objectContaining({ symbol: MNQ, netQuantity: 0 }),
    ]);
    controller.stop();
  });

  it('flat sweep bez durable ochranné nohy je no-op bez broker read/write poplachu', async () => {
    const broker = createMockBroker();
    const cancel = vi.spyOn(broker, 'cancelOrder');
    const listOrders = vi.spyOn(broker, 'listOrders');
    const audit = vi.fn();
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: groupWith([activeFollower(200)]),
      onAudit: audit,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    listOrders.mockClear();

    broker.emitEvent({
      type: 'position', position: { accountId: 200, symbol: MNQ, netQuantity: 1 },
    });
    broker.emitEvent({
      type: 'position', position: { accountId: 200, symbol: MNQ, netQuantity: 0 },
    });
    await controller.waitForIdle();

    expect(cancel).not.toHaveBeenCalled();
    expect(listOrders).not.toHaveBeenCalled();
    expect(audit.mock.calls.flatMap(call => call[0]).some(entry => (
      entry.reason?.includes('Flat sweep nedokončen')
    ))).toBe(false);
    controller.stop();
  });
});

describe('V4 durable leader-flat guard', () => {
  it('běžný DISARM v grace okně guard nezruší a prokázaná orphan kopie se cíleně zavře', async () => {
    let now = 100;
    const broker = createMockBroker({
      nativeLiquidate: true,
      clock: () => now,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: groupWith([activeFollower(200)], { autoCloseFollowerPositions: true }),
      clock: () => now,
      leaderFlatGraceMs: 20,
      leaderFlatExitSettlementGraceMs: 0,
      leaderFlatInflightRetryMs: 1,
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({ quantity: 5 }) });
    await controller.waitForIdle();
    broker.setPosition(100, MNQ, 5);
    broker.emitEvent({
      type: 'position', position: { accountId: 100, symbol: MNQ, netQuantity: 5 },
    });
    await controller.waitForIdle();
    broker.setPosition(100, MNQ, 0);
    broker.emitEvent({
      type: 'position', position: { accountId: 100, symbol: MNQ, netQuantity: 0 },
    });
    await controller.waitForIdle();
    controller.disarm();

    now = 200;
    await new Promise(resolve => setTimeout(resolve, 40));
    await controller.waitForIdle();

    expect(broker.liquidateRequests()).toEqual([
      expect.objectContaining({ accountId: 200, symbol: MNQ }),
    ]);
    expect(controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
    controller.stop();
  });

  it('restart s otevřenou grace epochou obnoví read-only guard a nenechá orphan kopii bez dozoru', async () => {
    const broker = createMockBroker({ nativeLiquidate: true });
    broker.setPosition(200, MNQ, 2);
    const snapshot = emptySnapshot();
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore({
        ...snapshot,
        safety: {
          ...snapshot.safety!,
          leaderExposureEpochs: [{
            id: 'restart-grace', groupId: 'v9-v4', leaderAccountId: 100,
            symbol: MNQ, openedAt: 10, lastLeaderNet: 2, generation: 2,
            phase: 'grace', flatObservedAt: 20, graceUntil: 20,
            followers: [{
              accountId: 200, replicationModeAtOpen: 'on-submit', eligibleAtOpen: true,
              copyLineage: 'confirmed', confirmedNetQuantity: 2,
            }],
            leaderEntryOrderIds: ['old-entry'], leaderExitOrderIds: ['old-exit'],
          }],
        },
      }),
      group: groupWith([activeFollower(200)], { autoCloseFollowerPositions: true }),
      leaderFlatExitSettlementGraceMs: 0,
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });

    broker.setConnected(true);
    await controller.waitForIdle();
    await new Promise(resolve => setTimeout(resolve, 10));
    await controller.waitForIdle();

    expect(broker.liquidateRequests()).toEqual([
      expect.objectContaining({ accountId: 200, symbol: MNQ }),
    ]);
    expect(controller.status().armed).toBe(false);
    controller.stop();
  });

  it('opakované změny safety generation mají pevný strop a končí hlasitě bez obchodu', async () => {
    let now = 100;
    const broker = createMockBroker({
      nativeLiquidate: true,
      clock: () => now,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    const audit = vi.fn();
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: groupWith([activeFollower(200)], { autoCloseFollowerPositions: true }),
      clock: () => now,
      leaderFlatGraceMs: 5,
      leaderFlatExitSettlementGraceMs: 0,
      leaderFlatInflightRetryMs: 1,
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
      onAudit: audit,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    broker.emitEvent({ type: 'order', order: leaderOrder({ quantity: 5 }) });
    await controller.waitForIdle();
    broker.setPosition(100, MNQ, 5);
    broker.emitEvent({
      type: 'position', position: { accountId: 100, symbol: MNQ, netQuantity: 5 },
    });
    await controller.waitForIdle();
    broker.setPosition(100, MNQ, 0);
    broker.emitEvent({
      type: 'position', position: { accountId: 100, symbol: MNQ, netQuantity: 0 },
    });
    await controller.waitForIdle();

    const originalListPositions = broker.listPositions.bind(broker);
    broker.listPositions = async accountId => {
      controller.disarm();
      return originalListPositions(accountId);
    };
    now = 200;
    await new Promise(resolve => setTimeout(resolve, 30));
    await controller.waitForIdle();

    expect(broker.liquidateRequests()).toEqual([]);
    expect(controller.status().lastError).toContain('vyčerpal 3 přeplánování');
    expect(audit.mock.calls.flatMap(call => call[0]).filter(entry => (
      entry.reason?.includes('přeplánován po změně safety generation')
    ))).toHaveLength(3);
    controller.stop();
  });

  it('flat follower po restartu uklidí jen doloženou osiřelou copier OCO nohu', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const owned = await broker.placeOrder({
      tag: 'owned-stop', accountId: 200, symbol: MNQ, side: 'Sell', quantity: 2,
      orderType: 'Stop', stopPrice: 19_900,
    });
    const manual = await broker.placeOrder({
      tag: 'manual-nq', accountId: 200, symbol: NQ, side: 'Buy', quantity: 1,
      orderType: 'Limit', limitPrice: 19_000,
    });
    const bracket = markBracketAcknowledged(createBracketOutboxEntry({
      key: 'bracket:restart-owned', tag: 'restart-owned', leaderEntryOrderId: 'leader-entry',
      leaderStopOrderId: 'leader-stop', leaderTargetOrderId: 'leader-target',
      leaderEventId: 'leader-bracket', leaderSequence: 1,
      request: {
        tag: 'restart-owned', accountId: 200, symbol: MNQ, quantity: 2,
        first: { side: 'Sell', orderType: 'Stop', stopPrice: 19_900 },
        second: { side: 'Sell', orderType: 'Limit', limitPrice: 20_100 },
      },
      now: 10,
    }), owned.brokerOrderId!, 'missing-target', 11);
    const snapshot = emptySnapshot();
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore({
        ...snapshot,
        bracketOutbox: [bracket],
        safety: {
          ...snapshot.safety!,
          leaderExposureEpochs: [{
            id: 'restart-flat-oco', groupId: 'v9-v4', leaderAccountId: 100,
            symbol: MNQ, openedAt: 10, lastLeaderNet: 2, generation: 2,
            phase: 'grace', flatObservedAt: 20, graceUntil: 20,
            followers: [{
              accountId: 200, replicationModeAtOpen: 'on-submit', eligibleAtOpen: true,
              copyLineage: 'confirmed', confirmedNetQuantity: 2,
            }],
            leaderEntryOrderIds: ['leader-entry'], leaderExitOrderIds: ['leader-exit'],
          }],
        },
      }),
      group: groupWith([activeFollower(200)]),
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });

    broker.setConnected(true);
    await controller.waitForIdle();
    await new Promise(resolve => setTimeout(resolve, 10));
    await controller.waitForIdle();

    expect(broker.cancelRequestCount(owned.brokerOrderId!)).toBe(1);
    expect((await broker.findOrderById(200, owned.brokerOrderId!)).order?.status).toBe('canceled');
    expect(broker.cancelRequestCount(manual.brokerOrderId!)).toBe(0);
    expect((await broker.findOrderById(200, manual.brokerOrderId!)).order?.status).toBe('working');
    expect(broker.liquidateRequests()).toEqual([]);
    controller.stop();
  });
});

describe('ST4 reconciliation fence', () => {
  it('stream změna během reconciliation se znovu načte a divergence nikdy neskončí ARMED bez chyby', async () => {
    const broker = createMockBroker();
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: groupWith([activeFollower(200)]),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    const originalListPositions = broker.listPositions.bind(broker);
    let releaseFirstRead!: () => void;
    const firstReadBlocked = new Promise<void>(resolve => { releaseFirstRead = resolve; });
    let first = true;
    broker.listPositions = async accountId => {
      if (first) {
        first = false;
        await firstReadBlocked;
      }
      return originalListPositions(accountId);
    };

    const reconciliation = controller.reconcile();
    await Promise.resolve();
    broker.setPosition(200, MNQ, -2);
    broker.emitEvent({
      type: 'position', position: { accountId: 200, symbol: MNQ, netQuantity: -2 },
    });
    releaseFirstRead();

    const result = await reconciliation;
    await controller.waitForIdle();
    expect(result.authoritativelyClean).toBe(false);
    expect(result.divergentAccounts).toContain(200);
    expect(controller.status()).toMatchObject({
      armed: false, reconciliationRequired: true, divergentAccounts: [200],
    });
    controller.stop();
  });
});

describe('balíček 6b — adversariální review sondy', () => {
  it.each([
    { probe: 'P1', pendingBeforeExit: false, forcePending: false },
    { probe: 'P1c', pendingBeforeExit: true, forcePending: false },
    { probe: 'PB', pendingBeforeExit: true, forcePending: true },
  ])('$probe čekající OSO dalšího vstupu není osiřelá ochranná noha', async ({
    pendingBeforeExit,
    forcePending,
  }) => {
    let now = 100;
    const broker = createMockBroker({
      clock: () => now,
      behavior: request => request.orderType === 'Market'
        ? { kind: 'fill', price: 20_000 }
        : { kind: 'working' },
    });
    const originalListOrders = broker.listOrders.bind(broker);
    broker.listOrders = async accountId => {
      const orders = await originalListOrders(accountId);
      const byId = new Map<string, BrokerOrder>(
        orders.map(order => [order.brokerOrderId, order]),
      );
      return orders.map(order => {
        const parent = order.parentOrderId ? byId.get(order.parentOrderId) : undefined;
        return parent && parent.status === 'working' && parent.filledQuantity === 0
          && order.status === 'working'
          ? { ...order, status: 'pending' as const }
          : order;
      });
    };
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: groupWith([activeFollower(200)]),
      clock: () => now,
      leaderFlatGraceMs: 20,
      leaderFlatExitSettlementGraceMs: 0,
      leaderFlatInflightRetryMs: 1,
      osoCorrelationWindowMs: 5,
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'l-in', quantity: 1 }) });
    await controller.waitForIdle();
    broker.setPosition(100, MNQ, 1);
    broker.emitEvent({
      type: 'position', position: { accountId: 100, symbol: MNQ, netQuantity: 1 },
    });
    await controller.waitForIdle();

    const submitPendingOso = async () => {
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'oso-entry', quantity: 1, orderType: 'Limit', limitPrice: 19_900,
      }) });
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'oso-stop', parentOrderId: 'oso-entry', quantity: 1,
        side: 'Sell', orderType: 'Stop', stopPrice: 19_800,
      }) });
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'oso-target', parentOrderId: 'oso-entry', quantity: 1,
        side: 'Sell', orderType: 'Limit', limitPrice: 20_100,
      }) });
      await tick(15);
      await controller.waitForIdle();
      const copiedLegs = broker.orders().filter(order => (
        order.accountId === 200 && order.parentOrderId != null
      ));
      if (forcePending) {
        for (const leg of copiedLegs) leg.status = 'pending';
      }
      return copiedLegs;
    };

    let copiedLegs: BrokerOrder[] = [];
    if (pendingBeforeExit) {
      now = 105;
      copiedLegs = await submitPendingOso();
    }
    now = 110;
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'l-out', quantity: 1, side: 'Sell', sourceVersion: 'exit:w',
    }) });
    await controller.waitForIdle();
    broker.setPosition(100, MNQ, 0);
    broker.emitEvent({
      type: 'position', position: { accountId: 100, symbol: MNQ, netQuantity: 0 },
    });
    await controller.waitForIdle();
    if (!pendingBeforeExit) {
      now = 120;
      copiedLegs = await submitPendingOso();
    }

    now = 1_000;
    await tick(60);
    await controller.waitForIdle();

    expect(copiedLegs).toHaveLength(2);
    expect(copiedLegs.map(order => broker.cancelRequestCount(order.brokerOrderId))).toEqual([0, 0]);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    controller.stop();
  });

  it('P6 fill mezi guard order/position readem nikdy nezruší ochranu nové pozice', async () => {
    let now = 100;
    const broker = createMockBroker({
      clock: () => now,
      behavior: request => request.orderType === 'Market'
        ? { kind: 'fill', price: 20_000 }
        : { kind: 'working' },
    });
    const originalListOrders = broker.listOrders.bind(broker);
    const originalListPositions = broker.listPositions.bind(broker);
    let skewFill = false;
    let guardProbeActive = false;
    let guardedPositionReads = 0;
    broker.listOrders = async accountId => {
      let orders = await originalListOrders(accountId);
      if (guardProbeActive && accountId === 200) {
        if (skewFill) {
          skewFill = false;
          broker.setPosition(200, MNQ, 1);
        }
        orders = orders.map(order => (
          order.orderType === 'Limit' && !order.parentOrderId && order.status === 'working'
            ? { ...order, status: 'filled' as const, filledQuantity: order.quantity }
            : order
        ));
      }
      const byId = new Map<string, BrokerOrder>(
        orders.map(order => [order.brokerOrderId, order]),
      );
      return orders.map(order => {
        const parent = order.parentOrderId ? byId.get(order.parentOrderId) : undefined;
        return parent && parent.status === 'working' && parent.filledQuantity === 0
          && order.status === 'working'
          ? { ...order, status: 'pending' as const }
          : order;
      });
    };
    broker.listPositions = async accountId => {
      if (accountId === 200 && guardProbeActive) {
        guardedPositionReads += 1;
        return [];
      }
      return originalListPositions(accountId);
    };
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: groupWith([activeFollower(200)]),
      clock: () => now,
      leaderFlatGraceMs: 20,
      leaderFlatExitSettlementGraceMs: 0,
      leaderFlatInflightRetryMs: 1,
      osoCorrelationWindowMs: 5,
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'l-in', quantity: 1 }) });
    await controller.waitForIdle();
    broker.setPosition(100, MNQ, 1);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: MNQ, netQuantity: 1 } });
    await controller.waitForIdle();
    now = 110;
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'l-out', quantity: 1, side: 'Sell', sourceVersion: 'exit:w',
    }) });
    await controller.waitForIdle();
    broker.setPosition(100, MNQ, 0);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: MNQ, netQuantity: 0 } });
    await controller.waitForIdle();
    now = 120;
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'oso-entry', quantity: 1, orderType: 'Limit', limitPrice: 19_900,
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'oso-stop', parentOrderId: 'oso-entry', quantity: 1,
      side: 'Sell', orderType: 'Stop', stopPrice: 19_800,
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'oso-target', parentOrderId: 'oso-entry', quantity: 1,
      side: 'Sell', orderType: 'Limit', limitPrice: 20_100,
    }) });
    await tick(15);
    await controller.waitForIdle();
    const followerLegs = broker.orders().filter(order => (
      order.accountId === 200 && order.parentOrderId != null
    ));

    now = 1_000;
    skewFill = true;
    guardProbeActive = true;
    await tick(60);
    await controller.waitForIdle();

    expect(guardedPositionReads).toBe(3);
    expect(followerLegs.map(order => broker.cancelRequestCount(order.brokerOrderId))).toEqual([0, 0]);
    expect(followerLegs.every(order => order.status === 'working')).toBe(true);
    expect(controller.status()).toMatchObject({
      armed: false,
      lastError: expect.stringContaining('nekonzistentní broker snapshot'),
    });
    guardProbeActive = false;
    expect(await broker.listPositions(200)).toEqual([
      expect.objectContaining({ symbol: MNQ, netQuantity: 1 }),
    ]);
    controller.stop();
  });

  it('PA restart s čekajícím OSO mimo epochu zůstane blokovaný bez broker write', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const leaderOso = await broker.placeOso({
      tag: 'leader-next', accountId: 100, symbol: MNQ, side: 'Buy', quantity: 1,
      orderType: 'Limit', limitPrice: 19_000,
      first: { side: 'Sell', orderType: 'Stop', stopPrice: 18_900 },
      second: { side: 'Sell', orderType: 'Limit', limitPrice: 19_100 },
    });
    const copyOso = await broker.placeOso({
      tag: 'copy-next', accountId: 200, symbol: MNQ, side: 'Buy', quantity: 1,
      orderType: 'Limit', limitPrice: 19_000,
      first: { side: 'Sell', orderType: 'Stop', stopPrice: 18_900 },
      second: { side: 'Sell', orderType: 'Limit', limitPrice: 19_100 },
    });
    for (const id of [leaderOso.firstBrokerOrderId, leaderOso.secondBrokerOrderId,
      copyOso.firstBrokerOrderId, copyOso.secondBrokerOrderId]) {
      broker.orders().find(order => order.brokerOrderId === id)!.status = 'pending';
    }
    const oso = markOsoAcknowledged(createOsoOutboxEntry({
      key: 'oso:copy-next', tag: 'copy-next', leaderEntryOrderId: leaderOso.entryBrokerOrderId,
      leaderStopOrderId: leaderOso.firstBrokerOrderId,
      leaderTargetOrderId: leaderOso.secondBrokerOrderId,
      leaderEventId: 'leader-next', leaderSequence: 1,
      request: {
        tag: 'copy-next', accountId: 200, symbol: MNQ, side: 'Buy', quantity: 1,
        orderType: 'Limit', limitPrice: 19_000,
        first: { side: 'Sell', orderType: 'Stop', stopPrice: 18_900 },
        second: { side: 'Sell', orderType: 'Limit', limitPrice: 19_100 },
      },
      updatedAt: 10,
    }), copyOso.entryBrokerOrderId, copyOso.firstBrokerOrderId, copyOso.secondBrokerOrderId, 11);
    const snapshot = emptySnapshot();
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore({
        ...snapshot,
        osoOutbox: [oso],
        safety: {
          ...snapshot.safety!,
          leaderExposureEpochs: [{
            id: 'restart-grace', groupId: 'v9-v4', leaderAccountId: 100,
            symbol: MNQ, openedAt: 10, lastLeaderNet: 1, generation: 2,
            phase: 'grace', flatObservedAt: 20, graceUntil: 20,
            followers: [{
              accountId: 200, replicationModeAtOpen: 'on-submit', eligibleAtOpen: true,
              copyLineage: 'confirmed', confirmedNetQuantity: 1,
            }],
            leaderEntryOrderIds: ['old-entry'], leaderExitOrderIds: ['old-exit'],
          }],
        },
      }),
      group: groupWith([activeFollower(200)]),
      leaderFlatExitSettlementGraceMs: 0,
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await tick();
    await controller.waitForIdle();

    expect(controller.status().armed).toBe(false);
    expect(broker.liquidateRequests()).toEqual([]);
    expect([copyOso.entryBrokerOrderId, copyOso.firstBrokerOrderId, copyOso.secondBrokerOrderId]
      .map(id => broker.cancelRequestCount(id))).toEqual([0, 0, 0]);
    controller.stop();
  });

  it('PC waived fill bez otevřené epochy získá stopu z otevřeného symbolu leadera', async () => {
    const broker = createMockBroker({ nativeLiquidate: true });
    broker.setPosition(100, MNQ, 1);
    broker.setPosition(200, MNQ, 2);
    const nq = markAcknowledged(createOutboxEntry('k-nq', 't-nq', 'l-nq', {
      tag: 't-nq', accountId: 200, symbol: NQ, side: 'Buy', quantity: 1, orderType: 'Market',
    }, 1), 'b-nq', 2);
    const mnq = waiveOutboxEntry(markAcknowledged(createOutboxEntry('k-mnq', 't-mnq', 'l-mnq', {
      tag: 't-mnq', accountId: 200, symbol: MNQ, side: 'Buy', quantity: 2, orderType: 'Market',
    }, 3), 'b-mnq', 4), 'operátor waived', 5);
    const snapshot = emptySnapshot();
    const store = createMemoryCopierStore({
      ...snapshot,
      outbox: [nq, mnq],
      safety: { ...snapshot.safety!, liveCopyOpenSince: 1 },
    });
    const controller = await bootstrapCopierRuntime({
      broker,
      store,
      group: groupWith([activeFollower(200)]),
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await tick();
    await controller.waitForIdle();

    expect(broker.liquidateRequests()).toEqual([
      expect.objectContaining({ accountId: 200, symbol: MNQ }),
    ]);
    expect(await broker.listPositions(200)).toEqual([
      expect.objectContaining({ symbol: MNQ, netQuantity: 0 }),
    ]);
    expect(controller.status().autoClose).toMatchObject({ flat: true, submittedClosures: 1 });
    expect((await store.load()).safety).not.toHaveProperty('liveCopyOpenSince');
    controller.stop();
  });

  it('P2 vlastní reconcile sweep + jeden další leader event dostanou omezený read-only pokus', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const owned = await broker.placeOrder({
      tag: 'owned-stop', accountId: 200, symbol: MNQ, side: 'Sell', quantity: 1,
      orderType: 'Stop', stopPrice: 19_900,
    });
    const bracket = markBracketAcknowledged(createBracketOutboxEntry({
      key: 'bracket:p2', tag: 'p2', leaderEntryOrderId: 'leader-entry',
      leaderStopOrderId: 'leader-stop', leaderTargetOrderId: 'leader-target',
      leaderEventId: 'leader-bracket', leaderSequence: 1,
      request: {
        tag: 'p2', accountId: 200, symbol: MNQ, quantity: 1,
        first: { side: 'Sell', orderType: 'Stop', stopPrice: 19_900 },
        second: { side: 'Sell', orderType: 'Limit', limitPrice: 20_100 },
      },
      now: 10,
    }), owned.brokerOrderId!, 'missing-target', 11);
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore({ ...emptySnapshot(), bracketOutbox: [bracket] }),
      group: groupWith([activeFollower(200)]),
    });
    let leaderReads = 0;
    let probeActive = false;
    const originalListPositions = broker.listPositions.bind(broker);
    broker.listPositions = async accountId => {
      if (probeActive && accountId === 100) {
        leaderReads += 1;
        if (leaderReads === 2) {
          broker.emitEvent({ type: 'order', order: leaderOrder({
            brokerOrderId: 'leader-nq-limit', symbol: NQ,
            orderType: 'Limit', limitPrice: 18_000,
          }) });
        }
      }
      return originalListPositions(accountId);
    };
    broker.setConnected(true);
    await controller.waitForIdle();
    probeActive = true;

    await expect(controller.reconcile()).resolves.toMatchObject({ authoritativelyClean: true });
    await controller.waitForIdle();
    expect(leaderReads).toBe(3);
    expect(broker.cancelRequestCount(owned.brokerOrderId!)).toBe(1);
    expect((await broker.findOrderById(200, owned.brokerOrderId!)).order?.status).toBe('canceled');
    controller.stop();
  });

  it('P3 DISARMED leader aktivita guard jen omezeně přeplánuje a nezanechá falešnou chybu', async () => {
    let now = 100;
    const broker = createMockBroker({
      nativeLiquidate: true,
      clock: () => now,
      behavior: request => request.orderType === 'Market'
        ? { kind: 'fill', price: 20_000 }
        : { kind: 'working' },
    });
    const audit = vi.fn();
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: groupWith([activeFollower(200)], { autoCloseFollowerPositions: true }),
      clock: () => now,
      leaderFlatGraceMs: 5,
      leaderFlatExitSettlementGraceMs: 0,
      leaderFlatInflightRetryMs: 1,
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
      onAudit: audit,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'l-in', quantity: 1 }) });
    await controller.waitForIdle();
    broker.setPosition(100, MNQ, 1);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: MNQ, netQuantity: 1 } });
    await controller.waitForIdle();
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'l-out', quantity: 1, side: 'Sell', sourceVersion: 'exit:w',
    }) });
    await controller.waitForIdle();
    broker.setPosition(100, MNQ, 0);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: MNQ, netQuantity: 0 } });
    await controller.waitForIdle();
    controller.disarm();

    let leaderReads = 0;
    const originalListPositions = broker.listPositions.bind(broker);
    broker.listPositions = async accountId => {
      if (accountId === 100 && leaderReads < 6) {
        leaderReads += 1;
        broker.emitEvent({ type: 'order', order: leaderOrder({
          brokerOrderId: `nq-${leaderReads}`, symbol: NQ,
          orderType: 'Limit', limitPrice: 18_000 + leaderReads,
        }) });
      }
      return originalListPositions(accountId);
    };
    now = 200;
    await tick(40);
    await controller.waitForIdle();

    expect(audit.mock.calls.flatMap(call => call[0]).filter(entry => (
      entry.reason?.includes('přeplánován po změně safety generation')
    ))).toHaveLength(1);
    expect(controller.status()).toMatchObject({ armed: false, lastError: null });
    broker.listPositions = originalListPositions;
    await expect(controller.reconcile()).resolves.toBeDefined();
    expect(() => controller.arm()).not.toThrow();
    expect(controller.status().armed).toBe(true);
    controller.stop();
  });

  it.each([
    { probe: 'P4', killBeforeResume: true, expectedCancels: 0 },
    { probe: 'P5', killBeforeResume: false, expectedCancels: 1 },
  ])('$probe kill switch nezpůsobí další broker write guardu', async ({
    killBeforeResume,
    expectedCancels,
  }) => {
    let now = 100;
    const broker = createMockBroker({ clock: () => now, behavior: () => ({ kind: 'working' }) });
    const owned = await broker.placeOrder({
      tag: 'owned-stop', accountId: 200, symbol: MNQ, side: 'Sell', quantity: 2,
      orderType: 'Stop', stopPrice: 19_900,
    });
    const bracket = markBracketAcknowledged(createBracketOutboxEntry({
      key: 'bracket:kill-probe', tag: 'kill-probe', leaderEntryOrderId: 'leader-entry',
      leaderStopOrderId: 'leader-stop', leaderTargetOrderId: 'leader-target',
      leaderEventId: 'leader-bracket', leaderSequence: 1,
      request: {
        tag: 'kill-probe', accountId: 200, symbol: MNQ, quantity: 2,
        first: { side: 'Sell', orderType: 'Stop', stopPrice: 19_900 },
        second: { side: 'Sell', orderType: 'Limit', limitPrice: 20_100 },
      },
      now: 10,
    }), owned.brokerOrderId!, 'missing-target', 11);
    const snapshot = emptySnapshot();
    const controller = await bootstrapCopierRuntime({
      broker,
      clock: () => now,
      store: createMemoryCopierStore({
        ...snapshot,
        bracketOutbox: [bracket],
        safety: {
          ...snapshot.safety!,
          leaderExposureEpochs: [{
            id: 'kill-probe-grace', groupId: 'v9-v4', leaderAccountId: 100,
            symbol: MNQ, openedAt: 10, lastLeaderNet: 2, generation: 2,
            phase: 'grace', flatObservedAt: 90, graceUntil: 130,
            followers: [{
              accountId: 200, replicationModeAtOpen: 'on-submit', eligibleAtOpen: true,
              copyLineage: 'confirmed', confirmedNetQuantity: 2,
            }],
            leaderEntryOrderIds: ['leader-entry'], leaderExitOrderIds: ['leader-exit'],
          }],
        },
      }),
      group: groupWith([activeFollower(200)]),
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    if (!killBeforeResume) await controller.waitForIdle();
    const cancelsBeforeKill = broker.cancelRequestCount(owned.brokerOrderId!);
    controller.engageKillSwitch('review probe');
    now = 200;
    await tick(60);
    await controller.waitForIdle();

    expect(cancelsBeforeKill).toBe(expectedCancels);
    expect(broker.cancelRequestCount(owned.brokerOrderId!)).toBe(expectedCancels);
    expect(controller.status()).toMatchObject({ armed: false, killSwitch: true });
    controller.stop();
  });
});
