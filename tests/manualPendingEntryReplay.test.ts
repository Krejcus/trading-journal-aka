// C12 (4. 11. 2026, docs/reviews/trading-gaps-designs/safety.md + posudek copier-design-critic):
// automatické zrušení VLASTNÍHO čekajícího vstupu z appky (z flat i přikoupení) skutečným controllerem
// nad mock brokerem. Jeden cílený pokus, předčtení vstupu REST čtením, výsledek jen stavem u brokera,
// dílčí fill se neruší, odklad bez spojení, restart = incident (nikdy druhý pokus), followeři.
import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerAccountRiskSnapshot, BrokerOrder } from '../services/brokerPort';
import { AccountPositionsCache, bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import { manualOnlyDemoSafety, type CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import { buildLeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';
import { buildLeaderEntryPlaceCommand } from '../lib/leaderEntryPlace';
import { buildCancelPendingCommand, cancelOwnPendingEntries } from '../lib/liveCancelPending';
import { validateLeaderOrderManage } from '../lib/leaderOrderManage';
import { COPIER_MANUAL_ENTRY_AUTO_CANCEL_CAPABILITY, supportsCopierManualEntryAutoCancel } from '../lib/copierWorkerCapabilities';
import { manualEntryNotifications } from '../server/copierIncidentWatchdog';
import type { CopierStore } from '../services/copierStore';

const LEADER = 61038658;
const FOLLOWER = 200;
const SYM = 'MNQZ6';
/** 3. 11. 2026 09:00 CST (UTC−6). */
const START = Date.UTC(2026, 10, 3, 15, 0, 0);
const REF = 25_000;
const ENTRY = 24_980;
const SL = 24_970;
const TP = 25_010;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const soloGroup = (): CopyGroupConfig => ({
  id: `manual-demo-${LEADER}`, name: 'Ruční DEMO test', enabled: true, leaderAccountId: LEADER,
  followers: [], localOnly: true, manualOnly: true, manualEntryMaxContracts: 5, safety: manualOnlyDemoSafety(),
});
const followerGroup = (): CopyGroupConfig => ({
  id: 'manual-group', name: 'Ruční', enabled: true, leaderAccountId: LEADER,
  followers: [{ accountId: FOLLOWER, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});
const risk = (accountId: number, at: number): BrokerAccountRiskSnapshot => ({
  accountId, at, realizedPnlUsd: 0, openPnlUsd: 0, netLiq: 50_000, minNetLiq: 48_000, dailyLossAutoLiq: 1_000, trailingMaxDrawdown: 2_000,
} as unknown as BrokerAccountRiskSnapshot);
let active: CopierRuntimeController | null = null;
afterEach(() => { active?.stop(); active = null; });

async function setup(options: {
  followers?: boolean; patchBroker?: (broker: MockBroker) => void; settleMs?: number;
  store?: ReturnType<typeof createMemoryCopierStore>; broker?: MockBroker; arm?: boolean;
  /** Vlastní skupina (oponentura C12 kolo 2: vyřazený follower). */
  group?: CopyGroupConfig;
} = {}) {
  const clock = { now: START };
  const group = options.group ?? (options.followers ? followerGroup() : soloGroup());
  const riskAccounts = options.group ? [LEADER, ...options.group.followers.map(follower => follower.accountId)] : [LEADER, FOLLOWER];
  const broker = options.broker ?? createMockBroker({
    behavior: () => ({ kind: 'working' }),
    accountRiskSnapshots: riskAccounts.map(accountId => risk(accountId, START + 500)),
  });
  options.patchBroker?.(broker);
  const audits: string[] = [];
  const controller = await bootstrapCopierRuntime({
    broker, store: options.store ?? createMemoryCopierStore(), group, clock: () => clock.now, osoCorrelationWindowMs: 50,
    manualEntryTimingsMs: { post: 300, start: 500, legWait: 300, manage: 500, settle: options.settleMs ?? 50, verify: 100 },
    manualEntryQuote: () => ({ contract: SYM, last: REF, lastAt: clock.now - 100, bid: REF - 0.25, ask: REF, quoteAt: clock.now - 50 }),
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
  clock.now = START + 1_000;
  await sleep(20);
  await controller.waitForIdle();
  return { broker, controller, audits, clock, group };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function placeEntry(ctx: Ctx, id: string, patch: { quantity?: number; orderType?: 'Limit' | 'Market' } = {}, beforeIdle?: () => Promise<void>) {
  const status = ctx.controller.status();
  const market = patch.orderType === 'Market';
  const preview = buildLeaderEntryPreviewCommand(
    { symbol: SYM, side: 'Buy', quantity: patch.quantity ?? 1, orderType: market ? 'Market' : 'Limit',
      ...(market ? { referencePrice: REF, quoteReceivedAt: ctx.clock.now - 200 } : { price: ENTRY }), stopLoss: SL, takeProfit: TP },
    { group: { ...ctx.group, leaderAccountId: LEADER }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: `preview:${id}` },
  );
  const placed = await ctx.controller.placeLeaderEntry(buildLeaderEntryPlaceCommand(preview, `entry:${id}`), { deadlineAt: ctx.clock.now + 15_000 });
  expect(placed).toMatchObject({ status: 'acknowledged' });
  await sleep(30);
  await beforeIdle?.();
  await ctx.controller.waitForIdle();
  return placed;
}
/** Kolo revize: heartbeat spustí revizi čekajících vstupů hned (deterministicky, bez 1s časovače). */
async function tick(ctx: Ctx, ms = 0) {
  ctx.clock.now += ms;
  ctx.broker.emitEvent({ type: 'heartbeat', at: ctx.clock.now });
  await sleep(30);
  await ctx.controller.waitForIdle();
  await sleep(10);
  await ctx.controller.waitForIdle();
}
const brokerOrder = (ctx: Ctx, id: string) => ctx.broker.orders().find(order => order.brokerOrderId === id)!;
const emitOrder = (ctx: Ctx, order: BrokerOrder, version: string) => ctx.broker.emitEvent({ type: 'order', order: { ...order, sourceVersion: version } });
function fillAtBroker(ctx: Ctx, entryId: string, filled: number, status: BrokerOrder['status']) {
  const entry = brokerOrder(ctx, entryId);
  entry.status = status;
  entry.filledQuantity = filled;
  emitOrder(ctx, entry, `9:${status}`);
  ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `f-${entryId}-${filled}`, tag: entry.tag, brokerOrderId: entryId, accountId: LEADER, symbol: SYM, side: 'Buy', quantity: filled, price: ENTRY, filledAt: 3 } });
  ctx.broker.setPosition(LEADER, SYM, filled);
  ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: filled } });
}
const entryStatus = (ctx: Ctx, operationId: string) => ctx.controller.status().manualEntries?.find(item => item.operationId === operationId);
/** Kopie vstupu u followera se vyplní (stream: Order Filled + Fill + Position followera). */
function fillCopy(ctx: Ctx, copy: BrokerOrder, filled = 1) {
  const order = brokerOrder(ctx, copy.brokerOrderId);
  order.status = filled >= order.quantity ? 'filled' : 'working';
  order.filledQuantity = filled;
  emitOrder(ctx, order, `9:copy:${filled}`);
  ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `f-${copy.brokerOrderId}-${filled}`, tag: order.tag, brokerOrderId: copy.brokerOrderId, accountId: FOLLOWER, symbol: SYM, side: 'Buy', quantity: filled, price: ENTRY, filledAt: 3 } });
  ctx.broker.setPosition(FOLLOWER, SYM, filled);
  ctx.broker.emitEvent({ type: 'position', position: { accountId: FOLLOWER, symbol: SYM, netQuantity: filled } });
}

describe('C12 — vstup z flat: brzda = jedno cílené zrušení ověřené stavem', () => {
  it('ARMED v klidu nic; DISARM → právě jeden cancel jen na vstup, „zrušen“ ověřeno stavem, žádný incident, nic se neopakuje', async () => {
    const ctx = await setup();
    const placed = await placeEntry(ctx, 'c12flat01');
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    ctx.controller.disarm('manual');
    await tick(ctx);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(ctx.broker.cancelRequestCount(placed.stopBrokerOrderId!)).toBe(0);
    expect(ctx.broker.cancelRequestCount(placed.targetBrokerOrderId!)).toBe(0);
    expect(ctx.audits).toContain('canceled:vlastní vstup zrušen: čekající vstup: kopírka je vypnutá (ověřeno stavem u brokera)');
    expect(entryStatus(ctx, 'entry:c12flat01')).toMatchObject({ cancel: 'sent', cancelVerified: 'canceled', cancelReason: 'čekající vstup: kopírka je vypnutá' });
    expect(ctx.controller.status().lastError).toBeNull();
    await tick(ctx, 1_500);
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
  });

  it('kill switch → zrušení i za kill (risk-redukční výjimka INV-BRAKE-02)', async () => {
    const ctx = await setup();
    const placed = await placeEntry(ctx, 'c12kill01');
    ctx.controller.engageKillSwitch('test');
    await tick(ctx);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
  });

  it('16:10 CT za ARMED (uvnitř denní pauzy CME, díra 16:00–16:55 z oponentury P2) → zrušení „denní pauza CME“; předtím status autoCancelAt 15:55 CT', async () => {
    const ctx = await setup();
    await placeEntry(ctx, 'c12cme001');
    expect(entryStatus(ctx, 'entry:c12cme001')).toMatchObject({ autoCancelAt: Date.UTC(2026, 10, 3, 21, 55), autoCancelReason: 'cme-halt' });
    ctx.clock.now = Date.UTC(2026, 10, 3, 22, 10);
    await tick(ctx);
    const entryId = entryStatus(ctx, 'entry:c12cme001')?.entryBrokerOrderId;
    expect(ctx.broker.cancelRequestCount(entryId!)).toBe(1);
    expect(ctx.audits.some(line => line.includes('čekající vstup: denní pauza CME (16:00–17:00 CT)'))).toBe(true);
    expect(entryStatus(ctx, 'entry:c12cme001')?.autoCancelAt).toBeUndefined();
  });

  it('Market se nikdy neruší (ani neopakovaný audit „vlastní Market se neruší“)', async () => {
    const ctx = await setup();
    const placed = await placeEntry(ctx, 'c12mkt001', { orderType: 'Market' });
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.audits.filter(line => line.includes('vlastní Market se neruší'))).toEqual([]);
  });
});

describe('C12 — oponentura P1: dílčí fill, „úspěch“ adaptéru u vyplněného, předčtení, Position před Fill', () => {
  it('dílčí fill (1/2) a brzda → zbytek se NERUŠÍ, právě jeden incident (durable), další kola nic', async () => {
    const store = createMemoryCopierStore();
    const ctx = await setup({ store });
    const placed = await placeEntry(ctx, 'c12part01', { quantity: 2 });
    fillAtBroker(ctx, placed.entryBrokerOrderId!, 1, 'working');
    await tick(ctx);
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.controller.status().lastError).toMatch(/z části vyplněný \(1\/2\) a zbytek dál čeká — automaticky se neruší/);
    expect(ctx.audits.filter(line => line.includes('a zbytek dál čeká'))).toHaveLength(1);
    expect((await store.load()).safety?.manualEntries?.find(record => record.operationId === 'entry:c12part01')?.pendingIncidentAt).toEqual(expect.any(Number));
    expect(ctx.broker.liquidateRequests()).toHaveLength(0);
    // Za vypnuté kopírky viditelné i v historii vypnutí (`recordWhenDisarmed`).
    expect(ctx.controller.status().disarmHistory?.some(record => record.detail.includes('a zbytek dál čeká'))).toBe(true);
  });

  it('adaptér hlásí úspěch zrušení, ale vstup se vyplnil → pravdivě „vyplnil“, nikdy „zrušen“; nohy kryjí → bez incidentu', async () => {
    const ctx = await setup();
    const placed = await placeEntry(ctx, 'c12fill01', { quantity: 2 });
    const entryId = placed.entryBrokerOrderId!;
    const real = ctx.broker.cancelOrder.bind(ctx.broker);
    ctx.broker.cancelOrder = async (accountId, id) => { if (id === entryId) { fillAtBroker(ctx, entryId, 2, 'filled'); return; } return real(accountId, id); };
    ctx.controller.disarm('manual');
    await tick(ctx);
    expect(ctx.audits.some(line => line.startsWith('filled:Vstup se vyplnil (2) dřív, než ho broker zrušil'))).toBe(true);
    expect(ctx.audits.some(line => line.includes('vlastní vstup zrušen'))).toBe(false);
    expect(ctx.audits.some(line => line.includes('pozice chráněná SL/TP'))).toBe(true);
    expect(entryStatus(ctx, 'entry:c12fill01')?.cancelVerified).toBe('filled');
    expect(ctx.controller.status().lastError).toBeNull();
  });

  it('dílčí fill mezi předčtením a zrušením: zbytek zrušen, nohy zmizely → incident bez auto-close', async () => {
    const ctx = await setup();
    const placed = await placeEntry(ctx, 'c12race01', { quantity: 2 });
    const entryId = placed.entryBrokerOrderId!;
    ctx.broker.cancelOrder = async (_accountId, id) => {
      if (id !== entryId) return;
      fillAtBroker(ctx, entryId, 1, 'canceled');
      for (const legId of [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!]) {
        const leg = brokerOrder(ctx, legId);
        leg.status = 'canceled';
        emitOrder(ctx, leg, '9:Canceled');
      }
    };
    ctx.controller.disarm('manual');
    await tick(ctx);
    expect(entryStatus(ctx, 'entry:c12race01')?.cancelVerified).toBe('partially-filled');
    expect(ctx.controller.status().lastError).toMatch(/při rušení vyplnil \(1\) a SL\/TP pozice nejsou potvrzené/);
    expect(ctx.broker.liquidateRequests()).toHaveLength(0);
  });

  /** REST čtení vstupu napřed před streamem (cache controlleru drží starý stav — kopie, ne sdílený objekt). */
  const restAhead = (patch: Partial<BrokerOrder>) => (broker: MockBroker) => {
    const real = broker.findOrderById.bind(broker);
    broker.findOrderById = async (accountId, id) => {
      const lookup = await real(accountId, id);
      return lookup.order && lookup.order.parentOrderId == null && lookup.order.orderType === 'Limit' && lookup.order.side === 'Buy'
        ? { ...lookup, order: { ...lookup.order, ...patch } } : lookup;
    };
  };

  it('REST už ví o fillu, cache streamu ještě ne: předčtení nic nezruší (žádný pokus podle staré cache)', async () => {
    const ctx = await setup({ patchBroker: restAhead({ status: 'filled', filledQuantity: 2 }) });
    const placed = await placeEntry(ctx, 'c12rest01', { quantity: 2 });
    // REST napřed i u pozice (fill ji otevřel); stream ji zatím nedoručil (kolo 5: nohy kryjí jen nad pozicí).
    ctx.broker.setPosition(LEADER, SYM, 2);
    ctx.controller.disarm('manual');
    await tick(ctx);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    // Kolo 5 (P2): co fill znamená pro pozici, řekne až kontrola nohou a pozice (fill mohl pozici i zavřít).
    expect(ctx.audits.some(line => line.includes('se mezitím vyplnil (2) — nic se neruší; pozici a SL/TP ověřuji čtením'))).toBe(true);
    expect(ctx.controller.status().lastError).toBeNull();
  });

  it('REST: dílčí fill a vstup dál čeká (cache pozadu) → nic se neruší, incident „z části vyplněný“', async () => {
    const ctx = await setup({ patchBroker: restAhead({ filledQuantity: 1 }) });
    const placed = await placeEntry(ctx, 'c12rest02', { quantity: 2 });
    expect(brokerOrder(ctx, placed.entryBrokerOrderId!).filledQuantity).toBe(0);
    ctx.controller.disarm('manual');
    await tick(ctx);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.controller.status().lastError).toMatch(/z části vyplněný \(1\/2\) a zbytek dál čeká/);
  });

  it('Position před Fill (ARMED): pozice bez fillu kratší než ustálení se neruší; po fillu nic, žádný incident', async () => {
    const ctx = await setup();
    const placed = await placeEntry(ctx, 'c12pbf001');
    ctx.broker.setPosition(LEADER, SYM, 1);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 1 } });
    await tick(ctx, 500);
    await tick(ctx, 500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    fillAtBroker(ctx, placed.entryBrokerOrderId!, 1, 'filled');
    await tick(ctx, 3_000);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.audits.some(line => line.includes('pozice mimo appku'))).toBe(false);
  });

  it('pozice mimo appku ustálená ≥ 2 s a REST fill 0 → jedno zrušení vstupu z flat', async () => {
    const ctx = await setup();
    const placed = await placeEntry(ctx, 'c12out001');
    ctx.broker.setPosition(LEADER, SYM, 1);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 1 } });
    await tick(ctx);
    await tick(ctx, 2_100);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(ctx.audits.some(line => line.includes('čekající vstup: pozice mimo appku'))).toBe(true);
  });
});

