import { describe, expect, it } from 'vitest';
import {
  LUCID_FLEX_RULES,
  LUCID_PRO_RULES,
  normalizeFirmPayoutRules,
  payoutRuleTemplateForFirm,
  TRADEIFY_GROWTH_FUNDED_RULES,
  TRADEIFY_LIGHTNING_FUNDED_RULES,
} from '../lib/propFirmRules';

describe('prop firm payout rule templates', () => {
  it('contains the editable August 2026 defaults', () => {
    expect(TRADEIFY_GROWTH_FUNDED_RULES).toMatchObject({
      planName: 'Growth Funded', profitDaysRequired: 5, consistencyPct: 35,
      minBalanceToRequestUsd: 53_000, splitPct: 90, drawdownType: 'eod_trailing',
    });
    expect(TRADEIFY_LIGHTNING_FUNDED_RULES).toMatchObject({
      planName: 'Lightning Funded', profitDaysRequired: null, consistencyPct: 20,
    });
    expect(LUCID_FLEX_RULES).toMatchObject({
      planName: 'LucidFlex', profitDaysRequired: 5, minPayoutUsd: 100, payoutCycleDays: 14,
      withdrawablePctOfProfit: 50,
    });
    expect(LUCID_PRO_RULES).toMatchObject({
      planName: 'LucidPro', profitDaysRequired: null, payoutCycleDays: 3,
    });
  });

  it('returns a fresh fallback object for normalized firm keys', () => {
    const first = payoutRuleTemplateForFirm('tradeify');
    const second = payoutRuleTemplateForFirm('TRADEIFY_GROWTH');
    expect(first).toEqual(TRADEIFY_GROWTH_FUNDED_RULES);
    expect(second).toEqual(TRADEIFY_GROWTH_FUNDED_RULES);
    expect(first).not.toBe(second);
    expect(payoutRuleTemplateForFirm('unknown')).toBeNull();
  });

  it('reads payout rules stored before F3c with new fields set to null', () => {
    const legacy = { ...LUCID_PRO_RULES } as Partial<typeof LUCID_PRO_RULES>;
    delete legacy.withdrawablePctOfProfit;
    delete legacy.minBalanceToRequestUsd;
    expect(normalizeFirmPayoutRules(legacy as typeof LUCID_PRO_RULES)).toMatchObject({
      withdrawablePctOfProfit: null,
      minBalanceToRequestUsd: null,
    });
  });
});
