// V12c regresní čočka — nové sondy (scratchpad, READ-ONLY vůči worktree).
import { describe, expect, it } from 'vitest';
import type { BrokerEvent, BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker, type MockBroker } from './_laMock';
import { createBrokerRouter } from '../services/brokerRouter';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const G1: CopyGroupConfig = { id: 'g1', name: 'G', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }] };
const G2: CopyGroupConfig = { id: 'g1', name: 'G', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }, { accountId: 300, mode: 'on-submit', multiplier: 1 }] };
const GX2: CopyGroupConfig = { ...G1,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 2 }] };

const lo = (p: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-1', accountId: 100, symbol: 'MNQU6', side: 'Buy',
  orderType: 'Limit', quantity: 2, filledQuantity: 0, limitPrice: 29_500,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...p,
});
let base = 100;
const clock = () => ++base;
const behaviorMktFill = (r: any) => r.orderType === 'Market' ? { kind: 'fill' as const, price: 30_550 } : { kind: 'working' as const };

const accOf = (e: BrokerEvent) => e.type === 'order' ? e.order.accountId : e.type === 'fill' ? e.fill.accountId
  : e.type === 'position' ? e.position.accountId : undefined;
const cloneEv = (e: BrokerEvent): BrokerEvent => e.type === 'order' ? { ...e, order: { ...e.order } }
  : e.type === 'fill' ? { ...e, fill: { ...e.fill } } : e.type === 'position' ? { ...e, position: { ...e.position } } : e;

function withHold(broker: MockBroker) {
  const holdAccounts = new Set<number>();
  const held: { listener: (e: BrokerEvent) => void; event: BrokerEvent }[] = [];
  const raw = broker.subscribe.bind(broker);
  (broker as any).subscribe = (listener: (e: BrokerEvent) => void) => raw((event: BrokerEvent) => {
    const e = cloneEv(event);
    const a = accOf(e);
    if (a != null && holdAccounts.has(a)) { held.push({ listener, event: e }); return; }
    listener(e);
  });
  return {
    hold: (a: number) => { holdAccounts.add(a); },
    release: (a: number) => {
      holdAccounts.delete(a);
      const out = held.filter(h => accOf(h.event) === a);
      for (const h of out) held.splice(held.indexOf(h), 1);
      for (const h of out) h.listener(h.event);
    },
  };
}

async function setup(behavior: any = behaviorMktFill, group: CopyGroupConfig = G1) {
  base = 100;
  const broker = createMockBroker({ behavior });
  const h = withHold(broker);
  const controller = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group, clock });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  return { broker, controller, h };
}
const tick = async (broker: any, controller: any, ms: number) => {
  base += ms; broker.emitEvent({ type: 'heartbeat', at: base }); await controller.waitForIdle();
};
const sum = (broker: any, controller: any, extra: Record<string, unknown> = {}) => JSON.stringify({
  armed: controller.status().armed,
  placed: broker.placedRequests().filter((r: any) => r.accountId !== 100).map((r: any) => `${r.accountId}:${r.side}:${r.orderType}:${r.quantity}`),
  modified: broker.modifyRequests().map((m: any) => `${m.accountId}:${m.changes.quantity}@${m.changes.limitPrice ?? m.changes.stopPrice}`),
  lastError: controller.status().lastError?.slice?.(0, 140) ?? controller.status().lastError,
  ...extra,
});
async function leaderFilled(broker: any, controller: any, order: BrokerOrder, qty: number, pos: number, fillId: string, price = 30_500) {
  broker.emitEvent({ type: 'order', order: { ...order, status: 'filled', filledQuantity: qty, sourceVersion: `9:${fillId}:Filled`, updatedAt: base } });
  broker.emitEvent({ type: 'fill', fill: { fillId, tag: '', brokerOrderId: order.brokerOrderId, accountId: 100, symbol: 'MNQU6', side: order.side, quantity: qty, price, filledAt: base } });
  broker.setPosition(100, 'MNQU6', pos);
  broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: pos } });
  await controller.waitForIdle();
}
async function incidentPrefix(broker: any, controller: any) {
  const lim = lo({ brokerOrderId: 'L-lim', side: 'Sell', quantity: 8, orderType: 'Limit', limitPrice: 30_618 });
  broker.emitEvent({ type: 'order', order: lim });
  await controller.waitForIdle();
  await tick(broker, controller, 60_000);
  const mkt = lo({ brokerOrderId: 'L-mkt', side: 'Buy', quantity: 8, orderType: 'Market', limitPrice: undefined });
  broker.emitEvent({ type: 'order', order: mkt });
  await controller.waitForIdle();
  await leaderFilled(broker, controller, mkt, 8, 8, 'lf-mkt', 30_550);
  await tick(broker, controller, 40_000);
  return lim;
}
const stop8 = () => lo({ brokerOrderId: 'L-stop', side: 'Sell', quantity: 8, orderType: 'Stop', limitPrice: undefined, stopPrice: 30_516.25 });
const brokerPos = async (broker: any, a: number) => (await broker.listPositions(a)).map((p: any) => `${p.symbol}:${p.netQuantity}`);
const followerOpen = (broker: any, a = 200) => broker.orders().filter((o: any) => o.accountId === a && ['working', 'pending', 'accepted'].includes(o.status))
  .map((o: any) => `${o.side}:${o.orderType}:${o.quantity}@${o.limitPrice ?? o.stopPrice ?? ''}`);
