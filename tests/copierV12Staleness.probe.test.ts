// V12c staleness/masking probes (scratchpad only). Runs against afae767 and cb5cdf6^ exports.
import { describe, expect, it } from 'vitest';
import type { BrokerEvent, BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker } from './_laMock';
import { createBrokerRouter } from '../services/brokerRouter';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const group: CopyGroupConfig = {
  id: 'g1', name: 'Group', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
};
const lo = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-1', accountId: 100, symbol: 'MNQU6', side: 'Buy',
  orderType: 'Limit', quantity: 2, filledQuantity: 0, limitPrice: 29_500,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...partial,
});
let base = 100;
const clock = () => ++base;
const behavior = (r: any) => r.orderType === 'Market' ? { kind: 'fill', price: 30_550 } : { kind: 'working' };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const acctOf = (e: BrokerEvent) => e.type === 'order' ? e.order.accountId
  : e.type === 'fill' ? e.fill.accountId : e.type === 'position' ? e.position.accountId : undefined;

/** Follower (200) WS lag: events are held until release(). */
function withFollowerLag(broker: any) {
  const held: BrokerEvent[] = [];
  const sinks = new Set<(e: BrokerEvent) => void>();
  let lag = false;
  const rawSubscribe = broker.subscribe.bind(broker);
  broker.subscribe = (listener: (e: BrokerEvent) => void) => {
    sinks.add(listener);
    const unsub = rawSubscribe((event: BrokerEvent) => {
      if (lag && acctOf(event) === 200) { held.push(event); return; }
      listener(event);
    });
    return () => { sinks.delete(listener); unsub(); };
  };
  return {
    on() { lag = true; },
    release() {
      lag = false;
      const events = held.splice(0);
      for (const e of events) for (const s of sinks) s(e);
      return events.length;
    },
    heldCount: () => held.length,
  };
}

async function setup(opts: { lagWrap?: boolean } = {}) {
  base = 100;
  const broker: any = createMockBroker({ behavior } as any);
  const lag = opts.lagWrap ? withFollowerLag(broker) : null;
  const controller = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group, clock });
  broker.setConnected(true);
  await controller.waitForIdle(); await controller.reconcile(); controller.arm();
  return { broker, controller, lag };
}
const tick = async (broker: any, controller: any, ms: number) => {
  base += ms; broker.emitEvent({ type: 'heartbeat', at: base }); await controller.waitForIdle();
};
const summary = (broker: any, controller: any, extra: Record<string, unknown> = {}) => JSON.stringify({
  placed: broker.placedRequests().filter((r: any) => r.accountId !== 100).map((r: any) => `${r.accountId}:${r.side}:${r.orderType}:${r.quantity}`),
  armed: controller.status().armed,
  lastError: (controller.status().lastError ?? null)?.slice?.(0, 110) ?? null,
  followerPos: broker.positions ? undefined : undefined,
  ...extra,
});
const resyncSnapshot = async (broker: any, accountIds: number[]) => ({
  accountIds,
  positions: (await Promise.all(accountIds.map(accountId => broker.listPositions(accountId)))).flat(),
  orders: (await Promise.all(accountIds.map(accountId => broker.listOrders(accountId)))).flat(),
  gapFills: [],
});

/** C0 prefix: TP Sell Limit 8 from flat (copied), 60 s later Market Buy 8 (copied), follower synced. */
async function prefix(broker: any, controller: any, opts: { holdFollowerEntry?: ReturnType<typeof withFollowerLag> } = {}) {
  const lim = lo({ brokerOrderId: 'L-lim', side: 'Sell', quantity: 8, orderType: 'Limit', limitPrice: 30_618 });
  broker.emitEvent({ type: 'order', order: lim });
  await controller.waitForIdle();
  await tick(broker, controller, 60_000);
  if (opts.holdFollowerEntry) opts.holdFollowerEntry.on();
  const mkt = lo({ brokerOrderId: 'L-mkt', side: 'Buy', quantity: 8, orderType: 'Market', limitPrice: undefined });
  broker.emitEvent({ type: 'order', order: mkt });
  await controller.waitForIdle();
  broker.emitEvent({ type: 'order', order: { ...mkt, status: 'filled', filledQuantity: 8, sourceVersion: '2:Filled', updatedAt: 2 } });
  broker.emitEvent({ type: 'fill', fill: { fillId: 'lf1', tag: '', brokerOrderId: 'L-mkt', accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 8, price: 30550, filledAt: 3 } });
  broker.setPosition(100, 'MNQU6', 8);
  broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 8 } });
  await controller.waitForIdle();
  return lim;
}
const stopOrder = () => lo({ brokerOrderId: 'L-stop', side: 'Sell', quantity: 8, orderType: 'Stop', limitPrice: undefined, stopPrice: 30516.25 });

