import { describe, expect, it, vi } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import type { GroupLimitMemberRecord } from '../services/groupLimitLifecycle';
import { executeGroupLimitManagement, type GroupLimitManagementExecution, type GroupLimitMemberSnapshot } from '../services/groupLimitLifecycleExecution';
import { buildLeaderOrderManageCommand } from '../lib/leaderOrderManage';

const SYMBOL = 'MNQZ6', ENTRY = 29_500, SL = 29_480, TP = 29_550;
function harness(initial: 'bare' | 'stop' | 'target' = 'bare') {
  const orders = new Map<string, BrokerOrder>();
  const events: string[] = [];
  const wal: GroupLimitMemberRecord[][] = [];
  const members = [100, 200].map((accountId, index): GroupLimitMemberRecord => ({
    accountId, entryId: `${accountId}-entry`, quantity: index ? 4 : 2, entryFrom: ENTRY,
    status: 'planned', tag: `own-group-${accountId}`,
    ...(initial === 'stop' ? { stopId: `${accountId}-old-sl`, stopFrom: SL } : {}),
    ...(initial === 'target' ? { targetId: `${accountId}-old-tp`, targetFrom: TP } : {}),
  }));
  function order(accountId: number, id: string, type: 'Stop' | 'Limit', price: number, quantity: number): BrokerOrder {
    return { accountId, brokerOrderId: id, tag: `own-group-${accountId}`, symbol: SYMBOL, side: 'Sell', orderType: type,
      quantity, filledQuantity: 0, status: 'working', updatedAt: 100, sourceVersion: `${id}-v1`,
      ...(type === 'Stop' ? { stopPrice: price } : { limitPrice: price }) };
  }
  for (const member of members) {
    if (member.stopId) orders.set(member.stopId, order(member.accountId, member.stopId, 'Stop', SL, member.quantity));
    if (member.targetId) orders.set(member.targetId, order(member.accountId, member.targetId, 'Limit', TP, member.quantity));
  }
  const snapshots = new Map<number, GroupLimitMemberSnapshot>(members.map(member => [member.accountId, {
    net: member.quantity, orders: [...orders.values()].filter(row => row.accountId === member.accountId).map(row => ({ ...row })),
  }]));
  const command = buildLeaderOrderManageCommand({ groupId: 'group-test', leaderAccountId: 100, entryOperationId: 'entry:execution00001',
    operationId: 'manage:execution00001', symbol: SYMBOL, action: 'add-leg', leg: initial === 'stop' ? 'takeProfit' : 'stopLoss',
    newPrice: initial === 'stop' ? TP : SL, expect: { price: ENTRY, quantity: 2 }, groupLimitContract: 1, groupLimitStateHash: 'abc123def456' });
  const input: GroupLimitManagementExecution = {
    command, symbol: SYMBOL, side: 'Buy', members, snapshots,
    guard: vi.fn(async expected => {
      for (const [id, snapshot] of expected) {
        const current = [...orders.values()].filter(row => row.accountId === id && row.status === 'working');
        if (JSON.stringify(current.sort((a, b) => a.brokerOrderId.localeCompare(b.brokerOrderId)))
          !== JSON.stringify([...snapshot.orders].sort((a, b) => a.brokerOrderId.localeCompare(b.brokerOrderId)))) return 'externally changed orders';
      }
      return null;
    }),
    save: vi.fn(async rows => { wal.push(structuredClone(rows)); }), bind: vi.fn(async () => {}),
    place: vi.fn(async request => { events.push(`place:${request.accountId}`); const id = `${request.accountId}-new-leg`;
      orders.set(id, order(request.accountId, id, request.orderType as 'Stop' | 'Limit', request.stopPrice ?? request.limitPrice!, request.quantity)); return id; }),
    oco: vi.fn(async request => { events.push(`oco:${request.accountId}`); const stopId = `${request.accountId}-new-sl`, targetId = `${request.accountId}-new-tp`;
      orders.set(stopId, { ...order(request.accountId, stopId, 'Stop', request.first.stopPrice!, request.quantity), ocoId: targetId, linkedOrderId: targetId });
      orders.set(targetId, { ...order(request.accountId, targetId, 'Limit', request.second.limitPrice!, request.quantity), ocoId: stopId, linkedOrderId: stopId }); return { stopId, targetId }; }),
    modify: vi.fn(async (_account, id, _quantity, type, price) => { const row = orders.get(id)!; if (type === 'Stop') row.stopPrice = price; else row.limitPrice = price; }),
    cancel: vi.fn(async (account, id) => { events.push(`cancel:${account}:${id}`); orders.get(id)!.status = 'canceled'; }),
    lookup: vi.fn(async (_account, id) => { const row = orders.get(id); return row ? { ...row } : null; }),
  };
  return { input, orders, events, wal };
}

