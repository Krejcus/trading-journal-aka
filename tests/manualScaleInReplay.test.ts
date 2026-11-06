// Dokupování do pozice (3. 11. 2026): replay skutečného záznamu fáze 0 z DEMO
// (tests/fixtures/tradovate-leader-scale-in.json) přes controller v manual-only DEMO
// skupině. Základ Market OSO → přikoupení Market OSO (TP noha bez `parentId`!) →
// čekající přikoupení Limit → liquidate (zruší i čekající přikoupení). Nesmí vzniknout
// falešný incident, nohy přikoupení se nesmí brát jako samostatná redukce.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerAccountRiskSnapshot, BrokerOrder, BrokerOsoAck, BrokerOsoRequest } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { manualOnlyDemoSafety, type CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';
import { buildLeaderEntryPreviewCommand, type LiveEntryPreviewDraft } from '../lib/leaderEntryPreview';
import { buildLeaderEntryPlaceCommand } from '../lib/leaderEntryPlace';
import { buildLeaderOrderManageCommand } from '../lib/leaderOrderManage';

type RecordedEvent = { t: number; event: Record<string, unknown> & { type: string; receivedAt: number } };
const recording = JSON.parse(readFileSync(new URL('./fixtures/tradovate-leader-scale-in.json', import.meta.url), 'utf8')) as {
  events: RecordedEvent[];
  acks: BrokerOsoAck[];
  prices: { market: number; stopLoss: number; takeProfit: number; addLimit: number; loosened: { stopLoss: number; takeProfit: number } };
};
const RECORDED_LEADER = 1001;
const LEADER = 61038658;
const SYM = 'MNQZ6';
const [BASE, ADD, PENDING] = recording.acks;
/** Časy kroků záznamu (ms od startu): přikoupení odešlo 2313, posun 3857, čekající 5365, liquidate 7222. */
const T_ADD = 2_313;
const T_MODIFY = 3_857;
const T_PENDING = 5_365;
const T_LIQUIDATE = 7_222;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const group = (dailyLossLimitUsd = 5_000): CopyGroupConfig => ({
  id: `manual-demo-${LEADER}`, name: 'Ruční DEMO test', enabled: true, leaderAccountId: LEADER,
  followers: [], localOnly: true, manualOnly: true, manualEntryMaxContracts: 5,
  safety: { ...manualOnlyDemoSafety(), dailyLossLimitUsd },
});
const risk = (at: number): BrokerAccountRiskSnapshot => ({
  accountId: LEADER, at, realizedPnlUsd: 0, openPnlUsd: 0, netLiq: 50_000, minNetLiq: null,
  dailyLossAutoLiq: null, trailingMaxDrawdown: null,
} as unknown as BrokerAccountRiskSnapshot);

let active: CopierRuntimeController | null = null;
afterEach(() => { active?.stop(); active = null; });

const slice = (from: number, to: number) => recording.events.filter(item => item.t >= from && item.t < to);

