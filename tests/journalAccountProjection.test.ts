import { describe, expect, it, vi } from 'vitest';
import { projectJournalAccounts } from '../lib/journalAccountProjection';
import { journalObservation, type JournalEntityType, type JournalEvidence } from '../lib/tradovateJournalEvidence';
import type { Account } from '../types';
import { loadJournalAccountReadModel } from '../services/journalAccountReadModel';
import type { JournalEvidenceCache } from '../services/journalEvidenceCache';

vi.mock('../services/tradovateOAuthConnection', () => ({ loadTradovateJournalEvidencePage: vi.fn(() => { throw new Error('No network in this test'); }) }));

const connectionId = '92a967bf-00f8-4303-845c-ac6f1b744e68';
const account = (external = 1, overrides: Partial<Account> = {}): Account => ({
  id: `ce4990b0-0c8c-40e0-a790-${String(external).padStart(12, '0')}`, name: 'Same account name',
  initialBalance: 50_000, currency: 'USD', type: 'prop', status: 'Active',
  oauth: { provider: 'tradovate', environment: 'demo', connectionId, externalAccountId: String(external), firm: null },
  ...overrides,
} as Account);
const evidence = (count = 1) => {
  const rows: JournalEvidence[] = [];
  const add = (type: JournalEntityType, data: Record<string, number | string | boolean>, time: number) => {
    const sequence = rows.length + 1;
    rows.push({ ...journalObservation(type, data, 'stream', 'Created', time)!, connectionId, environment: 'demo',
      id: sequence.toString(16).padStart(64, '0'), sequence, sessionId: 'session' });
  };
  add('contract', { id: 1, name: 'MNQU6' }, 0);
  for (let id = 1; id <= count; id++) {
    add('position', { id, accountId: id, contractId: 1, netPos: 0 }, 0);
    for (const [fillId, side, price, time] of [[id * 10, 'Buy', 20_000 + id, 1000 + id], [id * 10 + 1, 'Sell', 20_010 + id, 2000 + id]] as const) {
      add('fill', { id: fillId, orderId: fillId, accountId: id, contractId: 1, action: side, price, qty: id, timestamp: new Date(time).toISOString() }, time);
      add('fillfee', { id: fillId, commission: id * 0.5, commissionCurrencyId: 840 }, time);
    }
    add('fillpair', { id, buyFillId: id * 10, sellFillId: id * 10 + 1, qty: id, active: true }, 3000);
  }
  return rows;
};
describe('account assignment for evidence-backed journal positions', () => {
  it('keeps 12 accounts with their own quantities, fees and PnL independent of labels', () => {
    const result = projectJournalAccounts(evidence(12), Array.from({ length: 12 }, (_, i) => account(i + 1)));
    expect(result.ready).toHaveLength(12); expect(result.pending).toEqual([]);
    expect(result.ready.map(row => row.history.netPnl)).toEqual(Array.from({ length: 12 }, (_, i) => (i + 1) * 19));
    expect(new Set(result.ready.map(row => row.journalAccountId)).size).toBe(12);
  });
  it('never falls back to the first account or current matching name', () => {
    const first = account(1);
    for (const wrong of [account(2), account(1, { oauth: { ...first.oauth!, connectionId: 'other' } }),
      account(1, { oauth: { ...first.oauth!, environment: 'live' } }), account(1, { oauth: undefined })]) {
      const result = projectJournalAccounts(evidence(), [wrong]);
      expect(result.ready).toEqual([]); expect(result.pending[0].reason).toBe('account-not-linked');
    }
  });
  it('requires one unambiguous, valid journal account identity', () => {
    expect(projectJournalAccounts(evidence(), [account(1), account(1, { id: account(2).id })]).pending[0].reason).toBe('account-link-conflict');
    expect(projectJournalAccounts(evidence(), [account(1, { id: 'legacy-name' })]).pending[0].reason).toBe('invalid-journal-account');
  });
  it('keeps missing fees pending and becomes importable when those same fees arrive later', () => {
    const rows = evidence();
    const pending = projectJournalAccounts(rows.filter(row => row.entityType !== 'fillfee'), [account(1)]);
    expect(pending.ready).toEqual([]); expect(pending.pending[0].reason).toBe('accounting-pending');
    const ready = projectJournalAccounts(rows, [account(1)]);
    expect(ready.ready[0].id).toBe(pending.pending[0].position.id);
    expect(ready.ready[0].history.netPnl).toBe(19);
  });
  it('loads one connection once for 12 accounts and only publishes a committed complete snapshot', async () => {
    const rows = evidence(12);
    let committed: JournalEvidence[] = [];
    const cache: JournalEvidenceCache = {
      checkpoint: async () => ({ next: 0, through: null, completeThrough: 0 }),
      commit: async (_scope, page) => { committed = page.rows.map(row => row.event); },
      snapshot: async () => ({ through: rows.length, events: committed }),
    };
    const loadPage = vi.fn(async (scope, after) => ({ scope, after, through: rows.length, next: rows.length, hasMore: false,
      rows: rows.map((event, index) => ({ cursor: index + 1, event })) }));
    const result = await loadJournalAccountReadModel({ ownerId: 'owner', accounts: Array.from({ length: 12 }, (_, i) => account(i + 1)),
      isCurrent: () => true, cache, loadPage });
    expect(loadPage).toHaveBeenCalledTimes(1); expect(result).toHaveLength(1);
    expect(result[0].state).toBe('ready'); expect(result[0].projection?.ready).toHaveLength(12);
    const failed = await loadJournalAccountReadModel({ ownerId: 'owner', accounts: [account()], isCurrent: () => true, cache,
      loadPage: async () => { throw new Error('endpoint unavailable'); } });
    expect(failed[0]).toMatchObject({ state: 'unavailable', projection: null });
  });
});
