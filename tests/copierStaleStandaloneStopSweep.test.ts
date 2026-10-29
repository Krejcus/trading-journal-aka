import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore, type CopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBroker } from '../services/mockBroker';

// Incident 28.–29. 10. 2026: samostatné SL followerů vyplněné 26. 10. zůstaly
// v durable outboxu a links. Po restartu je in-memory sweep paměť prázdná a
// Tradovate /order/list vrací jen aktuální session, takže každý další flat
// sweep skončil „stav ochranné nohy … chybí v autoritativních zdrojích“ a
// kopírka se po každém exitu sama vypnula. Reconciliation uzavírala jen
// OSO/bracket nohy.

const symbol = 'MNQZ6';
const DAY = 86_400_000;
// 26. 10. 2026 15:00 UTC (10:00 CDT) — uprostřed session.
const START = Date.UTC(2026, 9, 26, 15, 0, 0);

const group: CopyGroupConfig = {
  id: 'stale-standalone', name: 'Origoš', enabled: true, leaderAccountId: 100,
  followers: [200, 201].map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
};

async function boot(store: CopierStore, startAt: number, orderIdPrefix: string) {
  let time = startAt;
  const audits: string[] = [];
  const broker: MockBroker = createMockBroker({ behavior: () => ({ kind: 'working' }), orderIdPrefix });
  const controller = await bootstrapCopierRuntime({
    broker, store, group, clock: () => ++time,
    leaderFlatGraceMs: 60000, followerTransitionCorrelationWindowMs: 60000, osoCorrelationWindowMs: 5,
    onAudit: entries => { for (const entry of entries) audits.push(entry.reason ?? entry.kind); },
  });
  const position = (accountId: number, netQuantity: number, sym = symbol) => {
    broker.setPosition(accountId, sym, netQuantity);
    broker.emitEvent({ type: 'position', position: { accountId, symbol: sym, netQuantity } });
  };
  const order = (id: string, patch: Partial<BrokerOrder> = {}): BrokerOrder => ({
    tag: '', brokerOrderId: id, accountId: 100, symbol, side: 'Sell', orderType: 'Limit', quantity: 10,
    filledQuantity: 0, limitPrice: 29_840, status: 'working', sourceVersion: '1', updatedAt: time, ...patch,
  });
  const advance = (ms: number) => { time += ms; broker.emitEvent({ type: 'heartbeat', at: time }); };
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    await controller.waitForIdle();
  };
  return { broker, controller, position, order, advance, settle, audits, now: () => time };
}

type Ctx = Awaited<ReturnType<typeof boot>>;

/** Short 10 přes Limit, ~40 s potom samostatný Buy Stop (zrcadlený followerům). */
async function openWithStandaloneStop(ctx: Ctx, tag: string, sym = symbol) {
  const { broker, controller, position, order, advance, settle } = ctx;
  broker.emitEvent({ type: 'order', order: order(`entry-${tag}`, { symbol: sym }) });
  await settle();
  broker.emitEvent({ type: 'order', order: { ...order(`entry-${tag}`, { symbol: sym }), status: 'filled', filledQuantity: 10 } });
  broker.emitEvent({ type: 'fill', fill: { fillId: `lead-entry-${tag}`, tag: '', brokerOrderId: `entry-${tag}`,
    accountId: 100, symbol: sym, side: 'Sell', quantity: 10, price: 29_840, filledAt: 1 } });
  position(100, -10, sym);
  for (const f of group.followers) {
    const entry = broker.orders().find(o => (
      o.accountId === f.accountId && o.symbol === sym && o.side === 'Sell' && o.status === 'working'
    ))!;
    entry.filledQuantity = 10; entry.status = 'filled';
    broker.emitEvent({ type: 'order', order: { ...entry } });
    broker.emitEvent({ type: 'fill', fill: { fillId: `entry-${tag}-${f.accountId}`, tag: '', brokerOrderId: entry.brokerOrderId,
      accountId: f.accountId, symbol: sym, side: 'Sell', quantity: 10, price: 29_840, filledAt: 2 } });
    position(f.accountId, -10, sym);
  }
  await controller.waitForIdle();
  advance(40_000);
  await controller.waitForIdle();
  const leaderStop = order(`stop-${tag}`, { symbol: sym, side: 'Buy', orderType: 'Stop', limitPrice: undefined, stopPrice: 29_851.5 });
  broker.emitEvent({ type: 'order', order: leaderStop });
  await settle();
  const stops = broker.orders().filter(o => (
    o.accountId !== 100 && o.symbol === sym && o.orderType === 'Stop' && o.status === 'working'
  ));
  expect(stops.map(o => o.accountId).sort()).toEqual([200, 201]);
  expect(controller.status()).toMatchObject({ armed: true, lastError: null });
  return { leaderStop, stops };
}

