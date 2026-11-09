import { describe, expect, it, vi } from 'vitest';
import { COPIER_GROUP_LIMIT_MOVE_CAPABILITY, COPIER_GROUP_LIMIT_MANAGE_CAPABILITY, COPIER_GROUP_LIMIT_BARE_CAPABILITY, COPIER_MANUAL_ORDER_CANCEL_PENDING_CAPABILITY } from '../lib/copierWorkerCapabilities';
import { groupLimitOutcomeNotice, groupLimitCommandFields, groupLimitCancelExpect, groupLimitPendingMoveTrade, groupLimitPositionManageTrade, groupLimitCancelTrade, groupLimitLegTrade } from '../lib/groupLimitUi';
import type { GroupLimitAccountState, GroupLimitTradeState } from '../lib/groupLimitProtocol';
import { buildLeaderOrderManageCommand, validateLeaderOrderManage } from '../lib/leaderOrderManage';
import { createLiveManageRun } from '../hooks/useLiveManageRunner';
import type { LeaderOrderManageCommand, LeaderOrderManageResult } from '../lib/leaderOrderManage';
import { createLiveDeskCommands } from '../lib/liveDeskCommands';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import { liveAttachIntent, liveTicketLegsProblem } from '../lib/liveBareEntry';
import { liveGroupLineSnapshotChanged, liveLineMoveBlockReason, livePositionChartLines } from '../lib/liveChartOrderLines';
import type { LiveChartPositionSummary } from '../lib/liveChartPosition';

const OP = 'entry:group000000001';
const account = (id: number, q: number, leader = false): GroupLimitAccountState => ({
  accountId: id, role: leader ? 'leader' : 'follower', expectedQuantity: q, openQuantity: 0, state: 'pending', verifiedAt: 100,
  entry: { brokerOrderId: `${id}-entry`, quantity: q, filledQuantity: 0, price: 25_000, state: 'working' },
  stop: { brokerOrderId: `${id}-sl`, quantity: q, filledQuantity: 0, price: 24_990, state: 'pending' },
  target: { brokerOrderId: `${id}-tp`, quantity: q, filledQuantity: 0, price: 25_020, state: 'pending' },
});
const pending = (): GroupLimitTradeState => ({ groupId: 'group-live', entryOperationId: OP, symbol: 'MNQZ6', side: 'Buy',
  state: 'pending', stateHash: '1234abcd1234abcd', accounts: [account(1, 2, true), account(2, 4)] });
const position = (): GroupLimitTradeState => {
  const trade = pending(); trade.state = 'position';
  for (const row of trade.accounts) { row.state = 'position'; row.openQuantity = row.expectedQuantity;
    row.entry!.state = 'filled'; row.entry!.filledQuantity = row.expectedQuantity;
    row.stop!.state = 'working'; row.target!.state = 'working'; }
  return trade;
};
const status = (trade = pending()) => ({
  capabilities: [COPIER_GROUP_LIMIT_MOVE_CAPABILITY, COPIER_GROUP_LIMIT_MANAGE_CAPABILITY, COPIER_GROUP_LIMIT_BARE_CAPABILITY, COPIER_MANUAL_ORDER_CANCEL_PENDING_CAPABILITY],
  group: { id: 'group-live', leaderAccountId: 1, followers: [{ accountId: 2, multiplier: 2, mode: 'on-submit' }] },
  controller: { groupLimitTrades: [trade] },
});

