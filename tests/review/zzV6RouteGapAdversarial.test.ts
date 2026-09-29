import { describe, expect, it } from 'vitest';
import type { BrokerEvent, BrokerFill, BrokerOrder } from '../../services/brokerPort';
import { bootstrapCopierRuntime } from '../../services/copierRuntimeController';
import { createMemoryCopierStore } from '../../services/copierStore';
import type { CopyGroupConfig } from '../../services/liveCopyTrading';
import { createMockBroker } from '../../services/mockBroker';
import { createBrokerRouter } from '../../services/brokerRouter';

const VERSION = 'assertions';
const log = (..._args: unknown[]) => undefined;

const baseGroup: CopyGroupConfig = {
  id: 'v6p', name: 'V6P', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
};
const stepClock = () => { let now = 1_000; return () => ++now; };
const resyncEvent = (at: number, snapshot: {
  accountIds: number[]; positions?: { accountId: number; symbol: string; netQuantity: number }[];
  orders?: BrokerOrder[]; gapFills?: BrokerFill[];
}): BrokerEvent => ({
  type: 'connection', connected: true, at, resynced: true, routeGap: false,
  resync: { positions: [], orders: [], gapFills: [], ...snapshot },
} as BrokerEvent);

const setupArmed = async (group: CopyGroupConfig = baseGroup, behavior?: Parameters<typeof createMockBroker>[0]) => {
  const broker = createMockBroker({ nativeLiquidate: true, ...behavior });
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(), group, clock: stepClock(), wait: async () => undefined,
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  return { broker, controller };
};
const settle = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

