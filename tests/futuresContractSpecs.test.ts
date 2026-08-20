import { describe, expect, it } from 'vitest';
import { futuresSymbolRoot, pointValueUsd } from '../services/futuresContractSpecs';

describe('futuresSymbolRoot', () => {
  it('odděluje kořen od měsíce a roku včetně kořenů s číslicí', () => {
    expect(futuresSymbolRoot('MNQU6')).toBe('MNQ');
    expect(futuresSymbolRoot('NQH26')).toBe('NQ');
    expect(futuresSymbolRoot('M2KZ5')).toBe('M2K');
    expect(futuresSymbolRoot('6EZ5')).toBe('6E');
    expect(futuresSymbolRoot('M6EU25')).toBe('M6E');
    expect(futuresSymbolRoot('mesm5')).toBe('MES');
  });

  it('symbol bez měsíčního kódu vrací beze změny', () => {
    expect(futuresSymbolRoot('MNQ')).toBe('MNQ');
  });
});

describe('pointValueUsd', () => {
  it('zná běžné CME kontrakty', () => {
    expect(pointValueUsd('NQZ5')).toBe(20);
    expect(pointValueUsd('MNQU6')).toBe(2);
    expect(pointValueUsd('ESH26')).toBe(50);
    expect(pointValueUsd('MESM5')).toBe(5);
    expect(pointValueUsd('GCQ5')).toBe(100);
  });

  it('neznámý kontrakt vrací null — žádný tichý odhad', () => {
    expect(pointValueUsd('XAUUSD')).toBeNull();
    expect(pointValueUsd('WEIRDZ5')).toBeNull();
  });
});