describe('group LIMIT UI readiness', () => {
  it('supports protected multi-quantity pending move while the old solo path remains capped', () => {
    const s = status(); expect(groupLimitPendingMoveTrade(s, OP, 'MNQZ6')).toBe(s.controller.groupLimitTrades[0]);
    const summary = { kind: 'pending', side: 'long', quantity: 6, entry: 25_000, entryType: 'limit', stop: 24_990, target: 25_020,
      mark: 25_010, leader: { accountId: 1, quantity: 2, entry: 25_000 }, rows: [], accounts: 2, scopeLabel: null, openPnl: null, protection: '' } as LiveChartPositionSummary;
    expect(liveLineMoveBlockReason(summary, 'entry', 24_999, { moveLimit: true })).toMatch(/1 kontraktu/);
    expect(liveLineMoveBlockReason(summary, 'entry', 24_999, { groupLimitMove: true })).toBeNull();
    expect(livePositionChartLines(summary, { manageable: true, groupLimitMove: true, entryAvg: null, pointValue: 2 })[0].draggable).toBe(true);
    expect(livePositionChartLines({ ...summary, entryType: 'stop' }, { manageable: true, groupLimitMove: true, entryAvg: null, pointValue: 2 })[0].draggable).toBe(false);
  });
  it('rejects missing/duplicate/foreign members, wrong ownership, pending actions, unknown and partial fills', () => {
    const mutations: ((t: GroupLimitTradeState) => void)[] = [
      t => { t.accounts.push(account(99, 1)); }, t => { t.accounts.push({ ...t.accounts[0] }); },
      t => { t.accounts[0].role = 'follower'; }, t => { t.state = 'unknown'; },
      t => { t.pendingOperationId = 'manage:already0000'; }, t => { t.accounts[1].issue = 'binding missing'; },
      t => { t.accounts[1].verifiedAt = null; }, t => { t.accounts[1].entry!.filledQuantity = 1; },
      t => { t.accounts[1].stop!.quantity = 1; }, t => { t.accounts[1].target!.brokerOrderId = t.accounts[1].stop!.brokerOrderId; },
      t => { t.accounts[1].stop = null; }, t => { t.accounts[0].openQuantity = 1; },
    ];
    for (const mutate of mutations) { const t = pending(); mutate(t); expect(groupLimitPendingMoveTrade(status(t), OP, 'MNQZ6')).toBeNull(); }
    expect(groupLimitPendingMoveTrade({ ...status(), capabilities: ['manual-order-move-limit-v2'] }, OP, 'MNQZ6')).toBeNull();
    expect(groupLimitPendingMoveTrade(status(), OP, 'MNQH7')).toBeNull();
    expect(groupLimitPendingMoveTrade({ ...status(), controller: {} }, OP, 'MNQZ6')).toBeNull();
  });
  it('each new capability is required for its own path; a legacy solo capability cannot replace it', () => {
    const bare = pending(); for (const row of bare.accounts) { row.stop = null; row.target = null; }
    expect(groupLimitPendingMoveTrade(status(bare), OP, 'MNQZ6')).toBe(bare);
    const noMove = status(); noMove.capabilities = ['manual-order-move-limit-v2'];
    expect(groupLimitPendingMoveTrade(noMove, OP, 'MNQZ6')).toBeNull();
    const noBare = status(bare); noBare.capabilities = [COPIER_GROUP_LIMIT_MOVE_CAPABILITY, 'manual-entry-bare-pending-v1'];
    expect(groupLimitPendingMoveTrade(noBare, OP, 'MNQZ6')).toBeNull();
    const noManage = status(position()); noManage.capabilities = ['manual-order-single-leg-v1', 'manual-order-close-bare-v1'];
    expect(groupLimitPositionManageTrade(noManage, OP, 'MNQZ6')).toBeNull();
    const noCancel = status(); noCancel.capabilities = ['manual-order-cancel-pending-v1'];
    expect(groupLimitCancelTrade(noCancel, OP, 'MNQZ6')).toBeNull();
  });
  it('uses sealed participants without inventing an excluded follower from current configuration', () => {
    const s = status(); s.group.followers.push({ accountId: 3, multiplier: 1, mode: 'on-submit' });
    expect(groupLimitPendingMoveTrade(s, OP, 'MNQZ6')).not.toBeNull();
    s.controller.groupLimitTrades[0].state = 'unknown';
    expect(groupLimitPendingMoveTrade(s, OP, 'MNQZ6')).toBeNull();
  });
  it('post-fill management uses actual leader qty and permits verified flat members after partial cancellation', () => {
    const t = position(); t.state = 'mixed'; const follower = t.accounts[1];
    follower.state = 'flat'; follower.openQuantity = 0; follower.entry!.state = 'canceled'; follower.entry!.filledQuantity = 0;
    follower.stop = null; follower.target = null;
    expect(groupLimitPositionManageTrade(status(t), OP, 'MNQZ6')).toBe(t);
    expect(groupLimitLegTrade(t)).toMatchObject({ quantity: 2, groupLimitStateHash: t.stateHash, referencePrice: 25_000 });
    t.accounts[0].entry!.state = 'working';
    expect(groupLimitPositionManageTrade(status(t), OP, 'MNQZ6')).toBeNull();
  });
  it('pending remainder, missing follower evidence or pending operation cannot create protection', () => {
    for (const mutate of [
      (t: GroupLimitTradeState) => { t.accounts[1].entry!.state = 'working'; },
      (t: GroupLimitTradeState) => { t.accounts[1].openQuantity = null; },
      (t: GroupLimitTradeState) => { t.accounts[1].stop!.quantity = 1; },
      (t: GroupLimitTradeState) => { t.pendingOperationId = 'manage:already0000'; },
    ]) { const t = position(); mutate(t); expect(groupLimitPositionManageTrade(status(t), OP, 'MNQZ6')).toBeNull(); }
  });
  it('cancel remains possible for a known own remainder during an unresolved move; a filled entry cannot be canceled', () => {
    const t = pending(); t.state = 'unknown'; t.pendingOperationId = 'manage:already0000'; t.accounts[0].entry!.filledQuantity = 1; t.accounts[1].state = 'unknown'; t.accounts[1].verifiedAt = null;
    expect(groupLimitCancelTrade(status(t), OP, 'MNQZ6')).toBe(t);
    t.accounts[0].entry!.filledQuantity = 2;
    expect(groupLimitCancelTrade(status(t), OP, 'MNQZ6')).toBeNull();
  });
  it.each([0, 1])('cancel build/validate roundtrip preserves zero/partial fill wire shape (%s)', filledQuantity => {
    const t = pending(); t.accounts[0].entry!.filledQuantity = filledQuantity;
    const command = buildLeaderOrderManageCommand({ groupId: t.groupId, operationId: 'manage:cancel00000001',
      leaderAccountId: 1, entryOperationId: OP, symbol: t.symbol, action: 'cancel-entry',
      ...groupLimitCommandFields(t), expect: groupLimitCancelExpect(t, 25_000) });
    expect(validateLeaderOrderManage(JSON.parse(JSON.stringify(command)))).toEqual(command);
    expect(command.expect).toEqual({ price: 25_000, quantity: 2, ...(filledQuantity > 0 ? { filledQuantity } : {}) });
  });
  it('PC and phone line snapshots retain the original group hash independently of unchanged leader price', () => {
    const first = { groupLimitStateHash: 'firststate1234567' };
    expect(liveGroupLineSnapshotChanged(first, 'newstate12345678')).toBe(true);
    expect(liveGroupLineSnapshotChanged(first, null)).toBe(true);
    expect(liveGroupLineSnapshotChanged(undefined, 'newstate12345678')).toBe(true);
    expect(liveGroupLineSnapshotChanged(first, first.groupLimitStateHash)).toBe(false);
    expect(liveGroupLineSnapshotChanged(undefined, null)).toBe(false);
  });
  it('the group bare permission grants only Limit, and never Stop, Market or a single pre-entry leg', () => {
    const bare = { type: 'limit' as const, stopLoss: null, takeProfit: null };
    expect(liveTicketLegsProblem(bare, false, false, true)).toBeNull();
    expect(liveTicketLegsProblem({ ...bare, type: 'stop' }, false, false, true)).not.toBeNull();
    expect(liveTicketLegsProblem({ ...bare, type: 'market' }, false, false, true)).not.toBeNull();
    expect(liveTicketLegsProblem({ ...bare, stopLoss: 24_990 }, false, false, true)).not.toBeNull();
  });
});

