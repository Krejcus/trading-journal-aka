// SL a TP po jedné u holé pozice (6. 11. 2026, docs/reviews/instant-legs-design-20261106.md).
import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerAccountRiskSnapshot, BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import { manualOnlyDemoSafety, type CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import { buildLeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';
import { buildLeaderEntryPlaceCommand } from '../lib/leaderEntryPlace';
import { buildLeaderOrderManageCommand, validateLeaderOrderManage, type LeaderOrderManageCommand } from '../lib/leaderOrderManage';
import { singleLegAllowedUnderBrake, singleLegFillSettled, singleLegPriceProblem } from '../lib/manualSingleLeg';

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

async function setup(initial?: Parameters<typeof createMemoryCopierStore>[0]) {
  const clock = { now: START };
  const quote = { last: 25_000, bid: 24_999.75, ask: 25_000 };
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [risk(START + 500)] });
  const audits: string[] = [];
  const memory = createMemoryCopierStore(initial);
  const failNext = { on: false };
  const onCommit: { fn: (() => void) | null } = { fn: null };
  const store = { load: () => memory.load(), commit: async (...args: Parameters<typeof memory.commit>) => {
    if (failNext.on) { failNext.on = false; throw new Error('test: disk'); }
    const saved = await memory.commit(...args);
    const hook = onCommit.fn;
    onCommit.fn = null;
    hook?.();
    return saved;
  } };
  const controller = await bootstrapCopierRuntime({
    broker, store, group: group(), clock: () => clock.now, osoCorrelationWindowMs: 50,
    manualEntryTimingsMs: { post: 300, start: 500, legWait: 300, manage: 500, settle: 50, verify: 100 },
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
  const bare = (quantity = 1) => {
    const status = controller.status();
    const preview = buildLeaderEntryPreviewCommand(
      { symbol: SYM, side: 'Buy', quantity, orderType: 'Market', referencePrice: 25_000, quoteReceivedAt: clock.now - 300 },
      { group: { ...group(), leaderAccountId: LEADER }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: 'preview:baretest001' },
    );
    return buildLeaderEntryPlaceCommand(preview, 'entry:baretest001');
  };
  return { onCommit, broker, controller, audits, clock, quote, bare, failNextCommit: () => { failNext.on = true; } };
}

const fillMarket = (broker: MockBroker, entryId: string, quantity: number) => {
  const entry = broker.orders().find(order => order.brokerOrderId === entryId)!;
  entry.status = 'filled';
  entry.filledQuantity = quantity;
  broker.emitEvent({ type: 'order', order: { ...entry, sourceVersion: '2:Filled' } });
  broker.emitEvent({ type: 'fill', fill: { fillId: `f-${entryId}`, tag: entry.tag, brokerOrderId: entryId, accountId: LEADER, symbol: SYM, side: 'Buy', quantity, price: 25_000.25, filledAt: START + 1_000 } });
  broker.setPosition(LEADER, SYM, quantity);
  broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: quantity } });
};