describe('Z1 same-frame sibling of leader Stop', () => {
  for (const gap of ['none-control', 'sync', 'microtask', 'macrotask'] as const) {
    it(`Z1 ${gap}`, async () => {
      const { broker, controller } = await setup();
      await prefix(broker, controller);
      await tick(broker, controller, 40_000);
      const stop = stopOrder();
      broker.emitEvent({ type: 'order', order: stop });
      if (gap !== 'none-control') {
        if (gap === 'microtask') await Promise.resolve();
        if (gap === 'macrotask') await wait(0);
        broker.emitEvent({ type: 'order', order: { ...stop, sourceVersion: '1:Working#exec', updatedAt: 2 } });
      }
      await controller.waitForIdle();
      expect(controller.status().armed).toBe(true);
      expect(broker.placedRequests()).toContainEqual(expect.objectContaining({
        accountId: 200, orderType: 'Stop', quantity: 8,
      }));
      console.log('Z1', gap, summary(broker, controller));
      controller.stop();
    });
  }
});

describe('Z2 Market partial exit with its own fill burst in the same frame', () => {
  for (const burst of ['control-separate', 'sync-burst'] as const) {
    it(`Z2 ${burst}`, async () => {
      const { broker, controller } = await setup();
      await prefix(broker, controller);
      await tick(broker, controller, 40_000);
      broker.emitEvent({ type: 'order', order: stopOrder() });
      await controller.waitForIdle();
      await tick(broker, controller, 5_000);
      const px = lo({ brokerOrderId: 'L-px', side: 'Sell', quantity: 3, orderType: 'Market', limitPrice: undefined });
      broker.emitEvent({ type: 'order', order: px });
      if (burst === 'control-separate') await controller.waitForIdle();
      broker.emitEvent({ type: 'fill', fill: { fillId: 'lf2', tag: '', brokerOrderId: 'L-px', accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 3, price: 30560, filledAt: 9 } });
      broker.emitEvent({ type: 'order', order: { ...px, status: 'filled', filledQuantity: 3, sourceVersion: '2:Filled' } });
      broker.setPosition(100, 'MNQU6', 5);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 5 } });
      await controller.waitForIdle();
      expect(controller.status().armed).toBe(true);
      expect(broker.placedRequests()).toContainEqual(expect.objectContaining({
        accountId: 200, side: 'Sell', orderType: 'Market', quantity: 3,
      }));
      console.log('Z2', burst, summary(broker, controller));
      controller.stop();
    });
  }
});

describe('Z3/Z4 unrelated same-account event queued behind the Stop', () => {
  for (const who of ['leader-other-symbol', 'follower-other-symbol'] as const) {
    it(`Z3 ${who}`, async () => {
      const { broker, controller } = await setup();
      await prefix(broker, controller);
      await tick(broker, controller, 40_000);
      broker.emitEvent({ type: 'order', order: stopOrder() });
      broker.emitEvent({ type: 'position', position: { accountId: who.startsWith('leader') ? 100 : 200, symbol: 'MESU6', netQuantity: 0 } });
      await controller.waitForIdle();
      expect(controller.status().armed).toBe(true);
      expect(broker.placedRequests()).toContainEqual(expect.objectContaining({
        accountId: 200, orderType: 'Stop', quantity: 8,
      }));
      console.log('Z3', who, summary(broker, controller));
      controller.stop();
    });
  }
});

