// Fáze 2b: správa obchodu leadera zadaného mimo appku (TradingView / Tradovate
// UI), který kopírka sama zkopírovala jako nativní OSO. Id leadera z durable outboxu.
import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerAccountRiskSnapshot, BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import { buildLeaderOrderManageCommand, validateLeaderOrderManage, type LeaderOrderManageAction } from '../lib/leaderOrderManage';

const LEADER = 100;
const FOLLOWER = 200;
const SYMBOL = 'MNQZ6';
const START = Date.UTC(2026, 9, 29, 15, 0, 0);
const group = (): CopyGroupConfig => ({
  id: 'tracked-group', name: 'Sledované', enabled: true, leaderAccountId: LEADER,
  followers: [{ accountId: FOLLOWER, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});
const risk = (accountId: number, at: number): BrokerAccountRiskSnapshot => ({
  accountId, at, realizedPnlUsd: 0, openPnlUsd: 0, netLiq: 50_000, minNetLiq: 48_000, dailyLossAutoLiq: 1_000, trailingMaxDrawdown: 2_000,
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let active: CopierRuntimeController | null = null;
afterEach(() => { active?.stop(); active = null; });

async function setup() {
  const clock = { now: START };
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [risk(LEADER, START + 500), risk(FOLLOWER, START + 500)] });
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(), group: group(), clock: () => clock.now, osoCorrelationWindowMs: 50,
    manualEntryTimingsMs: { post: 500, start: 500, legWait: 300 },
  });
  active = controller;
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  await controller.waitForIdle();
  clock.now = START + 1_000;
  // Leader zadá OSO v TradingView: vstup, SL s parentId, TP jen s ocoId.
  const base = { tag: '', accountId: LEADER, symbol: SYMBOL, quantity: 1, filledQuantity: 0, status: 'working' as const, sourceVersion: '1', updatedAt: clock.now };
  const leaderOrders: BrokerOrder[] = [
    { ...base, brokerOrderId: 'tv-e', side: 'Buy', orderType: 'Limit', limitPrice: 29_500 },
    { ...base, brokerOrderId: 'tv-s', side: 'Sell', orderType: 'Stop', stopPrice: 29_480, parentOrderId: 'tv-e', ocoId: 'tv-t', status: 'pending' },
    { ...base, brokerOrderId: 'tv-t', side: 'Sell', orderType: 'Limit', limitPrice: 29_560, ocoId: 'tv-s', status: 'pending' },
  ];
  for (const order of leaderOrders) { broker.seedOrder(order); broker.emitEvent({ type: 'order', order }); }
  await sleep(120);
  await controller.waitForIdle();
  return { broker, controller, clock, leaderOrders };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function fill(ctx: Ctx) {
  for (const order of ctx.broker.orders().filter(item => item.side === 'Buy' && item.orderType === 'Limit' && isOpen(item))) {
    order.status = 'filled';
    order.filledQuantity = 1;
    ctx.broker.setPosition(order.accountId, SYMBOL, 1);
    ctx.broker.emitEvent({ type: 'order', order: { ...order } });
    ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `f-${order.brokerOrderId}`, tag: '', brokerOrderId: order.brokerOrderId, accountId: order.accountId, symbol: SYMBOL, side: 'Buy', quantity: 1, price: 29_500, filledAt: 2 } });
    ctx.broker.emitEvent({ type: 'position', position: { accountId: order.accountId, symbol: SYMBOL, netQuantity: 1 } });
  }
  for (const order of ctx.broker.orders().filter(item => item.side === 'Sell' && item.status === 'pending')) {
    order.status = 'working';
    ctx.broker.emitEvent({ type: 'order', order: { ...order } });
  }
  await sleep(30);
  await ctx.controller.waitForIdle();
}
const isOpen = (order: BrokerOrder) => order.status === 'working' || order.status === 'pending';
const manage = (ctx: Ctx, action: LeaderOrderManageAction, expectPrice: number, newPrice: number | undefined, id: string, leaderEntryOrderId = 'tv-e') => (
  ctx.controller.manageLeaderOrder(validateLeaderOrderManage(buildLeaderOrderManageCommand({
    groupId: group().id, operationId: id, leaderAccountId: LEADER, leaderEntryOrderId, symbol: SYMBOL,
    action, expect: { price: expectPrice, quantity: 1 }, ...(newPrice != null ? { newPrice } : {}),
  })), { deadlineAt: ctx.clock.now + 15_000 })
);

describe('fáze 2b: správa obchodu, který kopírka sleduje', () => {
  it('OSO z TradingView zkopírované kopírkou → v statusu spravovatelné; posun SL dál se zrcadlí followerovi', async () => {
    const ctx = await setup();
    expect(ctx.broker.placedOsoRequests().filter(request => request.accountId === FOLLOWER)).toHaveLength(1);
    expect(ctx.controller.status().manageableLeaderTrades).toEqual([expect.objectContaining({ source: 'tracked', leaderEntryOrderId: 'tv-e', side: 'Buy' })]);
    await fill(ctx);
    const result = await manage(ctx, 'move-stop', 29_480, 29_470, 'manage:tracked001');
    expect(result).toMatchObject({ status: 'acknowledged', brokerOrderId: 'tv-s' });
    await sleep(30);
    await ctx.controller.waitForIdle();
    const followerStop = ctx.broker.orders().find(order => order.accountId === FOLLOWER && order.orderType === 'Stop');
    expect(followerStop?.stopPrice).toBe(29_470);
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
  });

  it('obchod, který kopírka nesleduje, nejde spravovat', async () => {
    const ctx = await setup();
    await fill(ctx);
    const result = await manage(ctx, 'move-stop', 29_480, 29_470, 'manage:tracked002', 'unknown-entry');
    expect(result.blockers.map(issue => issue.code)).toContain('not-tracked');
    expect(ctx.broker.modifyRequests().filter(request => request.accountId === LEADER)).toEqual([]);
  });

  it('zrušení čekajícího sledovaného vstupu zruší i kopii followera', async () => {
    const ctx = await setup();
    const result = await manage(ctx, 'cancel-entry', 29_500, undefined, 'manage:tracked003');
    expect(result.status).toBe('acknowledged');
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(ctx.broker.orders().find(order => order.accountId === FOLLOWER && order.side === 'Buy')?.status).toBe('canceled');
  });
});