describe('C12 — selhání, odklad, restart, souběh s ručním zrušením', () => {
  it('zrušení selže (síť) → incident u KAŽDÉHO čekajícího vstupu (i z flat), žádný druhý pokus', async () => {
    const ctx = await setup();
    const placed = await placeEntry(ctx, 'c12fail01');
    let attempts = 0;
    ctx.broker.cancelOrder = async () => { attempts += 1; throw new Error('network down'); };
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(attempts).toBe(1);
    expect(ctx.controller.status().lastError).toContain('nepodařilo zrušit');
    expect(entryStatus(ctx, 'entry:c12fail01')).toMatchObject({ cancel: 'failed', cancelVerified: 'working' });
    expect(placed.entryBrokerOrderId).toBeTruthy();
  });

  it('spojení dole → žádné čtení ani pokus; po obnově spojení jedno zrušení', async () => {
    let lookups = 0;
    const ctx = await setup({ patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => { lookups += 1; return real(accountId, id); };
    } });
    const placed = await placeEntry(ctx, 'c12conn01');
    lookups = 0;
    ctx.broker.setConnected(false);
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(lookups).toBe(0);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    ctx.broker.setConnected(true);
    await tick(ctx);
    await tick(ctx, 1_000);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
  });

  it('restart se zrušením v `sending` a vstup dál pracuje → incident jednou, žádný druhý pokus', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ store });
    const placed = await placeEntry(first, 'c12rst001');
    first.controller.stop();
    active = null;
    const snapshot = await store.load();
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualEntries: (snapshot.safety?.manualEntries ?? []).map(record => (
      record.operationId === 'entry:c12rst001' ? { ...record, cancel: { status: 'sending' as const, at: first.clock.now, reason: 'čekající vstup: kopírka je vypnutá' } } : record
    )) } }, snapshot.revision);
    const second = await setup({ store, broker: first.broker, arm: false });
    await tick(second);
    await tick(second, 1_500);
    expect(second.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(second.controller.status().lastError).toMatch(/po zrušení \(sending: čekající vstup: kopírka je vypnutá\) u brokera dál pracuje/);
    expect(second.audits.filter(line => line.includes('u brokera dál pracuje'))).toHaveLength(1);
    expect((await store.load()).safety?.manualEntries?.find(record => record.operationId === 'entry:c12rst001')?.pendingIncidentAt).toEqual(expect.any(Number));
  });

  it('restart v `sending` u vstupu z flat (bez id) → unknown + trvalý incident (oponentura P2), nic se neposílá', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ store });
    first.controller.stop();
    active = null;
    const snapshot = await store.load();
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualEntries: [{
      operationId: 'entry:c12rst002', payloadHash: 'abcdefgh12', tag: 'me0123456789abcd', status: 'sending',
      createdAt: START, updatedAt: START,
      request: { accountId: LEADER, symbol: SYM, side: 'Buy', quantity: 1, orderType: 'Limit', price: ENTRY, stopLoss: SL, takeProfit: TP },
    }] } }, snapshot.revision);
    const second = await setup({ store, broker: first.broker, arm: false });
    expect(second.controller.status().manualEntries?.[0]).toMatchObject({ operationId: 'entry:c12rst002', status: 'unknown' });
    expect(second.controller.status().lastError).toMatch(/Ruční vstup Buy 1 Limit MNQZ6: worker se restartoval během odesílání/);
    expect(second.broker.placedOsoRequests()).toEqual([]);
  });

  it('automatické zrušení běží → ruční „Zrušit čekající“ téhož vstupu se zablokuje (entry-canceling); odejde jen jeden cancel', async () => {
    let hold: (() => void) | null = null;
    let holdNext = false;
    const ctx = await setup({ patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        if (holdNext) { holdNext = false; await new Promise<void>(resolve => { hold = resolve; }); }
        return real(accountId, id);
      };
    } });
    const placed = await placeEntry(ctx, 'c12mutex1');
    const shown = ctx.controller.status().pendingOwnEntries ?? [];
    expect(shown).toHaveLength(1);
    holdNext = true;
    ctx.controller.disarm('manual');
    ctx.broker.emitEvent({ type: 'heartbeat', at: ctx.clock.now });
    await sleep(40);
    expect(hold).not.toBeNull();
    const manual = await ctx.controller.manageLeaderOrder(validateLeaderOrderManage(buildCancelPendingCommand(shown[0], {
      groupId: ctx.group.id, leaderAccountId: LEADER, operationId: 'manage:c12mutex1',
    })), { deadlineAt: ctx.clock.now + 15_000 });
    expect(manual).toMatchObject({ status: 'blocked', blockers: [expect.objectContaining({ code: 'entry-canceling' })] });
    (hold as unknown as () => void)();
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
  });

  it('ruční zrušení z appky se neprojevilo (vstup dál čeká) → po brzdě jen incident, nic se automaticky neopakuje', async () => {
    const ctx = await setup({ settleMs: 50 });
    const placed = await placeEntry(ctx, 'c12prior1');
    const entryId = placed.entryBrokerOrderId!;
    let attempts = 0;
    const real = ctx.broker.cancelOrder.bind(ctx.broker);
    ctx.broker.cancelOrder = async (accountId, id) => {
      if (id !== entryId) return real(accountId, id);
      attempts += 1;
      throw new Error('cancelOrder rejected: TooLateToCancel');
    };
    let counter = 0;
    const results = await cancelOwnPendingEntries({
      entries: ctx.controller.status().pendingOwnEntries ?? [], groupId: ctx.group.id, leaderAccountId: LEADER,
      newOperationId: () => `manage:c12prior${String(++counter).padStart(2, '0')}`,
      send: command => ctx.controller.manageLeaderOrder(validateLeaderOrderManage(command), { deadlineAt: ctx.clock.now + 15_000 }),
    });
    expect(results[0]).toMatchObject({ outcome: 'unknown' });
    ctx.clock.now += 1_000;
    await sleep(200);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().manualOrderActions?.find(action => action.operationId === 'manage:c12prior01')?.status).toBe('rejected');
    expect(attempts).toBe(1);
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(attempts).toBe(1);
    expect(ctx.controller.status().lastError).toMatch(/ruční zrušení z appky \(rejected\) se neprojevilo a vstup dál čeká — nic se automaticky neopakuje/);
  });
});

describe('C12 — nečitelný stav a „nikdy nohu“', () => {
  it('předčtení opakovaně nečitelné → nic se nezruší (žádný zápis naslepo), čtení s exponenciálním odstupem, po 3 pokusech incident; za 5 min nejvýš 6 čtení (strop, oponentura kolo 1 P3)', async () => {
    let failReads = false;
    let reads = 0;
    const ctx = await setup({ patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        if (failReads) { reads += 1; throw new Error('REST timeout'); }
        return real(accountId, id);
      };
    } });
    const placed = await placeEntry(ctx, 'c12read01');
    failReads = true;
    ctx.controller.disarm('manual');
    await tick(ctx); // t = 0: 1. čtení, další až za 5 s
    await tick(ctx, 1_000);
    expect(reads).toBe(1);
    await tick(ctx, 5_000); // t = 6: 2. čtení, další až za 10 s
    expect(reads).toBe(2);
    expect(ctx.controller.status().lastError).toBeNull();
    await tick(ctx, 5_000); // t = 11: odstup ještě běží
    expect(reads).toBe(2);
    await tick(ctx, 5_000); // t = 16: 3. čtení → incident
    expect(reads).toBe(3);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.controller.status().lastError).toMatch(/jeho stav u brokera nejde přečíst — nic se nezrušilo/);
    // Do 5 min: čtení na 36 s, 76 s, 156 s (odstup 20/40/80 s), další až po 316 s — žádné čtení každých 5 s.
    for (let elapsed = 16; elapsed < 300; elapsed += 5) await tick(ctx, 5_000);
    expect(reads).toBe(6);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.audits.filter(line => line.includes('jeho stav u brokera nejde přečíst'))).toHaveLength(1);
  });

  it('REST: vstup u brokera skončil (fill 0), cache pozadu → nic se neruší a v tomto běhu se už nečte (strop čtení, oponentura kolo 1 P3)', async () => {
    let reads = 0;
    const ctx = await setup({ patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        const lookup = await real(accountId, id);
        if (!(lookup.order && lookup.order.parentOrderId == null && lookup.order.orderType === 'Limit' && lookup.order.side === 'Buy')) return lookup;
        reads += 1;
        return { ...lookup, order: { ...lookup.order, status: 'canceled' as const } };
      };
    } });
    const placed = await placeEntry(ctx, 'c12endd01');
    reads = 0;
    ctx.controller.disarm('manual');
    await tick(ctx);
    for (let step = 0; step < 12; step += 1) await tick(ctx, 5_000);
    expect(reads).toBe(1);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.audits.filter(line => line.includes('už u brokera nečeká (canceled) — nic se neruší'))).toHaveLength(1);
    expect(ctx.controller.status().lastError).toBeNull();
  });

  it('po zrušení nejde stav ověřit ani po ustálení → incident „výsledek nejde ověřit“, ne „zrušen“', async () => {
    let failReads = false;
    const ctx = await setup({ patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        if (failReads) throw new Error('REST timeout');
        return real(accountId, id);
      };
    } });
    const placed = await placeEntry(ctx, 'c12read02');
    const realCancel = ctx.broker.cancelOrder.bind(ctx.broker);
    ctx.broker.cancelOrder = async (accountId, id) => { await realCancel(accountId, id); failReads = true; };
    ctx.controller.disarm('manual');
    await tick(ctx);
    await sleep(120);
    await ctx.controller.waitForIdle();
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(entryStatus(ctx, 'entry:c12read02')?.cancelVerified).toBe('unverified');
    expect(ctx.controller.status().lastError).toMatch(/výsledek nejde ověřit u brokera/);
    expect(ctx.audits.some(line => line.includes('vlastní vstup zrušen'))).toBe(false);
  });

  it('záznam s id SL jako vstupem (poškozený store) → automatické zrušení nohu nikdy nezruší, jen incident', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ store });
    const placed = await placeEntry(first, 'c12leg001');
    first.controller.stop();
    active = null;
    const snapshot = await store.load();
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualEntries: (snapshot.safety?.manualEntries ?? []).map(record => (
      record.operationId === 'entry:c12leg001' ? { ...record, entryBrokerOrderId: placed.stopBrokerOrderId } : record
    )) } }, snapshot.revision);
    const second = await setup({ store, broker: first.broker, arm: false });
    await tick(second);
    await tick(second, 1_500);
    expect(second.broker.cancelRequestCount(placed.stopBrokerOrderId!)).toBe(0);
    expect(second.audits.some(line => line.includes('se má zrušit (čekající vstup: kopírka je vypnutá), ale cíl zrušení je noha jiného příkazu (má parent)'))).toBe(true);
  });
});

describe('C12 — skupina s followery', () => {
  it('brzda: zrušení vstupu leadera a kopie followera zrušená lifecycle cancelem (INV-ARM-04 / BRAKE-02)', async () => {
    const ctx = await setup({ followers: true });
    const placed = await placeEntry(ctx, 'c12fol001');
    const copy = ctx.broker.orders().find(order => order.accountId === FOLLOWER && order.parentOrderId == null && order.orderType === 'Limit' && order.side === 'Buy');
    expect(copy).toBeTruthy();
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(ctx.broker.cancelRequestCount(copy!.brokerOrderId)).toBe(1);
  });

  it('follower už má na symbolu pozici z KOPIE tohoto vstupu (kopie s fillem > 0) → incident místo zrušení (vstup leadera se neruší)', async () => {
    const ctx = await setup({ followers: true });
    const placed = await placeEntry(ctx, 'c12fol002');
    const copy = ctx.broker.orders().find(order => order.accountId === FOLLOWER && order.parentOrderId == null && order.orderType === 'Limit' && order.side === 'Buy')!;
    ctx.controller.disarm('manual');
    await ctx.controller.waitForIdle();
    fillCopy(ctx, copy);
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.audits.some(line => line.includes(`follower ${FOLLOWER} už má na symbolu pozici z kopie tohoto vstupu`))).toBe(true);
  });
});

describe('C12 — skupina s followery: nepokrytá vazba', () => {
  it('on-submit follower bez navázané kopie vstupu (vazba po restartu chybí) → incident místo zrušení (jeho kopie by se nezrušila)', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ followers: true, store });
    const placed = await placeEntry(first, 'c12cov001');
    const entryId = placed.entryBrokerOrderId!;
    first.controller.stop();
    active = null;
    const snapshot = await store.load();
    expect(snapshot.links.some(([orderId]) => orderId === entryId)).toBe(true);
    await store.commit({ ...snapshot, links: snapshot.links.filter(([orderId]) => orderId !== entryId) }, snapshot.revision);
    const second = await setup({ followers: true, store, broker: first.broker, arm: false });
    await tick(second);
    await tick(second, 1_500);
    expect(second.broker.cancelRequestCount(entryId)).toBe(0);
    expect(second.audits.some(line => line.includes(`followeři ${FOLLOWER} nemají kopii vstupu navázanou`))).toBe(true);
  });
});

describe('C12 — oponentura kolo 1 (P3c): neznámá pozice followera', () => {
  it('pozice followera není známá (follower přidaný do skupiny, jeho pozice ještě nenačtené) → incident místo zrušení, vstup leadera se neruší', async () => {
    const ctx = await setup({ followers: true });
    const placed = await placeEntry(ctx, 'c12funk01');
    // Vypnutí a přidání followera v jednom kroku: revize uvidí followera, jehož pozice cache nezná.
    ctx.controller.disarm('manual');
    ctx.controller.updateGroup({ ...ctx.group, followers: [...ctx.group.followers, { accountId: FOLLOWER + 1, mode: 'on-submit', multiplier: 1 }] });
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.audits.some(line => line.includes(`pozice followera ${FOLLOWER + 1} není známá — automaticky se neruší`))).toBe(true);
  });
});

describe('C12 — capability', () => {
  it('UI tvrdí „zruší se sám“ / „zrušen“ jen s capability workeru', () => {
    expect(supportsCopierManualEntryAutoCancel({ capabilities: [COPIER_MANUAL_ENTRY_AUTO_CANCEL_CAPABILITY] })).toBe(true);
    expect(supportsCopierManualEntryAutoCancel({ capabilities: ['manual-order-cancel-pending-v1'] })).toBe(false);
    expect(supportsCopierManualEntryAutoCancel(null)).toBe(false);
  });
});

describe('C12 — oponentura kolo 1: push, ruční zrušení po neúspěchu, cache těsně před zápisem', () => {
  const pushFor = (ctx: Ctx, operationId: string) => manualEntryNotifications(
    (ctx.controller.status().manualEntries ?? []).filter(item => item.operationId === operationId), ctx.clock.now, { verifiedCancel: true },
  );

  it('P1: adaptér hlásí úspěch, vstup se vyplnil → push „vyplnil se během rušení — zkontroluj pozici a SL/TP“, nikdy „zrušený“', async () => {
    const ctx = await setup();
    const placed = await placeEntry(ctx, 'c12push01', { quantity: 2 });
    const entryId = placed.entryBrokerOrderId!;
    const real = ctx.broker.cancelOrder.bind(ctx.broker);
    ctx.broker.cancelOrder = async (accountId, id) => { if (id === entryId) { fillAtBroker(ctx, entryId, 2, 'filled'); return; } return real(accountId, id); };
    ctx.controller.disarm('manual');
    await tick(ctx);
    expect(entryStatus(ctx, 'entry:c12push01')).toMatchObject({ cancel: 'sent', cancelVerified: 'filled' });
    const [push] = pushFor(ctx, 'entry:c12push01');
    expect(push).toMatchObject({ title: 'Vstup se vyplnil během rušení', problem: true });
    expect(push.body).toContain('zkontroluj pozici a její SL/TP');
    expect(push.body).not.toContain('zrušený');
    expect(push.body).not.toContain('followeři vstup nedostali');
  });

  it('P2: automatické zrušení selže (síť) → ruční „Zrušit čekající“ se nabízí a odejde právě jednou (žádné trvalé entry-canceling)', async () => {
    const ctx = await setup();
    const placed = await placeEntry(ctx, 'c12after1');
    const entryId = placed.entryBrokerOrderId!;
    const real = ctx.broker.cancelOrder.bind(ctx.broker);
    let automatic = 0;
    let failNext = true;
    ctx.broker.cancelOrder = async (accountId, id) => {
      if (id === entryId && failNext) { failNext = false; automatic += 1; throw new Error('network down'); }
      return real(accountId, id);
    };
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(automatic).toBe(1);
    expect(ctx.controller.status().lastError).toContain('nepodařilo zrušit');
    const shown = ctx.controller.status().pendingOwnEntries ?? [];
    expect(shown.map(item => item.entryOperationId)).toEqual(['entry:c12after1']);
    const manual = await ctx.controller.manageLeaderOrder(validateLeaderOrderManage(buildCancelPendingCommand(shown[0], {
      groupId: ctx.group.id, leaderAccountId: LEADER, operationId: 'manage:c12after1',
    })), { deadlineAt: ctx.clock.now + 15_000 });
    expect(manual).toMatchObject({ status: 'acknowledged' });
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(1);
    expect(automatic).toBe(1);
    expect(brokerOrder(ctx, entryId).status).toBe('canceled');
  });

  it('P3: fill doručený streamem během durable zápisu `sending` → 0 × cancelOrder, `cancel` se vrátí na neodeslaný', async () => {
    let onSending: (() => Promise<void>) | null = null;
    const base = createMemoryCopierStore();
    const store: CopierStore = {
      load: () => base.load(),
      commit: async (snapshot, revision) => {
        if (onSending && snapshot.safety?.manualEntries?.some(record => record.cancel?.status === 'sending')) {
          const hook = onSending;
          onSending = null;
          await hook();
        }
        return base.commit(snapshot, revision);
      },
    };
    const ctx = await setup({ store: store as ReturnType<typeof createMemoryCopierStore> });
    const placed = await placeEntry(ctx, 'c12late01');
    const entryId = placed.entryBrokerOrderId!;
    onSending = async () => { fillAtBroker(ctx, entryId, 1, 'filled'); await sleep(40); };
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(onSending).toBeNull();
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(0);
    expect(entryStatus(ctx, 'entry:c12late01')?.cancel).toBeUndefined();
    expect(ctx.audits.some(line => line.includes('těsně před zrušením — nic se neodeslalo'))).toBe(true);
  });

  it('P3: předčtení — REST `canceled` s dílčím fillem 1/2 (zbytek zrušen jinde, cache pozadu), nohy zrušené → nic se neruší, nohy ověřené čtením, incident (ne „se svými nohami“)', async () => {
    const ctx = await setup({ patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        const lookup = await real(accountId, id);
        return lookup.order && lookup.order.parentOrderId == null && lookup.order.orderType === 'Limit' && lookup.order.side === 'Buy'
          ? { ...lookup, order: { ...lookup.order, status: 'canceled' as const, filledQuantity: 1 } } : lookup;
      };
    } });
    const placed = await placeEntry(ctx, 'c12endp01', { quantity: 2 });
    // U brokera (REST) nohy po dílčím zrušení zmizely a pozice je 1; stream o tom zatím nic nedoručil.
    for (const legId of [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!]) brokerOrder(ctx, legId).status = 'canceled';
    ctx.broker.setPosition(LEADER, SYM, 1);
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 1_000);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.audits.some(line => line.includes('se mezitím vyplnil (1/2) — nic se neruší; pozici a SL/TP ověřuji čtením'))).toBe(true);
    expect(ctx.audits.some(line => line.includes('se svými nohami'))).toBe(false);
    expect(ctx.controller.status().lastError).toMatch(/se při rušení vyplnil \(1\) a SL\/TP pozice nejsou potvrzené/);
    expect(entryStatus(ctx, 'entry:c12endp01')?.pendingIncident?.text).toMatch(/SL\/TP pozice nejsou potvrzené/);
  });

  it('P2: incident C12 při už otevřeném jiném incidentu → status nese `pendingIncident` a watchdog pošle per-záznamový push', async () => {
    const store = createMemoryCopierStore();
    const ctx = await setup({ store });
    const placed = await placeEntry(ctx, 'c12inc001', { quantity: 2 });
    fillAtBroker(ctx, placed.entryBrokerOrderId!, 1, 'working');
    await tick(ctx);
    ctx.controller.engageKillSwitch('jiný incident');
    await tick(ctx);
    await tick(ctx, 1_000);
    expect(ctx.controller.status().killSwitch).toBe(true);
    const status = entryStatus(ctx, 'entry:c12inc001');
    expect(status?.pendingIncident).toEqual({ at: expect.any(Number), text: expect.stringContaining('z části vyplněný (1/2) a zbytek dál čeká') });
    expect((await store.load()).safety?.manualEntries?.find(record => record.operationId === 'entry:c12inc001')?.pendingIncidentKinds).toEqual(['partial']);
    const [push] = pushFor(ctx, 'entry:c12inc001');
    expect(push).toMatchObject({ key: 'manual-entry:entry:c12inc001', problem: true, title: 'Čekající vstup: zkontroluj leadera' });
    expect(push.body).toContain('zbytek dál čeká');
    expect(push.detail).toContain(`|incident:${status!.pendingIncident!.at}`);
  });

  it('P3: dedup podle druhu — „nejde přečíst“ a později zrušení bez účinku → druhý, pravdivý incident (lastError netvrdí „nic se nezrušilo“)', async () => {
    let failReads = 0;
    const ctx = await setup({ patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        if (failReads > 0) { failReads -= 1; throw new Error('REST timeout'); }
        return real(accountId, id);
      };
    } });
    const placed = await placeEntry(ctx, 'c12kind01');
    const entryId = placed.entryBrokerOrderId!;
    const real = ctx.broker.cancelOrder.bind(ctx.broker);
    ctx.broker.cancelOrder = async (accountId, id) => { if (id === entryId) throw new Error('network down'); return real(accountId, id); };
    failReads = 3;
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 6_000);
    await tick(ctx, 10_000);
    expect(ctx.controller.status().lastError).toMatch(/nejde přečíst — nic se nezrušilo/);
    await tick(ctx, 20_000);
    await tick(ctx, 1_000);
    expect(ctx.controller.status().lastError).toMatch(/se nepodařilo zrušit/);
    expect(entryStatus(ctx, 'entry:c12kind01')?.pendingIncident?.text).toMatch(/se nepodařilo zrušit/);
  });

  it('INV-TRAD-02: Fill doručený po výsledku „zrušen“ (REST cumQty pozadu) → `cancelVerified` se opraví na fill, nohy se ověří, incident', async () => {
    const ctx = await setup();
    const placed = await placeEntry(ctx, 'c12lfil01', { quantity: 2 });
    const entryId = placed.entryBrokerOrderId!;
    ctx.controller.disarm('manual');
    await tick(ctx);
    expect(entryStatus(ctx, 'entry:c12lfil01')?.cancelVerified).toBe('canceled');
    expect(pushFor(ctx, 'entry:c12lfil01')[0]).toMatchObject({ title: 'Čekající vstup zrušen', problem: false });
    // Pozdní Fill za Order(Canceled): pozice 1, nohy zrušené s rodičem.
    for (const legId of [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!]) {
      const leg = brokerOrder(ctx, legId);
      leg.status = 'canceled';
      emitOrder(ctx, leg, '9:Canceled');
    }
    ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `late-${entryId}`, tag: brokerOrder(ctx, entryId).tag, brokerOrderId: entryId, accountId: LEADER, symbol: SYM, side: 'Buy', quantity: 1, price: ENTRY, filledAt: 4 } });
    ctx.broker.setPosition(LEADER, SYM, 1);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 1 } });
    await tick(ctx);
    await tick(ctx, 500);
    expect(entryStatus(ctx, 'entry:c12lfil01')?.cancelVerified).toBe('partially-filled');
    expect(ctx.audits.some(line => line.includes('po výsledku „zrušen“ dorazil fill (1)'))).toBe(true);
    expect(ctx.controller.status().lastError).toMatch(/se při rušení vyplnil \(1\) a SL\/TP pozice nejsou potvrzené/);
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(1);
  });
});

