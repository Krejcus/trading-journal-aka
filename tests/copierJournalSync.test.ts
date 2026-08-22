import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Account, Trade } from '../types';
import { syncCopierJournal, type CopierLedgerRow } from '../services/copierJournalSync';

const account = (externalAccountId = '100', id = '11111111-1111-4111-8111-111111111111'): Account => ({
  id,
  name: `Journal ${externalAccountId}`, initialBalance: 50_000, type: 'Funded', phase: 'Funded',
  status: 'Active', currency: 'USD', createdAt: 1,
  ...(externalAccountId ? { oauth: { provider: 'tradovate' as const, environment: 'demo' as const, externalAccountId, connectionId: 'c1', firm: 'Test' } } : {}),
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
  it('založí master a kopie podle závazné konvence včetně multiplier matematiky', async () => {
    const stored: Trade[] = [];
    const saveTrades = vi.fn(async (trades: Trade[]) => {
      const saved = trades.map((trade, index) => ({
        ...trade,
        id: trade.isMaster
          ? '22222222-2222-4222-8222-222222222222'
          : `${index + 3}3333333-3333-4333-8333-333333333333`,
      }));
      stored.push(...saved);
      return saved;
    });
    const cursorStore = memoryStore();
    const deps = { loadRows: vi.fn(async () => [row]), getTrades: async () => stored, saveTrades, cursorStore, now: () => Date.parse('2026-08-22T12:00:00Z') };
    const accounts = [
      account(),
      account('200', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      account('300', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    ];

    const first = await syncCopierJournal({
      userId: 'u1', leaderAccountId: 100, accounts,
      followers: [{ accountId: 200, multiplier: 1.6 }, { accountId: 300, multiplier: 0.2 }],
      deps,
    });

    expect(first.created).toHaveLength(3);
    expect(saveTrades).toHaveBeenCalledTimes(2);
    expect(saveTrades.mock.calls[0][0][0]).toMatchObject({
      id: 'copier-fill-42', copierTradeId: 'copier-fill-42', accountId: account().id,
      instrument: 'MNQ', direction: 'Long', pnl: 125, positionSize: 2,
      entryPrice: 21_000, exitPrice: 21_062.5, exitReason: 'tp', needsReview: true,
      source: 'copier', signal: 'Copier', groupId: 'copier-group-fill-42', isMaster: true,
    });
    expect(saveTrades.mock.calls[0][0][0]).not.toHaveProperty('masterTradeId');
    expect(saveTrades.mock.calls[1][0]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'copier-fill-42-200', copierTradeId: 'copier-fill-42-200',
        accountId: accounts[1].id, groupId: 'copier-group-fill-42',
        masterTradeId: '22222222-2222-4222-8222-222222222222',
        positionSize: 3, pnl: 200, pnlEstimated: true,
        entryPrice: 21_000, exitPrice: 21_062.5, exitReason: 'tp',
        source: 'copier', signal: 'Copier',
      }),
      expect.objectContaining({
        id: 'copier-fill-42-300', positionSize: 1, pnl: 25, pnlEstimated: true,
      }),
    ]));
    for (const copy of saveTrades.mock.calls[1][0]) {
      expect(copy).not.toHaveProperty('isMaster');
      expect(copy).not.toHaveProperty('needsReview');
    }
  });

  it('je idempotentní a druhý běh nevytvoří master ani kopii znovu', async () => {
    const stored: Trade[] = [];
    const saveTrades = vi.fn(async (trades: Trade[]) => {
      const saved = trades.map(trade => ({
        ...trade,
        id: trade.isMaster
          ? '22222222-2222-4222-8222-222222222222'
          : '33333333-3333-4333-8333-333333333333',
      }));
      stored.push(...saved);
      return saved;
    });
    const deps = { loadRows: vi.fn(async () => [row]), getTrades: async () => stored, saveTrades, cursorStore: memoryStore(), now: () => Date.parse('2026-08-22T12:00:00Z') };
    const options = {
      userId: 'u1', leaderAccountId: 100,
      accounts: [account(), account('200', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')],
      followers: [{ accountId: 200, multiplier: 1 }], deps,
    };

    await syncCopierJournal(options);
    const second = await syncCopierJournal(options);

    expect(saveTrades).toHaveBeenCalledTimes(2);
    expect(second.created).toEqual([]);
  });

  it('bez mappingu nic nezaloží a vrátí čekající obchod', async () => {
    const saveTrades = vi.fn(async () => []);
    const result = await syncCopierJournal({
      userId: 'u1', leaderAccountId: 100, accounts: [account('')], followers: [],
      deps: { loadRows: async () => [row], getTrades: async () => [], saveTrades, cursorStore: memoryStore(), now: () => Date.parse('2026-08-22T12:00:00Z') },
    });
    expect(saveTrades).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
    expect(result.pending).toEqual([expect.objectContaining({ id: 'copier-fill-42', leaderAccountId: 100 })]);
  });

  it('followera bez journal mappingu přeskočí a započítá', async () => {
    const saveTrades = vi.fn(async (trades: Trade[]) => trades.map(trade => ({
      ...trade, id: '22222222-2222-4222-8222-222222222222',
    })));
    const result = await syncCopierJournal({
      userId: 'u1', leaderAccountId: 100, accounts: [account()],
      followers: [{ accountId: 999, multiplier: 2 }],
      deps: { loadRows: async () => [row], getTrades: async () => [], saveTrades, cursorStore: memoryStore(), now: () => Date.parse('2026-08-22T12:00:00Z') },
    });

    expect(result.created).toHaveLength(1);
    expect(result.skippedFollowers).toBe(1);
    expect(saveTrades).toHaveBeenCalledTimes(1);
  });

  it('healing doplní pouze groupId/isMaster a chybějící kopii, reflexi nechá beze změny', async () => {
    const legacy: Trade = {
      id: '22222222-2222-4222-8222-222222222222', copierTradeId: 'copier-fill-42',
      accountId: account().id, source: 'copier', signal: 'Copier', instrument: 'MNQ',
      direction: 'Long', pnl: 125, positionSize: 2, date: row.closed_at,
      timestamp: Date.parse(row.closed_at), entryTime: Date.parse(row.opened_at!),
      entryDate: row.opened_at!, exitDate: row.closed_at, entryPrice: 21_000,
      exitPrice: 21_062.5, exitReason: 'tp', needsReview: false,
      notes: 'Moje reflexe', emotions: ['Klid'], runUp: 42, drawdown: 7,
      durationMinutes: 5, duration: '5m',
    };
    const stored = [legacy];
    const updateTrade = vi.fn(async (id: string | number, updates: Partial<Trade>) => {
      const index = stored.findIndex(trade => trade.id === id);
      stored[index] = { ...stored[index], ...updates };
    });
    const saveTrades = vi.fn(async (trades: Trade[]) => trades.map(trade => ({
      ...trade, id: '33333333-3333-4333-8333-333333333333',
    })));

    const result = await syncCopierJournal({
      userId: 'u1', leaderAccountId: 100,
      accounts: [account(), account('200', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')],
      followers: [{ accountId: 200, multiplier: 2 }],
      deps: { loadRows: async () => [], getTrades: async () => stored, saveTrades, updateTrade, cursorStore: memoryStore(), now: () => Date.parse('2026-08-22T12:00:00Z') },
    });

    expect(updateTrade).toHaveBeenCalledWith(legacy.id, {
      groupId: 'copier-group-fill-42', isMaster: true,
    });
    expect(stored[0]).toMatchObject({ notes: 'Moje reflexe', emotions: ['Klid'], runUp: 42, drawdown: 7, needsReview: false });
    expect(result.updated[0]).toMatchObject({ groupId: 'copier-group-fill-42', isMaster: true, notes: 'Moje reflexe' });
    expect(saveTrades).toHaveBeenCalledWith([expect.objectContaining({
      id: 'copier-fill-42-200', masterTradeId: legacy.id, groupId: 'copier-group-fill-42',
      positionSize: 4, pnl: 250, pnlEstimated: true,
    })]);
  });

  it('po explicitním výběru použije zvolený účet a volbu si zapamatuje', async () => {
    const selected = account('');
    const cursorStore = memoryStore();
    const saveTrades = vi.fn(async (trades: Trade[]) => trades);
    const common = {
      userId: 'u1', leaderAccountId: 100, accounts: [selected], followers: [],
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