describe('group LIMIT leg write coordinator failure boundaries', () => {
  it('adds the first leg with actual per-account quantities and durable intent before dispatch', async () => {
    const h = harness();
    const original = h.input.place;
    h.input.place = vi.fn(async request => {
      const saved = h.wal.at(-1)!.find(member => member.accountId === request.accountId)!;
      expect(saved).toMatchObject({ status: 'sending', phase: 'write-sending', tag: request.tag, quantity: request.quantity });
      return original(request);
    });
    expect(await executeGroupLimitManagement(h.input)).toEqual({ status: 'acknowledged' });
    expect(h.events).toEqual(['place:100', 'place:200']);
    expect([...h.orders.values()].map(row => row.quantity)).toEqual([2, 4]);
    expect(h.wal.at(-1)!.map(member => member.status)).toEqual(['acknowledged', 'acknowledged']);
  });
  it('SL-only promotion verifies new OCO before canceling old SL and accepts its exact own state changes', async () => {
    const h = harness('stop');
    const originalCancel = h.input.cancel;
    h.input.cancel = vi.fn(async (account, id) => {
      const member = h.wal.at(-1)!.find(row => row.accountId === account)!;
      expect(member).toMatchObject({ phase: 'oco-acked', newStopId: `${account}-new-sl`, newTargetId: `${account}-new-tp` });
      expect(h.input.lookup).toHaveBeenCalledWith(account, member.newStopId);
      expect(h.input.lookup).toHaveBeenCalledWith(account, member.newTargetId);
      return originalCancel(account, id);
    });
    expect(await executeGroupLimitManagement(h.input)).toEqual({ status: 'acknowledged' });
    expect(h.events).toEqual(['oco:100', 'cancel:100:100-old-sl', 'oco:200', 'cancel:200:200-old-sl']);
    expect(h.input.guard).toHaveBeenCalledWith(expect.any(Map), true);
  });
  it('TP-only promotion proves old target canceled before placing OCO', async () => {
    const h = harness('target'); const originalOco = h.input.oco;
    h.input.oco = vi.fn(async request => {
      expect(h.orders.get(`${request.accountId}-old-tp`)?.status).toBe('canceled');
      expect(h.wal.at(-1)!.find(member => member.accountId === request.accountId)?.phase).toBe('target-canceled');
      return originalOco(request);
    });
    expect(await executeGroupLimitManagement(h.input)).toEqual({ status: 'acknowledged' });
    expect(h.events).toEqual(['cancel:100:100-old-tp', 'oco:100', 'cancel:200:200-old-tp', 'oco:200']);
  });
  it.each(['missing', 'mismatched'] as const)('keeps old SL and refuses group success when the new OCO linkage is %s', async mode => {
    const h = harness('stop'); const originalOco = h.input.oco;
    h.input.oco = vi.fn(async request => {
      const ids = await originalOco(request);
      for (const id of [ids.stopId, ids.targetId]) {
        const row = h.orders.get(id)!;
        if (mode === 'missing') { delete row.ocoId; delete row.linkedOrderId; }
        else { row.ocoId = 'foreign-order'; row.linkedOrderId = 'foreign-order'; }
      }
      return ids;
    });
    expect(await executeGroupLimitManagement(h.input)).toMatchObject({ status: 'unknown' });
    expect(h.events).toEqual(['oco:100']);
    expect(h.orders.get('100-old-sl')?.status).toBe('working');
    expect(h.input.cancel).not.toHaveBeenCalled();
  });
  it('external change after the first OCO blocks cleanup and all later members', async () => {
    const h = harness('stop'); const originalLookup = h.input.lookup;
    h.input.lookup = vi.fn(async (account, id) => {
      const found = await originalLookup(account, id);
      if (id === '100-new-tp') h.orders.get('200-old-sl')!.stopPrice! -= 1;
      return found;
    });
    expect(await executeGroupLimitManagement(h.input)).toMatchObject({ status: 'unknown', reason: 'externally changed orders' });
    expect(h.events).toEqual(['oco:100']);
    expect(h.orders.get('100-old-sl')!.status).toBe('working');
    expect(h.wal.at(-1)!.map(member => member.status)).toEqual(['unknown', 'planned']);
  });
  it('a lost ACK never retries or starts another account', async () => {
    const h = harness(); const originalPlace = h.input.place;
    h.input.place = vi.fn(async request => { await originalPlace(request); throw new Error('ACK lost'); });
    expect(await executeGroupLimitManagement(h.input)).toEqual({ status: 'unknown', reason: 'ACK lost' });
    expect(h.events).toEqual(['place:100']);
    expect(h.input.place).toHaveBeenCalledTimes(1);
    expect(h.wal.at(-1)![0]).toMatchObject({ status: 'unknown', phase: 'write-sending', tag: 'own-group-100' });
  });
  it('prewrite brake/config change sends no broker request', async () => {
    const h = harness(); h.input.guard = vi.fn(async () => 'brake changed');
    expect(await executeGroupLimitManagement(h.input)).toMatchObject({ status: 'not-sent', reason: 'brake changed' });
    expect(h.events).toEqual([]); expect(h.input.oco).not.toHaveBeenCalled();
  });
  it('a fill while canceling old TP does not create replacement OCO', async () => {
    const h = harness('target');
    h.input.cancel = vi.fn(async (account, id) => { h.events.push(`cancel:${account}:${id}`); Object.assign(h.orders.get(id)!, { status: 'filled', filledQuantity: 1 }); });
    expect(await executeGroupLimitManagement(h.input)).toMatchObject({ status: 'unknown' });
    expect(h.events).toEqual(['cancel:100:100-old-tp']); expect(h.input.oco).not.toHaveBeenCalled();
  });
});
