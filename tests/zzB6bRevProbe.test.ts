import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { markBracketAcknowledged, createBracketOutboxEntry } from '../services/copierBracketOutbox';
import { createOsoOutboxEntry, markOsoAcknowledged } from '../services/copierOsoOutbox';
import { createOutboxEntry, markAcknowledged, waiveOutboxEntry } from '../services/copierOutbox';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';

const MNQ = 'MNQU6';
const groupWith = (
  followers: CopyGroupConfig['followers'],
  safety: Partial<NonNullable<CopyGroupConfig['safety']>> = {},
): CopyGroupConfig => ({
  id: 'v9-v4', name: 'V9 V4', enabled: true, leaderAccountId: 100, followers,
  safety: { ...DEFAULT_COPY_GROUP_SAFETY, armExpiryFlatten: 'followers', ...safety },
});
const activeFollower = (accountId: number) => ({ accountId, mode: 'on-submit' as const, multiplier: 1 });
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const out = (name: string, value: unknown) => {
  const result = value as Record<string, unknown>;
  switch (name) {
    case 'R1':
    case 'R2':
      expect(result).toMatchObject({ targetCancels: 1, targetStatus: 'canceled', liquidations: [] });
      expect(result.errorsAfterHeartbeats).toBe(result.errorsBeforeHeartbeats);
      return;
    case 'R3':
      expect(result).toMatchObject({
        targetCancels: 1,
        targetStatus: 'canceled',
        liquidations: [`300:${MNQ}`],
        pos300: [0],
      });
      expect(result.errorsAfterHeartbeats).toBe(result.errorsBeforeHeartbeats);
      return;
    case 'R4':
      expect(result).toMatchObject({ ownedCancels: 1, ownedStatus: 'canceled' });
      return;
    case 'R5':
    case 'R5m':
      expect(result).toMatchObject({
        targetCancels: 1,
        targetStatus: 'canceled',
        armed: true,
        lastError: null,
        errors: [],
      });
      return;
    case 'R6':
      expect(result).toMatchObject({
        target200Cancels: 1,
        target200Status: 'canceled',
        liquidations: [],
        armed: true,
        lastError: null,
        errorsAfterGuard: 0,
        errorsAfter3Heartbeats: 0,
      });
      return;
    case 'R6x':
      expect(result).toMatchObject({
        target200Cancels: 1,
        target200Status: 'canceled',
        pos300: [0],
        liquidations: [`300:${MNQ}`],
        armed: false,
      });
      expect(result.errorsAfter3Heartbeats).toBe(result.errorsAfterGuard);
      return;
    case 'R6i':
      expect(result).toMatchObject({
        target200Cancels: 0,
        target200Status: 'working',
        pos300: [0],
        liquidations: [`300:${MNQ}`],
        armed: false,
      });
      expect(result.errorsAfterGuard).toBe(1);
      expect(result.errorsAfter3Heartbeats).toBe(result.errorsAfterGuard);
      return;
    case 'R6r':
      expect(result).toMatchObject({
        reconcileResult: { clean: true, divergent: [], working: [] },
        armAfterReconcile: true,
        target200Cancels: 1,
        target200Status: 'canceled',
        errorsAfterGuard: 0,
        errorsAfter3Heartbeats: 0,
        errorsAfterReconcileAndHeartbeats: 0,
      });
      return;
    case 'R8-leaderFlat':
      expect(result).toMatchObject({ liquidations: [], pos200: [`${MNQ}=2`] });
      return;
    case 'R8-leaderOpen':
      expect(result).toMatchObject({ liquidations: [`200:${MNQ}`], pos200: [`${MNQ}=0`] });
      return;
    case 'R9-noLineage':
    case 'R9-lineage':
      expect(result).toMatchObject({ liquidations: [] });
      expect(result.lastError).toEqual(expect.stringContaining('follower exit stále čeká'));
      return;
    default:
      throw new Error(`Neznámá B6b review sonda ${name}`);
  }
};
const leaderOrder = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-entry', accountId: 100, symbol: MNQ, side: 'Buy',
  orderType: 'Market', quantity: 1, filledQuantity: 0,
  status: 'working', sourceVersion: '1:Working', updatedAt: 100, ...partial,
});

