// Limit a Stop opravdu bez SL/TP u brokera (7. 11. 2026): sólo DEMO, i víc kontraktů, po fillu správa jako u holého Marketu.
import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerAccountRiskSnapshot } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { manualOnlyDemoSafety, type CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';
import { buildLeaderEntryPreviewCommand, validateLeaderEntryPreview } from '../lib/leaderEntryPreview';
import { buildLeaderEntryPlaceCommand } from '../lib/leaderEntryPlace';
import { buildLeaderOrderManageCommand } from '../lib/leaderOrderManage';
import { manualEntryBarePendingBlockers } from '../services/manualEntryPreview';
import { bareCloseRecordBlockers, selectBareLegTrade, type BareCloseEntryRecord } from '../lib/manualBareClose';
import { liveBarePendingBlockReason, liveTicketLegsProblem, type LiveBareMarketGate } from '../lib/liveBareEntry';

const LEADER = 61038658;
const SYM = 'MNQZ6';
const START = Date.UTC(2026, 10, 2, 2, 0, 0);
const group = (): CopyGroupConfig => ({
  id: `manual-demo-${LEADER}`, name: 'Ruční DEMO test', enabled: true, leaderAccountId: LEADER,
  followers: [], localOnly: true, manualOnly: true, manualEntryMaxContracts: 5, safety: manualOnlyDemoSafety(),
});
const risk = (at: number): BrokerAccountRiskSnapshot => ({
  accountId: LEADER, at, realizedPnlUsd: 0, openPnlUsd: 0, netLiq: 50_000, minNetLiq: null, dailyLossAutoLiq: null, trailingMaxDrawdown: null,
} as unknown as BrokerAccountRiskSnapshot);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let active: CopierRuntimeController | null = null;
afterEach(() => { active?.stop(); active = null; });

async function setup() {
  const clock = { now: START };
  const quote = { last: 25_000, bid: 24_999.75, ask: 25_000 };
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [risk(START + 500)] });
  const audits: string[] = [];
  const memory = createMemoryCopierStore();
  const controller = await bootstrapCopierRuntime({
    broker, store: memory, group: group(), clock: () => clock.now, osoCorrelationWindowMs: 50,
    manualEntryTimingsMs: { post: 300, start: 500, legWait: 120, manage: 500, settle: 50, verify: 100 },
    manualEntryQuote: () => ({ contract: SYM, last: quote.last, lastAt: clock.now - 100, bid: quote.bid, ask: quote.ask, quoteAt: clock.now - 50 }),
    onAudit: entries => { for (const entry of entries) audits.push(`${entry.kind}:${entry.reason ?? ''}`); },
  });
  active = controller;
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  await controller.waitForIdle();
  clock.now = START + 1_000;
  await sleep(20);
  await controller.waitForIdle();
  const place = (orderType: 'Limit' | 'Stop', price: number, side: 'Buy' | 'Sell' = 'Buy', quantity = 1) => {
    const status = controller.status();
    const preview = buildLeaderEntryPreviewCommand(
      { symbol: SYM, side, quantity, orderType, price },
      { group: { ...group(), leaderAccountId: LEADER }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: 'preview:barepend001' },
    );
    return controller.placeLeaderEntry(buildLeaderEntryPlaceCommand(preview, 'entry:barepend001'), { deadlineAt: clock.now + 15_000 });
  };
  return { broker, controller, audits, clock, quote, place };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const settle = async (ctx: Ctx, ms = 30) => { await sleep(ms); await ctx.controller.waitForIdle(); };
