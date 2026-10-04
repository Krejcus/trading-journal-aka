import { describe, expect, it } from 'vitest';
import {
  OTHER_FIRM, accountCountInLabel, accountFirmKey, expenseFirmKeys, firmDisplayName, firmSummaries, monthlyCashflow, selectableFirms,
} from '../lib/businessFirms';
import type { Account, BusinessExpense, BusinessPayout } from '../types';

const acc = (id: string, name: string, extra: Partial<Account> = {}) => ({ id, name, initialBalance: 50000, status: 'Active', type: 'Funded', ...extra }) as unknown as Account;
const exp = (date: string, label: string, amount: number) => ({ id: label + date, date, label, amount, category: 'Challenges' }) as BusinessExpense;
const pay = (date: string, accountId: string, amount: number, status: BusinessPayout['status'] = 'Received') => ({ id: accountId + date + amount, date, accountId, amount, status }) as BusinessPayout;

describe('businessFirms', () => {
  it('pozná firmu z popisu nákladu i smíšený nákup', () => {
    expect(expenseFirmKeys(exp('2026-09-28', '5x funded next', 387))).toEqual(['FUNDEDNEXT']);
    expect(expenseFirmKeys(exp('2026-03-04', '2x Lucid + 5x Apex', 280))).toEqual(['LUCID', 'APEX']);
    expect(expenseFirmKeys(exp('2026-01-20', '6x MFFU 50k', 462))).toEqual(['MYFUNDEDFUTURES']);
    expect(expenseFirmKeys(exp('2026-01-01', 'TradingView předplatné', 30))).toEqual([OTHER_FIRM]);
    expect(expenseFirmKeys(exp('2026-01-01', '2x Bulenox 50k', 90), ['BULENOX'])).toEqual(['BULENOX']);
    // zkratka účtu („MFF 1“) nesmí chytit delší slovo a MFF = MyFundedFutures
    expect(expenseFirmKeys(exp('2026-01-20', '6x MFFU 50k', 462), ['MFF'])).toEqual(['MYFUNDEDFUTURES']);
    expect(accountFirmKey(acc('m', 'MFF 1'))).toBe('MYFUNDEDFUTURES');
  });

  it('firma účtu výplaty sjednotí víceslovné názvy', () => {
    expect(accountFirmKey(acc('a', 'Alpha Futures 50K'))).toBe('ALPHAFUTURES');
    expect(accountFirmKey(acc('t', 'Tradeify 5'))).toBe('TRADEIFY');
    expect(accountFirmKey(acc('x', 'Bulenox 1'))).toBe('BULENOX');
    expect(accountFirmKey(undefined)).toBe(OTHER_FIRM);
    // Tradovate účty: v názvu jen kód firmy
    expect(accountFirmKey(acc('f', 'FNFTCHFILIPKREJCA36331'))).toBe('FUNDEDNEXT');
    expect(accountFirmKey(acc('l', 'LFF05066846490007'))).toBe('LUCID');
    expect(accountFirmKey(acc('d', 'TDFYG50488642119'))).toBe('TRADEIFY');
    expect(firmDisplayName('ALPHAFUTURES')).toBe('Alpha Futures');
  });

  it('souhrn podle firem dělí smíšený nákup a bere jen přijaté výplaty', () => {
    const accounts = [acc('t1', 'Tradeify 1'), acc('l1', 'Lucid Funded')];
    const rows = firmSummaries(
      [exp('2026-08-25', '1xlucid a 1x tradeify', 200), exp('2026-08-18', '5x tradeify', 400)],
      [pay('2026-07-24', 't1', 834), pay('2026-07-24', 'l1', 890), pay('2026-08-01', 'l1', 500, 'Pending')],
      accounts,
    );
    expect(rows.find(r => r.key === 'TRADEIFY')).toMatchObject({ cost: 500, paid: 834, net: 334, purchases: 2, payouts: 1 });
    expect(rows.find(r => r.key === 'LUCID')).toMatchObject({ cost: 100, paid: 890, net: 790, purchases: 1, payouts: 1 });
    expect(rows[0].key).toBe('LUCID');
  });

  it('měsíční cashflow s kumulací', () => {
    const rows = monthlyCashflow(
      [exp('2026-01-07', 'a', 150), exp('2026-02-03', 'b', 270), exp('2026-01-20T10:00:00', 'c', 462)],
      [pay('2026-01-28', 'x', 1350)],
    );
    expect(rows).toEqual([
      { month: '2026-01', paid: 1350, cost: 612, net: 738, cumulative: 738 },
      { month: '2026-02', paid: 0, cost: 270, net: -270, cumulative: 468 },
    ]);
  });

  it('výběr firem ve formuláři bere jen známé a ručně nastavené firmy', () => {
    const list = selectableFirms([acc('a', 'PTLOP17400'), acc('b', 'Hlavní'), acc('c', 'Bulenox 1', { firmOverride: 'Bulenox' })]);
    expect(list).toContain('TRADEIFY');
    expect(list).toContain('BULENOX');
    expect(list).not.toContain('PTLOP17400');
    expect(list).not.toContain('HLAVNÍ');
  });

  it('počet účtů z popisu', () => {
    expect(accountCountInLabel('5x tradeify')).toBe(5);
    expect(accountCountInLabel('5.x tradeify')).toBe(5);
    expect(accountCountInLabel('Funded next 5x')).toBe(5);
    expect(accountCountInLabel('3× FundedNext 50k')).toBe(3);
    expect(accountCountInLabel('Tradeify 50k')).toBe(1);
  });
});