describe('Z5 follower copy filled at broker, follower stream lagging (M3 with Market exit)', () => {
  for (const exit of ['Market', 'Stop'] as const) {
    it(`Z5 ${exit}`, async () => {
      const { broker, controller, lag } = await setup({ lagWrap: true });
      await prefix(broker, controller);
      await tick(broker, controller, 40_000);
      // broker truth: follower TP copy fills 8/8, follower flat; follower WS lags (0.6-2.9 s measured)
      lag!.on();
      const tp = broker.orders().find((o: any) => o.accountId === 200 && o.orderType === 'Limit');
      // NOTE: no mutation of the shared mock object (the controller caches the same reference)
      broker.setPosition(200, 'MNQU6', 0);
      broker.emitEvent({ type: 'fill', fill: { fillId: 'ff-tp', tag: tp.tag, brokerOrderId: tp.brokerOrderId, accountId: 200, symbol: 'MNQU6', side: 'Sell', quantity: 8, price: 30618, filledAt: 300 } });
      broker.emitEvent({ type: 'order', order: { ...tp, status: 'filled', filledQuantity: 8, sourceVersion: '2:Filled' } });
      broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 0 } });
      // leader (TP not filled on leader) exits
      if (exit === 'Market') {
        const ex = lo({ brokerOrderId: 'L-exit', side: 'Sell', quantity: 8, orderType: 'Market', limitPrice: undefined });
        broker.emitEvent({ type: 'order', order: ex });
        await controller.waitForIdle();
        broker.emitEvent({ type: 'fill', fill: { fillId: 'lf-exit', tag: '', brokerOrderId: 'L-exit', accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 8, price: 30600, filledAt: 301 } });
        broker.emitEvent({ type: 'order', order: { ...ex, status: 'filled', filledQuantity: 8, sourceVersion: '2:Filled' } });
        broker.setPosition(100, 'MNQU6', 0);
        broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 } });
      } else {
        broker.emitEvent({ type: 'order', order: stopOrder() });
      }
      await controller.waitForIdle();
      const atDispatch = summary(broker, controller, { held: lag!.heldCount() });
      lag!.release();
      await controller.waitForIdle();
      await wait(2_600); await controller.waitForIdle();
      const followerOpen = broker.orders().filter((o: any) => o.accountId === 200 && o.brokerOrderId !== tp.brokerOrderId && (o.status === 'working' || o.status === 'pending')).map((o: any) => `${o.side}:${o.orderType}:${o.quantity}`);
      const followerNet = (await broker.listPositions(200)).filter((p: any) => p.symbol === 'MNQU6').reduce((s: number, p: any) => s + p.netQuantity, 0);
      expect(followerNet).toBe(0);
      expect(followerOpen).toHaveLength(0);
      if (exit === 'Market') {
        // Follower TP se vyplnil bez leader TP; skutečná divergence zůstává
        // fail-closed a nesmí vzniknout opačný Sell Market nad flat účtem.
        expect(controller.status().armed).toBe(false);
        expect(broker.placedRequests().filter((r: any) => (
          r.accountId === 200 && r.side === 'Buy' && r.orderType === 'Market'
        ))).toHaveLength(1);
      } else {
        expect(controller.status().armed).toBe(false);
      }
      console.log('Z5', exit, 'atDispatch', atDispatch);
      console.log('Z5', exit, 'after+2.6s', summary(broker, controller, { followerNet, followerOpen }));
      for (const extra of [3_000, 10_000]) {
        await wait(extra); base += extra; broker.emitEvent({ type: 'heartbeat', at: base }); await controller.waitForIdle();
        const net2 = (await broker.listPositions(200)).filter((p: any) => p.symbol === 'MNQU6').reduce((s: number, p: any) => s + p.netQuantity, 0);
        const liq = broker.liquidateRequests ? broker.liquidateRequests().length : 'n/a';
        const flat = broker.placedRequests().filter((r: any) => r.accountId === 200).slice(-2).map((r: any) => `${r.side}:${r.orderType}:${r.quantity}`);
        console.log('Z5', exit, `after+${extra}`, summary(broker, controller, { followerNet: net2, liq, lastFollowerWrites: flat }));
      }
      controller.stop();
    }, 40_000);
  }
});