/** Počká na hlídací smyčku (běží po 1 s) a dožene zápisy. */
const review = async (ctx: Ctx) => { await sleep(1_100); await ctx.controller.waitForIdle(); await sleep(10); await ctx.controller.waitForIdle(); };
const fill = (ctx: Ctx, entryId: string) => {
  const entry = ctx.broker.orders().find(order => order.brokerOrderId === entryId)!;
  entry.status = 'filled';
  entry.filledQuantity = 1;
  ctx.broker.emitEvent({ type: 'order', order: { ...entry, sourceVersion: '2:Filled' } });
  ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `f-${entryId}`, tag: entry.tag, brokerOrderId: entryId, accountId: LEADER, symbol: SYM, side: entry.side, quantity: 1, price: entry.limitPrice ?? entry.stopPrice ?? 0, at: ctx.clock.now } as never });
  ctx.broker.setPosition(LEADER, SYM, 1);
  ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 1 } });
};
/** Dílčí fill: příkaz dál pracuje. */
const partial = (ctx: Ctx, entryId: string, filled: number) => {
  const entry = ctx.broker.orders().find(order => order.brokerOrderId === entryId)!;
  entry.filledQuantity = filled;
  ctx.broker.emitEvent({ type: 'order', order: { ...entry, sourceVersion: `3:Partial${filled}` } });
  ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `p-${entryId}-${filled}`, tag: entry.tag, brokerOrderId: entryId, accountId: LEADER, symbol: SYM, side: entry.side, quantity: filled, price: entry.limitPrice ?? 0, at: ctx.clock.now } as never });
  ctx.broker.setPosition(LEADER, SYM, filled);
  ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: filled } });
};
const open = (ctx: Ctx) => ctx.broker.orders().filter(order => order.status === 'pending' || order.status === 'working');
const recordOf = (ctx: Ctx) => ctx.controller.status().manualEntries?.find(item => item.operationId === 'entry:barepend001');

describe('validace', () => {
  const base = { type: 'preview-leader-entry', groupId: group().id, operationId: 'preview:barepend002', leaderAccountId: LEADER, symbol: SYM, side: 'Buy', orderType: 'Limit', price: 24_990,
    intent: { armedAt: 0, groupConfigHash: 'abcdefgh', followerQuantities: [] } };
  it('Limit bez nohou i víc kontraktů, nikdy jedna noha', () => {
    expect(() => validateLeaderEntryPreview({ ...base, quantity: 1 })).not.toThrow();
    expect(() => validateLeaderEntryPreview({ ...base, quantity: 3 })).not.toThrow();
    expect(() => validateLeaderEntryPreview({ ...base, quantity: 1, stopLoss: 24_980 })).toThrow();
  });
});

describe('brány ceny', () => {
  const quote = { contract: SYM, last: 25_000, lastAt: START - 100, bid: 24_999.75, ask: 25_000, quoteAt: START - 50 };
  const check = (orderType: 'Limit' | 'Stop', side: 'Buy' | 'Sell', price: number, q: typeof quote | null = quote) => (
    manualEntryBarePendingBlockers({ side, orderType, price, symbol: SYM }, q, START)[0]?.code ?? null
  );
  it('Limit přes trh ne, pod trhem ano', () => {
    expect(check('Limit', 'Buy', 24_999.75)).toBeNull();
    expect(check('Limit', 'Buy', 25_000)).toBe('bare-limit-marketable');
    expect(check('Limit', 'Sell', 25_000)).toBeNull();
    expect(check('Limit', 'Sell', 24_999.75)).toBe('bare-limit-marketable');
  });
  it('Stop jen na straně průrazu a aspoň 8 ticků od trhu', () => {
    expect(check('Stop', 'Buy', 25_002)).toBeNull();
    expect(check('Stop', 'Buy', 25_001.75)).toBe('bare-stop-too-close');
    expect(check('Stop', 'Buy', 24_990)).toBe('bare-stop-too-close');
    expect(check('Stop', 'Sell', 24_997.75)).toBeNull();
    expect(check('Stop', 'Sell', 24_998)).toBe('bare-stop-too-close');
  });
  it('bez čerstvé ceny stejného kontraktu nic', () => {
    expect(check('Limit', 'Buy', 24_990, null)).toBe('bare-pending-quote');
    expect(check('Limit', 'Buy', 24_990, { ...quote, contract: 'MNQH7' })).toBe('bare-pending-quote');
  });
});

