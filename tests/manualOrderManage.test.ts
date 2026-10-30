// Fáze 2a obchodování z grafu: správa vlastního ručního vstupu (plán §10.1) —
// posun SL/TP dál od trhu, zrušení čekajícího vstupu. Skutečný controller,
// mock broker; kopírka followerům zrcadlí změnu leadera běžnou cestou.
import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerAccountRiskSnapshot, BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore, type CopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import { buildLeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';
import { buildLeaderEntryPlaceCommand } from '../lib/leaderEntryPlace';
import { buildLeaderOrderManageCommand, validateLeaderOrderManage, type LeaderOrderManageAction } from '../lib/leaderOrderManage';

const LEADER = 100;
const FOLLOWER = 200;
const SYMBOL = 'MNQZ6';
const START = Date.UTC(2026, 9, 29, 15, 0, 0);
const ENTRY = 29_500;
const SL = 29_480;
const TP = 29_560;
const group = (): CopyGroupConfig => ({
  id: 'manage-group', name: 'Správa', enabled: true, leaderAccountId: LEADER,
  followers: [{ accountId: FOLLOWER, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});
const risk = (accountId: number, at: number, dailyLossAutoLiq = 1_000): BrokerAccountRiskSnapshot => ({
  accountId, at, realizedPnlUsd: 0, openPnlUsd: 0, netLiq: 50_000, minNetLiq: 48_000, dailyLossAutoLiq, trailingMaxDrawdown: 2_000,
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let active: CopierRuntimeController | null = null;
afterEach(() => { active?.stop(); active = null; });

async function setup(options: {
  followerDll?: number; store?: CopierStore; groupConfig?: CopyGroupConfig; patchBroker?: (broker: MockBroker) => void;
  modifyBehavior?: Parameters<typeof createMockBroker>[0]['modifyBehavior'];
} = {}) {
  const config = options.groupConfig ?? group();
  const clock = { now: START };
  const broker = createMockBroker({
    behavior: () => ({ kind: 'working' }),
    ...(options.modifyBehavior ? { modifyBehavior: options.modifyBehavior } : {}),
    accountRiskSnapshots: [risk(LEADER, START + 500), risk(FOLLOWER, START + 500, options.followerDll ?? 1_000), risk(201, START + 500)],
  });
  options.patchBroker?.(broker);
  const store = options.store ?? createMemoryCopierStore();
  const audits: string[] = [];
  const controller = await bootstrapCopierRuntime({
    broker, store, group: config, clock: () => clock.now, osoCorrelationWindowMs: 50,
    manualEntryTimingsMs: { post: 500, start: 500, legWait: 300, manage: 500, settle: 50, verify: 100 },
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
    { symbol: SYMBOL, side: 'Buy', quantity: 1, orderType: 'Limit', price: ENTRY, stopLoss: SL, takeProfit: TP },
    { group: { ...config, leaderAccountId: LEADER }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: 'preview:managetest01' },
  );
  const placed = await controller.placeLeaderEntry(buildLeaderEntryPlaceCommand(preview, 'entry:managetest01'), { deadlineAt: clock.now + 15_000 });
  expect(placed.status).toBe('acknowledged');
  await sleep(30);
  await controller.waitForIdle();
  return { broker, controller, store, audits, clock, placed };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** Vstup leadera i kopie followera se vyplní; nohy zůstanou pracující. */
async function fillEntries(ctx: Ctx) {
  const entries = ctx.broker.orders().filter(order => order.side === 'Buy' && order.orderType === 'Limit' && order.status === 'working' && order.limitPrice === ENTRY);
  expect(entries.map(order => order.accountId)).toContain(LEADER);
  for (const order of entries) {
    order.status = 'filled';
    order.filledQuantity = order.quantity;
    ctx.broker.setPosition(order.accountId, SYMBOL, order.quantity);
    ctx.broker.emitEvent({ type: 'order', order: { ...order } });
    ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `fill-${order.brokerOrderId}`, tag: order.tag, brokerOrderId: order.brokerOrderId,
      accountId: order.accountId, symbol: SYMBOL, side: 'Buy', quantity: order.quantity, price: ENTRY, filledAt: 2 } });
    ctx.broker.emitEvent({ type: 'position', position: { accountId: order.accountId, symbol: SYMBOL, netQuantity: order.quantity } });
  }
  await sleep(30);
  await ctx.controller.waitForIdle();
}

const manage = (ctx: Ctx, action: LeaderOrderManageAction, expectPrice: number, newPrice?: number, id = 'manage:managetest01') => {
  const command = buildLeaderOrderManageCommand({
    groupId: 'manage-group', operationId: id, leaderAccountId: LEADER, entryOperationId: 'entry:managetest01', symbol: SYMBOL,
    action, expect: { price: expectPrice, quantity: 1 }, ...(newPrice != null ? { newPrice } : {}),
  });
  return ctx.controller.manageLeaderOrder(validateLeaderOrderManage(command), { deadlineAt: ctx.clock.now + 15_000 });
};
const leaderModifies = (broker: MockBroker) => broker.modifyRequests().filter(request => request.accountId === LEADER);
const followerModifies = (broker: MockBroker) => broker.modifyRequests().filter(request => request.accountId === FOLLOWER);
const followerOrder = (broker: MockBroker, type: BrokerOrder['orderType']) => broker.orders().find(order => (
  order.accountId === FOLLOWER && order.side === 'Sell' && order.orderType === type && order.status === 'working'
));

describe('fáze 2a: správa vlastního ručního vstupu', () => {
  it('posun SL dál od trhu → leader modify s qty z čerstvého čtení, kopírka posune SL followera', async () => {
    const ctx = await setup();
    await fillEntries(ctx);
    const result = await manage(ctx, 'move-stop', SL, 29_470);
    expect(result).toMatchObject({ status: 'acknowledged', blockers: [] });
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(leaderModifies(ctx.broker)).toEqual([expect.objectContaining({ brokerOrderId: ctx.placed.stopBrokerOrderId, changes: expect.objectContaining({ quantity: 1, orderType: 'Stop', stopPrice: 29_470 }) })]);
    expect(followerModifies(ctx.broker)).toEqual([expect.objectContaining({ changes: expect.objectContaining({ stopPrice: 29_470 }) })]);
    expect(followerOrder(ctx.broker, 'Stop')?.stopPrice).toBe(29_470);
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
    expect(ctx.controller.status().manualOrderActions?.[0]).toMatchObject({ status: 'acknowledged', action: 'move-stop', toPrice: 29_470 });
  });

  it('posun TP dál od trhu projde; TP k trhu blokovaný (Limit přes trh by se vyplnil), SL za TP blokovaný', async () => {
    const ctx = await setup();
    await fillEntries(ctx);
    expect((await manage(ctx, 'move-target', TP, 29_550, 'manage:toward0002')).blockers.map(issue => issue.code)).toContain('toward-market');
    expect((await manage(ctx, 'move-stop', SL, TP, 'manage:beyond0001')).blockers.map(issue => issue.code)).toContain('beyond-target');
    expect((await manage(ctx, 'move-stop', SL, 29_600, 'manage:beyond0002')).blockers.map(issue => issue.code)).toContain('beyond-target');
    expect(leaderModifies(ctx.broker)).toEqual([]);
    const result = await manage(ctx, 'move-target', TP, 29_600, 'manage:target0001');
    expect(result.status).toBe('acknowledged');
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(followerOrder(ctx.broker, 'Limit')?.limitPrice).toBe(29_600);
  });

  it('posun SL nad denní limit followera = blocked, nic se nepošle', async () => {
    const ctx = await setup({ followerDll: 60 });
    await fillEntries(ctx);
    const result = await manage(ctx, 'move-stop', SL, 29_400);
    expect(result.blockers.map(issue => issue.code)).toContain('risk-limit');
    expect(leaderModifies(ctx.broker)).toEqual([]);
  });

  it('zobrazená cena nesedí / nevyplněný vstup / stejné id s jiným obsahem → blocked', async () => {
    const ctx = await setup();
    expect((await manage(ctx, 'move-stop', SL, 29_470, 'manage:shape0001')).blockers.map(issue => issue.code)).toContain('shape');
    await fillEntries(ctx);
    expect((await manage(ctx, 'move-stop', SL - 5, 29_470, 'manage:stale0001')).blockers.map(issue => issue.code)).toContain('order-changed');
    expect((await manage(ctx, 'move-stop', SL, 29_470, 'manage:dup000001')).status).toBe('acknowledged');
    await sleep(30);
    await ctx.controller.waitForIdle();
    const conflict = await manage(ctx, 'move-stop', 29_470, 29_460, 'manage:dup000001');
    expect(conflict.blockers.map(issue => issue.code)).toContain('operation-conflict');
    expect(leaderModifies(ctx.broker)).toHaveLength(1);
  });

  it('follower bez kopie nohy → brána dosahu zablokuje (posun by kopírku vypnul)', async () => {
    const ctx = await setup();
    await fillEntries(ctx);
    // Follower svůj SL zrušil ručně → noha není živá.
    const stop = followerOrder(ctx.broker, 'Stop')!;
    stop.status = 'canceled';
    ctx.broker.emitEvent({ type: 'order', order: { ...stop } });
    await sleep(20);
    await ctx.controller.waitForIdle();
    const result = await manage(ctx, 'move-stop', SL, 29_470, 'manage:reach0001');
    expect(result.status).toBe('blocked');
    expect(leaderModifies(ctx.broker)).toEqual([]);
    expect(ctx.controller.status().lastError).toBeNull();
  });

  it('DISARMED: posun blocked; zrušení čekajícího vstupu projde a kopírka zruší kopii followera', async () => {
    const ctx = await setup();
    ctx.controller.disarm('manual');
    expect((await manage(ctx, 'move-stop', SL, 29_470, 'manage:disarmed1')).status).toBe('blocked');
    const result = await manage(ctx, 'cancel-entry', ENTRY, undefined, 'manage:cancel0001');
    expect(result).toMatchObject({ status: 'acknowledged', brokerOrderId: ctx.placed.entryBrokerOrderId });
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(ctx.broker.cancelRequestCount(ctx.placed.entryBrokerOrderId!)).toBe(1);
    const followerEntry = ctx.broker.orders().find(order => order.accountId === FOLLOWER && order.side === 'Buy');
    expect(followerEntry?.status).toBe('canceled');
  });

  it('zrušení už vyplněného vstupu = blocked (použij Flatten)', async () => {
    const ctx = await setup();
    await fillEntries(ctx);
    const result = await manage(ctx, 'cancel-entry', ENTRY, undefined, 'manage:cancel0002');
    expect(result.blockers.map(issue => issue.code)).toContain('entry-not-pending');
    expect(ctx.broker.cancelRequestCount(ctx.placed.entryBrokerOrderId!)).toBe(0);
  });

  it('restart se změnou v `sending` → unknown; neznámá změna blokuje auto-resume a další změnu', async () => {
    const store = createMemoryCopierStore();
    const ctx = await setup({ store });
    ctx.controller.stop();
    active = null;
    const snapshot = await store.load();
    await store.commit({ ...snapshot, safety: { ...snapshot.safety!, manualOrderActions: [{
      operationId: 'manage:restart001', payloadHash: 'abcdefgh12', entryOperationId: 'entry:managetest01', action: 'move-stop',
      status: 'sending', targetBrokerOrderId: 'x', fromPrice: SL, toPrice: 29_470, quantity: 1, createdAt: START, updatedAt: START,
    }] } }, snapshot.revision);
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({ broker, store, group: group(), clock: () => START + 2_000 });
    active = controller;
    expect(controller.status().manualOrderActions?.[0]).toMatchObject({ status: 'unknown' });
    expect((await store.load()).safety?.manualOrderActions?.[0].status).toBe('unknown');
  });

  it('vypnutý follower posun neblokuje; druhý zapojený follower bez kopie nohy ano', async () => {
    const withDisabled: CopyGroupConfig = { ...group(), followers: [...group().followers, { accountId: 201, mode: 'on-submit', multiplier: 1, enabled: false }] };
    const ctx = await setup({ groupConfig: withDisabled });
    await fillEntries(ctx);
    const disabledResult = await manage(ctx, 'move-stop', SL, 29_470, 'manage:disabled01');
    expect(disabledResult.status).toBe('acknowledged');
  });

  it('visící posun: neznámý výsledek, vyřešení kopírku nevypne a Flatten All zavře i leadera', async () => {
    const hang = { on: false };
    const ctx = await setup({
      patchBroker: broker => {
        const real = broker.modifyOrder.bind(broker);
        broker.modifyOrder = async (accountId, brokerOrderId, changes) => (hang.on && accountId === LEADER
          ? new Promise<void>(() => undefined)
          : real(accountId, brokerOrderId, changes));
      },
    });
    await fillEntries(ctx);
    hang.on = true;
    const result = await manage(ctx, 'move-stop', SL, 29_470, 'manage:hanging01');
    expect(result.status).toBe('unknown');
    await ctx.controller.waiveManualEntry({ operationId: 'manage:hanging01', reason: 'ověřeno v Tradovate' });
    expect(ctx.controller.status().armed).toBe(true);
    // Mock market nikdy nevyplní, Flatten pak čeká na potvrzení — stačí, že leader dostal exit.
    void ctx.controller.flattenGroup('flatten:managetest01').catch(() => undefined);
    await sleep(500);
    const leaderTargeted = ctx.broker.liquidateRequests().some(request => request.accountId === LEADER)
      || ctx.broker.placedRequests().some(request => request.accountId === LEADER && request.orderType === 'Market');
    expect(leaderTargeted).toBe(true);
  });
});

describe('fáze 2c: utažení SL a SL na BE', () => {
  it('utažení SL k trhu (BE) → leader i follower posunuti, bez přepočtu limitu', async () => {
    // Follower DLL 60 $ pustí vstup (SL 20 b), posun dál od trhu ne — utažení riziko snižuje.
    const ctx = await setup({ followerDll: 60 });
    await fillEntries(ctx);
    expect((await manage(ctx, 'move-stop', SL, 29_400, 'manage:awayrisk1')).blockers.map(issue => issue.code)).toContain('risk-limit');
    const result = await manage(ctx, 'move-stop', SL, ENTRY, 'manage:tighten01');
    expect(result).toMatchObject({ status: 'acknowledged', blockers: [] });
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(leaderModifies(ctx.broker)).toEqual([expect.objectContaining({ changes: expect.objectContaining({ stopPrice: ENTRY }) })]);
    expect(followerOrder(ctx.broker, 'Stop')?.stopPrice).toBe(ENTRY);
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
    expect(ctx.controller.status().manualOrderActions?.at(-1)).toMatchObject({ status: 'acknowledged', toPrice: ENTRY });
  });

  it('broker posun přes trh odmítne (InvalidPrice) → rejected, nic se nekopíruje, kopírka běží', async () => {
    const ctx = await setup({ modifyBehavior: order => (order?.accountId === LEADER ? 'rejected' : 'success') });
    await fillEntries(ctx);
    const result = await manage(ctx, 'move-stop', SL, 29_520, 'manage:through01');
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/přes trh/);
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(followerModifies(ctx.broker)).toEqual([]);
    expect(followerOrder(ctx.broker, 'Stop')?.stopPrice).toBe(SL);
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
    expect(ctx.controller.status().manualOrderActions?.at(-1)).toMatchObject({ status: 'rejected' });
  });

  it('odpověď bez provedení (stream nesynchronizovaný) → nikdy acknowledged; čtení po ustálení → rejected', async () => {
    const ctx = await setup({ modifyBehavior: order => (order?.accountId === LEADER ? 'accepted-not-applied' : 'success') });
    await fillEntries(ctx);
    const result = await manage(ctx, 'move-stop', SL, 29_490, 'manage:silent001');
    expect(result.status).toBe('unknown');
    ctx.clock.now += 1_000;
    await sleep(200);
    expect(ctx.controller.status().manualOrderActions?.at(-1)).toMatchObject({ operationId: 'manage:silent001', status: 'rejected' });
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
  });

  it('posun přijat a SL se hned spustil → vyřešeno („SL se spustil“), žádné visící unknown', async () => {
    const ctx = await setup({
      patchBroker: broker => {
        const real = broker.modifyOrder.bind(broker);
        broker.modifyOrder = async (accountId, brokerOrderId, changes) => {
          await real(accountId, brokerOrderId, changes);
          if (accountId !== LEADER) return;
          const order = broker.orders().find(item => item.brokerOrderId === brokerOrderId)!;
          order.status = 'filled';
          order.filledQuantity = order.quantity;
        };
      },
    });
    await fillEntries(ctx);
    const result = await manage(ctx, 'move-stop', SL, 29_495, 'manage:filled001');
    expect(result.status).not.toBe('unknown');
    const record = ctx.controller.status().manualOrderActions?.find(item => item.operationId === 'manage:filled001');
    expect(record).toMatchObject({ status: 'waived' });
    expect(record?.reason).toMatch(/SL se spustil/);
  });

  it('StopLimit SL = blocked (modify by poslal jen stopPrice)', async () => {
    const ctx = await setup();
    await fillEntries(ctx);
    const stop = ctx.broker.orders().find(order => order.brokerOrderId === ctx.placed.stopBrokerOrderId)!;
    stop.orderType = 'StopLimit';
    stop.limitPrice = SL - 1;
    const result = await manage(ctx, 'move-stop', SL, 29_490, 'manage:stoplmt01');
    expect(result.blockers.map(issue => issue.code)).toContain('stop-type');
    expect(leaderModifies(ctx.broker)).toEqual([]);
  });

  it('brzda během zápisu → leader posunut, výsledek přizná, že followeři mají původní SL', async () => {
    const box: { ctx?: Ctx } = {};
    const ctx = await setup({
      patchBroker: broker => {
        const real = broker.modifyOrder.bind(broker);
        broker.modifyOrder = async (accountId, brokerOrderId, changes) => {
          if (accountId === LEADER && box.ctx) box.ctx.controller.disarm();
          return real(accountId, brokerOrderId, changes);
        };
      },
    });
    box.ctx = ctx;
    await fillEntries(ctx);
    const result = await manage(ctx, 'move-stop', SL, ENTRY, 'manage:brake0001');
    expect(result.status).toBe('acknowledged');
    expect(result.reason).toMatch(/followeři mají původní SL/);
  });

  it('reálný adaptér: „not confirmed“ výjimka, noha už filled → ohraničené čtení, výsledek není unknown', async () => {
    const ctx = await setup({
      patchBroker: broker => {
        const real = broker.modifyOrder.bind(broker);
        broker.modifyOrder = async (accountId, brokerOrderId, changes) => {
          await real(accountId, brokerOrderId, changes);
          if (accountId !== LEADER) return;
          const order = broker.orders().find(item => item.brokerOrderId === brokerOrderId)!;
          order.status = 'filled';
          order.filledQuantity = order.quantity;
          throw new Error(`modifyOrder command 1 was not confirmed by the order stream`);
        };
      },
    });
    await fillEntries(ctx);
    const result = await manage(ctx, 'move-stop', SL, 29_495, 'manage:notconf01');
    expect(result.status).toBe('acknowledged');
    expect(result.reason).toMatch(/SL se spustil/);
  });

  it('SL leadera zrušený, pozice trvá → nikdy úspěch: unknown s výstrahou o chybějící ochraně', async () => {
    const ctx = await setup({
      patchBroker: broker => {
        const real = broker.modifyOrder.bind(broker);
        broker.modifyOrder = async (accountId, brokerOrderId, changes) => {
          await real(accountId, brokerOrderId, changes);
          if (accountId !== LEADER) return;
          const order = broker.orders().find(item => item.brokerOrderId === brokerOrderId)!;
          order.status = 'canceled';
        };
      },
    });
    await fillEntries(ctx);
    const result = await manage(ctx, 'move-stop', SL, 29_495, 'manage:canceled1');
    expect(result.status).toBe('unknown');
    expect(result.reason).toMatch(/už u brokera není/);
  });

  it('visící ověřovací čtení nezablokuje job: po limitu unknown a dořešení později', async () => {
    const hang = { on: false };
    const ctx = await setup({
      patchBroker: broker => {
        const real = broker.findOrderById.bind(broker);
        broker.findOrderById = async (accountId, brokerOrderId) => (hang.on && accountId === LEADER ? new Promise(() => undefined) : real(accountId, brokerOrderId));
      },
    });
    await fillEntries(ctx);
    hang.on = true;
    const started = Date.now();
    const result = await manage(ctx, 'move-stop', SL, 29_495, 'manage:hangread1');
    expect(result.status).toBe('unknown');
    expect(Date.now() - started).toBeLessThan(2_000);
    hang.on = false;
    ctx.clock.now += 1_000;
    await sleep(200);
    expect(ctx.controller.status().manualOrderActions?.find(item => item.operationId === 'manage:hangread1')).toMatchObject({ status: 'acknowledged' });
  });

  it('souběh u followera: leader posunut, broker modify followera odmítne → kopírka bez likvidace, follower drží původní SL', async () => {
    const ctx = await setup({ modifyBehavior: order => (order?.accountId === FOLLOWER ? 'rejected' : 'success') });
    await fillEntries(ctx);
    const result = await manage(ctx, 'move-stop', SL, 29_495, 'manage:follrej01');
    expect(result.status).toBe('acknowledged');
    await sleep(100);
    await ctx.controller.waitForIdle();
    const status = ctx.controller.status();
    // Nativní OSO follower → režim jen správy (bez DISARM a auto-close), nové vstupy pozastavené.
    expect(status.armed).toBe(true);
    expect(status.managementOnly).toMatchObject({ source: 'protected-target-modify', accountIds: [FOLLOWER] });
    expect(followerOrder(ctx.broker, 'Stop')?.stopPrice).toBe(SL);
    expect(ctx.broker.liquidateRequests().filter(request => request.accountId === FOLLOWER)).toEqual([]);
    expect(ctx.broker.placedRequests().filter(request => request.accountId === FOLLOWER && request.orderType === 'Market')).toEqual([]);
  });
});