describe('shared PC/phone group manage bridge', () => {
  const harness = () => {
    let snapshot = status(position()); let fresh = true;
    const relay = vi.fn(async (_route: string, _command: LeaderOrderManageCommand) => ({ result: { type: 'leader-order-managed', status: 'acknowledged', blockers: [] } }));
    const desk = createLiveDeskCommands({ status: () => ({ status: snapshot as unknown as LocalCopierAgentStatus, fresh }),
      relayId: () => 'connection-1', relay, newOperationId: () => 'manage:group000000001' });
    return { desk, relay, snapshot, setFresh: (value: boolean) => { fresh = value; }, replace: (value: ReturnType<typeof status>) => { snapshot = value; } };
  };
  it('sends add/remove/move and close through the existing relay with leader qty and group hash', async () => {
    const h = harness(); const seen = groupLimitLegTrade(h.snapshot.controller.groupLimitTrades[0])!;
    await h.desk.manageBareLeg(seen, { kind: 'remove', leg: 'takeProfit', stop: 24_990, target: 25_020 });
    expect(h.relay).toHaveBeenLastCalledWith('connection-1', expect.objectContaining({ groupLimitContract: 1, groupLimitStateHash: seen.groupLimitStateHash,
      entryOperationId: OP, action: 'remove-leg', expect: { price: 25_000, quantity: 2, stop: 24_990, target: 25_020 } }));
    await h.desk.closeBareLeader(seen);
    expect(h.relay).toHaveBeenLastCalledWith('connection-1', expect.objectContaining({ action: 'close-position', groupLimitContract: 1, expect: { price: 25_000, quantity: 2 } }));
  });
  it.each(['capability', 'group', 'leader'] as const)('C7 sequence never falls back after %s changes on the same relay', async change => {
    const a = pending(), b = pending(); b.entryOperationId = 'entry:second0000001';
    const entries = [a, b].map((t, i) => ({ entryOperationId: t.entryOperationId, entryBrokerOrderId: t.accounts[0].entry!.brokerOrderId,
      symbol: t.symbol, side: t.side, quantity: 2, orderType: 'Limit' as const, price: 25_000, scaleIn: false, createdAt: i + 1 }));
    const initial = status(a); initial.controller.groupLimitTrades.push(b);
    const snapshot = { ...initial, controller: { ...initial.controller, pendingOwnEntries: entries } };
    const relay = vi.fn(async (_route: string, command: unknown) => {
      expect(validateLeaderOrderManage(command).groupLimitContract).toBe(1);
      if (change === 'capability') snapshot.capabilities = [COPIER_MANUAL_ORDER_CANCEL_PENDING_CAPABILITY];
      if (change === 'group') snapshot.group.id = 'other-group';
      if (change === 'leader') snapshot.group.leaderAccountId = 99;
      return { result: { type: 'leader-order-managed', status: 'acknowledged', blockers: [] } };
    });
    let seq = 0;
    const desk = createLiveDeskCommands({ status: () => ({ status: snapshot as unknown as LocalCopierAgentStatus, fresh: true }),
      relayId: () => 'same-route', relay, newOperationId: () => `manage:sequence00000${++seq}` });
    const results = await desk.cancelPendingEntries(entries);
    expect(relay).toHaveBeenCalledTimes(1);
    expect(results[1].outcome).toBe('blocked');
    expect(results[1].text).toMatch(/nic se neodeslalo/);
  });
  it('a stale pointer-down hash cannot be replaced by the latest bare-leg display trade', async () => {
    const h = harness(); const oldHash = h.snapshot.controller.groupLimitTrades[0].stateHash;
    h.snapshot.controller.groupLimitTrades[0].stateHash = 'newhash1234567890';
    const latest = groupLimitLegTrade(h.snapshot.controller.groupLimitTrades[0])!;
    await expect(h.desk.manageBareLeg(latest, { kind: 'move', leg: 'stopLoss', price: 24_995, current: 24_990, groupLimitStateHash: oldHash })).rejects.toThrow();
    expect(h.relay).not.toHaveBeenCalled();
  });
  it('PC × line -> shared runner -> real desk bridge -> strict validator uses entry price and actual leader qty', async () => {
    const h = harness(); const trade = h.snapshot.controller.groupLimitTrades[0];
    const summary = { kind: 'position', side: 'long', quantity: 6, entry: 25_000, entryType: null, stop: 24_990, target: 25_020,
      mark: 25_010, leader: { accountId: 1, quantity: 2, entry: 25_000 }, rows: [], accounts: 2, scopeLabel: null, openPnl: null, protection: '' } as LiveChartPositionSummary;
    const line = livePositionChartLines(summary, { manageable: true, canClose: true, entryAvg: 25_000, pointValue: 2, groupLimitStateHash: trade.stateHash })[0];
    expect(line.cancelAction).toBe('close-position'); expect(line.cancellable).toBe(true);
    const run = createLiveManageRun({ manage: () => (action, _legacyStop, _price, seenHash) => h.desk.manageGroupLimitPosition({
      action: action as 'close-position', entryOperationId: OP, symbol: 'MNQZ6', groupLimitStateHash: seenHash! }),
      busyRef: { current: false }, setPendingMove: vi.fn(), report: vi.fn() });
    await run('close-position', summary.stop, undefined, undefined, line.groupLimitStateHash);
    const command = validateLeaderOrderManage(h.relay.mock.calls[0][1]);
    expect(command.expect).toEqual({ price: 25_000, quantity: 2 }); expect(command.expect.price).not.toBe(summary.stop);
    expect(command.groupLimitStateHash).toBe(trade.stateHash);
  });
  it('phone attach intent after market moved -> real desk bridge translates quote expectation to leader entry price', async () => {
    const h = harness(); const trade = h.snapshot.controller.groupLimitTrades[0];
    for (const row of trade.accounts) { row.stop = null; row.target = null; }
    const intent = liveAttachIntent({ bareEntry: { operationId: OP, symbol: 'MNQZ6', side: 'Buy', quantity: 2 },
      position: { side: 'long', quantity: 2, symbol: 'MNQZ6', pending: null },
      quote: { symbol: 'MNQZ6', bid: 25_010, ask: 25_010.25, at: 1000 }, stopLoss: 24_990, takeProfit: 25_030, tickSize: 0.25, now: 1000 });
    expect('error' in intent).toBe(false); if ('error' in intent) return;
    expect(intent.attach.expectPrice).toBe(25_010);
    await h.desk.manageGroupLimitPosition({ ...intent.attach, action: 'attach-brackets', groupLimitStateHash: trade.stateHash });
    const command = validateLeaderOrderManage(h.relay.mock.calls[0][1]);
    expect(command).toMatchObject({ action: 'attach-brackets', expect: { price: 25_000, quantity: 2 }, stopLoss: 24_990, takeProfit: 25_030 });
  });
  it('group position bridge never translates a stale hash or missing capability into a legacy close or attach', async () => {
    for (const action of ['close-position', 'attach-brackets'] as const) {
      const h = harness(); const seenHash = h.snapshot.controller.groupLimitTrades[0].stateHash;
      h.snapshot.controller.groupLimitTrades[0].stateHash = 'newstate12345678';
      await expect(h.desk.manageGroupLimitPosition({ action, entryOperationId: OP, symbol: 'MNQZ6', groupLimitStateHash: seenHash,
        ...(action === 'attach-brackets' ? { stopLoss: 24_990, takeProfit: 25_020 } : {}) })).rejects.toThrow();
      h.snapshot.capabilities = ['manual-order-close-v1', 'manual-entry-bare-v1'];
      await expect(h.desk.manageGroupLimitPosition({ action, entryOperationId: OP, symbol: 'MNQZ6', groupLimitStateHash: seenHash })).rejects.toThrow();
      expect(h.relay).not.toHaveBeenCalled();
    }
  });
  it('fresh changed hash, pending remainder, absent DTO and stale status send nothing; no solo fallback', async () => {
    for (const change of [
      (h: ReturnType<typeof harness>) => { h.snapshot.controller.groupLimitTrades[0].stateHash = 'changed1234567890'; },
      (h: ReturnType<typeof harness>) => { h.snapshot.controller.groupLimitTrades[0].accounts[1].entry!.state = 'working'; },
      (h: ReturnType<typeof harness>) => { h.snapshot.controller.groupLimitTrades = []; },
      (h: ReturnType<typeof harness>) => { h.snapshot.capabilities = ['manual-order-single-leg-v1', 'manual-order-close-bare-v1']; },
      (h: ReturnType<typeof harness>) => { h.setFresh(false); },
    ]) { const h = harness(); const seen = groupLimitLegTrade(h.snapshot.controller.groupLimitTrades[0])!; change(h);
      await expect(h.desk.manageBareLeg(seen, { kind: 'add', leg: 'stopLoss', price: 24_990, stop: null, target: null })).rejects.toThrow();
      expect(h.relay).not.toHaveBeenCalled(); }
  });
});