describe('výběr pro UI', () => {
  const record = (extra: Partial<BareCloseEntryRecord> = {}): BareCloseEntryRecord => ({
    operationId: 'entry:a', status: 'acknowledged', createdAt: 1, bare: true, entryBrokerOrderId: '11',
    request: { accountId: LEADER, symbol: SYM, side: 'Buy', quantity: 1, orderType: 'Limit', price: 24_990 }, ...extra,
  });
  it('čekající vstup není pozice; po fillu se cena bere z Limitu', () => {
    const context = { solo: true, leaderAccountId: LEADER };
    expect(selectBareLegTrade([record()], context)).toBeNull();
    expect(selectBareLegTrade([record({ filledAt: 5 })], context)?.referencePrice).toBe(24_990);
    expect(selectBareLegTrade([record({ filledAt: 5, closedAt: 6 })], context)).toBeNull();
  });
  it('× zavřít před fillem neprojde', () => {
    const input = {
      newestOperationId: 'entry:a', solo: true, leaderAccountId: LEADER, groupId: 'g',
      runtime: { armed: true, shadowMode: false, killSwitch: false },
      command: { groupId: 'g', leaderAccountId: LEADER, symbol: SYM, expect: { price: 24_990, quantity: 1 } },
    };
    expect(bareCloseRecordBlockers({ ...input, record: record() })[0]?.code).toBe('entry-not-filled');
    expect(bareCloseRecordBlockers({ ...input, record: record({ filledAt: 5 }) })).toEqual([]);
  });
  it('panel: bez capability Limit nohy potřebuje, nad strop a v pozici neprojde', () => {
    const draft = { type: 'limit' as const, stopLoss: null, takeProfit: null };
    expect(liveTicketLegsProblem(draft, true)).toBe('Limit a Stop potřebují SL i TP.');
    expect(liveTicketLegsProblem(draft, true, true)).toBeNull();
    expect(liveTicketLegsProblem({ ...draft, stopLoss: 1 }, true, true)).not.toBeNull();
    const gate: LiveBareMarketGate = { blockedReason: null, marketSupported: true, bareSupported: true, maxContracts: 5, positionOpen: false, now: 100,
      quote: { symbol: SYM, bid: 1, ask: 2, at: 99 } };
    expect(liveBarePendingBlockReason(gate, 1)).toBeNull();
    expect(liveBarePendingBlockReason(gate, 5)).toBeNull();
    expect(liveBarePendingBlockReason(gate, 6)).toContain('Strop');
    expect(liveBarePendingBlockReason({ ...gate, positionOpen: true }, 1)).toContain('flat');
  });
});