const resyncSnapshot = async (broker: any, accountIds: number[]) => ({
  accountIds,
  positions: (await Promise.all(accountIds.map(accountId => broker.listPositions(accountId)))).flat(),
  orders: (await Promise.all(accountIds.map(accountId => broker.listOrders(accountId)))).flat(),
  gapFills: [],
});

describe('V12c regrese — modify závody (R12 okno: leader limit vyplněn, kopie ještě pracuje)', () => {
  for (const variant of ['MOD0-single', 'MOD1-late-placement-event', 'MOD2-double-modify', 'MOD2h-double-modify-held'] as const) {
    it(variant, async () => {
      const { broker, controller, h } = await setup(behaviorMktFill);
      const entry = lo({ brokerOrderId: 'L-lim', side: 'Buy', quantity: 2, orderType: 'Limit', limitPrice: 30_500 });
      if (variant === 'MOD1-late-placement-event') h.hold(200);
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      let final = 30_490;
      if (variant === 'MOD2h-double-modify-held') h.hold(200);
      broker.emitEvent({ type: 'order', order: { ...entry, limitPrice: 30_490, sourceVersion: '2:Working', updatedAt: 5 } });
      if (variant.startsWith('MOD2')) {
        final = 30_480;
        broker.emitEvent({ type: 'order', order: { ...entry, limitPrice: 30_480, sourceVersion: '3:Working', updatedAt: 6 } });
      }
      await controller.waitForIdle();
      h.release(200);
      await controller.waitForIdle();
      const afterModify = sum(broker, controller);
      await tick(broker, controller, 1_000);
      await leaderFilled(broker, controller, { ...entry, limitPrice: final }, 2, 2, 'lf1', final);
      await tick(broker, controller, 3_000);
      broker.emitEvent({ type: 'order', order: lo({ brokerOrderId: 'L-stop', side: 'Sell', quantity: 2, orderType: 'Stop', limitPrice: undefined, stopPrice: 30_400 }) });
      await controller.waitForIdle();
      expect(controller.status().armed).toBe(true);
      expect(broker.placedRequests().filter(r => r.accountId === 200 && r.orderType === 'Stop')).toHaveLength(1);
      console.log(`Q:${variant}`, sum(broker, controller, { afterModifyArmed: JSON.parse(afterModify).armed, followerOpen: followerOpen(broker) }));
      controller.stop();
    });
  }
});

