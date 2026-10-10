// Výpadek spojení uprostřed obchodu s SL/TP (10. 10. 2026). Dřív: working
// ordery (ochranné nohy leadera i followerů) = incident k potvrzení. Nyní:
// synchronní kopie s ochrannými nohami kopírky se drží bez incidentu, po živě
// pozorovaném konci obchodu se obnova dokončí a kopírka smí pokračovat.
import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';

const symbol = 'MNQZ6';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function openBracketTrade() {
  let time = 100;
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(),
    group: { id: 'g', name: 'g', enabled: true, leaderAccountId: 100, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }] },
    clock: () => ++time, leaderFlatGraceMs: 0, leaderFlatExitSettlementGraceMs: 0,
    followerTransitionCorrelationWindowMs: 60_000, osoCorrelationWindowMs: 5,
  } as never);
  const order = (id: string, patch: Partial<BrokerOrder> = {}): BrokerOrder => ({
    tag: '', brokerOrderId: id, accountId: 100, symbol, side: 'Buy', orderType: 'Limit', quantity: 2,
    filledQuantity: 0, limitPrice: 30_000, status: 'working', sourceVersion: '1', updatedAt: 100, ...patch,
  });
  // Mock neuchovává leaderovy příkazy z eventů — REST čtení leadera je podstrčené.
  const leaderRest: BrokerOrder[] = [];
  const originalList = broker.listOrders.bind(broker);
  (broker as { listOrders: unknown }).listOrders = async (accountId: number, ...rest: unknown[]) => (
    accountId === 100 ? [...leaderRest] : (originalList as (...args: unknown[]) => Promise<BrokerOrder[]>)(accountId, ...rest)
  );
  const position = (accountId: number, net: number) => {
    broker.setPosition(accountId, symbol, net);
    broker.emitEvent({ type: 'position', position: { accountId, symbol, netQuantity: net } });
  };
  const settle = async (ms = 30) => { await controller.waitForIdle(); await sleep(ms); await controller.waitForIdle(); };
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm({ ttlMs: 3_600_000 });
  const stop = order('stop', { parentOrderId: 'entry', side: 'Sell', orderType: 'Stop', limitPrice: undefined, stopPrice: 29_950 });
  const target = order('target', { parentOrderId: 'entry', side: 'Sell', limitPrice: 30_100 });
  broker.emitEvent({ type: 'order', order: order('entry') });
  broker.emitEvent({ type: 'order', order: stop });
  broker.emitEvent({ type: 'order', order: target });
  await controller.waitForIdle();
  const followerEntry = broker.orders().find(item => item.accountId === 200 && item.side === 'Buy')!;
  followerEntry.filledQuantity = 2;
  followerEntry.status = 'filled';
  broker.emitEvent({ type: 'order', order: { ...followerEntry } });
  broker.emitEvent({ type: 'fill', fill: { fillId: 'f200', tag: '', brokerOrderId: followerEntry.brokerOrderId, accountId: 200, symbol, side: 'Buy', quantity: 2, price: 30_000, filledAt: 1_000 } });
  position(200, 2);
  broker.emitEvent({ type: 'order', order: order('entry', { status: 'filled', filledQuantity: 2, sourceVersion: '2' }) });
  broker.emitEvent({ type: 'fill', fill: { fillId: 'f100', tag: '', brokerOrderId: 'entry', accountId: 100, symbol, side: 'Buy', quantity: 2, price: 30_000, filledAt: 1_000 } });
  position(100, 2);
  leaderRest.push(order('entry', { status: 'filled', filledQuantity: 2 }), stop, target);
  await settle();
  expect(controller.status()).toMatchObject({ armed: true, lastError: null });
  const endTrade = async (extraLeaderOrders: BrokerOrder[] = []) => {
    const followerTarget = broker.orders().find(item => item.accountId === 200 && item.orderType === 'Limit' && item.side === 'Sell')!;
    const followerStop = broker.orders().find(item => item.accountId === 200 && item.orderType === 'Stop')!;
    followerTarget.status = 'filled'; followerTarget.filledQuantity = 2; followerStop.status = 'canceled';
    broker.emitEvent({ type: 'order', order: { ...followerTarget } });
    broker.emitEvent({ type: 'fill', fill: { fillId: 'f200x', tag: '', brokerOrderId: followerTarget.brokerOrderId, accountId: 200, symbol, side: 'Sell', quantity: 2, price: 30_100, filledAt: 2_000 } });
    broker.emitEvent({ type: 'order', order: { ...followerStop } });
    position(200, 0);
    leaderRest.splice(0, leaderRest.length, order('entry', { status: 'filled', filledQuantity: 2 }),
      { ...stop, status: 'canceled' }, { ...target, status: 'filled', filledQuantity: 2 }, ...extraLeaderOrders);
    broker.emitEvent({ type: 'order', order: { ...target, status: 'filled', filledQuantity: 2, sourceVersion: '3' } });
    broker.emitEvent({ type: 'fill', fill: { fillId: 'f100x', tag: '', brokerOrderId: 'target', accountId: 100, symbol, side: 'Sell', quantity: 2, price: 30_100, filledAt: 2_000 } });
    broker.emitEvent({ type: 'order', order: { ...stop, status: 'canceled', sourceVersion: '3' } });
    position(100, 0);
    await settle(150);
  };
  return { broker, controller, order, leaderRest, position, settle, endTrade };
}