describe('C12 — oponentura kolo 1: odklad, typ Stop, restart po předčtení, route leadera, restart se starou cache', () => {
  it('odklad při nezpracovaných eventech leadera (ingress > 0): žádné čtení ani pokus; po zpracování jedno zrušení', async () => {
    let holdCommits = false;
    let release: (() => void) | null = null;
    const base = createMemoryCopierStore();
    const store: CopierStore = {
      load: () => base.load(),
      commit: async (snapshot, revision) => {
        if (holdCommits) { holdCommits = false; await new Promise<void>(resolve => { release = resolve; }); }
        return base.commit(snapshot, revision);
      },
    };
    let lookups = 0;
    const ctx = await setup({ store: store as ReturnType<typeof createMemoryCopierStore>, patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => { lookups += 1; return real(accountId, id); };
    } });
    const placed = await placeEntry(ctx, 'c12ingr01');
    const entryId = placed.entryBrokerOrderId!;
    lookups = 0;
    // Událost leadera, jejíž zpracování visí na zápisu, a za ní další ve frontě (ingress > 0).
    holdCommits = true;
    const foreign = { ...brokerOrder(ctx, entryId), brokerOrderId: 'foreign-1', tag: 'foreign-1', limitPrice: 24_900 };
    ctx.broker.emitEvent({ type: 'order', order: { ...foreign, sourceVersion: '1:working' } });
    await sleep(20);
    expect(release).not.toBeNull();
    ctx.broker.emitEvent({ type: 'order', order: { ...foreign, quantity: 2, sourceVersion: '2:working' } });
    ctx.controller.disarm('manual');
    await sleep(60);
    expect(lookups).toBe(0);
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(0);
    (release as unknown as () => void)();
    await tick(ctx);
    await tick(ctx, 1_000);
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(1);
  });

  it('odklad při běžící obnově spojení (recoveryInFlight): žádné čtení vstupu ani pokus; po obnově jedno zrušení', async () => {
    let holdPositions = false;
    let release: (() => void) | null = null;
    let lookups = 0;
    const ctx = await setup({ patchBroker: broker => {
      const realFind = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => { lookups += 1; return realFind(accountId, id); };
      const realPositions = broker.listPositions.bind(broker);
      broker.listPositions = async accountId => {
        if (holdPositions) { holdPositions = false; await new Promise<void>(resolve => { release = resolve; }); }
        return realPositions(accountId);
      };
    } });
    const placed = await placeEntry(ctx, 'c12recv01');
    const entryId = placed.entryBrokerOrderId!;
    ctx.broker.setConnected(false);
    await tick(ctx);
    lookups = 0;
    holdPositions = true;
    ctx.broker.setConnected(true);
    await sleep(30);
    expect(release).not.toBeNull();
    // 1s časovač revize (heartbeat by stál ve frontě za obnovou).
    await sleep(1_150);
    expect(lookups).toBe(0);
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(0);
    (release as unknown as () => void)();
    await tick(ctx);
    await tick(ctx, 1_000);
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(1);
  });

  it('vstup typu Stop: shoda typu broker ↔ záznam → jedno zrušení, ověřeno „zrušen“', async () => {
    const ctx = await setup();
    const status = ctx.controller.status();
    const preview = buildLeaderEntryPreviewCommand(
      { symbol: SYM, side: 'Buy', quantity: 1, orderType: 'Stop', price: REF + 20, stopLoss: REF - 10, takeProfit: REF + 60 },
      { group: { ...ctx.group, leaderAccountId: LEADER }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: 'preview:c12stop01' },
    );
    const placed = await ctx.controller.placeLeaderEntry(buildLeaderEntryPlaceCommand(preview, 'entry:c12stop01'), { deadlineAt: ctx.clock.now + 15_000 });
    expect(placed).toMatchObject({ status: 'acknowledged' });
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(brokerOrder(ctx, placed.entryBrokerOrderId!).orderType).toBe('Stop');
    ctx.controller.disarm('manual');
    await tick(ctx);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(entryStatus(ctx, 'entry:c12stop01')).toMatchObject({ orderType: 'Stop', cancelVerified: 'canceled' });
    expect(ctx.controller.status().lastError).toBeNull();
  });

  it('restart mezi předčtením a durable `sending`: starý běh nic neodešle, nový udělá jediný pokus', async () => {
    const store = createMemoryCopierStore();
    let hold: (() => void) | null = null;
    let holdNext = false;
    const first = await setup({ store, patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        if (holdNext) { holdNext = false; await new Promise<void>(resolve => { hold = resolve; }); }
        return real(accountId, id);
      };
    } });
    const placed = await placeEntry(first, 'c12rpre01');
    holdNext = true;
    first.controller.disarm('manual');
    first.broker.emitEvent({ type: 'heartbeat', at: first.clock.now });
    await sleep(40);
    expect(hold).not.toBeNull();
    first.controller.stop();
    active = null;
    (hold as unknown as () => void)();
    await sleep(30);
    expect(first.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect((await store.load()).safety?.manualEntries?.find(record => record.operationId === 'entry:c12rpre01')?.cancel).toBeUndefined();
    const second = await setup({ store, broker: first.broker, arm: false });
    await tick(second);
    await tick(second, 1_500);
    expect(second.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(second.controller.status().manualEntries?.find(item => item.operationId === 'entry:c12rpre01')?.cancelVerified).toBe('canceled');
  });

  it('dvě OAuth route: route leadera dole, agregát `connected` → čtení nečitelné → incident, žádný zápis (ani jinam)', async () => {
    let leaderRouteDown = false;
    const cancels: Array<[number, string]> = [];
    const ctx = await setup({ patchBroker: broker => {
      const realFind = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        if (leaderRouteDown && accountId === LEADER) throw new Error('route leader: 401 token expired');
        return realFind(accountId, id);
      };
      const realCancel = broker.cancelOrder.bind(broker);
      broker.cancelOrder = async (accountId, id) => { cancels.push([accountId, id]); return realCancel(accountId, id); };
    } });
    const placed = await placeEntry(ctx, 'c12rout01');
    leaderRouteDown = true;
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 6_000);
    await tick(ctx, 10_000);
    expect(ctx.controller.status().connected).toBe(true);
    expect(cancels).toEqual([]);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.controller.status().lastError).toMatch(/jeho stav u brokera nejde přečíst — nic se nezrušilo/);
  });

  it('P3a: restart se zrušením `sent`, cache po startu ukazuje vstup otevřený, REST už `canceled` → žádný falešný incident, nic se neposílá', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ store });
    const placed = await placeEntry(first, 'c12stal01');
    first.controller.stop();
    active = null;
    const snapshot = await store.load();
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualEntries: (snapshot.safety?.manualEntries ?? []).map(record => (
      record.operationId === 'entry:c12stal01' ? { ...record, updatedAt: START - 60_000, cancel: { status: 'sent' as const, at: first.clock.now, reason: 'čekající vstup: kopírka je vypnutá' } } : record
    )) } }, snapshot.revision);
    const second = await setup({ store, broker: first.broker, arm: false, patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        const lookup = await real(accountId, id);
        return lookup.order?.brokerOrderId === placed.entryBrokerOrderId ? { ...lookup, order: { ...lookup.order!, status: 'canceled' as const } } : lookup;
      };
    } });
    await tick(second);
    await tick(second, 1_500);
    expect(second.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(second.controller.status().lastError).toBeNull();
    // Oponentura C12 kolo 2 (P3): `sent` bez `verified` dořeší čtení po startu (bez ohledu na cache), ne revize.
    expect(second.audits.some(line => line.includes('zrušení z předchozího běhu (sent) ověřeno po startu — vstup už u brokera nečeká (canceled)'))).toBe(true);
    expect(second.controller.status().manualEntries?.find(item => item.operationId === 'entry:c12stal01')?.cancelVerified).toBe('canceled');
    expect(second.audits.some(line => line.includes('u brokera dál pracuje'))).toBe(false);
    // Jediné čtení: revize záznam čekající na ověření po startu nečte znovu.
    expect(second.audits.some(line => line.includes('cache streamu byla pozadu'))).toBe(false);
    // Ověření po startu `updatedAt` neposouvá (push o výsledku jen v okně od původního zápisu).
    expect((await store.load()).safety?.manualEntries?.find(record => record.operationId === 'entry:c12stal01')?.updatedAt).toBe(START - 60_000);
  });

  it('P3a: restart se zrušením `sent` už ověřeným jako „dál pracuje“, cache ukazuje vstup otevřený, REST už `canceled` → revize přečte REST, žádný falešný incident', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ store });
    const placed = await placeEntry(first, 'c12stal02');
    first.controller.stop();
    active = null;
    const snapshot = await store.load();
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualEntries: (snapshot.safety?.manualEntries ?? []).map(record => (
      record.operationId === 'entry:c12stal02' ? { ...record, cancel: { status: 'sent' as const, at: first.clock.now, reason: 'čekající vstup: kopírka je vypnutá', verified: 'working' as const } } : record
    )) } }, snapshot.revision);
    const second = await setup({ store, broker: first.broker, arm: false, patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        const lookup = await real(accountId, id);
        return lookup.order?.brokerOrderId === placed.entryBrokerOrderId ? { ...lookup, order: { ...lookup.order!, status: 'canceled' as const } } : lookup;
      };
    } });
    await tick(second);
    await tick(second, 1_500);
    expect(second.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(second.controller.status().lastError).toBeNull();
    expect(second.audits.some(line => line.includes('už u brokera nečeká (canceled) — cache streamu byla pozadu'))).toBe(true);
    expect(second.audits.some(line => line.includes('u brokera dál pracuje'))).toBe(false);
  });
});

/** Store, který při durable `cancel: sending` spustí hák (souběh streamu se zápisem). */
function hookedStore() {
  const base = createMemoryCopierStore();
  const box: { onSending: (() => Promise<void>) | null } = { onSending: null };
  const store: CopierStore = {
    load: () => base.load(),
    commit: async (snapshot, revision) => {
      if (box.onSending && snapshot.safety?.manualEntries?.some(record => record.cancel?.status === 'sending')) {
        const hook = box.onSending;
        box.onSending = null;
        await hook();
      }
      return base.commit(snapshot, revision);
    },
  };
  return { store: store as ReturnType<typeof createMemoryCopierStore>, box };
}
const leaderEntryAtBroker = (ctx: Ctx) => ctx.broker.orders().find(order => order.accountId === LEADER && order.parentOrderId == null && order.orderType === 'Limit' && order.side === 'Buy')!;
const pushFor2 = (ctx: Ctx, operationId: string) => manualEntryNotifications(
  (ctx.controller.status().manualEntries ?? []).filter(item => item.operationId === operationId), ctx.clock.now, { verifiedCancel: true },
);

describe('C12 — oponentura kolo 2 (P1): dílčí fill v okně pozdní kontroly = incident „zbytek dál čeká“', () => {
  for (const legQty of [1, 2]) {
    it(`předčtení → během durable \`sending\` Fill 1/2 a vstup dál pracuje (nohy qty ${legQty}) → 0 × cancel, právě jeden incident „zbytek dál čeká“, push`, async () => {
      const { store, box } = hookedStore();
      const ctx = await setup({ store });
      const placed = await placeEntry(ctx, `c12r2d${legQty}01`, { quantity: 2 });
      const entryId = placed.entryBrokerOrderId!;
      const operationId = `entry:c12r2d${legQty}01`;
      box.onSending = async () => {
        // Nohy po dílčím fillu: qty 1 = sledují fill (venue-managed, NEOVĚŘENO), qty 2 = nesledují.
        for (const legId of [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!]) {
          const leg = brokerOrder(ctx, legId);
          leg.quantity = legQty;
          leg.status = 'working';
          emitOrder(ctx, leg, `9:leg:${legQty}`);
        }
        fillAtBroker(ctx, entryId, 1, 'working');
        await sleep(40);
      };
      ctx.controller.disarm('manual');
      await tick(ctx);
      await tick(ctx, 1_500);
      await tick(ctx, 5_000);
      await tick(ctx, 60_000);
      expect(box.onSending).toBeNull();
      expect(ctx.broker.cancelRequestCount(entryId)).toBe(0);
      expect(brokerOrder(ctx, entryId)).toMatchObject({ status: 'working', filledQuantity: 1 });
      expect(ctx.audits.some(line => line.includes('se vyplnil z části (1/2) těsně před zrušením, zbytek dál čeká — nic se neodeslalo'))).toBe(true);
      expect(ctx.audits.filter(line => line.startsWith('blocked:') && line.includes('zbytek dál čeká'))).toHaveLength(1);
      expect(ctx.audits.some(line => line.includes('SL/TP pozice nejsou potvrzené'))).toBe(false);
      const status = entryStatus(ctx, operationId);
      expect(status?.cancel).toBeUndefined();
      expect(status?.pendingIncident?.text).toMatch(/z části vyplněný \(1\/2\) a zbytek dál čeká/);
      expect(ctx.controller.status().lastError).toMatch(/zbytek dál čeká/);
      expect((await store.load()).safety?.manualEntries?.find(record => record.operationId === operationId)?.pendingIncidentKinds).toEqual(['partial']);
      const [push] = pushFor2(ctx, operationId);
      expect(push).toMatchObject({ key: `manual-entry:${operationId}`, problem: true, title: 'Čekající vstup: zkontroluj leadera' });
      expect(push.body).toContain('zbytek dál čeká');
    });
  }

  it('zrušení po ACK (kopírka se vypnula během odesílání): stream stojí za během ručního vstupu, takže dílčí fill během durable `sending` cache nevidí → zrušení odejde, výsledek jen stavem (`partially-filled`), nikdy „zrušen“, nohy ověřené čtením', async () => {
    const { store, box } = hookedStore();
    const hooks: { afterPost: (() => void) | null } = { afterPost: null };
    const ctx = await setup({ store, patchBroker: broker => {
      const real = broker.placeOso!.bind(broker);
      broker.placeOso = async request => {
        const result = await real(request);
        const hook = hooks.afterPost;
        hooks.afterPost = null;
        hook?.();
        return result;
      };
    } });
    hooks.afterPost = () => ctx.controller.disarm('manual');
    box.onSending = async () => {
      fillAtBroker(ctx, leaderEntryAtBroker(ctx).brokerOrderId, 1, 'working');
      await sleep(40);
    };
    const placed = await placeEntry(ctx, 'c12r2ack1', { quantity: 2 });
    const entryId = placed.entryBrokerOrderId!;
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(box.onSending).toBeNull();
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(1);
    expect(entryStatus(ctx, 'entry:c12r2ack1')).toMatchObject({ cancel: 'sent', cancelVerified: 'partially-filled' });
    expect(ctx.audits.some(line => line.includes('vlastní vstup zrušen'))).toBe(false);
    expect(entryStatus(ctx, 'entry:c12r2ack1')?.pendingIncident?.text).toMatch(/se při rušení vyplnil \(1\) a SL\/TP pozice nejsou potvrzené/);
  });

  // Cesta bez předčtení z eventů (ochranné nohy nedorazily — stream nohy nedoručí): job zrušení běží
  // mimo frontu eventů, takže stream může během durable `sending` doručit fill.
  const dropLegEvents = (broker: MockBroker) => {
    const realSubscribe = broker.subscribe.bind(broker);
    broker.subscribe = listener => realSubscribe(event => {
      if (event.type === 'order' && event.order.parentOrderId != null && event.order.accountId === LEADER) return;
      listener(event);
    });
  };
  /** Čekání na nohy (legWait 300 ms podle hodin controlleru) vyprší: hodiny se posunou za běhu vstupu. */
  const legTimeout = (ctx: Ctx) => {
    const timer = setTimeout(() => { ctx.clock.now += 1_000; }, 150);
    return async () => { await sleep(250); clearTimeout(timer); };
  };

  it('zrušení bez předčtení (ochranné nohy nedorazily) → Fill 1/2 během durable `sending`, vstup dál pracuje → 0 × cancel, incident „zbytek dál čeká“', async () => {
    const { store, box } = hookedStore();
    const ctx = await setup({ store, patchBroker: dropLegEvents });
    box.onSending = async () => {
      fillAtBroker(ctx, leaderEntryAtBroker(ctx).brokerOrderId, 1, 'working');
      await sleep(40);
    };
    const placed = await placeEntry(ctx, 'c12r2nop1', { quantity: 2 }, legTimeout(ctx));
    const entryId = placed.entryBrokerOrderId!;
    await tick(ctx);
    await tick(ctx, 1_500);
    await tick(ctx, 5_000);
    expect(box.onSending).toBeNull();
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(0);
    expect(brokerOrder(ctx, entryId)).toMatchObject({ status: 'working', filledQuantity: 1 });
    expect(ctx.audits.some(line => line.includes('se vyplnil z části (1/2) těsně před zrušením, zbytek dál čeká — nic se neodeslalo (ochranné nohy nedorazily)'))).toBe(true);
    expect(entryStatus(ctx, 'entry:c12r2nop1')?.cancel).toBeUndefined();
    expect(entryStatus(ctx, 'entry:c12r2nop1')?.pendingIncident?.text).toMatch(/z části vyplněný \(1\/2\) a zbytek dál čeká/);
    expect(ctx.audits.some(line => line.includes('SL/TP pozice nejsou potvrzené'))).toBe(false);
  });

  it('zrušení bez předčtení (ochranné nohy nedorazily) → plný fill během durable `sending`, nohy u brokera zmizely → 0 × cancel, nohy ověřené čtením → incident „SL/TP nepotvrzené“', async () => {
    const { store, box } = hookedStore();
    const ctx = await setup({ store, patchBroker: dropLegEvents });
    box.onSending = async () => {
      const entry = leaderEntryAtBroker(ctx);
      for (const leg of ctx.broker.orders().filter(order => order.parentOrderId === entry.brokerOrderId)) leg.status = 'canceled';
      fillAtBroker(ctx, entry.brokerOrderId, 2, 'filled');
      await sleep(40);
    };
    const placed = await placeEntry(ctx, 'c12r2nop2', { quantity: 2 }, legTimeout(ctx));
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(box.onSending).toBeNull();
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.audits.some(line => line.includes('se vyplnil (2) těsně před zrušením — nic se neodeslalo (ochranné nohy nedorazily)'))).toBe(true);
    expect(entryStatus(ctx, 'entry:c12r2nop2')?.pendingIncident?.text).toMatch(/se při rušení vyplnil \(2\) a SL\/TP pozice nejsou potvrzené/);
  });

  it('memo kontroly nohou drží fill: po „z části vyplněn“ (REST cumQty 1) dorazí ze streamu fill 2, nohy kryjí jen 1 → nohy se ověří znovu → incident', async () => {
    const ctx = await setup();
    const placed = await placeEntry(ctx, 'c12r2mem1', { quantity: 2 });
    const entryId = placed.entryBrokerOrderId!;
    const legs = [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!];
    const real = ctx.broker.cancelOrder.bind(ctx.broker);
    let entryCancels = 0;
    ctx.broker.cancelOrder = async (accountId, id) => {
      if (id !== entryId) return real(accountId, id);
      entryCancels += 1;
      // Broker zrušil zbytek po fillu 1 (REST cumQty 1); nohy sledují fill 1.
      for (const legId of legs) { const leg = brokerOrder(ctx, legId); leg.quantity = 1; emitOrder(ctx, leg, '9:leg:1'); }
      fillAtBroker(ctx, entryId, 1, 'canceled');
    };
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 1_000);
    expect(entryStatus(ctx, 'entry:c12r2mem1')?.cancelVerified).toBe('partially-filled');
    expect(ctx.audits.some(line => line.includes('pozice chráněná SL/TP (ověřeno čtením)'))).toBe(true);
    expect(entryStatus(ctx, 'entry:c12r2mem1')?.pendingIncident).toBeUndefined();
    // Stream doručí opožděný druhý fill (REST cumQty byl pozadu); nohy u brokera dál kryjí jen 1.
    ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `f-${entryId}-late`, tag: brokerOrder(ctx, entryId).tag, brokerOrderId: entryId, accountId: LEADER, symbol: SYM, side: 'Buy', quantity: 1, price: ENTRY, filledAt: 4 } });
    ctx.broker.setPosition(LEADER, SYM, 2);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 2 } });
    await tick(ctx);
    await tick(ctx, 1_000);
    expect(entryCancels).toBe(1);
    expect(entryStatus(ctx, 'entry:c12r2mem1')?.cancelVerified).toBe('filled');
    expect(entryStatus(ctx, 'entry:c12r2mem1')?.pendingIncident?.text).toMatch(/se při rušení vyplnil \(2\) a SL\/TP pozice nejsou potvrzené/);
  });
});