describe('V12c regrese — ingress backlog v okamžiku SL (C0 zero-fill a R12)', () => {
  const variants = ['ING0-none', 'ING1-dup-stop-order-event', 'ING2-follower-other-symbol-position', 'ING3-leader-position-resent', 'ING4-leader-other-symbol-position'] as const;
  for (const variant of variants) {
    it(`C0 ${variant}`, async () => {
      const { broker, controller } = await setup(behaviorMktFill);
      await incidentPrefix(broker, controller);
      const s = stop8();
      broker.emitEvent({ type: 'order', order: s });
      if (variant === 'ING1-dup-stop-order-event') broker.emitEvent({ type: 'order', order: { ...s, sourceVersion: '1:Working:execReport' } });
      if (variant === 'ING2-follower-other-symbol-position') broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MESU6', netQuantity: 0 } });
      if (variant === 'ING3-leader-position-resent') broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 8 } });
      if (variant === 'ING4-leader-other-symbol-position') broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MESU6', netQuantity: 0 } });
      await controller.waitForIdle();
      const stops = broker.placedRequests().filter(r => r.accountId === 200 && r.orderType === 'Stop');
      if (variant === 'ING3-leader-position-resent') {
        expect(controller.status().armed).toBe(false);
        expect(stops).toHaveLength(0);
      } else {
        expect(controller.status().armed).toBe(true);
        expect(stops).toHaveLength(1);
      }
      console.log(`Q:C0-${variant}`, sum(broker, controller, { followerPos: await brokerPos(broker, 200) }));
      controller.stop();
    });
    it(`R12 ${variant}`, async () => {
      const { broker, controller } = await setup(() => ({ kind: 'working' }));
      const entry = lo({ brokerOrderId: 'L-lim', side: 'Buy', quantity: 2, orderType: 'Limit', limitPrice: 30_500 });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      await leaderFilled(broker, controller, entry, 2, 2, 'lf1');
      await tick(broker, controller, 3_000);
      const s = lo({ brokerOrderId: 'L-stop', side: 'Sell', quantity: 2, orderType: 'Stop', limitPrice: undefined, stopPrice: 30_400 });
      broker.emitEvent({ type: 'order', order: s });
      if (variant === 'ING1-dup-stop-order-event') broker.emitEvent({ type: 'order', order: { ...s, sourceVersion: '1:Working:execReport' } });
      if (variant === 'ING2-follower-other-symbol-position') broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MESU6', netQuantity: 0 } });
      if (variant === 'ING3-leader-position-resent') broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 2 } });
      if (variant === 'ING4-leader-other-symbol-position') broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MESU6', netQuantity: 0 } });
      await controller.waitForIdle();
      expect(controller.status().armed).toBe(true);
      expect(broker.placedRequests().filter(r => r.accountId === 200 && r.orderType === 'Stop')).toHaveLength(1);
      console.log(`Q:R12-${variant}`, sum(broker, controller));
      controller.stop();
    });
  }
});

