import { describe, expect, it } from 'vitest';
import { GROUP_LIMIT_CONTRACT, isGroupLimitTradeStates, type GroupLimitTradeState } from '../lib/groupLimitProtocol';
import { buildLeaderEntryPreviewCommand, validateLeaderEntryPreview } from '../lib/leaderEntryPreview';
import { buildLeaderEntryPlaceCommand, leaderEntryPlaceAsPreview, leaderEntryPayloadHash, validateLeaderEntryPlace } from '../lib/leaderEntryPlace';
import { buildLeaderOrderManageCommand, leaderOrderManagePayloadHash, validateLeaderOrderManage } from '../lib/leaderOrderManage';
import { supportsCopierGroupLimitMove, supportsCopierGroupLimitBare, supportsCopierGroupLimitManage } from '../lib/copierWorkerCapabilities';

const preview = () => buildLeaderEntryPreviewCommand({
  symbol: 'MNQZ6', side: 'Buy', quantity: 2, orderType: 'Limit', price: 29_500,
}, {
  group: { id: 'group-test', enabled: true, leaderAccountId: 100, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 2 }] },
  armedAt: 1000, excludedFollowers: new Set(), participation: [], operationId: 'preview:grouplimit01',
  groupLimitContract: GROUP_LIMIT_CONTRACT,
});

describe('per-account group LIMIT read model', () => {
  const trade = (): GroupLimitTradeState => ({
    groupId: 'group-test', entryOperationId: 'entry:grouplimit01', symbol: 'MNQZ6', side: 'Buy', stateHash: 'abc123def456', state: 'pending',
    accounts: [70771429, 70423188].map((accountId, index) => ({
      accountId, role: index === 0 ? 'leader' : 'follower', expectedQuantity: index + 1, openQuantity: 0,
      entry: { brokerOrderId: String(611860533628 + index), quantity: index + 1, filledQuantity: 0, price: 29_500, state: 'working' },
      stop: null, target: null, state: 'pending', verifiedAt: 1000,
    })),
  });
  it('accepts actual large account IDs and keeps individual quantities', () => {
    expect(isGroupLimitTradeStates([trade()])).toBe(true);
  });
  it('rejects duplicate member identity or two leaders instead of displaying false group coverage', () => {
    const duplicate = trade(); duplicate.accounts[1].accountId = duplicate.accounts[0].accountId;
    expect(isGroupLimitTradeStates([duplicate])).toBe(false);
    const leaders = trade(); leaders.accounts[1].role = 'leader';
    expect(isGroupLimitTradeStates([leaders])).toBe(false);
  });
  it('rejects missing order evidence, negative exposure and overfilled quantities', () => {
    const missing = trade(); delete (missing.accounts[1] as Partial<typeof missing.accounts[number]>).entry;
    expect(isGroupLimitTradeStates([missing])).toBe(false);
    const negative = trade(); negative.accounts[1].openQuantity = -1;
    expect(isGroupLimitTradeStates([negative])).toBe(false);
    const overfill = trade(); overfill.accounts[0].entry!.filledQuantity = 5;
    expect(isGroupLimitTradeStates([overfill])).toBe(false);
  });
});

const manage = () => buildLeaderOrderManageCommand({
  groupId: 'group-test', leaderAccountId: 100, entryOperationId: 'entry:grouplimit01', operationId: 'manage:grouplimit01',
  symbol: 'MNQZ6', action: 'move-limit', expect: { price: 29_500, quantity: 2 }, newPrice: 29_499,
  moveLimitContract: 2, groupLimitContract: GROUP_LIMIT_CONTRACT, groupLimitStateHash: 'abc123def456',
});

describe('versioned group LIMIT protocol', () => {
  it('preserves explicit group intent and participant quantities through preview and durable entry hash', () => {
    const p = preview();
    expect(validateLeaderEntryPreview(p).intent.followerQuantities).toEqual([{ accountId: 200, quantity: 4 }]);
    const entry = buildLeaderEntryPlaceCommand(p, 'entry:grouplimit01');
    expect(validateLeaderEntryPlace(entry).groupLimitContract).toBe(1);
    expect(leaderEntryPlaceAsPreview(entry).groupLimitContract).toBe(1);
    const changed = { ...entry, groupLimitContract: undefined };
    expect(() => validateLeaderEntryPlace(changed)).toThrow('invalid-relay-command-payload');
  });

  it.each(['Stop', 'Market'] as const)('does not let a group LIMIT contract authorize %s', orderType => {
    const base = preview();
    const next = { ...base, orderType,
      ...(orderType === 'Market' ? { price: undefined, referencePrice: 29_500, quoteReceivedAt: 1000 } : {}),
    };
    expect(() => validateLeaderEntryPreview(next)).toThrow('invalid-relay-command-payload');
  });

  it('rejects another group contract version even with a recomputed payload hash', () => {
    const entry = { ...buildLeaderEntryPlaceCommand(preview(), 'entry:grouplimit01'), groupLimitContract: 2 };
    entry.payloadHash = leaderEntryPayloadHash(entry as never);
    expect(() => validateLeaderEntryPlace(entry)).toThrow('invalid-relay-command-payload');
  });

  it('binds management to its exact observed group state', () => {
    const command = manage();
    expect(validateLeaderOrderManage(command).groupLimitStateHash).toBe('abc123def456');
    expect(() => validateLeaderOrderManage({ ...command, groupLimitStateHash: 'abc123def457' })).toThrow();
    const withoutHash = { ...command, groupLimitStateHash: undefined };
    withoutHash.payloadHash = leaderOrderManagePayloadHash(withoutHash);
    expect(() => validateLeaderOrderManage(withoutHash)).toThrow();
    const withoutContract = { ...command, groupLimitContract: undefined };
    withoutContract.payloadHash = leaderOrderManagePayloadHash(withoutContract);
    expect(() => validateLeaderOrderManage(withoutContract)).toThrow();
  });

  it('cannot reinterpret tracked/aggregate management as ownership of a group entry', () => {
    const aggregate = { ...manage(), scope: 'position' as const };
    aggregate.payloadHash = leaderOrderManagePayloadHash(aggregate);
    expect(() => validateLeaderOrderManage(aggregate)).toThrow();
    const tracked = { ...manage(), entryOperationId: undefined, leaderEntryOrderId: '123456' };
    tracked.payloadHash = leaderOrderManagePayloadHash(tracked);
    expect(() => validateLeaderOrderManage(tracked)).toThrow();
  });

  it('does not infer group support from unrelated solo capabilities', () => {
    const solo = { capabilities: ['manual-order-move-limit-v2', 'manual-entry-bare-pending-v1', 'manual-order-single-leg-v1'] };
    expect(supportsCopierGroupLimitMove(solo)).toBe(false);
    expect(supportsCopierGroupLimitBare(solo)).toBe(false);
    expect(supportsCopierGroupLimitManage(solo)).toBe(false);
  });
});