/** Stop se vyplní na leaderu i u followerů (skutečný stop-out) → všichni flat. */
async function stopOut(ctx: Ctx, tag: string, opened: Awaited<ReturnType<typeof openWithStandaloneStop>>, sym = symbol) {
  const { broker, position, settle } = ctx;
  const { leaderStop, stops } = opened;
  broker.emitEvent({ type: 'order', order: { ...leaderStop, status: 'filled', filledQuantity: 10 } });
  broker.emitEvent({ type: 'fill', fill: { fillId: `lead-stop-${tag}`, tag: '', brokerOrderId: `stop-${tag}`,
    accountId: 100, symbol: sym, side: 'Buy', quantity: 10, price: 29_852, filledAt: 3 } });
  position(100, 0, sym);
  for (const stop of stops) {
    stop.status = 'filled';
    stop.filledQuantity = stop.quantity;
    broker.setPosition(stop.accountId, sym, 0);
    broker.emitEvent({ type: 'fill', fill: { fillId: `stop-${tag}-${stop.accountId}`, tag: '', brokerOrderId: stop.brokerOrderId,
      accountId: stop.accountId, symbol: sym, side: 'Buy', quantity: stop.quantity, price: 29_852, filledAt: 3 } });
    broker.emitEvent({ type: 'order', order: { ...stop } });
    broker.emitEvent({ type: 'position', position: { accountId: stop.accountId, symbol: sym, netQuantity: 0 } });
  }
  await settle();
}

async function tradeStoppedOut(ctx: Ctx, tag: string) {
  const opened = await openWithStandaloneStop(ctx, tag);
  await stopOut(ctx, tag, opened);
  return opened.stops.map(stop => stop.brokerOrderId);
}

/** První den: obchod skončí na samostatném stopu, worker se pak zastaví. */
async function firstSession(store: CopierStore, startAt = START) {
  const ctx = await boot(store, startAt, 'd1');
  try {
    ctx.broker.setConnected(true);
    await ctx.controller.waitForIdle();
    await ctx.controller.reconcile();
    ctx.controller.arm();
    const oldStops = await tradeStoppedOut(ctx, 'd1');
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
    const stored = await store.load();
    const durable = stored.outbox.filter(entry => entry.protectiveRole === 'standalone-stop');
    expect(durable.map(entry => entry.brokerOrderId).sort()).toEqual([...oldStops].sort());
    expect(durable.every(entry => entry.status === 'acknowledged')).toBe(true);
    return oldStops;
  } finally {
    ctx.controller.stop();
  }
}

/**
 * Restart s novým brokerem: staré příkazy v /order/list ani ve streamu nejsou
 * (předchozí session). Kontrola u brokera, ON a další obchod do flat.
 */
async function restartAndTrade(store: CopierStore, startAt: number, publicReconcile = true) {
  const ctx = await boot(store, startAt, 'restart');
  ctx.broker.setConnected(true);
  await ctx.controller.waitForIdle();
  // Produkce po restartu: automatická read-only obnova po připojení, ON pak
  // často jen přes připravený ARM bez veřejné reconcile().
  if (publicReconcile) await ctx.controller.reconcile();
  ctx.controller.arm();
  await ctx.controller.waitForIdle();
  expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
  return ctx;
}

