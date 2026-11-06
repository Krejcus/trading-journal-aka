// Posun SL/TP nevyplněného vstupu a TP blíž k trhu (5. 11. 2026, `--pending-legs on`, sólo DEMO).
// Skutečný controller; broker se chová podle žurnálu z DEMO: Modify pozastavené nohy broker drží (OnHold).
import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerAccountRiskSnapshot, BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { manualOnlyDemoSafety, type CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import { replacedOrderIncreasesExposure } from '../services/manualScaleIn';
import { buildLeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';
import { buildLeaderEntryPlaceCommand } from '../lib/leaderEntryPlace';
import { buildLeaderOrderManageCommand, validateLeaderOrderManage, type LeaderOrderManageAction } from '../lib/leaderOrderManage';

const LEADER = 100;
const SYMBOL = 'MNQZ6';
const START = Date.UTC(2026, 10, 5, 15, 0, 0);
const ENTRY = 29_500;
const SL = 29_480;
const TP = 29_560;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const group = (): CopyGroupConfig => ({
  id: 'manual-demo', name: 'Ruční DEMO', enabled: true, leaderAccountId: LEADER, followers: [],
  localOnly: true, manualOnly: true, manualEntryMaxContracts: 5, safety: { ...manualOnlyDemoSafety(), dailyLossLimitUsd: 5_000 },
});

let active: CopierRuntimeController | null = null;
afterEach(() => { active?.stop(); active = null; });

async function setup(options: { on?: boolean; quantity?: number; noQuote?: boolean; bid?: number } = {}) {
  const clock = { now: START };
  const noQuote = { value: false };
  const riskRow = { accountId: LEADER, realizedPnlUsd: 0, openPnlUsd: 0, netLiq: 50_000, minNetLiq: null, dailyLossAutoLiq: null, trailingMaxDrawdown: null } as unknown as BrokerAccountRiskSnapshot;
  Object.defineProperty(riskRow, 'at', { get: () => clock.now, enumerable: true });
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [riskRow] });
  let gateFn: (accountId: number) => boolean = () => false;
  const audits: string[] = [];
  const memory = createMemoryCopierStore();
  const onCommit: { fn: (() => void) | null } = { fn: null };
  const store = { load: () => memory.load(), commit: async (...args: Parameters<typeof memory.commit>) => {
    const saved = await memory.commit(...args);
    onCommit.fn?.();
    await sleep(5);
    return saved;
  } };
  const controller = await bootstrapCopierRuntime({
    broker, store, group: group(), clock: () => clock.now, osoCorrelationWindowMs: 50,
    connectionRenewalClock: () => clock.now,
    manualPendingLegs: options.on ?? true,
    bindPendingLegsGate: gate => { gateFn = gate; },
    manualEntryQuote: () => ({ contract: SYMBOL, last: options.bid ?? 29_510, lastAt: clock.now - (noQuote.value ? 60_000 : 100), bid: options.bid ?? 29_510, ask: (options.bid ?? 29_510) + 0.25,
      quoteAt: clock.now - (noQuote.value ? 60_000 : 50) }),
    manualEntryTimingsMs: { post: 500, start: 500, legWait: 300, manage: 500, settle: 50, verify: 100, heldConfirm: 50 },
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
  const status = controller.status();
  const preview = buildLeaderEntryPreviewCommand(
    { symbol: SYMBOL, side: 'Buy', quantity: options.quantity ?? 1, orderType: 'Limit', price: ENTRY, stopLoss: SL, takeProfit: TP },
    { group: { ...group(), leaderAccountId: LEADER }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: 'preview:pendinglegs01' } as never,
  );
  const placed = await controller.placeLeaderEntry(buildLeaderEntryPlaceCommand(preview, 'entry:pendinglegs01'), { deadlineAt: clock.now + 15_000 });
  expect(placed.status).toBe('acknowledged');
  await sleep(30);
  await controller.waitForIdle();
  // Nohy čekajícího vstupu jsou u brokera pozastavené.
  const legs = broker.orders().filter(order => order.accountId === LEADER && order.side === 'Sell');
  for (const order of legs) {
    order.status = 'pending';
    broker.emitEvent({ type: 'order', order: { ...order } });
  }
  await sleep(20);
  await controller.waitForIdle();
  // Modify pozastavené nohy: broker ho drží, adaptér potvrdí `stream-held`.
  const modified: Array<{ id: string; stopPrice?: number; limitPrice?: number; quantity: number }> = [];
  broker.modifyOrder = async (_accountId, id, changes) => {
    modified.push({ id, quantity: changes.quantity, stopPrice: changes.stopPrice, limitPrice: changes.limitPrice });
    const order = broker.orders().find(item => item.brokerOrderId === id)!;
    Object.assign(order, changes.stopPrice != null ? { stopPrice: changes.stopPrice } : { limitPrice: changes.limitPrice });
    broker.emitEvent({ type: 'order', order: { ...order } });
    return { confirmedBy: order.status === 'pending' ? 'stream-held' as const : 'stream-replaced' as const, order: { ...order } };
  };
  return { broker, controller, clock, audits, modified, noQuote, onCommit, gate: () => gateFn };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const manage = (ctx: Ctx, action: LeaderOrderManageAction, expectPrice: number, newPrice: number | undefined, id: string, quantity = 1) => {
  const command = buildLeaderOrderManageCommand({
    groupId: 'manual-demo', operationId: id, leaderAccountId: LEADER, entryOperationId: 'entry:pendinglegs01', symbol: SYMBOL,
    action, expect: { price: expectPrice, quantity }, ...(newPrice != null ? { newPrice } : {}),
  });
  return ctx.controller.manageLeaderOrder(validateLeaderOrderManage(command), { deadlineAt: ctx.clock.now + 15_000 });
};
const codes = (result: { blockers: Array<{ code: string }> }) => result.blockers.map(issue => issue.code);
const leg = (broker: MockBroker, type: BrokerOrder['orderType']) => broker.orders().find(order => order.accountId === LEADER && order.side === 'Sell' && order.orderType === type)!;
const fillEntry = async (ctx: Ctx) => {
  const entry = ctx.broker.orders().find(order => order.accountId === LEADER && order.side === 'Buy')!;
  entry.status = 'filled';
  entry.filledQuantity = entry.quantity;
  ctx.broker.setPosition(LEADER, SYMBOL, entry.quantity);
  ctx.broker.emitEvent({ type: 'order', order: { ...entry } });
  ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `fill-${entry.brokerOrderId}`, tag: entry.tag, brokerOrderId: entry.brokerOrderId, accountId: LEADER, symbol: SYMBOL, side: 'Buy', quantity: entry.quantity, price: ENTRY, filledAt: 2 } });
  ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYMBOL, netQuantity: entry.quantity } });
  await sleep(30);
  await ctx.controller.waitForIdle();
};