describe('V12c regrese — scale-in limit čeká, pak redukující příkaz', () => {
  for (const variant of ['SC1-new-SL', 'SC2-TP-limit', 'SC3-partial-market-exit', 'SC4-full-market-exit', 'SC1d-new-SL-dup-event'] as const) {
    it(variant, async () => {
      const { broker, controller } = await setup(behaviorMktFill);
      const mkt = lo({ brokerOrderId: 'L-mkt', side: 'Buy', quantity: 2, orderType: 'Market', limitPrice: undefined });
      broker.emitEvent({ type: 'order', order: mkt });
      await controller.waitForIdle();
      await leaderFilled(broker, controller, mkt, 2, 2, 'lf-mkt', 30_550);
      await tick(broker, controller, 5_000);
      broker.emitEvent({ type: 'order', order: lo({ brokerOrderId: 'L-add', side: 'Buy', quantity: 2, orderType: 'Limit', limitPrice: 30_500 }) });
      await controller.waitForIdle();
      await tick(broker, controller, 10_000);
      let red: BrokerOrder;
      if (variant.startsWith('SC1')) red = lo({ brokerOrderId: 'L-stop', side: 'Sell', quantity: 2, orderType: 'Stop', limitPrice: undefined, stopPrice: 30_450 });
      else if (variant === 'SC2-TP-limit') red = lo({ brokerOrderId: 'L-tp', side: 'Sell', quantity: 2, orderType: 'Limit', limitPrice: 30_650 });
      else if (variant === 'SC3-partial-market-exit') red = lo({ brokerOrderId: 'L-x', side: 'Sell', quantity: 1, orderType: 'Market', limitPrice: undefined });
      else red = lo({ brokerOrderId: 'L-x', side: 'Sell', quantity: 2, orderType: 'Market', limitPrice: undefined });
      broker.emitEvent({ type: 'order', order: red });
      if (variant === 'SC1d-new-SL-dup-event') broker.emitEvent({ type: 'order', order: { ...red, sourceVersion: '1:dup' } });
      await controller.waitForIdle();
      expect(controller.status().armed).toBe(true);
      expect(broker.placedRequests()).toContainEqual(expect.objectContaining({
        accountId: 200,
        side: 'Sell',
        orderType: red.orderType,
        quantity: red.quantity,
      }));
      console.log(`Q:${variant}`, sum(broker, controller, { followerPos: await brokerPos(broker, 200), followerOpen: followerOpen(broker) }));
      controller.stop();
    });
  }
});

