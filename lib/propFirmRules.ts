export interface FirmPayoutRules {
  planName: string;
  profitDaysRequired: number | null;
  minProfitPerDayUsd: number | null;
  minPayoutUsd: number | null;
  maxPayoutUsd: number | null;
  withdrawablePctOfProfit: number | null;
  minBalanceToRequestUsd: number | null;
  payoutCycleDays: number | null;
  consistencyPct: number | null;
  splitPct: number | null;
  drawdownType: 'trailing' | 'eod_trailing' | 'static' | null;
}

const rules = (
  planName: string,
  overrides: Partial<Omit<FirmPayoutRules, 'planName'>>,
): FirmPayoutRules => ({
  planName,
  profitDaysRequired: null,
  minProfitPerDayUsd: null,
  minPayoutUsd: null,
  maxPayoutUsd: null,
  withdrawablePctOfProfit: null,
  minBalanceToRequestUsd: null,
  payoutCycleDays: null,
  consistencyPct: null,
  splitPct: null,
  drawdownType: null,
  ...overrides,
});

// Veřejná pravidla ověřená v 08/2026 jsou pouze výchozí šablony; uživatel je
// může uložit a upravit, protože firmy své podmínky průběžně mění.
export const TRADEIFY_GROWTH_FUNDED_RULES = rules('Growth Funded', {
  profitDaysRequired: 5,
  minBalanceToRequestUsd: 53_000,
  consistencyPct: 35,
  splitPct: 90,
  drawdownType: 'eod_trailing',
});

export const TRADEIFY_LIGHTNING_FUNDED_RULES = rules('Lightning Funded', {
  consistencyPct: 20,
  splitPct: 90,
  drawdownType: 'eod_trailing',
});

export const LUCID_FLEX_RULES = rules('LucidFlex', {
  profitDaysRequired: 5,
  minPayoutUsd: 100,
  payoutCycleDays: 14,
  withdrawablePctOfProfit: 50,
  splitPct: 90,
  drawdownType: 'eod_trailing',
});

export const LUCID_PRO_RULES = rules('LucidPro', {
  payoutCycleDays: 3,
  splitPct: 90,
  drawdownType: 'eod_trailing',
});

export const FIRM_PAYOUT_RULE_TEMPLATES: Readonly<Record<string, FirmPayoutRules>> = {
  TRADEIFY_GROWTH: TRADEIFY_GROWTH_FUNDED_RULES,
  TRADEIFY_LIGHTNING: TRADEIFY_LIGHTNING_FUNDED_RULES,
  LUCID_FLEX: LUCID_FLEX_RULES,
  LUCID_PRO: LUCID_PRO_RULES,
};

/** JSON uložený před F3c čteme bez nových polí jako explicitní null. */
export const normalizeFirmPayoutRules = (value: FirmPayoutRules): FirmPayoutRules => ({
  ...value,
  withdrawablePctOfProfit: value.withdrawablePctOfProfit ?? null,
  minBalanceToRequestUsd: value.minBalanceToRequestUsd ?? null,
});

export function payoutRuleTemplateForFirm(firmKey: string): FirmPayoutRules | null {
  const normalized = firmKey.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  const template = FIRM_PAYOUT_RULE_TEMPLATES[normalized]
    ?? (normalized === 'TRADEIFY' ? TRADEIFY_GROWTH_FUNDED_RULES : null)
    ?? (normalized === 'LUCID' ? LUCID_FLEX_RULES : null);
  return template ? normalizeFirmPayoutRules({ ...template }) : null;
}