describe('posun nohou nevyplněného vstupu', () => {
  it('bez flagu zůstává dnešní blok; brána adaptéru je vypnutá', async () => {
    const ctx = await setup({ on: false });
    expect(codes(await manage(ctx, 'move-stop', SL, 29_470, 'manage:pendoff0001'))).toContain('shape');
    expect(ctx.modified).toEqual([]);
    expect(ctx.gate()(LEADER)).toBe(false);
    expect(ctx.controller.manualPendingLegsEnabled?.()).toBe(false);
  });

  it('SL i TP se posunou, potvrzení je držené a brána platí jen pro leadera', async () => {
    const ctx = await setup();
    expect(ctx.gate()(LEADER)).toBe(true);
    expect(ctx.gate()(999)).toBe(false);
    expect((await manage(ctx, 'move-stop', SL, 29_470, 'manage:pendstop001')).status).toBe('acknowledged');
    expect((await manage(ctx, 'move-target', TP, 29_540, 'manage:pendtgt0001')).status).toBe('acknowledged');
    expect(ctx.modified).toMatchObject([{ stopPrice: 29_470, quantity: 1 }, { limitPrice: 29_540, quantity: 1 }]);
    expect(ctx.controller.status().manualOrderActions?.[0]).toMatchObject({ status: 'acknowledged' });
  });

  it('strana vůči vstupu a jiná cena, než uživatel viděl, se blokují', async () => {
    const ctx = await setup();
    expect(codes(await manage(ctx, 'move-stop', SL, 29_499.5, 'manage:pendside01'))).toContain('leg-side');
    expect(codes(await manage(ctx, 'move-target', TP, 29_500.5, 'manage:pendside02'))).toContain('leg-side');
    expect(codes(await manage(ctx, 'move-stop', SL + 1, 29_470, 'manage:pendexpect1'))).toContain('order-changed');
    expect(ctx.modified).toEqual([]);
  });

  it('víc kontraktů: projde a Modify nese počet nohy', async () => {
    const big = await setup({ quantity: 3 });
    expect((await manage(big, 'move-stop', SL, 29_470, 'manage:pendqty0001', 3)).status).toBe('acknowledged');
    expect(big.modified).toMatchObject([{ stopPrice: 29_470, quantity: 3 }]);
  });

  it('fill během ukládání záznamu: nic neodejde (částečný fill by jinak vrátil plný počet na nohu)', async () => {
    const ctx = await setup();
    const entry = ctx.broker.orders().find(order => order.accountId === LEADER && order.side === 'Buy')!;
    // Fill dorazí přesně v okamžiku durable zápisu záznamu `sending`.
    ctx.onCommit.fn = () => {
      ctx.onCommit.fn = null;
      entry.filledQuantity = 1;
      ctx.broker.emitEvent({ type: 'order', order: { ...entry } });
    };
    const result = await manage(ctx, 'move-stop', SL, 29_470, 'manage:pendrace001');
    expect(result.status).toBe('blocked');
    expect(ctx.modified).toEqual([]);
  });

  it('× vstupu projde i přes nedořešený posun jeho nohy', async () => {
    const ctx = await setup();
    ctx.broker.modifyOrder = async () => { throw new Error('síť'); };
    expect((await manage(ctx, 'move-stop', SL, 29_470, 'manage:pendunk0001')).status).toBe('unknown');
    expect(codes(await manage(ctx, 'move-target', TP, 29_540, 'manage:pendunk0002'))).toContain('manage-unresolved');
    const cancel = await manage(ctx, 'cancel-entry', ENTRY, undefined, 'manage:pendunk0003');
    expect(codes(cancel)).not.toContain('manage-unresolved');
  });

  it('aktivace bez potvrzení drženého Modify: po limitu incident bez zavírání', async () => {
    const ctx = await setup();
    await manage(ctx, 'move-stop', SL, 29_470, 'manage:pendconf001');
    const stop = leg(ctx.broker, 'Stop');
    stop.status = 'working';
    ctx.broker.emitEvent({ type: 'order', order: { ...stop, heldPriceUnconfirmed: true } });
    await sleep(120);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().lastError ?? '').toMatch(/nemá od brokera potvrzenou cenu/);
  });

  it('jiná cena v pending se hned nesmaže: po aktivaci je to incident', async () => {
    const ctx = await setup();
    await manage(ctx, 'move-stop', SL, 29_470, 'manage:pendext0001');
    const stop = leg(ctx.broker, 'Stop');
    stop.stopPrice = 29_460;
    ctx.broker.emitEvent({ type: 'order', order: { ...stop } });
    await sleep(20);
    stop.status = 'working';
    ctx.broker.emitEvent({ type: 'order', order: { ...stop } });
    await sleep(20);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().lastError ?? '').toMatch(/po fillu pracuje/);
  });

  it('po fillu s držanou cenou je vše v pořádku; jiná cena = incident bez zavírání', async () => {
    const ok = await setup();
    await manage(ok, 'move-stop', SL, 29_470, 'manage:pendfill001');
    await fillEntry(ok);
    const stop = leg(ok.broker, 'Stop');
    stop.status = 'working';
    ok.broker.emitEvent({ type: 'order', order: { ...stop } });
    await sleep(20);
    await ok.controller.waitForIdle();
    expect(ok.controller.status().lastError ?? null).toBeNull();
    ok.controller.stop();

    const bad = await setup();
    await manage(bad, 'move-stop', SL, 29_470, 'manage:pendfill002');
    await fillEntry(bad);
    const wrong = leg(bad.broker, 'Stop');
    wrong.status = 'working';
    wrong.stopPrice = SL;
    bad.broker.emitEvent({ type: 'order', order: { ...wrong } });
    await sleep(20);
    await bad.controller.waitForIdle();
    expect(bad.controller.status().lastError ?? '').toMatch(/po fillu pracuje/);
    expect(bad.broker.orders().filter(order => order.side === 'Sell' && order.orderType === 'Market')).toEqual([]);
  });
});