describe('výpadek uprostřed obchodu s SL/TP', () => {
  it('drží kopie bez incidentu; po živém konci obchodu se obnova dokončí a kopírka sama pokračuje', async () => {
    const h = await openBracketTrade();
    h.broker.setConnected(false);
    await h.settle();
    h.broker.setConnected(true);
    await h.settle(100);
    const held = h.controller.status();
    expect(held).toMatchObject({ armed: false, lastError: null, manualRecovery: null });
    expect(held.lastDisarm?.copiesOutcome).toBe('left-open-protected');
    expect(held.transportResume).toMatchObject({ phase: 'waiting', reason: expect.stringContaining('uprostřed obchodu') });
    expect(() => h.controller.arm()).toThrow();
    await h.endTrade();
    expect(h.controller.status()).toMatchObject({ reconciliationRequired: false, workingOrderAccounts: [] });
    await h.controller.prepareArm?.();
    const resume = h.controller.status().transportResume;
    expect(resume?.phase).toBe('ready');
    h.controller.arm({ requirePreparation: true, autoResume: { disarmAt: resume!.disarmAt } });
    expect(h.controller.status()).toMatchObject({ armed: true, transportResume: { phase: 'resumed' } });
    h.controller.stop();
  });

  it('obchod skončil už během výpadku = bez incidentu, ale sama nepokračuje', async () => {
    const h = await openBracketTrade();
    h.broker.setConnected(false);
    await h.settle();
    // V mezeře se vyplnil TP leadera i followera (žádné eventy, jen REST stav).
    const followerTarget = h.broker.orders().find(item => item.accountId === 200 && item.orderType === 'Limit' && item.side === 'Sell')!;
    const followerStop = h.broker.orders().find(item => item.accountId === 200 && item.orderType === 'Stop')!;
    followerTarget.status = 'filled'; followerTarget.filledQuantity = 2; followerStop.status = 'canceled';
    h.broker.setPosition(200, symbol, 0);
    h.broker.setPosition(100, symbol, 0);
    h.leaderRest.splice(0, h.leaderRest.length, h.order('entry', { status: 'filled', filledQuantity: 2 }));
    h.broker.setConnected(true);
    await h.settle(150);
    const status = h.controller.status();
    expect(status.manualRecovery ?? null).toBeNull();
    expect(status.transportResume).toMatchObject({ phase: 'declined', reason: expect.stringContaining('skončil během výpadku') });
    h.controller.stop();
  });

  it('cizí pracovní příkaz na followerovi dál znamená incident', async () => {
    const h = await openBracketTrade();
    await h.broker.placeOrder({ tag: 'manual', accountId: 200, symbol, side: 'Sell', orderType: 'Limit', quantity: 1, limitPrice: 30_500 } as never);
    await h.settle();
    h.broker.setConnected(false);
    await h.settle();
    h.broker.setConnected(true);
    await h.settle(100);
    // Ruční příkaz za ARM už sám může vyvolat fail-closed; po reconnectu nesmí projít jako „držené kopie“.
    expect(h.controller.status().manualRecovery).not.toBeNull();
    expect(h.controller.status().lastDisarm?.copiesOutcome).not.toBe('left-open-protected');
    h.controller.stop();
  });

  it('leaderův nový vstupní příkaz (nesnižuje pozici) dál znamená incident', async () => {
    const h = await openBracketTrade();
    h.broker.setConnected(false);
    await h.settle();
    h.leaderRest.push(h.order('scale-in', { side: 'Buy', limitPrice: 29_900 }));
    h.broker.setConnected(true);
    await h.settle(100);
    expect(h.controller.status().manualRecovery).toMatchObject({ reason: expect.stringContaining('working=') });
    h.controller.stop();
  });

  it('druhý výpadek během drženého obchodu = nepokračuje (konec obchodu by nešel ověřit živě)', async () => {
    const h = await openBracketTrade();
    h.broker.setConnected(false); await h.settle();
    h.broker.setConnected(true); await h.settle(100);
    expect(h.controller.status().transportResume?.phase).toBe('waiting');
    h.broker.setConnected(false); await h.settle();
    expect(h.controller.status().transportResume).toMatchObject({ phase: 'declined', reason: expect.stringContaining('další výpadek') });
    h.controller.stop();
  });

  it('follower bez SL/TP (nohy zmizely v mezeře) = incident, ne „chráněné kopie“', async () => {
    const h = await openBracketTrade();
    h.broker.setConnected(false); await h.settle();
    for (const order of h.broker.orders().filter(item => item.accountId === 200 && item.status === 'working')) order.status = 'canceled';
    h.broker.setConnected(true); await h.settle(100);
    expect(h.controller.status().manualRecovery).not.toBeNull();
    expect(h.controller.status().lastDisarm?.copiesOutcome).not.toBe('left-open-protected');
    h.controller.stop();
  });

  it('dvě ochranné nohy stejné třídy nad pozici (follower by se otočil) = incident', async () => {
    const h = await openBracketTrade();
    h.broker.setConnected(false); await h.settle();
    // Leader v mezeře SL/TP zrušil; follower má obě copier nohy jako stopky (2 + 2 > pozice 2).
    for (const order of h.leaderRest) if (order.status === 'working') order.status = 'canceled';
    const target = h.broker.orders().find(item => item.accountId === 200 && item.orderType === 'Limit' && item.side === 'Sell')!;
    target.orderType = 'Stop';
    target.stopPrice = 29_900;
    h.broker.setConnected(true); await h.settle(100);
    expect(h.controller.status().manualRecovery).not.toBeNull();
    expect(h.controller.status().lastDisarm?.copiesOutcome).not.toBe('left-open-protected');
    h.controller.stop();
  });

  it('částečný výstup leadera i followera v mezeře = drží bez incidentu, ale sama nepokračuje', async () => {
    const h = await openBracketTrade();
    h.broker.setConnected(false); await h.settle();
    // Obě strany v mezeře zmenšily pozici na 1 a nohy na zbytek 1.
    for (const order of h.broker.orders().filter(item => item.accountId === 200 && item.status === 'working')) order.quantity = 1;
    h.broker.setPosition(200, symbol, 1);
    h.broker.setPosition(100, symbol, 1);
    for (const order of h.leaderRest) if (order.status === 'working') order.quantity = 1;
    h.broker.setConnected(true); await h.settle(100);
    const status = h.controller.status();
    expect(status.manualRecovery ?? null).toBeNull();
    expect(status.transportResume).toMatchObject({ phase: 'declined', reason: expect.stringContaining('nesedí s deníkem') });
    h.controller.stop();
  });

  it('jeden výpadek jako error + connection:false (Tradovate) nezruší pokračování; chyba transportu se po konci obchodu smaže', async () => {
    const h = await openBracketTrade();
    h.broker.emitEvent({ type: 'error', error: new Error('connection=leader phase=websocket Tradovate WebSocket heartbeat timeout') } as never);
    await h.settle();
    h.broker.setConnected(false);
    await h.settle();
    expect(h.controller.status().transportResume?.phase).toBe('waiting');
    h.broker.setConnected(true);
    await h.settle(100);
    expect(h.controller.status().manualRecovery ?? null).toBeNull();
    await h.endTrade();
    expect(h.controller.status().lastError).toBeNull();
    await h.controller.prepareArm?.();
    expect(h.controller.status().transportResume?.phase).toBe('ready');
    h.controller.stop();
  });

  it('runner (stop 2, TP jen na 1 kontrakt) se drží bez incidentu', async () => {
    const h = await openBracketTrade();
    for (const order of h.leaderRest) if (order.status === 'working' && order.orderType === 'Limit') order.quantity = 1;
    const followerTarget = h.broker.orders().find(item => item.accountId === 200 && item.orderType === 'Limit' && item.side === 'Sell')!;
    followerTarget.quantity = 1;
    h.broker.setConnected(false); await h.settle();
    h.broker.setConnected(true); await h.settle(100);
    expect(h.controller.status().manualRecovery ?? null).toBeNull();
    expect(h.controller.status().lastDisarm?.copiesOutcome).toBe('left-open-protected');
    h.controller.stop();
  });

  it('po živém konci drženého obchodu má leader nový čekající vstup = bez incidentu, jen nepokračuje', async () => {
    const h = await openBracketTrade();
    h.broker.setConnected(false); await h.settle();
    h.broker.setConnected(true); await h.settle(100);
    await h.endTrade([h.order('next-entry', { limitPrice: 29_800 })]);
    const status = h.controller.status();
    expect(status.manualRecovery ?? null).toBeNull();
    expect(status.transportResume).toMatchObject({ phase: 'declined', reason: expect.stringContaining('čekající příkaz') });
    h.controller.stop();
  });

  it('obchod bez SL/TP: po živém konci se obnova spustí i bez čekající obnovy a pokračování dojde do ready', async () => {
    const h = await openBracketTrade();
    // Leader SL/TP zruší; kopírka zruší i nohy followera.
    for (const order of h.leaderRest) {
      if (order.status !== 'working') continue;
      order.status = 'canceled';
      h.broker.emitEvent({ type: 'order', order: { ...order, sourceVersion: '9' } });
    }
    await h.settle(60);
    for (const order of h.broker.orders().filter(item => item.accountId === 200 && item.status === 'working')) {
      await h.broker.cancelOrder(200, order.brokerOrderId);
    }
    await h.settle();
    h.broker.setConnected(false); await h.settle();
    h.broker.setConnected(true); await h.settle(100);
    expect(h.controller.status()).toMatchObject({ manualRecovery: null, workingOrderAccounts: [] });
    expect(h.controller.status().transportResume?.phase).toBe('waiting');
    // Konec obchodu živě: leader exit fill, follower flat.
    h.broker.emitEvent({ type: 'fill', fill: { fillId: 'f100exit', tag: '', brokerOrderId: 'manual-exit', accountId: 100, symbol, side: 'Sell', quantity: 2, price: 30_050, filledAt: 3_000 } });
    h.position(200, 0);
    h.position(100, 0);
    await h.settle(150);
    await h.controller.prepareArm?.();
    expect(h.controller.status().transportResume?.phase).toBe('ready');
    h.controller.stop();
  });
});