describe(`V6 adversarial probes [${VERSION}]`, () => {
  it('PA: leader fill znameho orderu nedoruceny pred mezerou, order+pozice dorucene -> nesmi zustat ARMED bez kopie', async () => {
    const { broker, controller } = await setupArmed();
    // Kontrola: stejny scenar s live fillem kopiruje (fill je spoustec kopie).
    broker.emitEvent({ type: 'order', order: {
      tag: '', brokerOrderId: 'L1', accountId: 100, symbol: 'MNQU6', side: 'Buy', orderType: 'Market',
      quantity: 1, filledQuantity: 1, status: 'filled', updatedAt: 1_500,
    } });
    broker.setPosition(100, 'MNQU6', 1);
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
    await controller.waitForIdle();
    const before = { armed: controller.status().armed, placed: broker.placedRequests().length, lastError: controller.status().lastError };
    log('PA pred resync', JSON.stringify(before));
    broker.emitEvent(resyncEvent(3_000, {
      accountIds: [100, 200],
      positions: [{ accountId: 100, symbol: 'MNQU6', netQuantity: 1 }],
      gapFills: [{ fillId: 'F1', tag: '', brokerOrderId: 'L1', accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 30_000, filledAt: 1_500 }],
    }));
    await controller.waitForIdle();
    await settle(200);
    await controller.waitForIdle();
    const after = {
      armed: controller.status().armed,
      placed: broker.placedRequests().length,
      followerPos: (await broker.listPositions(200)).find(p => p.symbol === 'MNQU6')?.netQuantity ?? 0,
      leaderPos: (await broker.listPositions(100)).find(p => p.symbol === 'MNQU6')?.netQuantity ?? 0,
      lastError: controller.status().lastError,
      lastDisarm: controller.status().lastDisarm?.code ?? null,
    };
    log('PA po resync', JSON.stringify(after));
    controller.stop();
    expect(after.armed).toBe(false);
    expect(after.lastDisarm).toBe('route-gap-divergence');
    expect(after.lastError).toContain('leader gap fill');
    expect(after.placed).toBe(0);
  });

  it('PB: leader exit v mezere, follower otevreny -> pre ho zavre / hlida, novy?', async () => {
    const { broker, controller } = await setupArmed();
    const lo = { tag: '', brokerOrderId: 'lo-1', accountId: 100, symbol: 'MNQU6', side: 'Buy' as const, orderType: 'Market' as const,
      quantity: 1, filledQuantity: 0, status: 'working' as const, sourceVersion: '1:Working', updatedAt: 1_590 };
    broker.emitEvent({ type: 'order', order: lo });
    await controller.waitForIdle();
    broker.setPosition(100, 'MNQU6', 1);
    broker.emitEvent({ type: 'order', order: { ...lo, status: 'filled', filledQuantity: 1, sourceVersion: '1:Filled', updatedAt: 1_600 } });
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'lf-1', tag: '', brokerOrderId: 'lo-1', accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 30_000, filledAt: 1_600,
    } });
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
    await controller.waitForIdle();
    await settle();
    await controller.waitForIdle();
    const followerAfterCopy = (await broker.listPositions(200)).find(p => p.symbol === 'MNQU6')?.netQuantity ?? 0;
    const placedBefore = broker.placedRequests().length;
    const liqBefore = broker.liquidateRequests().length;
    log('PB po kopii', JSON.stringify({ armed: controller.status().armed, followerAfterCopy, placedBefore, liqBefore }));
    // Mezera: leader zavrel pozici neznamym orderem.
    broker.setPosition(100, 'MNQU6', 0);
    broker.emitEvent(resyncEvent(4_000, {
      accountIds: [100, 200],
      positions: [{ accountId: 200, symbol: 'MNQU6', netQuantity: followerAfterCopy }],
      gapFills: [{ fillId: 'lf-exit', tag: '', brokerOrderId: 'lo-exit', accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 1, price: 29_990, filledAt: 3_900 }],
    }));
    await controller.waitForIdle();
    for (let i = 0; i < 40; i += 1) { await settle(100); await controller.waitForIdle(); }
    const follower = (await broker.listPositions(200)).find(p => p.symbol === 'MNQU6')?.netQuantity ?? 0;
    const out = {
      armed: controller.status().armed,
      followerNow: follower,
      placedAfter: broker.placedRequests().length - placedBefore,
      liquidateAfter: broker.liquidateRequests().length - liqBefore,
      lastError: controller.status().lastError?.slice(0, 160),
      reconciliationRequired: controller.status().reconciliationRequired,
      blocker: (controller as { connectionRenewalBlocker?: () => string | null }).connectionRenewalBlocker?.() ?? 'n/a',
    };
    log('PB po resync+4s', JSON.stringify(out));
    controller.stop();
    expect(out.armed).toBe(false);
    expect(out.blocker).toBe('connection recovery');
    expect(out.reconciliationRequired).toBe(true);
    expect(out.lastError).toContain('route-gap-divergence');
  });

  it('PC: disabled follower na route -> planovana obmena nesmi falesne DISARM', async () => {
    const group: CopyGroupConfig = {
      ...baseGroup,
      followers: [
        { accountId: 200, mode: 'on-submit', multiplier: 1 },
        { accountId: 201, mode: 'on-submit', multiplier: 1, enabled: false },
      ],
    };
    const { broker, controller } = await setupArmed(group);
    broker.emitEvent(resyncEvent(5_000, { accountIds: [100, 200, 201] }));
    await controller.waitForIdle();
    const out = { armed: controller.status().armed, lastError: controller.status().lastError?.slice(0, 200) ?? null };
    log('PC', JSON.stringify(out));
    controller.stop();
    expect(out.armed).toBe(true);
  });

  it('PD: blocker nevidi leader fill cekajici ve fronte controlleru', async () => {
    const { broker, controller } = await setupArmed();
    if (!('connectionRenewalBlocker' in controller)) { log('PD n/a'); return; }
    broker.emitEvent({ type: 'order', order: { tag: '', brokerOrderId: 'lo-q', accountId: 100, symbol: 'MNQU6', side: 'Buy', orderType: 'Market',
      quantity: 1, filledQuantity: 0, status: 'working', sourceVersion: '1:Working', updatedAt: 1_590 } });
    const blockerImmediately = controller.connectionRenewalBlocker();
    const flatImmediately = controller.status().groupFlat;
    await controller.waitForIdle();
    log('PD', JSON.stringify({ blockerImmediately, flatImmediately, placedAfterIdle: broker.placedRequests().length }));
    controller.stop();
    expect(blockerImmediately).toBe('leader event queue');
    expect(flatImmediately).toBe(true);
  });

  it('PD2: po zpracovani leader eventu drzi blocker petisekundove klidove okno', async () => {
    let now = 1_000;
    const broker = createMockBroker({ nativeLiquidate: true });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: baseGroup,
      clock: () => 1_000, connectionRenewalClock: () => now,
      connectionRenewalQuietMs: 5_000,
      wait: async () => undefined,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({
      type: 'position',
      position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 },
    });
    expect(controller.connectionRenewalBlocker()).toBe('leader event queue');
    await controller.waitForIdle();
    expect(controller.connectionRenewalBlocker()).toBe('leader event quiet window');
    now += 4_999;
    expect(controller.connectionRenewalBlocker()).toBe('leader event quiet window');
    now += 1;
    expect(controller.connectionRenewalBlocker()).toBeNull();
    controller.stop();
  });

  it('PE: po stateful recovery se synchronni otevrenou pozici blocker trva (obmena odlozena)', async () => {
    const { broker, controller } = await setupArmed();
    if (!('connectionRenewalBlocker' in controller)) { log('PE n/a'); return; }
    broker.setPosition(100, 'MNQU6', 1);
    broker.emitEvent({ type: 'fill', fill: {
      fillId: 'lf-e', tag: '', brokerOrderId: 'lo-e', accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 30_000, filledAt: 1_600,
    } });
    broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
    await controller.waitForIdle(); await settle(); await controller.waitForIdle();
    broker.setConnected(false); await controller.waitForIdle();
    broker.setConnected(true); await controller.waitForIdle();
    for (let i = 0; i < 10; i += 1) { await settle(50); await controller.waitForIdle(); }
    const out = { armed: controller.status().armed, blocker: controller.connectionRenewalBlocker(), groupFlat: controller.status().groupFlat };
    log('PE', JSON.stringify(out));
    controller.stop();
    expect(out.blocker).toBe('connection recovery');
  });
});