describe('Z6 socket renewal / blip through router bumps routeEpoch permanently', () => {
  for (const variant of ['control', 'leader-renewal', 'follower-renewal', 'follower-renewal-then-reconcile'] as const) {
    it(`Z6 ${variant}`, async () => {
      base = 100;
      const L: any = createMockBroker({ behavior } as any);
      const F: any = createMockBroker({ behavior } as any);
      const router = createBrokerRouter([
        { broker: L, accountIds: [100], critical: true },
        { broker: F, accountIds: [200], critical: false },
      ], { reconnectGraceMs: 10_000 });
      const controller = await bootstrapCopierRuntime({ broker: router, store: createMemoryCopierStore(), group, clock });
      L.setConnected(true); F.setConnected(true);
      await controller.waitForIdle(); await controller.reconcile(); controller.arm();
      const pendingLeaderOrder = await prefix(L, controller);
      await tick(L, controller, 40_000);
      if (variant === 'leader-renewal') L.emitEvent({
        type: 'connection', connected: true, at: base, resynced: true,
        resync: { ...await resyncSnapshot(L, [100]), orders: [pendingLeaderOrder] },
      });
      if (variant.startsWith('follower-renewal')) F.emitEvent({
        type: 'connection', connected: true, at: base, resynced: true,
        resync: await resyncSnapshot(F, [200]),
      });
      await controller.waitForIdle();
      let reconcileErr: string | null = null;
      if (variant === 'follower-renewal-then-reconcile') {
        try { await controller.reconcile(); } catch (e) { reconcileErr = String(e).slice(0, 80); }
      }
      const mid = controller.status();
      L.emitEvent({ type: 'order', order: stopOrder() });
      await controller.waitForIdle();
      const placed = F.placedRequests().map((r: any) => `${r.accountId}:${r.side}:${r.orderType}:${r.quantity}`);
      if (variant === 'follower-renewal-then-reconcile') {
        expect(mid.armed).toBe(false);
        expect(placed).not.toContain('200:Sell:Stop:8');
      } else {
        expect(mid.armed).toBe(true);
        expect(controller.status().armed).toBe(true);
        expect(placed).toContain('200:Sell:Stop:8');
      }
      console.log('Z6', variant, JSON.stringify({ armedBeforeStop: mid.armed, reconcileErr, placed, armed: controller.status().armed, lastError: controller.status().lastError?.slice(0, 90) ?? null }));
      controller.stop();
    }, 20_000);
  }
});

describe('Z7 follower entry-copy events still in flight when leader places SL', () => {
  for (const when of ['released-before-SL', 'released-with-SL', 'released-after-SL'] as const) {
    it(`Z7 ${when}`, async () => {
      const { broker, controller, lag } = await setup({ lagWrap: true });
      await prefix(broker, controller, { holdFollowerEntry: lag! });
      const heldEntry = lag!.heldCount();
      if (when === 'released-before-SL') { lag!.release(); await controller.waitForIdle(); }
      await tick(broker, controller, 1_500);
      broker.emitEvent({ type: 'order', order: stopOrder() });
      if (when === 'released-with-SL') lag!.release();
      await controller.waitForIdle();
      if (when === 'released-after-SL') { lag!.release(); await controller.waitForIdle(); }
      expect(controller.status().armed).toBe(true);
      expect(broker.placedRequests()).toContainEqual(expect.objectContaining({
        accountId: 200, orderType: 'Stop', quantity: 8,
      }));
      console.log('Z7', when, summary(broker, controller, { heldEntry }));
      controller.stop();
    }, 20_000);
  }
});

describe('Z8 S1b variants: leader limit filled, follower copy working, non-Market exit', () => {
  for (const exitType of ['Market', 'Limit-TP'] as const) {
    it(`Z8 ${exitType}`, async () => {
      base = 100;
      const broker: any = createMockBroker({ behavior: () => ({ kind: 'working' }) } as any);
      const controller = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group, clock });
      broker.setConnected(true);
      await controller.waitForIdle(); await controller.reconcile(); controller.arm();
      const entry = lo({ brokerOrderId: 'e1', side: 'Buy', quantity: 8, orderType: 'Limit', limitPrice: 30_400 });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      broker.emitEvent({ type: 'fill', fill: { fillId: 'fe1', tag: '', brokerOrderId: 'e1', accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 8, price: 30400, filledAt: 5 } });
      broker.emitEvent({ type: 'order', order: { ...entry, status: 'filled', filledQuantity: 8, sourceVersion: '2:Filled' } });
      broker.setPosition(100, 'MNQU6', 8);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 8 } });
      await controller.waitForIdle();
      await tick(broker, controller, 5_000);
      const ex = exitType === 'Market'
        ? lo({ brokerOrderId: 'x1', side: 'Sell', quantity: 8, orderType: 'Market', limitPrice: undefined })
        : lo({ brokerOrderId: 'x1', side: 'Sell', quantity: 8, orderType: 'Limit', limitPrice: 30_700 });
      broker.emitEvent({ type: 'order', order: ex });
      await controller.waitForIdle();
      expect(controller.status().armed).toBe(true);
      if (exitType === 'Market') {
        expect(broker.placedRequests()).not.toContainEqual(expect.objectContaining({
          accountId: 200, side: 'Sell', orderType: 'Market', quantity: 8,
        }));
        expect(broker.orders().filter((order: any) => (
          order.accountId === 200 && order.status === 'working'
        ))).toHaveLength(0);
      } else {
        expect(broker.placedRequests()).toContainEqual(expect.objectContaining({
          accountId: 200, side: 'Sell', orderType: 'Limit', quantity: 8,
        }));
      }
      console.log('Z8', exitType, summary(broker, controller));
      controller.stop();
    }, 20_000);
  }
});