describe('truthful group outcome text', () => {
  const result = (status: LeaderOrderManageResult['status']): LeaderOrderManageResult => ({ type: 'leader-order-managed',
    operationId: 'manage:outcome000001', action: 'move-stop', status, checkedAt: 1, blockers: [] });
  it('only coordinator ACK says all members verified; unknown never claims success', () => {
    expect(groupLimitOutcomeNotice('move-stop', result('acknowledged'), 1)).toMatchObject({ tone: 'ok', text: expect.stringMatching(/ověřeno na všech účtech/) });
    const unknown = groupLimitOutcomeNotice('move-stop', result('unknown'), 1);
    expect(unknown.tone).toBe('warn'); expect(unknown.text).toMatch(/není ověřený/); expect(unknown.text).not.toMatch(/ověřeno na všech/);
  });
  it('PC runner captures group mode before await, so a changing display cannot reclassify the result', async () => {
    let token: string | null = 'groupstate1234567'; let resolve!: (value: LeaderOrderManageResult) => void;
    const pending = new Promise<LeaderOrderManageResult>(done => { resolve = done; });
    const report = vi.fn();
    const run = createLiveManageRun({ manage: () => () => pending, groupLimitStateHash: () => token,
      busyRef: { current: false }, setPendingMove: vi.fn(), report });
    const running = run('move-stop', 24_990, 24_995, 'stopLoss');
    token = null; resolve(result('acknowledged')); await running;
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ tone: 'ok', text: expect.stringMatching(/ověřeno na všech účtech/) }));
  });
});
