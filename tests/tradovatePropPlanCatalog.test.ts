import { describe, expect, it } from 'vitest';
import { findTradovatePropPlanPreset, inferTradovatePropIdentity } from '../lib/tradovatePropPlanCatalog';

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

  it('doplní LucidFlex evaluation pravidla včetně EOD drawdownu a limitů kontraktů', () => {
    expect(findTradovatePropPlanPreset('Lucid', 'LucidFlex Evaluation 50K')).toMatchObject({
      propFirm: 'Lucid',
      accountType: 'evaluation',
      accountSize: 50_000,
      drawdownType: 'eod_trailing',
      maxLoss: 2_000,
      dailyLossLimit: null,
      consistencyPct: 50,
      profitTarget: 3_000,
      maxMini: 4,
      maxMicro: 40,
    });
  });

  it('rozlišuje LucidPro DLL a legacy LucidBlack consistency', () => {
    expect(findTradovatePropPlanPreset('Lucid Trading', 'LucidPro 100K')).toMatchObject({
      dailyLossLimit: 1_800,
      consistencyPct: null,
      maxLoss: 3_000,
    });
    expect(findTradovatePropPlanPreset('Lucid', 'LucidBlack 50K')).toMatchObject({
      dailyLossLimit: null,
      consistencyPct: 60,
    });
  });

  it('LucidDaily doplní jen při explicitní volbě drawdownu a DLL', () => {
    expect(findTradovatePropPlanPreset('Lucid', 'LucidDaily EOD DLL OFF 50K')).toMatchObject({
      drawdownType: 'eod_trailing',
      dailyLossLimit: null,
      consistencyPct: 50,
    });
    expect(findTradovatePropPlanPreset('Lucid', 'LucidDaily Intraday DLL ON 50K')).toMatchObject({
      drawdownType: 'trailing',
      dailyLossLimit: 1_200,
    });
    expect(findTradovatePropPlanPreset('Lucid', 'LucidDaily 50K')).toBeNull();
  });

  it('předvyplní Lucid/LucidFlex pro detekovaný LFE účet bez hádání velikosti', () => {
    expect(inferTradovatePropIdentity('LFE05066846490015')).toEqual({ propFirm: 'Lucid', planName: 'LucidFlex' });
    expect(inferTradovatePropIdentity('TDFYG50621860230')).toEqual({ propFirm: 'Tradeify', planName: null });
  });
});
