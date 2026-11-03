// C8 (3. 11. 2026, docs/reviews/trading-gaps-designs/safety.md): × zavřít holý Market bez SL/TP
// přes skutečný controller v sólo skupině (manual-only local-only DEMO bez followerů) + čisté helpery.
import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerAccountRiskSnapshot, BrokerLiquidateRequest, BrokerLiquidateResult, BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore, type CopierStore } from '../services/copierStore';
import type { CopierManualEntryRecord } from '../services/copierEngine';
import { manualOnlyDemoSafety, type CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import { buildLeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';
import { buildLeaderEntryPlaceCommand } from '../lib/leaderEntryPlace';
import { buildLeaderOrderManageCommand, validateLeaderOrderManage } from '../lib/leaderOrderManage';
import {
  bareCloseLotBlockers,
  bareCloseManageFields,
  bareClosePreWriteBlocker,
  bareCloseRecordBlockers,
  bareCloseShapeBlockers,
  bareCloseSuperseded,
  selectBareLeaderTrade,
  soloManualGroup,
  type BareCloseEntryRecord,
} from '../lib/manualBareClose';
import { COPIER_MANUAL_ORDER_CLOSE_BARE_CAPABILITY, supportsCopierManualOrderCloseBare } from '../lib/copierWorkerCapabilities';

const LEADER = 61038658;
const SYM = 'MNQZ6';
const START = Date.UTC(2026, 10, 3, 2, 0, 0);
const REF = 25_000;
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

async function setup(options: {
  patchBroker?: (broker: MockBroker) => void;
  store?: CopierStore;
  onController?: (controller: CopierRuntimeController) => void;
  settleMs?: number;
  broker?: MockBroker;
  arm?: boolean;
} = {}) {
  const clock = { now: START };
  const broker = options.broker ?? createMockBroker({ behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [risk(START + 500)], nativeLiquidate: true });
  options.patchBroker?.(broker);
  const audits: string[] = [];
  const store = options.store ?? createMemoryCopierStore();
  const controller = await bootstrapCopierRuntime({
    broker, store, group: group(), clock: () => clock.now, osoCorrelationWindowMs: 50,
    manualEntryTimingsMs: { post: 300, start: 500, legWait: 300, manage: 500, settle: options.settleMs ?? 50, verify: 100 },
    manualEntryQuote: () => ({ contract: SYM, last: REF, lastAt: clock.now - 100, bid: REF - 0.25, ask: REF, quoteAt: clock.now - 50 }),
    onAudit: entries => { for (const entry of entries) audits.push(`${entry.kind}:${entry.reason ?? ''}`); },
  });
  active = controller;
  options.onController?.(controller);
  broker.setConnected(true);
  await controller.waitForIdle();
  if (options.arm !== false) {
    await controller.reconcile();
    controller.arm();
    await controller.waitForIdle();
  }
  clock.now = START + 1_000;
  await sleep(20);
  await controller.waitForIdle();
  return { broker, controller, audits, clock, store };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

/** Holý Market (bez SL/TP) z telefonní lišty, vyplněný na celé qty. */
async function openBare(ctx: Ctx, quantity = 2, id = 'barec001') {
  const status = ctx.controller.status();
  const preview = buildLeaderEntryPreviewCommand(
    { symbol: SYM, side: 'Buy', quantity, orderType: 'Market', referencePrice: REF, quoteReceivedAt: ctx.clock.now - 300 },
    { group: { ...group(), leaderAccountId: LEADER }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: `preview:${id}` },
  );
  const placed = await ctx.controller.placeLeaderEntry(buildLeaderEntryPlaceCommand(preview, `entry:${id}`), { deadlineAt: ctx.clock.now + 15_000 });
  expect(placed).toMatchObject({ status: 'acknowledged' });
  const entry = ctx.broker.orders().find(order => order.brokerOrderId === placed.entryBrokerOrderId)!;
  entry.status = 'filled';
  entry.filledQuantity = quantity;
  ctx.broker.emitEvent({ type: 'order', order: { ...entry, sourceVersion: '2:Filled' } });
  // Čas fillu v aktuální session: lot deníku dne s fillem vstupu je podmínka × (obrat přes nulu, oponentura C8).
  ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `f-${entry.brokerOrderId}`, tag: entry.tag, brokerOrderId: entry.brokerOrderId, accountId: LEADER, symbol: SYM, side: 'Buy', quantity, price: REF + 0.25, filledAt: ctx.clock.now } });
  ctx.broker.setPosition(LEADER, SYM, quantity);
  ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: quantity } });
  await sleep(30);
  await ctx.controller.waitForIdle();
  return { entryOperationId: `entry:${id}`, entryBrokerOrderId: placed.entryBrokerOrderId! };
}

const closeBare = (ctx: Ctx, opts: { id?: string; entryOperationId?: string; quantity?: number; price?: number } = {}) => {
  const command = buildLeaderOrderManageCommand({
    groupId: group().id, operationId: opts.id ?? 'manage:bareclose01', leaderAccountId: LEADER,
    entryOperationId: opts.entryOperationId ?? 'entry:barec001', symbol: SYM, action: 'close-position',
    expect: { price: opts.price ?? REF, quantity: opts.quantity ?? 2 },
  });
  return ctx.controller.manageLeaderOrder(validateLeaderOrderManage(command), { deadlineAt: ctx.clock.now + 15_000 });
};
const codes = (result: { blockers: Array<{ code: string }> }) => result.blockers.map(issue => issue.code);
const bareEntryStatus = (ctx: Ctx, id = 'entry:barec001') => ctx.controller.status().manualEntries?.find(entry => entry.operationId === id);
const actionRecord = (ctx: Ctx, id = 'manage:bareclose01') => ctx.controller.status().manualOrderActions?.find(item => item.operationId === id);
const foreignLeaderOrder = (overrides: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: 'foreign1', brokerOrderId: 'foreign-1', accountId: LEADER, symbol: SYM, side: 'Sell', orderType: 'Limit',
  quantity: 1, filledQuantity: 0, limitPrice: REF + 50, status: 'working', sourceVersion: '1:Working', updatedAt: START, ...overrides,
});

