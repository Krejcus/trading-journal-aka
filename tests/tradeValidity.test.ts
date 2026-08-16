import { describe, expect, it } from 'vitest';
import { parseOptionalTradeValidity } from '../services/tradeValidity';

describe('parseOptionalTradeValidity', () => {
  it('preserves missing validity as undefined', () => {
    expect(parseOptionalTradeValidity(undefined)).toBeUndefined();
    expect(parseOptionalTradeValidity(null)).toBeUndefined();
    expect(parseOptionalTradeValidity('')).toBeUndefined();
  });

  it('parses explicit true and false values', () => {
    expect(parseOptionalTradeValidity(true)).toBe(true);
    expect(parseOptionalTradeValidity('true')).toBe(true);
    expect(parseOptionalTradeValidity(false)).toBe(false);
    expect(parseOptionalTradeValidity('false')).toBe(false);
  });
});
