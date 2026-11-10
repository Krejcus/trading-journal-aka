import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';
import { buildLeaderEntryPlaceCommand } from '../lib/leaderEntryPlace';
import { buildLeaderOrderManageCommand, validateLeaderOrderManage } from '../lib/leaderOrderManage';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { runtimeFromSnapshot } from '../services/copierRunner';
import { processManualFlatten } from '../services/copierManualActions';
import { createExposureCappedBroker } from '../services/exposureCappedBroker';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';

const START = Date.UTC(2026, 9, 29, 15);
const group: CopyGroupConfig = {
  id: 'request-control', name: 'Request control', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }], localOnly: true,
};
let active: CopierRuntimeController | null = null;
afterEach(() => { active?.stop(); active = null; });
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
async function setup() {
  let now = START, limited = false;
  const scope = new AsyncLocalStorage<boolean>();
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [100, 200].map(accountId => ({
    accountId, at: START + 500, realizedPnlUsd: 0, openPnlUsd: 0,
    netLiq: 50_000, minNetLiq: 48_000, dailyLossAutoLiq: 1000, trailingMaxDrawdown: 2000,
  })) });
  broker.newRiskRequestBlocker = () => limited ? 'Application read budget exhausted' : null;
  broker.runWithAcceptedRequests = action => scope.run(true, action);
  broker.streamOrderSnapshot = () => ({ orders: [], observedAt: now });
  broker.streamPositionSnapshot = () => ({ positions: [], observedAt: now });
  broker.streamCoverage = accountId => ({
    accountId, connectionId: 'test-connection', environment: 'demo', routeEpoch: 0, currentRouteEpoch: 0,
    sessionId: 'test-session', currentSessionId: 'test-session', baselineAt: START, lastDataAt: START,
    observedAt: now, socketLive: true, synchronized: true, gap: false, backlog: false, mergeInProgress: false,
  });
  // Kontinuita streamu (jen graf): stejný řádek, ale bez dokladu — obchodní událost ji nezruší.
  broker.streamContinuity = accountId => ({ ...broker.streamCoverage!(accountId)!, baselineAt: START - 1, lastDataAt: START });
  broker.streamContinuityPositionSnapshot = () => ({ positions: [], observedAt: now });
  const originalCancel = broker.cancelOrder;
  broker.cancelOrder = async (...args) => {
    if (limited) expect(scope.getStore(), 'accepted cancel dispatch scope').toBe(true);
    return originalCancel(...args);
  };
  const originalLookup = broker.findOrderById;
  broker.findOrderById = async (...args) => {
    if (limited) expect(scope.getStore(), 'accepted management lookup scope').toBe(true);
    return originalLookup(...args);
  };
  const controller = await bootstrapCopierRuntime({
    broker, group, store: createMemoryCopierStore(), clock: () => now, osoCorrelationWindowMs: 20,
    manualEntryQuote: () => ({ contract: 'MNQZ6', last: 29_500, lastAt: now, bid: 29_499.75, ask: 29_500, quoteAt: now }),
    manualEntryTimingsMs: { post: 500, start: 500, legWait: 300, manage: 500, settle: 50, verify: 100 },
  });
  active = controller;
  broker.setConnected(true); await controller.waitForIdle(); await controller.reconcile();
  controller.arm(); await controller.waitForIdle(); now += 1000;
  await settle(); await controller.waitForIdle();
  const preview = () => buildLeaderEntryPreviewCommand({
    symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 29_500, stopLoss: 29_480, takeProfit: 29_560,
  }, { group: { ...group, leaderAccountId: 100 }, armedAt: controller.status().armedAt ?? 0,
    excludedFollowers: new Set(), participation: [], operationId: 'preview:requestctrl01' });
  return { broker, controller, preview, now: () => now, limit() { limited = true; } };
}