describe('V12c regrese — S1b varianty (leader limit vyplněn, pak leader Market exit)', () => {
  it('S1b-delayed: kopie u brokera VYPLNĚNA, fill/pozice followera zpožděné (working event už zpracován)', async () => {
    const { broker, controller, h } = await setup(behaviorMktFill);
    const entry = lo({ brokerOrderId: 'L-lim', side: 'Buy', quantity: 2, orderType: 'Limit', limitPrice: 30_500 });
    broker.emitEvent({ type: 'order', order: entry });
    await controller.waitForIdle();
    await tick(broker, controller, 20_000);
    // broker-side fill of follower copy, events held (0.6–2.9 s lag)
    h.hold(200);
    const copy = broker.orders().find((o: any) => o.accountId === 200 && o.orderType === 'Limit')!;
    broker.setPosition(200, 'MNQU6', 2);
    broker.emitEvent({ type: 'order', order: { ...copy, status: 'filled', filledQuantity: 2, updatedAt: base } });
    broker.emitEvent({ type: 'fill', fill: { fillId: 'ff1', tag: copy.tag, brokerOrderId: copy.brokerOrderId, accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 2, price: 30_500, filledAt: base } });
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 2 } });
    (copy as any).status = 'filled'; (copy as any).filledQuantity = 2;
    await leaderFilled(broker, controller, entry, 2, 2, 'lf1');
    await tick(broker, controller, 1_200);
    const x = lo({ brokerOrderId: 'L-x', side: 'Sell', quantity: 2, orderType: 'Market', limitPrice: undefined });
    broker.emitEvent({ type: 'order', order: x });
    await controller.waitForIdle();
    await leaderFilled(broker, controller, x, 2, 0, 'lf2', 30_520);
    h.release(200);
    await controller.waitForIdle();
    expect(controller.status().armed).toBe(true);
    expect(broker.placedRequests()).toContainEqual(expect.objectContaining({
      accountId: 200, side: 'Sell', orderType: 'Market', quantity: 2,
    }));
    expect(await brokerPos(broker, 200)).toContain('MNQU6:0');
    console.log('Q:S1b-delayed', sum(broker, controller, { followerPos: await brokerPos(broker, 200), followerOpen: followerOpen(broker) }));
    controller.stop();
  });

  it('O6m1: multiplier 1 bez OSO, leader Buy Limit 2 vyplněn, kopie 1/2, leader Market Sell 2', async () => {
    const { broker, controller, h } = await setup(behaviorMktFill);
    const entry = lo({ brokerOrderId: 'L-lim', side: 'Buy', quantity: 2, orderType: 'Limit', limitPrice: 30_500 });
    broker.emitEvent({ type: 'order', order: entry });
    await controller.waitForIdle();
    await tick(broker, controller, 20_000);
    const copy = broker.orders().find((o: any) => o.accountId === 200 && o.orderType === 'Limit')!;
    (copy as any).filledQuantity = 1;
    broker.setPosition(200, 'MNQU6', 1);
    broker.emitEvent({ type: 'order', order: { ...copy, status: 'working', filledQuantity: 1, updatedAt: base } });
    broker.emitEvent({ type: 'fill', fill: { fillId: 'ff1', tag: copy.tag, brokerOrderId: copy.brokerOrderId, accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 30_500, filledAt: base } });
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 1 } });
    await controller.waitForIdle();
    await leaderFilled(broker, controller, entry, 2, 2, 'lf1');
    await tick(broker, controller, 2_000);
    const x = lo({ brokerOrderId: 'L-x', side: 'Sell', quantity: 2, orderType: 'Market', limitPrice: undefined });
    broker.emitEvent({ type: 'order', order: x });
    await controller.waitForIdle();
    await leaderFilled(broker, controller, x, 2, 0, 'lf2', 30_520);
    await tick(broker, controller, 3_000);
    void h;
    expect(controller.status().armed).toBe(false);
    expect(broker.placedRequests()).not.toContainEqual(expect.objectContaining({
      accountId: 200, side: 'Sell', orderType: 'Market', quantity: 2,
    }));
    expect(followerOpen(broker)).toHaveLength(0);
    console.log('Q:O6m1', sum(broker, controller, { followerPos: await brokerPos(broker, 200), followerOpen: followerOpen(broker) }));
    controller.stop();
  });

  for (const variant of ['O6', 'O6b'] as const) {
    it(`${variant}: multiplier 2, kopie 1/2 a leader Market exit nesmí poslat Sell 2`, async () => {
      const { broker, controller } = await setup(behaviorMktFill, GX2);
      const entry = lo({ brokerOrderId: `L-${variant}-lim`, side: 'Buy', quantity: 1, orderType: 'Limit', limitPrice: 30_500 });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      const copy = broker.orders().find((o: any) => o.accountId === 200 && o.orderType === 'Limit')!;
      (copy as any).filledQuantity = 1;
      broker.setPosition(200, 'MNQU6', 1);
      broker.emitEvent({ type: 'order', order: { ...copy, status: 'working', filledQuantity: 1, updatedAt: base } });
      broker.emitEvent({ type: 'fill', fill: {
        fillId: `ff-${variant}`, tag: copy.tag, brokerOrderId: copy.brokerOrderId,
        accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 30_500, filledAt: base,
      } });
      broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 1 } });
      await controller.waitForIdle();
      await leaderFilled(broker, controller, entry, 1, 1, `lf-${variant}`);
      await tick(broker, controller, 2_000);
      broker.emitEvent({ type: 'order', order: lo({
        brokerOrderId: `L-${variant}-exit`, side: 'Sell', quantity: 1,
        orderType: 'Market', limitPrice: undefined,
      }) });
      await controller.waitForIdle();

      expect(controller.status().armed).toBe(false);
      expect(broker.placedRequests()).not.toContainEqual(expect.objectContaining({
        accountId: 200, side: 'Sell', orderType: 'Market', quantity: 2,
      }));
      expect(followerOpen(broker)).toHaveLength(0);
      controller.stop();
    });
  }

  for (const exitType of ['Market', 'Stop'] as const) {
    it(`MULTI-${exitType}: 2 followeři, A kopie vyplněna, B kopie ještě pracuje; leader ${exitType} exit`, async () => {
      const { broker, controller } = await setup(behaviorMktFill, G2);
      const entry = lo({ brokerOrderId: 'L-lim', side: 'Buy', quantity: 2, orderType: 'Limit', limitPrice: 30_500 });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      await tick(broker, controller, 20_000);
      const copyA = broker.orders().find((o: any) => o.accountId === 200 && o.orderType === 'Limit')!;
      (copyA as any).status = 'filled'; (copyA as any).filledQuantity = 2;
      broker.setPosition(200, 'MNQU6', 2);
      broker.emitEvent({ type: 'order', order: { ...copyA } });
      broker.emitEvent({ type: 'fill', fill: { fillId: 'fa1', tag: copyA.tag, brokerOrderId: copyA.brokerOrderId, accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 2, price: 30_500, filledAt: base } });
      broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 2 } });
      await leaderFilled(broker, controller, entry, 2, 2, 'lf1');
      await tick(broker, controller, 1_500);
      const x = exitType === 'Market'
        ? lo({ brokerOrderId: 'L-x', side: 'Sell', quantity: 2, orderType: 'Market', limitPrice: undefined })
        : lo({ brokerOrderId: 'L-x', side: 'Sell', quantity: 2, orderType: 'Stop', limitPrice: undefined, stopPrice: 30_400 });
      broker.emitEvent({ type: 'order', order: x });
      await controller.waitForIdle();
      if (exitType === 'Market') await leaderFilled(broker, controller, x, 2, 0, 'lf2', 30_520);
      expect(controller.status().armed).toBe(true);
      if (exitType === 'Market') {
        expect(broker.placedRequests()).toContainEqual(expect.objectContaining({
          accountId: 200, side: 'Sell', orderType: 'Market', quantity: 2,
        }));
        expect(broker.placedRequests()).not.toContainEqual(expect.objectContaining({
          accountId: 300, side: 'Sell', orderType: 'Market', quantity: 2,
        }));
        expect(followerOpen(broker, 300)).toHaveLength(0);
      }
      console.log(`Q:MULTI-${exitType}`, sum(broker, controller, {
        posA: await brokerPos(broker, 200), posB: await brokerPos(broker, 300),
        openA: followerOpen(broker, 200), openB: followerOpen(broker, 300),
      }));
      controller.stop();
    });
  }
});

