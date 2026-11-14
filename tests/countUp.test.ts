import { describe, expect, it } from 'vitest';
import { easeOutCubic, formatNumericText, parseNumericText } from '../lib/countUp';

describe('doběhnutí čísel na dashboardu', () => {
  it('přečte číslo a vypíše ho zpět přesně stejně', () => {
    for (const text of ['-$1,008', '+$17,719', '$29,612.5', '42.9%', '1.12', '+0.42R', '-$5,849', '0', '1 008 Kč', '12,5 %', '$1.5k']) {
      const shape = parseNumericText(text);
      expect(shape, text).not.toBeNull();
      expect(formatNumericText(shape!, shape!.value)).toBe(text);
    }
  });

  it('rozliší tisíce od desetin', () => {
    expect(parseNumericText('-$1,008')).toMatchObject({ value: 1008, decimals: 0, groupSeparator: ',' });
    expect(parseNumericText('42.9%')).toMatchObject({ value: 42.9, decimals: 1, suffix: '%' });
    expect(parseNumericText('$12,480.50')).toMatchObject({ value: 12480.5, decimals: 2, groupSeparator: ',', decimalSeparator: '.' });
  });

  it('mezihodnota drží tvar (znaménko, měna, oddělovač, desetinná místa)', () => {
    expect(formatNumericText(parseNumericText('-$17,719')!, 4200.4)).toBe('-$4,200');
    expect(formatNumericText(parseNumericText('42.9%')!, 7.26)).toBe('7.3%');
    expect(formatNumericText(parseNumericText('+0.42R')!, 0)).toBe('+0.00R');
  });

  it('text bez čísla nebo se dvěma čísly se neanimuje', () => {
    for (const text of ['∞', '—', '', '12/40 dnů', 'T1 +$50']) expect(parseNumericText(text), text).toBeNull();
  });

  it('křivka zpomalení začíná v 0, končí v 1 a nepřestřelí', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(5)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});