describe('C12 — oponentura kolo 2 (P3): restart bez ověřeného výsledku zrušení', () => {
  it('restart v `cancel: sending`, vstup mezitím u brokera zrušen s fillem 1/2 a nohy zmizely (cache ho neukazuje) → čtení po startu: `partially-filled`, incident `fill-unprotected`, nic se neposílá', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ store });
    const placed = await placeEntry(first, 'c12r2rst1', { quantity: 2 });
    const entryId = placed.entryBrokerOrderId!;
    first.controller.stop();
    active = null;
    // Během výpadku workeru: broker vstup zrušil s cumQty 1/2, nohy kaskádou zmizely (NEOVĚŘENÁ kaskáda), pozice 1.
    Object.assign(brokerOrder(first, entryId), { status: 'canceled', filledQuantity: 1 });
    for (const legId of [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!]) brokerOrder(first, legId).status = 'canceled';
    first.broker.setPosition(LEADER, SYM, 1);
    const snapshot = await store.load();
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualEntries: (snapshot.safety?.manualEntries ?? []).map(record => (
      record.operationId === 'entry:c12r2rst1' ? { ...record, cancel: { status: 'sending' as const, at: first.clock.now, reason: 'čekající vstup: kopírka je vypnutá' } } : record
    )) } }, snapshot.revision);
    const second = await setup({ store, broker: first.broker, arm: false });
    await tick(second);
    await tick(second, 1_500);
    expect(second.broker.cancelRequestCount(entryId)).toBe(0);
    const status = entryStatus(second, 'entry:c12r2rst1');
    expect(status).toMatchObject({ cancel: 'sending', cancelVerified: 'partially-filled' });
    expect(status?.pendingIncident?.text).toMatch(/se při rušení vyplnil \(1\) a SL\/TP pozice nejsou potvrzené/);
    expect((await store.load()).safety?.manualEntries?.find(record => record.operationId === 'entry:c12r2rst1')?.pendingIncidentKinds).toContain('fill-unprotected');
    expect(second.audits.some(line => line.includes('po zrušení z předchozího běhu (sending) se vstup vyplnil (1/2)'))).toBe(true);
    const [push] = pushFor2(second, 'entry:c12r2rst1');
    expect(push).toMatchObject({ problem: true, title: 'Čekající vstup: zkontroluj leadera' });
  });

  it('restart v `cancel: sending` a REST nečitelný → `unverified`, incident „nejde po startu ověřit“, nic se neposílá', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ store });
    const placed = await placeEntry(first, 'c12r2rst3');
    const entryId = placed.entryBrokerOrderId!;
    first.controller.stop();
    active = null;
    // Vstup u brokera mezitím skončil (cache po startu ho neukazuje), jeho stav ale nejde přečíst.
    brokerOrder(first, entryId).status = 'canceled';
    const snapshot = await store.load();
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualEntries: (snapshot.safety?.manualEntries ?? []).map(record => (
      record.operationId === 'entry:c12r2rst3' ? { ...record, cancel: { status: 'sending' as const, at: first.clock.now, reason: 'čekající vstup: kopírka je vypnutá' } } : record
    )) } }, snapshot.revision);
    const second = await setup({ store, broker: first.broker, arm: false, patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        if (id === entryId) throw new Error('REST 503');
        return real(accountId, id);
      };
    } });
    await tick(second);
    await tick(second, 1_500);
    expect(second.broker.cancelRequestCount(entryId)).toBe(0);
    expect(entryStatus(second, 'entry:c12r2rst3')).toMatchObject({ cancel: 'sending', cancelVerified: 'unverified' });
    expect(entryStatus(second, 'entry:c12r2rst3')?.pendingIncident?.text).toMatch(/výsledek zrušení z předchozího běhu \(sending\) nejde po startu ověřit u brokera/);
  });

  it('restart v `cancel: sending`, vstup dál pracuje → incident „dál pracuje“; „Zrušit čekající“ ho nabídne a ruční cancel-entry odejde právě jednou', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ store });
    const placed = await placeEntry(first, 'c12r2rst2');
    const entryId = placed.entryBrokerOrderId!;
    first.controller.stop();
    active = null;
    const snapshot = await store.load();
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualEntries: (snapshot.safety?.manualEntries ?? []).map(record => (
      record.operationId === 'entry:c12r2rst2' ? { ...record, cancel: { status: 'sending' as const, at: first.clock.now, reason: 'čekající vstup: kopírka je vypnutá' } } : record
    )) } }, snapshot.revision);
    const second = await setup({ store, broker: first.broker, arm: false });
    await tick(second);
    await tick(second, 1_500);
    expect(second.broker.cancelRequestCount(entryId)).toBe(0);
    expect(second.controller.status().lastError).toMatch(/po zrušení \(sending: čekající vstup: kopírka je vypnutá\) u brokera dál pracuje/);
    expect(entryStatus(second, 'entry:c12r2rst2')).toMatchObject({ cancel: 'sending', cancelVerified: 'working' });
    const shown = second.controller.status().pendingOwnEntries ?? [];
    expect(shown.map(item => item.entryOperationId)).toEqual(['entry:c12r2rst2']);
    const manual = await second.controller.manageLeaderOrder(validateLeaderOrderManage(buildCancelPendingCommand(shown[0], {
      groupId: second.group.id, leaderAccountId: LEADER, operationId: 'manage:c12r2rst2',
    })), { deadlineAt: second.clock.now + 15_000 });
    expect(manual).toMatchObject({ status: 'acknowledged' });
    await tick(second, 1_500);
    expect(second.broker.cancelRequestCount(entryId)).toBe(1);
    expect(brokerOrder(second, entryId).status).toBe('canceled');
  });
});

describe('C12 — oponentura kolo 2 (P3): přehodnocení důvodu těsně před zápisem, odklad', () => {
  it('ARM během zdrženého předčtení (důvod „kopírka je vypnutá“ pominul) → 0 × cancel, `cancel` neodeslaný, pokračování nezamítnuté; další brzda = jediný pokus', async () => {
    let hold: (() => void) | null = null;
    let holdNext = false;
    const ctx = await setup({ patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        if (holdNext) { holdNext = false; await new Promise<void>(resolve => { hold = resolve; }); }
        return real(accountId, id);
      };
    } });
    const placed = await placeEntry(ctx, 'c12r2arm1');
    const entryId = placed.entryBrokerOrderId!;
    holdNext = true;
    ctx.controller.disarm('manual');
    ctx.broker.emitEvent({ type: 'heartbeat', at: ctx.clock.now });
    await sleep(40);
    expect(hold).not.toBeNull();
    ctx.controller.arm();
    expect(ctx.controller.status().armed).toBe(true);
    (hold as unknown as () => void)();
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(0);
    expect(entryStatus(ctx, 'entry:c12r2arm1')?.cancel).toBeUndefined();
    expect(ctx.audits.some(line => line.includes('důvod zrušení pominul (čekající vstup: kopírka je vypnutá) — nic se neodeslalo'))).toBe(true);
    expect(ctx.audits.some(line => line.includes('automatické pokračování po výpadku zrušeno: čekající vstup zrušen'))).toBe(false);
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(1);
    expect(entryStatus(ctx, 'entry:c12r2arm1')?.cancelVerified).toBe('canceled');
  });

  it('spojení spadne během durable `sending` → nic neodejde (odklad), po obnově spojení jediný pokus', async () => {
    const { store, box } = hookedStore();
    const ctx = await setup({ store });
    const placed = await placeEntry(ctx, 'c12r2dfr1');
    const entryId = placed.entryBrokerOrderId!;
    box.onSending = async () => { ctx.broker.setConnected(false); await sleep(30); };
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(box.onSending).toBeNull();
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(0);
    expect(ctx.audits.some(line => line.includes('spojení k brokerovi dole nebo běží jeho obnova — zrušení odloženo, nic se neodeslalo'))).toBe(true);
    expect(entryStatus(ctx, 'entry:c12r2dfr1')?.cancel).toBeUndefined();
    ctx.broker.setConnected(true);
    await tick(ctx);
    await tick(ctx, 1_000);
    await tick(ctx, 1_000);
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(1);
    expect(entryStatus(ctx, 'entry:c12r2dfr1')?.cancelVerified).toBe('canceled');
  });
});

describe('C12 — oponentura kolo 2 (P3): followeři a kill', () => {
  it('vyřazený follower (enabled:false) s vlastní pozicí na symbolu zrušení leadera neblokuje; kopie zapojeného followera zrušená lifecycle cancelem', async () => {
    const FOLLOWER_OFF = FOLLOWER + 1;
    const ctx = await setup({
      group: { ...followerGroup(), followers: [{ accountId: FOLLOWER, mode: 'on-submit', multiplier: 1 }, { accountId: FOLLOWER_OFF, mode: 'on-submit', multiplier: 1, enabled: false }] },
      patchBroker: broker => broker.setPosition(FOLLOWER_OFF, SYM, 1),
    });
    expect(ctx.controller.status().armed).toBe(true);
    const placed = await placeEntry(ctx, 'c12r2off1');
    const copy = ctx.broker.orders().find(order => order.accountId === FOLLOWER && order.parentOrderId == null && order.orderType === 'Limit' && order.side === 'Buy');
    expect(copy).toBeTruthy();
    expect(ctx.broker.orders().some(order => order.accountId === FOLLOWER_OFF)).toBe(false);
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(ctx.broker.cancelRequestCount(copy!.brokerOrderId)).toBe(1);
    expect(ctx.audits.some(line => line.includes(`follower ${FOLLOWER_OFF} už má na symbolu pozici`))).toBe(false);
  });

  it('follower s vazbou na vstup (kopie), který se mezitím vyřadil a jeho kopie se vyplnila → dál se počítá: incident místo zrušení leadera', async () => {
    const ctx = await setup({ followers: true });
    const placed = await placeEntry(ctx, 'c12r2lnk1');
    const copy = ctx.broker.orders().find(order => order.accountId === FOLLOWER && order.parentOrderId == null && order.orderType === 'Limit' && order.side === 'Buy');
    expect(copy).toBeTruthy();
    ctx.controller.disarm('manual');
    // Follower se vyřadí (konfigurace) a jeho kopie se mezitím vyplní — pozici má z vazby na tento vstup.
    ctx.controller.updateGroup({ ...ctx.group, followers: [{ accountId: FOLLOWER, mode: 'on-submit', multiplier: 1, enabled: false }] });
    fillCopy(ctx, copy!);
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.audits.some(line => line.includes(`follower ${FOLLOWER} už má na symbolu pozici`))).toBe(true);
  });

  it('kill switch se skupinou s followery → zrušení vstupu leadera (1×) a kopie followera zrušená lifecycle cancelem (1×)', async () => {
    const ctx = await setup({ followers: true });
    const placed = await placeEntry(ctx, 'c12r2kil1');
    const copy = ctx.broker.orders().find(order => order.accountId === FOLLOWER && order.parentOrderId == null && order.orderType === 'Limit' && order.side === 'Buy');
    expect(copy).toBeTruthy();
    ctx.controller.engageKillSwitch('test');
    await tick(ctx);
    await tick(ctx, 500);
    await tick(ctx, 2_000);
    expect(ctx.controller.status().killSwitch).toBe(true);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(ctx.broker.cancelRequestCount(copy!.brokerOrderId)).toBe(1);
    expect(brokerOrder(ctx, copy!.brokerOrderId).status).toBe('canceled');
  });

  it('kill switch + automatické zrušení selže (síť) → ruční „Zrušit čekající“ se pod kill nabídne a odejde právě jednou', async () => {
    const ctx = await setup();
    const placed = await placeEntry(ctx, 'c12r2kil2');
    const entryId = placed.entryBrokerOrderId!;
    const real = ctx.broker.cancelOrder.bind(ctx.broker);
    let automatic = 0;
    let failNext = true;
    ctx.broker.cancelOrder = async (accountId, id) => {
      if (id === entryId && failNext) { failNext = false; automatic += 1; throw new Error('network down'); }
      return real(accountId, id);
    };
    ctx.controller.engageKillSwitch('test');
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(ctx.controller.status().killSwitch).toBe(true);
    expect(automatic).toBe(1);
    expect(entryStatus(ctx, 'entry:c12r2kil2')?.pendingIncident?.text).toContain('nepodařilo zrušit');
    const shown = ctx.controller.status().pendingOwnEntries ?? [];
    expect(shown.map(item => item.entryOperationId)).toEqual(['entry:c12r2kil2']);
    const manual = await ctx.controller.manageLeaderOrder(validateLeaderOrderManage(buildCancelPendingCommand(shown[0], {
      groupId: ctx.group.id, leaderAccountId: LEADER, operationId: 'manage:c12r2kil2',
    })), { deadlineAt: ctx.clock.now + 15_000 });
    expect(manual).toMatchObject({ status: 'acknowledged' });
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(1);
    expect(automatic).toBe(1);
    expect(brokerOrder(ctx, entryId).status).toBe('canceled');
  });
});

describe('C12 — oponentura kolo 3 (P2): TooLateToCancel rozhodne čtení po ustálení', () => {
  it('broker zrušení odmítne (TooLateToCancel), první REST čtení ještě `working 0`, druhé `filled` → žádný incident „dál čeká“, výsledek `filled`, push „zkontroluj pozici a SL/TP“', async () => {
    let entryIdRef = '';
    let staleReads = 2;
    let attempts = 0;
    const ctx = await setup({ settleMs: 400, patchBroker: broker => {
      const realFind = broker.findOrderById.bind(broker);
      broker.cancelOrder = async (_accountId, id) => {
        attempts += 1;
        const entry = broker.orders().find(order => order.brokerOrderId === id)!;
        entry.status = 'filled';
        entry.filledQuantity = entry.quantity;
        // Fill otevřel pozici (REST; stream ji nedoručí — kolo 5: nohy kryjí jen nad pozicí).
        broker.setPosition(LEADER, SYM, entry.quantity);
        throw new Error('Order rejected: TooLateToCancel');
      };
      broker.findOrderById = async (accountId, id) => {
        const result = await realFind(accountId, id);
        // Předčtení (#1) a první ověření (#2) ještě fill neukazují (REST pozadu za odmítnutím).
        if (id === entryIdRef && result.order && staleReads > 0) {
          staleReads -= 1;
          return { ...result, order: { ...result.order, status: 'working' as const, filledQuantity: 0 } };
        }
        return result;
      };
    } });
    const placed = await placeEntry(ctx, 'c12r3tlc1');
    entryIdRef = placed.entryBrokerOrderId!;
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 100);
    // Po prvním čtení: nic rozhodnuto, žádný incident ani výsledek.
    expect(attempts).toBe(1);
    expect(staleReads).toBe(0);
    expect(ctx.controller.status().lastError).toBeNull();
    expect(entryStatus(ctx, 'entry:c12r3tlc1')?.cancelVerified).toBeUndefined();
    expect(entryStatus(ctx, 'entry:c12r3tlc1')?.pendingIncident).toBeUndefined();
    await sleep(450);
    await tick(ctx, 100);
    await sleep(50);
    await ctx.controller.waitForIdle();
    const status = entryStatus(ctx, 'entry:c12r3tlc1');
    expect(status).toMatchObject({ cancel: 'failed', cancelVerified: 'filled' });
    expect(status?.pendingIncident).toBeUndefined();
    expect(ctx.controller.status().lastError ?? '').not.toContain('dál čeká');
    expect(ctx.audits.some(line => line.includes('se nepodařilo zrušit'))).toBe(false);
    const [push] = pushFor2(ctx, 'entry:c12r3tlc1');
    expect(push).toMatchObject({ title: 'Vstup se vyplnil během rušení', problem: true });
    expect(push.body).toContain('zkontroluj pozici a její SL/TP');
    expect(push.body).not.toContain('dál čeká');
    expect(attempts).toBe(1);
  });

  it('broker zrušení odmítne a vstup po ustálení dál čeká → teprve druhé čtení vyhlásí „nepodařilo zrušit“ (jednou), nic se neopakuje', async () => {
    const ctx = await setup({ settleMs: 400 });
    const placed = await placeEntry(ctx, 'c12r3tlc2');
    const entryId = placed.entryBrokerOrderId!;
    let attempts = 0;
    ctx.broker.cancelOrder = async () => { attempts += 1; throw new Error('Order rejected: TooLateToCancel'); };
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 100);
    expect(attempts).toBe(1);
    expect(ctx.controller.status().lastError).toBeNull();
    await sleep(450);
    await tick(ctx, 100);
    await sleep(50);
    await ctx.controller.waitForIdle();
    expect(entryStatus(ctx, 'entry:c12r3tlc2')).toMatchObject({ cancel: 'failed', cancelVerified: 'working' });
    expect(ctx.controller.status().lastError).toContain('nepodařilo zrušit');
    expect(attempts).toBe(1);
    expect(brokerOrder(ctx, entryId).status).toBe('working');
  });
});