describe('V12c regrese — Kontrola pozic za ARM s eventem během čtení', () => {
  for (const variant of ['RC0-no-event', 'RC1-leader-position-resent', 'RC2-follower-order-event'] as const) {
    it(variant, async () => {
      const { broker, controller } = await setup(behaviorMktFill);
      const mkt = lo({ brokerOrderId: 'L-mkt', side: 'Buy', quantity: 2, orderType: 'Market', limitPrice: undefined });
      broker.emitEvent({ type: 'order', order: mkt });
      await controller.waitForIdle();
      await leaderFilled(broker, controller, mkt, 2, 2, 'lf-mkt', 30_550);
      await tick(broker, controller, 5_000);
      const rawList = broker.listPositions.bind(broker);
      let fired = false;
      (broker as any).listPositions = async (a: number) => {
        const out = await rawList(a);
        if (!fired && variant !== 'RC0-no-event') {
          fired = true;
          if (variant === 'RC1-leader-position-resent') broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 2 } });
          else {
            const f = broker.orders().find((o: any) => o.accountId === 200)!;
            broker.emitEvent({ type: 'order', order: { ...f } });
          }
        }
        return out;
      };
      let err: string | null = null;
      try { await controller.reconcile(); } catch (e) { err = String((e as Error).message).slice(0, 120); }
      (broker as any).listPositions = rawList;
      await controller.waitForIdle();
      const afterRecon = controller.status().armed;
      await tick(broker, controller, 3_000);
      const x = lo({ brokerOrderId: 'L-x', side: 'Sell', quantity: 2, orderType: 'Market', limitPrice: undefined });
      broker.emitEvent({ type: 'order', order: x });
      await controller.waitForIdle();
      await leaderFilled(broker, controller, x, 2, 0, 'lf2', 30_520);
      expect(err).toBeNull();
      expect(controller.status().lastError).toBeNull();
      console.log(`Q:${variant}`, sum(broker, controller, { reconcileErr: err, armedAfterRecon: afterRecon, followerPos: await brokerPos(broker, 200) }));
      controller.stop();
    });
  }
});