describe('Z9 resynced (planned renewal) reaches the controller only without router', () => {
  for (const via of ['direct-broker', 'router-critical-leader', 'router-noncritical-follower'] as const) {
    it(`Z9 ${via}`, async () => {
      base = 100;
      const L: any = createMockBroker({ behavior } as any);
      const F: any = via === 'direct-broker' ? L : createMockBroker({ behavior } as any);
      const broker = via === 'direct-broker' ? L : createBrokerRouter([
        { broker: L, accountIds: [100], critical: true },
        { broker: F, accountIds: [200], critical: false },
      ], { reconnectGraceMs: 10_000 });
      const controller = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group, clock });
      L.setConnected(true); if (F !== L) F.setConnected(true);
      await controller.waitForIdle(); await controller.reconcile(); controller.arm();
      const src = via === 'router-noncritical-follower' ? F : L;
      const accountIds = via === 'router-noncritical-follower' ? [200]
        : via === 'direct-broker' ? [100, 200] : [100];
      src.emitEvent({
        type: 'connection', connected: true, at: base, resynced: true,
        resync: await resyncSnapshot(src, accountIds),
      });
      await controller.waitForIdle();
      const s: any = controller.status();
      expect(s.armed).toBe(true);
      console.log('Z9', via, JSON.stringify({ armedAfterResync: s.armed, reconciliationRequired: s.reconciliationRequired, lastError: s.lastError ?? null }));
      controller.stop();
    });
  }
});

describe('Z10 S1b partial: follower copy partially filled, leader Limit fully filled, leader Market exit', () => {
  for (const followerFilled of [0, 3, 7] as const) {
    it(`Z10 followerFilled=${followerFilled}`, async () => {
      base = 100;
      const broker: any = createMockBroker({ behavior: (r: any) => r.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' } } as any);
      const controller = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group, clock });
      broker.setConnected(true);
      await controller.waitForIdle(); await controller.reconcile(); controller.arm();
      const entry = lo({ brokerOrderId: 'e1', side: 'Buy', quantity: 8, orderType: 'Limit', limitPrice: 30_400 });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      const copy = broker.orders().find((o: any) => o.accountId === 200);
      if (followerFilled > 0) {
        broker.setPosition(200, 'MNQU6', followerFilled);
        broker.emitEvent({ type: 'fill', fill: { fillId: 'ff1', tag: copy.tag, brokerOrderId: copy.brokerOrderId, accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: followerFilled, price: 30400, filledAt: 4 } });
        broker.emitEvent({ type: 'order', order: { ...copy, filledQuantity: followerFilled, sourceVersion: '2:Working' } });
        broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: followerFilled } });
        await controller.waitForIdle();
      }
      broker.emitEvent({ type: 'fill', fill: { fillId: 'fe1', tag: '', brokerOrderId: 'e1', accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 8, price: 30400, filledAt: 5 } });
      broker.emitEvent({ type: 'order', order: { ...entry, status: 'filled', filledQuantity: 8, sourceVersion: '2:Filled' } });
      broker.setPosition(100, 'MNQU6', 8);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 8 } });
      await controller.waitForIdle();
      await tick(broker, controller, 5_000);
      broker.emitEvent({ type: 'order', order: lo({ brokerOrderId: 'x1', side: 'Sell', quantity: 8, orderType: 'Market', limitPrice: undefined }) });
      await controller.waitForIdle();
      const followerNet = (await broker.listPositions(200)).filter((p: any) => p.symbol === 'MNQU6').reduce((s: number, p: any) => s + p.netQuantity, 0);
      const followerOpen = broker.orders().filter((o: any) => o.accountId === 200 && o.status === 'working').map((o: any) => `${o.side}:${o.orderType}:${o.quantity - o.filledQuantity}`);
      expect(broker.placedRequests()).not.toContainEqual(expect.objectContaining({
        accountId: 200, side: 'Sell', orderType: 'Market', quantity: 8,
      }));
      expect(controller.status().armed).toBe(followerFilled === 0);
      expect(followerOpen).toHaveLength(followerFilled === 0 ? 0 : 1);
      console.log('Z10', followerFilled, summary(broker, controller, { followerNet, followerOpen }));
      controller.stop();
    });
  }
});

