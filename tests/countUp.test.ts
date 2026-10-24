import { describe, expect, it } from 'vitest';
import { formatLike, splitNumeric } from '../lib/countUp';

const roundTrip = (text: string) => { const parts = splitNumeric(text)!; return formatLike(parts.value, parts); };

describe('countUp', () => {
  it('rozpozná předponu, číslo, oddělovače a příponu a složí totéž', () => {
    for (const text of ['+$4 710', '-$5,849', '$54,766', '43.8%', '1.17', '+4.38R', '0.0%', '12 345 Kč', '+$35 330.5']) {
      expect(roundTrip(text)).toBe(text);
    }
    expect(splitNumeric('-$5,849')).toMatchObject({ prefix: '-$', value: 5849, groupSep: ',', decimals: 0 });
    expect(splitNumeric('43.8%')).toMatchObject({ prefix: '', value: 43.8, decimals: 1, suffix: '%' });
  });
  it('mezihodnota se formátuje jako originál', () => {
    const parts = splitNumeric('+$4 710')!;
    expect(formatLike(1234.6, parts)).toBe('+$1 235');
    expect(formatLike(9, splitNumeric('1.17')!)).toBe('9.00');
  });
  it('bez čísla se neanimuje', () => {
    expect(splitNumeric('∞')).toBeNull();
    expect(splitNumeric('—')).toBeNull();
  });
});