describe('worker', () => {
  it('Limit bez nohou: u brokera jediný příkaz, po čekání na nohy žádný incident, nabídne se jen ×', async () => {
    const ctx = await setup();
    const placed = await ctx.place('Limit', 24_990);
    expect(placed.status).toBe('acknowledged');
    expect(open(ctx).map(order => [order.orderType, order.limitPrice])).toEqual([['Limit', 24_990]]);
    await settle(ctx, 250);
    expect(ctx.controller.status().armed).toBe(true);
    expect(ctx.controller.status().lastError ?? null).toBeNull();
    expect(open(ctx)).toHaveLength(1);
    const status = ctx.controller.status();
    expect(status.bareLegTrade ?? null).toBeNull();
    expect(status.bareLeaderTrade ?? null).toBeNull();
    expect(status.manageableLeaderTrades?.map(trade => trade.bare)).toEqual([true]);
    expect(status.pendingOwnEntries?.map(entry => entry.price)).toEqual([24_990]);
  });

  it('Stop bez nohou odejde s cenou Stopu', async () => {
    const ctx = await setup();
    const placed = await ctx.place('Stop', 25_002);
    expect(placed.status).toBe('acknowledged');
    expect(open(ctx).map(order => [order.orderType, order.stopPrice])).toEqual([['Stop', 25_002]]);
  });

  it('Limit přes trh nic neodešle', async () => {
    const ctx = await setup();
    const placed = await ctx.place('Limit', 25_000);
    expect(placed.status).toBe('blocked');
    expect(open(ctx)).toHaveLength(0);
  });

  it('× zruší vstup, záznam se uzavře a žádná pozice se nenabídne', async () => {
    const ctx = await setup();
    await ctx.place('Limit', 24_990);
    await settle(ctx, 120);
    const result = await ctx.controller.manageLeaderOrder(buildLeaderOrderManageCommand({
      groupId: group().id, operationId: 'manage:barepend0001', leaderAccountId: LEADER, entryOperationId: 'entry:barepend001', symbol: SYM,
      action: 'cancel-entry', expect: { price: 24_990, quantity: 1 },
    }), { deadlineAt: ctx.clock.now + 15_000 });
    expect(result.status).toBe('acknowledged');
    expect(open(ctx)).toHaveLength(0);
    await review(ctx);
    expect(ctx.controller.status().armed).toBe(true);
    expect(ctx.controller.status().bareLegTrade ?? null).toBeNull();
    expect(ctx.controller.status().manageableLeaderTrades).toEqual([]);
  });

  it('po fillu je pozice bez nohou, přijde zpráva a jde přidat SL', async () => {
    const ctx = await setup();
    const placed = await ctx.place('Limit', 24_990);
    await settle(ctx, 120);
    fill(ctx, placed.entryBrokerOrderId!);
    await settle(ctx);
    const trade = ctx.controller.status().bareLegTrade;
    expect(trade?.referencePrice).toBe(24_990);
    expect(ctx.controller.status().armed).toBe(true);
    expect(recordOf(ctx)?.pendingIncident?.text ?? '').toContain('BEZ SL/TP');
    expect(ctx.controller.status().manageableLeaderTrades).toEqual([]);
    ctx.clock.now += 5_000;
    ctx.broker.emitEvent({ type: 'heartbeat', at: ctx.clock.now });
    await settle(ctx);
    const added = await ctx.controller.manageLeaderOrder(buildLeaderOrderManageCommand({
      groupId: group().id, operationId: 'manage:barepend0002', leaderAccountId: LEADER, entryOperationId: 'entry:barepend001', symbol: SYM,
      action: 'add-leg', leg: 'stopLoss', newPrice: 24_980, expect: { price: 24_990, quantity: 1, stop: null, target: null },
    }), { deadlineAt: ctx.clock.now + 15_000 });
    expect(added.status).toBe('acknowledged');
  });

  it('před fillem SL přidat nejde', async () => {
    const ctx = await setup();
    await ctx.place('Limit', 24_990);
    await settle(ctx, 120);
    const added = await ctx.controller.manageLeaderOrder(buildLeaderOrderManageCommand({
      groupId: group().id, operationId: 'manage:barepend0003', leaderAccountId: LEADER, entryOperationId: 'entry:barepend001', symbol: SYM,
      action: 'add-leg', leg: 'stopLoss', newPrice: 24_980, expect: { price: 24_990, quantity: 1, stop: null, target: null },
    }), { deadlineAt: ctx.clock.now + 15_000 });
    expect(added.status).toBe('blocked');
    expect(open(ctx)).toHaveLength(1);
  });

  it('vypnutí kopírky čekající vstup zruší', async () => {
    const ctx = await setup();
    await ctx.place('Limit', 24_990);
    await settle(ctx, 120);
    ctx.controller.disarm();
    await review(ctx);
    expect(open(ctx)).toHaveLength(0);
  });

  it('fill za vypnuté kopírky je incident, který říká BEZ SL/TP', async () => {
    const ctx = await setup();
    const placed = await ctx.place('Limit', 24_990);
    await settle(ctx, 120);
    ctx.controller.disarm();
    fill(ctx, placed.entryBrokerOrderId!);
    await settle(ctx);
    await sleep(2_100);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().lastError ?? '').toContain('BEZ SL/TP');
    expect(ctx.controller.status().armed).toBe(false);
  }, 10_000);

  it('odpověď bez id a bez důvodu: incident, žádné opakování', async () => {
    const ctx = await setup();
    const place = ctx.broker.placeOrder.bind(ctx.broker);
    let calls = 0;
    ctx.broker.placeOrder = (async () => { calls += 1; return { brokerOrderId: '', accepted: false, definitive: false } as never; }) as typeof ctx.broker.placeOrder;
    const placed = await ctx.place('Limit', 24_990);
    ctx.broker.placeOrder = place;
    await settle(ctx);
    expect(placed.status).toBe('unknown');
    expect(calls).toBe(1);
    expect(ctx.controller.status().armed).toBe(false);
    expect(ctx.controller.status().lastError ?? '').toContain('BEZ SL/TP');
  });

  it('POST bez odpovědi: incident, pozdní ACK za vypnuté kopírky vstup zruší', async () => {
    const ctx = await setup();
    const place = ctx.broker.placeOrder.bind(ctx.broker);
    let release: (() => void) | null = null;
    ctx.broker.placeOrder = (async (request: Parameters<typeof place>[0]) => {
      await new Promise<void>(resolve => { release = resolve; });
      return place(request);
    }) as typeof ctx.broker.placeOrder;
    const placed = await ctx.place('Limit', 24_990);
    expect(placed.status).toBe('unknown');
    expect(ctx.controller.status().armed).toBe(false);
    release!();
    await settle(ctx, 100);
    await review(ctx);
    expect(open(ctx)).toHaveLength(0);
  });

  it('Order(Filled), Position(0), pozdní Fill: uzavřený záznam se nevrátí a nepřijde falešná zpráva', async () => {
    const ctx = await setup();
    const placed = await ctx.place('Limit', 24_990);
    await settle(ctx, 120);
    const entry = ctx.broker.orders().find(order => order.brokerOrderId === placed.entryBrokerOrderId)!;
    entry.status = 'filled';
    entry.filledQuantity = 1;
    ctx.broker.emitEvent({ type: 'order', order: { ...entry, sourceVersion: '2:Filled' } });
    await settle(ctx);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 0 } });
    await settle(ctx);
    expect(ctx.controller.status().bareLegTrade ?? null).toBeNull();
    ctx.broker.emitEvent({ type: 'fill', fill: { fillId: 'late', tag: entry.tag, brokerOrderId: entry.brokerOrderId, accountId: LEADER, symbol: SYM, side: 'Buy', quantity: 1, price: 24_990, at: ctx.clock.now } as never });
    await settle(ctx);
    expect(ctx.controller.status().bareLegTrade ?? null).toBeNull();
  });

  it('fill při rušení kill switchem: incident říká BEZ SL/TP a čipy jsou', async () => {
    const ctx = await setup();
    const placed = await ctx.place('Limit', 24_990);
    await settle(ctx, 120);
    const cancel = ctx.broker.cancelOrder.bind(ctx.broker);
    ctx.broker.cancelOrder = (async () => { fill(ctx, placed.entryBrokerOrderId!); throw new Error('Too late to cancel'); }) as typeof ctx.broker.cancelOrder;
    ctx.controller.engageKillSwitch();
    await review(ctx);
    ctx.broker.cancelOrder = cancel;
    const status = ctx.controller.status();
    expect(status.armed).toBe(false);
    expect(`${status.lastError ?? ''} ${recordOf(ctx)?.pendingIncident?.text ?? ''}`).toContain('BEZ SL/TP');
    expect(status.bareLegTrade?.referencePrice).toBe(24_990);
  });

  it('Flatten s čekajícím vstupem ho zruší bez incidentu', async () => {
    const ctx = await setup();
    await ctx.place('Limit', 24_990);
    await settle(ctx, 120);
    await ctx.controller.flattenGroup('flatten:barepend01').catch(() => undefined);
    await review(ctx);
    expect(open(ctx)).toHaveLength(0);
    expect(ctx.controller.status().bareLegTrade ?? null).toBeNull();
  });

  it('× když se vstup mezitím vyplnil: nic se neruší, text říká BEZ SL/TP a pozice se nabídne', async () => {
    const ctx = await setup();
    const placed = await ctx.place('Limit', 24_990);
    await settle(ctx, 120);
    const entry = ctx.broker.orders().find(order => order.brokerOrderId === placed.entryBrokerOrderId)!;
    entry.status = 'filled';
    entry.filledQuantity = 1;
    const result = await ctx.controller.manageLeaderOrder(buildLeaderOrderManageCommand({
      groupId: group().id, operationId: 'manage:barepend0004', leaderAccountId: LEADER, entryOperationId: 'entry:barepend001', symbol: SYM,
      action: 'cancel-entry', expect: { price: 24_990, quantity: 1 },
    }), { deadlineAt: ctx.clock.now + 15_000 });
    expect(result.status).not.toBe('acknowledged');
    await settle(ctx);
    expect(ctx.controller.status().bareLegTrade?.referencePrice).toBe(24_990);
  });
});