describe('C12 — oponentura kolo 3 (P2): followeři — blokuje jen pozice z TOHOTO vstupu', () => {
  it('ARMED, ruční obchod v Tradovate zkopírovaný followerovi (pozice mimo appku), kopie vstupu má fill 0 → vstup leadera 1× a kopie 1× zrušené, ARM zůstane, žádný incident', async () => {
    const ctx = await setup({ followers: true });
    const placed = await placeEntry(ctx, 'c12r3fol1');
    const copy = ctx.broker.orders().find(order => order.accountId === FOLLOWER && order.parentOrderId == null && order.orderType === 'Limit' && order.side === 'Buy')!;
    expect(copy).toBeTruthy();
    expect(ctx.controller.status().armed).toBe(true);
    ctx.broker.setPosition(LEADER, SYM, 1);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 1 } });
    ctx.broker.setPosition(FOLLOWER, SYM, 1);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: FOLLOWER, symbol: SYM, netQuantity: 1 } });
    await tick(ctx);
    await tick(ctx, 2_100);
    await tick(ctx, 1_000);
    await tick(ctx, 500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(ctx.broker.cancelRequestCount(copy.brokerOrderId)).toBe(1);
    expect(brokerOrder(ctx, copy.brokerOrderId).status).toBe('canceled');
    expect(ctx.controller.status().armed).toBe(true);
    expect(ctx.controller.status().lastError).toBeNull();
    expect(ctx.audits.some(line => line.includes('už má na symbolu pozici'))).toBe(false);
    expect(entryStatus(ctx, 'entry:c12r3fol1')).toMatchObject({ cancelVerified: 'canceled' });
  });

  it('kopie vstupu u followera s fillem > 0 (pozice z tohoto vstupu) → incident bez zrušení leadera i kopie', async () => {
    const ctx = await setup({ followers: true });
    const placed = await placeEntry(ctx, 'c12r3fol2');
    const copy = ctx.broker.orders().find(order => order.accountId === FOLLOWER && order.parentOrderId == null && order.orderType === 'Limit' && order.side === 'Buy')!;
    ctx.controller.disarm('manual');
    fillCopy(ctx, copy, 1);
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.broker.cancelRequestCount(copy.brokerOrderId)).toBe(0);
    expect(entryStatus(ctx, 'entry:c12r3fol2')?.pendingIncident?.text).toContain(`follower ${FOLLOWER} už má na symbolu pozici z kopie tohoto vstupu`);
  });

  it('stav kopie vstupu nejde přečíst (vazba je, kopie v cache není) a follower má pozici → incident místo zrušení', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ followers: true, store });
    const placed = await placeEntry(first, 'c12r3fol3');
    const entryId = placed.entryBrokerOrderId!;
    first.controller.stop();
    active = null;
    const snapshot = await store.load();
    // Vazba po restartu ukazuje na kopii, kterou broker (a tedy cache) nezná; follower drží pozici.
    await store.commit({ ...snapshot, links: snapshot.links.map(([orderId, links]) => [orderId, orderId === entryId
      ? links.map(link => ({ ...link, brokerOrderId: 'copy-unknown-1' })) : links] as typeof snapshot.links[number]) }, snapshot.revision);
    first.broker.setPosition(FOLLOWER, SYM, 1);
    const second = await setup({ followers: true, store, broker: first.broker, arm: false });
    await tick(second);
    await tick(second, 1_500);
    expect(second.broker.cancelRequestCount(entryId)).toBe(0);
    expect(second.audits.some(line => line.includes(`follower ${FOLLOWER} už má na symbolu pozici (stav kopie tohoto vstupu nejde ověřit)`))).toBe(true);
  });

  it('C7 ruční „Zrušit čekající“: follower má pozici odjinud (kopie vstupu fill 0) → zrušení projde (vstup i kopie); kopie s fillem > 0 → follower-has-position', async () => {
    const ctx = await setup({ followers: true });
    const placed = await placeEntry(ctx, 'c12r3c7a1');
    const copy = ctx.broker.orders().find(order => order.accountId === FOLLOWER && order.parentOrderId == null && order.orderType === 'Limit' && order.side === 'Buy')!;
    ctx.broker.setPosition(FOLLOWER, SYM, 1);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: FOLLOWER, symbol: SYM, netQuantity: 1 } });
    ctx.broker.setPosition(LEADER, SYM, 0);
    await tick(ctx);
    // Kolo 4 (P2): pozice followera „odjinud“ až po ustálení (Position mohla předběhnout Order/Fill kopie).
    await tick(ctx, 2_100);
    const shown = ctx.controller.status().pendingOwnEntries ?? [];
    expect(shown.map(item => item.entryOperationId)).toEqual(['entry:c12r3c7a1']);
    const manual = await ctx.controller.manageLeaderOrder(validateLeaderOrderManage(buildCancelPendingCommand(shown[0], {
      groupId: ctx.group.id, leaderAccountId: LEADER, operationId: 'manage:c12r3c7a1',
    })), { deadlineAt: ctx.clock.now + 15_000 });
    expect(manual).toMatchObject({ status: 'acknowledged' });
    await tick(ctx, 1_500);
    await tick(ctx, 500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(ctx.broker.cancelRequestCount(copy.brokerOrderId)).toBe(1);
    ctx.controller.stop();
    active = null;

    const other = await setup({ followers: true });
    const placed2 = await placeEntry(other, 'c12r3c7b1');
    const copy2 = other.broker.orders().find(order => order.accountId === FOLLOWER && order.parentOrderId == null && order.orderType === 'Limit' && order.side === 'Buy')!;
    fillCopy(other, copy2, 1);
    await tick(other);
    const shown2 = other.controller.status().pendingOwnEntries ?? [];
    expect(shown2.map(item => item.entryOperationId)).toEqual(['entry:c12r3c7b1']);
    const blocked = await other.controller.manageLeaderOrder(validateLeaderOrderManage(buildCancelPendingCommand(shown2[0], {
      groupId: other.group.id, leaderAccountId: LEADER, operationId: 'manage:c12r3c7b1',
    })), { deadlineAt: other.clock.now + 15_000 });
    expect(blocked).toMatchObject({ status: 'blocked' });
    expect(JSON.stringify(blocked)).toContain('follower-has-position');
    expect(other.broker.cancelRequestCount(placed2.entryBrokerOrderId!)).toBe(0);
  });
});

describe('C12 — oponentura kolo 3 (P3): nohy před výsledkem, značka „nohy ověřeny“, restart', () => {
  /** Store, který po „pádu“ workeru nic nezapíše (stop() sám běžící job neukončí). */
  const crashableStore = () => {
    const base = createMemoryCopierStore();
    const box = { dead: false };
    const store: CopierStore = {
      load: () => base.load(),
      commit: async (snapshot, revision) => {
        if (box.dead) throw new Error('worker spadl');
        return base.commit(snapshot, revision);
      },
    };
    return { store: store as ReturnType<typeof createMemoryCopierStore>, base, box };
  };
  it('restart se stavem `verified: filled` bez značky „nohy ověřeny“ (pád mezi), nohy u brokera zrušené → po startu kontrola nohou → incident `fill-unprotected`, značka se zapíše', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ store });
    const placed = await placeEntry(first, 'c12r3lg01');
    const entryId = placed.entryBrokerOrderId!;
    first.controller.stop();
    active = null;
    Object.assign(brokerOrder(first, entryId), { status: 'filled', filledQuantity: 1 });
    for (const legId of [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!]) brokerOrder(first, legId).status = 'canceled';
    first.broker.setPosition(LEADER, SYM, 1);
    const snapshot = await store.load();
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualEntries: (snapshot.safety?.manualEntries ?? []).map(record => (
      record.operationId === 'entry:c12r3lg01' ? { ...record, cancel: { status: 'sent' as const, at: first.clock.now, reason: 'čekající vstup: kopírka je vypnutá', verified: 'filled' as const, fillQty: 1 } } : record
    )) } }, snapshot.revision);
    const second = await setup({ store, broker: first.broker, arm: false });
    await tick(second);
    await tick(second, 1_500);
    await tick(second, 1_000);
    expect(second.broker.cancelRequestCount(entryId)).toBe(0);
    expect(second.controller.status().lastError).toMatch(/se při rušení vyplnil \(1\) a SL\/TP pozice nejsou potvrzené/);
    const durable = (await store.load()).safety?.manualEntries?.find(record => record.operationId === 'entry:c12r3lg01');
    expect(durable?.pendingIncidentKinds).toContain('fill-unprotected');
    expect(durable?.cancel).toMatchObject({ verified: 'filled', fillQty: 1 });
    expect(durable?.cancel?.legsCheckedAt).toEqual(expect.any(Number));
  });

  it('restart se stavem `verified: filled` A se značkou „nohy ověřeny“ → po startu se nic nečte ani nehlásí', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ store });
    const placed = await placeEntry(first, 'c12r3lg02');
    const entryId = placed.entryBrokerOrderId!;
    first.controller.stop();
    active = null;
    Object.assign(brokerOrder(first, entryId), { status: 'filled', filledQuantity: 1 });
    for (const legId of [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!]) brokerOrder(first, legId).status = 'canceled';
    first.broker.setPosition(LEADER, SYM, 1);
    const snapshot = await store.load();
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualEntries: (snapshot.safety?.manualEntries ?? []).map(record => (
      record.operationId === 'entry:c12r3lg02' ? { ...record, cancel: { status: 'sent' as const, at: first.clock.now, reason: 'x', verified: 'filled' as const, fillQty: 1, legsCheckedAt: first.clock.now } } : record
    )) } }, snapshot.revision);
    const second = await setup({ store, broker: first.broker, arm: false });
    await tick(second);
    await tick(second, 1_500);
    expect(second.audits.some(line => line.includes('SL/TP se před pádem neověřily'))).toBe(false);
  });

  it('pád během kontroly nohou po odmítnutém / „úspěšném“ zrušení vyplněného vstupu → výsledek se neuloží dřív než nohy; nový běh nohy ověří → incident', async () => {
    const { store, base, box } = crashableStore();
    let legIds: string[] = [];
    let crash: (() => void) | null = null;
    const first = await setup({ store, patchBroker: broker => {
      const realFind = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        if (crash && legIds.includes(id)) { const stop = crash; crash = null; stop(); return new Promise(() => undefined); }
        return realFind(accountId, id);
      };
    } });
    const placed = await placeEntry(first, 'c12r3lg03');
    const entryId = placed.entryBrokerOrderId!;
    legIds = [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!];
    const real = first.broker.cancelOrder.bind(first.broker);
    let attempts = 0;
    first.broker.cancelOrder = async (accountId, id) => {
      if (id === entryId) {
        attempts += 1;
        // Vyplnil se během rušení; nohy kaskádou zmizely (NEOVĚŘENÁ kaskáda).
        Object.assign(brokerOrder(first, entryId), { status: 'filled', filledQuantity: 1 });
        for (const legId of legIds) brokerOrder(first, legId).status = 'canceled';
        first.broker.setPosition(LEADER, SYM, 1);
        return;
      }
      return real(accountId, id);
    };
    crash = () => { box.dead = true; first.controller.stop(); };
    first.controller.disarm('manual');
    await tick(first);
    await sleep(200);
    active = null;
    const durable = (await store.load()).safety?.manualEntries?.find(record => record.operationId === 'entry:c12r3lg03');
    expect(durable?.cancel?.status).toBe('sent');
    expect(durable?.cancel?.verified).toBeUndefined();
    first.broker.cancelOrder = real;
    box.dead = false;
    const second = await setup({ store: base, broker: first.broker, arm: false });
    await tick(second);
    await tick(second, 1_500);
    await tick(second, 1_000);
    expect(attempts).toBe(1);
    expect(second.broker.cancelRequestCount(entryId)).toBe(0);
    expect(second.controller.status().lastError).toMatch(/se při rušení vyplnil \(1\) a SL\/TP pozice nejsou potvrzené/);
    expect(entryStatus(second, 'entry:c12r3lg03')).toMatchObject({ cancelVerified: 'filled' });
  });

  it('pozdní Fill po „zrušen“: předznačka `filled` bez „nohy ověřeny“ hned, značka až po kontrole nohou; pád během kontroly → nový běh nohy ověří', async () => {
    const { store, base, box } = crashableStore();
    let legIds: string[] = [];
    let crash: (() => void) | null = null;
    const first = await setup({ store, patchBroker: broker => {
      const realFind = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        if (crash && legIds.includes(id)) { const stop = crash; crash = null; stop(); return new Promise(() => undefined); }
        return realFind(accountId, id);
      };
    } });
    const placed = await placeEntry(first, 'c12r3lg04', { quantity: 2 });
    const entryId = placed.entryBrokerOrderId!;
    legIds = [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!];
    first.controller.disarm('manual');
    await tick(first);
    expect(entryStatus(first, 'entry:c12r3lg04')?.cancelVerified).toBe('canceled');
    crash = () => { box.dead = true; first.controller.stop(); };
    for (const legId of legIds) {
      const leg = brokerOrder(first, legId);
      leg.status = 'canceled';
      emitOrder(first, leg, '9:Canceled');
    }
    first.broker.emitEvent({ type: 'fill', fill: { fillId: `late-${entryId}`, tag: brokerOrder(first, entryId).tag, brokerOrderId: entryId, accountId: LEADER, symbol: SYM, side: 'Buy', quantity: 1, price: ENTRY, filledAt: 4 } });
    first.broker.setPosition(LEADER, SYM, 1);
    await sleep(200);
    active = null;
    const durable = (await store.load()).safety?.manualEntries?.find(record => record.operationId === 'entry:c12r3lg04');
    expect(durable?.cancel).toMatchObject({ verified: 'partially-filled', fillQty: 1 });
    expect(durable?.cancel?.legsCheckedAt).toBeUndefined();
    // REST cumQty pozadu (vstup `canceled` s fillem 0): po startu se výsledek nesníží na „zrušen“.
    Object.assign(brokerOrder(first, entryId), { status: 'canceled', filledQuantity: 0 });
    box.dead = false;
    const second = await setup({ store: base, broker: first.broker, arm: false });
    await tick(second);
    await tick(second, 1_500);
    await tick(second, 1_000);
    expect(second.controller.status().lastError).toMatch(/se při rušení vyplnil \(1\) a SL\/TP pozice nejsou potvrzené/);
    expect(entryStatus(second, 'entry:c12r3lg04')).toMatchObject({ cancelVerified: 'partially-filled' });
    const after = (await store.load()).safety?.manualEntries?.find(record => record.operationId === 'entry:c12r3lg04');
    expect(after?.cancel?.legsCheckedAt).toEqual(expect.any(Number));
  });

  it('pozdní Fill po „zrušen“ bez pádu → po kontrole nohou durable značka „nohy ověřeny“ (restart nic nečte znovu)', async () => {
    const store = createMemoryCopierStore();
    const ctx = await setup({ store });
    const placed = await placeEntry(ctx, 'c12r3lg05', { quantity: 2 });
    const entryId = placed.entryBrokerOrderId!;
    ctx.controller.disarm('manual');
    await tick(ctx);
    for (const legId of [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!]) {
      const leg = brokerOrder(ctx, legId);
      leg.status = 'canceled';
      emitOrder(ctx, leg, '9:Canceled');
    }
    ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `late-${entryId}`, tag: brokerOrder(ctx, entryId).tag, brokerOrderId: entryId, accountId: LEADER, symbol: SYM, side: 'Buy', quantity: 1, price: ENTRY, filledAt: 4 } });
    ctx.broker.setPosition(LEADER, SYM, 1);
    await tick(ctx);
    await tick(ctx, 500);
    const durable = (await store.load()).safety?.manualEntries?.find(record => record.operationId === 'entry:c12r3lg05');
    expect(durable?.cancel).toMatchObject({ verified: 'partially-filled', fillQty: 1 });
    expect(durable?.cancel?.legsCheckedAt).toEqual(expect.any(Number));
  });
});

describe('C12 — oponentura kolo 3 (P3): pozdní kontrola a nezpracované eventy leadera', () => {
  it('předčtení OK → během durable `sending` čeká Fill leadera ve frontě (ingress > 0, cache ho ještě nevidí) → 0 × cancelOrder, `cancel` neodeslaný; po zpracování nic dalšího', async () => {
    let onSending: (() => Promise<void>) | null = null;
    let holdNext = false;
    let release: (() => void) | null = null;
    const base = createMemoryCopierStore();
    const store: CopierStore = {
      load: () => base.load(),
      commit: async (snapshot, revision) => {
        if (onSending && snapshot.safety?.manualEntries?.some(record => record.cancel?.status === 'sending')) {
          const hook = onSending;
          onSending = null;
          await hook();
          return base.commit(snapshot, revision);
        }
        if (holdNext) { holdNext = false; await new Promise<void>(resolve => { release = resolve; }); }
        return base.commit(snapshot, revision);
      },
    };
    const ctx = await setup({ store: store as ReturnType<typeof createMemoryCopierStore> });
    const placed = await placeEntry(ctx, 'c12r3ing1');
    const entryId = placed.entryBrokerOrderId!;
    onSending = async () => {
      // Událost leadera, jejíž zpracování visí na zápisu, a za ní ve frontě fill vlastního vstupu.
      holdNext = true;
      const foreign = { ...brokerOrder(ctx, entryId), brokerOrderId: 'foreign-r3', tag: 'foreign-r3', limitPrice: 24_900 };
      ctx.broker.emitEvent({ type: 'order', order: { ...foreign, sourceVersion: '1:working' } });
      await sleep(20);
      // Fill vstupu už dorazil, ale čeká ve frontě za zdrženým eventem — cache ho ještě nevidí.
      ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `f-${entryId}-q`, tag: brokerOrder(ctx, entryId).tag, brokerOrderId: entryId, accountId: LEADER, symbol: SYM, side: 'Buy', quantity: 1, price: ENTRY, filledAt: 3 } });
    };
    ctx.controller.disarm('manual');
    await sleep(120);
    expect(onSending).toBeNull();
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(0);
    expect(release).not.toBeNull();
    (release as unknown as () => void)();
    // Zbytek streamu: Order(Filled) a Position (broker vstup vyplnil).
    Object.assign(brokerOrder(ctx, entryId), { status: 'filled', filledQuantity: 1 });
    emitOrder(ctx, brokerOrder(ctx, entryId), '9:filled');
    ctx.broker.setPosition(LEADER, SYM, 1);
    ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: 1 } });
    await tick(ctx);
    await tick(ctx, 1_500);
    // Zápis „neodesláno“ čekal za zdrženým zpracováním eventu; po něm audit odkladu a nic dalšího (vstup je vyplněný).
    expect(ctx.audits.some(line => line.includes('čekají nezpracované eventy leadera (fill může být ve frontě) — zrušení odloženo'))).toBe(true);
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(0);
    expect(entryStatus(ctx, 'entry:c12r3ing1')?.cancel).toBeUndefined();
  });
});

