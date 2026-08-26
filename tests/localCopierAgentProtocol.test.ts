import { describe, expect, it } from 'vitest';
import {
  copyGroupAccountIds,
  resolveLocalExecutionGroup,
  sameCopyGroupAccounts,
} from '../lib/localCopierAgentProtocol';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const group = (id: string, leader: number | null, followers: number[]): CopyGroupConfig => ({
  id,
  name: id,
  enabled: true,
  leaderAccountId: leader,
  followers: followers.map(accountId => ({ accountId, mode: 'on-submit', multiplier: 1 })),
});

describe('local copier agent group matching', () => {
  it('matches UI and runtime groups only when the exact account set is equal', () => {
    expect(sameCopyGroupAccounts(group('ui', 11, [22]), group('runtime', 11, [22]))).toBe(true);
    expect(sameCopyGroupAccounts(group('ui', 11, [22, 33]), group('runtime', 11, [22]))).toBe(false);
    expect(sameCopyGroupAccounts(group('ui', 11, [33]), group('runtime', 11, [22]))).toBe(false);
    expect(sameCopyGroupAccounts(group('ui', 22, [11]), group('runtime', 11, [22]))).toBe(false);
  });

  it('sorts account ids and rejects an incomplete group', () => {
    expect(copyGroupAccountIds(group('ui', 22, [11]))).toEqual([11, 22]);
    expect(sameCopyGroupAccounts(group('ui', null, [22]), group('runtime', 11, [22]))).toBe(false);
  });

  it('keeps the runtime attached while a unique UI group changes followers', () => {
    const runtime = group('runtime', 11, [22]);
    const edited = group('ui', 11, [22, 33]);
    expect(resolveLocalExecutionGroup([edited], runtime)).toEqual(edited);
  });

  it('keeps the runtime attached by stable group id while UI changes the leader epoch', () => {
    const runtime = group('stable-slot', 11, [22]);
    const edited = group('stable-slot', 22, [11]);
    expect(resolveLocalExecutionGroup([
      group('other', 44, [33]),
      edited,
    ], runtime)).toEqual(edited);
  });

  it('prefers an exact topology and fails closed when leader matching is ambiguous', () => {
    const runtime = group('runtime', 11, [22]);
    const exact = group('exact', 11, [22]);
    const other = group('other', 33, [44]);
    expect(resolveLocalExecutionGroup([other, exact], runtime)).toEqual(exact);
    expect(resolveLocalExecutionGroup([
      group('one', 11, [33]),
      group('two', 11, [44]),
    ], runtime)).toBeNull();
  });

  it('povolí překryv účtů, ale execution profil vybírá jednoznačně podle id', () => {
    const runtime = group('second', 11, [22]);
    const first = group('first', 11, [22]);
    const second = group('second', 11, [22]);
    expect(resolveLocalExecutionGroup([first, second], runtime)).toEqual(second);
  });

  it('fail-closes nejednoznačnou topologii bez shody stabilního id', () => {
    const runtime = group('runtime', 11, [22]);
    expect(resolveLocalExecutionGroup([
      group('first', 11, [22]),
      group('second', 11, [22]),
    ], runtime)).toBeNull();
  });
});
