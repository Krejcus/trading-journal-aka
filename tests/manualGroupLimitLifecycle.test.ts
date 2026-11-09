import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerAccountRiskSnapshot } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBrokerOptions, type MockBroker } from '../services/mockBroker';
import { buildLeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';
import { buildLeaderEntryPlaceCommand } from '../lib/leaderEntryPlace';
import { buildLeaderOrderManageCommand, validateLeaderOrderManage } from '../lib/leaderOrderManage';
import { mergeGroupLimitMembers } from '../services/groupLimitLifecycle';

const START = Date.UTC(2026, 10, 9, 15), SYMBOL = 'MNQZ6';
const ENTRY = 29_500, SL = 29_480, TP = 29_560;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const config = (): CopyGroupConfig => ({ id: 'group-limit', name: 'Group', enabled: true, localOnly: true, leaderAccountId: 100,
  safety: { ...DEFAULT_COPY_GROUP_SAFETY, leaderMaxContracts: { accountId: 100, contracts: 5 } },
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 2, maxContracts: 10 }, { accountId: 300, mode: 'on-submit', multiplier: 1, maxContracts: 5 }] });
let active: CopierRuntimeController | null = null;
afterEach(() => { active?.stop(); active = null; });

async function setup(options: { on?: boolean; quantity?: number; bare?: boolean; behavior?: MockBrokerOptions['behavior']; patchBroker?: (broker: MockBroker) => void } = {}) {
  const clock = { now: START };
  const risks = [100, 200, 300].map(accountId => {
    const row = { accountId, realizedPnlUsd: 0, openPnlUsd: 0, netLiq: 50_000, minNetLiq: 45_000, dailyLossAutoLiq: 5_000, trailingMaxDrawdown: 5_000 } as BrokerAccountRiskSnapshot;
    Object.defineProperty(row, 'at', { get: () => clock.now, enumerable: true }); return row;
  });
  const broker = createMockBroker({ behavior: options.behavior ?? (() => ({ kind: 'working' })), accountRiskSnapshots: risks });
  const cancelWrites: Array<{ accountId: number; id: string }> = [];
  const originalCancel = broker.cancelOrder.bind(broker);
  broker.cancelOrder = async (accountId, id) => { cancelWrites.push({ accountId, id }); return originalCancel(accountId, id); };
  const memory = createMemoryCopierStore();
  const onCommit: { fn: (() => void) | null } = { fn: null };
  const store = { load: () => memory.load(), commit: async (...args: Parameters<typeof memory.commit>) => { const saved = await memory.commit(...args); onCommit.fn?.(); return saved; } };
  const liquidations: Array<{ accountId: number; tag: string }> = [];
  broker.liquidatePosition = async ({ accountId, symbol, tag }) => {
    liquidations.push({ accountId, tag });
    for (const order of broker.orders().filter(row => row.accountId === accountId && row.symbol === symbol && (row.status === 'working' || row.status === 'pending'))) { order.status = 'canceled'; broker.emitEvent({ type: 'order', order: { ...order } }); }
    broker.setPosition(accountId, symbol, 0); broker.emitEvent({ type: 'position', position: { accountId, symbol, netQuantity: 0 } });
    return { status: 'submitted' };
  };
  options.patchBroker?.(broker);
  const controller = await bootstrapCopierRuntime({ broker, store, group: config(), clock: () => clock.now,
    manualGroupLimits: options.on ?? true, osoCorrelationWindowMs: 30, flattenConfirmationAttempts: 2, flattenConfirmationPollMs: 1,
    manualEntryQuote: () => ({ contract: SYMBOL, last: 29_520, bid: 29_520, ask: 29_520.25, quoteAt: clock.now, lastAt: clock.now }),
    manualEntryTimingsMs: { post: 300, start: 500, legWait: 300, manage: 300, settle: 50, verify: 150 } });
  active = controller; broker.setConnected(true); await controller.waitForIdle(); await controller.reconcile(); controller.arm();
  await controller.waitForIdle(); clock.now += 1_000; await sleep(20); await controller.waitForIdle();
  const preview = buildLeaderEntryPreviewCommand({ symbol: SYMBOL, side: 'Buy', quantity: options.quantity ?? 2, orderType: 'Limit', price: ENTRY, ...(!options.bare ? { stopLoss: SL, takeProfit: TP } : {}) },
    { group: config(), armedAt: controller.status().armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: 'preview:grouplimit01', ...(options.bare ? { groupLimitContract: 1 as const } : {}) });
  const placed = await controller.placeLeaderEntry(buildLeaderEntryPlaceCommand(preview, 'entry:grouplimit01'), { deadlineAt: clock.now + 15_000 });
  expect(placed.status).toBe('acknowledged'); await sleep(50); await controller.waitForIdle();
  for (const order of broker.orders().filter(row => row.side === 'Sell')) { order.status = 'pending'; broker.emitEvent({ type: 'order', order: { ...order } }); }
  await sleep(30); await controller.waitForIdle();
  const writes: Array<{ account: number; id: string; price: number | undefined }> = [];
  broker.modifyOrder = async (account, id, changes) => {
    writes.push({ account, id, price: changes.limitPrice ?? changes.stopPrice });
    const order = broker.orders().find(row => row.accountId === account && row.brokerOrderId === id)!;
    if (order.side === 'Buy' && changes.limitPrice != null) {
      const delta = changes.limitPrice - order.limitPrice!;
      for (const leg of broker.orders().filter(row => row.accountId === account && row.side === 'Sell' && row.status === 'pending')) {
        if (leg.orderType === 'Stop') leg.stopPrice! += delta; else leg.limitPrice! += delta;
        broker.emitEvent({ type: 'order', order: { ...leg } });
      }
    }
    Object.assign(order, changes); broker.emitEvent({ type: 'order', order: { ...order } });
    return { confirmedBy: order.status === 'pending' ? 'stream-held' as const : 'stream-replaced' as const, order: { ...order } };
  };
  const move = (id: string, hash = controller.status().groupLimitTrades?.[0]?.stateHash) => controller.manageLeaderOrder(validateLeaderOrderManage(buildLeaderOrderManageCommand({
    groupId: config().id, operationId: id, leaderAccountId: 100, entryOperationId: 'entry:grouplimit01', symbol: SYMBOL,
    action: 'move-limit', moveLimitContract: 2, groupLimitContract: 1, groupLimitStateHash: hash ?? 'abcdefgh', expect: { price: ENTRY, quantity: options.quantity ?? 2 }, newPrice: ENTRY - 2,
  })), { deadlineAt: clock.now + 15_000 });
  const action = (name: 'add-leg' | 'remove-leg' | 'move-stop' | 'move-target' | 'cancel-entry' | 'attach-brackets' | 'close-position', id: string, extra = {}) => {
    const trade = controller.status().groupLimitTrades![0], leader = trade.accounts[0];
    const price = name === 'move-stop' ? leader.stop!.price! : name === 'move-target' ? leader.target!.price! : leader.entry!.price!;
    return controller.manageLeaderOrder(validateLeaderOrderManage(buildLeaderOrderManageCommand({ groupId: config().id, operationId: id, leaderAccountId: 100,
      entryOperationId: 'entry:grouplimit01', symbol: SYMBOL, action: name, groupLimitContract: 1, groupLimitStateHash: trade.stateHash,
      expect: { price, quantity: name === 'cancel-entry' ? leader.entry!.quantity : leader.openQuantity!, ...((name === 'add-leg' || name === 'remove-leg') ? { stop: leader.stop?.price ?? null, target: leader.target?.price ?? null } : {}), ...(name === 'cancel-entry' && leader.entry!.filledQuantity > 0 ? { filledQuantity: leader.entry!.filledQuantity } : {}) }, ...extra })), { deadlineAt: clock.now + 15_000 });
  };
  const fill = async (account: number, quantity?: number) => {
    const entry = broker.orders().find(row => row.accountId === account && row.side === 'Buy')!;
    const q = quantity ?? entry.quantity; entry.filledQuantity = q; entry.status = q === entry.quantity ? 'filled' : 'working'; broker.setPosition(account, SYMBOL, q);
    broker.emitEvent({ type: 'order', order: { ...entry } });
    broker.emitEvent({ type: 'fill', fill: { fillId: `fill-${account}-${q}`, tag: entry.tag, brokerOrderId: entry.brokerOrderId, accountId: account, symbol: SYMBOL, side: 'Buy', quantity: q, price: ENTRY, filledAt: clock.now } });
    broker.emitEvent({ type: 'position', position: { accountId: account, symbol: SYMBOL, netQuantity: q } });
    for (const leg of broker.orders().filter(row => row.accountId === account && row.side === 'Sell' && row.status === 'pending')) { leg.status = 'working'; broker.emitEvent({ type: 'order', order: { ...leg } }); }
    await sleep(30); await controller.waitForIdle();
  };
  return { controller, broker, clock, writes, move, onCommit, store, action, fill, liquidations, risks, cancelWrites };
}

