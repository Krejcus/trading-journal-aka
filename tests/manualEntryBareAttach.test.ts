// 2. 11. 2026: holý Market z telefonní lišty (bez SL/TP) a doplnění SL/TP
// (`attach-brackets`) přes skutečný controller v manual-only DEMO skupině.
import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerAccountRiskSnapshot } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { manualOnlyDemoSafety, type CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import { buildLeaderEntryPreviewCommand, validateLeaderEntryPreview } from '../lib/leaderEntryPreview';
import type { BrokerOrder } from '../services/brokerPort';
import { buildLeaderEntryPlaceCommand } from '../lib/leaderEntryPlace';
import { buildLeaderOrderManageCommand, validateLeaderOrderManage } from '../lib/leaderOrderManage';

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
  const onCommit: { fn: (() => void) | null } = { fn: null };
  const store = { load: () => memory.load(), commit: async (...args: Parameters<typeof memory.commit>) => {
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
  return { onCommit, broker, controller, audits, clock, quote, bare };
}

const fillMarket = (broker: MockBroker, entryId: string, quantity: number) => {
  const entry = broker.orders().find(order => order.brokerOrderId === entryId)!;
  entry.status = 'filled';
  entry.filledQuantity = quantity;
  broker.emitEvent({ type: 'order', order: { ...entry, sourceVersion: '2:Filled' } });
  broker.emitEvent({ type: 'fill', fill: { fillId: `f-${entryId}`, tag: entry.tag, brokerOrderId: entryId, accountId: LEADER, symbol: SYM, side: 'Buy', quantity, price: 25_000.25, filledAt: 2 } });
  broker.setPosition(LEADER, SYM, quantity);
  broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: quantity } });
};