describe('C8 — čisté helpery', () => {
  const record = (overrides: Partial<BareCloseEntryRecord> = {}): BareCloseEntryRecord => ({
    operationId: 'entry:barepure01', status: 'acknowledged', createdAt: 10, bare: true, entryBrokerOrderId: 'E1',
    request: { accountId: LEADER, symbol: SYM, side: 'Buy', quantity: 2, orderType: 'Market', referencePrice: REF }, ...overrides,
  });
  const base = (overrides: Partial<Parameters<typeof bareCloseRecordBlockers>[0]> = {}) => bareCloseRecordBlockers({
    record: record(), newestOperationId: 'entry:barepure01', solo: true, leaderAccountId: LEADER, groupId: 'g',
    runtime: { armed: true, shadowMode: false, killSwitch: false },
    command: { groupId: 'g', leaderAccountId: LEADER, symbol: SYM, expect: { price: REF, quantity: 2 } }, ...overrides,
  }).map(issue => issue.code);

  it('sólo skupina = manual-only ∧ local-only ∧ bez followerů ∧ DEMO; smazaná skupina nikdy', () => {
    const solo = { manualOnly: true, localOnly: true, followers: [] };
    expect(soloManualGroup({ group: solo, brokerEnvironment: 'demo' })).toBe(true);
    expect(soloManualGroup({ group: solo, brokerEnvironment: 'live' })).toBe(false);
    expect(soloManualGroup({ group: { ...solo, followers: [1] }, brokerEnvironment: 'demo' })).toBe(false);
    expect(soloManualGroup({ group: { ...solo, localOnly: false }, brokerEnvironment: 'demo' })).toBe(false);
    expect(soloManualGroup({ group: { ...solo, manualOnly: undefined }, brokerEnvironment: 'demo' })).toBe(false);
    expect(soloManualGroup({ group: null, brokerEnvironment: 'demo' })).toBe(false);
  });

  it('brány záznamu: vlastní holý, sólo, leader, nejnovější + otevřený, ARMED, co jsem viděl = qty', () => {
    expect(base()).toEqual([]);
    expect(base({ record: record({ stopBrokerOrderId: 'S1', targetBrokerOrderId: 'T1' }) })).toEqual(['not-bare-entry']);
    expect(base({ record: record({ status: 'unknown' }) })).toEqual(['not-bare-entry']);
    expect(base({ record: record({ request: { ...record().request, accountId: 1 } }) })).toEqual(['not-bare-entry']);
    expect(base({ solo: false })).toEqual(['not-solo']);
    expect(base({ command: { groupId: 'x', leaderAccountId: LEADER, symbol: SYM, expect: { price: REF, quantity: 2 } } })).toEqual(['not-leader']);
    expect(base({ command: { groupId: 'g', leaderAccountId: LEADER, symbol: 'MNQH7', expect: { price: REF, quantity: 2 } } })).toEqual(['not-leader']);
    // Starší záznam nesmí „adoptovat“ pozici, i když sám otevřený vypadá.
    expect(base({ newestOperationId: 'entry:b' })).toEqual(['entry-closed']);
    expect(base({ record: record({ closedAt: 20 }) })).toEqual(['entry-closed']);
    expect(base({ runtime: { armed: false, shadowMode: false, killSwitch: false } })).toEqual(['not-armed']);
    expect(base({ runtime: { armed: true, shadowMode: true, killSwitch: false } })).toEqual(['not-armed']);
    expect(base({ runtime: { armed: true, shadowMode: false, killSwitch: true } })).toEqual(['not-armed']);
    expect(base({ command: { groupId: 'g', leaderAccountId: LEADER, symbol: SYM, expect: { price: REF, quantity: 1 } } })).toEqual(['order-changed']);
    expect(base({ command: { groupId: 'g', leaderAccountId: LEADER, symbol: SYM, expect: { price: REF + 0.25, quantity: 2 } } })).toEqual(['order-changed']);
  });

  it('tvar z REST: vyplněno přesně qty, |net| = qty na správné straně, nic nepracuje', () => {
    const shape = (overrides: Partial<Parameters<typeof bareCloseShapeBlockers>[0]> = {}) => bareCloseShapeBlockers({
      side: 'Buy', quantity: 2, entryOrder: { status: 'filled', filledQuantity: 2 }, net: 2, openOrdersOnSymbol: 0, ...overrides,
    }).map(issue => issue.code);
    expect(shape()).toEqual([]);
    expect(shape({ entryOrder: null })).toEqual(['shape']);
    expect(shape({ entryOrder: { status: 'working', filledQuantity: 1 } })).toEqual(['shape']);
    expect(shape({ net: 3 })).toEqual(['shape']);
    expect(shape({ net: -2 })).toEqual(['shape']);
    expect(shape({ net: 0 })).toEqual(['shape']);
    expect(shape({ side: 'Sell', net: -2 })).toEqual([]);
    expect(shape({ openOrdersOnSymbol: 1 })).toEqual(['other-orders']);
  });

  it('kontrola před zápisem z cache: nic nepracuje a stream net = očekávaná pozice', () => {
    expect(bareClosePreWriteBlocker({ expectedNet: 2, streamNet: 2, openOrdersOnSymbol: 0 })).toBeNull();
    expect(bareClosePreWriteBlocker({ expectedNet: 2, streamNet: 2, openOrdersOnSymbol: 1 })).toMatch(/začal pracovat příkaz/);
    expect(bareClosePreWriteBlocker({ expectedNet: 2, streamNet: 1, openOrdersOnSymbol: 0 })).toMatch(/Pozice leadera se mezitím změnila/);
    expect(bareClosePreWriteBlocker({ expectedNet: -2, streamNet: 2, openOrdersOnSymbol: 0 })).toMatch(/Pozice leadera se mezitím změnila/);
    expect(bareClosePreWriteBlocker({ expectedNet: 2, streamNet: null, openOrdersOnSymbol: 0 })).toMatch(/Pozice leadera se mezitím změnila/);
  });

  it('výběr pro UI = nejnovější, acknowledged, holý, bez nohou, otevřený; jen sólo; payload projde validátorem beze změny', () => {
    const ctx = { solo: true, leaderAccountId: LEADER };
    expect(selectBareLeaderTrade([record()], ctx)).toEqual({ entryOperationId: 'entry:barepure01', symbol: SYM, side: 'Buy', quantity: 2, referencePrice: REF });
    expect(selectBareLeaderTrade([record()], { ...ctx, solo: false })).toBeNull();
    expect(selectBareLeaderTrade([record({ closedAt: 5 })], ctx)).toBeNull();
    expect(selectBareLeaderTrade([record({ stopBrokerOrderId: 'S', targetBrokerOrderId: 'T' })], ctx)).toBeNull();
    expect(selectBareLeaderTrade([record(), record({ operationId: 'entry:b', createdAt: 11, bare: undefined })], ctx)).toBeNull();
    expect(selectBareLeaderTrade([record({ request: { ...record().request, referencePrice: undefined } })], ctx)).toBeNull();
    const trade = selectBareLeaderTrade([record()], ctx)!;
    const command = buildLeaderOrderManageCommand({ groupId: 'g', operationId: 'manage:uiclose001', leaderAccountId: LEADER, ...bareCloseManageFields(trade) });
    expect(() => validateLeaderOrderManage(command)).not.toThrow();
    expect(command).toMatchObject({ action: 'close-position', entryOperationId: 'entry:barepure01', expect: { price: REF, quantity: 2 } });
  });

  it('oponentura: lot deníku dne s fillem vstupu = očekávaná pozice; obrat přes nulu nebo chybějící lot → blocked', () => {
    const lot = (overrides: Record<string, unknown> = {}) => ({ symbol: SYM, netQuantity: 2, entryOrderIds: ['E1'], ...overrides });
    const check = (lots: ReturnType<typeof lot>[], expectedNet = 2) => bareCloseLotBlockers({ lots, symbol: SYM, entryBrokerOrderId: 'E1', expectedNet }).map(issue => issue.code);
    expect(check([lot()])).toEqual([]);
    expect(check([lot({ netQuantity: -2 })], -2)).toEqual([]);
    // +2 → −2 → +2 jedním fillem: nový lot bez id vstupu.
    expect(check([lot({ entryOrderIds: ['REV2'] })])).toEqual(['entry-not-open']);
    expect(check([])).toEqual(['entry-not-open']);
    expect(check([lot({ netQuantity: 1 })])).toEqual(['entry-not-open']);
    expect(check([lot({ netQuantity: -2 })])).toEqual(['entry-not-open']);
    expect(check([lot({ symbol: 'MNQH7' })])).toEqual(['entry-not-open']);
    expect(check([lot({ entryOrderIds: undefined })])).toEqual(['entry-not-open']);
  });

  it('oponentura: dořešení zavření — záznam nevlastní pozici, když ho stream uzavřel nebo ho nahradil novější vstup z flat', () => {
    const entry = { operationId: 'entry:a', createdAt: 10 };
    expect(bareCloseSuperseded(entry, [entry])).toBe(false);
    expect(bareCloseSuperseded({ ...entry, closedAt: 20 }, [entry])).toBe(true);
    expect(bareCloseSuperseded(entry, [entry, { operationId: 'entry:b', createdAt: 11, entryBrokerOrderId: 'E2' }])).toBe(true);
    // Novější záznam, který k brokerovi nedošel, ani přikoupení (neprošlo branou z flat) vlastnictví nemění.
    expect(bareCloseSuperseded(entry, [entry, { operationId: 'entry:b', createdAt: 11 }])).toBe(false);
    expect(bareCloseSuperseded(entry, [entry, { operationId: 'entry:b', createdAt: 11, entryBrokerOrderId: 'E2', scaleIn: true }])).toBe(false);
    expect(bareCloseSuperseded(entry, [{ operationId: 'entry:z', createdAt: 9, entryBrokerOrderId: 'E0' }, entry])).toBe(false);
  });

  it('capability: bez ní UI × u holé pozice nenabídne', () => {
    expect(supportsCopierManualOrderCloseBare(null)).toBe(false);
    expect(supportsCopierManualOrderCloseBare({ capabilities: ['manual-order-close-v1', 'manual-entry-bare-v1'] })).toBe(false);
    expect(supportsCopierManualOrderCloseBare({ capabilities: [COPIER_MANUAL_ORDER_CLOSE_BARE_CAPABILITY] })).toBe(true);
    expect(COPIER_MANUAL_ORDER_CLOSE_BARE_CAPABILITY).toBe('manual-order-close-bare-v1');
  });
});

