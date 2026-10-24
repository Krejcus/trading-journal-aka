import { describe, expect, it } from 'vitest';
import {
  accountLifecycles, accountOutcome, firmLifecycleStats, isAccountPurchase, pairAccountsWithPurchases, purchaseParts,
} from '../lib/accountPurchases';
import type { Account, BusinessExpense, BusinessPayout, Trade } from '../types';

const day = (date: string) => Date.parse(`${date}T12:00:00`);
const account = (id: string, patch: Partial<Account> = {}): Account => ({
  id, name: id, initialBalance: 50_000, currency: 'USD', type: 'Funded', status: 'Active',
  createdAt: day('2026-10-22'), phase: 'Challenge', firmOverride: 'Lucid', ...patch,
} as Account);
const expense = (id: string, date: string, label: string, amount: number, category = 'Challenges'): BusinessExpense =>
  ({ id, date, label, amount, category } as BusinessExpense);

describe('rozbor nákupu z popisku', () => {
  it('čte počet i firmu v různých zápisech, jak je píšeš', () => {
    expect(purchaseParts('5× Lucid 50k')).toEqual([{ firmKey: 'LUCID', count: 5 }]);
    expect(purchaseParts('5x funded next ')).toEqual([{ firmKey: 'FUNDEDNEXT', count: 5 }]);
    expect(purchaseParts('Funded next 5x')).toEqual([{ firmKey: 'FUNDEDNEXT', count: 5 }]);
    expect(purchaseParts('5.x tradeify')).toEqual([{ firmKey: 'TRADEIFY', count: 5 }]);
    expect(purchaseParts('5xapex')).toEqual([{ firmKey: 'APEX', count: 5 }]);
    expect(purchaseParts('Lucid 50k')).toEqual([{ firmKey: 'LUCID', count: 1 }]);
    expect(purchaseParts('5x 50k Lucid')).toEqual([{ firmKey: 'LUCID', count: 5 }]);
  });

  it('rozdělí nákup přes dvě firmy', () => {
    expect(purchaseParts('2x Lucid + 5x Apex')).toEqual([{ firmKey: 'LUCID', count: 2 }, { firmKey: 'APEX', count: 5 }]);
    expect(purchaseParts('1xlucid a 1x tradeify')).toEqual([{ firmKey: 'LUCID', count: 1 }, { firmKey: 'TRADEIFY', count: 1 }]);
  });

  it('aktivace funded účtu ani software nejsou nákup účtu', () => {
    expect(isAccountPurchase({ category: 'Challenges', label: 'Aktivace Lucid funded' })).toBe(false);
    expect(isAccountPurchase({ category: 'Software', label: 'TradingView' })).toBe(false);
    expect(isAccountPurchase({ category: 'Challenges', label: '3× Lucid 50k' })).toBe(true);
  });
});

describe('párování nákupů s účty', () => {
  it('nákup „5× Lucid“ dostane 5 účtů z okolí data a cenu po pětinách', () => {
    const accounts = ['a', 'b', 'c', 'd', 'e'].map(id => account(id, { createdAt: day('2026-10-22') }));
    const { byAccount, byExpense } = pairAccountsWithPurchases(accounts, [expense('x', '2026-10-22', '5× Lucid 50k', 350)]);
    expect(byAccount.get('a')).toMatchObject({ expenseId: 'x', price: 70, sure: true });
    expect(byExpense.get('x')?.get('LUCID')).toHaveLength(5);
  });

  it('kapacita nákupu se nepřekročí a jiná firma se nepáruje', () => {
    const accounts = [
      account('l1'), account('l2'), account('l3'),
      account('f1', { firmOverride: 'FundedNext', name: 'FNFT1' }),
    ];
    const { byAccount } = pairAccountsWithPurchases(accounts, [expense('x', '2026-10-22', '2× Lucid 50k', 180)]);
    expect([...byAccount.keys()].sort()).toEqual(['l1', 'l2']);
  });

  it('účet připojený později než nákup dostane starší nákup jen jako návrh', () => {
    const { byAccount } = pairAccountsWithPurchases(
      [account('late', { createdAt: day('2026-09-15'), firmOverride: 'FundedNext', name: 'FNFT9' })],
      [expense('old', '2026-08-03', '3x funded next', 176)],
    );
    expect(byAccount.get('late')).toMatchObject({ expenseId: 'old', sure: false });
  });

  it('funded účet z prošlé challenge se s nákupem nepáruje', () => {
    const { byAccount } = pairAccountsWithPurchases(
      [account('LFF05066846490012', { phase: 'Funded' })],
      [expense('x', '2026-10-22', '1x lucid', 90)],
    );
    expect(byAccount.size).toBe(0);
  });
});

describe('životní cyklus účtu', () => {
  const trade = (accountId: string, date: string, pnl: number): Trade => ({ id: `${accountId}-${date}-${pnl}`, accountId, timestamp: day(date), pnl } as Trade);

  it('spálený účet: datum spálení, ztráta, max zisk a životnost', () => {
    const burned = account('b', { status: 'Inactive', isArchived: true, result: 'Failed', failureDate: '2026-10-14', failureAmountLost: 2089 });
    const life = accountLifecycles([burned], [trade('b', '2026-10-12', 473), trade('b', '2026-10-14', -2562)], []).get('b')!;
    expect(life).toMatchObject({ outcome: 'burned', lifeDays: 3, pnl: -2089, maxProfit: 473, trades: 2 });
  });

  it('skryté testovací účty se do statistik firem nepočítají', () => {
    const hidden = account('h', { status: 'Inactive', isArchived: true });
    expect(accountOutcome(hidden)).toBe('hidden');
    const stats = firmLifecycleStats([expense('x', '2026-10-22', '5× Lucid 50k', 350)], accountLifecycles([hidden, account('live')], [], []).values());
    expect(stats.get('LUCID')).toMatchObject({ bought: 5, alive: 1, inApp: 1 });
  });

  it('výplaty se berou jen přijaté', () => {
    const payouts = [
      { id: '1', accountId: 'a', amount: 500, status: 'Received', date: '2026-10-01' },
      { id: '2', accountId: 'a', amount: 300, status: 'Pending', date: '2026-10-02' },
    ] as BusinessPayout[];
    expect(accountLifecycles([account('a')], [], payouts).get('a')?.payouts).toBe(500);
  });
});