const enterWithCopy = async () => {
  const { broker, controller } = await setupArmed();
  const lo = { tag: '', brokerOrderId: 'lo-1', accountId: 100, symbol: 'MNQU6', side: 'Buy' as const, orderType: 'Market' as const,
    quantity: 1, filledQuantity: 0, status: 'working' as const, sourceVersion: '1:Working', updatedAt: 1_590 };
  broker.emitEvent({ type: 'order', order: lo });
  await controller.waitForIdle();
  broker.setPosition(100, 'MNQU6', 1);
  broker.emitEvent({ type: 'order', order: { ...lo, status: 'filled', filledQuantity: 1, sourceVersion: '1:Filled', updatedAt: 1_600 } });
  broker.emitEvent({ type: 'fill', fill: { fillId: 'lf-1', tag: '', brokerOrderId: 'lo-1', accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 30_000, filledAt: 1_600 } });
  broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
  for (let i = 0; i < 5; i += 1) { await settle(20); await controller.waitForIdle(); }
  return { broker, controller };
};
const leaderStop = (stopPrice: number, version: number): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-sl', accountId: 100, symbol: 'MNQU6', side: 'Sell', orderType: 'Stop',
  quantity: 1, filledQuantity: 0, stopPrice, status: 'working', sourceVersion: `${version}:Working`, updatedAt: 1_700 + version,
});
const followerStops = (broker: ReturnType<typeof createMockBroker>) => broker.orders()
  .filter(order => order.accountId === 200 && order.orderType === 'Stop' && order.status === 'working')
  .map(order => order.stopPrice);