const ENTRY = 'entry:baretest001';
let counter = 0;
type Ctx = Awaited<ReturnType<typeof setup>>;
const manage = (ctx: Ctx, fields: Pick<LeaderOrderManageCommand, 'action'> & Partial<LeaderOrderManageCommand>, quantity = 1) => {
  counter += 1;
  return ctx.controller.manageLeaderOrder(buildLeaderOrderManageCommand({
    groupId: group().id, operationId: `manage:single${String(counter).padStart(4, '0')}`, leaderAccountId: LEADER, entryOperationId: ENTRY, symbol: SYM,
    expect: { price: 25_000, quantity, stop: null, target: null }, ...fields,
  }), { deadlineAt: ctx.clock.now + 15_000 });
};
const addStop = (ctx: Ctx, price: number, target: number | null = null) => manage(ctx, { action: 'add-leg', leg: 'stopLoss', newPrice: price, expect: { price: 25_000, quantity: 1, stop: null, target } });
const addTarget = (ctx: Ctx, price: number, stop: number | null = null) => manage(ctx, { action: 'add-leg', leg: 'takeProfit', newPrice: price, expect: { price: 25_000, quantity: 1, stop, target: null } });
const remove = (ctx: Ctx, leg: 'stopLoss' | 'takeProfit', stop: number | null, target: number | null) => manage(ctx, { action: 'remove-leg', leg, expect: { price: 25_000, quantity: 1, stop, target } });
const settled = async (ctx: Ctx) => {
  const placed = await ctx.controller.placeLeaderEntry(ctx.bare(1), { deadlineAt: ctx.clock.now + 15_000 });
  fillMarket(ctx.broker, placed.entryBrokerOrderId!, 1);
  await sleep(30);
  await ctx.controller.waitForIdle();
  ctx.clock.now += 5_000;
  return placed.entryBrokerOrderId!;
};
const open = (broker: MockBroker) => broker.orders().filter(order => order.status === 'pending' || order.status === 'working');
const openType = (broker: MockBroker, type: BrokerOrder['orderType']) => open(broker).filter(order => order.orderType === type);
const next = async (ctx: Ctx) => {
  await sleep(10);
  await ctx.controller.waitForIdle();
  ctx.clock.now += 3_000;
  ctx.broker.emitEvent({ type: 'heartbeat', at: ctx.clock.now });
  await sleep(10);
  await ctx.controller.waitForIdle();
};