describe('C12 — oponentura kolo 3 (P3): status nese i starší záznam s incidentem', () => {
  /** Starší čekající vstup + 10 novějších uzavřených záznamů (status by dřív nesl jen posledních 10). */
  const withTenNewer = async (id: string) => {
    const store = createMemoryCopierStore();
    const first = await setup({ store, settleMs: 50 });
    const placed = await placeEntry(first, id);
    first.controller.stop();
    active = null;
    const snapshot = await store.load();
    const base = snapshot.safety!.manualEntries!.find(record => record.operationId === `entry:${id}`)!;
    const newer = Array.from({ length: 10 }, (_, index) => ({
      ...base, operationId: `entry:${id}n${index}`, payloadHash: `h${index}`, createdAt: base.createdAt + 1 + index, updatedAt: base.createdAt + 1 + index,
      request: { ...base.request, orderType: 'Market' as const, price: undefined }, entryBrokerOrderId: `gone-entry-${index}`,
      stopBrokerOrderId: `gone-stop-${index}`, targetBrokerOrderId: `gone-target-${index}`, closedAt: base.createdAt + 2 + index,
    }));
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualEntries: [...snapshot.safety!.manualEntries!, ...newer] } }, snapshot.revision);
    return { store, first, placed };
  };

  it('11 záznamů, nejstarší čekající vstup se zruší (vstup i nohy už nepracují) → status ho nese kvůli zrušení v okně notifikace, push „zrušen“', async () => {
    const { store, first, placed } = await withTenNewer('c12r3old2');
    const second = await setup({ store, broker: first.broker, arm: false, settleMs: 50 });
    await tick(second);
    // Nohy u brokera skončily s rodičem (stream to doručí) — záznam už nemá nic otevřeného.
    for (const legId of [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!]) {
      const leg = brokerOrder(second, legId);
      leg.status = 'canceled';
      emitOrder(second, leg, '9:leg:canceled');
    }
    await tick(second, 500);
    await tick(second, 500);
    expect(second.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    const entries = second.controller.status().manualEntries ?? [];
    expect(entries.length).toBe(11);
    expect(entries[0]).toMatchObject({ operationId: 'entry:c12r3old2', cancelVerified: 'canceled' });
    const pushes = manualEntryNotifications(entries, second.clock.now, { verifiedCancel: true });
    expect(pushes.some(push => push.key === 'manual-entry:entry:c12r3old2' && push.title === 'Čekající vstup zrušen')).toBe(true);
  });

  it('11 záznamů a incident u nejstaršího (čekající vstup, zrušení selže) → status ho nese a watchdog pošle per-záznamový push', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ store, settleMs: 50 });
    const placed = await placeEntry(first, 'c12r3old1');
    const entryId = placed.entryBrokerOrderId!;
    first.controller.stop();
    active = null;
    const snapshot = await store.load();
    const base = snapshot.safety!.manualEntries!.find(record => record.operationId === 'entry:c12r3old1')!;
    const newer = Array.from({ length: 10 }, (_, index) => ({
      ...base, operationId: `entry:c12r3new${index}`, payloadHash: `h${index}`, createdAt: base.createdAt + 1 + index, updatedAt: base.createdAt + 1 + index,
      request: { ...base.request, orderType: 'Market' as const, price: undefined }, entryBrokerOrderId: `gone-entry-${index}`,
      stopBrokerOrderId: `gone-stop-${index}`, targetBrokerOrderId: `gone-target-${index}`, closedAt: base.createdAt + 2 + index,
    }));
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualEntries: [...snapshot.safety!.manualEntries!, ...newer] } }, snapshot.revision);
    let attempts = 0;
    first.broker.cancelOrder = async () => { attempts += 1; throw new Error('network down'); };
    const second = await setup({ store, broker: first.broker, arm: false, settleMs: 50 });
    await tick(second);
    await tick(second, 1_500);
    await sleep(80);
    await tick(second, 500);
    const entries = second.controller.status().manualEntries ?? [];
    expect(entries.length).toBe(11);
    expect(entries[0].operationId).toBe('entry:c12r3old1');
    expect(entries[0].pendingIncident?.text).toContain('nepodařilo zrušit');
    const pushes = manualEntryNotifications(entries, second.clock.now, { verifiedCancel: true });
    expect(pushes.some(push => push.key === 'manual-entry:entry:c12r3old1' && push.title === 'Čekající vstup: zkontroluj leadera')).toBe(true);
    expect(attempts).toBe(1);
    expect(entryId).toBeTruthy();
  });
});

/** Vlastní čekající Limit SELL z appky (z flat) — oponentura kolo 4, sonda A1/A2. */
async function placeSell(ctx: Ctx, id: string) {
  const status = ctx.controller.status();
  const preview = buildLeaderEntryPreviewCommand(
    { symbol: SYM, side: 'Sell', quantity: 1, orderType: 'Limit', price: 25_020, stopLoss: 25_030, takeProfit: 24_990 },
    { group: { ...ctx.group, leaderAccountId: LEADER }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: `preview:${id}` },
  );
  const placed = await ctx.controller.placeLeaderEntry(buildLeaderEntryPlaceCommand(preview, `entry:${id}`), { deadlineAt: ctx.clock.now + 15_000 });
  expect(placed).toMatchObject({ status: 'acknowledged' });
  await sleep(30);
  await ctx.controller.waitForIdle();
  return placed;
}
const followerCopy = (ctx: Ctx, side: 'Buy' | 'Sell' = 'Buy') => ctx.broker.orders()
  .find(order => order.accountId === FOLLOWER && order.parentOrderId == null && order.orderType === 'Limit' && order.side === side)!;
const setPositionEvent = (ctx: Ctx, accountId: number, net: number) => {
  ctx.broker.setPosition(accountId, SYM, net);
  ctx.broker.emitEvent({ type: 'position', position: { accountId, symbol: SYM, netQuantity: net } });
};
const emitCopyFilled = (ctx: Ctx, copy: BrokerOrder) => {
  emitOrder(ctx, { ...copy, status: 'filled', filledQuantity: copy.quantity }, '9:copy:filled');
  ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `f-${copy.brokerOrderId}-r4`, tag: copy.tag, brokerOrderId: copy.brokerOrderId, accountId: FOLLOWER, symbol: SYM, side: copy.side, quantity: copy.quantity, price: ENTRY, filledAt: ctx.clock.now } });
};
const manageCancel = (ctx: Ctx, shown: NonNullable<ReturnType<CopierRuntimeController['status']>['pendingOwnEntries']>[number], operationId: string) => (
  ctx.controller.manageLeaderOrder(validateLeaderOrderManage(buildCancelPendingCommand(shown, {
    groupId: ctx.group.id, leaderAccountId: LEADER, operationId,
  })), { deadlineAt: ctx.clock.now + 15_000 })
);

describe('C12 — oponentura kolo 4 (P2): vlastní vstup z flat proti pozici mimo appku na opačné straně', () => {
  it('A1: ARMED + on-submit follower, čekající Limit SELL z appky, ruční BUY 1 v Tradovate zkopírovaný (leader i follower long 1) → SELL leadera 1× a kopie 1× zrušené, ARM zůstane, žádný incident', async () => {
    const ctx = await setup({ followers: true });
    const placed = await placeSell(ctx, 'c12r4a1');
    const copy = followerCopy(ctx, 'Sell');
    expect(copy).toBeTruthy();
    setPositionEvent(ctx, LEADER, 1);
    setPositionEvent(ctx, FOLLOWER, 1);
    await tick(ctx);
    await tick(ctx, 2_100);
    await tick(ctx, 1_000);
    await tick(ctx, 500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(ctx.broker.cancelRequestCount(copy.brokerOrderId)).toBe(1);
    expect(brokerOrder(ctx, copy.brokerOrderId).status).toBe('canceled');
    expect(ctx.controller.status().armed).toBe(true);
    expect(ctx.controller.status().lastError).toBeNull();
    expect(ctx.audits.some(line => line.includes('opačné straně'))).toBe(false);
    expect(entryStatus(ctx, 'entry:c12r4a1')).toMatchObject({ cancelVerified: 'canceled' });
    expect(entryStatus(ctx, 'entry:c12r4a1')?.pendingIncident).toBeUndefined();
  });

  it('A2: sólo skupina, čekající Limit SELL z appky, ruční BUY 1 v Tradovate → SELL 1× zrušený (ověřeno stavem), ARM zůstane, žádný incident', async () => {
    const ctx = await setup();
    const placed = await placeSell(ctx, 'c12r4a2');
    setPositionEvent(ctx, LEADER, 1);
    await tick(ctx);
    await tick(ctx, 2_100);
    await tick(ctx, 1_000);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(ctx.controller.status().armed).toBe(true);
    expect(ctx.controller.status().lastError).toBeNull();
    expect(entryStatus(ctx, 'entry:c12r4a2')).toMatchObject({ cancelVerified: 'canceled' });
  });
});

describe('C12 — oponentura kolo 4 (P2): pozice followera „odjinud“ jen nad ustáleným a dohnaným stavem', () => {
  it('B3: DISARM, kopie u brokera vyplněná, stream zatím doručil jen Position followera → leader se neruší (odklad, ne incident); po Order/Fill kopie incident „z kopie tohoto vstupu“', async () => {
    let lookups = 0;
    const ctx = await setup({ followers: true, patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => { lookups += 1; return real(accountId, id); };
    } });
    const placed = await placeEntry(ctx, 'c12r4b3');
    lookups = 0;
    const copy = followerCopy(ctx);
    const snapshot = { ...copy };
    setPositionEvent(ctx, FOLLOWER, 1);
    await sleep(20);
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 200);
    await tick(ctx, 1_000);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.controller.status().lastError).toBeNull();
    // Odklad už v revizi: žádné předčtení ani durable `sending` (pozdní kontrola je jen druhá vrstva).
    expect(lookups).toBe(0);
    expect(ctx.audits.some(line => line.includes('stav followera se během přípravy zrušení změnil'))).toBe(false);
    emitCopyFilled(ctx, snapshot);
    await tick(ctx, 500);
    await tick(ctx, 1_500);
    await tick(ctx, 5_000);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.audits.some(line => line.includes(`follower ${FOLLOWER} už má na symbolu pozici z kopie tohoto vstupu`))).toBe(true);
    expect(entryStatus(ctx, 'entry:c12r4b3')?.pendingIncident?.text).toContain('z kopie tohoto vstupu');
    // Vstup leadera nikdo neruší: hák „kopie po zrušení vstupu“ se neozve (rozhodla revize).
    expect(ctx.audits.some(line => line.includes('skončil bez fillu'))).toBe(false);
  });

  it('B4: ARMED, Position followera předběhne Order/Fill kopie → ruční „Zrušit čekající“ (C7) se zablokuje (nic nezruší); po Order/Fill kopie follower-has-position', async () => {
    const ctx = await setup({ followers: true });
    const placed = await placeEntry(ctx, 'c12r4b4x');
    const copy = followerCopy(ctx);
    const snapshot = { ...copy };
    setPositionEvent(ctx, FOLLOWER, 1);
    await tick(ctx);
    const shown = ctx.controller.status().pendingOwnEntries ?? [];
    expect(shown.map(item => item.entryOperationId)).toEqual(['entry:c12r4b4x']);
    const first = await manageCancel(ctx, shown[0], 'manage:c12r4b4a');
    expect(first).toMatchObject({ status: 'blocked' });
    expect(JSON.stringify(first)).toContain('Pozice followera se právě změnila');
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    emitCopyFilled(ctx, snapshot);
    await tick(ctx, 500);
    await tick(ctx, 2_100);
    const second = await manageCancel(ctx, shown[0], 'manage:c12r4b4b');
    expect(second).toMatchObject({ status: 'blocked' });
    expect(JSON.stringify(second)).toContain('follower-has-position');
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
  });

  it('Fill kopie před Position followera (cache: follower flat, kopie vyplněná) → leader se neruší, incident „z kopie tohoto vstupu“', async () => {
    const ctx = await setup({ followers: true });
    const placed = await placeEntry(ctx, 'c12r4fbp');
    const copy = followerCopy(ctx);
    emitCopyFilled(ctx, { ...copy });
    await tick(ctx);
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.audits.some(line => line.includes(`follower ${FOLLOWER} už má na symbolu pozici z kopie tohoto vstupu`))).toBe(true);
  });

  it('nezpracované eventy followera (ingress > 0) → odklad bez čtení i zrušení; po zpracování (kopie se vyplnila) incident, leader se neruší', async () => {
    let holdCommits = false;
    let release: (() => void) | null = null;
    const base = createMemoryCopierStore();
    const store: CopierStore = {
      load: () => base.load(),
      commit: async (snapshot, revision) => {
        if (holdCommits) { holdCommits = false; await new Promise<void>(resolve => { release = resolve; }); }
        return base.commit(snapshot, revision);
      },
    };
    let lookups = 0;
    const ctx = await setup({ followers: true, store: store as ReturnType<typeof createMemoryCopierStore>, patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => { lookups += 1; return real(accountId, id); };
    } });
    const placed = await placeEntry(ctx, 'c12r4ingr');
    const copy = followerCopy(ctx);
    lookups = 0;
    // Událost followera, jejíž zpracování visí na zápisu; za ní ve frontě Order/Fill/Position kopie.
    holdCommits = true;
    ctx.broker.emitEvent({ type: 'position', position: { accountId: FOLLOWER, symbol: 'MESZ6', netQuantity: 1 } });
    await sleep(20);
    expect(release).not.toBeNull();
    emitCopyFilled(ctx, { ...copy });
    setPositionEvent(ctx, FOLLOWER, 1);
    ctx.controller.disarm('manual');
    await sleep(60);
    expect(lookups).toBe(0);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    (release as unknown as () => void)();
    await tick(ctx);
    await tick(ctx, 1_000);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.audits.some(line => line.includes(`follower ${FOLLOWER} už má na symbolu pozici z kopie tohoto vstupu`))).toBe(true);
  });

  it('kopie se vyplní během předčtení / durable `sending` (pozdní kontrola) → 0 × cancelOrder, `cancel` neodeslaný; další kolo incident „z kopie tohoto vstupu“', async () => {
    const { store, box } = hookedStore();
    const ctx = await setup({ followers: true, store });
    const placed = await placeEntry(ctx, 'c12r4late');
    const copy = followerCopy(ctx);
    box.onSending = async () => {
      emitCopyFilled(ctx, { ...copy });
      setPositionEvent(ctx, FOLLOWER, 1);
      await sleep(40);
    };
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 200);
    expect(box.onSending).toBeNull();
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.audits.some(line => line.includes('stav followera se během přípravy zrušení změnil'))).toBe(true);
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(entryStatus(ctx, 'entry:c12r4late')?.cancel).toBeUndefined();
    expect(ctx.audits.some(line => line.includes(`follower ${FOLLOWER} už má na symbolu pozici z kopie tohoto vstupu`))).toBe(true);
  });

  it('P3b za DISARMED: vstup leadera zrušen s fillem 0, lifecycle zrušení kopie odmítnuto (TooLateToCancel) a kopie se vyplní → incident per záznam (zrušení kopie selhalo, kopie vyplněná), nic se nezavírá', async () => {
    const ctx = await setup({ followers: true });
    const placed = await placeEntry(ctx, 'c12r4p3b');
    const copy = followerCopy(ctx);
    const snapshot = { ...copy };
    const realCancel = ctx.broker.cancelOrder.bind(ctx.broker);
    ctx.broker.cancelOrder = async (accountId, id) => {
      if (id === copy.brokerOrderId) {
        const atBroker = brokerOrder(ctx, id);
        atBroker.status = 'filled';
        atBroker.filledQuantity = 1;
        throw new Error('Order rejected: TooLateToCancel');
      }
      return realCancel(accountId, id);
    };
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 200);
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(entryStatus(ctx, 'entry:c12r4p3b')).toMatchObject({ cancelVerified: 'canceled' });
    expect(ctx.audits.some(line => line.includes(`kopii ${copy.brokerOrderId} u followera ${FOLLOWER} se nepodařilo prokazatelně zrušit`))).toBe(true);
    emitCopyFilled(ctx, snapshot);
    setPositionEvent(ctx, FOLLOWER, 1);
    await tick(ctx, 500);
    await tick(ctx, 1_000);
    expect(ctx.audits.some(line => line.includes(`kopie ${copy.brokerOrderId} u followera ${FOLLOWER} se vyplnila`))).toBe(true);
    // Kolo 6 (P3): neutrální text — kopie mohla pozici followera otevřít i zavřít (proti pozici na opačné straně).
    expect(entryStatus(ctx, 'entry:c12r4p3b')?.pendingIncident?.text).toContain('pozice followera se změnila a leader ne; nic se automaticky nezavírá, zkontroluj followera v Tradovate');
    expect(entryStatus(ctx, 'entry:c12r4p3b')?.pendingIncident?.text).not.toContain('drží pozici, kterou leader nemá');
    expect(ctx.controller.status().lastError).not.toBeNull();
    expect(ctx.broker.orders().some(order => order.accountId === FOLLOWER && order.orderType === 'Market')).toBe(false);
  });

  it('kopie se vyplní za DISARMED po VYPLNĚNÉM vstupu leadera (běžný obchod) → žádný incident „kopie po zrušení“', async () => {
    const ctx = await setup({ followers: true });
    const placed = await placeEntry(ctx, 'c12r4norm');
    const copy = followerCopy(ctx);
    fillAtBroker(ctx, placed.entryBrokerOrderId!, 1, 'filled');
    await tick(ctx);
    ctx.controller.disarm('manual');
    await tick(ctx);
    fillCopy(ctx, copy, 1);
    await tick(ctx, 500);
    await tick(ctx, 1_000);
    expect(ctx.audits.some(line => line.includes('skončil bez fillu'))).toBe(false);
  });
});

describe('C12 — oponentura kolo 4 (P3): fill ze streamu rozhodne i při REST pozadu po ustálení', () => {
  it('C1: TooLateToCancel, obě REST čtení `working 0`, stream doručí plný fill mezi nimi → `cancelVerified: filled`, žádné „dál čeká“, nohy ověřené', async () => {
    let entryIdRef = '';
    const ctx = await setup({ settleMs: 400, patchBroker: broker => {
      const realFind = broker.findOrderById.bind(broker);
      broker.cancelOrder = async () => { throw new Error('Order rejected: TooLateToCancel'); };
      broker.findOrderById = async (accountId, id) => {
        const result = await realFind(accountId, id);
        if (id === entryIdRef && result.order) return { ...result, order: { ...result.order, status: 'working' as const, filledQuantity: 0 } };
        return result;
      };
    } });
    const placed = await placeEntry(ctx, 'c12r4c1');
    entryIdRef = placed.entryBrokerOrderId!;
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 100);
    fillAtBroker(ctx, entryIdRef, 1, 'filled');
    await tick(ctx, 50);
    await sleep(450);
    await tick(ctx, 100);
    await sleep(50);
    await ctx.controller.waitForIdle();
    const status = entryStatus(ctx, 'entry:c12r4c1');
    expect(status).toMatchObject({ cancelVerified: 'filled' });
    expect(status?.pendingIncident?.text ?? '').not.toContain('dál čeká');
    expect(ctx.audits.some(line => line.includes('se nepodařilo zrušit'))).toBe(false);
    expect(ctx.audits.some(line => line.includes('stream doručil fill (1)'))).toBe(true);
    const [push] = pushFor2(ctx, 'entry:c12r4c1');
    expect(push.body).not.toContain('dál čeká');
  });

  it('fill ze streamu až PO výsledku „dál čeká“ (REST pozadu) → výsledek se opraví na `filled`, nohy se ověří', async () => {
    let entryIdRef = '';
    const ctx = await setup({ settleMs: 400, patchBroker: broker => {
      const realFind = broker.findOrderById.bind(broker);
      broker.cancelOrder = async () => { throw new Error('Order rejected: TooLateToCancel'); };
      broker.findOrderById = async (accountId, id) => {
        const result = await realFind(accountId, id);
        if (id === entryIdRef && result.order) return { ...result, order: { ...result.order, status: 'working' as const, filledQuantity: 0 } };
        return result;
      };
    } });
    const placed = await placeEntry(ctx, 'c12r4c2');
    entryIdRef = placed.entryBrokerOrderId!;
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 100);
    await sleep(450);
    await tick(ctx, 100);
    await sleep(50);
    await ctx.controller.waitForIdle();
    expect(entryStatus(ctx, 'entry:c12r4c2')).toMatchObject({ cancelVerified: 'working' });
    fillAtBroker(ctx, entryIdRef, 1, 'filled');
    await tick(ctx, 100);
    await sleep(50);
    await ctx.controller.waitForIdle();
    expect(entryStatus(ctx, 'entry:c12r4c2')).toMatchObject({ cancelVerified: 'filled' });
    expect(ctx.audits.some(line => line.includes('po výsledku „dál čeká“ dorazil fill (1)'))).toBe(true);
  });
});