describe(`V6 SL v mezere [${VERSION}]`, () => {
  it('PF: leader zadal SL v mezere -> follower dostane ochranu?', async () => {
    const { broker, controller } = await enterWithCopy();
    const followerPos = (await broker.listPositions(200)).find(p => p.symbol === 'MNQU6')?.netQuantity ?? 0;
    const sl = leaderStop(29_900, 1);
    broker.emitEvent({ type: 'order', order: sl });
    await controller.waitForIdle();
    broker.emitEvent(resyncEvent(5_000, {
      accountIds: [100, 200],
      positions: [{ accountId: 100, symbol: 'MNQU6', netQuantity: 1 }, { accountId: 200, symbol: 'MNQU6', netQuantity: followerPos }],
      orders: [sl, ...broker.orders().filter(o => o.accountId === 200)],
    }));
    for (let i = 0; i < 40; i += 1) { await settle(50); await controller.waitForIdle(); }
    const out = { followerPos, armed: controller.status().armed, followerStops: followerStops(broker), lastError: controller.status().lastError?.slice(0, 140) ?? null };
    log('PF', JSON.stringify(out));
    controller.stop();
    // Stejná baseline jako 23011e6: samostatný Stop bez párového kontextu
    // tato sonda neklasifikuje jako OCO ochranu. Renewal ji nesmí zhoršit.
    expect(out).toMatchObject({ armed: true, followerStops: [], lastError: null });
  });

  it('PG: leader posunul SL v mezere -> follower SL zustane stary?', async () => {
    const { broker, controller } = await enterWithCopy();
    broker.emitEvent({ type: 'order', order: leaderStop(29_900, 1) });
    for (let i = 0; i < 5; i += 1) { await settle(20); await controller.waitForIdle(); }
    const stopsBefore = followerStops(broker);
    const followerPos = (await broker.listPositions(200)).find(p => p.symbol === 'MNQU6')?.netQuantity ?? 0;
    const moved = leaderStop(30_000, 2);
    broker.emitEvent({ type: 'order', order: moved });
    await controller.waitForIdle();
    broker.emitEvent(resyncEvent(6_000, {
      accountIds: [100, 200],
      positions: [{ accountId: 100, symbol: 'MNQU6', netQuantity: 1 }, { accountId: 200, symbol: 'MNQU6', netQuantity: followerPos }],
      orders: [moved, ...broker.orders().filter(o => o.accountId === 200)],
    }));
    for (let i = 0; i < 40; i += 1) { await settle(50); await controller.waitForIdle(); }
    const out = { stopsBefore, stopsAfter: followerStops(broker), modifies: broker.modifyRequests().length, armed: controller.status().armed, lastError: controller.status().lastError?.slice(0, 140) ?? null };
    log('PG', JSON.stringify(out));
    controller.stop();
    expect(out).toMatchObject({ armed: true, stopsBefore: [], stopsAfter: [], modifies: 0 });
  });
});

describe(`V6 OCO SL posun v mezere [${VERSION}]`, () => {
  it('PH: leader OCO SL/TP zrcadleny, SL posunut v mezere -> follower SL?', async () => {
    const { broker, controller } = await enterWithCopy();
    const stop = (stopPrice: number, v: number): BrokerOrder => ({
      tag: '', brokerOrderId: 'leader-sl', accountId: 100, symbol: 'MNQU6', side: 'Sell', orderType: 'Stop',
      quantity: 1, filledQuantity: 0, stopPrice, status: 'working', sourceVersion: `${v}:Working`, updatedAt: 1_700 + v,
      ocoId: 'oco-1', linkedOrderId: 'leader-tp',
    });
    const tp: BrokerOrder = {
      tag: '', brokerOrderId: 'leader-tp', accountId: 100, symbol: 'MNQU6', side: 'Sell', orderType: 'Limit',
      quantity: 1, filledQuantity: 0, limitPrice: 30_100, status: 'working', sourceVersion: '1:Working', updatedAt: 1_701,
      ocoId: 'oco-1', linkedOrderId: 'leader-sl',
    };
    broker.emitEvent({ type: 'order', order: stop(29_900, 1) });
    broker.emitEvent({ type: 'order', order: tp });
    for (let i = 0; i < 40; i += 1) { await settle(50); await controller.waitForIdle(); }
    const stopsBefore = followerStops(broker);
    const ocoBefore = broker.placedOcoRequests().length;
    const followerPos = (await broker.listPositions(200)).find(p => p.symbol === 'MNQU6')?.netQuantity ?? 0;
    const armedBefore = controller.status().armed;
    const moved = stop(30_000, 2);
    broker.emitEvent({ type: 'order', order: moved });
    broker.emitEvent({ type: 'order', order: tp });
    await controller.waitForIdle();
    broker.emitEvent(resyncEvent(7_000, {
      accountIds: [100, 200],
      positions: [{ accountId: 100, symbol: 'MNQU6', netQuantity: 1 }, { accountId: 200, symbol: 'MNQU6', netQuantity: followerPos }],
      orders: [moved, tp, ...broker.orders().filter(o => o.accountId === 200)],
    }));
    for (let i = 0; i < 20; i += 1) { await settle(50); await controller.waitForIdle(); }
    const out = { armedBefore, ocoBefore, stopsBefore, stopsAfter: followerStops(broker), modifies: broker.modifyRequests().map(m => m.changes.stopPrice), armed: controller.status().armed, lastError: controller.status().lastError?.slice(0, 160) ?? null };
    log('PH', JSON.stringify(out));
    controller.stop();
    expect(out.stopsAfter).toEqual([30_000]);
  });
});