describe('incident 28.–29. 10. 2026 — staré samostatné SL po restartu', { timeout: 60_000 }, () => {
  it('noha vyplněná v předchozí session a chybějící v /order/list nezpůsobí fail-closed', async () => {
    const store = createMemoryCopierStore();
    const oldStops = await firstSession(store);
    // 28. 10. 13:30 UTC: o dvě session později.
    const ctx = await restartAndTrade(store, START + 2 * DAY - 90 * 60_000);
    try {
      await tradeStoppedOut(ctx, 'd3');
      expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null, manualRecovery: null });
      expect(ctx.audits.some(reason => reason.includes('chybí v autoritativních zdrojích'))).toBe(false);
      // Stará noha se nikdy neruší (broker ji nezná) a nic se neposílá navíc.
      for (const id of oldStops) expect(ctx.broker.cancelRequestCount(id), id).toBe(0);
    } finally {
      ctx.controller.stop();
    }
  });

  it('noha potvrzená v aktuální session, která v /order/list chybí, zůstane fail-closed', async () => {
    const store = createMemoryCopierStore();
    await firstSession(store);
    // Restart o 10 minut později — stále stejná session; chybějící noha je anomálie.
    const ctx = await restartAndTrade(store, START + 10 * 60_000);
    try {
      await tradeStoppedOut(ctx, 'd1b');
      expect(ctx.controller.status().armed).toBe(false);
      expect(ctx.controller.status().lastError ?? '').toContain('chybí v autoritativních zdrojích');
    } finally {
      ctx.controller.stop();
    }
  });

  it('pracující stará noha přítomná v /order/list se nad flat followerem dál zruší', async () => {
    const store = createMemoryCopierStore();
    const oldStops = await firstSession(store);
    const ctx = await boot(store, START + 2 * DAY - 90 * 60_000, 'restart');
    try {
      // Broker starou nohu followera 200 vrací jako pracující (GTC přes noc).
      const stale = oldStops[0];
      const loaded = await store.load();
      const durable = loaded.outbox.find(entry => entry.brokerOrderId === stale)!;
      ctx.broker.seedOrder({
        tag: durable.tag, brokerOrderId: stale, accountId: durable.request.accountId, symbol, side: 'Buy',
        orderType: 'Stop', quantity: 10, filledQuantity: 0, stopPrice: 29_851.5, status: 'working',
        sourceVersion: '1', updatedAt: ctx.now(),
      });
      ctx.broker.setConnected(true);
      await ctx.controller.waitForIdle();
      await ctx.controller.reconcile();
      await ctx.controller.waitForIdle();
      expect(ctx.broker.cancelRequestCount(stale)).toBe(1);
    } finally {
      ctx.controller.stop();
    }
  });

  it('flat na MNQ neruší pracující samostatný SL otevřené NQ pozice téhož followera', async () => {
    const store = createMemoryCopierStore();
    const ctx = await boot(store, START, 'sym');
    try {
      ctx.broker.setConnected(true);
      await ctx.controller.waitForIdle();
      await ctx.controller.reconcile();
      ctx.controller.arm();
      const nq = await openWithStandaloneStop(ctx, 'nq', 'NQZ6');
      const mnq = await openWithStandaloneStop(ctx, 'mnq');
      await stopOut(ctx, 'mnq', mnq);
      for (const stop of nq.stops) {
        expect(ctx.broker.cancelRequestCount(stop.brokerOrderId), stop.brokerOrderId).toBe(0);
        expect(stop.status).toBe('working');
      }
    } finally {
      ctx.controller.stop();
    }
  });

  it('automatická obnova po připojení bez veřejné reconcile() starou nohu taky uzavře', async () => {
    const store = createMemoryCopierStore();
    const oldStops = await firstSession(store);
    const ctx = await restartAndTrade(store, START + 2 * DAY - 90 * 60_000, false);
    try {
      await tradeStoppedOut(ctx, 'auto');
      expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null, manualRecovery: null });
      for (const id of oldStops) expect(ctx.broker.cancelRequestCount(id), id).toBe(0);
    } finally {
      ctx.controller.stop();
    }
  });

  it('noha potvrzená pár minut před 17:00 CT se po přechodu session nepřítomností neuzavře', async () => {
    const store = createMemoryCopierStore();
    // 26. 10. 21:57 UTC = 16:57 CDT; stop se potvrdí ~16:58, těsně před koncem session.
    await firstSession(store, Date.UTC(2026, 9, 26, 21, 57, 0));
    const ctx = await restartAndTrade(store, Date.UTC(2026, 9, 26, 22, 10, 0));
    try {
      await tradeStoppedOut(ctx, 'edge');
      expect(ctx.controller.status().armed).toBe(false);
      expect(ctx.controller.status().lastError ?? '').toContain('chybí v autoritativních zdrojích');
    } finally {
      ctx.controller.stop();
    }
  });
});
