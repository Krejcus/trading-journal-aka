import { describe, expect, it } from 'vitest';
import { createCopierState, type CopierManualEntryRecord, type FollowerOrderLink } from '../services/copierEngine';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';
import { projectGroupLimitTrade, type GroupLimitProjectionInput } from '../services/groupLimitLifecycle';
import type { BrokerOrder } from '../services/brokerPort';
import type { OsoOutboxEntry } from '../services/copierOsoOutbox';
import type { OutboxEntry } from '../services/copierOutbox';
import { copyGroupConfigHash } from '../lib/leaderEntryPreview';
import { groupLimitPositionManageTrade, groupLimitOwnManageEntry } from '../lib/groupLimitUi';
import { COPIER_GROUP_LIMIT_MANAGE_CAPABILITY } from '../lib/copierWorkerCapabilities';

const LEADER = 61_038_658, A = 73_895_341, B = 73_895_342;
const SYMBOL = 'MNQZ6', ENTRY = 26_950.25, SL = 26_940.25, TP = 26_970.25;
const NOW = Date.UTC(2026, 10, 9, 15);
const group = (): CopyGroupConfig => ({ id: 'lucid-projection', name: 'Projection', enabled: true, localOnly: true,
  leaderAccountId: LEADER, safety: { ...DEFAULT_COPY_GROUP_SAFETY, leaderMaxContracts: { accountId: LEADER, contracts: 5 } },
  followers: [{ accountId: A, mode: 'on-submit', multiplier: 2, maxContracts: 10 }, { accountId: B, mode: 'on-submit', multiplier: 1, maxContracts: 5 }] });

function fixture(bare = false) {
  const config = group();
  const entry: CopierManualEntryRecord = { operationId: 'entry:projection001', payloadHash: 'hash', tag: 'manual-entry',
    status: 'acknowledged', createdAt: NOW, updatedAt: NOW,
    request: { accountId: LEADER, symbol: SYMBOL, side: 'Buy', quantity: 2, orderType: 'Limit', price: ENTRY,
      ...(!bare ? { stopLoss: SL, takeProfit: TP } : {}) },
    groupLimitContract: 1, groupLimitConfigHash: copyGroupConfigHash(config),
    groupLimitParticipants: [{ accountId: A, quantity: 4 }, { accountId: B, quantity: 2 }],
    entryBrokerOrderId: 'leader-entry', ...(!bare ? { stopBrokerOrderId: 'leader-sl', targetBrokerOrderId: 'leader-tp' } : { bare: true as const }),
  };
  const links = new Map<string, readonly FollowerOrderLink[]>();
  const state = { ...createCopierState(), links };
  const rows = new Map<number, Map<string, BrokerOrder>>();
  const net = new Map<number, number>();
  const statuses = new Map<string, BrokerOrder['status']>();
  const fills = new Map<string, number>();
  const oso: OsoOutboxEntry[] = [], outbox: OutboxEntry[] = [];
  const add = (id: number, key: string, kind: 'entry' | 'stop' | 'target', q: number, status: BrokerOrder['status'] = kind === 'entry' ? 'working' : 'pending') => {
    const order: BrokerOrder = { accountId: id, brokerOrderId: key, symbol: SYMBOL, side: kind === 'entry' ? 'Buy' : 'Sell',
      tag: key, orderType: kind === 'stop' ? 'Stop' : 'Limit', quantity: q, filledQuantity: 0, status, sourceVersion: `${key}:v1`, updatedAt: NOW,
      ...(kind === 'stop' ? { stopPrice: SL } : { limitPrice: kind === 'entry' ? ENTRY : TP }) };
    if (!rows.has(id)) rows.set(id, new Map()); rows.get(id)!.set(key, order); statuses.set(`${id}:${key}`, status); return order;
  };
  const link = (leader: string, id: number, key: string, q: number) => {
    const existing = state.links.get(leader) ?? [];
    state.links.set(leader, [...existing, { key: `link:${id}:${key}`, accountId: id, brokerOrderId: key, quantity: q } satisfies FollowerOrderLink]);
  };
  for (const [id, q, prefix] of [[LEADER, 2, 'leader'], [A, 4, 'a'], [B, 2, 'b']] as const) {
    net.set(id, 0); add(id, `${prefix}-entry`, 'entry', q);
    if (!bare) { add(id, `${prefix}-sl`, 'stop', q); add(id, `${prefix}-tp`, 'target', q); }
    if (id === LEADER) continue;
    link('leader-entry', id, `${prefix}-entry`, q);
    if (bare) outbox.push({ key: `${prefix}-copy`, tag: `${prefix}-tag`, leaderOrderId: 'leader-entry', request: { tag: `${prefix}-tag`, accountId: id,
      symbol: SYMBOL, side: 'Buy', orderType: 'Limit', quantity: q, limitPrice: ENTRY }, status: 'acknowledged', attempts: 1, brokerOrderId: `${prefix}-entry`, updatedAt: NOW });
    else {
      link('leader-sl', id, `${prefix}-sl`, q); link('leader-tp', id, `${prefix}-tp`, q);
      oso.push({ key: `${prefix}-oso`, tag: `${prefix}-oso`, leaderEntryOrderId: 'leader-entry', leaderStopOrderId: 'leader-sl', leaderTargetOrderId: 'leader-tp',
        leaderEventId: 'leader-submit', leaderSequence: 1, request: { tag: `${prefix}-oso`, accountId: id, symbol: SYMBOL, side: 'Buy', orderType: 'Limit', quantity: q, limitPrice: ENTRY,
          first: { side: 'Sell', orderType: 'Stop', stopPrice: SL }, second: { side: 'Sell', orderType: 'Limit', limitPrice: TP } },
        status: 'acknowledged', attempts: 1, entryBrokerOrderId: `${prefix}-entry`, firstBrokerOrderId: `${prefix}-sl`, secondBrokerOrderId: `${prefix}-tp`, updatedAt: NOW });
    }
  }
  const input: GroupLimitProjectionInput = { group: config, entry, state, oso, outbox, verifiedAt: NOW,
    orders: id => rows.get(id), net: id => net.get(id) ?? null,
    observed: (id, key) => statuses.get(`${id}:${key}`), filled: (id, key) => fills.get(`${id}:${key}`) ?? 0,
    route: id => id === B ? 2 : 1, externalFence: 'configuration-routes-v1' };
  const project = () => projectGroupLimitTrade(input)!;
  const fillAll = () => {
    for (const [id, accountRows] of rows) {
      const own = [...accountRows.values()].find(row => row.side === 'Buy')!;
      own.status = 'filled'; own.filledQuantity = own.quantity; net.set(id, own.quantity);
      statuses.set(`${id}:${own.brokerOrderId}`, 'filled'); fills.set(`${id}:${own.brokerOrderId}`, own.quantity);
      for (const leg of accountRows.values()) if (leg.side === 'Sell') leg.status = 'working';
    }
  };
  const ready = () => groupLimitPositionManageTrade({ capabilities: [COPIER_GROUP_LIMIT_MANAGE_CAPABILITY], group: config,
    controller: { groupLimitTrades: [project()] } }, entry.operationId, SYMBOL);
  return { config, entry, input, state, rows, net, statuses, fills, oso, outbox, add, project, fillAll, ready };
}