async function setup(options: { scaleIn?: boolean; dailyLossLimitUsd?: number; realizedPnlUsd?: number; openPnlUsd?: number; freezeRiskAt?: boolean;
  store?: ReturnType<typeof createMemoryCopierStore>; arm?: boolean; settleMs?: number } = {}) {
  const firstAt = recording.events[0].event.receivedAt;
  const clock = { now: firstAt - 60_000 };
  // Risk snímek s časem čtení (jako u brokera): po fillu ho controller vynuceně přečte znovu.
  const snapshot = { ...risk(0), realizedPnlUsd: options.realizedPnlUsd ?? 0, openPnlUsd: options.openPnlUsd ?? 0 };
  // `freezeRiskAt`: snímek „z doby před fillem“ — controller ho po fillu přečte, ale čas se neposune.
  const frozenAt = clock.now + 30_000;
  Object.defineProperty(snapshot, 'at', { get: () => (options.freezeRiskAt ? Math.min(clock.now, frozenAt) : clock.now), enumerable: true });
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [snapshot] });
  const audits: string[] = [];
  /** Poslední stav příkazů leadera ze záznamu — REST čtení brokera (mock je nezná). */
  const orderStates = new Map<string, BrokerOrder>();
  /** Eventy okna s posunutým časem příchodu (testovací hodiny mezi kroky běží napřed). */
  const emit = (items: RecordedEvent[]) => {
    const shift = items.length ? Math.max(0, clock.now + 20 - items[0].event.receivedAt) : 0;
    for (const item of items) {
      const { type, receivedAt: recordedAt, ...body } = item.event;
      const receivedAt = recordedAt + shift;
      clock.now = Math.max(clock.now, receivedAt);
      const payload = JSON.parse(JSON.stringify(body).replaceAll(`"accountId":${RECORDED_LEADER}`, `"accountId":${LEADER}`));
      if (type === 'order') {
        const order = payload.order as BrokerOrder;
        orderStates.set(order.brokerOrderId, { tag: '', ...order });
        broker.emitEvent({ type: 'order', order: { tag: '', ...order }, receivedAt } as never);
      } else if (type === 'fill') {
        broker.emitEvent({ type: 'fill', fill: { tag: '', ...payload.fill }, receivedAt } as never);
      } else if (type === 'position') {
        broker.setPosition(LEADER, SYM, payload.position.netQuantity);
        broker.emitEvent({ type: 'position', position: payload.position, receivedAt } as never);
      }
    }
  };
  // Broker: OSO vrátí id ze záznamu a po ~30 ms pustí jeho WS eventy (jako u Tradovate).
  const placed: BrokerOsoRequest[] = [];
  const windows = [[0, T_ADD], [T_ADD, T_MODIFY], [T_PENDING, T_LIQUIDATE]] as const;
  broker.placeOso = async (request: BrokerOsoRequest) => {
    const index = placed.length;
    placed.push(request);
    const ack = recording.acks[index];
    setTimeout(() => emit(slice(windows[index][0], windows[index][1])), 30);
    return ack;
  };
  broker.listOrders = async accountId => [...orderStates.values()].filter(order => order.accountId === accountId).map(order => ({ ...order }));
  // REST čtení jednoho příkazu (C12: předčtení a ověření automatického zrušení) ze stejného stavu.
  broker.findOrderById = async (accountId, brokerOrderId) => {
    const order = orderStates.get(brokerOrderId);
    return { order: order && order.accountId === accountId ? { ...order } : null, completeness: 'authoritative' as const, observedAt: clock.now };
  };
  // Zrušení jako u Tradovate: otevřený příkaz → Canceled event (stav i pro REST čtení); počet z mocku.
  const mockCancel = broker.cancelOrder.bind(broker);
  broker.cancelOrder = async (accountId, brokerOrderId) => {
    await mockCancel(accountId, brokerOrderId);
    const current = orderStates.get(brokerOrderId);
    if (!current || (current.status !== 'working' && current.status !== 'pending')) return;
    const next: BrokerOrder = { ...current, status: 'canceled', sourceVersion: `${brokerOrderId}:Canceled`, updatedAt: clock.now };
    orderStates.set(brokerOrderId, next);
    broker.emitEvent({ type: 'order', order: next, receivedAt: clock.now } as never);
  };
  // Modify: jako Tradovate — Replaced event s novou cenou a potvrzení `stream-replaced`; `rejectIds` odmítne.
  const modified: Array<{ id: string; changes: Record<string, unknown> }> = [];
  const rejectIds = new Set<string>();
  broker.modifyOrder = async (_accountId, brokerOrderId, changes) => {
    modified.push({ id: brokerOrderId, changes: { ...changes } });
    await sleep(5);
    if (rejectIds.has(brokerOrderId)) throw new Error(`modifyOrder command 1 rejected: InvalidPrice`);
    const current = orderStates.get(brokerOrderId)!;
    const next: BrokerOrder = { ...current, quantity: changes.quantity, orderType: changes.orderType,
      ...(changes.stopPrice != null ? { stopPrice: changes.stopPrice } : {}), ...(changes.limitPrice != null ? { limitPrice: changes.limitPrice } : {}),
      status: 'working', sourceVersion: `${brokerOrderId}:Replaced:${modified.length}`, updatedAt: clock.now };
    orderStates.set(brokerOrderId, next);
    broker.emitEvent({ type: 'order', order: next, receivedAt: clock.now } as never);
    return { confirmedBy: 'stream-replaced' as const, order: { ...next } };
  };
  const liquidated: string[] = [];
  broker.liquidatePosition = async request => {
    liquidated.push(request.symbol);
    setTimeout(() => emit(slice(T_LIQUIDATE, Infinity)), 10);
    return { status: 'submitted' as const };
  };
  const controller = await bootstrapCopierRuntime({
    broker, store: options.store ?? createMemoryCopierStore(), group: group(options.dailyLossLimitUsd), clock: () => clock.now, osoCorrelationWindowMs: 200,
    connectionRenewalClock: () => clock.now,
    manualEntryTimingsMs: { post: 500, start: 1_000, legWait: 500, ...(options.settleMs != null ? { settle: options.settleMs } : {}) },
    manualEntryScaleIn: options.scaleIn ?? true,
    manualEntryQuote: () => ({ contract: SYM, last: 28_083.5, lastAt: clock.now - 100, bid: 28_083.25, ask: 28_083.5, quoteAt: clock.now - 50 }),
    onAudit: entries => { for (const entry of entries) audits.push(`${entry.kind}:${entry.reason ?? ''}`); },
  });
  active = controller;
  broker.setConnected(true);
  await controller.waitForIdle();
  if (options.arm !== false) {
    await controller.reconcile();
    controller.arm();
    await controller.waitForIdle();
  }
  const command = (operationId: string, draft: Partial<LiveEntryPreviewDraft>) => {
    const status = controller.status();
    const preview = buildLeaderEntryPreviewCommand(
      { symbol: SYM, side: 'Buy', quantity: 1, orderType: 'Market', referencePrice: 28_083.5, quoteReceivedAt: clock.now - 300,
        stopLoss: recording.prices.stopLoss, takeProfit: recording.prices.takeProfit, ...draft },
      { group: { ...group(options.dailyLossLimitUsd), leaderAccountId: LEADER }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: `preview:${operationId}` },
    );
    return buildLeaderEntryPlaceCommand(preview, `entry:${operationId}`);
  };
  const place = (entry: ReturnType<typeof command>) => controller.placeLeaderEntry(entry, { deadlineAt: clock.now + 15_000 });
  /** Po eventech: ticho 5 s po eventu leadera, čerstvý risk snímek po fillu. */
  const settle = async (ms = 6_000) => {
    await sleep(80);
    await controller.waitForIdle();
    clock.now += ms;
    broker.emitEvent({ type: 'heartbeat', at: clock.now });
    await sleep(40);
    await controller.waitForIdle();
  };
  const manage = (operationId: string, fields: { action: 'move-stop' | 'move-target' | 'close-position' | 'cancel-entry'; price: number; quantity: number; newPrice?: number;
    entryOperationId: string; scope?: 'position' }) => controller.manageLeaderOrder(buildLeaderOrderManageCommand({
    groupId: group().id, operationId: `manage:${operationId}`, leaderAccountId: LEADER, entryOperationId: fields.entryOperationId,
    symbol: SYM, action: fields.action, expect: { price: fields.price, quantity: fields.quantity },
    ...(fields.newPrice != null ? { newPrice: fields.newPrice } : {}), ...(fields.scope ? { scope: fields.scope } : {}),
  }), { deadlineAt: clock.now + 15_000 });
  return { broker, controller, audits, clock, command, place, settle, emit, placed, manage, modified, rejectIds, liquidated, orderStates };
}