describe('group LIMIT lifecycle (real controller and runner)', () => {
  it('protected 2/4/2 contracts: exactly one parent Modify per account through existing cascade', async () => {
    const ctx = await setup();
    expect(ctx.controller.status().groupLimitTrades?.[0]).toMatchObject({ state: 'pending', accounts: [{ expectedQuantity: 2 }, { expectedQuantity: 4 }, { expectedQuantity: 2 }] });
    const originalHash = ctx.controller.status().groupLimitTrades![0].stateHash;
    const result = await ctx.move('manage:grouplimit01', originalHash);
    expect(result).toMatchObject({ status: 'acknowledged', blockers: [] });
    await ctx.controller.waitForIdle();
    expect(ctx.writes.filter(write => ctx.broker.orders().find(row => row.brokerOrderId === write.id)?.side === 'Buy').map(write => write.account).sort()).toEqual([100, 200, 300]);
    for (const order of ctx.broker.orders()) expect(order.orderType === 'Stop' ? order.stopPrice : order.limitPrice).toBe((order.side === 'Buy' ? ENTRY : order.orderType === 'Stop' ? SL : TP) - 2);
    const record = (await ctx.store.load()).safety?.manualOrderActions?.[0];
    expect(record?.groupLimit?.members.map(member => member.status)).toEqual(['acknowledged', 'acknowledged', 'acknowledged']);
    const count = ctx.writes.length; expect((await ctx.move('manage:grouplimit01', originalHash)).status).toBe('acknowledged'); expect(ctx.writes).toHaveLength(count);
  });
  it('bare LIMIT mirrors once; pending move and cancel keep exact group ownership', async () => {
    const ctx = await setup({ bare: true });
    expect(ctx.broker.placedRequests().filter(row => row.side === 'Buy').map(row => [row.accountId, row.quantity])).toEqual([[100, 2], [200, 4], [300, 2]]);
    expect(ctx.controller.status().groupLimitTrades?.[0].state).toBe('pending');
    expect((await ctx.move('manage:groupbaremove')).status).toBe('acknowledged');
    expect((await ctx.action('cancel-entry', 'manage:groupbarecancel')).status).toBe('acknowledged');
    expect(ctx.broker.orders().every(row => row.status === 'canceled')).toBe(true);
  });
  it('bare fill -> SL -> native OCO promotion uses per-member actual qty without duplicate fanout', async () => {
    const ctx = await setup({ bare: true });
    await ctx.fill(100); await ctx.fill(200); await ctx.fill(300); ctx.clock.now += 1_000;
    expect(ctx.controller.status().groupLimitTrades?.[0].state).toBe('position');
    const add = await ctx.action('add-leg', 'manage:groupbaresl', { leg: 'stopLoss', newPrice: SL });
    expect(add).toMatchObject({ status: 'acknowledged' });
    const promoted = await ctx.action('add-leg', 'manage:groupbaretp', { leg: 'takeProfit', newPrice: TP });
    expect(promoted).toMatchObject({ status: 'acknowledged' });
    const active = ctx.broker.orders().filter(row => row.status === 'working');
    expect(active.map(row => [row.accountId, row.orderType, row.quantity])).toEqual([[100, 'Stop', 2], [100, 'Limit', 2], [200, 'Stop', 4], [200, 'Limit', 4], [300, 'Stop', 2], [300, 'Limit', 2]]);
  });
  it('follower fills before leader: pending own episode stays valid, cancel touches remainders only', async () => {
    const ctx = await setup({ bare: true });
    await ctx.fill(200);
    await sleep(350); await ctx.controller.waitForIdle();
    expect(ctx.controller.status().lastError).toBeNull();
    expect(ctx.broker.placedRequests().filter(row => row.side === 'Sell')).toEqual([]);
    await ctx.fill(100, 1);
    const canceled = await ctx.action('cancel-entry', 'manage:groupearlycancel');
    expect(canceled.status).toBe('acknowledged');
    expect((await ctx.broker.listPositions(200)).find(row => row.symbol === SYMBOL)?.netQuantity).toBe(4);
  });
  it('group postfill close uses the existing exact-symbol native liquidation pipeline', async () => {
    const ctx = await setup({ bare: true }); await ctx.fill(100); await ctx.fill(200); await ctx.fill(300); ctx.clock.now += 1_000;
    const closed = await ctx.action('close-position', 'manage:groupnativeclose');
    expect(closed).toMatchObject({ status: 'acknowledged' });
    for (const id of [100, 200, 300]) expect((await ctx.broker.listPositions(id)).every(row => row.netQuantity === 0)).toBe(true);
  });
  it('protected fill -> remove SL -> add SL/OCO keeps immutable entry ownership and current leg WAL', async () => {
    const ctx = await setup(); await ctx.fill(100); await ctx.fill(200); await ctx.fill(300); ctx.clock.now += 1_000;
    expect((await ctx.action('remove-leg', 'manage:groupprotectrem', { leg: 'stopLoss' })).status).toBe('acknowledged');
    expect(ctx.controller.status().groupLimitTrades?.[0]).toMatchObject({ state: 'position', accounts: [{ stop: null }, { stop: null }, { stop: null }] });
    expect((await ctx.action('add-leg', 'manage:groupprotectadd', { leg: 'stopLoss', newPrice: SL - 1 })).status).toBe('acknowledged');
    expect(ctx.controller.status().groupLimitTrades?.[0].state).toBe('position');
    expect((await ctx.action('move-target', 'manage:groupprotectmove', { newPrice: TP + 1 })).status).toBe('acknowledged');
  });
  it.each(['off', 'kill'] as const)('a brake during the final awaited member read prevents every new leg (%s)', async mode => {
    const ctx = await setup({ bare: true }); await ctx.fill(100); await ctx.fill(200); await ctx.fill(300); ctx.clock.now += 1_000;
    const original = ctx.broker.listOrders.bind(ctx.broker);
    let release!: () => void, held = false;
    const latch = new Promise<void>(resolve => { release = resolve; });
    ctx.broker.listOrders = async (accountId, options) => {
      const result = await original(accountId, options);
      if (accountId === 300 && !held && ctx.controller.status().manualOrderActions?.some(action => action.status === 'sending')) { held = true; await latch; }
      return result;
    };
    const before = ctx.broker.placedRequests().length;
    const pending = ctx.action('add-leg', `manage:groupbrake${mode}`, { leg: 'takeProfit', newPrice: TP });
    for (let i = 0; i < 100 && !held; i += 1) await sleep(5);
    expect(held).toBe(true); if (mode === 'off') ctx.controller.disarm(); else ctx.controller.engageKillSwitch('test'); release();
    expect((await pending).status).toBe('blocked'); expect(ctx.broker.placedRequests()).toHaveLength(before);
  });
  it('verified follower flat permanently ends ownership; a later same-sized position is foreign', async () => {
    const ctx = await setup({ bare: true }); await ctx.fill(100); await ctx.fill(200); await ctx.fill(300); ctx.clock.now += 1_000;
    ctx.broker.setPosition(200, SYMBOL, 0); ctx.broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYMBOL, netQuantity: 0 } }); await sleep(30); await ctx.controller.waitForIdle();
    ctx.broker.setPosition(200, SYMBOL, 4); ctx.broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYMBOL, netQuantity: 4 } }); await sleep(30); await ctx.controller.waitForIdle();
    const before = ctx.broker.placedRequests().length;
    expect(ctx.controller.status().groupLimitTrades?.[0].state).toBe('unknown');
    expect((await ctx.action('add-leg', 'manage:groupforeignsame', { leg: 'stopLoss', newPrice: SL })).status).toBe('blocked');
    expect(ctx.broker.placedRequests()).toHaveLength(before);
  });
  it.each(['bare', 'target'] as const)('pre-ACK OCO events without tags fail closed without a second generic fanout (%s)', async initial => {
    const ctx = await setup({ bare: true }); await ctx.fill(100); await ctx.fill(200); await ctx.fill(300); ctx.clock.now += 1_000;
    if (initial === 'target') expect((await ctx.action('add-leg', 'manage:groupinitialtp', { leg: 'takeProfit', newPrice: TP })).status).toBe('acknowledged');
    let release!: () => void, writes = 0;
    const ack = new Promise<void>(resolve => { release = resolve; });
    ctx.broker.placeOco = async request => {
      writes += 1;
      const ids = ['untagged-stop', 'untagged-target'];
      for (const [index, leg] of [request.first, request.second].entries()) {
        const row = { ...leg, tag: '', brokerOrderId: ids[index], accountId: request.accountId, symbol: request.symbol, quantity: request.quantity,
          filledQuantity: 0, status: 'working' as const, updatedAt: ctx.clock.now, linkedOrderId: ids[1 - index] };
        ctx.broker.seedOrder(row); ctx.broker.emitEvent({ type: 'order', order: { ...row } });
      }
      await ack; return { firstBrokerOrderId: ids[0], secondBrokerOrderId: ids[1], accepted: true, definitive: true };
    };
    const before = ctx.broker.placedRequests().length;
    const result = initial === 'bare' ? ctx.action('attach-brackets', 'manage:groupemptytag', { stopLoss: SL, takeProfit: TP })
      : ctx.action('add-leg', 'manage:groupemptytagtp', { leg: 'stopLoss', newPrice: SL });
    for (let i = 0; i < 100 && writes === 0; i += 1) await sleep(5);
    await sleep(50); expect(ctx.controller.status().lastError ?? '').toMatch(/ID\/tag/);
    expect(ctx.broker.placedRequests()).toHaveLength(before); release();
    expect((await result).status).toBe('unknown'); expect(writes).toBe(1);
  });
  it('durable group ownership rejects legacy management even after reinstall with opt-in off', async () => {
    const ctx = await setup({ bare: true }); await ctx.fill(100); await ctx.fill(200); await ctx.fill(300); ctx.clock.now += 1_000;
    expect((await ctx.action('add-leg', 'manage:groupdowngradeadd', { leg: 'stopLoss', newPrice: SL })).status).toBe('acknowledged');
    ctx.controller.stop();
    const restarted = await bootstrapCopierRuntime({ broker: ctx.broker, store: ctx.store, group: config(), clock: () => ctx.clock.now, manualGroupLimits: false }); active = restarted;
    const before = ctx.writes.length;
    const legacy = validateLeaderOrderManage(buildLeaderOrderManageCommand({ groupId: config().id, operationId: 'manage:grouplegacyafter', leaderAccountId: 100,
      entryOperationId: 'entry:grouplimit01', symbol: SYMBOL, action: 'move-stop', expect: { price: SL, quantity: 2 }, newPrice: SL - 1 }));
    const result = await restarted.manageLeaderOrder(legacy, { deadlineAt: ctx.clock.now + 15_000 });
    expect(result.status).toBe('blocked'); expect(result.blockers.map(issue => issue.code)).toContain('group-contract-required'); expect(ctx.writes).toHaveLength(before);
  });
  it('the original protected OSO leader ID alias cannot bypass durable group ownership after reinstall', async () => {
    const ctx = await setup(); await ctx.fill(100); await ctx.fill(200); await ctx.fill(300); ctx.clock.now += 1_000;
    expect((await ctx.action('move-target', 'manage:groupprotectedown', { newPrice: TP + 1 })).status).toBe('acknowledged');
    const leaderId = ctx.broker.orders().find(row => row.accountId === 100 && row.side === 'Buy')!.brokerOrderId;
    ctx.controller.stop();
    const restarted = await bootstrapCopierRuntime({ broker: ctx.broker, store: ctx.store, group: config(), clock: () => ctx.clock.now, manualGroupLimits: false }); active = restarted;
    const before = ctx.writes.length;
    const legacy = validateLeaderOrderManage(buildLeaderOrderManageCommand({ groupId: config().id, operationId: 'manage:grouplegacyalias', leaderAccountId: 100,
      leaderEntryOrderId: leaderId, symbol: SYMBOL, action: 'move-target', expect: { price: TP + 1, quantity: 2 }, newPrice: TP + 2 }));
    const result = await restarted.manageLeaderOrder(legacy, { deadlineAt: ctx.clock.now + 15_000 });
    expect(result.blockers.map(issue => issue.code)).toContain('group-contract-required'); expect(ctx.writes).toHaveLength(before);
  });
  it('correct prices with an active child above a flat account cannot confirm a pending parent move', async () => {
    const ctx = await setup(); const original = ctx.broker.modifyOrder;
    ctx.broker.modifyOrder = async (account, id, changes) => {
      const result = await original(account, id, changes);
      if (account === 100 && ctx.broker.orders().find(row => row.brokerOrderId === id)?.side === 'Buy') {
        const stop = ctx.broker.orders().find(row => row.accountId === 100 && row.orderType === 'Stop')!; stop.status = 'working';
        ctx.broker.emitEvent({ type: 'order', order: { ...stop } });
      }
      return result;
    };
    expect((await ctx.move('manage:groupworkingchild')).status).toBe('unknown');
  });
  it.each(['filled', 'unknown'] as const)('P7 blocks automatic cleanup across heartbeat review when a copied member is %s', async scenario => {
    const ctx = await setup({ bare: true, behavior: request => request.accountId === 300
      ? scenario === 'unknown' ? { kind: 'timeout-after-accept' } : { kind: 'reject', reason: 'test' }
      : request.accountId === 200 && scenario === 'filled' ? { kind: 'fill', price: ENTRY } : { kind: 'working' } });
    ctx.clock.now += 5_000;
    ctx.broker.emitEvent({ type: 'heartbeat', at: ctx.clock.now }); await sleep(50); await ctx.controller.waitForIdle();
    const entry = (await ctx.store.load()).safety?.manualEntries?.[0];
    expect(entry?.groupLimitCleanupBlocked).toBe(true);
    expect(ctx.broker.orders().find(row => row.accountId === 100 && row.side === 'Buy')?.status).toBe('working');
    expect(ctx.liquidations).toEqual([]);
    expect(ctx.cancelWrites).toEqual([]);
  });
  it('an ACK binding merges a concurrently persisted tombstone and maximum fill instead of reviving it', () => {
    const current = [{ accountId: 100, entryId: 'own-entry', quantity: 2, entryFrom: ENTRY, status: 'acknowledged' as const,
      openedAt: 10, closedAt: 20, filledQuantity: 2 }];
    const captured = [{ accountId: 100, entryId: 'own-entry', quantity: 2, entryFrom: ENTRY, status: 'acknowledged' as const,
      stopId: 'late-sl', openedAt: 5, filledQuantity: 1 }];
    expect(mergeGroupLimitMembers(current, captured)).toMatchObject([{ closedAt: 20, openedAt: 10, filledQuantity: 2, stopId: 'late-sl' }]);
  });
  it('a fresh risk snapshot with no DLL/MLL/cut cannot authorize widening SL', async () => {
    const ctx = await setup(); await ctx.fill(100); await ctx.fill(200); await ctx.fill(300);
    for (const risk of ctx.risks) Object.assign(risk, { netLiq: null, minNetLiq: null, dailyLossAutoLiq: null, trailingMaxDrawdown: null });
    ctx.clock.now += 31_000; ctx.broker.emitEvent({ type: 'heartbeat', at: ctx.clock.now }); await sleep(30); await ctx.controller.waitForIdle();
    const before = ctx.writes.length;
    const result = await ctx.action('move-stop', 'manage:groupnorisklimit', { newPrice: SL - 1 });
    expect(result.status).toBe('blocked'); expect(result.blockers.map(issue => issue.code)).toContain('group-price');
    expect(ctx.writes).toHaveLength(before);
  });
  it('P7 broker read failure after a rejected copy never falls through to automatic close/cleanup', async () => {
    let fanoutStarted = false;
    const ctx = await setup({ bare: true,
      behavior: request => { if (request.accountId === 300) { fanoutStarted = true; return { kind: 'reject', reason: 'missing copy' }; } return { kind: 'working' }; },
      patchBroker: broker => { const read = broker.listPositions.bind(broker); broker.listPositions = async accountId => { if (fanoutStarted) throw new Error('P7 read unavailable'); return read(accountId); }; },
    });
    ctx.clock.now += 5_000; ctx.broker.emitEvent({ type: 'heartbeat', at: ctx.clock.now }); await sleep(30); await ctx.controller.waitForIdle();
    expect((await ctx.store.load()).safety?.manualEntries?.[0].groupLimitCleanupBlocked).toBe(true);
    expect(ctx.liquidations).toEqual([]); expect(ctx.cancelWrites).toEqual([]);
    expect(ctx.broker.orders().find(order => order.accountId === 100 && order.side === 'Buy')?.status).toBe('working');
  });
  it('fresh REST-only foreign fill history vetoes group close despite the same cached net', async () => {
    const ctx = await setup({ bare: true }); await ctx.fill(100); await ctx.fill(200); await ctx.fill(300); ctx.clock.now += 1_000;
    const read = ctx.broker.listOrders.bind(ctx.broker); let revealed = false;
    ctx.broker.listOrders = async (accountId, options) => {
      if (accountId === 200 && !revealed && ctx.controller.status().manualOrderActions?.some(action => action.action === 'close-position' && action.status === 'sending')) {
        revealed = true;
        ctx.broker.seedOrder({ tag: 'foreign', brokerOrderId: 'foreign-close-reopen', accountId: 200, symbol: SYMBOL, side: 'Buy', orderType: 'Market',
          quantity: 4, filledQuantity: 4, status: 'filled', updatedAt: ctx.clock.now });
      }
      return read(accountId, options);
    };
    const result = await ctx.action('close-position', 'manage:groupcloseforeign');
    expect(revealed).toBe(true); expect(result.status).toBe('unknown'); expect(ctx.liquidations).toEqual([]); expect(ctx.cancelWrites).toEqual([]);
  });
  it('group close transient read failure is bounded by the admitted command deadline', async () => {
    const ctx = await setup({ bare: true }); await ctx.fill(100); await ctx.fill(200); await ctx.fill(300); ctx.clock.now += 1_000;
    const read = ctx.broker.listPositions.bind(ctx.broker); let failedReads = 0;
    ctx.broker.listPositions = async accountId => {
      if (ctx.controller.status().manualOrderActions?.some(action => action.action === 'close-position' && action.status === 'sending')) {
        failedReads += 1; ctx.clock.now += 16_000; throw new Error('temporary network timeout');
      }
      return read(accountId);
    };
    const result = await ctx.action('close-position', 'manage:groupclosedeadline');
    expect(result.status).toBe('unknown'); expect(failedReads).toBeLessThan(10); expect(ctx.liquidations).toEqual([]); expect(ctx.cancelWrites).toEqual([]);
  });
  it('a follower leg ID collision cannot suppress an independent leader order from another account', async () => {
    const ctx = await setup({ bare: true }); await ctx.fill(100); await ctx.fill(200); await ctx.fill(300); ctx.clock.now += 1_000;
    expect((await ctx.action('add-leg', 'manage:groupcollisionleg', { leg: 'stopLoss', newPrice: SL })).status).toBe('acknowledged');
    const followerLeg = ctx.broker.orders().find(order => order.accountId === 200 && order.side === 'Sell')!;
    const before = ctx.broker.placedRequests().filter(request => request.accountId !== 100 && request.side === 'Buy').length;
    ctx.broker.emitEvent({ type: 'order', order: { ...followerLeg, accountId: 100, tag: 'foreign-leader', side: 'Buy', orderType: 'Limit',
      quantity: 1, stopPrice: undefined, limitPrice: ENTRY - 20, parentOrderId: undefined, linkedOrderId: undefined, ocoId: undefined, updatedAt: ctx.clock.now } });
    await sleep(60); await ctx.controller.waitForIdle();
    // The ordinary leader replace guard sees the collision and refuses it; suppression would
    // silently record/ignore it and leave the copier armed. No forced generic fanout is expected.
    expect(ctx.controller.status().lastError ?? '').toContain(`leader replace ${followerLeg.brokerOrderId}`);
    expect(ctx.controller.status().armed).toBe(false);
    expect(ctx.broker.placedRequests().filter(request => request.accountId !== 100 && request.side === 'Buy')).toHaveLength(before);
  });
  it('off or stale state hash dispatches nothing', async () => {
    const ctx = await setup({ on: false }); expect((await ctx.move('manage:grouplimitoff')).status).toBe('blocked'); expect(ctx.writes).toEqual([]);
    ctx.controller.stop();
    const on = await setup(); expect((await on.move('manage:grouplimitold', 'abcdefgh')).status).toBe('blocked'); expect(on.writes).toEqual([]);
  });
  it('follower fill while durable sending is saved prevents all dispatch', async () => {
    const ctx = await setup();
    ctx.onCommit.fn = () => { ctx.onCommit.fn = null; const entry = ctx.broker.orders().find(row => row.accountId === 200 && row.side === 'Buy')!;
      entry.filledQuantity = 1; ctx.broker.setPosition(200, SYMBOL, 1); ctx.broker.emitEvent({ type: 'order', order: { ...entry } }); };
    const result = await ctx.move('manage:grouplimitfill'); expect(result.status).toBe('blocked'); expect(ctx.writes).toEqual([]);
  });
});
