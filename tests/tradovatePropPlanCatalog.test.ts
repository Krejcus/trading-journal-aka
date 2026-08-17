import { describe, expect, it } from 'vitest';
import { findTradovatePropPlanPreset } from '../lib/tradovatePropPlanCatalog';

describe('Tradovate prop plan catalog', () => {
  it('najde aktuální Tradeify Growth 50K pravidla i z přirozeného názvu', () => {
    expect(findTradovatePropPlanPreset('Tradeify', 'Growth Evaluation 50K')).toMatchObject({
      accountType: 'evaluation',
      accountSize: 50_000,
      drawdownType: 'eod_trailing',
      maxLoss: 2_000,
      dailyLossLimit: 1_250,
      consistencyPct: null,
      profitTarget: 3_000,
      maxMini: 4,
      maxMicro: 40,
    });
  });

  it('rozlišuje Select pravidla a účet bez daily loss limitu', () => {
    expect(findTradovatePropPlanPreset('Tradeify Futures', 'SELECT $100K')).toMatchObject({
      accountSize: 100_000,
      maxLoss: 3_000,
      dailyLossLimit: null,
      consistencyPct: 40,
      profitTarget: 6_000,
      maxMini: 8,
      maxMicro: 80,
    });
  });

  it('nepředstírá znalost neznámé firmy nebo plánu', () => {
    expect(findTradovatePropPlanPreset('Jiná firma', 'Growth 50K')).toBeNull();
    expect(findTradovatePropPlanPreset('Tradeify', 'Vlastní plán')).toBeNull();
  });
});
