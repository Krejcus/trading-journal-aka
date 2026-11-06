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
import { buildLeaderOrderManageCommand, LEADER_ORDER_MOVE_LIMIT_CONTRACT, moveLimitLegsVerdict, moveLimitRiskEntry, validateLeaderOrderManage, type LeaderOrderManageAction } from '../lib/leaderOrderManage';

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
  const bootOptions = {
    broker, store, group: group(), clock: () => clock.now, osoCorrelationWindowMs: 50,
    connectionRenewalClock: () => clock.now,
    manualPendingLegs: options.on ?? true,
    bindPendingLegsGate: gate => { gateFn = gate; },
    manualEntryQuote: () => ({ contract: SYMBOL, last: options.bid ?? 29_510, lastAt: clock.now - (noQuote.value ? 60_000 : 100), bid: options.bid ?? 29_510, ask: (options.bid ?? 29_510) + 0.25,
      quoteAt: clock.now - (noQuote.value ? 60_000 : 50) }),
    manualEntryTimingsMs: { post: 500, start: 500, legWait: 300, manage: 500, settle: 50, verify: 100, heldConfirm: 50 },
    onAudit: (entries: Array<{ kind: string; reason?: string }>) => { for (const entry of entries) audits.push(`${entry.kind}:${entry.reason ?? ''}`); },
  } as unknown as Parameters<typeof bootstrapCopierRuntime>[0];
  const controller = await bootstrapCopierRuntime(bootOptions);
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
  // Broker při Modify vstupu v OSO posune obě pozastavené nohy o stejnou hodnotu (žurnál DEMO 6. 11. 2026).
  const cascade = { value: 'both' as 'both' | 'none' | 'stop-only' };
  broker.modifyOrder = async (_accountId, id, changes) => {
    modified.push({ id, quantity: changes.quantity, stopPrice: changes.stopPrice, limitPrice: changes.limitPrice });
    const order = broker.orders().find(item => item.brokerOrderId === id)!;
    if (order.side === 'Buy' && changes.limitPrice != null && order.limitPrice != null) {
      const delta = changes.limitPrice - order.limitPrice;
      const legs = broker.orders().filter(item => item.accountId === LEADER && item.side === 'Sell' && item.status === 'pending');
      for (const item of legs) {
        if (cascade.value === 'none' || (cascade.value === 'stop-only' && item.orderType !== 'Stop')) continue;
        if (item.orderType === 'Stop') item.stopPrice = item.stopPrice! + delta; else item.limitPrice = item.limitPrice! + delta;
        broker.emitEvent({ type: 'order', order: { ...item } });
      }
    }
    Object.assign(order, changes.stopPrice != null ? { stopPrice: changes.stopPrice } : { limitPrice: changes.limitPrice });
    broker.emitEvent({ type: 'order', order: { ...order } });
    return { confirmedBy: order.status === 'pending' ? 'stream-held' as const : 'stream-replaced' as const, order: { ...order } };
  };
  return { broker, controller, clock, audits, modified, noQuote, onCommit, cascade, bootOptions, gate: () => gateFn };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const manage = (ctx: Ctx, action: LeaderOrderManageAction, expectPrice: number, newPrice: number | undefined, id: string, quantity = 1) => {
  const command = buildLeaderOrderManageCommand({
    groupId: 'manual-demo', operationId: id, leaderAccountId: LEADER, entryOperationId: 'entry:pendinglegs01', symbol: SYMBOL,
    action, expect: { price: expectPrice, quantity }, ...(newPrice != null ? { newPrice } : {}),
    ...(action === 'move-limit' ? { moveLimitContract: LEADER_ORDER_MOVE_LIMIT_CONTRACT } : {}),
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
  it('pošle jeden Modify původního vstupu; nohy posune broker a worker to ověří; replay nezapisuje podruhé', async () => {
    const ctx = await setup();
    const entry = ctx.broker.orders().find(o => o.side === 'Buy')!;
    const result = await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:limitmove01');
    expect(result.status).toBe('acknowledged');
    expect(ctx.modified).toEqual([{ id: entry.brokerOrderId, quantity: 1, limitPrice: ENTRY - 1, stopPrice: undefined }]);
    expect(leg(ctx.broker, 'Stop').stopPrice).toBe(SL - 1);
    expect(leg(ctx.broker, 'Limit').limitPrice).toBe(TP - 1);
    await legCheckDone(ctx);
    expect(ctx.controller.status().lastError).toBeNull();
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


/** Doběhne kontrola nohou po ustálení (settle 50 ms v testu). */
const legCheckDone = async (ctx: Ctx) => {
  ctx.clock.now += 1_000;
  await sleep(220);
  await ctx.controller.waitForIdle();
};
const actionOf = (ctx: Ctx, id: string) => ctx.controller.status().manualOrderActions?.find(action => action.operationId === id);

describe('posun limitu: model rizika a nohou', () => {
  it('ztráta se počítá s horší variantou |vstup − SL| + |posun|', () => {
    expect(moveLimitRiskEntry('long', 27_000, 26_990, 26_980)).toBe(27_010);
    expect(moveLimitRiskEntry('long', 27_000, 27_010, 26_980)).toBe(27_010);
    expect(moveLimitRiskEntry('short', 27_000, 27_010, 27_020)).toBe(26_990);
  });
  it('rozliší posunuté, nezměněné a nesouměrné nohy', () => {
    const base = { stopFrom: 26_988, targetFrom: 27_024, delta: 2.25 };
    expect(moveLimitLegsVerdict({ ...base, stopPrice: 26_990.25, targetPrice: 27_026.25 })).toBe('shifted');
    expect(moveLimitLegsVerdict({ ...base, stopPrice: 26_988, targetPrice: 27_024 })).toBe('unchanged');
    expect(moveLimitLegsVerdict({ ...base, stopPrice: 26_990.25, targetPrice: 27_024 })).toBe('mismatch');
    expect(moveLimitLegsVerdict({ ...base, stopPrice: null, targetPrice: 27_024 })).toBe('mismatch');
  });
  it('příkaz bez kontraktu v2 neprojde validací (starý iPhone), jiná akce ho mít nesmí', () => {
    const fields = { groupId: 'g', operationId: 'manage:contract001', leaderAccountId: LEADER, entryOperationId: 'entry:contract0001', symbol: SYMBOL, expect: { price: ENTRY, quantity: 1 }, newPrice: ENTRY - 1 };
    expect(() => validateLeaderOrderManage(buildLeaderOrderManageCommand({ ...fields, action: 'move-limit' }))).toThrow('invalid-relay-command-payload');
    expect(() => validateLeaderOrderManage(buildLeaderOrderManageCommand({ ...fields, action: 'move-stop', moveLimitContract: LEADER_ORDER_MOVE_LIMIT_CONTRACT }))).toThrow('invalid-relay-command-payload');
    expect(validateLeaderOrderManage(buildLeaderOrderManageCommand({ ...fields, action: 'move-limit', moveLimitContract: LEADER_ORDER_MOVE_LIMIT_CONTRACT })).action).toBe('move-limit');
  });
});

describe('posun limitu: kontrola nohou', () => {
  it.each(['none', 'stop-only'] as const)('potvrzený posun s nohami %s je po ustálení incident, ne obchod', async cascade => {
    const ctx = await setup(); ctx.cascade.value = cascade;
    expect((await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:legsbad0001')).status).toBe('acknowledged');
    await legCheckDone(ctx);
    expect(ctx.controller.status().lastError).toMatch(/posun limitu/);
    expect(ctx.modified).toHaveLength(1);
  });
  it('po fillu kontroluje cenu nohy i bez ručního posunu nohy', async () => {
    const ctx = await setup();
    await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:legsfill001');
    await legCheckDone(ctx);
    expect(ctx.controller.status().lastError).toBeNull();
    await fillEntry(ctx);
    const stop = leg(ctx.broker, 'Stop');
    stop.status = 'working'; stop.stopPrice = SL;
    ctx.broker.emitEvent({ type: 'order', order: { ...stop } });
    await sleep(20); await ctx.controller.waitForIdle();
    expect(ctx.controller.status().lastError).toMatch(/po fillu pracuje/);
  });
  it('správná cena po fillu incident nedělá a ruční posun nohy po posunu limitu má přednost', async () => {
    const ctx = await setup();
    await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:legsokay001');
    await legCheckDone(ctx);
    expect((await manage(ctx, 'move-stop', SL - 1, SL - 2, 'manage:legsokay002')).status).toBe('acknowledged');
    await fillEntry(ctx);
    for (const item of [leg(ctx.broker, 'Stop'), leg(ctx.broker, 'Limit')]) {
      item.status = 'working';
      ctx.broker.emitEvent({ type: 'order', order: { ...item } });
    }
    await sleep(20); await ctx.controller.waitForIdle();
    expect(ctx.controller.status().lastError).toBeNull();
  });
  it('ručně posunutá noha posun limitu zablokuje', async () => {
    const ctx = await setup();
    expect((await manage(ctx, 'move-stop', SL, SL - 1, 'manage:legsheld001')).status).toBe('acknowledged');
    expect(codes(await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:legsheld002'))).toContain('move-limit-legs');
    expect(ctx.modified).toHaveLength(1);
  });
  it('víc kontraktů worker odmítne', async () => {
    const ctx = await setup({ quantity: 2 });
    expect(codes(await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:legsqty0001', 2))).toContain('move-limit-quantity');
    expect(ctx.modified).toEqual([]);
  });
  it('restart v čekající kontrole ji zopakuje z durable značky', async () => {
    const ctx = await setup(); ctx.cascade.value = 'none';
    await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:legsrest001');
    ctx.controller.stop();
    const again = await bootstrapCopierRuntime(ctx.bootOptions);
    active = again;
    await again.waitForIdle();
    ctx.clock.now += 1_000;
    await sleep(220);
    await again.waitForIdle();
    expect(again.status().manualOrderActions?.find(action => action.operationId === 'manage:legsrest001')?.status).toBe('acknowledged');
    expect(again.status().lastError).toMatch(/posun limitu/);
    expect(ctx.modified).toHaveLength(1);
  });
});

describe('posun limitu: známý konec není trvalé unknown', () => {
  const failingWrite = (ctx: Ctx, before: () => void) => { ctx.broker.modifyOrder = async () => { before(); throw new Error('Tradovate order modify not confirmed'); }; };
  it('fill během zápisu skončí waived a správa pozice není zablokovaná', async () => {
    const ctx = await setup();
    failingWrite(ctx, () => {
      const entry = ctx.broker.orders().find(o => o.side === 'Buy')!;
      entry.status = 'filled'; entry.filledQuantity = 1;
    });
    const result = await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:racefill001');
    await sleep(20); await ctx.controller.waitForIdle();
    expect(result.reason ?? '').toMatch(/vyplnil/);
    expect(actionOf(ctx, 'manage:racefill001')?.status).toBe('waived');
    expect(ctx.controller.status().manualOrderActions?.some(action => action.status === 'unknown' || action.status === 'sending')).toBe(false);
  });
  it('vstup zrušený jinde skončí waived', async () => {
    const ctx = await setup();
    failingWrite(ctx, () => { ctx.broker.orders().find(o => o.side === 'Buy')!.status = 'canceled'; });
    const result = await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:racecanc001');
    expect(result.reason ?? '').toMatch(/skončil/);
    expect(actionOf(ctx, 'manage:racecanc001')?.status).toBe('waived');
  });
  it('třetí cena po ustálení skončí waived, nic se neopakuje', async () => {
    const ctx = await setup();
    failingWrite(ctx, () => { ctx.broker.orders().find(o => o.side === 'Buy')!.limitPrice = ENTRY - 3; });
    await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:racethrd001');
    expect(actionOf(ctx, 'manage:racethrd001')?.status).toBe('unknown');
    await legCheckDone(ctx);
    expect(actionOf(ctx, 'manage:racethrd001')?.status).toBe('waived');
  });
  it('nejistý posun neblokuje zrušení vstupu', async () => {
    const ctx = await setup();
    failingWrite(ctx, () => { ctx.broker.orders().find(o => o.side === 'Buy')!.limitPrice = ENTRY - 3; });
    await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:raceunkn001');
    expect(actionOf(ctx, 'manage:raceunkn001')?.status).toBe('unknown');
    const canceled = await manage(ctx, 'cancel-entry', ENTRY - 3, undefined, 'manage:raceunkn002');
    expect(codes(canceled)).not.toContain('manage-unresolved');
  });
});

describe('posun limitu: dva posuny a pořadí kontrol', () => {
  const secondMoveFills = (ctx: Ctx, delta: number) => {
    ctx.broker.modifyOrder = async () => {
      const entry = ctx.broker.orders().find(o => o.side === 'Buy')!;
      leg(ctx.broker, 'Stop').stopPrice! += delta;
      leg(ctx.broker, 'Limit').limitPrice! += delta;
      entry.limitPrice = entry.limitPrice! + delta;
      entry.status = 'filled'; entry.filledQuantity = 1;
      throw new Error('Tradovate order modify not confirmed');
    };
  };
  const activate = async (ctx: Ctx) => {
    ctx.broker.setPosition(LEADER, SYMBOL, 1);
    for (const item of [leg(ctx.broker, 'Stop'), leg(ctx.broker, 'Limit')]) {
      item.status = 'working';
      ctx.broker.emitEvent({ type: 'order', order: { ...item } });
    }
    await sleep(20); await ctx.controller.waitForIdle();
  };
  it('správná cena po dvou posunech a fillu během druhého incident nedělá', async () => {
    const ctx = await setup();
    await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:twomoves001');
    await legCheckDone(ctx);
    secondMoveFills(ctx, -1);
    const second = await manage(ctx, 'move-limit', ENTRY - 1, ENTRY - 2, 'manage:twomoves002');
    expect(second.reason ?? '').toMatch(/vyplnil/);
    await activate(ctx);
    expect(ctx.controller.status().lastError).toBeNull();
    await legCheckDone(ctx);
    expect(ctx.controller.status().lastError).toBeNull();
  });
  it('špatná cena po dvou posunech incident udělá, jakmile druhá kontrola doběhne', async () => {
    const ctx = await setup();
    await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:twomoves003');
    await legCheckDone(ctx);
    secondMoveFills(ctx, -1);
    await manage(ctx, 'move-limit', ENTRY - 1, ENTRY - 2, 'manage:twomoves004');
    await legCheckDone(ctx);
    leg(ctx.broker, 'Stop').stopPrice = SL;
    await activate(ctx);
    expect(ctx.controller.status().lastError).toMatch(/po fillu pracuje/);
  });
  it('během čekající kontroly nejde posunout nevyplněnou nohu', async () => {
    const ctx = await setup(); ctx.cascade.value = 'none';
    await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:pendleg0001');
    expect(codes(await manage(ctx, 'move-stop', SL, SL - 1, 'manage:pendleg0002'))).toContain('move-limit-legs');
    expect(ctx.modified).toHaveLength(1);
  });
});

describe('posun limitu: ruční vyřešení', () => {
  it('neprojde, dokud zápis k brokerovi běží; potom ano a nic se neposílá', async () => {
    const ctx = await setup();
    let release!: () => void;
    ctx.broker.modifyOrder = () => new Promise((_resolve, reject) => { release = () => reject(new Error('Tradovate order modify not confirmed')); });
    await manage(ctx, 'move-limit', ENTRY, ENTRY - 1, 'manage:waivebusy01');
    expect(actionOf(ctx, 'manage:waivebusy01')?.status).toBe('unknown');
    await expect(ctx.controller.waiveManualEntry({ operationId: 'manage:waivebusy01', reason: 'ověřeno v Tradovate' })).rejects.toThrow(/ještě běží/);
    release();
    await sleep(30); await ctx.controller.waitForIdle();
    const after = actionOf(ctx, 'manage:waivebusy01');
    if (after?.status === 'unknown') await ctx.controller.waiveManualEntry({ operationId: 'manage:waivebusy01', reason: 'ověřeno v Tradovate' });
    expect(actionOf(ctx, 'manage:waivebusy01')?.status).not.toBe('unknown');
  });
});