describe('víc kontraktů a dílčí fill', () => {
  const cancelRemainder = (ctx: Ctx, operationId: string, filledQuantity?: number) => ctx.controller.manageLeaderOrder(buildLeaderOrderManageCommand({
    groupId: group().id, operationId, leaderAccountId: LEADER, entryOperationId: 'entry:barepend001', symbol: SYM,
    action: 'cancel-entry', expect: { price: 24_990, quantity: 3, ...(filledQuantity != null ? { filledQuantity } : {}) },
  }), { deadlineAt: ctx.clock.now + 15_000 });
  const placed3 = async (ctx: Ctx) => {
    const placed = await ctx.place('Limit', 24_990, 'Buy', 3);
    expect(placed.status).toBe('acknowledged');
    expect(open(ctx).map(order => order.quantity)).toEqual([3]);
    await settle(ctx, 120);
    return placed.entryBrokerOrderId!;
  };

  it('dílčí fill: žádné čipy ani × pozice, zpráva a čára zbytku', async () => {
    const ctx = await setup();
    const entryId = await placed3(ctx);
    partial(ctx, entryId, 1);
    await settle(ctx);
    const status = ctx.controller.status();
    expect(status.armed).toBe(true);
    expect(status.bareLegTrade ?? null).toBeNull();
    expect(status.bareLeaderTrade ?? null).toBeNull();
    expect(status.barePartial).toMatchObject({ quantity: 3, filledQuantity: 1, price: 24_990 });
    expect(recordOf(ctx)?.pendingIncident?.text ?? '').toContain('z části');
  });

  it('× zbytku: kdo fill viděl, zruší ho bez incidentu a pozice má správný počet', async () => {
    const ctx = await setup();
    const entryId = await placed3(ctx);
    partial(ctx, entryId, 1);
    await settle(ctx);
    const result = await cancelRemainder(ctx, 'manage:barepart0001', 1);
    expect(result.status).toBe('acknowledged');
    expect(open(ctx)).toHaveLength(0);
    await review(ctx);
    const status = ctx.controller.status();
    expect(status.armed).toBe(true);
    expect(status.lastError ?? null).toBeNull();
    expect(status.barePartial ?? null).toBeNull();
    expect(status.bareLegTrade?.quantity).toBe(1);
    expect(status.bareLeaderTrade?.quantity).toBe(1);
  });

  it('× bez znalosti fillu: nic se neruší, text říká pravdu', async () => {
    const ctx = await setup();
    const entryId = await placed3(ctx);
    partial(ctx, entryId, 2);
    await settle(ctx);
    const blind = await cancelRemainder(ctx, 'manage:barepart0002');
    expect(blind.status).toBe('blocked');
    const stale = await cancelRemainder(ctx, 'manage:barepart0003', 1);
    expect(stale.status).toBe('blocked');
    expect(stale.blockers?.[0]?.text ?? '').toContain('BEZ SL/TP');
    expect(open(ctx)).toHaveLength(1);
  });

  it('raw Filled s menším fillem není plný fill', async () => {
    const ctx = await setup();
    const entryId = await placed3(ctx);
    const entry = ctx.broker.orders().find(order => order.brokerOrderId === entryId)!;
    entry.status = 'filled';
    entry.filledQuantity = 1;
    ctx.broker.setPosition(LEADER, SYM, 1);
    ctx.broker.emitEvent({ type: 'order', order: { ...entry, sourceVersion: '4:RawFilled' } });
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 1 } });
    await settle(ctx);
    // Nejednoznačné: zbylé filly ještě mohou dorazit, čipy zatím ne.
    expect(ctx.controller.status().bareLegTrade ?? null).toBeNull();
    ctx.clock.now += 6_000;
    await review(ctx);
    ctx.clock.now += 60_000;
    await review(ctx);
    expect(ctx.controller.status().bareLegTrade?.quantity).toBe(1);
  }, 10_000);

  it('postupné vyplnění do plna: čipy na celý počet', async () => {
    const ctx = await setup();
    const entryId = await placed3(ctx);
    partial(ctx, entryId, 1);
    await settle(ctx);
    expect(ctx.controller.status().bareLegTrade ?? null).toBeNull();
    const entry = ctx.broker.orders().find(order => order.brokerOrderId === entryId)!;
    entry.status = 'filled';
    entry.filledQuantity = 3;
    ctx.broker.setPosition(LEADER, SYM, 3);
    ctx.broker.emitEvent({ type: 'order', order: { ...entry, sourceVersion: '5:Filled' } });
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 3 } });
    await settle(ctx);
    expect(ctx.controller.status().bareLegTrade?.quantity).toBe(3);
    expect(recordOf(ctx)?.pendingIncident?.text ?? '').not.toContain('z části');
  });

  it('vypnutí kopírky zbytek zruší a ohlásí pozici BEZ SL/TP', async () => {
    const ctx = await setup();
    const entryId = await placed3(ctx);
    partial(ctx, entryId, 1);
    await settle(ctx);
    ctx.controller.disarm();
    await review(ctx);
    await sleep(200);
    await ctx.controller.waitForIdle();
    expect(open(ctx)).toHaveLength(0);
    const status = ctx.controller.status();
    expect(`${status.lastError ?? ''} ${recordOf(ctx)?.pendingIncident?.text ?? ''}`).toContain('BEZ SL/TP');
    expect(status.bareLegTrade?.quantity).toBe(1);
  });

  it('× a raw Filled s menším fillem: „zrušený“ se netvrdí, výsledek zůstává neznámý', async () => {
    const ctx = await setup();
    const entryId = await placed3(ctx);
    partial(ctx, entryId, 1);
    await settle(ctx);
    const cancel = ctx.broker.cancelOrder.bind(ctx.broker);
    ctx.broker.cancelOrder = (async () => {
      const entry = ctx.broker.orders().find(order => order.brokerOrderId === entryId)!;
      entry.status = 'filled';
      ctx.broker.emitEvent({ type: 'order', order: { ...entry, sourceVersion: '6:RawFilled' } });
    }) as typeof ctx.broker.cancelOrder;
    const result = await cancelRemainder(ctx, 'manage:barepart0005', 1);
    ctx.broker.cancelOrder = cancel;
    expect(result.status).toBe('unknown');
    expect(result.reason ?? '').not.toContain('zrušený');
  });

  it('dílčí pozice se SL a TP: posun SL jde na skutečný počet', async () => {
    const ctx = await setup();
    const entryId = await placed3(ctx);
    partial(ctx, entryId, 1);
    await settle(ctx);
    await cancelRemainder(ctx, 'manage:barepart0006', 1);
    await review(ctx);
    ctx.clock.now += 5_000;
    const leg = (operationId: string, action: 'add-leg' | 'move-stop', extra: Record<string, unknown>) => ctx.controller.manageLeaderOrder(buildLeaderOrderManageCommand({
      groupId: group().id, operationId, leaderAccountId: LEADER, entryOperationId: 'entry:barepend001', symbol: SYM, action, ...extra,
    } as never), { deadlineAt: ctx.clock.now + 15_000 });
    const stop = await leg('manage:barepart0007', 'add-leg', { leg: 'stopLoss', newPrice: 24_900, expect: { price: 24_990, quantity: 1, stop: null, target: null } });
    expect(stop.blockers ?? []).toEqual([]);
    expect(stop.status).toBe('acknowledged');
    await settle(ctx);
    ctx.clock.now += 3_000;
    const target = await leg('manage:barepart0008', 'add-leg', { leg: 'takeProfit', newPrice: 25_100, expect: { price: 24_990, quantity: 1, stop: 24_900, target: null } });
    expect(target.status).toBe('acknowledged');
    await settle(ctx);
    ctx.clock.now += 3_000;
    const moved = await leg('manage:barepart0009', 'move-stop', { newPrice: 24_950, expect: { price: 24_900, quantity: 1 } });
    expect(moved.blockers?.[0]?.code).not.toBe('shape');
  }, 15_000);

  it('Order(Filled) bez fillů: po ustálení nikdy ticho', async () => {
    const ctx = await setup();
    const entryId = await placed3(ctx);
    const entry = ctx.broker.orders().find(order => order.brokerOrderId === entryId)!;
    entry.status = 'filled';
    ctx.broker.setPosition(LEADER, SYM, 3);
    ctx.broker.emitEvent({ type: 'order', order: { ...entry, sourceVersion: '7:Filled0' } });
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 3 } });
    await settle(ctx);
    ctx.clock.now += 6_000;
    await review(ctx);
    ctx.clock.now += 60_000;
    await review(ctx);
    expect(ctx.controller.status().bareLegTrade?.quantity).toBe(3);
    expect(recordOf(ctx)?.pendingIncident?.text ?? '').toContain('BEZ SL/TP');
  }, 10_000);

  it('po zavření dílčí pozice se starý vstup neujme cizí pozice', async () => {
    const ctx = await setup();
    const entryId = await placed3(ctx);
    partial(ctx, entryId, 1);
    await settle(ctx);
    await cancelRemainder(ctx, 'manage:barepart0004', 1);
    await review(ctx);
    ctx.broker.setPosition(LEADER, SYM, 0);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 0 } });
    await settle(ctx);
    expect(ctx.controller.status().bareLegTrade ?? null).toBeNull();
    ctx.broker.setPosition(LEADER, SYM, 1);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 1 } });
    await settle(ctx);
    expect(ctx.controller.status().bareLegTrade ?? null).toBeNull();
  });
});

