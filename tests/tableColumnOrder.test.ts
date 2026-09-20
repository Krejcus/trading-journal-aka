import { describe, expect, it } from 'vitest';
import { applyColumnOrder, moveColumn, pinColumnEdges } from '../lib/tableColumnOrder';

const DEFAULTS = ['account', 'broker', 'firm', 'balance', 'actions'] as const;

describe('applyColumnOrder', () => {
  it('bez uloženého pořadí vrací výchozí', () => {
    expect(applyColumnOrder(DEFAULTS, [])).toEqual([...DEFAULTS]);
  });

  it('respektuje uložené pořadí', () => {
    expect(applyColumnOrder(DEFAULTS, ['balance', 'account', 'firm', 'broker', 'actions']))
      .toEqual(['balance', 'account', 'firm', 'broker', 'actions']);
  });

  it('zahodí klíč, který už v appce není', () => {
    expect(applyColumnOrder(DEFAULTS, ['balance', 'zrušený', 'account', 'broker', 'firm', 'actions']))
      .toEqual(['balance', 'account', 'broker', 'firm', 'actions']);
  });

  it('zahodí duplicitu i nesmyslnou hodnotu', () => {
    expect(applyColumnOrder(DEFAULTS, ['broker', 'broker', null, 7, 'account']))
      .toEqual(['broker', 'account', 'firm', 'balance', 'actions']);
  });

  it('nově přidaný sloupec vrátí na výchozí místo, ne na konec', () => {
    // Uložené pořadí vzniklo dřív, než „firm“ existoval.
    const order = applyColumnOrder(DEFAULTS, ['account', 'broker', 'balance', 'actions']);
    expect(order).toEqual(['account', 'broker', 'firm', 'balance', 'actions']);
    expect(order.indexOf('firm')).toBeLessThan(order.indexOf('actions'));
  });

  it('nikdy neztratí ani nezdvojí sloupec', () => {
    const order = applyColumnOrder(DEFAULTS, ['firm', 'firm', 'nesmysl']);
    expect([...order].sort()).toEqual([...DEFAULTS].sort());
  });
});

describe('moveColumn', () => {
  it('posune položku nahoru', () => {
    expect(moveColumn(['a', 'b', 'c', 'd'], 2, 0)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('posune položku dolů', () => {
    expect(moveColumn(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('cíl mimo rozsah se ořízne na kraj', () => {
    expect(moveColumn(['a', 'b', 'c'], 0, 9)).toEqual(['b', 'c', 'a']);
    expect(moveColumn(['a', 'b', 'c'], 2, -4)).toEqual(['c', 'a', 'b']);
  });

  it('zdroj mimo rozsah nechá pořadí beze změny', () => {
    expect(moveColumn(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });
});

describe('pinColumnEdges', () => {
  it('drží název první a akce poslední', () => {
    expect(pinColumnEdges(['balance', 'actions', 'account', 'firm'], 'account', 'actions'))
      .toEqual(['account', 'balance', 'firm', 'actions']);
  });

  it('doplní kotvy, i když v uloženém pořadí chybí', () => {
    expect(pinColumnEdges(['firm'], 'account', 'actions')).toEqual(['account', 'firm', 'actions']);
  });
});
