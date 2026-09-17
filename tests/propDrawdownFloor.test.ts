import { describe, expect, it } from 'vitest';
import { brokerRiskEquity, propDrawdownFloor } from '../services/brokerPort';

describe('propDrawdownFloor (Tradovate risk status → floor propky)', () => {
  it('fresh Lucid funded account: high-water = start balance, floor is start − trailing', () => {
    // 17. 9. 2026: LFF…0008–0011 měly maxNetLiq = minNetLiq = 50 000 a byly falešně BREACHED.
    expect(propDrawdownFloor({ highWaterNetLiq: 50_000, trailingMaxDrawdown: 2_000, trailingMaxDrawdownLimit: 50_100 })).toBe(48_000);
  });
  it('traded account: trailing floor stops at the broker trailing limit', () => {
    expect(propDrawdownFloor({ highWaterNetLiq: 52_718.5, trailingMaxDrawdown: 2_000, trailingMaxDrawdownLimit: 50_100 })).toBe(50_100);
    expect(propDrawdownFloor({ highWaterNetLiq: 51_000, trailingMaxDrawdown: 2_000, trailingMaxDrawdownLimit: 50_100 })).toBe(49_000);
  });
  it('without a limit the floor trails the high-water mark', () => {
    expect(propDrawdownFloor({ highWaterNetLiq: 50_250, trailingMaxDrawdown: 2_000, trailingMaxDrawdownLimit: null })).toBe(48_250);
  });
  it('never guesses a floor without a watermark or a positive trailing drawdown', () => {
    expect(propDrawdownFloor({ highWaterNetLiq: null, trailingMaxDrawdown: 2_000, trailingMaxDrawdownLimit: 50_100 })).toBeNull();
    expect(propDrawdownFloor({ highWaterNetLiq: 50_000, trailingMaxDrawdown: null, trailingMaxDrawdownLimit: 50_100 })).toBeNull();
    expect(propDrawdownFloor({ highWaterNetLiq: 50_000, trailingMaxDrawdown: 0, trailingMaxDrawdownLimit: 50_100 })).toBeNull();
    expect(propDrawdownFloor({ highWaterNetLiq: Number.NaN, trailingMaxDrawdown: 2_000, trailingMaxDrawdownLimit: null })).toBeNull();
  });
  it('a zero or negative trailing limit is a disabled sentinel, not a floor', () => {
    expect(propDrawdownFloor({ highWaterNetLiq: 50_000, trailingMaxDrawdown: 2_000, trailingMaxDrawdownLimit: 0 })).toBe(48_000);
  });
});

describe('brokerRiskEquity', () => {
  it('prefers real net liq and falls back to realized cash (flat account)', () => {
    expect(brokerRiskEquity({ netLiq: 49_900, cashBalanceUsd: 50_000 })).toBe(49_900);
    expect(brokerRiskEquity({ netLiq: null, cashBalanceUsd: 50_000 })).toBe(50_000);
    expect(brokerRiskEquity({ netLiq: null, cashBalanceUsd: null })).toBeNull();
    expect(brokerRiskEquity({ netLiq: Number.POSITIVE_INFINITY, cashBalanceUsd: 1 })).toBe(1);
  });
});
