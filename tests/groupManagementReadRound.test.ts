import { describe, expect, it } from 'vitest';
import { readGroupManagementRound } from '../services/groupManagementReadRound';

describe('group management read rounds', () => {
  it('bounds simultaneous accounts to four and returns the original order despite out-of-order replies', async () => {
    const members = Array.from({ length: 9 }, (_, index) => ({ accountId: index + 1, entryId: String(index + 1) }));
    let active = 0, peak = 0;
    const result = await readGroupManagementRound(members, {
      listOrders: async accountId => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 10 - accountId)); active--; return []; },
      listPositions: async () => [],
    }, async () => null);
    expect(peak).toBe(4); expect(result.map(row => row.accountId)).toEqual(members.map(member => member.accountId));
  });
  it('drains a failed batch and starts no later account or write', async () => {
    const starts: number[] = []; let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const pending = readGroupManagementRound(Array.from({ length: 5 }, (_, index) => ({ accountId: index + 1, entryId: 'entry' })), {
      listOrders: async accountId => { starts.push(accountId); if (accountId === 1) throw new Error('read failed'); if (accountId === 4) await held; return []; },
      listPositions: async () => [],
    }, async () => null);
    let settled = false; const checked = pending.catch(reason => { settled = true; return reason; });
    await new Promise(resolve => setTimeout(resolve, 0)); expect(settled).toBe(false);
    release(); expect((await checked).message).toBe('read failed'); expect(starts).toEqual([1, 2, 3, 4]);
  });
});