describe('TP blíž k trhu u otevřené pozice', () => {
  const open = async (options: Parameters<typeof setup>[0] = {}) => {
    const ctx = await setup(options);
    await fillEntry(ctx);
    for (const type of ['Stop', 'Limit'] as const) {
      const order = leg(ctx.broker, type);
      order.status = 'working';
      ctx.broker.emitEvent({ type: 'order', order: { ...order } });
    }
    await sleep(20);
    await ctx.controller.waitForIdle();
    return ctx;
  };

  it('s čerstvou kotací a odstupem projde', async () => {
    const ctx = await open();
    expect((await manage(ctx, 'move-target', TP, 29_540, 'manage:tpclose001')).status).toBe('acknowledged');
    expect(ctx.modified).toMatchObject([{ limitPrice: 29_540 }]);
  });

  it('blíž než 8 ticků od trhu, bez kotace i bez flagu se blokuje', async () => {
    const near = await open();
    expect(codes(await manage(near, 'move-target', TP, 29_511, 'manage:tpclose002'))).toContain('target-too-close');
    expect(near.modified).toEqual([]);
    const off = await open({ on: false });
    expect(codes(await manage(off, 'move-target', TP, 29_540, 'manage:tpclose003'))).toContain('toward-market');
    const stale = await open();
    stale.noQuote.value = true;
    expect(codes(await manage(stale, 'move-target', TP, 29_540, 'manage:tpclose004'))).toContain('target-no-quote');
    expect(stale.modified).toEqual([]);
  });
});

