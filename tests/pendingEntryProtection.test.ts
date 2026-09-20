import { describe, expect, it } from 'vitest';
import { contractsLabel, pendingEntryProtection } from '../components/LiveCopyTradeOverview';
import type { LiveOrder } from '../services/tradecopiaLiveService';

const order = (patch: Partial<LiveOrder> & Pick<LiveOrder, 'id' | 'action' | 'orderType' | 'quantity'>): LiveOrder => ({
  accountId: 1, accountName: 'A', price: null, stopPrice: null, status: 'Working',
  symbol: 'MNQZ6', placedAt: null, updatedAt: null, working: true, ...patch,
});

const buyEntry = order({ id: 1, action: 'Buy', orderType: 'Limit', quantity: 3 });

describe('pendingEntryProtection', () => {
  it('bez dalších příkazů nemá vstup žádnou ochranu', () => {
    expect(pendingEntryProtection(buyEntry, [buyEntry]))
      .toEqual({ quantity: 3, stopCoverage: 0, targetCoverage: 0 });
  });

  it('opačný stop na stejném kontraktu je stop loss, opačná limitka target', () => {
    const guards = [
      buyEntry,
      order({ id: 2, action: 'Sell', orderType: 'Stop', quantity: 3 }),
      order({ id: 3, action: 'Sell', orderType: 'Limit', quantity: 3 }),
    ];
    expect(pendingEntryProtection(buyEntry, guards))
      .toEqual({ quantity: 3, stopCoverage: 3, targetCoverage: 3 });
  });

  it('sám sebe za ochranu nepovažuje', () => {
    const sellEntry = order({ id: 9, action: 'Sell', orderType: 'Stop', quantity: 2 });
    expect(pendingEntryProtection(sellEntry, [sellEntry]).stopCoverage).toBe(0);
  });

  it('příkaz na stejnou stranu ochrana není', () => {
    const guards = [buyEntry, order({ id: 2, action: 'Buy', orderType: 'Stop', quantity: 3 })];
    expect(pendingEntryProtection(buyEntry, guards).stopCoverage).toBe(0);
  });

  it('jiný kontrakt se nepočítá', () => {
    const guards = [buyEntry, order({ id: 2, action: 'Sell', orderType: 'Stop', quantity: 3, symbol: 'MESZ6' })];
    expect(pendingEntryProtection(buyEntry, guards).stopCoverage).toBe(0);
  });

  it('dílčí krytí sečte všechny opačné stopky', () => {
    const guards = [
      buyEntry,
      order({ id: 2, action: 'Sell', orderType: 'Stop', quantity: 1 }),
      order({ id: 3, action: 'Sell', orderType: 'Stop', quantity: 1 }),
    ];
    expect(pendingEntryProtection(buyEntry, guards).stopCoverage).toBe(2);
  });

  it('u short vstupu chrání příkazy na nákup', () => {
    const sellEntry = order({ id: 1, action: 'Sell', orderType: 'Limit', quantity: 2 });
    const guards = [sellEntry, order({ id: 2, action: 'Buy', orderType: 'Stop', quantity: 2 })];
    expect(pendingEntryProtection(sellEntry, guards).stopCoverage).toBe(2);
  });
});

describe('contractsLabel', () => {
  it('skloňuje podle počtu', () => {
    expect(contractsLabel(1)).toBe('1 kontrakt');
    expect(contractsLabel(2)).toBe('2 kontrakty');
    expect(contractsLabel(4)).toBe('4 kontrakty');
    expect(contractsLabel(5)).toBe('5 kontraktů');
    expect(contractsLabel(-3)).toBe('3 kontrakty');
  });

  it('neceločíselný i nesmyslný počet skloní bezpečně', () => {
    expect(contractsLabel(1.5)).toBe('1.5 kontraktů');
    expect(contractsLabel(Number.NaN)).toBe('— kontraktů');
  });
});
