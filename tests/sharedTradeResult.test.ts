import { describe, expect, it } from 'vitest';
import { sharedTradeResult } from '../lib/sharedTradeResult';
import { formatSharedPnL } from '../utils/formatPnL';

describe('shared confirmed trade results', () => {
  it('retains each account net dollars, including cents and loss signs', () => {
    const result = sharedTradeResult({ pnl: -27.52, riskAmount: 10, copierTradeId: 'journal:one' }, 'usd');
    expect(result).toEqual({ pnl: -27.52, riskAmount: undefined });
    expect(formatSharedPnL(result.pnl, 'usd')).toMatch(/^-\$27[.,]52$/);
  });
  it('never invents R for a journal trade with missing or stale legacy risk', () => {
    for (const riskAmount of [undefined, 0, 1, 100]) {
      const result = sharedTradeResult({ pnl: 27.52, riskAmount, copierTradeId: 'journal:one' }, 'rr');
      expect(result).toEqual({ pnl: null, riskAmount: undefined });
      expect(formatSharedPnL(result.pnl, 'rr')).toBe('—');
    }
  });
  it('converts known manual risk once and preserves signed and break-even R', () => {
    expect(sharedTradeResult({ pnl: -3, riskAmount: 2 }, 'rr')).toEqual({ pnl: -1.5, riskAmount: 1 });
    expect(sharedTradeResult({ pnl: 0, riskAmount: 2 }, 'rr')).toEqual({ pnl: 0, riskAmount: 1 });
    expect(formatSharedPnL(-1.5, 'rr')).toBe('-1.50R');
  });
  it('does not turn hidden or invalid financial data into zero', () => {
    expect(sharedTradeResult({ pnl: 12, riskAmount: 3 }, 'hidden')).toEqual({ pnl: null, riskAmount: undefined });
    expect(sharedTradeResult({ pnl: NaN }, 'usd').pnl).toBeNull();
    expect(sharedTradeResult({ pnl: 12, riskAmount: Infinity }, 'rr').pnl).toBeNull();
    expect(formatSharedPnL(undefined, 'rr')).toBe('—');
  });
});