describe('SL a TP po jedné', () => {
  it('bez nohou → SL: jeden Stop, bez incidentu; posun; × vrátí holou pozici', async () => {
    const ctx = await setup();
    await settled(ctx);
    const added = await addStop(ctx, 24_990);
    expect(added.blockers).toEqual([]);
    expect(added.status).toBe('acknowledged');
    expect(ctx.broker.placedOcoRequests()).toHaveLength(0);
    expect(ctx.broker.placedRequests().at(-1)).toMatchObject({ side: 'Sell', orderType: 'Stop', stopPrice: 24_990, quantity: 1 });
    await next(ctx);
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null, bareLeaderTrade: { hasStop: true } });
    const moved = await manage(ctx, { action: 'move-stop', expect: { price: 24_990, quantity: 1 }, newPrice: 24_985 });
    expect(moved.blockers).toEqual([]);
    expect(moved.status).toBe('acknowledged');
    expect(ctx.broker.modifyRequests().at(-1)).toMatchObject({ changes: { orderType: 'Stop', stopPrice: 24_985, quantity: 1 } });
    await next(ctx);
    const removed = await remove(ctx, 'stopLoss', 24_985, null);
    expect(removed.status).toBe('acknowledged');
    await next(ctx);
    expect(openType(ctx.broker, 'Stop')).toHaveLength(0);
    const status = ctx.controller.status();
    expect(status.lastError).toBeNull();
    expect(status.bareLeaderTrade).toBeTruthy();
    expect(status.bareLeaderTrade?.hasStop).toBeUndefined();
  });

  it('SL → přidat TP: nejdřív OCO se stejným SL, potom zrušit starý; pak běžný spravovaný obchod', async () => {
    const ctx = await setup();
    await settled(ctx);
    await addStop(ctx, 24_990);
    await next(ctx);
    const oldStop = openType(ctx.broker, 'Stop')[0].brokerOrderId;
    const originalCancel = ctx.broker.cancelOrder.bind(ctx.broker);
    let ocoBeforeCancel = false;
    ctx.broker.cancelOrder = async (accountId, id) => { ocoBeforeCancel = ctx.broker.placedOcoRequests().length === 1; return originalCancel(accountId, id); };
    const added = await addTarget(ctx, 25_020, 24_990);
    expect(added.blockers).toEqual([]);
    expect(added.status).toBe('acknowledged');
    expect(ocoBeforeCancel).toBe(true);
    expect(ctx.broker.placedOcoRequests()[0]).toMatchObject({ first: { orderType: 'Stop', stopPrice: 24_990 }, second: { orderType: 'Limit', limitPrice: 25_020 } });
    expect(ctx.broker.cancelRequestCount(oldStop)).toBe(1);
    await next(ctx);
    expect(ctx.controller.status()).toMatchObject({ lastError: null, bareLeaderTrade: null });
    const moved = await manage(ctx, { action: 'move-target', expect: { price: 25_020, quantity: 1 }, newPrice: 25_030 });
    expect(moved.blockers).toEqual([]);
    expect(moved.status).toBe('acknowledged');
  });

  it('TP → přidat SL: nejdřív zrušit TP, potom OCO', async () => {
    const ctx = await setup();
    await settled(ctx);
    await addTarget(ctx, 25_020);
    await next(ctx);
    const oldTarget = openType(ctx.broker, 'Limit')[0].brokerOrderId;
    const originalOco = ctx.broker.placeOco!.bind(ctx.broker);
    let canceledBeforeOco = false;
    ctx.broker.placeOco = async request => { canceledBeforeOco = ctx.broker.cancelRequestCount(oldTarget) === 1; return originalOco(request); };
    const added = await addStop(ctx, 24_990, 25_020);
    expect(added.blockers).toEqual([]);
    expect(added.status).toBe('acknowledged');
    expect(canceledBeforeOco).toBe(true);
  });

  it('dvě nohy → × TP: partner běží, zrušen jen TP; čip se vrátí', async () => {
    const ctx = await setup();
    await settled(ctx);
    await addStop(ctx, 24_990);
    await next(ctx);
    await addTarget(ctx, 25_020, 24_990);
    await next(ctx);
    const removed = await remove(ctx, 'takeProfit', 24_990, 25_020);
    expect(removed.blockers).toEqual([]);
    expect(removed.status).toBe('acknowledged');
    await next(ctx);
    expect(openType(ctx.broker, 'Stop')).toHaveLength(1);
    expect(openType(ctx.broker, 'Limit')).toHaveLength(0);
    expect(ctx.controller.status()).toMatchObject({ lastError: null, bareLeaderTrade: { hasStop: true } });
  });

  it('hned po fillu počká, starý obraz z druhého zařízení a blízký SL neprojdou', async () => {
    const ctx = await setup();
    const placed = await ctx.controller.placeLeaderEntry(ctx.bare(1), { deadlineAt: ctx.clock.now + 15_000 });
    fillMarket(ctx.broker, placed.entryBrokerOrderId!, 1);
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect((await addStop(ctx, 24_990)).blockers.map(issue => issue.code)).toEqual(['fill-settling']);
    ctx.clock.now += 5_000;
    expect((await addTarget(ctx, 25_020, 24_990)).blockers.map(issue => issue.code)).toEqual(['order-changed']);
    expect((await addStop(ctx, 25_001)).blockers.map(issue => issue.code)).toEqual(['bracket-side']);
    await addStop(ctx, 24_995);
    await next(ctx);
    ctx.quote.bid = 24_996; ctx.quote.last = 24_996; ctx.quote.ask = 24_996.25;
    const close = await addTarget(ctx, 25_020, 24_995);
    expect(close.blockers.map(issue => issue.code)).toEqual(['sl-too-close']);
    expect(ctx.broker.placedOcoRequests()).toHaveLength(0);
  });

  it('za vypnuté kopírky jen přidání SL k pozici bez nohou', async () => {
    const ctx = await setup();
    await settled(ctx);
    ctx.controller.disarm();
    await ctx.controller.waitForIdle();
    expect((await addTarget(ctx, 25_020)).blockers.map(issue => issue.code)).toEqual(['not-armed']);
    const added = await addStop(ctx, 24_990);
    expect(added.status).toBe('acknowledged');
    await next(ctx);
    expect((await remove(ctx, 'stopLoss', 24_990, null)).blockers.map(issue => issue.code)).toEqual(['not-armed']);
    expect((await addTarget(ctx, 25_020, 24_990)).blockers.map(issue => issue.code)).toEqual(['not-armed']);
    expect(openType(ctx.broker, 'Stop')).toHaveLength(1);
  });

  it('SL → TP: odmítnuté OCO nechá SL běžet, bez incidentu; nezrušený starý SL = incident DVA SL', async () => {
    const ctx = await setup();
    await settled(ctx);
    await addStop(ctx, 24_990);
    await next(ctx);
    const oldStop = openType(ctx.broker, 'Stop')[0].brokerOrderId;
    const original = ctx.broker.placeOco!.bind(ctx.broker);
    ctx.broker.placeOco = async () => ({ firstBrokerOrderId: '', secondBrokerOrderId: '', accepted: false, definitive: true, rejectReason: 'test' });
    expect((await addTarget(ctx, 25_020, 24_990)).status).toBe('rejected');
    expect(ctx.broker.cancelRequestCount(oldStop)).toBe(0);
    expect(ctx.controller.status().lastError).toBeNull();
    await next(ctx);
    ctx.broker.placeOco = original;
    ctx.broker.cancelOrder = async () => { throw new Error('test: nejde zrušit'); };
    expect((await addTarget(ctx, 25_020, 24_990)).status).toBe('unknown');
    expect(ctx.controller.status().lastError).toContain('DVA SL');
  });

  it('SL → TP: nové nohy odmítnuté ve streamu před ACK nechají starý SL běžet, incident', async () => {
    const ctx = await setup();
    await settled(ctx);
    await addStop(ctx, 24_990);
    await next(ctx);
    const oldStop = openType(ctx.broker, 'Stop')[0].brokerOrderId;
    const original = ctx.broker.placeOco!.bind(ctx.broker);
    ctx.broker.placeOco = async request => {
      const ack = await original(request);
      const leg = ctx.broker.orders().find(order => order.brokerOrderId === ack.firstBrokerOrderId)!;
      leg.status = 'rejected';
      ctx.broker.emitEvent({ type: 'order', order: { ...leg, sourceVersion: '9:Rejected' } });
      await sleep(10);
      return ack;
    };
    const result = await addTarget(ctx, 25_020, 24_990);
    expect(result.status).toBe('unknown');
    expect(ctx.broker.cancelRequestCount(oldStop)).toBe(0);
    expect(ctx.controller.status().lastError).toContain('starý SL');
  });

  it('SL → TP: starý SL se během výměny vyplnil: nové nohy se zruší, incident', async () => {
    const ctx = await setup();
    await settled(ctx);
    await addStop(ctx, 24_990);
    await next(ctx);
    const oldStop = openType(ctx.broker, 'Stop')[0];
    const originalCancel = ctx.broker.cancelOrder.bind(ctx.broker);
    ctx.broker.cancelOrder = async (accountId, id) => {
      if (id !== oldStop.brokerOrderId) return originalCancel(accountId, id);
      oldStop.status = 'filled';
      oldStop.filledQuantity = 1;
      ctx.broker.setPosition(LEADER, SYM, 0);
      throw new Error('TooLate');
    };
    expect((await addTarget(ctx, 25_020, 24_990)).status).toBe('unknown');
    const oco = ctx.broker.orders().filter(order => order.brokerOrderId !== oldStop.brokerOrderId && (order.orderType === 'Stop' || order.orderType === 'Limit'));
    expect(oco).toHaveLength(2);
    for (const leg of oco) expect(ctx.broker.cancelRequestCount(leg.brokerOrderId)).toBe(1);
    expect(ctx.controller.status().lastError).toContain('flat účet');
  });

  it('posun jediné nohy: odmítnutí = rejected, prázdná odpověď se ověří čtením; neznámé add-leg stream nevyřeší', async () => {
    const ctx = await setup();
    await settled(ctx);
    await addStop(ctx, 24_990);
    await next(ctx);
    const original = ctx.broker.modifyOrder.bind(ctx.broker);
    ctx.broker.modifyOrder = async () => { throw new Error('modifyOrder rejected: InvalidPrice'); };
    expect((await manage(ctx, { action: 'move-stop', expect: { price: 24_990, quantity: 1 }, newPrice: 24_985 })).status).toBe('rejected');
    await next(ctx);
    ctx.broker.modifyOrder = async () => undefined;
    expect((await manage(ctx, { action: 'move-stop', expect: { price: 24_990, quantity: 1 }, newPrice: 24_985 })).status).toBe('unknown');
    ctx.broker.modifyOrder = original;
    expect(ctx.controller.status().unresolvedManualOrderActions).toHaveLength(1);
  });

  it('neznámé přidání nohy: konec staré nohy ve streamu akci nevyřeší', async () => {
    const ctx = await setup();
    await settled(ctx);
    await addStop(ctx, 24_990);
    await next(ctx);
    const stop = openType(ctx.broker, 'Stop')[0];
    ctx.broker.placeOco = async () => { throw new Error('test: timeout'); };
    expect((await addTarget(ctx, 25_020, 24_990)).status).toBe('unknown');
    stop.status = 'canceled';
    ctx.broker.emitEvent({ type: 'order', order: { ...stop, sourceVersion: '9:Canceled' } });
    await sleep(20);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().unresolvedManualOrderActions).toEqual([expect.objectContaining({ action: 'add-leg', status: 'unknown' })]);
  });

  it('přidání nohy se nepodaří uložit: incident a výsledek neznámý', async () => {
    const ctx = await setup();
    await settled(ctx);
    let fail = false;
    ctx.onCommit.fn = null;
    const original = ctx.broker.placeOrder.bind(ctx.broker);
    ctx.broker.placeOrder = async request => { const ack = await original(request); fail = true; ctx.failNextCommit(); return ack; };
    expect(fail).toBe(false);
    expect((await addStop(ctx, 24_990)).status).toBe('unknown');
    expect(ctx.controller.status().lastError).toContain('nepodařilo se je uložit');
  });

  it('TP → SL: odmítnuté OCO po zrušení TP říká pravdu', async () => {
    const ctx = await setup();
    await settled(ctx);
    await addTarget(ctx, 25_020);
    await next(ctx);
    ctx.broker.placeOco = async () => ({ firstBrokerOrderId: '', secondBrokerOrderId: '', accepted: false, definitive: true, rejectReason: 'test' });
    const result = await addStop(ctx, 24_990, 25_020);
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('TP je zrušený');
    expect(ctx.controller.status().bareLeaderTrade?.hasTarget).toBeUndefined();
  });

  it('× pozice s jednou nohou jde cestou holého zavření', async () => {
    const ctx = await setup();
    await settled(ctx);
    await addStop(ctx, 24_990);
    await next(ctx);
    let liquidated = 0;
    ctx.broker.liquidatePosition = async () => { liquidated += 1; return { status: 'indeterminate' as const, reason: 'test' }; };
    const closed = await manage(ctx, { action: 'close-position', expect: { price: 25_000, quantity: 1 } });
    expect(closed.blockers.map(issue => issue.code)).toEqual([]);
    expect(liquidated).toBe(1);
  });

  it('vlastní noha dál pracuje na flat účtu: incident po ustálení, bez zrušení', async () => {
    const ctx = await setup();
    await settled(ctx);
    await addStop(ctx, 24_990);
    await next(ctx);
    const leg = openType(ctx.broker, 'Stop')[0].brokerOrderId;
    ctx.broker.setPosition(LEADER, SYM, 0);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 0 } });
    await sleep(30);
    await ctx.controller.waitForIdle();
    ctx.clock.now += 4_000;
    await sleep(3_200);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().lastError).toContain('dál pracuje');
    expect(ctx.broker.cancelRequestCount(leg)).toBe(0);
  }, 10_000);

  it('restart během výměny: incident s textem podle fáze, nic se neposílá', async () => {
    const empty = emptySnapshot();
    const ctx = await setup({ ...empty, safety: { ...empty.safety, manualOrderActions: [{
      operationId: 'manage:restart0001', payloadHash: 'x', entryOperationId: ENTRY, action: 'add-leg', leg: 'takeProfit', phase: 'oco-acked', oldLegId: '77', status: 'sending',
      targetBrokerOrderId: '77', fromPrice: null, toPrice: 25_020, quantity: 1, symbol: SYM, createdAt: 1, updatedAt: 1,
    }] } });
    expect(ctx.controller.status().lastError).toContain('MOŽNÉ DVA SL');
    expect(ctx.controller.status().unresolvedManualOrderActions).toEqual([expect.objectContaining({ operationId: 'manage:restart0001', status: 'unknown' })]);
    expect(ctx.broker.cancelRequestCount('77')).toBe(0);
  });
});