const osoReq = (accountId: number, tag: string) => ({
  tag, accountId, symbol: MNQ, side: 'Buy' as const, quantity: 1,
  orderType: 'Limit' as const, limitPrice: 19_000,
  first: { side: 'Sell' as const, orderType: 'Stop' as const, stopPrice: 18_900 },
  second: { side: 'Sell' as const, orderType: 'Limit' as const, limitPrice: 19_100 },
});

async function restartOsoOrphan(name: string, o: { lineage: boolean; follower300: boolean; heartbeats: number }) {
  const broker = createMockBroker({ nativeLiquidate: true, behavior: () => ({ kind: 'working' }) });
  const leaderOso = await broker.placeOso(osoReq(100, 'leader-oso'));
  const copyOso = await broker.placeOso(osoReq(200, 'copy-oso'));
  const set = (id: string, patch: Partial<BrokerOrder>) => Object.assign(
    broker.orders().find(order => order.brokerOrderId === id)!, patch,
  );
  // Leader: vstup vyplněn, SL vyplněn, TP zrušen -> flat.
  set(leaderOso.entryBrokerOrderId, { status: 'filled', filledQuantity: 1 });
  set(leaderOso.firstBrokerOrderId, { status: 'filled', filledQuantity: 1 });
  set(leaderOso.secondBrokerOrderId, { status: 'canceled' });
  // Follower: vstup vyplněn, SL vyplněn (pozice 0), TP venue NEzrušil -> skutečná osiřelá noha.
  set(copyOso.entryBrokerOrderId, { status: 'filled', filledQuantity: 1 });
  set(copyOso.firstBrokerOrderId, { status: 'filled', filledQuantity: 1 });
  if (o.follower300) broker.setPosition(300, MNQ, 1);
  const oso = markOsoAcknowledged(createOsoOutboxEntry({
    key: 'oso:copy-oso', tag: 'copy-oso', leaderEntryOrderId: leaderOso.entryBrokerOrderId,
    leaderStopOrderId: leaderOso.firstBrokerOrderId, leaderTargetOrderId: leaderOso.secondBrokerOrderId,
    leaderEventId: 'leader-oso', leaderSequence: 1, request: osoReq(200, 'copy-oso'), updatedAt: 10,
  }), copyOso.entryBrokerOrderId, copyOso.firstBrokerOrderId, copyOso.secondBrokerOrderId, 11);
  const snapshot = emptySnapshot();
  const errors: string[] = [];
  const audits: string[] = [];
  const followers = [200, ...(o.follower300 ? [300] : [])];
  const controller = await bootstrapCopierRuntime({
    broker,
    store: createMemoryCopierStore({
      ...snapshot,
      osoOutbox: [oso],
      safety: {
        ...snapshot.safety!,
        leaderExposureEpochs: [{
          id: 'restart-oso', groupId: 'v9-v4', leaderAccountId: 100,
          symbol: MNQ, openedAt: 10, lastLeaderNet: 1, generation: 2,
          phase: 'grace', flatObservedAt: 20, graceUntil: 20,
          followers: followers.map(accountId => ({
            accountId, replicationModeAtOpen: 'on-submit' as const, eligibleAtOpen: true,
            copyLineage: 'confirmed' as const, confirmedNetQuantity: 1,
          })),
          leaderEntryOrderIds: o.lineage ? [leaderOso.entryBrokerOrderId] : ['other-entry'],
          leaderExitOrderIds: [leaderOso.firstBrokerOrderId],
        }],
      },
    }),
    group: groupWith(followers.map(activeFollower), { autoCloseFollowerPositions: true }),
    leaderFlatExitSettlementGraceMs: 0,
    flattenConfirmationAttempts: 2,
    flattenConfirmationPollMs: 0,
    wait: async () => undefined,
    onError: error => errors.push(error.message),
    onAudit: entries => { for (const entry of entries) audits.push(`${entry.kind}:${entry.reason ?? ''}`.slice(0, 140)); },
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await tick();
  await controller.waitForIdle();
  const errorsBeforeHeartbeats = errors.length;
  for (let i = 0; i < o.heartbeats; i += 1) {
    broker.emitEvent({ type: 'heartbeat', at: Date.now() });
    await tick(20);
    await controller.waitForIdle();
  }
  const target = broker.orders().find(order => order.brokerOrderId === copyOso.secondBrokerOrderId)!;
  out(name, {
    targetCancels: broker.cancelRequestCount(copyOso.secondBrokerOrderId),
    targetStatus: target.status,
    liquidations: broker.liquidateRequests().map(r => `${r.accountId}:${r.symbol}`),
    pos300: o.follower300 ? (await broker.listPositions(300)).map(p => p.netQuantity) : null,
    armed: controller.status().armed,
    lastError: controller.status().lastError,
    errorsBeforeHeartbeats,
    errorsAfterHeartbeats: errors.length,
    errors: errors.slice(0, 3),
    guardAudits: audits.filter(a => /leader-flat|nekonzist|osiřel/.test(a)).slice(0, 6),
  });
  controller.stop();
}

describe('b6b rev sondy', () => {
  it('R1 restart: skutečná osiřelá OSO TP noha nad flat followerem (linie epochy) + 3 heartbeaty', async () => {
    await restartOsoOrphan('R1', { lineage: true, follower300: false, heartbeats: 3 });
  });
  it('R2 restart: osiřelá OSO TP noha mimo linii epochy', async () => {
    await restartOsoOrphan('R2', { lineage: false, follower300: false, heartbeats: 0 });
  });
  it('R3 restart: osiřelá OSO noha u 200 + follower 300 drží orphan kopii', async () => {
    await restartOsoOrphan('R3', { lineage: true, follower300: true, heartbeats: 0 });
  });

  it('R4 restart: legacy epocha bez leaderEntryOrderIds + osiřelá OCO noha', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const owned = await broker.placeOrder({
      tag: 'owned-stop', accountId: 200, symbol: MNQ, side: 'Sell', quantity: 2,
      orderType: 'Stop', stopPrice: 19_900,
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
    const errors: string[] = [];
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
              accountId: 200, replicationModeAtOpen: 'on-submit', eligibleAtOpen: false,
              copyLineage: 'unproven',
            }],
            leaderEntryOrderIds: [], leaderExitOrderIds: [],
          }],
        },
      }),
      group: groupWith([activeFollower(200)]),
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
      onError: error => errors.push(error.message),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await tick(10);
    await controller.waitForIdle();
    out('R4', {
      ownedCancels: broker.cancelRequestCount(owned.brokerOrderId!),
      ownedStatus: (await broker.findOrderById(200, owned.brokerOrderId!)).order?.status,
      armed: controller.status().armed, lastError: controller.status().lastError,
      errors: errors.slice(0, 3),
    });
    controller.stop();
  });

  it.each([
    { name: 'R5', missFollowerExit: false },
    { name: 'R5m', missFollowerExit: true },
  ])('$name živý ARMED OSO obchod, exit přes SL', async ({ name, missFollowerExit }) => {
    let now = 100;
    const broker = createMockBroker({
      clock: () => now,
      behavior: request => request.orderType === 'Market'
        ? { kind: 'fill', price: 20_000 }
        : { kind: 'working' },
    });
    const errors: string[] = [];
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
      onError: error => errors.push(error.message),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'oso-entry', orderType: 'Limit', limitPrice: 19_900 }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'oso-stop', parentOrderId: 'oso-entry', side: 'Sell', orderType: 'Stop', stopPrice: 19_800 }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'oso-target', parentOrderId: 'oso-entry', side: 'Sell', orderType: 'Limit', limitPrice: 20_100 }) });
    await tick(15);
    await controller.waitForIdle();
    const copyEntry = broker.orders().find(order => order.accountId === 200 && !order.parentOrderId)!;
    const copyLegs = broker.orders().filter(order => order.accountId === 200 && order.parentOrderId);
    const copyStop = copyLegs.find(order => order.orderType === 'Stop')!;
    const copyTarget = copyLegs.find(order => order.orderType === 'Limit')!;

    now = 105;
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'oso-entry', orderType: 'Limit', limitPrice: 19_900, status: 'filled', filledQuantity: 1, sourceVersion: '2:Filled' }) });
    broker.emitEvent({ type: 'fill', fill: { fillId: 'lf1', tag: '', brokerOrderId: 'oso-entry', accountId: 100, symbol: MNQ, side: 'Buy', quantity: 1, price: 19_900, filledAt: now } });
    broker.setPosition(100, MNQ, 1);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: MNQ, netQuantity: 1 } });
    await controller.waitForIdle();
    copyEntry.status = 'filled'; copyEntry.filledQuantity = 1;
    broker.emitEvent({ type: 'order', order: { ...copyEntry, sourceVersion: 'c:2' } });
    broker.emitEvent({ type: 'fill', fill: { fillId: 'ff1', tag: copyEntry.tag, brokerOrderId: copyEntry.brokerOrderId, accountId: 200, symbol: MNQ, side: 'Buy', quantity: 1, price: 19_900, filledAt: now } });
    broker.setPosition(200, MNQ, 1);
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: MNQ, netQuantity: 1 } });
    await controller.waitForIdle();

    now = 110;
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'oso-stop', parentOrderId: 'oso-entry', side: 'Sell', orderType: 'Stop', stopPrice: 19_800, status: 'filled', filledQuantity: 1, sourceVersion: '3:Filled' }) });
    broker.emitEvent({ type: 'fill', fill: { fillId: 'lf2', tag: '', brokerOrderId: 'oso-stop', accountId: 100, symbol: MNQ, side: 'Sell', quantity: 1, price: 19_800, filledAt: now } });
    broker.setPosition(100, MNQ, 0);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: MNQ, netQuantity: 0 } });
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'oso-target', parentOrderId: 'oso-entry', side: 'Sell', orderType: 'Limit', limitPrice: 20_100, status: 'canceled', sourceVersion: '3:Canceled' }) });
    await controller.waitForIdle();
    copyStop.status = 'filled'; copyStop.filledQuantity = 1;
    broker.setPosition(200, MNQ, 0);
    if (!missFollowerExit) {
      broker.emitEvent({ type: 'order', order: { ...copyStop, sourceVersion: 'c:3' } });
      broker.emitEvent({ type: 'fill', fill: { fillId: 'ff2', tag: copyStop.tag, brokerOrderId: copyStop.brokerOrderId, accountId: 200, symbol: MNQ, side: 'Sell', quantity: 1, price: 19_800, filledAt: now } });
      broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: MNQ, netQuantity: 0 } });
    }
    await controller.waitForIdle();
    const targetBeforeGuard = copyTarget.status;
    now = 1_000;
    await tick(60);
    await controller.waitForIdle();
    out(name, {
      targetBeforeGuard,
      targetCancels: broker.cancelRequestCount(copyTarget.brokerOrderId),
      targetStatus: copyTarget.status,
      armed: controller.status().armed,
      lastError: controller.status().lastError,
      errors: errors.slice(0, 3),
    });
    controller.stop();
  });
});