const addIntent = (ticketEntryIds: string[], quantity: number) => ({ mode: 'add' as const, side: 'Buy' as const, quantity, ticketEntryIds });

/** Základ + Market přikoupení + posun ze záznamu + čekající Limit přikoupení (ACK). */
async function withPendingAdd(ctx: Awaited<ReturnType<typeof setup>>, id: string) {
  await ctx.place(ctx.command(`scalebase${id}`, {}));
  await ctx.settle();
  await ctx.place(ctx.command(`scaleadd0${id}`, { position: addIntent([BASE.entryBrokerOrderId], 1) }));
  await ctx.settle();
  ctx.emit(slice(T_MODIFY, T_PENDING));
  await ctx.settle();
  const { loosened } = recording.prices;
  const pending = await ctx.place(ctx.command(`scalepnd${id}`, {
    orderType: 'Limit', price: recording.prices.addLimit, stopLoss: loosened.stopLoss, takeProfit: loosened.takeProfit,
    position: addIntent([BASE.entryBrokerOrderId, ADD.entryBrokerOrderId].sort(), 2),
  }));
  expect(pending).toMatchObject({ status: 'acknowledged', entryBrokerOrderId: PENDING.entryBrokerOrderId });
  await ctx.settle(1_000);
  return pending;
}