describe('C12 — oponentura kolo 4 (P3): vyřazený follower bez načtené pozice', () => {
  it('vyřazený follower (enabled:false, bez vazby) bez načtených pozic zrušení leadera neblokuje (žádné „není známá“)', async () => {
    const ctx = await setup({ followers: true });
    const placed = await placeEntry(ctx, 'c12r4r13');
    ctx.controller.disarm('manual');
    ctx.controller.updateGroup({ ...ctx.group, followers: [...ctx.group.followers, { accountId: FOLLOWER + 1, mode: 'on-submit', multiplier: 1, enabled: false }] });
    await tick(ctx);
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(ctx.audits.some(line => line.includes(`pozice followera ${FOLLOWER + 1} není známá`))).toBe(false);
  });
});

/**
 * Oponentura C12 kolo 5 (P2): vlastní vstup z flat proti pozici na opačné straně se vyplní BĚHEM rušení
 * (TooLateToCancel) — leader je flat a nohy vstupu pracují jako nahé vstupy. Nikdy „pozice chráněná SL/TP“,
 * nikdy „pozice je otevřená“; incident per záznam `fill-unprotected`, nohy se automaticky neruší.
 */
describe('C12 — oponentura kolo 5 (P2): fill vstupu proti pozici na opačné straně během rušení', () => {
  /** Broker: zrušení SELL vstupu leadera „přijde pozdě“ — vstup se vyplní, pozice leadera 0, nohy BUY dál pracují. */
  type Ref = { entryId: string; ctx: Ctx | null; attempts: number };
  const sellFillsDuringCancel = (ref: Ref) => (broker: MockBroker) => {
    const real = broker.cancelOrder.bind(broker);
    broker.cancelOrder = async (accountId, id) => {
      if (id === ref.entryId && ref.ctx) {
        ref.attempts += 1;
        const ctx = ref.ctx;
        const entry = brokerOrder(ctx, id);
        entry.status = 'filled';
        entry.filledQuantity = 1;
        emitOrder(ctx, entry, '9:sell:filled');
        ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `f-${id}-r5`, tag: entry.tag, brokerOrderId: id, accountId: LEADER, symbol: SYM, side: 'Sell', quantity: 1, price: 25_020, filledAt: 3 } });
        setPositionEvent(ctx, LEADER, 0);
        throw new Error('Order rejected: TooLateToCancel');
      }
      return real(accountId, id);
    };
  };
  const legsOf = (ctx: Ctx, entryId: string) => ctx.broker.orders().filter(order => order.accountId === LEADER && order.parentOrderId === entryId);
  const settle = async (ctx: Ctx) => {
    await tick(ctx, 1_000);
    await sleep(200);
    await tick(ctx, 500);
    await sleep(200);
    await ctx.controller.waitForIdle();
  };
  const expectNakedLegsIncident = async (ctx: Ctx, operationId: string, entryId: string, store?: ReturnType<typeof createMemoryCopierStore>) => {
    const status = entryStatus(ctx, operationId);
    expect(status?.cancelVerified).toBe('filled');
    expect(status?.pendingIncident?.text).toContain('vstup zavřel nebo zmenšil pozici mimo appku a jeho SL/TP pracují bez pozice jako nové vstupy');
    expect(ctx.audits.some(line => line.includes(`cancel-entry ${entryId}`) && line.includes('pozice chráněná SL/TP'))).toBe(false);
    expect(ctx.audits.some(line => line.includes(`(${entryId})`) && line.includes('pozice je otevřená'))).toBe(false);
    expect(ctx.audits.some(line => line.includes('Vstup se vyplnil (1) dřív, než ho broker zrušil — šel proti pozici leadera na opačné straně'))).toBe(true);
    expect(ctx.controller.status().lastError).toContain('SL/TP pracují bez pozice');
    // Nohy se automaticky neruší (INV-DIVERGENCE-01) — nic na ně neodešlo.
    const legs = legsOf(ctx, entryId);
    expect(legs.map(leg => `${leg.side} ${leg.status}`).sort()).toEqual(['Buy working', 'Buy working']);
    for (const leg of legs) expect(ctx.broker.cancelRequestCount(leg.brokerOrderId)).toBe(0);
    const [push] = pushFor2(ctx, operationId);
    expect(push).toMatchObject({ title: 'Čekající vstup: zkontroluj leadera', problem: true });
    expect(push.body).toContain('SL/TP pracují bez pozice');
    expect(push.body).not.toContain('pozice je otevřená');
    if (store) {
      const record = (await store.load()).safety?.manualEntries?.find(item => item.operationId === operationId);
      expect(record?.cancel).toMatchObject({ opposite: true, verified: 'filled' });
      expect(record?.pendingIncidentKinds).toContain('fill-unprotected');
    }
  };

  it('PC sólo: čekající SELL z appky, ruční BUY 1 → automatické zrušení; SELL se vyplní během cancelOrder (pozice 0) → incident `fill-unprotected`, nikdy „chráněná SL/TP“', async () => {
    const ref: Ref = { entryId: '', ctx: null, attempts: 0 };
    const store = createMemoryCopierStore();
    const ctx = await setup({ store, patchBroker: sellFillsDuringCancel(ref) });
    ref.ctx = ctx;
    const placed = await placeSell(ctx, 'c12r5pc1');
    ref.entryId = placed.entryBrokerOrderId!;
    setPositionEvent(ctx, LEADER, 1);
    await tick(ctx);
    await tick(ctx, 2_100);
    await settle(ctx);
    expect(ref.attempts).toBe(1);
    await expectNakedLegsIncident(ctx, 'entry:c12r5pc1', ref.entryId, store);
  });

  for (const armed of [true, false]) {
    it(`PC s on-submit followerem za ${armed ? 'ARMED' : 'DISARMED'}: SELL leadera se vyplní během zrušení → incident per záznam, nohy leadera se neruší`, async () => {
      const ref: Ref = { entryId: '', ctx: null, attempts: 0 };
      const ctx = await setup({ followers: true, patchBroker: sellFillsDuringCancel(ref) });
      ref.ctx = ctx;
      const placed = await placeSell(ctx, `c12r5pcf${armed ? 'a' : 'd'}`);
      ref.entryId = placed.entryBrokerOrderId!;
      expect(followerCopy(ctx, 'Sell')).toBeTruthy();
      setPositionEvent(ctx, LEADER, 1);
      setPositionEvent(ctx, FOLLOWER, 1);
      if (!armed) ctx.controller.disarm('manual');
      await tick(ctx);
      await tick(ctx, 2_100);
      await settle(ctx);
      expect(ref.attempts).toBe(1);
      await expectNakedLegsIncident(ctx, `entry:c12r5pcf${armed ? 'a' : 'd'}`, ref.entryId);
      expect(ctx.controller.status().armed).toBe(false);
    });
  }

  it('restart v `cancel: sending` (proti pozici na opačné straně, durable `opposite` z reálného předčtení), SELL se mezitím vyplnil a pozice je 0 → ověření po startu: incident `fill-unprotected`, text bez „pozice je otevřená“', async () => {
    const store = createMemoryCopierStore();
    let entryIdRef = '';
    let hung = false;
    // „Pád“ workeru během zrušení: cancelOrder vstupu se nikdy nevrátí (durable `sending` už je zapsaný).
    const first = await setup({ store, patchBroker: broker => {
      const real = broker.cancelOrder.bind(broker);
      broker.cancelOrder = async (accountId, id) => {
        if (id === entryIdRef) { hung = true; return new Promise<void>(() => {}); }
        return real(accountId, id);
      };
    } });
    const placed = await placeSell(first, 'c12r5rst');
    const entryId = placed.entryBrokerOrderId!;
    entryIdRef = entryId;
    setPositionEvent(first, LEADER, 1);
    await tick(first);
    first.clock.now += 2_100;
    first.broker.emitEvent({ type: 'heartbeat', at: first.clock.now });
    for (let index = 0; index < 100 && !hung; index += 1) await sleep(20);
    expect(hung).toBe(true);
    first.controller.stop();
    active = null;
    const durable = (await store.load()).safety?.manualEntries?.find(record => record.operationId === 'entry:c12r5rst');
    expect(durable?.cancel).toMatchObject({ status: 'sending', opposite: true });
    // Během výpadku: SELL se u brokera vyplnil (pozice 0), nohy BUY dál pracují.
    Object.assign(brokerOrder(first, entryId), { status: 'filled', filledQuantity: 1 });
    first.broker.setPosition(LEADER, SYM, 0);
    const second = await setup({ store, broker: first.broker, arm: false });
    await tick(second);
    await tick(second, 1_500);
    await second.controller.waitForIdle();
    const status = entryStatus(second, 'entry:c12r5rst');
    expect(status).toMatchObject({ cancel: 'sending', cancelVerified: 'filled' });
    expect(status?.pendingIncident?.text).toContain('vstup zavřel nebo zmenšil pozici mimo appku');
    expect(second.audits.some(line => line.includes('po zrušení z předchozího běhu (sending) se vstup vyplnil (1) — šel proti pozici leadera na opačné straně'))).toBe(true);
    expect(second.audits.some(line => line.includes('pozice chráněná SL/TP'))).toBe(false);
    for (const leg of legsOf(second, entryId)) expect(second.broker.cancelRequestCount(leg.brokerOrderId)).toBe(0);
  });

  it('REST pozadu i po ustálení (obě čtení `working 0`), stream doručí fill SELL proti pozici → cesta „stream doručil fill“ bez „pozice je otevřená“, incident `fill-unprotected`', async () => {
    const ref: Ref = { entryId: '', ctx: null, attempts: 0 };
    const ctx = await setup({ settleMs: 400, patchBroker: broker => {
      sellFillsDuringCancel(ref)(broker);
      const realFind = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        const result = await realFind(accountId, id);
        if (id === ref.entryId && ref.attempts > 0 && result.order) return { ...result, order: { ...result.order, status: 'working' as const, filledQuantity: 0 } };
        return result;
      };
    } });
    ref.ctx = ctx;
    const placed = await placeSell(ctx, 'c12r5strm');
    ref.entryId = placed.entryBrokerOrderId!;
    setPositionEvent(ctx, LEADER, 1);
    await tick(ctx);
    await tick(ctx, 2_100);
    await sleep(450);
    await tick(ctx, 100);
    await settle(ctx);
    expect(ref.attempts).toBe(1);
    expect(ctx.audits.some(line => line.includes('stream doručil fill (1)') && line.includes('šel proti pozici leadera na opačné straně'))).toBe(true);
    expect(ctx.audits.some(line => line.includes('stream doručil fill') && line.includes('pozice je otevřená'))).toBe(false);
    expect(entryStatus(ctx, 'entry:c12r5strm')?.pendingIncident?.text).toContain('SL/TP pracují bez pozice');
  });

  it('pozdní Fill SELL (proti pozici) po výsledku „zrušen“ → text bez „pozice je otevřená“, nohy a pozice ověřené čtením', async () => {
    const ctx = await setup();
    const placed = await placeSell(ctx, 'c12r5late');
    const entryId = placed.entryBrokerOrderId!;
    setPositionEvent(ctx, LEADER, 1);
    await tick(ctx);
    await tick(ctx, 2_100);
    await settle(ctx);
    expect(entryStatus(ctx, 'entry:c12r5late')).toMatchObject({ cancelVerified: 'canceled' });
    // INV-TRAD-02: Fill za Order(Canceled) — vstup se stihl vyplnit, pozice 0.
    ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `f-${entryId}-late`, tag: brokerOrder(ctx, entryId).tag, brokerOrderId: entryId, accountId: LEADER, symbol: SYM, side: 'Sell', quantity: 1, price: 25_020, filledAt: 3 } });
    setPositionEvent(ctx, LEADER, 0);
    await settle(ctx);
    expect(ctx.audits.some(line => line.includes('po výsledku „zrušen“ dorazil fill (1) — šel proti pozici leadera na opačné straně'))).toBe(true);
    expect(ctx.audits.some(line => line.includes('dorazil fill') && line.includes('pozice je otevřená'))).toBe(false);
    expect(entryStatus(ctx, 'entry:c12r5late')?.cancelVerified).toBe('filled');
  });

  it('kontrola: vstup na STEJNÉ straně se vyplní během zrušení a otevře pozici → „pozice chráněná SL/TP“, žádný incident', async () => {
    let entryIdRef = '';
    let ctxRef: Ctx | null = null;
    const ctx = await setup({ patchBroker: broker => {
      broker.cancelOrder = async (_accountId, id) => {
        if (id === entryIdRef && ctxRef) fillAtBroker(ctxRef, id, 1, 'filled');
        throw new Error('Order rejected: TooLateToCancel');
      };
    } });
    ctxRef = ctx;
    const placed = await placeEntry(ctx, 'c12r5same');
    entryIdRef = placed.entryBrokerOrderId!;
    ctx.controller.disarm('manual');
    await tick(ctx);
    await settle(ctx);
    expect(entryStatus(ctx, 'entry:c12r5same')?.cancelVerified).toBe('filled');
    expect(entryStatus(ctx, 'entry:c12r5same')?.pendingIncident).toBeUndefined();
    expect(ctx.audits.some(line => line.includes('pozice chráněná SL/TP (ověřeno čtením)'))).toBe(true);
  });

  it('vstup na stejné straně se vyplní během zrušení, ale pozici mezitím zavřel ruční obchod (net 0) a nohy dál pracují → incident, ne „chráněná“', async () => {
    let entryIdRef = '';
    let ctxRef: Ctx | null = null;
    const ctx = await setup({ patchBroker: broker => {
      broker.cancelOrder = async (_accountId, id) => {
        if (id === entryIdRef && ctxRef) {
          fillAtBroker(ctxRef, id, 1, 'filled');
          setPositionEvent(ctxRef, LEADER, 0);
        }
        throw new Error('Order rejected: TooLateToCancel');
      };
    } });
    ctxRef = ctx;
    const placed = await placeEntry(ctx, 'c12r5man');
    entryIdRef = placed.entryBrokerOrderId!;
    ctx.controller.disarm('manual');
    await tick(ctx);
    await settle(ctx);
    expect(entryStatus(ctx, 'entry:c12r5man')?.pendingIncident?.text).toContain('pozice leadera 0 nekryje fill BUY 1 — fill pozici zavřel nebo zmenšil (nebo ji mezitím zavřel jiný obchod)');
    expect(entryStatus(ctx, 'entry:c12r5man')?.pendingIncident?.text).not.toContain('mimo appku');
    expect(ctx.audits.some(line => line.includes('pozice chráněná SL/TP'))).toBe(false);
  });
});

describe('C12 — oponentura kolo 5 (P3): skončená kopie vstupu u followera, ARMED hák, neznámý stav kopie', () => {
  for (const ending of ['canceled', 'rejected'] as const) {
    it(`PB-${ending}: ARMED, kopie vstupu skončí (${ending}) s fillem 0, ruční BUY 1 zkopírovaný (leader i follower long 1) → vstup leadera 1× zrušen, ARM zůstane, žádný incident`, async () => {
      const ctx = await setup({ followers: true });
      const placed = await placeEntry(ctx, `c12r5pb${ending}`);
      const copy = followerCopy(ctx);
      const atBroker = brokerOrder(ctx, copy.brokerOrderId);
      atBroker.status = ending;
      emitOrder(ctx, { ...atBroker, status: ending, filledQuantity: 0 }, `9:copy:${ending}`);
      await tick(ctx);
      await tick(ctx, 500);
      setPositionEvent(ctx, LEADER, 1);
      setPositionEvent(ctx, FOLLOWER, 1);
      await tick(ctx);
      await tick(ctx, 2_100);
      await tick(ctx, 1_000);
      await tick(ctx, 500);
      expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
      expect(brokerOrder(ctx, placed.entryBrokerOrderId!).status).toBe('canceled');
      expect(ctx.controller.status().armed).toBe(true);
      expect(ctx.controller.status().lastError).toBeNull();
      expect(ctx.audits.some(line => line.includes('stav kopie tohoto vstupu nejde ověřit'))).toBe(false);
      expect(entryStatus(ctx, `entry:c12r5pb${ending}`)).toMatchObject({ cancelVerified: 'canceled' });
    });
  }

  it('kopie vstupu zrušená s dílčím fillem 1/2 (Order(Canceled) nese fill) a follower má pozici 1 → incident „z kopie tohoto vstupu“ (ne „nejde ověřit“), leader se neruší', async () => {
    // Follower s násobkem 2: kopie vstupu 1 má qty 2 (dílčí fill 1/2).
    const ctx = await setup({ group: { ...followerGroup(), followers: [{ accountId: FOLLOWER, mode: 'on-submit', multiplier: 2 }] } });
    const placed = await placeEntry(ctx, 'c12r5pbp');
    const copy = followerCopy(ctx);
    const atBroker = brokerOrder(ctx, copy.brokerOrderId);
    Object.assign(atBroker, { status: 'canceled', filledQuantity: 1 });
    emitOrder(ctx, { ...atBroker }, '9:copy:partial-cancel');
    setPositionEvent(ctx, FOLLOWER, 1);
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 2_100);
    await tick(ctx, 1_000);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(entryStatus(ctx, 'entry:c12r5pbp')?.pendingIncident?.text).toContain(`follower ${FOLLOWER} už má na symbolu pozici z kopie tohoto vstupu`);
  });

  it('Fill kopie dorazí, Order kopie pak hlásí canceled s fillem 0 (pořadí eventů) → kopie se dál počítá jako vyplněná: incident, leader se neruší', async () => {
    const ctx = await setup({ followers: true });
    const placed = await placeEntry(ctx, 'c12r5pbf');
    const copy = followerCopy(ctx);
    ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `f-${copy.brokerOrderId}-r5`, tag: copy.tag, brokerOrderId: copy.brokerOrderId, accountId: FOLLOWER, symbol: SYM, side: 'Buy', quantity: 1, price: ENTRY, filledAt: 3 } });
    emitOrder(ctx, { ...copy, status: 'canceled', filledQuantity: 0 }, '9:copy:canceled0');
    setPositionEvent(ctx, FOLLOWER, 1);
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 2_100);
    await tick(ctx, 1_000);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(entryStatus(ctx, 'entry:c12r5pbf')?.pendingIncident?.text).toContain(`follower ${FOLLOWER} už má na symbolu pozici z kopie tohoto vstupu`);
  });

  it('X4: follower flat a stav kopie neznámý (vazba po restartu na kopii, kterou cache nezná) → zrušení leadera projde (1×)', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ followers: true, store });
    const placed = await placeEntry(first, 'c12r5x4');
    const entryId = placed.entryBrokerOrderId!;
    first.controller.stop();
    active = null;
    const snapshot = await store.load();
    await store.commit({ ...snapshot, links: snapshot.links.map(([orderId, links]) => [orderId, orderId === entryId
      ? links.map(link => ({ ...link, brokerOrderId: 'copy-unknown-r5' })) : links] as typeof snapshot.links[number]) }, snapshot.revision);
    const second = await setup({ followers: true, store, broker: first.broker, arm: false });
    await tick(second);
    await tick(second, 1_500);
    expect(second.broker.cancelRequestCount(entryId)).toBe(1);
    expect(second.audits.some(line => line.includes('stav kopie tohoto vstupu nejde ověřit'))).toBe(false);
  });

  it('X2: ARMED + follower (násobek 2), vstup leadera zrušen s fillem 0, lifecycle zrušení kopie ji zruší s dílčím fillem 1/2 → per-záznamový hák za ARMED mlčí; divergenci zachytí běžná ARMED cesta (autoritativní kontrola velikosti followera → fail-closed)', async () => {
    const ctx = await setup({ group: { ...followerGroup(), followers: [{ accountId: FOLLOWER, mode: 'on-submit', multiplier: 2 }] } });
    const placed = await placeEntry(ctx, 'c12r5x2');
    const copy = followerCopy(ctx);
    expect(copy.quantity).toBe(2);
    const realCancel = ctx.broker.cancelOrder.bind(ctx.broker);
    let copyCancels = 0;
    ctx.broker.cancelOrder = async (accountId, id) => {
      if (id === copy.brokerOrderId) {
        copyCancels += 1;
        // Broker zbytek zruší, 1 ze 2 se stihl vyplnit (Order(Canceled) s fillem, jako partial-cancel adaptéru).
        const atBroker = brokerOrder(ctx, id);
        Object.assign(atBroker, { status: 'canceled', filledQuantity: 1 });
        emitOrder(ctx, { ...atBroker }, '9:copy:partial-cancel');
        ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `f-${id}-x2`, tag: atBroker.tag, brokerOrderId: id, accountId: FOLLOWER, symbol: SYM, side: 'Buy', quantity: 1, price: ENTRY, filledAt: ctx.clock.now } });
        setPositionEvent(ctx, FOLLOWER, 3);
        return;
      }
      return realCancel(accountId, id);
    };
    setPositionEvent(ctx, LEADER, 1);
    setPositionEvent(ctx, FOLLOWER, 2);
    await tick(ctx);
    await tick(ctx, 2_100);
    await tick(ctx, 1_000);
    await tick(ctx, 1_000);
    await tick(ctx, 2_000);
    const status = entryStatus(ctx, 'entry:c12r5x2');
    expect(copyCancels).toBe(1);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    // Za ARMED per-záznamový hák mlčí: žádné „skončil bez fillu“, žádný incident per záznam ani jeho
    // `failClosed({ autoClose: false })`, které by předběhlo běžnou lifecycle / divergence cestu.
    expect(ctx.audits.some(line => line.includes('skončil bez fillu'))).toBe(false);
    expect(status?.pendingIncident).toBeUndefined();
    expect(ctx.controller.status().lastError ?? '').not.toContain('skončil bez fillu');
    // Oponentura kolo 6 (P3, X2): ARMED cestu drží autoritativní kontrola velikosti followera — follower 3
    // proti očekávaným 2 (leader 1 × 2) = fail-closed (ARM dolů, lastError s divergencí). Ověřeno jen v mocku.
    for (let index = 0; index < 60 && ctx.controller.status().armed; index += 1) {
      await tick(ctx, 1_000);
      await sleep(20);
    }
    expect(ctx.controller.status().armed).toBe(false);
    expect(ctx.controller.status().lastError ?? '').toContain(`follower ${FOLLOWER} má autoritativně pozici 3 na ${SYM}, očekáváno 2 podle leadera 1 × 2`);
    expect(entryStatus(ctx, 'entry:c12r5x2')?.pendingIncident).toBeUndefined();
    expect(ctx.audits.some(line => line.includes('skončil bez fillu'))).toBe(false);
  }, 60_000);
});

