import { describe, it, expect } from 'vitest';
import { reconcileDashboardRows } from '../utils/dashboardRefresh';

describe('cold dashboard cache refresh', () => {
  it('accepts note, tags, quantity and risk edits with unchanged id/pnl/timestamp', () => {
    const old = [{ id: 't', pnl: 100, timestamp: 'today', notes: 'old', quantity: 1, riskAmount: 50, tags: ['a'] }];
    const fresh = [{ ...old[0], notes: 'new', quantity: 3, riskAmount: 120, tags: ['b'] }];
    expect(reconcileDashboardRows(old, fresh)).toBe(fresh);
  });
  it('accepts edits of existing account/preparation/review/focus content', () => {
    for (const field of ['name', 'initialBalance', 'notes', 'focus']) {
      const old = [{ id: 'existing', date: 'today', [field]: 'old' }];
      const fresh = [{ id: 'existing', date: 'today', [field]: 'new' }];
      expect(reconcileDashboardRows(old, fresh)).toBe(fresh);
    }
  });
  it('accepts deletion, retains unchanged references and preserves pending local edits', () => {
    const old = [{ id: 'a', notes: 'local edit' }];
    expect(reconcileDashboardRows(old, [])).toEqual([]);
    expect(reconcileDashboardRows(old, [{ ...old[0] }])).toBe(old);
    expect(reconcileDashboardRows(old, [{ id: 'a', notes: 'server' }], true)).toBe(old);
  });
  it('shodné objekty (delta sync beze změny) vrátí původní pole bez serializace', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const stringify = JSON.stringify;
    let calls = 0;
    JSON.stringify = ((...args: Parameters<typeof stringify>) => { calls += 1; return stringify(...args); }) as typeof JSON.stringify;
    try {
      expect(reconcileDashboardRows(rows, [...rows])).toBe(rows);
    } finally { JSON.stringify = stringify; }
    expect(calls).toBe(0);
  });
});