describe('přikoupení do pozice: replay záznamu z DEMO (3. 11. 2026)', { timeout: 30_000 }, () => {
  it('základ + Market přikoupení se stejným SL/TP: ACK, žádný incident, dva lístky jedné pozice', async () => {
    const ctx = await setup();
    const base = await ctx.place(ctx.command('scalebase0001', {}));
    expect(base).toMatchObject({ status: 'acknowledged', entryBrokerOrderId: BASE.entryBrokerOrderId });
    await ctx.settle();
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });

    const add = await ctx.place(ctx.command('scaleadd00001', { position: addIntent([BASE.entryBrokerOrderId], 1) }));
    expect(add.blockers).toEqual([]);
    expect(add).toMatchObject({ status: 'acknowledged', entryBrokerOrderId: ADD.entryBrokerOrderId });
    await ctx.settle();
    const status = ctx.controller.status();
    expect(status.lastError).toBeNull();
    expect(status.armed).toBe(true);
    expect(ctx.audits.filter(line => line.includes('nohy nedorazily') || line.includes('oso-lone-leg') || line.includes('standalone'))).toEqual([]);
    // Market rodič není v OSO korelátoru: SL dítě dostane stejný audit u základu i přikoupení (dnešní chování z flat).
    expect(ctx.audits.filter(line => line.includes('protective-child-without'))).toEqual([
      `blocked:protective-child-without-copied-entry:${BASE.entryBrokerOrderId}`,
      `blocked:protective-child-without-copied-entry:${ADD.entryBrokerOrderId}`,
    ]);
    expect(ctx.broker.cancelRequestCount(ADD.entryBrokerOrderId)).toBe(0);
    expect(ctx.placed[1]).toMatchObject({ orderType: 'Market', quantity: 1,
      first: { orderType: 'Stop', stopPrice: recording.prices.stopLoss }, second: { orderType: 'Limit', limitPrice: recording.prices.takeProfit } });
    expect(status.manualEntries?.find(entry => entry.operationId === 'entry:scaleadd00001')).toMatchObject({ status: 'acknowledged' });
  });

  it('čekající Limit přikoupení: nohy podle id z ACK (TP bez parentId), žádný incident; liquidate ho zruší', async () => {
    const ctx = await setup();
    await ctx.place(ctx.command('scalebase0006', {}));
    await ctx.settle();
    await ctx.place(ctx.command('scaleadd00006', { position: addIntent([BASE.entryBrokerOrderId], 1) }));
    await ctx.settle();
    // Souběžný posun obou SL a TP ze záznamu (stream potvrdí nové ceny všech čtyř nohou).
    ctx.emit(slice(T_MODIFY, T_PENDING));
    await ctx.settle();
    const { loosened } = recording.prices;
    const pending = await ctx.place(ctx.command('scalepend0006', {
      orderType: 'Limit', price: recording.prices.addLimit, stopLoss: loosened.stopLoss, takeProfit: loosened.takeProfit,
      position: addIntent([BASE.entryBrokerOrderId, ADD.entryBrokerOrderId].sort(), 2),
    }));
    expect(pending.blockers).toEqual([]);
    expect(pending).toMatchObject({ status: 'acknowledged', entryBrokerOrderId: PENDING.entryBrokerOrderId });
    // Okno OSO korelace (200 ms) + čekání na nohy (500 ms): vlastní nohy musí najít svůj vstup.
    await ctx.settle(1_000);
    await ctx.settle(1_000);
    let status = ctx.controller.status();
    expect(status).toMatchObject({ armed: true, lastError: null });
    expect(ctx.audits.filter(line => line.includes('nohy nedorazily') || line.includes('oso-lone-leg'))).toEqual([]);
    expect(ctx.broker.cancelRequestCount(PENDING.entryBrokerOrderId)).toBe(0);
    // Liquidate ze záznamu: broker zruší všechny nohy i čekající přikoupení, pak zavře 2 kontrakty.
    ctx.emit(slice(T_LIQUIDATE, Infinity));
    await ctx.settle();
    status = ctx.controller.status();
    expect(status.lastError).toBeNull();
  });

  it('čekající přikoupení se zruší při vypnutí kopírky (stavová podmínka, i za DISARMED)', async () => {
    const ctx = await setup();
    await withPendingAdd(ctx, '0007');
    expect(ctx.broker.cancelRequestCount(PENDING.entryBrokerOrderId)).toBe(0);
    ctx.controller.disarm('manual');
    await sleep(1_200);
    await ctx.controller.waitForIdle();
    expect(ctx.broker.cancelRequestCount(PENDING.entryBrokerOrderId)).toBe(1);
    // Jediný pokus — další kola kontroly ho neopakují.
    await sleep(1_100);
    expect(ctx.broker.cancelRequestCount(PENDING.entryBrokerOrderId)).toBe(1);
    expect(ctx.broker.cancelRequestCount(BASE.firstBrokerOrderId)).toBe(0);
  });

  it('Market přikoupení s otevřeným (zatím jen z ACK) vstupem se po vypnutí neruší a audit se neopakuje', async () => {
    const ctx = await setup();
    await ctx.place(ctx.command('scalebase0009', {}));
    await ctx.settle();
    // Broker přikoupení přijme, ale stream ještě nic nedoručil: vstup v cache = syntetický `pending` z ACK.
    ctx.broker.placeOso = async () => ADD;
    await ctx.place(ctx.command('scaleadd00009', { position: addIntent([BASE.entryBrokerOrderId], 1) }));
    await sleep(50);
    await ctx.controller.waitForIdle();
    ctx.controller.disarm('manual');
    await sleep(2_300);
    expect(ctx.broker.cancelRequestCount(ADD.entryBrokerOrderId)).toBe(0);
    expect(ctx.audits.filter(line => line.includes('vlastní Market se neruší'))).toEqual([]);
  });

  it('pozice zavřená (SL/TP) s čekajícím přikoupením → přikoupení se zruší', async () => {
    const ctx = await setup();
    await withPendingAdd(ctx, '0008');
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 0 }, receivedAt: ctx.clock.now } as never);
    await sleep(60);
    await ctx.controller.waitForIdle();
    await sleep(20);
    expect(ctx.broker.cancelRequestCount(PENDING.entryBrokerOrderId)).toBe(1);
    expect(ctx.audits.some(line => line.includes('čekající přikoupení: pozice je zavřená'))).toBe(true);
  });

  /** Testovací hodiny po krocích; kontrolu přikoupení spouští heartbeat (deterministicky, bez 1s časovače). */
  const holdFor = async (ctx: Awaited<ReturnType<typeof setup>>, ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 2_000) {
      ctx.clock.now += 2_000;
      ctx.broker.emitEvent({ type: 'heartbeat', at: ctx.clock.now });
      await sleep(30);
      await ctx.controller.waitForIdle();
      await sleep(10);
    }
  };

  it('čekající přikoupení držené přes 5 s nevyhlásí falešné nadkrytí (oponentura diffu, P1-A)', async () => {
    const ctx = await setup();
    await withPendingAdd(ctx, '0010');
    await holdFor(ctx, 8_000);
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
    expect(ctx.broker.cancelRequestCount(PENDING.entryBrokerOrderId)).toBe(0);
  }, 30_000);

  it('skutečné nadkrytí (ruční částečné zavření v Tradovate) = incident po ustálení', async () => {
    const ctx = await setup();
    await ctx.place(ctx.command('scalebase0011', {}));
    await ctx.settle();
    await ctx.place(ctx.command('scaleadd00011', { position: addIntent([BASE.entryBrokerOrderId], 1) }));
    await ctx.settle();
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 1 }, receivedAt: ctx.clock.now } as never);
    await holdFor(ctx, 8_000);
    expect(ctx.controller.status().lastError).toContain('kryjí víc kontraktů');
    expect(ctx.controller.status().armed).toBe(false);
  }, 30_000);

  it('nadkrytí za vypnuté kopírky = jen upozornění v auditu, žádný incident (Filip 3. 11.)', async () => {
    const ctx = await setup();
    await ctx.place(ctx.command('scalebase0016', {}));
    await ctx.settle();
    await ctx.place(ctx.command('scaleadd00016', { position: addIntent([BASE.entryBrokerOrderId], 1) }));
    await ctx.settle();
    ctx.controller.disarm('manual');
    await ctx.controller.waitForIdle();
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 1 }, receivedAt: ctx.clock.now } as never);
    await holdFor(ctx, 8_000);
    expect(ctx.controller.status().lastError).toBeNull();
    expect(ctx.audits.filter(line => line.includes('scale-in-overcover'))).toHaveLength(1);
  }, 30_000);

  it('selhané zrušení čekajícího přikoupení = viditelný incident (P2-1); o něm rozhodne čtení po ustálení (C12 kolo 3 P2)', async () => {
    const ctx = await setup({ settleMs: 300 });
    await withPendingAdd(ctx, '0012');
    ctx.broker.cancelOrder = async () => { throw new Error('network down'); };
    ctx.controller.disarm('manual');
    await sleep(1_300);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().lastError).toContain('nepodařilo zrušit');
  });

  it('přikoupení s neznámým výsledkem (timeout POSTu) = incident (P2-1)', async () => {
    const ctx = await setup();
    await ctx.place(ctx.command('scalebase0013', {}));
    await ctx.settle();
    await ctx.place(ctx.command('scaleadd00013', { position: addIntent([BASE.entryBrokerOrderId], 1) }));
    await ctx.settle();
    ctx.emit(slice(T_MODIFY, T_PENDING));
    await ctx.settle();
    ctx.broker.placeOso = () => new Promise(() => undefined);
    const { loosened } = recording.prices;
    const result = await ctx.place(ctx.command('scalepnd0013', {
      orderType: 'Limit', price: recording.prices.addLimit, stopLoss: loosened.stopLoss, takeProfit: loosened.takeProfit,
      position: addIntent([BASE.entryBrokerOrderId, ADD.entryBrokerOrderId].sort(), 2),
    }));
    expect(result.status).toBe('unknown');
    expect(ctx.controller.status().lastError).toContain('Přikoupení');
    expect(ctx.controller.status().armed).toBe(false);
  });

  it('přikoupení vyplněné až v novém obchodu (jiná epizoda deníku) = incident, jednou', async () => {
    const ctx = await setup();
    await withPendingAdd(ctx, '0014');
    // Základ zavře liquidate (bez zrušení čekajícího přikoupení), pak se přikoupení vyplní z flat.
    const pendingIds = new Set([PENDING.entryBrokerOrderId, PENDING.firstBrokerOrderId, PENDING.secondBrokerOrderId]);
    ctx.broker.cancelOrder = async () => undefined;
    ctx.emit(slice(T_LIQUIDATE, Infinity).filter(item => !(item.event.type === 'order'
      && pendingIds.has(String((item.event.order as { brokerOrderId?: string }).brokerOrderId)))));
    await sleep(40);
    await ctx.controller.waitForIdle();
    const at = ctx.clock.now + 50;
    const entry = { tag: '', brokerOrderId: PENDING.entryBrokerOrderId, accountId: LEADER, symbol: SYM, side: 'Buy' as const, orderType: 'Limit' as const,
      quantity: 1, filledQuantity: 1, limitPrice: recording.prices.addLimit, status: 'filled' as const, sourceVersion: `${PENDING.entryBrokerOrderId}:Filled`, updatedAt: at };
    ctx.broker.emitEvent({ type: 'order', order: entry, receivedAt: at } as never);
    ctx.broker.emitEvent({ type: 'fill', fill: { fillId: 'f-new-episode', tag: '', brokerOrderId: PENDING.entryBrokerOrderId, accountId: LEADER, symbol: SYM, side: 'Buy',
      quantity: 1, price: recording.prices.addLimit, filledAt: at }, receivedAt: at } as never);
    ctx.broker.setPosition(LEADER, SYM, 1);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 1 }, receivedAt: at } as never);
    await sleep(60);
    await ctx.controller.waitForIdle();
    await sleep(20);
    expect(ctx.controller.status().lastError).toContain('otevřelo nový obchod');
    const incidents = ctx.audits.filter(line => line.includes('se vyplnilo až v novém obchodu'));
    await holdFor(ctx, 4_000);
    expect(ctx.audits.filter(line => line.includes('se vyplnilo až v novém obchodu'))).toEqual(incidents);
    expect(incidents).toHaveLength(1);
  });

  it('risk snímek starší než poslední fill pozice = přikoupení blokované (risk-unverified)', async () => {
    const ctx = await setup({ freezeRiskAt: true });
    await ctx.place(ctx.command('scalebase0015', {}));
    await ctx.settle();
    const add = await ctx.place(ctx.command('scaleadd00015', { position: addIntent([BASE.entryBrokerOrderId], 1) }));
    expect(add.status).toBe('blocked');
    expect(add.blockers.map(issue => issue.code)).toContain('risk-unverified');
  });

  it('C12: výpadek spojení s čekajícím přikoupením → nic se nezkouší bez spojení; po obnově jedno zrušení a automatické pokračování skončí (INV-RECON-04)', async () => {
    const ctx = await setup();
    await withPendingAdd(ctx, '0021');
    ctx.broker.setConnected(false);
    await sleep(60);
    await ctx.controller.waitForIdle();
    const waiting = ctx.controller.status().transportResume;
    expect(waiting?.phase).toBe('waiting');
    await sleep(1_100);
    expect(ctx.broker.cancelRequestCount(PENDING.entryBrokerOrderId)).toBe(0);
    ctx.broker.setConnected(true);
    await sleep(1_200);
    await ctx.controller.waitForIdle();
    expect(ctx.broker.cancelRequestCount(PENDING.entryBrokerOrderId)).toBe(1);
    expect(ctx.controller.status().transportResume).toMatchObject({ phase: 'declined', reason: expect.stringContaining('čekající vstup zrušen: čekající přikoupení: kopírka je vypnutá') });
  });

  it('C12 kolo 2 (P3): po výpadku se čekající přikoupení vyplní během durable `sending` (nic se neodešle) → automatické pokračování se NEzamítne „čekající vstup zrušen“ (INV-RECON-04)', async () => {
    const base = createMemoryCopierStore();
    let onSending: (() => Promise<void>) | null = null;
    const store = {
      load: () => base.load(),
      commit: async (snapshot: Parameters<typeof base.commit>[0], revision: Parameters<typeof base.commit>[1]) => {
        if (onSending && snapshot.safety?.manualEntries?.some(record => record.cancel?.status === 'sending')) {
          const hook = onSending;
          onSending = null;
          await hook();
        }
        return base.commit(snapshot, revision);
      },
    } as ReturnType<typeof createMemoryCopierStore>;
    const ctx = await setup({ store });
    await withPendingAdd(ctx, '0031');
    ctx.broker.setConnected(false);
    await sleep(60);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().transportResume?.phase).toBe('waiting');
    onSending = async () => {
      // Čekající přikoupení se u brokera vyplní (REST i stream), zatímco se zapisuje `cancel: sending`.
      const current = ctx.orderStates.get(PENDING.entryBrokerOrderId)!;
      const filled: BrokerOrder = { ...current, status: 'filled', filledQuantity: current.quantity, sourceVersion: `${current.brokerOrderId}:Filled`, updatedAt: ctx.clock.now };
      ctx.orderStates.set(filled.brokerOrderId, filled);
      ctx.broker.emitEvent({ type: 'order', order: filled, receivedAt: ctx.clock.now } as never);
      ctx.broker.emitEvent({ type: 'fill', fill: { fillId: 'c12r2-late-fill', tag: '', brokerOrderId: filled.brokerOrderId, accountId: LEADER, symbol: SYM, side: 'Buy', quantity: filled.quantity, price: recording.prices.addLimit, filledAt: ctx.clock.now }, receivedAt: ctx.clock.now } as never);
      await sleep(40);
    };
    ctx.broker.setConnected(true);
    await sleep(1_200);
    await ctx.controller.waitForIdle();
    expect(onSending).toBeNull();
    expect(ctx.broker.cancelRequestCount(PENDING.entryBrokerOrderId)).toBe(0);
    expect(ctx.audits.some(line => line.includes('těsně před zrušením — nic se neodeslalo'))).toBe(true);
    expect(ctx.controller.status().transportResume?.reason ?? '').not.toContain('čekající vstup zrušen');
  });

  it('restart během odesílání Limit přikoupení = unknown + trvalý incident (nikdy znovu neodesláno)', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ store });
    first.controller.stop();
    active = null;
    const snapshot = await store.load();
    await store.commit({
      ...snapshot,
      safety: { ...snapshot.safety!, manualEntries: [{
        operationId: 'entry:restartadd01', payloadHash: 'abcdefgh12', tag: 'me0123456789abcd', status: 'sending', scaleIn: true,
        createdAt: first.clock.now, updatedAt: first.clock.now,
        request: { accountId: LEADER, symbol: SYM, side: 'Buy', quantity: 1, orderType: 'Limit', price: 28_027.5, stopLoss: 27_937.5, takeProfit: 28_537.5 },
      }] },
    }, snapshot.revision);
    const second = await setup({ store, arm: false });
    expect(second.controller.status().manualEntries?.[0]).toMatchObject({ operationId: 'entry:restartadd01', status: 'unknown' });
    expect(second.controller.status().lastError).toContain('Přikoupení');
    expect(second.placed).toEqual([]);
  });

  it('bez opt-inu instalace přikoupení neodejde (scale-in-off), vstup z flat beze změny', async () => {
    const ctx = await setup({ scaleIn: false });
    await ctx.place(ctx.command('scalebase0002', {}));
    await ctx.settle();
    const add = await ctx.place(ctx.command('scaleadd00002', { position: addIntent([BASE.entryBrokerOrderId], 1) }));
    expect(add.status).toBe('blocked');
    expect(add.blockers.map(issue => issue.code)).toContain('scale-in-off');
    expect(ctx.placed).toHaveLength(1);
  });

  it('dvojklik / zastaralý záměr: druhé přikoupení se starou pozicí neodejde', async () => {
    const ctx = await setup();
    await ctx.place(ctx.command('scalebase0003', {}));
    await ctx.settle();
    await ctx.place(ctx.command('scaleadd00003', { position: addIntent([BASE.entryBrokerOrderId], 1) }));
    await ctx.settle();
    const again = await ctx.place(ctx.command('scaleadd00004', { position: addIntent([BASE.entryBrokerOrderId], 1) }));
    expect(again.status).toBe('blocked');
    expect(again.blockers.map(issue => issue.code)).toContain('intent-position-changed');
    expect(ctx.placed).toHaveLength(2);
  });

  it('vstup z flat bez `position` při otevřené pozici dál blokuje account-not-flat', async () => {
    const ctx = await setup();
    await ctx.place(ctx.command('scalebase0005', {}));
    await ctx.settle();
    const bare = await ctx.place(ctx.command('scaleflat0005', {}));
    expect(bare.status).toBe('blocked');
    expect(bare.blockers.map(issue => issue.code)).toContain('account-not-flat');
  });

  describe('správa celé pozice (scope: position)', () => {
    async function twoTickets(ctx: Awaited<ReturnType<typeof setup>>, id: string) {
      await ctx.place(ctx.command(`scalebase${id}`, {}));
      await ctx.settle();
      await ctx.place(ctx.command(`scaleadd0${id}`, { position: addIntent([BASE.entryBrokerOrderId], 1) }));
      await ctx.settle();
      return `entry:scalebase${id}`;
    }

    it('posun SL obou lístků najednou: dva modify s qty 1, potvrzeno; status ukáže pozici 2 se společným SL', async () => {
      const ctx = await setup();
      const base = await twoTickets(ctx, '0101');
      const position = ctx.controller.status().leaderPositions?.[0];
      expect(position).toMatchObject({ symbol: SYM, side: 'Buy', quantity: 2, baseEntryOperationId: base, tickets: 2,
        stopPrice: recording.prices.stopLoss, targetPrice: recording.prices.takeProfit, stopUniform: true, canManage: true, pendingAdd: null });
      const result = await ctx.manage('posstop0101', { action: 'move-stop', price: recording.prices.stopLoss, quantity: 2, newPrice: 27_930, entryOperationId: base, scope: 'position' });
      expect(result.blockers).toEqual([]);
      expect(result.status).toBe('acknowledged');
      expect(ctx.modified.map(item => item.id).sort()).toEqual([BASE.firstBrokerOrderId, ADD.firstBrokerOrderId].sort());
      expect(ctx.modified.every(item => item.changes.quantity === 1 && item.changes.stopPrice === 27_930 && item.changes.orderType === 'Stop')).toBe(true);
      await ctx.settle();
      expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(ctx.controller.status().leaderPositions?.[0]).toMatchObject({ stopPrice: 27_930, stopUniform: true });
      // Opakované doručení téhož příkazu: stejný výsledek, žádný další zápis.
      const again = await ctx.manage('posstop0101', { action: 'move-stop', price: recording.prices.stopLoss, quantity: 2, newPrice: 27_930, entryOperationId: base, scope: 'position' });
      expect(again.status).toBe('acknowledged');
      expect(ctx.modified).toHaveLength(2);
    });

    it('starý tvar příkazu (jeden lístek) na pozici se dvěma lístky = blokace position-multi', async () => {
      const ctx = await setup();
      const base = await twoTickets(ctx, '0102');
      const result = await ctx.manage('oldshape0102', { action: 'move-stop', price: recording.prices.stopLoss, quantity: 2, newPrice: 27_930, entryOperationId: base });
      expect(result.status).toBe('blocked');
      expect(result.blockers.map(issue => issue.code)).toContain('position-multi');
      expect(ctx.modified).toHaveLength(0);
    });

    it('jiný základní lístek nebo jiné qty = order-changed; nic se neodešle', async () => {
      const ctx = await setup();
      await twoTickets(ctx, '0103');
      const wrongBase = await ctx.manage('posbase0103', { action: 'move-stop', price: recording.prices.stopLoss, quantity: 2, newPrice: 27_930, entryOperationId: 'entry:scaleadd00103', scope: 'position' });
      expect(wrongBase.blockers.map(issue => issue.code)).toContain('order-changed');
      const wrongQty = await ctx.manage('posqty00103', { action: 'move-stop', price: recording.prices.stopLoss, quantity: 1, newPrice: 27_930, entryOperationId: 'entry:scalebase0103', scope: 'position' });
      expect(wrongQty.blockers.map(issue => issue.code)).toContain('order-changed');
      expect(ctx.modified).toHaveLength(0);
    });

    it('jedna noha odmítnutá: výsledek unknown „u 1 z 2“, žádné opakování; rozjeté nohy další posun blokují', async () => {
      const ctx = await setup();
      const base = await twoTickets(ctx, '0104');
      ctx.rejectIds.add(ADD.firstBrokerOrderId);
      const result = await ctx.manage('posrej0104', { action: 'move-stop', price: recording.prices.stopLoss, quantity: 2, newPrice: 27_930, entryOperationId: base, scope: 'position' });
      expect(result.status).toBe('unknown');
      expect(result.reason).toContain('1 z 2');
      expect(ctx.modified).toHaveLength(2);
      await ctx.settle();
      expect(ctx.controller.status().leaderPositions?.[0]).toMatchObject({ stopUniform: false, canManage: false, stopPrice: 27_937.5 });
      // Bez tichého sjednocení: další posun z nejochrannějšího SL blokuje legs-diverged, nic se neodešle.
      const next = await ctx.manage('posrej0104b', { action: 'move-stop', price: 27_937.5, quantity: 2, newPrice: 27_920, entryOperationId: base, scope: 'position' });
      expect(next.blockers.map(issue => issue.code)).toContain('legs-diverged');
      expect(ctx.modified).toHaveLength(2);
      // Zavření celé pozice v tomto stavu jde (jediná cesta z appky).
      const close = await ctx.manage('posrej0104c', { action: 'close-position', price: 27_937.5, quantity: 2, entryOperationId: base, scope: 'position' });
      expect(close.blockers).toEqual([]);
      expect(ctx.liquidated).toEqual([SYM]);
    });

    it('zrušení čekajícího přikoupení přes jeho lístek (výjimka z position-multi)', async () => {
      const ctx = await setup();
      await withPendingAdd(ctx, '0108');
      const result = await ctx.manage('pospndc0108', { action: 'cancel-entry', price: recording.prices.addLimit, quantity: 1, entryOperationId: 'entry:scalepnd0108' });
      expect(result.blockers).toEqual([]);
      expect(ctx.broker.cancelRequestCount(PENDING.entryBrokerOrderId)).toBe(1);
    });

    it('C7 / oponentura C17 (P2): zrušení přikoupení uprostřed změny celé pozice = busy, nic se neodešle', async () => {
      const ctx = await setup();
      await withPendingAdd(ctx, '0109');
      const { loosened } = recording.prices;
      let liquidateStarted = false;
      let release: (() => void) | undefined;
      ctx.broker.liquidatePosition = async () => {
        liquidateStarted = true;
        await new Promise<void>(resolve => { release = resolve; });
        return { status: 'submitted' as const };
      };
      const closing = ctx.manage('posxcl0109', { action: 'close-position', price: loosened.stopLoss, quantity: 2, entryOperationId: 'entry:scalebase0109', scope: 'position' });
      for (let waited = 0; !liquidateStarted && waited < 2_000; waited += 5) await sleep(5);
      expect(liquidateStarted).toBe(true);
      const cancel = await ctx.manage('pospndc0109', { action: 'cancel-entry', price: recording.prices.addLimit, quantity: 1, entryOperationId: 'entry:scalepnd0109' });
      expect(cancel.blockers.map(issue => issue.code)).toEqual(['busy']);
      expect(ctx.broker.cancelRequestCount(PENDING.entryBrokerOrderId)).toBe(0);
      release?.();
      await closing;
    });

    it('C7 oponentura diffu (P3): po změně celé pozice s neznámým výsledkem zrušení přikoupení = manage-unresolved, nic se neodešle', async () => {
      const ctx = await setup();
      await withPendingAdd(ctx, '0110');
      const { loosened } = recording.prices;
      ctx.broker.liquidatePosition = async () => ({ status: 'indeterminate' as const, reason: 'test: výsledek neznámý' });
      const closing = await ctx.manage('posxcl0110', { action: 'close-position', price: loosened.stopLoss, quantity: 2, entryOperationId: 'entry:scalebase0110', scope: 'position' });
      expect(closing.status).toBe('unknown');
      const cancel = await ctx.manage('pospndc0110', { action: 'cancel-entry', price: recording.prices.addLimit, quantity: 1, entryOperationId: 'entry:scalepnd0110' });
      expect(cancel.status).toBe('blocked');
      expect(cancel.blockers.map(issue => issue.code)).toEqual(['manage-unresolved']);
      expect(cancel.blockers[0].text).toContain('Flattenem');
      expect(ctx.broker.cancelRequestCount(PENDING.entryBrokerOrderId)).toBe(0);
    });

    it('C12 / oponentura C17 (P2): automatické zrušení přikoupení počká, dokud běží změna celé pozice', async () => {
      const ctx = await setup();
      await withPendingAdd(ctx, '0111');
      const { loosened } = recording.prices;
      let liquidateStarted = false;
      let release: (() => void) | undefined;
      ctx.broker.liquidatePosition = async () => {
        liquidateStarted = true;
        await new Promise<void>(resolve => { release = resolve; });
        return { status: 'submitted' as const };
      };
      const closing = ctx.manage('posxcl0111', { action: 'close-position', price: loosened.stopLoss, quantity: 2, entryOperationId: 'entry:scalebase0111', scope: 'position' });
      for (let waited = 0; !liquidateStarted && waited < 2_000; waited += 5) await sleep(5);
      expect(liquidateStarted).toBe(true);
      ctx.controller.disarm('manual');
      ctx.broker.emitEvent({ type: 'heartbeat', at: ctx.clock.now });
      await sleep(1_200);
      expect(ctx.broker.cancelRequestCount(PENDING.entryBrokerOrderId)).toBe(0);
      // Rozpracovaná změna není neznámý výsledek: žádný incident, jen odklad.
      expect(ctx.audits.some(line => line.includes('předchozí změna celé pozice má neznámý výsledek'))).toBe(false);
      release?.();
      await closing;
    });

    it('C12: změna celé pozice s neznámým výsledkem → automatické zrušení přikoupení jen incident (Tradovate / Flatten), nic se neodešle', async () => {
      const ctx = await setup();
      await withPendingAdd(ctx, '0112');
      const { loosened } = recording.prices;
      ctx.broker.liquidatePosition = async () => ({ status: 'indeterminate' as const, reason: 'test: výsledek neznámý' });
      const closing = await ctx.manage('posxcl0112', { action: 'close-position', price: loosened.stopLoss, quantity: 2, entryOperationId: 'entry:scalebase0112', scope: 'position' });
      expect(closing.status).toBe('unknown');
      ctx.controller.disarm('manual');
      ctx.broker.emitEvent({ type: 'heartbeat', at: ctx.clock.now });
      await sleep(1_200);
      await ctx.controller.waitForIdle();
      expect(ctx.broker.cancelRequestCount(PENDING.entryBrokerOrderId)).toBe(0);
      expect(ctx.audits.some(line => line.includes('předchozí změna celé pozice má neznámý výsledek — zruš ho v Tradovate nebo Flattenem'))).toBe(true);
    });

    it('posun SL dál od trhu: rezerva bez otevřeného zisku (P1-1) — realizovaná ztráta se nesmaže', async () => {
      // Limit 900, realizováno −300, otevřeno +400: stará rezerva 900, správná 600; ztráta 2 lístků ke SL 27 930 ≈ 625 $.
      const ctx = await setup({ dailyLossLimitUsd: 900, realizedPnlUsd: -300, openPnlUsd: 400 });
      const base = await twoTickets(ctx, '0107');
      const result = await ctx.manage('posrisk0107', { action: 'move-stop', price: recording.prices.stopLoss, quantity: 2, newPrice: 27_930, entryOperationId: base, scope: 'position' });
      expect(result.blockers.map(issue => issue.code)).toContain('risk-limit');
      expect(ctx.modified).toHaveLength(0);
    });

    it('posun TP k trhu blokovaný; utažení SL nad TP blokované; utažení příliš blízko trhu blokované', async () => {
      const ctx = await setup();
      const base = await twoTickets(ctx, '0105');
      const toward = await ctx.manage('postp00105', { action: 'move-target', price: recording.prices.takeProfit, quantity: 2, newPrice: 28_400, entryOperationId: base, scope: 'position' });
      expect(toward.blockers.map(issue => issue.code)).toContain('toward-market');
      const beyond = await ctx.manage('posbey0105', { action: 'move-stop', price: recording.prices.stopLoss, quantity: 2, newPrice: 28_600, entryOperationId: base, scope: 'position' });
      expect(beyond.blockers.map(issue => issue.code)).toContain('beyond-target');
      const close = await ctx.manage('posclo0105', { action: 'move-stop', price: recording.prices.stopLoss, quantity: 2, newPrice: 28_082, entryOperationId: base, scope: 'position' });
      expect(close.blockers.map(issue => issue.code)).toContain('tighten-too-close');
      expect(ctx.modified).toHaveLength(0);
    });

    it('čekající přikoupení: posun blokovaný, zavření celé pozice projde (liquidate zruší i přikoupení)', async () => {
      const ctx = await setup();
      await withPendingAdd(ctx, '0106');
      const base = 'entry:scalebase0106';
      const { loosened } = recording.prices;
      const move = await ctx.manage('pospnd0106', { action: 'move-stop', price: loosened.stopLoss, quantity: 2, newPrice: 27_920, entryOperationId: base, scope: 'position' });
      expect(move.blockers.map(issue => issue.code)).toContain('scale-in-pending');
      const close = await ctx.manage('posxcl0106', { action: 'close-position', price: loosened.stopLoss, quantity: 2, entryOperationId: base, scope: 'position' });
      expect(close.blockers).toEqual([]);
      expect(ctx.liquidated).toEqual([SYM]);
      await ctx.settle();
      expect(ctx.controller.status().lastError).toBeNull();
    });
  });
});
