import { describe, expect, it } from 'vitest';
import {
  readRetainedEligibility,
  resolveDisplayEligibility,
  writeRetainedEligibility,
} from '../lib/retainedEligibilityDisplay';
import type { CopierAccountEligibility } from '../services/copierEngine';

const storage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
};
const dll = (accountId: number): CopierAccountEligibility => ({ accountId, state: 'dll-locked', reason: 'DLL vyčerpán', at: 1 });

describe('paměť rozhodnutí o způsobilosti pro aktuální obchodní den', () => {
  it('rozhodnuté účty si zapamatuje, nerozhodnuté převezmou dnešní rozhodnutí', () => {
    const first = resolveDisplayEligibility({
      accountIds: [1, 2],
      effective: new Map([[1, dll(1)]]),
      isUndecided: () => false,
      retained: { tradeDate: '2026-10-05', states: {} },
    });
    expect(first.retained.states).toEqual({ '1': { state: 'dll-locked', reason: 'DLL vyčerpán' }, '2': { state: 'active' } });

    // Další otevření: zatím nic nejde rozhodnout.
    const next = resolveDisplayEligibility({
      accountIds: [1, 2],
      effective: new Map(),
      isUndecided: () => true,
      retained: first.retained,
    });
    expect(next.undecided.size).toBe(0);
    expect(next.byAccount.get(1)?.state).toBe('dll-locked');
    expect(next.byAccount.get(1)?.reason).toContain('naposledy potvrzeno dnes');
    expect(next.byAccount.has(2)).toBe(false);
  });

  it('bez dnešního rozhodnutí zůstane účet nerozhodnutý', () => {
    const result = resolveDisplayEligibility({
      accountIds: [3], effective: new Map(), isUndecided: () => true,
      retained: { tradeDate: '2026-10-05', states: {} },
    });
    expect([...result.undecided]).toEqual([3]);
  });

  it('rozhodnutí z jiného obchodního dne se nepoužije', () => {
    const store = storage();
    writeRetainedEligibility('user', { tradeDate: '2026-10-02', states: { '1': { state: 'dll-locked' } } }, store);
    expect(readRetainedEligibility('user', '2026-10-05', store).states).toEqual({});
    expect(readRetainedEligibility('user', '2026-10-02', store).states['1']?.state).toBe('dll-locked');
  });

  it('paměť patří jen jednomu uživateli', () => {
    const store = storage();
    writeRetainedEligibility('user-a', { tradeDate: '2026-10-05', states: { '1': { state: 'active' } } }, store);
    expect(readRetainedEligibility('user-b', '2026-10-05', store).states).toEqual({});
  });

  it('nejistý stav (unverifiable) se do paměti neukládá', () => {
    const result = resolveDisplayEligibility({
      accountIds: [4],
      effective: new Map([[4, { accountId: 4, state: 'unverifiable', at: 1 } as CopierAccountEligibility]]),
      isUndecided: () => false,
      retained: { tradeDate: '2026-10-05', states: {} },
    });
    expect(result.retained.states).toEqual({});
  });
});