describe('SL a TP po jedné: tvar příkazu a čisté brány', () => {
  const base = { groupId: 'g', operationId: 'manage:valid0001', leaderAccountId: 1, entryOperationId: 'entry:valid0001', symbol: SYM };
  it('validace: add-leg s cenou a nohou, remove-leg bez ceny, leg jinde nesmí', () => {
    const ok = buildLeaderOrderManageCommand({ ...base, action: 'add-leg', leg: 'stopLoss', newPrice: 24_990, expect: { price: 25_000, quantity: 1, stop: null, target: null } });
    expect(validateLeaderOrderManage(ok)).toBeTruthy();
    expect(() => validateLeaderOrderManage(buildLeaderOrderManageCommand({ ...base, action: 'add-leg', newPrice: 24_990, expect: { price: 25_000, quantity: 1 } }))).toThrow();
    expect(() => validateLeaderOrderManage(buildLeaderOrderManageCommand({ ...base, action: 'remove-leg', leg: 'stopLoss', newPrice: 24_990, expect: { price: 25_000, quantity: 1 } }))).toThrow();
    expect(() => validateLeaderOrderManage(buildLeaderOrderManageCommand({ ...base, action: 'move-stop', leg: 'stopLoss', newPrice: 24_990, expect: { price: 25_000, quantity: 1 } }))).toThrow();
    expect(() => validateLeaderOrderManage(buildLeaderOrderManageCommand({ ...base, action: 'move-stop', newPrice: 24_990, expect: { price: 25_000, quantity: 1, stop: null } }))).toThrow();
  });
  it('pod brzdou jen SL k pozici bez nohou', () => {
    const allowed = (action: 'add-leg' | 'remove-leg', leg: 'stopLoss' | 'takeProfit', hasStop: boolean, hasTarget: boolean) => singleLegAllowedUnderBrake({ action, leg, hasStop, hasTarget });
    expect(allowed('add-leg', 'stopLoss', false, false)).toBe(true);
    expect(allowed('add-leg', 'stopLoss', false, true)).toBe(false);
    expect(allowed('add-leg', 'takeProfit', false, false)).toBe(false);
    expect(allowed('remove-leg', 'stopLoss', true, false)).toBe(false);
  });
  it('cena nohy vůči trhu a usazení fillu', () => {
    const at = (leg: 'stopLoss' | 'takeProfit', price: number, side: 'Buy' | 'Sell' = 'Buy') => singleLegPriceProblem({ side, leg, price, market: 25_000, minTicks: 8 });
    expect(at('stopLoss', 24_998)).toBeNull();
    expect(at('stopLoss', 24_998.25)).toContain('8 ticků');
    expect(at('takeProfit', 25_002)).toBeNull();
    expect(at('stopLoss', 25_002, 'Sell')).toBeNull();
    expect(at('takeProfit', 25_002, 'Sell')).toContain('8 ticků');
    expect(singleLegFillSettled({ now: 2_000, fillAt: 100, createdAt: 0, windowMs: 1_500 })).toBe(true);
    expect(singleLegFillSettled({ now: 1_000, fillAt: 100, createdAt: 0, windowMs: 1_500 })).toBe(false);
    expect(singleLegFillSettled({ now: 4_000, fillAt: null, createdAt: 0, windowMs: 1_500 })).toBe(false);
    expect(singleLegFillSettled({ now: 5_000, fillAt: null, createdAt: 0, windowMs: 1_500 })).toBe(true);
  });
});