describe('group LIMIT projection: real sealed provenance, no broker IO', () => {
  it('projects protected OSO with real large account IDs and distinct 2/4/2 quantities', () => {
    const f = fixture(); const t = f.project();
    expect(t.state).toBe('pending');
    expect(t.accounts.map(row => [row.accountId, row.role, row.expectedQuantity, row.openQuantity])).toEqual([
      [LEADER, 'leader', 2, 0], [A, 'follower', 4, 0], [B, 'follower', 2, 0],
    ]);
    expect(t.accounts.every(row => !row.issue)).toBe(true);
    f.state.links.delete('leader-tp'); expect(f.project().state).toBe('unknown');
  });
  it('heartbeat time is excluded; follower revision, quantity, route and external fence each invalidate the hash', () => {
    const f = fixture(); const hash = f.project().stateHash;
    f.input.verifiedAt = NOW + 30_000;
    for (const rows of f.rows.values()) for (const row of rows.values()) row.updatedAt += 30_000;
    expect(f.project().stateHash).toBe(hash);
    f.rows.get(A)!.get('a-sl')!.sourceVersion = 'externally-edited:v2'; expect(f.project().stateHash).not.toBe(hash);
    f.rows.get(A)!.get('a-sl')!.sourceVersion = 'a-sl:v1';
    f.net.set(A, 1); expect(f.project().stateHash).not.toBe(hash); f.net.set(A, 0);
    f.input.route = id => id === A ? 3 : id === B ? 2 : 1; expect(f.project().stateHash).not.toBe(hash);
    f.input.route = id => id === B ? 2 : 1; f.input.externalFence = 'external-order-net-changed'; expect(f.project().stateHash).not.toBe(hash);
  });
  it('filled entry eviction retains the historical Limit price; it is not a fill VWAP', () => {
    const f = fixture(); f.fillAll();
    for (const rows of f.rows.values()) for (const [key, order] of rows) if (order.side === 'Buy') rows.delete(key);
    const t = f.project(); expect(t.state).toBe('position');
    expect(t.accounts.map(row => row.entry?.price)).toEqual([ENTRY, ENTRY, ENTRY]); expect(f.ready()).not.toBeNull();
  });
  it('protected fill -> remove SL -> managed native OCO IDs keeps original OSO links immutable and DTO manageable', () => {
    const f = fixture(); f.fillAll(); expect(f.ready()).not.toBeNull();
    const originalLinks = JSON.stringify([...f.state.links]);
    const originalOso = JSON.stringify(f.oso);
    f.entry.groupLimitMembers = [LEADER, A, B].map(id => {
      const prefix = id === LEADER ? 'leader' : id === A ? 'a' : 'b';
      const oldStop = f.rows.get(id)!.get(`${prefix}-sl`)!; oldStop.status = 'canceled';
      return { accountId: id, entryId: `${prefix}-entry`, targetId: `${prefix}-tp`, quantity: id === A ? 4 : 2,
        entryFrom: ENTRY, targetFrom: TP, status: 'acknowledged' as const };
    });
    delete f.entry.stopBrokerOrderId;
    expect(f.project().accounts.every(row => row.stop == null)).toBe(true);
    expect(f.project().accounts.every(row => !row.issue)).toBe(true); expect(f.ready()).not.toBeNull();
    const own = groupLimitOwnManageEntry({ capabilities: [COPIER_GROUP_LIMIT_MANAGE_CAPABILITY], group: f.config,
      controller: { groupLimitTrades: [f.project()] } }, SYMBOL, 'long');
    expect(own).toMatchObject({ source: 'own', entryOperationId: f.entry.operationId, leaderEntryOrderId: 'leader-entry' });

    for (const member of f.entry.groupLimitMembers) {
      const prefix = member.accountId === LEADER ? 'leader' : member.accountId === A ? 'a' : 'b';
      f.rows.get(member.accountId)!.get(`${prefix}-tp`)!.status = 'canceled';
      member.stopId = `${prefix}-managed-sl`; member.targetId = `${prefix}-managed-tp`;
      f.add(member.accountId, member.stopId, 'stop', member.quantity, 'working');
      f.add(member.accountId, member.targetId, 'target', member.quantity, 'working');
    }
    f.entry.stopBrokerOrderId = 'leader-managed-sl'; f.entry.targetBrokerOrderId = 'leader-managed-tp';
    const t = f.project(); expect(t.state).toBe('position'); expect(f.ready()).not.toBeNull();
    expect(t.accounts.map(row => [row.stop?.brokerOrderId, row.target?.brokerOrderId])).toEqual([
      ['leader-managed-sl', 'leader-managed-tp'], ['a-managed-sl', 'a-managed-tp'], ['b-managed-sl', 'b-managed-tp'],
    ]);
    expect(JSON.stringify([...f.state.links])).toBe(originalLinks); expect(JSON.stringify(f.oso)).toBe(originalOso);
  });
  it('bare ordinary links + current managed WAL project actual partial quantities and a flat member', () => {
    const f = fixture(true); f.fillAll();
    const a = f.rows.get(A)!.get('a-entry')!; a.status = 'canceled'; a.filledQuantity = 1; f.fills.set(`${A}:a-entry`, 1); f.net.set(A, 1);
    const b = f.rows.get(B)!.get('b-entry')!; b.status = 'canceled'; b.filledQuantity = 0; f.fills.set(`${B}:b-entry`, 0); f.net.set(B, 0);
    f.entry.stopBrokerOrderId = 'leader-new-sl'; f.add(LEADER, 'leader-new-sl', 'stop', 2, 'working'); f.add(A, 'a-new-sl', 'stop', 1, 'working');
    f.entry.groupLimitMembers = [
      { accountId: LEADER, entryId: 'leader-entry', stopId: 'leader-new-sl', quantity: 2, entryFrom: ENTRY, status: 'acknowledged' },
      { accountId: A, entryId: 'a-entry', stopId: 'a-new-sl', quantity: 1, entryFrom: ENTRY, status: 'acknowledged' },
      { accountId: B, entryId: 'b-entry', quantity: 0, entryFrom: ENTRY, status: 'acknowledged' },
    ];
    const t = f.project(); expect(t.state).toBe('mixed');
    expect(t.accounts.map(row => [row.state, row.openQuantity, row.stop?.quantity ?? 0])).toEqual([['position', 2, 2], ['position', 1, 1], ['flat', 0, 0]]);
    expect(f.ready()).not.toBeNull();
    f.outbox[0].status = 'unknown'; expect(f.project().state).toBe('unknown');
  });
  it('a verified closed member is never revived by a later external position on the same symbol', () => {
    const f = fixture(true); f.fillAll();
    f.entry.groupLimitMembers = [LEADER, A, B].map(id => ({ accountId: id,
      entryId: id === LEADER ? 'leader-entry' : id === A ? 'a-entry' : 'b-entry', quantity: id === A ? 4 : 2,
      entryFrom: ENTRY, openedAt: NOW, filledQuantity: id === A ? 4 : 2,
      ...(id === B ? { closedAt: NOW + 1_000 } : {}), status: 'acknowledged' as const }));
    f.net.set(B, 0); expect(f.project().accounts[2].state).toBe('flat'); expect(f.ready()).not.toBeNull();
    f.net.set(B, 2); const revived = f.project();
    expect(revived.accounts[2].state).toBe('unknown'); expect(revived.state).toBe('unknown'); expect(f.ready()).toBeNull();
    f.net.set(B, 0); f.entry.closedAt = NOW + 2_000;
    expect(f.project().accounts[0].state).toBe('unknown'); expect(f.ready()).toBeNull();
  });
  it('sealed exclusions are not invented; configuration changes and missing ownership remain unknown', () => {
    const f = fixture(true); f.entry.groupLimitParticipants = [{ accountId: A, quantity: 4 }];
    expect(f.project().accounts.map(row => row.accountId)).toEqual([LEADER, A]);
    f.config.followers[0].multiplier = 3; expect(f.project().state).toBe('unknown');
  });
});
