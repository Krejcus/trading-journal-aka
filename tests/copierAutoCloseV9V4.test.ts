import { describe, expect, it, vi } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { markBracketAcknowledged, createBracketOutboxEntry } from '../services/copierBracketOutbox';
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