describe('restart', () => {
  async function restarted(failReads: number) {
    const store = createMemoryCopierStore();
    const clock = { now: START };
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [risk(START + 500)] });
    const boot = () => bootstrapCopierRuntime({
      broker, store, group: group(), clock: () => clock.now, osoCorrelationWindowMs: 50,
      manualEntryTimingsMs: { post: 300, start: 500, legWait: 120, manage: 500, settle: 50, verify: 100 },
      manualEntryQuote: () => ({ contract: SYM, last: 25_000, lastAt: clock.now - 100, bid: 24_999.75, ask: 25_000, quoteAt: clock.now - 50 }),
    });
    const first = await boot();
    active = first;
    broker.setConnected(true);
    await first.waitForIdle();
    await first.reconcile();
    first.arm();
    await first.waitForIdle();
    clock.now = START + 1_000;
    await sleep(20);
    const preview = buildLeaderEntryPreviewCommand(
      { symbol: SYM, side: 'Buy', quantity: 1, orderType: 'Limit', price: 24_990 },
      { group: { ...group(), leaderAccountId: LEADER }, armedAt: first.status().armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: 'preview:barepend001' },
    );
    const placed = await first.placeLeaderEntry(buildLeaderEntryPlaceCommand(preview, 'entry:barepend001'), { deadlineAt: clock.now + 15_000 });
    await sleep(150);
    await first.waitForIdle();
    first.stop();
    // Vstup se vyplnil, zatímco worker neběžel.
    const entry = broker.orders().find(order => order.brokerOrderId === placed.entryBrokerOrderId)!;
    entry.status = 'filled';
    entry.filledQuantity = 1;
    broker.setPosition(LEADER, SYM, 1);
    const find = broker.findOrderById.bind(broker);
    let calls = 0;
    broker.findOrderById = (async (...args: Parameters<typeof find>) => {
      calls += 1;
      if (calls <= failReads) throw new Error('429');
      return find(...args);
    }) as typeof broker.findOrderById;
    const second = await boot();
    active = second;
    broker.setConnected(true);
    await second.waitForIdle();
    return { second, clock, calls: () => calls };
  }
  const turn = async (ctx: { second: CopierRuntimeController; clock: { now: number } }, ms: number) => {
    ctx.clock.now += ms;
    await sleep(1_100);
    await ctx.second.waitForIdle();
    await sleep(10);
    await ctx.second.waitForIdle();
  };

  it('fill za výpadku a čtení vyjde: incident BEZ SL/TP a čipy', async () => {
    const ctx = await restarted(0);
    await turn(ctx, 1_000);
    await sleep(2_100);
    await ctx.second.waitForIdle();
    expect(ctx.second.status().lastError ?? '').toContain('BEZ SL/TP');
    expect(ctx.second.status().bareLegTrade?.referencePrice).toBe(24_990);
  }, 10_000);

  it('čtení jednou selže: zkusí se znovu a výsledek se dozví', async () => {
    const ctx = await restarted(1);
    await turn(ctx, 1_000);
    await turn(ctx, 120_000);
    expect(ctx.calls()).toBeGreaterThanOrEqual(2);
    expect(ctx.second.status().bareLegTrade?.referencePrice).toBe(24_990);
  }, 10_000);

  it('čtení selhává dál: incident, nikdy ticho', async () => {
    const ctx = await restarted(100);
    for (let index = 0; index < 4; index += 1) await turn(ctx, 300_000);
    expect(ctx.second.status().lastError ?? '').toContain('nejde přečíst');
    expect(ctx.second.status().bareLegTrade ?? null).toBeNull();
  }, 15_000);
});