describe('Z11 follower route removed by replaceRoutes while a pending copy exists', () => {
  it('Z11', async () => {
    base = 100;
    const L: any = createMockBroker({ behavior } as any);
    const F: any = createMockBroker({ behavior } as any);
    const F2: any = createMockBroker({ behavior } as any);
    const g2: CopyGroupConfig = { ...group, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }, { accountId: 201, mode: 'on-submit', multiplier: 1 }] };
    const router: any = createBrokerRouter([
      { broker: L, accountIds: [100], critical: true },
      { broker: F, accountIds: [200], critical: false },
      { broker: F2, accountIds: [201], critical: false },
    ], { reconnectGraceMs: 10_000 });
    const autoCloses: string[] = [];
    const epochCalls: string[] = [];
    const rawEpoch = router.routeEpoch.bind(router);
    router.routeEpoch = (id: number) => { try { const v = rawEpoch(id); epochCalls.push(`${id}=${v}`); return v; } catch (e) { epochCalls.push(`${id}=THROW`); throw e; } };
    const controller = await bootstrapCopierRuntime({ broker: router, store: createMemoryCopierStore(), group: g2, clock, onAudit: e => { for (const a of e) autoCloses.push(`${a.kind}:${(a.reason ?? '').slice(0, 50)}`); } });
    L.setConnected(true); F.setConnected(true); F2.setConnected(true);
    await controller.waitForIdle(); await controller.reconcile(); controller.arm();
    await prefix(L, controller);
    await tick(L, controller, 40_000);
    let replaceErr: string | null = null;
    epochCalls.push('|REPLACE|');
    try {
      router.replaceRoutes([
        { broker: L, accountIds: [100] },
        { broker: F, accountIds: [] },
        { broker: F2, accountIds: [201] },
      ]);
    } catch (e) { replaceErr = String(e).slice(0, 80); }
    await controller.waitForIdle();
    epochCalls.push('|STOP|');
    L.emitEvent({ type: 'order', order: stopOrder() });
    await controller.waitForIdle();
    await wait(200); await controller.waitForIdle();
    const f2 = F2.placedRequests().map((r: any) => `${r.accountId}:${r.side}:${r.orderType}:${r.quantity}`);
    const f2liq = F2.liquidateRequests ? F2.liquidateRequests().length : 'n/a';
    const s: any = controller.status();
    expect(replaceErr).toBeNull();
    expect(s.armed).toBe(false);
    expect(s.lastError).toContain('fail-closed');
    console.log('Z11', JSON.stringify({ replaceErr, armed: s.armed, lastError: s.lastError?.slice(0, 120) ?? null, follower201Writes: f2, f2liq, audit: autoCloses.slice(-5), epochCalls }));
    controller.stop();
  }, 20_000);

  it('Z11b routeEpoch výjimku normalizuje na řízený fail-closed bez zápisu', async () => {
    base = 100;
    const broker: any = createMockBroker({ behavior } as any);
    let followerRouteRemoved = false;
    broker.routeEpoch = (accountId: number) => {
      if (followerRouteRemoved && accountId === 200) {
        throw new Error('route 200 byla odebrána');
      }
      return accountId === 100 ? 11 : 12;
    };
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group,
      clock,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    await prefix(broker, controller);

    followerRouteRemoved = true;
    broker.emitEvent({ type: 'order', order: stopOrder() });
    await controller.waitForIdle();

    expect(controller.status().armed).toBe(false);
    expect(controller.status().lastError).toContain('routeEpoch účtu 200 nelze načíst');
    expect(broker.placedRequests().filter((request: any) => (
      request.accountId === 200 && request.orderType === 'Stop'
    ))).toHaveLength(0);
    controller.stop();
  });
});