describe('V12c regrese — router planned renewal (connected:true resynced) mezi limitem a SL', () => {
  for (const variant of ['EP0-none', 'EP1-follower-renewal', 'EP2-leader-renewal'] as const) {
    it(variant, async () => {
      base = 100;
      const leaderBroker = createMockBroker({ behavior: behaviorMktFill });
      const followerBroker = createMockBroker({ behavior: behaviorMktFill });
      const router = createBrokerRouter([
        { broker: leaderBroker, accountIds: [100], critical: true },
        { broker: followerBroker, accountIds: [200], critical: false },
      ], { reconnectGraceMs: 10_000 });
      const controller = await bootstrapCopierRuntime({ broker: router, store: createMemoryCopierStore(), group: G1, clock });
      leaderBroker.setConnected(true); followerBroker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      const pendingLeaderOrder = await incidentPrefix(leaderBroker, controller);
      if (variant === 'EP1-follower-renewal') followerBroker.emitEvent({
        type: 'connection', connected: true, at: base, resynced: true,
        resync: await resyncSnapshot(followerBroker, [200]),
      } as any);
      if (variant === 'EP2-leader-renewal') leaderBroker.emitEvent({
        type: 'connection', connected: true, at: base, resynced: true,
        resync: { ...await resyncSnapshot(leaderBroker, [100]), orders: [pendingLeaderOrder] },
      } as any);
      await controller.waitForIdle();
      const armedAfterRenewal = controller.status().armed;
      await tick(leaderBroker, controller, 2_000);
      leaderBroker.emitEvent({ type: 'order', order: stop8() });
      await controller.waitForIdle();
      expect(armedAfterRenewal).toBe(true);
      expect(controller.status().armed).toBe(true);
      expect(followerBroker.placedRequests().filter(r => r.orderType === 'Stop')).toHaveLength(1);
      console.log(`Q:${variant}`, JSON.stringify({
        armedAfterRenewal, armed: controller.status().armed,
        stops: followerBroker.placedRequests().filter(r => r.orderType === 'Stop').length,
        lastError: controller.status().lastError?.slice(0, 120) ?? null,
      }));
      controller.stop();
    });
  }
});

describe('V12c regrese — převod limitu na trh / změna qty u čekající kopie, pak R12 okno', () => {
  for (const variant of ['MOD5-limit-to-market', 'MOD6-qty-up-then-fill', 'MOD7-qty-modify-late-placement-event'] as const) {
    it(variant, async () => {
      const { broker, controller, h } = await setup(() => ({ kind: 'working' }));
      const entry = lo({ brokerOrderId: 'L-lim', side: 'Buy', quantity: 2, orderType: 'Limit', limitPrice: 30_500 });
      if (variant === 'MOD7-qty-modify-late-placement-event') h.hold(200);
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      let filledOrder: BrokerOrder = entry; let qty = 2;
      if (variant === 'MOD5-limit-to-market') {
        filledOrder = { ...entry, orderType: 'Market', limitPrice: undefined, sourceVersion: '2:Working', updatedAt: 5 };
      } else {
        qty = 3;
        filledOrder = { ...entry, quantity: 3, sourceVersion: '2:Working', updatedAt: 5 };
      }
      broker.emitEvent({ type: 'order', order: filledOrder });
      await controller.waitForIdle();
      h.release(200);
      await controller.waitForIdle();
      const afterModify = sum(broker, controller);
      await leaderFilled(broker, controller, filledOrder, qty, qty, 'lf1');
      await tick(broker, controller, 3_000);
      broker.emitEvent({ type: 'order', order: lo({ brokerOrderId: 'L-stop', side: 'Sell', quantity: qty, orderType: 'Stop', limitPrice: undefined, stopPrice: 30_400 }) });
      await controller.waitForIdle();
      expect(controller.status().armed).toBe(true);
      expect(broker.placedRequests()).toContainEqual(expect.objectContaining({
        accountId: 200, side: 'Sell', orderType: 'Stop', quantity: qty,
      }));
      console.log(`Q:${variant}`, sum(broker, controller, { afterModify: JSON.parse(afterModify), followerOpen: followerOpen(broker) }));
      controller.stop();
    });
  }
});