describe('holý Market a doplnění SL/TP (manual-only DEMO)', () => {
  it('validace: holý vstup jen bez obou nohou, Limit jen po 1 kontraktu', () => {
    const base = { type: 'preview-leader-entry', groupId: 'g', operationId: 'preview:abcdefgh1', leaderAccountId: 1, symbol: SYM, side: 'Buy', quantity: 1,
      intent: { armedAt: 1, groupConfigHash: 'abcdefgh', followerQuantities: [] } };
    expect(() => validateLeaderEntryPreview({ ...base, orderType: 'Market', referencePrice: 25_000, quoteReceivedAt: START })).not.toThrow();
    expect(() => validateLeaderEntryPreview({ ...base, orderType: 'Market', referencePrice: 25_000, quoteReceivedAt: START, stopLoss: 24_990 })).toThrow();
    // Holý Limit od 7. 11. 2026 jen po 1 kontraktu.
    expect(() => validateLeaderEntryPreview({ ...base, orderType: 'Limit', price: 24_990 })).not.toThrow();
    expect(() => validateLeaderEntryPreview({ ...base, quantity: 2, orderType: 'Limit', price: 24_990 })).toThrow();
    const manage = { groupId: 'g', operationId: 'manage:abcdefgh1', leaderAccountId: 1, entryOperationId: 'entry:abcdefgh1', symbol: SYM,
      action: 'attach-brackets' as const, expect: { price: 25_000, quantity: 1 } };
    expect(() => validateLeaderOrderManage(buildLeaderOrderManageCommand({ ...manage, stopLoss: 24_990, takeProfit: 25_020 }))).not.toThrow();
    expect(() => validateLeaderOrderManage(buildLeaderOrderManageCommand({ ...manage, stopLoss: 24_990 }))).toThrow();
    expect(() => validateLeaderOrderManage(buildLeaderOrderManageCommand({ ...manage, action: 'move-stop', newPrice: 24_980, stopLoss: 24_990, takeProfit: 25_020 }))).toThrow();
  });

  it('holý Market = jeden Market příkaz bez nohou; pak attach → OCO; pak běžný posun SL', async () => {
    const ctx = await setup();
    const placed = await ctx.controller.placeLeaderEntry(ctx.bare(2), { deadlineAt: ctx.clock.now + 15_000 });
    expect(placed).toMatchObject({ status: 'acknowledged' });
    expect(ctx.broker.placedOsoRequests()).toHaveLength(0);
    expect(ctx.broker.placedRequests()).toHaveLength(1);
    expect(ctx.broker.placedRequests()[0]).toMatchObject({ accountId: LEADER, symbol: SYM, side: 'Buy', quantity: 2, orderType: 'Market' });
    expect(ctx.broker.placedRequests()[0]).not.toHaveProperty('limitPrice');
    fillMarket(ctx.broker, placed.entryBrokerOrderId!, 2);
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });

    ctx.clock.now += 4_000;
    const attach = buildLeaderOrderManageCommand({ groupId: group().id, operationId: 'manage:attach0001', leaderAccountId: LEADER,
      entryOperationId: 'entry:baretest001', symbol: SYM, action: 'attach-brackets', expect: { price: 25_000, quantity: 2 }, stopLoss: 24_990, takeProfit: 25_020 });
    const attached = await ctx.controller.manageLeaderOrder(attach, { deadlineAt: ctx.clock.now + 15_000 });
    expect(attached).toMatchObject({ status: 'acknowledged' });
    expect(ctx.broker.placedOcoRequests()).toHaveLength(1);
    expect(ctx.broker.placedOcoRequests()[0]).toMatchObject({ accountId: LEADER, symbol: SYM, quantity: 2,
      first: { side: 'Sell', orderType: 'Stop', stopPrice: 24_990 }, second: { side: 'Sell', orderType: 'Limit', limitPrice: 25_020 } });
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
    // Druhý attach: obchod už nohy má.
    const again = await ctx.controller.manageLeaderOrder(buildLeaderOrderManageCommand({ ...attach, operationId: 'manage:attach0002' }), { deadlineAt: ctx.clock.now + 15_000 });
    expect(again.blockers.map(issue => issue.code)).toContain('already-protected');
    expect(ctx.broker.placedOcoRequests()).toHaveLength(1);
    // Po doplnění je to běžný spravovaný obchod: posun SL dál od trhu.
    ctx.clock.now += 4_000;
    const move = await ctx.controller.manageLeaderOrder(buildLeaderOrderManageCommand({ groupId: group().id, operationId: 'manage:move00001', leaderAccountId: LEADER,
      entryOperationId: 'entry:baretest001', symbol: SYM, action: 'move-stop', expect: { price: 24_990, quantity: 2 }, newPrice: 24_985 }), { deadlineAt: ctx.clock.now + 15_000 });
    expect(move.blockers).toEqual([]);
    expect(move.status).toBe('acknowledged');
    expect(ctx.broker.modifyRequests().at(-1)).toMatchObject({ accountId: LEADER, changes: { orderType: 'Stop', stopPrice: 24_985, quantity: 2 } });
  });

  it('attach odmítne nohy na špatné straně trhu nebo blízko', async () => {
    const ctx = await setup();
    const placed = await ctx.controller.placeLeaderEntry(ctx.bare(1), { deadlineAt: ctx.clock.now + 15_000 });
    fillMarket(ctx.broker, placed.entryBrokerOrderId!, 1);
    await sleep(30);
    await ctx.controller.waitForIdle();
    const cmd = (stopLoss: number, takeProfit: number, id: string) => buildLeaderOrderManageCommand({ groupId: group().id, operationId: id, leaderAccountId: LEADER,
      entryOperationId: 'entry:baretest001', symbol: SYM, action: 'attach-brackets', expect: { price: 25_000, quantity: 1 }, stopLoss, takeProfit });
    const close = await ctx.controller.manageLeaderOrder(cmd(24_999, 25_020, 'manage:attach0003'), { deadlineAt: ctx.clock.now + 15_000 });
    expect(close.blockers.map(issue => issue.code)).toContain('bracket-side');
    const wrong = await ctx.controller.manageLeaderOrder(cmd(25_010, 24_980, 'manage:attach0004'), { deadlineAt: ctx.clock.now + 15_000 });
    expect(wrong.blockers.map(issue => issue.code)).toContain('bracket-side');
    expect(ctx.broker.placedOcoRequests()).toHaveLength(0);
  });

  it('attach za DISARMED projde (snižuje riziko)', async () => {
    const ctx = await setup();
    const placed = await ctx.controller.placeLeaderEntry(ctx.bare(1), { deadlineAt: ctx.clock.now + 15_000 });
    fillMarket(ctx.broker, placed.entryBrokerOrderId!, 1);
    await sleep(30);
    await ctx.controller.waitForIdle();
    ctx.controller.disarm('manual');
    await ctx.controller.waitForIdle();
    const attached = await ctx.controller.manageLeaderOrder(buildLeaderOrderManageCommand({ groupId: group().id, operationId: 'manage:attach0005', leaderAccountId: LEADER,
      entryOperationId: 'entry:baretest001', symbol: SYM, action: 'attach-brackets', expect: { price: 25_000, quantity: 1 }, stopLoss: 24_990, takeProfit: 25_020 }), { deadlineAt: ctx.clock.now + 15_000 });
    expect(attached.status).toBe('acknowledged');
  });

  it('ACK doplnění na už flat účtu: nohy se cíleně ruší a vzniká incident (P0)', async () => {
    const ctx = await setup();
    const placed = await ctx.controller.placeLeaderEntry(ctx.bare(1), { deadlineAt: ctx.clock.now + 15_000 });
    fillMarket(ctx.broker, placed.entryBrokerOrderId!, 1);
    await sleep(30);
    await ctx.controller.waitForIdle();
    const original = ctx.broker.placeOco!.bind(ctx.broker);
    ctx.broker.placeOco = async request => {
      // Flatten mezitím zavřel pozici (stream to ukáže dřív než ACK).
      ctx.broker.setPosition(LEADER, SYM, 0);
      ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 0 } });
      return original(request);
    };
    const attached = await ctx.controller.manageLeaderOrder(buildLeaderOrderManageCommand({ groupId: group().id, operationId: 'manage:attach0006', leaderAccountId: LEADER,
      entryOperationId: 'entry:baretest001', symbol: SYM, action: 'attach-brackets', expect: { price: 25_000, quantity: 1 }, stopLoss: 24_990, takeProfit: 25_020 }), { deadlineAt: ctx.clock.now + 15_000 });
    expect(attached.status).toBe('unknown');
    await sleep(30);
    const legs = ctx.broker.orders().filter(order => order.orderType === 'Stop' || order.orderType === 'Limit');
    expect(legs.length).toBe(2);
    for (const leg of legs) expect(ctx.broker.cancelRequestCount(leg.brokerOrderId)).toBe(1);
    expect(ctx.controller.status().lastError).toContain('nohy doplněné na flat účet');
  });

  it.each([[39, 'acknowledged'], [41, 'blocked']] as const)('holý Market: trh se během ukládání pohne o %i ticků: %s', async (ticks, status) => {
    const ctx = await setup();
    const command = ctx.bare(1);
    ctx.onCommit.fn = () => { ctx.quote.bid = 25_000 - ticks * 0.25; ctx.quote.last = ctx.quote.bid; ctx.quote.ask = ctx.quote.bid + 0.25 + 2 * ticks * 0.25; };
    const result = await ctx.controller.placeLeaderEntry(command, { deadlineAt: ctx.clock.now + 15_000 });
    expect(result.status).toBe(status);
  });

  const attachWithStopFilled = async (id: string, after?: (ctx: Awaited<ReturnType<typeof setup>>, legs: { stop: BrokerOrder; target: BrokerOrder }) => void) => {
    const ctx = await setup();
    const placed = await ctx.controller.placeLeaderEntry(ctx.bare(1), { deadlineAt: ctx.clock.now + 15_000 });
    fillMarket(ctx.broker, placed.entryBrokerOrderId!, 1);
    await sleep(30);
    await ctx.controller.waitForIdle();
    const original = ctx.broker.placeOco!.bind(ctx.broker);
    ctx.broker.placeOco = async request => {
      const ack = await original(request);
      const stop = ctx.broker.orders().find(order => order.brokerOrderId === ack.firstBrokerOrderId)!;
      const target = ctx.broker.orders().find(order => order.brokerOrderId === ack.secondBrokerOrderId)!;
      stop.status = 'filled';
      stop.filledQuantity = stop.quantity;
      target.status = 'canceled';
      ctx.broker.setPosition(LEADER, SYM, 0);
      ctx.broker.emitEvent({ type: 'order', order: { ...stop } });
      ctx.broker.emitEvent({ type: 'order', order: { ...target } });
      ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 0 } });
      after?.(ctx, { stop, target });
      return ack;
    };
    const attached = await ctx.controller.manageLeaderOrder(buildLeaderOrderManageCommand({ groupId: group().id, operationId: id, leaderAccountId: LEADER,
      entryOperationId: 'entry:baretest001', symbol: SYM, action: 'attach-brackets', expect: { price: 25_000, quantity: 1 }, stopLoss: 24_990, takeProfit: 25_020 }), { deadlineAt: ctx.clock.now + 15_000 });
    return { ctx, attached };
  };

  it('vlastní SL se hned vyplnil a účet je ověřeně flat: žádný incident (5. 11. na Openu)', async () => {
    const { ctx, attached } = await attachWithStopFilled('manage:attach0009');
    expect(attached.status).toBe('acknowledged');
    expect(attached.reason).toMatch(/SL se hned vyplnil/);
    expect(ctx.controller.status().lastError ?? null).toBeNull();
  });

  it('noha vyplněná, ale pozice se otočila: incident, ne „zavřeno“', async () => {
    const { ctx, attached } = await attachWithStopFilled('manage:attach0010', context => {
      const positions = context.broker.listPositions.bind(context.broker);
      let reads = 0;
      context.broker.listPositions = async accountId => {
        reads += 1;
        // První čtení net 0, pak se ukáže otočená pozice.
        if (reads > 1) context.broker.setPosition(LEADER, SYM, -1);
        return positions(accountId);
      };
    });
    expect(attached.status).toBe('unknown');
    expect(ctx.controller.status().lastError).toContain('nohy doplněné na flat účet');
  });

  it('noha vyplněná, druhá dál pracuje a zrušit nejde: incident', async () => {
    const { ctx, attached } = await attachWithStopFilled('manage:attach0011', (context, legs) => {
      legs.target.status = 'working';
      context.broker.cancelOrder = async () => { throw new Error('timeout'); };
    });
    expect(attached.status).toBe('unknown');
    expect(ctx.controller.status().lastError).toBeTruthy();
  });

  it('ACK dřív, než stream ukáže flat: rozhodne čtení u brokera (P1-1)', async () => {
    const ctx = await setup();
    const placed = await ctx.controller.placeLeaderEntry(ctx.bare(1), { deadlineAt: ctx.clock.now + 15_000 });
    fillMarket(ctx.broker, placed.entryBrokerOrderId!, 1);
    await sleep(30);
    await ctx.controller.waitForIdle();
    const original = ctx.broker.placeOco!.bind(ctx.broker);
    // Pozice zavřená u brokera, stream to zatím neukázal.
    ctx.broker.placeOco = async request => { ctx.broker.setPosition(LEADER, SYM, 0); return original(request); };
    const attached = await ctx.controller.manageLeaderOrder(buildLeaderOrderManageCommand({ groupId: group().id, operationId: 'manage:attach0007', leaderAccountId: LEADER,
      entryOperationId: 'entry:baretest001', symbol: SYM, action: 'attach-brackets', expect: { price: 25_000, quantity: 1 }, stopLoss: 24_990, takeProfit: 25_020 }), { deadlineAt: ctx.clock.now + 15_000 });
    expect(attached.status).toBe('unknown');
    await sleep(20);
    const legs = ctx.broker.orders().filter(order => order.orderType === 'Stop' || order.orderType === 'Limit');
    for (const leg of legs) expect(ctx.broker.cancelRequestCount(leg.brokerOrderId)).toBe(1);
  });

  it('starý holý záznam po flat neadoptuje novou pozici (P1-3)', async () => {
    const ctx = await setup();
    const placed = await ctx.controller.placeLeaderEntry(ctx.bare(1), { deadlineAt: ctx.clock.now + 15_000 });
    fillMarket(ctx.broker, placed.entryBrokerOrderId!, 1);
    await sleep(30);
    await ctx.controller.waitForIdle();
    ctx.broker.setPosition(LEADER, SYM, 0);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 0 } });
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().manualEntries?.find(entry => entry.operationId === 'entry:baretest001')).toMatchObject({ open: false });
    // Jiná pozice +1 bez příkazů (např. OSO, kterému někdo zrušil nohy).
    ctx.broker.setPosition(LEADER, SYM, 1);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 1 } });
    await sleep(30);
    await ctx.controller.waitForIdle();
    ctx.clock.now += 4_000;
    const attached = await ctx.controller.manageLeaderOrder(buildLeaderOrderManageCommand({ groupId: group().id, operationId: 'manage:attach0008', leaderAccountId: LEADER,
      entryOperationId: 'entry:baretest001', symbol: SYM, action: 'attach-brackets', expect: { price: 25_000, quantity: 1 }, stopLoss: 24_990, takeProfit: 25_020 }), { deadlineAt: ctx.clock.now + 15_000 });
    expect(attached.blockers.map(issue => issue.code)).toContain('entry-closed');
    expect(ctx.broker.placedOcoRequests()).toHaveLength(0);
  });

  it('leader zplochl bez dohledu workeru: kontrola pozic po reconnectu holý vstup uzavře', async () => {
    const ctx = await setup();
    const placed = await ctx.controller.placeLeaderEntry(ctx.bare(1), { deadlineAt: ctx.clock.now + 15_000 });
    fillMarket(ctx.broker, placed.entryBrokerOrderId!, 1);
    await sleep(30);
    await ctx.controller.waitForIdle();
    ctx.controller.disarm('manual');
    await ctx.controller.waitForIdle();
    ctx.broker.setConnected(false);
    await ctx.controller.waitForIdle();
    // Mezitím zavřeno mimo dohled (žádný position event).
    ctx.broker.setPosition(LEADER, SYM, 0);
    for (const order of ctx.broker.orders()) if (order.status === 'working') order.status = 'canceled';
    ctx.broker.setConnected(true);
    await sleep(60);
    await ctx.controller.waitForIdle();
    // Automatická kontrola se kvůli pozici leadera přeskočí → ruční Kontrola pozic.
    await ctx.controller.reconcile();
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().manualEntries?.find(entry => entry.operationId === 'entry:baretest001')).toMatchObject({ open: false });
  });
});