describe('C8 — × zavřít holý Market (controller, sólo DEMO skupina)', () => {
  it('běžná cesta: jeden liquidate, výsledek stavem, záznam uzavřený, kopírka dál zapnutá; attach pak nejde', async () => {
    const ctx = await setup();
    expect(ctx.controller.manualBareCloseEnabled?.()).toBe(true);
    await openBare(ctx);
    expect(ctx.controller.status().bareLeaderTrade).toEqual({ entryOperationId: 'entry:barec001', symbol: SYM, side: 'Buy', quantity: 2, referencePrice: REF });
    const result = await closeBare(ctx);
    expect(result).toMatchObject({ status: 'acknowledged', blockers: [] });
    expect(result.reason).toMatch(/ověřeno čtením/);
    expect(ctx.broker.liquidateRequests()).toEqual([expect.objectContaining({ accountId: LEADER, symbol: SYM })]);
    expect(actionRecord(ctx)).toMatchObject({ action: 'close-position', status: 'acknowledged', entryOperationId: 'entry:barec001' });
    expect(bareEntryStatus(ctx)).toMatchObject({ open: false });
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null, bareLeaderTrade: null });
    expect(ctx.audits.some(line => line.startsWith('modified:close-position holé pozice Buy 2'))).toBe(true);
    // Stejné operationId = výsledek ze záznamu, žádný druhý zápis.
    expect((await closeBare(ctx)).status).toBe('acknowledged');
    expect(ctx.broker.liquidateRequests()).toHaveLength(1);
    // Uzavřený holý záznam už nohy nedostane (žádné adoptování další pozice).
    const attach = await ctx.controller.manageLeaderOrder(buildLeaderOrderManageCommand({ groupId: group().id, operationId: 'manage:bareattach1', leaderAccountId: LEADER,
      entryOperationId: 'entry:barec001', symbol: SYM, action: 'attach-brackets', expect: { price: REF, quantity: 2 }, stopLoss: REF - 10, takeProfit: REF + 20 }), { deadlineAt: ctx.clock.now + 15_000 });
    expect(codes(attach)).toContain('entry-closed');
  });

  it('stream zplochnutí neukáže: úspěch z REST a holý záznam uzavře sám worker (ne až stream)', async () => {
    const ctx = await setup({ patchBroker: broker => {
      broker.liquidatePosition = async request => { broker.setPosition(request.accountId, request.symbol, 0); return { status: 'submitted', brokerOrderId: 'liq-1' }; };
    } });
    await openBare(ctx);
    const result = await closeBare(ctx);
    expect(result.status).toBe('acknowledged');
    expect(bareEntryStatus(ctx)).toMatchObject({ open: false });
    expect(ctx.controller.status().bareLeaderTrade).toBeNull();
  });

  it('cizí pracující příkaz na symbolu (REST) → blocked other-orders, nic se nepošle', async () => {
    const ctx = await setup();
    await openBare(ctx);
    ctx.broker.seedOrder(foreignLeaderOrder());
    const result = await closeBare(ctx);
    expect(result.status).toBe('blocked');
    expect(codes(result)).toEqual(['other-orders']);
    expect(ctx.broker.liquidateRequests()).toEqual([]);
    expect(actionRecord(ctx)).toBeUndefined();
  });

  it('typ příkazu, který appka nezná (INV-TRAD-07), se počítá jako pracující → blocked', async () => {
    const ctx = await setup();
    await openBare(ctx);
    ctx.broker.seedOrder(foreignLeaderOrder({ orderType: 'Unsupported', brokerOrderType: 'TrailingStop', limitPrice: undefined }));
    expect(codes(await closeBare(ctx))).toEqual(['other-orders']);
    expect(ctx.broker.liquidateRequests()).toEqual([]);
  });

  it('jiný počet: expect qty, pozice u brokera, částečné vyplnění, opačná strana → blocked, nic se nepošle', async () => {
    const ctx = await setup();
    await openBare(ctx);
    expect(codes(await closeBare(ctx, { quantity: 1, id: 'manage:bareqty0001' }))).toEqual(['order-changed']);
    expect(codes(await closeBare(ctx, { price: REF + 0.25, id: 'manage:bareqty0002' }))).toEqual(['order-changed']);
    ctx.broker.setPosition(LEADER, SYM, 3);
    expect(codes(await closeBare(ctx, { id: 'manage:bareqty0003' }))).toEqual(['shape']);
    ctx.broker.setPosition(LEADER, SYM, -2);
    expect(codes(await closeBare(ctx, { id: 'manage:bareqty0004' }))).toEqual(['shape']);
    ctx.broker.setPosition(LEADER, SYM, 2);
    const entry = ctx.broker.orders().find(order => order.accountId === LEADER && order.orderType === 'Market')!;
    entry.filledQuantity = 1;
    expect(codes(await closeBare(ctx, { id: 'manage:bareqty0005' }))).toEqual(['shape']);
    expect(ctx.broker.liquidateRequests()).toEqual([]);
  });

  it('uzavřený záznam (leader mezitím zplochl) nesmí zavřít jinou pozici → entry-closed', async () => {
    const ctx = await setup();
    await openBare(ctx);
    ctx.broker.setPosition(LEADER, SYM, 0);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 0 } });
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(bareEntryStatus(ctx)).toMatchObject({ open: false });
    // Jiná pozice stejné velikosti (např. z Tradovate) — vlastnictví z pozice se neodvozuje (INV-PART-03).
    ctx.broker.setPosition(LEADER, SYM, 2);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 2 } });
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().bareLeaderTrade).toBeNull();
    expect(codes(await closeBare(ctx))).toEqual(['entry-closed']);
    expect(ctx.broker.liquidateRequests()).toEqual([]);
  });

  it('DISARMED a kill → not-armed (za DISARMED až s C9), nic se nepošle', async () => {
    const ctx = await setup();
    await openBare(ctx);
    ctx.controller.disarm('manual');
    await ctx.controller.waitForIdle();
    expect(codes(await closeBare(ctx, { id: 'manage:bareoff001' }))).toEqual(['not-armed']);
    ctx.controller.engageKillSwitch('test');
    await ctx.controller.waitForIdle();
    expect(codes(await closeBare(ctx, { id: 'manage:bareoff002' }))).toEqual(['not-armed']);
    expect(ctx.broker.liquidateRequests()).toEqual([]);
  });

  it('brzda během REST čtení → state-changed ve frontě, nic se nepošle', async () => {
    let brakeDuringRead = false;
    const ctx = await setup({ patchBroker: broker => {
      const real = broker.listPositions.bind(broker);
      broker.listPositions = async accountId => {
        if (brakeDuringRead) { brakeDuringRead = false; active?.disarm('manual'); }
        return real(accountId);
      };
    } });
    await openBare(ctx);
    brakeDuringRead = true;
    const during = await closeBare(ctx, { id: 'manage:barebrk001' });
    expect(codes(during)).toEqual(['state-changed']);
    expect(ctx.broker.liquidateRequests()).toEqual([]);
  });

  it('DISARM mezi durable `sending` a zápisem → not-sent, liquidate neodejde', async () => {
    const store = createMemoryCopierStore();
    let controllerRef: CopierRuntimeController | null = null;
    let armTrap = false;
    const realCommit = store.commit.bind(store);
    store.commit = async (snapshot, revision) => {
      const committed = await realCommit(snapshot, revision);
      if (armTrap && snapshot.safety?.manualOrderActions?.some(item => item.operationId === 'manage:barebrk002' && item.status === 'sending')) {
        armTrap = false;
        controllerRef?.disarm('manual');
      }
      return committed;
    };
    const ctx = await setup({ store, onController: controller => { controllerRef = controller; } });
    await openBare(ctx);
    armTrap = true;
    const result = await closeBare(ctx, { id: 'manage:barebrk002' });
    expect(result.status).toBe('blocked');
    expect(result.blockers[0]).toMatchObject({ code: 'not-sent', text: expect.stringMatching(/přestala běžet/) });
    expect(ctx.broker.liquidateRequests()).toEqual([]);
    expect(actionRecord(ctx, 'manage:barebrk002')).toMatchObject({ status: 'not-sent' });
  });

  it('závod: příkaz na symbolu jen ve streamu (REST ho ještě nevidí) → not-sent před zápisem', async () => {
    const ctx = await setup();
    await openBare(ctx);
    ctx.broker.emitEvent({ type: 'order', order: foreignLeaderOrder() });
    await sleep(30);
    await ctx.controller.waitForIdle();
    const result = await closeBare(ctx);
    expect(result.status).toBe('blocked');
    expect(result.blockers[0]).toMatchObject({ code: 'not-sent', text: expect.stringMatching(/začal pracovat příkaz/) });
    expect(ctx.broker.liquidateRequests()).toEqual([]);
  });

  it('závod: stream ukazuje jinou pozici než REST → not-sent před zápisem', async () => {
    const ctx = await setup();
    await openBare(ctx);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 1 } });
    await sleep(30);
    await ctx.controller.waitForIdle();
    const result = await closeBare(ctx);
    expect(result.blockers[0]).toMatchObject({ code: 'not-sent', text: expect.stringMatching(/Pozice leadera se mezitím změnila/) });
    expect(ctx.broker.liquidateRequests()).toEqual([]);
  });

  it('pozice po zápisu trvá → unknown + incident (bez auto-close), žádný druhý zápis', async () => {
    let calls = 0;
    const ctx = await setup({ patchBroker: broker => {
      broker.liquidatePosition = async () => { calls += 1; return { status: 'submitted', brokerOrderId: 'liq-x' }; };
    } });
    await openBare(ctx);
    const result = await closeBare(ctx);
    expect(result.status).toBe('unknown');
    expect(result.reason).toMatch(/Holá pozice leadera 2 \(bez SL\/TP\) trvá — zavření nepotvrzeno/);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().lastError).toMatch(/Holá pozice leadera 2/);
    expect(ctx.controller.status().armed).toBe(false);
    expect(actionRecord(ctx)).toMatchObject({ status: 'unknown' });
    expect(bareEntryStatus(ctx)).toMatchObject({ open: true });
    await sleep(200);
    expect(calls).toBe(1);
  });

  it('broker „already flat“ → waived (kauzalita se netvrdí), záznam uzavřený', async () => {
    const ctx = await setup({ patchBroker: broker => {
      broker.liquidatePosition = async (): Promise<BrokerLiquidateResult> => ({ status: 'already-flat' });
    } });
    await openBare(ctx);
    const result = await closeBare(ctx);
    expect(result.status).toBe('acknowledged');
    expect(result.reason).toMatch(/už byla zavřená/);
    expect(actionRecord(ctx)).toMatchObject({ status: 'waived' });
    expect(bareEntryStatus(ctx)).toMatchObject({ open: false });
  });

  it('opačné pořadí: stream flat dřív, první REST snímek ještě s pozicí → žádný falešný incident', async () => {
    let staleReads = 1;
    const ctx = await setup({ patchBroker: broker => {
      const realPositions = broker.listPositions.bind(broker);
      const realLiquidate = broker.liquidatePosition!.bind(broker);
      let liquidated = false;
      broker.liquidatePosition = async request => { liquidated = true; return realLiquidate(request); };
      broker.listPositions = async accountId => {
        if (liquidated && accountId === LEADER && staleReads > 0) { staleReads -= 1; return [{ accountId: LEADER, symbol: SYM, netQuantity: 2 }]; }
        return realPositions(accountId);
      };
    } });
    await openBare(ctx);
    const result = await closeBare(ctx);
    expect(result.status).toBe('acknowledged');
    expect(staleReads).toBe(0);
    expect(ctx.controller.status().lastError).toBeNull();
  });

  it('dvě zavření souběžně: druhé = manage-unresolved, liquidate jen jednou', async () => {
    let release: (value: BrokerLiquidateResult) => void = () => undefined;
    let calls = 0;
    const ctx = await setup({ patchBroker: broker => {
      broker.liquidatePosition = (_request: BrokerLiquidateRequest) => { calls += 1; return new Promise(resolve => { release = resolve; }); };
    } });
    await openBare(ctx);
    const first = closeBare(ctx, { id: 'manage:barepar001' });
    for (let i = 0; i < 50 && calls === 0; i += 1) await sleep(5);
    expect(calls).toBe(1);
    const second = await closeBare(ctx, { id: 'manage:barepar002' });
    expect(codes(second)).toEqual(['manage-unresolved']);
    ctx.broker.setPosition(LEADER, SYM, 0);
    release({ status: 'submitted', brokerOrderId: 'liq-p' });
    expect((await first).status).toBe('acknowledged');
    expect(calls).toBe(1);
  });

  it('Flatten současně: zápis je registrovaný, Flatten leadera vynechá — druhá likvidace nevznikne', async () => {
    let release: (value: BrokerLiquidateResult) => void = () => undefined;
    let calls = 0;
    const ctx = await setup({ patchBroker: broker => {
      broker.liquidatePosition = (_request: BrokerLiquidateRequest) => {
        calls += 1;
        if (calls > 1) return Promise.resolve({ status: 'already-flat' } as BrokerLiquidateResult);
        return new Promise(resolve => { release = resolve; });
      };
    } });
    await openBare(ctx);
    const close = closeBare(ctx);
    for (let i = 0; i < 50 && calls === 0; i += 1) await sleep(5);
    expect(calls).toBe(1);
    const flatten = await ctx.controller.flattenGroup('flatten:bareclose01').catch(error => ({ error: String(error) }));
    expect(calls).toBe(1);
    expect(JSON.stringify(flatten)).toMatch(/nejasn|background write|běžící|write/i);
    ctx.broker.setPosition(LEADER, SYM, 0);
    release({ status: 'submitted', brokerOrderId: 'liq-f' });
    const result = await close;
    expect(result.status).toBe('acknowledged');
    expect(calls).toBe(1);
  });

  it('restart v `sending`: pozice trvá → unknown + incident „holá pozice trvá“; bez zápisu', async () => {
    const store = createMemoryCopierStore();
    const ctx = await setup({ store });
    const { entryBrokerOrderId } = await openBare(ctx);
    ctx.controller.stop();
    active = null;
    const snapshot = await store.load();
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualOrderActions: [{
      operationId: 'manage:barerst001', payloadHash: 'abcdefgh12', entryOperationId: 'entry:barec001', action: 'close-position',
      status: 'sending', targetBrokerOrderId: entryBrokerOrderId, fromPrice: REF, toPrice: null, symbol: SYM, quantity: 2, createdAt: START, updatedAt: START,
    }] } }, snapshot.revision);
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }), nativeLiquidate: true });
    broker.setPosition(LEADER, SYM, 2);
    const controller = await bootstrapCopierRuntime({ broker, store, group: group(), clock: () => START + 5_000, manualEntryTimingsMs: { settle: 30, verify: 100 } });
    active = controller;
    broker.setConnected(true);
    expect(controller.status().manualOrderActions?.[0]).toMatchObject({ status: 'unknown' });
    await sleep(150);
    await controller.waitForIdle();
    expect(controller.status().manualOrderActions?.[0]).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/Holá pozice leadera 2 \(bez SL\/TP\) trvá/) });
    expect(controller.status().lastError).toMatch(/Holá pozice leadera 2/);
    // Kolo 3 (výhrada C8 č. 6): worker po restartu startuje DISARMED — incident se přesto zapíše (recordWhenDisarmed).
    expect(controller.status().lastDisarm).toMatchObject({ trigger: 'fail-closed', detail: expect.stringMatching(/Holá pozice leadera 2/) });
    expect(broker.liquidateRequests()).toEqual([]);
  });

  it('restart v `sending`: leader flat → waived a holý záznam uzavřený', async () => {
    const store = createMemoryCopierStore();
    const ctx = await setup({ store });
    const { entryBrokerOrderId } = await openBare(ctx);
    ctx.controller.stop();
    active = null;
    const snapshot = await store.load();
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualOrderActions: [{
      operationId: 'manage:barerst002', payloadHash: 'abcdefgh12', entryOperationId: 'entry:barec001', action: 'close-position',
      status: 'sending', targetBrokerOrderId: entryBrokerOrderId, fromPrice: REF, toPrice: null, symbol: SYM, quantity: 2, createdAt: START, updatedAt: START,
    }] } }, snapshot.revision);
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }), nativeLiquidate: true });
    const controller = await bootstrapCopierRuntime({ broker, store, group: group(), clock: () => START + 5_000, manualEntryTimingsMs: { settle: 30, verify: 100 } });
    active = controller;
    broker.setConnected(true);
    await sleep(150);
    await controller.waitForIdle();
    expect(controller.status().manualOrderActions?.[0]).toMatchObject({ status: 'waived', reason: expect.stringMatching(/příčina neověřena/) });
    expect(controller.status().manualEntries?.find(entry => entry.operationId === 'entry:barec001')).toMatchObject({ open: false });
    expect(broker.liquidateRequests()).toEqual([]);
  });
});