describe('b6b rev sondy — živý tok bez doručené cancel/exit události', () => {
  it.each([
    { name: 'R6', withSecond: false },
    { name: 'R6x', withSecond: true },
    { name: 'R6i', withSecond: true, inconsistent200: true },
    { name: 'R6r', withSecond: false, reconcileAfter: true },
  ])('$name', async ({ name, withSecond, reconcileAfter, inconsistent200 }: {
    name: string;
    withSecond: boolean;
    reconcileAfter?: boolean;
    inconsistent200?: boolean;
  }) => {
    let now = 100;
    const broker = createMockBroker({
      clock: () => now,
      nativeLiquidate: true,
      behavior: request => request.orderType === 'Market'
        ? { kind: 'fill', price: 20_000 }
        : { kind: 'working' },
    });
    const errors: string[] = [];
    const followers = [200, ...(withSecond ? [300] : [])];
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: groupWith(followers.map(activeFollower), { autoCloseFollowerPositions: true }),
      clock: () => now,
      leaderFlatGraceMs: 20,
      leaderFlatExitSettlementGraceMs: 0,
      leaderFlatInflightRetryMs: 1,
      osoCorrelationWindowMs: 5,
      flattenConfirmationAttempts: 2,
      flattenConfirmationPollMs: 0,
      wait: async () => undefined,
      onError: error => errors.push(error.message),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'oso-entry', orderType: 'Limit', limitPrice: 19_900 }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'oso-stop', parentOrderId: 'oso-entry', side: 'Sell', orderType: 'Stop', stopPrice: 19_800 }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'oso-target', parentOrderId: 'oso-entry', side: 'Sell', orderType: 'Limit', limitPrice: 20_100 }) });
    await tick(15);
    await controller.waitForIdle();
    const legsOf = (accountId: number) => {
      const entry = broker.orders().find(order => order.accountId === accountId && !order.parentOrderId)!;
      const legs = broker.orders().filter(order => order.accountId === accountId && order.parentOrderId);
      return { entry, stop: legs.find(order => order.orderType === 'Stop')!, target: legs.find(order => order.orderType === 'Limit')! };
    };
    const c200 = legsOf(200);
    const c300 = withSecond ? legsOf(300) : null;

    now = 105;
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'oso-entry', orderType: 'Limit', limitPrice: 19_900, status: 'filled', filledQuantity: 1, sourceVersion: '2:Filled' }) });
    broker.emitEvent({ type: 'fill', fill: { fillId: 'lf1', tag: '', brokerOrderId: 'oso-entry', accountId: 100, symbol: MNQ, side: 'Buy', quantity: 1, price: 19_900, filledAt: now } });
    broker.setPosition(100, MNQ, 1);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: MNQ, netQuantity: 1 } });
    await controller.waitForIdle();
    for (const [accountId, c] of [[200, c200], [300, c300]] as const) {
      if (!c) continue;
      c.entry.status = 'filled'; c.entry.filledQuantity = 1;
      broker.emitEvent({ type: 'order', order: { ...c.entry, sourceVersion: `c${accountId}:2` } });
      broker.emitEvent({ type: 'fill', fill: { fillId: `ff1-${accountId}`, tag: c.entry.tag, brokerOrderId: c.entry.brokerOrderId, accountId, symbol: MNQ, side: 'Buy', quantity: 1, price: 19_900, filledAt: now } });
      broker.setPosition(accountId, MNQ, 1);
      broker.emitEvent({ type: 'position', position: { accountId, symbol: MNQ, netQuantity: 1 } });
      await controller.waitForIdle();
    }

    // Exit přes SL leadera; cancel TP leadera (venue OCO) stream nedoručil,
    // follower 200 SL fill + flat také nedoručen. Follower 300 zůstal long.
    now = 110;
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'oso-stop', parentOrderId: 'oso-entry', side: 'Sell', orderType: 'Stop', stopPrice: 19_800, status: 'filled', filledQuantity: 1, sourceVersion: '3:Filled' }) });
    broker.emitEvent({ type: 'fill', fill: { fillId: 'lf2', tag: '', brokerOrderId: 'oso-stop', accountId: 100, symbol: MNQ, side: 'Sell', quantity: 1, price: 19_800, filledAt: now } });
    broker.setPosition(100, MNQ, 0);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: MNQ, netQuantity: 0 } });
    await controller.waitForIdle();
    c200.stop.status = 'filled'; c200.stop.filledQuantity = 1;
    broker.setPosition(200, MNQ, 0);
    const targetBeforeGuard = c200.target.status;
    now = 1_000;
    if (inconsistent200) c200.entry.updatedAt = now + 1;
    await tick(60);
    await controller.waitForIdle();
    const errorsAfterGuard = errors.length;
    for (let i = 0; i < 3; i += 1) {
      now += 1_000;
      broker.emitEvent({ type: 'heartbeat', at: now });
      await tick(20);
      await controller.waitForIdle();
    }
    let reconcileResult: unknown = null;
    let errorsAfterReconcileAndHeartbeats: number | null = null;
    let armAfterReconcile: unknown = null;
    if (reconcileAfter) {
      try {
        const r = await controller.reconcile();
        reconcileResult = { clean: r.authoritativelyClean, divergent: r.divergentAccounts, working: r.workingOrderAccounts };
      } catch (e) { reconcileResult = String(e); }
      try { controller.arm(); armAfterReconcile = controller.status().armed; } catch (e) { armAfterReconcile = String(e); }
      for (let i = 0; i < 2; i += 1) {
        now += 1_000;
        broker.emitEvent({ type: 'heartbeat', at: now });
        await tick(20);
        await controller.waitForIdle();
      }
      errorsAfterReconcileAndHeartbeats = errors.length;
    }
    out(name, {
      reconcileResult, armAfterReconcile, errorsAfterReconcileAndHeartbeats,
      targetBeforeGuard,
      target200Cancels: broker.cancelRequestCount(c200.target.brokerOrderId),
      target200Status: c200.target.status,
      pos300: withSecond ? (await broker.listPositions(300)).map(p => p.netQuantity) : null,
      liquidations: broker.liquidateRequests().map(r => `${r.accountId}:${r.symbol}`),
      armed: controller.status().armed,
      lastError: controller.status().lastError,
      errorsAfterGuard,
      errorsAfter3Heartbeats: errors.length,
      errors: [...new Set(errors)].slice(0, 4),
    });
    controller.stop();
  });
});

