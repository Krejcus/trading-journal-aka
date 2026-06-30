import { describe, it, expect } from 'vitest';
import { parseContractRoot, pointValueFor, normalizeDecimalSeparators } from '../services/tradovateImport';

describe('parseContractRoot', () => {
  it('vytáhne root symbol z plného kontraktu', () => {
    expect(parseContractRoot('MNQM6')).toBe('MNQ');
    expect(parseContractRoot('ESH25')).toBe('ES');
    expect(parseContractRoot('6EM5')).toBe('6E');
    expect(parseContractRoot('MES')).toBe('MES'); // bez měsíčního kódu zůstává
    expect(parseContractRoot('CME:MESU6')).toBe('MES'); // prefix burzy se odstraní
  });
});

describe('pointValueFor', () => {
  it('známé kontrakty mají správnou point value', () => {
    expect(pointValueFor('MNQM6')).toBe(2);
    expect(pointValueFor('ESH25')).toBe(50);
    expect(pointValueFor('NQ')).toBe(20);
  });
  it('neznámý kontrakt → fallback 1', () => {
    expect(pointValueFor('XYZ123')).toBe(1);
    expect(pointValueFor(undefined)).toBe(1);
  });
});

describe('normalizeDecimalSeparators', () => {
  it('US i EU formáty sjednotí na tečku', () => {
    expect(normalizeDecimalSeparators('1,234.56')).toBe('1234.56'); // US tisíce + desetinná
    expect(normalizeDecimalSeparators('1.234,56')).toBe('1234.56'); // EU
    expect(normalizeDecimalSeparators('1234,56')).toBe('1234.56');  // EU desetinná čárka
    expect(normalizeDecimalSeparators('1,234')).toBe('1234');       // US tisícová čárka
  });
});