describe('C8 — oponentura: chybové větve, nejnovější záznam, obrat přes nulu, nový vstup během unknown', () => {
  const attachBare = (ctx: Ctx, id = 'manage:bareatt0001', entryOperationId = 'entry:barec001') => ctx.controller.manageLeaderOrder(buildLeaderOrderManageCommand({
    groupId: group().id, operationId: id, leaderAccountId: LEADER, entryOperationId, symbol: SYM, action: 'attach-brackets',
    expect: { price: REF, quantity: 2 }, stopLoss: REF - 10, takeProfit: REF + 20,
  }), { deadlineAt: ctx.clock.now + 15_000 });
  /** Liquidate, který u brokera proběhne (pozice 0), ale odpověď přijde až po timeoutu správy. */
  const lateLiquidate = (broker: MockBroker, flatten = true, afterMs = 600) => {
    broker.liquidatePosition = async request => {
      if (flatten) broker.setPosition(request.accountId, request.symbol, 0);
      await sleep(afterMs);
      return { status: 'submitted', brokerOrderId: 'liq-late' };
    };
  };

  it('timeout a pozice trvá → unknown + incident; unknown pak blokuje doplnění SL/TP (manage-unresolved)', async () => {
    const ctx = await setup({ settleMs: 10_000, patchBroker: broker => lateLiquidate(broker, false) });
    await openBare(ctx);
    const result = await closeBare(ctx);
    expect(result.status).toBe('unknown');
    expect(result.reason).toMatch(/Holá pozice leadera 2 \(bez SL\/TP\) trvá — zavření nepotvrzeno \(zavření nepotvrzené\)/);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status()).toMatchObject({ armed: false, lastError: expect.stringMatching(/Holá pozice leadera 2/) });
    expect(actionRecord(ctx)).toMatchObject({ status: 'unknown' });
    expect(codes(await attachBare(ctx))).toEqual(['manage-unresolved']);
  });

  it('timeout a leader flat → unknown bez incidentu, dořešení čtením = waived + holý záznam uzavřený; žádný druhý zápis', async () => {
    let calls = 0;
    const ctx = await setup({ patchBroker: broker => { lateLiquidate(broker); const real = broker.liquidatePosition!; broker.liquidatePosition = request => { calls += 1; return real(request); }; } });
    await openBare(ctx);
    const result = await closeBare(ctx);
    expect(result.status).toBe('unknown');
    expect(ctx.controller.status().lastError).toBeNull();
    await sleep(250);
    await ctx.controller.waitForIdle();
    expect(actionRecord(ctx)).toMatchObject({ status: 'waived', reason: expect.stringMatching(/příčina neověřena/) });
    expect(bareEntryStatus(ctx)).toMatchObject({ open: false });
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
    expect(calls).toBe(1);
  });

  it('výjimka zápisu a pozice trvá → unknown + incident; indeterminate a flat → unknown, pak waived', async () => {
    const thrown = await setup({ patchBroker: broker => { broker.liquidatePosition = async () => { throw new Error('socket hang up'); }; } });
    await openBare(thrown);
    const first = await closeBare(thrown);
    expect(first.status).toBe('unknown');
    expect(first.reason).toMatch(/Holá pozice leadera 2/);
    expect(thrown.controller.status().lastError).toMatch(/Holá pozice leadera 2/);
    thrown.controller.stop();
    active = null;
    const indeterminate = await setup({ patchBroker: broker => {
      broker.liquidatePosition = async request => { broker.setPosition(request.accountId, request.symbol, 0); return { status: 'indeterminate', reason: 'adapter lost reply' }; };
    } });
    await openBare(indeterminate);
    const second = await closeBare(indeterminate);
    expect(second.status).toBe('unknown');
    expect(indeterminate.controller.status().lastError).toBeNull();
    await sleep(250);
    await indeterminate.controller.waitForIdle();
    expect(actionRecord(indeterminate)).toMatchObject({ status: 'waived' });
    expect(bareEntryStatus(indeterminate)).toMatchObject({ open: false });
  });

  it('definitivní odmítnutí a pozice trvá → incident, ale záznam `rejected` (ne unknown) → doplnění SL/TP zůstává dostupné', async () => {
    const ctx = await setup({ patchBroker: broker => { broker.liquidatePosition = async (): Promise<BrokerLiquidateResult> => ({ status: 'rejected', reason: 'Market closed' }); } });
    await openBare(ctx);
    const result = await closeBare(ctx);
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/Holá pozice leadera 2 \(bez SL\/TP\) trvá — zavření nepotvrzeno \(zavření odmítnuto: Market closed\)/);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status()).toMatchObject({ armed: false, lastError: expect.stringMatching(/Holá pozice leadera 2/) });
    expect(actionRecord(ctx)).toMatchObject({ status: 'rejected' });
    expect(bareEntryStatus(ctx)).toMatchObject({ open: true });
    // Risk-redukční doplnění SL/TP i za DISARMED (incident vypnul kopírku) — ne manage-unresolved.
    const attach = await attachBare(ctx);
    expect(codes(attach)).not.toContain('manage-unresolved');
    expect(attach.status).toBe('acknowledged');
  });

  it('definitivní odmítnutí a leader flat → waived „ne tímto příkazem“, záznam uzavřený, bez incidentu', async () => {
    const ctx = await setup({ patchBroker: broker => {
      broker.liquidatePosition = async request => { broker.setPosition(request.accountId, request.symbol, 0); return { status: 'rejected', reason: 'Already flat' }; };
    } });
    await openBare(ctx);
    const result = await closeBare(ctx);
    expect(result.status).toBe('acknowledged');
    expect(result.reason).toMatch(/ne tímto příkazem/);
    expect(result.reason).not.toMatch(/followery/);
    expect(actionRecord(ctx)).toMatchObject({ status: 'waived' });
    expect(bareEntryStatus(ctx)).toMatchObject({ open: false });
    expect(ctx.controller.status().lastError).toBeNull();
  });

  it('nejnovější záznam na úrovni controlleru: starší holý záznam (closedAt null) vedle novějšího vstupu → entry-closed, nic se nepošle', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ store });
    await openBare(first);
    first.controller.stop();
    active = null;
    const snapshot = await store.load();
    const entries = snapshot.safety?.manualEntries ?? [];
    const old = entries.find(record => record.operationId === 'entry:barec001')!;
    expect(old.closedAt).toBeUndefined();
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualEntries: [...entries, {
      ...old, operationId: 'entry:barec009', createdAt: old.createdAt + 1, entryBrokerOrderId: 'other-entry', updatedAt: old.updatedAt + 1,
    }] } }, snapshot.revision);
    const second = await setup({ store, broker: first.broker, arm: false });
    const result = await closeBare(second);
    expect(codes(result)).toEqual(['entry-closed']);
    expect(second.broker.liquidateRequests()).toEqual([]);
  });

  it('obrat přes nulu bez eventu net 0 (+2 → −2 → +2 jedním fillem) → entry-not-open, nic se nepošle', async () => {
    const ctx = await setup();
    await openBare(ctx);
    const fill = (id: string, side: 'Buy' | 'Sell') => ctx.broker.emitEvent({ type: 'fill', fill: {
      fillId: `f-${id}`, tag: id, brokerOrderId: id, accountId: LEADER, symbol: SYM, side, quantity: 4, price: REF + 0.25, filledAt: ctx.clock.now,
    } });
    fill('rev-1', 'Sell');
    fill('rev-2', 'Buy');
    await sleep(30);
    await ctx.controller.waitForIdle();
    // Stream ani REST net 0 nikdy neukázaly — holý záznam zůstal „otevřený“.
    expect(bareEntryStatus(ctx)).toMatchObject({ open: true });
    const result = await closeBare(ctx);
    expect(codes(result)).toEqual(['entry-not-open']);
    expect(ctx.broker.liquidateRequests()).toEqual([]);
  });

  it('Flatten běžící ještě před × → blocked, × nic neodešle (jediná likvidace je Flattenu)', async () => {
    let release: (value: BrokerLiquidateResult) => void = () => undefined;
    let calls = 0;
    const ctx = await setup({ patchBroker: broker => {
      broker.liquidatePosition = (_request: BrokerLiquidateRequest) => { calls += 1; return new Promise(resolve => { release = resolve; }); };
    } });
    await openBare(ctx);
    const flatten = ctx.controller.flattenGroup('flatten:barefirst1').catch(error => ({ error: String(error) }));
    for (let i = 0; i < 50 && calls === 0; i += 1) await sleep(5);
    expect(calls).toBe(1);
    const result = await closeBare(ctx);
    expect(result.status).toBe('blocked');
    expect(calls).toBe(1);
    expect(actionRecord(ctx)).toBeUndefined();
    ctx.broker.setPosition(LEADER, SYM, 0);
    release({ status: 'submitted', brokerOrderId: 'liq-flat' });
    await flatten;
  });

  it('close se `scope: position` na holém záznamu → blocked, nic se nepošle', async () => {
    const ctx = await setup();
    await openBare(ctx);
    const command = buildLeaderOrderManageCommand({
      groupId: group().id, operationId: 'manage:barescope1', leaderAccountId: LEADER, entryOperationId: 'entry:barec001', symbol: SYM,
      action: 'close-position', expect: { price: REF, quantity: 2 }, scope: 'position',
    });
    const result = await ctx.controller.manageLeaderOrder(validateLeaderOrderManage(command), { deadlineAt: ctx.clock.now + 15_000 });
    expect(result.status).toBe('blocked');
    expect(ctx.broker.liquidateRequests()).toEqual([]);
  });

  /** Restart s `close-position` v `sending` u holého záznamu A; `patch` upraví durable záznamy vstupů. */
  async function restartUnknownBareClose(patch: (entries: CopierManualEntryRecord[]) => CopierManualEntryRecord[]) {
    const store = createMemoryCopierStore();
    const ctx = await setup({ store });
    const { entryBrokerOrderId } = await openBare(ctx);
    ctx.controller.stop();
    active = null;
    const snapshot = await store.load();
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualEntries: patch(snapshot.safety?.manualEntries ?? []), manualOrderActions: [{
      operationId: 'manage:barenew001', payloadHash: 'abcdefgh12', entryOperationId: 'entry:barec001', action: 'close-position',
      status: 'sending', targetBrokerOrderId: entryBrokerOrderId, fromPrice: REF, toPrice: null, symbol: SYM, quantity: 2, createdAt: START, updatedAt: START,
    }] } }, snapshot.revision);
    // U brokera je pozice 2 bez příkazů — ale patří jinému vstupu / mimo appku.
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }), nativeLiquidate: true });
    broker.setPosition(LEADER, SYM, 2);
    const controller = await bootstrapCopierRuntime({ broker, store, group: group(), clock: () => START + 5_000, manualEntryTimingsMs: { settle: 30, verify: 100 } });
    active = controller;
    broker.setConnected(true);
    await sleep(150);
    await controller.waitForIdle();
    return { controller, broker };
  }

  it('nový vstup během `unknown` zavření (novější záznam z flat došel k brokerovi) → dořešení NEvyhlásí falešný incident o nové pozici', async () => {
    const { controller, broker } = await restartUnknownBareClose(entries => {
      const old = entries.find(record => record.operationId === 'entry:barec001')!;
      expect(old.closedAt).toBeUndefined();
      return [...entries, { ...old, operationId: 'entry:barec002', createdAt: old.createdAt + 5_000, updatedAt: old.updatedAt + 5_000, entryBrokerOrderId: 'B-entry' }];
    });
    const action = controller.status().manualOrderActions?.find(item => item.operationId === 'manage:barenew001');
    expect(action).toMatchObject({ status: 'waived', reason: expect.stringMatching(/patří jinému vstupu/) });
    expect(controller.status().lastError).toBeNull();
    expect(controller.status().manualEntries?.find(entry => entry.operationId === 'entry:barec001')).toMatchObject({ open: false });
    expect(broker.liquidateRequests()).toEqual([]);
  });

  it('`unknown` zavření, stream mezitím holý záznam uzavřel (closedAt) a u brokera je jiná pozice → waived, žádný falešný incident', async () => {
    const { controller, broker } = await restartUnknownBareClose(entries => entries.map(record => (
      record.operationId === 'entry:barec001' ? { ...record, closedAt: START + 2_000 } : record)));
    const action = controller.status().manualOrderActions?.find(item => item.operationId === 'manage:barenew001');
    expect(action).toMatchObject({ status: 'waived', reason: expect.stringMatching(/patří jinému vstupu/) });
    expect(controller.status().lastError).toBeNull();
    expect(broker.liquidateRequests()).toEqual([]);
  });

  it('kolo 3 (P3): × skončí timeoutem a liquidate dál visí, flat způsobil někdo jiný → `waived` až po konci zápisu; nový vstup mezitím nejde', async () => {
    let release: (value: BrokerLiquidateResult) => void = () => undefined;
    let calls = 0;
    const ctx = await setup({ patchBroker: broker => {
      broker.liquidatePosition = request => {
        calls += 1;
        // Pozici zavřelo něco jiného (REST i stream flat), liquidate u brokera visí.
        broker.setPosition(request.accountId, request.symbol, 0);
        broker.emitEvent({ type: 'position', position: { accountId: request.accountId, symbol: request.symbol, netQuantity: 0 } });
        return new Promise(resolve => { release = resolve; });
      };
    } });
    await openBare(ctx);
    const result = await closeBare(ctx);
    expect(result.status).toBe('unknown');
    await sleep(250); // obě plánovaná čtení (50 / 150 ms) proběhla, zápis pořád visí
    await ctx.controller.waitForIdle();
    // Stream holý záznam uzavřel (closedAt) → zkratka `bareCloseSuperseded` by platila, ale zápis běží.
    expect(bareEntryStatus(ctx)).toMatchObject({ open: false });
    expect(actionRecord(ctx)).toMatchObject({ status: 'unknown' });
    // Nový holý vstup B, dokud liquidate visí: nic neodejde (liquidate by ho mohl tiše zavřít).
    ctx.clock.now += 5_000;
    const status = ctx.controller.status();
    const preview = buildLeaderEntryPreviewCommand(
      { symbol: SYM, side: 'Buy', quantity: 1, orderType: 'Market', referencePrice: REF, quoteReceivedAt: ctx.clock.now - 300 },
      { group: { ...group(), leaderAccountId: LEADER }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: 'preview:barec002' },
    );
    const sentBefore = ctx.broker.placedRequests().length + ctx.broker.placedOsoRequests().length;
    const placedB = await ctx.controller.placeLeaderEntry(buildLeaderEntryPlaceCommand(preview, 'entry:barec002'), { deadlineAt: ctx.clock.now + 15_000 });
    expect(placedB.status).toBe('blocked');
    expect(codes(placedB)).toEqual(['leader-write-in-flight']);
    expect(ctx.broker.placedRequests().length + ctx.broker.placedOsoRequests().length).toBe(sentBefore);
    expect(ctx.controller.status().manualEntries?.find(entry => entry.operationId === 'entry:barec002')).toBeUndefined();
    // Zápis doběhne → dořešení navázané na jeho konec: `waived` „patří jinému vstupu“, žádný incident, žádný druhý zápis.
    release({ status: 'submitted', brokerOrderId: 'liq-late' });
    await sleep(60);
    await ctx.controller.waitForIdle();
    expect(actionRecord(ctx)).toMatchObject({ status: 'waived', reason: expect.stringMatching(/patří jinému vstupu/) });
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
    expect(calls).toBe(1);
  });
});