describe('request capacity changes do not replace copier safety', () => {
  it('keeps emergency native Flatten reads and confirmation in the accepted scope through the cap wrapper', async () => {
    const scope = new AsyncLocalStorage<boolean>();
    const broker = createMockBroker({ nativeLiquidate: true });
    broker.setPosition(100, 'MNQZ6', 1);
    broker.runWithAcceptedRequests = action => scope.run(true, action);
    const positions = broker.listPositions, orders = broker.listOrders;
    broker.listPositions = async accountId => {
      expect(scope.getStore(), 'listPositions').toBe(true);
      return positions(accountId);
    };
    broker.listOrders = async accountId => {
      expect(scope.getStore(), 'listOrders').toBe(true);
      return orders(accountId);
    };
    const store = createMemoryCopierStore();
    const result = await processManualFlatten({
      runtime: runtimeFromSnapshot(await store.load()), broker: createExposureCappedBroker(broker, () => 5),
      store, groupId: group.id, accountIds: [100], operationId: 'flatten:capacity01', clock: () => START,
      confirmationAttempts: 2, confirmationPollMs: 0, wait: async () => {},
    });
    expect(result.result).toMatchObject({ flat: true, failedAccounts: [] });
    expect(broker.liquidateRequests()).toHaveLength(1);
    expect(scope.getStore()).toBeUndefined();
  });

  it('a healthy armed controller refuses new risk before any leader/follower write when capacity is unavailable', async () => {
    const ctx = await setup(); expect(ctx.controller.status().armed).toBe(true);
    expect(ctx.controller.status().exposure?.streamCoverage).toHaveLength(2);
    // Kontinuita má tytéž kontroly (shoda snímku s cache) a nezávisí na dokladu.
    expect(ctx.controller.status().exposure?.streamContinuity).toHaveLength(2);
    expect(ctx.controller.status().exposure?.streamContinuity?.every(row => row.synchronized && !row.backlog && row.baselineAt === START - 1)).toBe(true);
    const coverage = ctx.broker.streamCoverage;
    ctx.broker.streamCoverage = () => null;
    expect(ctx.controller.status().exposure?.streamCoverage).toEqual([]);
    expect(ctx.controller.status().exposure?.streamContinuity).toHaveLength(2);
    ctx.broker.streamCoverage = coverage;
    ctx.limit();
    const preview = ctx.controller.previewLeaderEntry(ctx.preview());
    expect(preview.blockers.map(blocker => blocker.code)).toContain('tradovate-request-control');
    const result = await ctx.controller.placeLeaderEntry(buildLeaderEntryPlaceCommand(ctx.preview(), 'entry:requestctrl01'), { deadlineAt: ctx.now() + 15_000 });
    expect(result.status).toBe('blocked');
    expect(result.blockers.map(blocker => blocker.code)).toContain('tradovate-request-control');
    expect(ctx.broker.placedOsoRequests()).toHaveLength(0);
    expect(ctx.broker.placedRequests()).toHaveLength(0);
  });

  it('the same local read limit permits verified cancellation of an already accepted entry and its follower', async () => {
    const ctx = await setup();
    const placed = await ctx.controller.placeLeaderEntry(buildLeaderEntryPlaceCommand(ctx.preview(), 'entry:requestctrl02'), { deadlineAt: ctx.now() + 15_000 });
    expect(placed.status).toBe('acknowledged');
    await settle(); await ctx.controller.waitForIdle();
    ctx.limit();
    const command = buildLeaderOrderManageCommand({
      groupId: group.id, operationId: 'manage:requestctrl01', leaderAccountId: 100,
      entryOperationId: 'entry:requestctrl02', symbol: 'MNQZ6', action: 'cancel-entry',
      expect: { price: 29_500, quantity: 1 },
    });
    const result = await ctx.controller.manageLeaderOrder(validateLeaderOrderManage(command), { deadlineAt: ctx.now() + 15_000 });
    expect(result.status).toBe('acknowledged');
    await settle(); await ctx.controller.waitForIdle();
    const parents = ctx.broker.orders().filter(order => order.side === 'Buy');
    expect(parents.map(order => order.accountId).sort()).toEqual([100, 200]);
    expect(parents.every(order => order.status === 'canceled')).toBe(true);
    expect(ctx.controller.status().lastError).toBeNull();
  });
  it('final ARM admission also blocks a direct caller when shared read capacity is unavailable',async()=>{
    const ctx=await setup();ctx.controller.disarm();await ctx.controller.waitForIdle();ctx.limit();
    expect(()=>ctx.controller.arm()).toThrow('ARM blokován');expect(ctx.controller.status().armed).toBe(false);
    expect(ctx.broker.placedRequests()).toHaveLength(0);
  });

});