describe('b6b rev sondy — V9 stopa', () => {
  it.each([
    { name: 'R8-leaderFlat', leaderNet: 0 },
    { name: 'R8-leaderOpen', leaderNet: 1 },
  ])('$name waived fill mimo stopu', async ({ name, leaderNet }) => {
    const broker = createMockBroker({ nativeLiquidate: true });
    broker.setPosition(100, MNQ, leaderNet);
    broker.setPosition(200, MNQ, 2);
    const nq = markAcknowledged(createOutboxEntry('k-nq', 't-nq', 'l-nq', {
      tag: 't-nq', accountId: 200, symbol: 'NQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    }, 1), 'b-nq', 2);
    const mnq = waiveOutboxEntry(markAcknowledged(createOutboxEntry('k-mnq', 't-mnq', 'l-mnq', {
      tag: 't-mnq', accountId: 200, symbol: MNQ, side: 'Buy', quantity: 2, orderType: 'Market',
    }, 3), 'b-mnq', 4), 'operátor waived', 5);
    const snapshot = emptySnapshot();
    const errors: string[] = [];
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore({ ...snapshot, outbox: [nq, mnq], safety: { ...snapshot.safety!, liveCopyOpenSince: 1 } }),
      group: groupWith([activeFollower(200)]),
      flattenConfirmationAttempts: 2, flattenConfirmationPollMs: 0, wait: async () => undefined,
      onError: error => errors.push(error.message),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await tick();
    await controller.waitForIdle();
    out(name, {
      liquidations: broker.liquidateRequests().map(r => `${r.accountId}:${r.symbol}`),
      pos200: (await broker.listPositions(200)).map(p => `${p.symbol}=${p.netQuantity}`),
      autoClose: controller.status().autoClose, lastDisarm: controller.status().lastDisarm,
      errors: errors.slice(0, 3),
    });
    controller.stop();
  });
});

describe('b6b rev sondy — linie epochy a settlement evidence', () => {
  it.each([
    { name: 'R9-noLineage', lineage: false },
    { name: 'R9-lineage', lineage: true },
  ])('$name čerstvě vyplněný copier SL, pozice ještě dobíhá', async ({ name, lineage }) => {
    const now = 1_000;
    const broker = createMockBroker({ nativeLiquidate: true, clock: () => now, behavior: () => ({ kind: 'working' }) });
    const stop = await broker.placeOrder({ tag: 'own-stop', accountId: 200, symbol: MNQ, side: 'Sell', quantity: 1, orderType: 'Stop', stopPrice: 19_900 });
    Object.assign(broker.orders().find(o => o.brokerOrderId === stop.brokerOrderId)!, { status: 'filled', filledQuantity: 1, updatedAt: 900 });
    broker.setPosition(200, MNQ, 1);
    const bracket = markBracketAcknowledged(createBracketOutboxEntry({
      key: 'bracket:own', tag: 'own', leaderEntryOrderId: 'leader-entry',
      leaderStopOrderId: 'leader-stop', leaderTargetOrderId: 'leader-target',
      leaderEventId: 'leader-bracket', leaderSequence: 1,
      request: { tag: 'own', accountId: 200, symbol: MNQ, quantity: 1,
        first: { side: 'Sell', orderType: 'Stop', stopPrice: 19_900 },
        second: { side: 'Sell', orderType: 'Limit', limitPrice: 20_100 } },
      now: 10,
    }), stop.brokerOrderId!, 'missing-target', 11);
    let guardArmed = false;
    let flipped = false;
    const originalListPositions = broker.listPositions.bind(broker);
    broker.listPositions = async accountId => {
      const result = await originalListPositions(accountId);
      if (accountId === 200 && guardArmed && !flipped) flipped = true;
      return result;
    };
    const errors: string[] = [];
    const snapshot = emptySnapshot();
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore({ ...snapshot, bracketOutbox: [bracket], safety: { ...snapshot.safety!, leaderExposureEpochs: [{
        id: 'e9', groupId: 'v9-v4', leaderAccountId: 100, symbol: MNQ, openedAt: 10, lastLeaderNet: 1, generation: 2,
        phase: 'grace', flatObservedAt: 20, graceUntil: 20,
        followers: [{ accountId: 200, replicationModeAtOpen: 'on-submit', eligibleAtOpen: true, copyLineage: 'confirmed', confirmedNetQuantity: 1 }],
        leaderEntryOrderIds: lineage ? ['leader-entry'] : ['other-entry'], leaderExitOrderIds: [],
      }] } }),
      group: groupWith([activeFollower(200)], { autoCloseFollowerPositions: true }),
      clock: () => now,
      leaderFlatExitSettlementGraceMs: 5_000,
      leaderFlatInflightRetryMs: 1,
      flattenConfirmationAttempts: 2, flattenConfirmationPollMs: 0, wait: async () => undefined,
      onError: error => errors.push(error.message),
      onAudit: entries => { if (entries.some(e => (e.reason ?? '').includes('leader-flat guard obnoven'))) guardArmed = true; },
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await tick(40);
    await controller.waitForIdle();
    out(name, {
      guardArmed, flipped,
      liquidations: broker.liquidateRequests().map(r => `${r.accountId}:${r.symbol}`),
      lastError: controller.status().lastError,
      errors: [...new Set(errors)].slice(0, 3),
    });
    controller.stop();
  });
});