describe(`V6 OCO SL/TP zalozeny v mezere [${VERSION}]`, () => {
  it('PI: vstup zkopirovan live, leader SL+TP OCO vznikl v mezere -> follower chranen?', async () => {
    const { broker, controller } = await enterWithCopy();
    const sl: BrokerOrder = {
      tag: '', brokerOrderId: 'leader-sl', accountId: 100, symbol: 'MNQU6', side: 'Sell', orderType: 'Stop',
      quantity: 1, filledQuantity: 0, stopPrice: 29_900, status: 'working', sourceVersion: '1:Working', updatedAt: 1_701,
      ocoId: 'oco-1', linkedOrderId: 'leader-tp',
    };
    const tp: BrokerOrder = {
      tag: '', brokerOrderId: 'leader-tp', accountId: 100, symbol: 'MNQU6', side: 'Sell', orderType: 'Limit',
      quantity: 1, filledQuantity: 0, limitPrice: 30_100, status: 'working', sourceVersion: '1:Working', updatedAt: 1_702,
      ocoId: 'oco-1', linkedOrderId: 'leader-sl',
    };
    const followerPos = (await broker.listPositions(200)).find(p => p.symbol === 'MNQU6')?.netQuantity ?? 0;
    broker.emitEvent({ type: 'order', order: sl });
    broker.emitEvent({ type: 'order', order: tp });
    await controller.waitForIdle();
    broker.emitEvent(resyncEvent(7_000, {
      accountIds: [100, 200],
      positions: [{ accountId: 100, symbol: 'MNQU6', netQuantity: 1 }, { accountId: 200, symbol: 'MNQU6', netQuantity: followerPos }],
      orders: [sl, tp, ...broker.orders().filter(o => o.accountId === 200)],
    }));
    for (let i = 0; i < 40; i += 1) { await settle(50); await controller.waitForIdle(); }
    const out = { followerPos, followerStops: followerStops(broker), oco: broker.placedOcoRequests().length, armed: controller.status().armed, lastError: controller.status().lastError?.slice(0, 120) ?? null };
    log('PI', JSON.stringify(out));
    controller.stop();
    expect(out.followerStops.length).toBeGreaterThan(0);
  });
});

describe(`V6 router agregat [${VERSION}]`, () => {
  for (const followerCritical of [true, false]) {
    it(`PJ: follower route resync (critical=${followerCritical}) pri vypadku leader route -> controller nesmi byt connected/ARM`, async () => {
      const leader = createMockBroker({ nativeLiquidate: true });
      const follower = createMockBroker({ nativeLiquidate: true });
      const router = createBrokerRouter([
        { broker: leader, accountIds: [100], critical: true },
        { broker: follower, accountIds: [200], critical: followerCritical },
      ], { reconnectGraceMs: 10_000 });
      const controller = await bootstrapCopierRuntime({
        broker: router, store: createMemoryCopierStore(), group: baseGroup, clock: stepClock(), wait: async () => undefined,
      });
      leader.setConnected(true);
      follower.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      const armedStart = controller.status().armed;
      // Leader WS spadne (skutecny vypadek), follower mezitim dokonci planovanou obmenu.
      leader.setConnected(false);
      await controller.waitForIdle();
      const afterLeaderDown = { connected: controller.status().connected, armed: controller.status().armed };
      follower.emitEvent({
        type: 'connection', connected: true, at: 9_000, resynced: true,
        resync: { accountIds: [200], positions: [], orders: [], gapFills: [] },
      } as BrokerEvent);
      await controller.waitForIdle();
      for (let i = 0; i < 5; i += 1) { await settle(20); await controller.waitForIdle(); }
      const afterFollowerResync = { connected: controller.status().connected, armed: controller.status().armed, reconciliationRequired: controller.status().reconciliationRequired };
      let reArm = 'n/a';
      try { await controller.reconcile(); controller.arm(); reArm = `armed=${controller.status().armed}`; } catch (e) { reArm = `throw: ${(e as Error).message.slice(0, 100)}`; }
      // Leader trade behem vypadku jeho WS se nikdy nedorucí.
      const out = { armedStart, afterLeaderDown, afterFollowerResync, reArm, leaderConnectedAtBroker: false };
      log(`PJ critical=${followerCritical}`, JSON.stringify(out));
      expect(afterFollowerResync.connected).toBe(false);
      expect(afterFollowerResync.armed).toBe(false);
      expect(reArm).toContain('worker nemá živé spojení s Tradovate');
      controller.stop();
    });
  }
});
