import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Account, Trade } from '../types';
import { syncCopierJournal, type CopierLedgerRow } from '../services/copierJournalSync';

const account = (oauth = true): Account => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Leader journal', initialBalance: 50_000, type: 'Funded', phase: 'Funded',
  status: 'Active', currency: 'USD', createdAt: 1,
  ...(oauth ? { oauth: { provider: 'tradovate' as const, environment: 'demo' as const, externalAccountId: '100', connectionId: 'c1', firm: 'Test' } } : {}),
});

const row: CopierLedgerRow = {
  trade_id: 'fill-42', symbol: 'MNQU6', side: 'Long', quantity: 2,
  realized_pnl_usd: 125, opened_at: '2026-08-22T10:00:00.000Z', closed_at: '2026-08-22T10:05:00.000Z',
  exit_reason: 'tp', entry_price: 21_000, exit_price: 21_062.5,
};

const memoryStore = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
};

describe('copier journal sync', () => {
  it('je idempotentní a druhý běh nevytvoří duplikát', async () => {
    const stored: Trade[] = [];
    const saveTrades = vi.fn(async (trades: Trade[]) => {
      const saved = trades.map(trade => ({ ...trade, id: '22222222-2222-4222-8222-222222222222' }));
      stored.push(...saved);
      return saved;
    });
    const cursorStore = memoryStore();
    const deps = { loadRows: vi.fn(async () => [row]), getTrades: async () => stored, saveTrades, cursorStore, now: () => Date.parse('2026-08-22T12:00:00Z') };

    const first = await syncCopierJournal({ userId: 'u1', leaderAccountId: 100, accounts: [account()], deps });
    const second = await syncCopierJournal({ userId: 'u1', leaderAccountId: 100, accounts: [account()], deps });

    expect(first.created).toHaveLength(1);
    expect(saveTrades).toHaveBeenCalledTimes(1);
    expect(saveTrades.mock.calls[0][0][0]).toMatchObject({
      id: 'copier-fill-42', copierTradeId: 'copier-fill-42', accountId: account().id,
      instrument: 'MNQ', direction: 'Long', pnl: 125, positionSize: 2,
      entryPrice: 21_000, exitPrice: 21_062.5, exitReason: 'tp', needsReview: true,
      source: 'copier', signal: 'Copier',
    });
    expect(second.created).toEqual([]);
  });

  it('bez mappingu nic nezaloží a vrátí čekající obchod', async () => {
    const saveTrades = vi.fn(async () => []);
    const result = await syncCopierJournal({
      userId: 'u1', leaderAccountId: 100, accounts: [account(false)],
      deps: { loadRows: async () => [row], getTrades: async () => [], saveTrades, cursorStore: memoryStore(), now: () => Date.parse('2026-08-22T12:00:00Z') },
    });
    expect(saveTrades).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
    expect(result.pending).toEqual([expect.objectContaining({ id: 'copier-fill-42', leaderAccountId: 100 })]);
  });

  it('po explicitním výběru použije zvolený účet a volbu si zapamatuje', async () => {
    const selected = account(false);
    const cursorStore = memoryStore();
    const saveTrades = vi.fn(async (trades: Trade[]) => trades);
    const common = {
      userId: 'u1', leaderAccountId: 100, accounts: [selected],
      deps: { loadRows: async () => [row], getTrades: async () => [], saveTrades, cursorStore, now: () => Date.parse('2026-08-22T12:00:00Z') },
    };
    await syncCopierJournal({ ...common, accountIdOverride: selected.id });
    await syncCopierJournal(common);
    expect(saveTrades).toHaveBeenCalledTimes(2);
    expect(saveTrades.mock.calls[1][0][0].accountId).toBe(selected.id);
  });
});

describe('copier journal migration', () => {
  it('přidává fakta a povolí authenticated číst pouze vlastní ledger', () => {
    const sql = readFileSync(new URL('../supabase/migrations/20260822153000_copier_journal_trade_facts.sql', import.meta.url), 'utf8');
    expect(sql).toContain('add column exit_reason text null');
    expect(sql).toContain('add column entry_price double precision null');
    expect(sql).toContain('add column exit_price double precision null');
    expect(sql).toContain('grant select on table public.tradovate_copier_trades to authenticated');
    expect(sql).toContain('using (user_id = (select auth.uid()))');
  });
});