describe('C12 — oponentura kolo 5 (P3): ustálení pozice followera po nahrazení snímku pozic', () => {
  it('AccountPositionsCache: nahrazení snímku (`set` jiné mapy, `delete`, `clear`) se ohlásí PŘED nahrazením; stream na místě (stejná mapa) ne', () => {
    const calls: string[] = [];
    const cache = new AccountPositionsCache((accountId, next) => {
      calls.push(`${accountId}:${next ? JSON.stringify([...next]) : 'none'}:${JSON.stringify([...(cache.get(accountId) ?? new Map())])}`);
    });
    const first = new Map([[SYM, 1]]);
    cache.set(FOLLOWER, first);
    expect(calls).toEqual([`${FOLLOWER}:[["${SYM}",1]]:[]`]);
    first.set(SYM, 2);
    cache.set(FOLLOWER, first);
    expect(calls).toHaveLength(1);
    cache.set(FOLLOWER, new Map());
    expect(calls[1]).toBe(`${FOLLOWER}:[]:[["${SYM}",2]]`);
    cache.set(LEADER, new Map([[SYM, 1]]));
    cache.delete(LEADER);
    expect(calls[3]).toBe(`${LEADER}:none:[["${SYM}",1]]`);
    expect(cache.has(LEADER)).toBe(false);
    cache.delete(LEADER);
    expect(calls).toHaveLength(4);
    cache.clear();
    expect(calls[4]).toBe(`${FOLLOWER}:none:[]`);
    expect(cache.size).toBe(0);
  });

  it('ustálená pozice followera 1, pak snímek pozic BEZ symbolu (flat vynechaný), nová kopie: Position 1 dřív než Fill → odklad (leader se neruší), po Fill kopie incident „z kopie tohoto vstupu“', async () => {
    let lookups = 0;
    const ctx = await setup({ followers: true, arm: false, patchBroker: broker => {
      // `/position/list` je úplný snímek — nulové pozice v něm chybějí (NEOVĚŘENO u Tradovate; mock nuly drží).
      const realPositions = broker.listPositions.bind(broker);
      broker.listPositions = async accountId => (await realPositions(accountId)).filter(position => position.netQuantity !== 0);
      const realFind = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => { lookups += 1; return realFind(accountId, id); };
    } });
    // Follower drží pozici 1 déle než ustálení (revize ji zapisuje do `followerPositionSeen`).
    setPositionEvent(ctx, FOLLOWER, 1);
    await tick(ctx);
    await tick(ctx, 2_100);
    await tick(ctx, 1_000);
    // Pozice se mimo stream zavřela; reconciliation nahradí snímek pozic followera bez symbolu.
    ctx.broker.setPosition(FOLLOWER, SYM, 0);
    await ctx.controller.reconcile();
    ctx.controller.arm();
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().armed).toBe(true);
    // Lifecycle po reconciliation (přechod followera 1 → 0) doběhne — jinak `group-busy`.
    for (let index = 0; index < 6; index += 1) { await sleep(300); await tick(ctx, 1_000); }
    const placed = await placeEntry(ctx, 'c12r5seen');
    const copy = followerCopy(ctx);
    const snapshot = { ...copy };
    lookups = 0;
    // Kopie se u brokera vyplnila; stream zatím doručil jen Position followera (stejné net jako stará pozice).
    setPositionEvent(ctx, FOLLOWER, 1);
    await sleep(20);
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 200);
    await tick(ctx, 1_000);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(lookups).toBe(0);
    emitCopyFilled(ctx, snapshot);
    await tick(ctx, 500);
    await tick(ctx, 1_500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(entryStatus(ctx, 'entry:c12r5seen')?.pendingIncident?.text).toContain('z kopie tohoto vstupu');
  });
});

describe('C12 — oponentura kolo 5 (P3, A1): REST čtení vstupu bez clOrdId', () => {
  /** Předčtení vstupu (SELL bez parentu) vrátí order bez `tag`; volitelně nohy s jiným parentem. */
  const stripTag = (opts: { legsParent?: string } = {}) => (broker: MockBroker) => {
    const realFind = broker.findOrderById.bind(broker);
    broker.findOrderById = async (accountId, id) => {
      const lookup = await realFind(accountId, id);
      if (!lookup.order) return lookup;
      if (lookup.order.parentOrderId == null && lookup.order.side === 'Sell' && lookup.order.orderType === 'Limit') {
        return { ...lookup, order: { ...lookup.order, tag: undefined } };
      }
      if (opts.legsParent && lookup.order.parentOrderId != null) return { ...lookup, order: { ...lookup.order, parentOrderId: opts.legsParent } };
      return lookup;
    };
  };
  it('A1 bez clOrdId: ARMED + on-submit follower, čekající SELL, ruční BUY 1 zkopírovaný → vlastnictví z nohou (parent = vstup) → SELL 1× a kopie 1× zrušené, ARM zůstane', async () => {
    const ctx = await setup({ followers: true, patchBroker: stripTag() });
    const placed = await placeSell(ctx, 'c12r5a1t');
    const copy = followerCopy(ctx, 'Sell');
    setPositionEvent(ctx, LEADER, 1);
    setPositionEvent(ctx, FOLLOWER, 1);
    await tick(ctx);
    await tick(ctx, 2_100);
    await tick(ctx, 1_000);
    await tick(ctx, 500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(ctx.broker.cancelRequestCount(copy.brokerOrderId)).toBe(1);
    expect(ctx.controller.status().armed).toBe(true);
    expect(ctx.controller.status().lastError).toBeNull();
    expect(entryStatus(ctx, 'entry:c12r5a1t')).toMatchObject({ cancelVerified: 'canceled' });
  });
  it('bez clOrdId a nohy NEdokazují vlastnictví (parent jiný) → incident „opačné straně“, nic se neruší', async () => {
    const ctx = await setup({ patchBroker: stripTag({ legsParent: 'someone-else' }) });
    const placed = await placeSell(ctx, 'c12r5a1n');
    setPositionEvent(ctx, LEADER, 1);
    await tick(ctx);
    await tick(ctx, 2_100);
    await tick(ctx, 1_000);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(entryStatus(ctx, 'entry:c12r5a1n')?.pendingIncident?.text).toContain('pozice leadera je na opačné straně (1)');
  });
});

describe('C12 — oponentura kolo 6 (P3): konec obchodu během kontroly, dílčí fill ze streamu, neznámá pozice followera v C7', () => {
  const settle6 = async (ctx: Ctx) => {
    for (let index = 0; index < 4; index += 1) {
      await tick(ctx, 500);
      await sleep(150);
    }
    await ctx.controller.waitForIdle();
  };

  it('A6: vstup na stejné straně se vyplní během zrušení, nohy se přečtou `working` a hned potom se SL vyplní a TP zruší (pozice 0) → `flat` bez incidentu, lastError null', async () => {
    let entryId = '';
    let ctxRef: Ctx | null = null;
    let trap = false;
    let legReads = 0;
    const ctx = await setup({ patchBroker: broker => {
      broker.cancelOrder = async (_accountId, id) => {
        if (id === entryId && ctxRef) {
          fillAtBroker(ctxRef, id, 1, 'filled');
          trap = true;
        }
        throw new Error('Order rejected: TooLateToCancel');
      };
      const realFind = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        const raw = await realFind(accountId, id);
        const result = raw.order ? { ...raw, order: { ...raw.order } } : raw;
        const c = ctxRef;
        if (trap && c && result.order?.parentOrderId === entryId) {
          legReads += 1;
          // Druhé ze dvou souběžných čtení nohou vrátí ještě `working` (snímek před koncem obchodu); u brokera
          // se ale právě SL vyplnil a TP zrušil (OCO) — pozice 0, nic nepracuje.
          if (legReads === 2) {
            trap = false;
            const legs = c.broker.orders().filter(order => order.accountId === LEADER && order.parentOrderId === entryId);
            const stop = legs.find(order => order.orderType === 'Stop')!;
            const target = legs.find(order => order.orderType === 'Limit')!;
            Object.assign(stop, { status: 'filled', filledQuantity: 1 });
            target.status = 'canceled';
            emitOrder(c, stop, '10:sl');
            emitOrder(c, target, '10:tp');
            c.broker.emitEvent({ type: 'fill', fill: { fillId: 'f-sl-r6', tag: stop.tag, brokerOrderId: stop.brokerOrderId, accountId: LEADER, symbol: SYM, side: 'Sell', quantity: 1, price: SL, filledAt: 4 } });
            setPositionEvent(c, LEADER, 0);
          }
        }
        return result;
      };
    } });
    ctxRef = ctx;
    const placed = await placeEntry(ctx, 'c12r6a6');
    entryId = placed.entryBrokerOrderId!;
    ctx.controller.disarm('manual');
    await tick(ctx);
    await settle6(ctx);
    expect(legReads).toBeGreaterThanOrEqual(2);
    const status = entryStatus(ctx, 'entry:c12r6a6');
    expect(status?.cancelVerified).toBe('filled');
    expect(status?.pendingIncident).toBeUndefined();
    expect(ctx.controller.status().lastError).toBeNull();
    expect(ctx.audits.some(line => line.includes(`cancel-entry ${entryId}`) && line.includes('pozice je už zavřená a nic nepracuje'))).toBe(true);
    expect(ctx.audits.some(line => line.includes('nekryje fill'))).toBe(false);
    expect(ctx.audits.some(line => line.includes('pozice chráněná SL/TP'))).toBe(false);
  });

  it('C6: zrušení selže (síť), stream doručí dílčí fill 1/2 a vstup v cache dál pracuje, REST pozadu (`working 0`) i po ustálení → `working` + incident „zbytek dál čeká“, ne `partially-filled`; nohy se neověřují ani neruší', async () => {
    let entryId = '';
    let ctxRef: Ctx | null = null;
    let entryCancels = 0;
    const ctx = await setup({ settleMs: 400, patchBroker: broker => {
      const realCancel = broker.cancelOrder.bind(broker);
      broker.cancelOrder = async (accountId, id) => {
        const c = ctxRef;
        if (id === entryId && c) {
          entryCancels += 1;
          const entry = brokerOrder(c, id);
          Object.assign(entry, { status: 'working', filledQuantity: 1 });
          emitOrder(c, entry, '10:part');
          c.broker.emitEvent({ type: 'fill', fill: { fillId: 'f-part-r6', tag: entry.tag, brokerOrderId: id, accountId: LEADER, symbol: SYM, side: 'Buy', quantity: 1, price: ENTRY, filledAt: 4 } });
          setPositionEvent(c, LEADER, 1);
          throw new Error('socket hang up');
        }
        return realCancel(accountId, id);
      };
      const realFind = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        const result = await realFind(accountId, id);
        if (id === entryId && result.order) return { ...result, order: { ...result.order, status: 'working' as const, filledQuantity: 0 } };
        return result;
      };
    } });
    ctxRef = ctx;
    const placed = await placeEntry(ctx, 'c12r6c6', { quantity: 2 });
    entryId = placed.entryBrokerOrderId!;
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 100);
    await sleep(500);
    await settle6(ctx);
    expect(entryCancels).toBe(1);
    const status = entryStatus(ctx, 'entry:c12r6c6');
    expect(status?.cancelVerified).toBe('working');
    expect(status?.pendingIncident?.text).toContain('je z části vyplněný (1/2) a zbytek dál čeká');
    expect(ctx.audits.some(line => line.includes('stream doručil fill'))).toBe(false);
    expect(ctx.audits.some(line => line.includes('nohy nesedí s pozicí'))).toBe(false);
    for (const leg of ctx.broker.orders().filter(order => order.accountId === LEADER && order.parentOrderId === entryId)) {
      expect(ctx.broker.cancelRequestCount(leg.brokerOrderId)).toBe(0);
    }
    const [push] = pushFor2(ctx, 'entry:c12r6c6');
    expect(push?.body).toContain('zbytek dál čeká');
  });

  it('C6 kontrola: REST hlásí vstup skončený (`canceled`, cumQty pozadu 0), stream ještě `working` s fillem 1/2 → cesta fillu (`partially-filled`, nohy ověřené), ne „zbytek dál čeká“', async () => {
    let entryId = '';
    let ctxRef: Ctx | null = null;
    let entryCancels = 0;
    const ctx = await setup({ settleMs: 400, patchBroker: broker => {
      const realCancel = broker.cancelOrder.bind(broker);
      broker.cancelOrder = async (accountId, id) => {
        const c = ctxRef;
        if (id === entryId && c) {
          entryCancels += 1;
          const entry = brokerOrder(c, id);
          // U brokera: 1 ze 2 se vyplnil, zbytek zrušen. Stream zatím doručil jen Order(working 1/2) a Fill.
          emitOrder(c, { ...entry, status: 'working', filledQuantity: 1 }, '10:part');
          c.broker.emitEvent({ type: 'fill', fill: { fillId: 'f-part-r6b', tag: entry.tag, brokerOrderId: id, accountId: LEADER, symbol: SYM, side: 'Buy', quantity: 1, price: ENTRY, filledAt: 4 } });
          setPositionEvent(c, LEADER, 1);
          Object.assign(entry, { status: 'canceled', filledQuantity: 1 });
          return;
        }
        return realCancel(accountId, id);
      };
      const realFind = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        const result = await realFind(accountId, id);
        if (id === entryId && result.order?.status === 'canceled') return { ...result, order: { ...result.order, filledQuantity: 0 } };
        return result;
      };
    } });
    ctxRef = ctx;
    const placed = await placeEntry(ctx, 'c12r6c6b', { quantity: 2 });
    entryId = placed.entryBrokerOrderId!;
    ctx.controller.disarm('manual');
    await tick(ctx);
    await tick(ctx, 100);
    await sleep(500);
    await settle6(ctx);
    expect(entryCancels).toBe(1);
    const status = entryStatus(ctx, 'entry:c12r6c6b');
    expect(status?.cancelVerified).toBe('partially-filled');
    expect(ctx.audits.some(line => line.includes('stream doručil fill (1/2)'))).toBe(true);
    expect(status?.pendingIncident?.text ?? '').not.toContain('zbytek dál čeká');
  });

  it('C7: zapojený follower (on-fill, kopii nemá) bez načtených pozic → ruční „Zrušit čekající“ se zablokuje (`follower-has-position`, „není známá“), 0× cancel', async () => {
    const ctx = await setup({ followers: true });
    const placed = await placeEntry(ctx, 'c12r6c7u');
    // Přidaný follower: jeho pozice cache nezná (unknown ≠ flat, INV-DEFAULT-02). Revize vyhlásí `follower-unknown`.
    ctx.controller.updateGroup({ ...ctx.group, followers: [...ctx.group.followers, { accountId: FOLLOWER + 1, mode: 'on-fill', multiplier: 1 }] });
    await tick(ctx);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    const shown = ctx.controller.status().pendingOwnEntries ?? [];
    expect(shown.map(item => item.entryOperationId)).toEqual(['entry:c12r6c7u']);
    const blocked = await manageCancel(ctx, shown[0], 'manage:c12r6c7u');
    expect(blocked).toMatchObject({ status: 'blocked' });
    expect(JSON.stringify(blocked)).toContain('follower-has-position');
    expect(JSON.stringify(blocked)).toContain(`Pozice followera ${FOLLOWER + 1} není známá`);
    await tick(ctx, 500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
  });

  it('C7: vyřazený follower (breached, bez vazby na vstup, pozice nenačtené) ruční zrušení neblokuje — stejní followeři jako revize; vstup i kopie zapojeného followera 1×', async () => {
    const initial = emptySnapshot();
    initial.safety = {
      entryCooldownUntil: 0,
      dayLockUntil: 0,
      accountEligibility: [{ accountId: FOLLOWER + 1, state: 'breached', reason: 'LIVE účet není dostupný', at: 900 }],
    };
    const group: CopyGroupConfig = { ...followerGroup(), followers: [...followerGroup().followers, { accountId: FOLLOWER + 1, mode: 'on-submit', multiplier: 1 }] };
    const ctx = await setup({ group, store: createMemoryCopierStore(initial) });
    expect(ctx.controller.status().armed).toBe(true);
    const placed = await placeEntry(ctx, 'c12r6c7b');
    const copy = followerCopy(ctx);
    expect(copy).toBeTruthy();
    expect(ctx.broker.orders().some(order => order.accountId === FOLLOWER + 1)).toBe(false);
    const shown = ctx.controller.status().pendingOwnEntries ?? [];
    expect(shown.map(item => item.entryOperationId)).toEqual(['entry:c12r6c7b']);
    const manual = await manageCancel(ctx, shown[0], 'manage:c12r6c7b');
    expect(manual).toMatchObject({ status: 'acknowledged' });
    await tick(ctx, 1_500);
    await tick(ctx, 500);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(ctx.broker.cancelRequestCount(copy.brokerOrderId)).toBe(1);
  });
});