describe('V12c regrese — C0 s realistickým burstem leader Market exitu (order+fill+position v jednom ticku)', () => {
  for (const withDupStop of [false, true]) {
    it(`C0-burst dupStop=${withDupStop}`, async () => {
      const { broker, controller } = await setup(behaviorMktFill);
      await incidentPrefix(broker, controller);
      const s = stop8();
      broker.emitEvent({ type: 'order', order: s });
      if (withDupStop) broker.emitEvent({ type: 'order', order: { ...s, sourceVersion: '1:Working:execReport' } });
      await controller.waitForIdle();
      const afterStop = sum(broker, controller);
      await tick(broker, controller, 5_000);
      const px = lo({ brokerOrderId: 'L-px', side: 'Sell', quantity: 3, orderType: 'Market', limitPrice: undefined });
      broker.emitEvent({ type: 'order', order: px });
      broker.emitEvent({ type: 'order', order: { ...px, status: 'filled', filledQuantity: 3, sourceVersion: '2:Filled' } });
      broker.emitEvent({ type: 'fill', fill: { fillId: 'lf2', tag: '', brokerOrderId: 'L-px', accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 3, price: 30560, filledAt: base } });
      broker.setPosition(100, 'MNQU6', 5);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 5 } });
      await controller.waitForIdle();
      const afterPartial = sum(broker, controller);
      await tick(broker, controller, 5_000);
      const ex = lo({ brokerOrderId: 'L-exit', side: 'Sell', quantity: 5, orderType: 'Market', limitPrice: undefined });
      broker.emitEvent({ type: 'order', order: ex });
      broker.emitEvent({ type: 'order', order: { ...ex, status: 'filled', filledQuantity: 5, sourceVersion: '2:Filled' } });
      broker.emitEvent({ type: 'fill', fill: { fillId: 'lf3', tag: '', brokerOrderId: 'L-exit', accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 5, price: 30570, filledAt: base } });
      broker.setPosition(100, 'MNQU6', 0);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 } });
      await controller.waitForIdle();
      const afterStopValue = JSON.parse(afterStop);
      const afterPartialValue = JSON.parse(afterPartial);
      const finalRequests = broker.placedRequests().filter(r => r.accountId === 200);
      expect(afterStopValue.armed).toBe(true);
      expect(afterPartialValue.armed).toBe(true);
      expect(controller.status().armed).toBe(true);
      expect(finalRequests).toContainEqual(expect.objectContaining({ orderType: 'Stop', quantity: 8 }));
      expect(finalRequests).toContainEqual(expect.objectContaining({ orderType: 'Market', side: 'Sell', quantity: 3 }));
      expect(finalRequests).toContainEqual(expect.objectContaining({ orderType: 'Market', side: 'Sell', quantity: 5 }));
      expect(await brokerPos(broker, 200)).toContain('MNQU6:0');
      console.log(`Q:C0-burst-dup${withDupStop}`, JSON.stringify({
        afterStop: JSON.parse(afterStop).placed.slice(2), armedAfterStop: JSON.parse(afterStop).armed,
        afterPartial: JSON.parse(afterPartial).placed.slice(2), armedAfterPartial: JSON.parse(afterPartial).armed,
        final: JSON.parse(sum(broker, controller)).placed.slice(2), armed: controller.status().armed,
        followerPos: await brokerPos(broker, 200), followerOpen: followerOpen(broker),
      }));
      controller.stop();
    });
  }
});