describe('klasifikace replaced vlastní nohy', () => {
  const base = { nextPotential: 1, previousPotential: 0, hadPrevious: false, quantity: 1, ownLegQuantity: 1 };
  it('po restartu bez paměti záměrů: vlastní noha v původním počtu nezvyšuje', () => {
    expect(replacedOrderIncreasesExposure(base)).toBe(false);
  });
  it('vyšší qty vlastní nohy, známý záměr i cizí příkaz zůstávají navýšením', () => {
    expect(replacedOrderIncreasesExposure({ ...base, quantity: 3, nextPotential: 2 })).toBe(true);
    expect(replacedOrderIncreasesExposure({ ...base, hadPrevious: true })).toBe(true);
    expect(replacedOrderIncreasesExposure({ ...base, ownLegQuantity: null })).toBe(true);
  });
});


describe('posun vlastního čekajícího limitu', () => {
  it('mění jen cenu původního vstupu, zachová id, množství a ochranné nohy; replay nezapisuje podruhé', async () => {
    const ctx = await setup();
    const entry = ctx.broker.orders().find(o => o.side === 'Buy')!;
    const before = ctx.broker.orders().map(o => ({ ...o }));
    const result = await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:limitmove01');
    expect(result.status).toBe('acknowledged');
    expect(ctx.modified).toEqual([{ id: entry.brokerOrderId, quantity: 1, limitPrice: ENTRY - 1, stopPrice: undefined }]);
    expect(ctx.broker.orders().filter(o => o.side === 'Sell')).toEqual(before.filter(o => o.side === 'Sell'));
    expect((await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:limitmove01')).status).toBe('acknowledged');
    expect(ctx.modified).toHaveLength(1);
  });
  it('bez instalačního opt-inu neodešle nic', async () => {
    const ctx = await setup({ on: false });
    expect(codes(await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:limitoff001'))).toContain('unsupported');
    expect(ctx.modified).toEqual([]);
  });
  it('neodešle změnu proti staré ceně', async () => {
    const ctx = await setup();
    expect(codes(await manage(ctx, 'move-limit', ENTRY - 1, ENTRY - 2, 'manage:limitstale1'))).toContain('order-changed');
    expect(ctx.modified).toEqual([]);
  });
  it('bez čerstvé kotace neodešle nic', async () => {
    const ctx = await setup(); ctx.noQuote.value = true;
    expect(codes(await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:limitquote1'))).toContain('limit-too-close');
    expect(ctx.modified).toEqual([]);
  });
  it('neposune limit přes trh ani přes ochranný SL', async () => {
    const ctx = await setup();
    expect(codes(await manage(ctx, 'move-limit', ENTRY, 29510, 'manage:limitcross1'))).toContain('limit-too-close');
    expect(codes(await manage(ctx, 'move-limit', ENTRY, SL, 'manage:limitcross2'))).toContain('leg-side');
    expect(ctx.modified).toEqual([]);
  });
  it('fill během ukládání záměru zastaví zápis', async () => {
    const ctx = await setup();
    ctx.onCommit.fn = () => {
      ctx.onCommit.fn = null;
      const entry = ctx.broker.orders().find(o => o.side === 'Buy')!;
      entry.status = 'filled'; entry.filledQuantity = 1;
      ctx.broker.emitEvent({ type: 'order', order: { ...entry } });
      ctx.broker.setPosition(LEADER, SYMBOL, 1);
      ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYMBOL, netQuantity: 1 } });
    };
    expect((await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:limitrace01')).status).toBe('blocked');
    expect(ctx.modified).toEqual([]);
  });
});


describe('posun limitu: změna pojistek při ukládání', () => {
  it.each(['off', 'stale-quote', 'changed-stop'])('%s nepustí změnu po uložení sending', async change => {
    const ctx = await setup();
    ctx.onCommit.fn = () => {
      ctx.onCommit.fn = null;
      if (change === 'off') ctx.controller.disarm();
      else if (change === 'stale-quote') ctx.noQuote.value = true;
      else {
        const stop = leg(ctx.broker, 'Stop'); stop.stopPrice = ENTRY - 0.25;
        ctx.broker.emitEvent({ type: 'order', order: { ...stop } });
      }
    };
    const result = await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, `manage:limitguard${change.replaceAll('-', '')}`);
    expect(result.status).toBe('blocked');
    expect(ctx.modified).toEqual([]);
  });
  it('neshodné množství neposune', async () => {
    const ctx = await setup();
    expect(codes(await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:limitqty001', 2))).toContain('order-changed');
    expect(ctx.modified).toEqual([]);
  });
});
