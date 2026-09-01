import type {
  TradovateAccountProfile,
  TradovateProfileAccountType,
  TradovateProfileDrawdownType,
} from './tradovateAccountProfileTypes';

export interface TradovatePropPlanPreset {
  propFirm: 'Tradeify' | 'Lucid';
  planName: string;
  accountType: TradovateProfileAccountType;
  accountSize: number;
  drawdownType: TradovateProfileDrawdownType;
  maxLoss: number;
  dailyLossLimit: number | null;
  consistencyPct: number | null;
  profitTarget: number;
  maxMini: number;
  maxMicro: number;
  sourceUrl: string;
  verifiedAt: string;
}

const TRADEIFY_GROWTH_SOURCE = 'https://help.tradeify.co/en/articles/10495915-growth-evaluation-accounts';
const TRADEIFY_SELECT_SOURCE = 'https://help.tradeify.co/en/articles/12853921-select-evaluation-accounts';
export const LUCID_FLEX_SOURCE = 'https://support.lucidtrading.com/en/articles/12945790-lucidflex-evaluation-account';
const LUCID_PRO_SOURCE = 'https://support.lucidtrading.com/en/articles/12890029-lucidpro-evaluation-account';
const LUCID_DAILY_SOURCE = 'https://support.lucidtrading.com/en/articles/15996664-luciddaily-evaluation';
const LUCID_BLACK_SOURCE = 'https://support.lucidtrading.com/en/articles/13424894-lucidblack-evaluation-account';
const VERIFIED_AT = '2026-08-18';

const tradeifyGrowth = (
  accountSize: number,
  maxLoss: number,
  dailyLossLimit: number,
  profitTarget: number,
  maxMini: number,
): TradovatePropPlanPreset => ({
  propFirm: 'Tradeify',
  planName: `Growth ${accountSize / 1000}K`,
  accountType: 'evaluation',
  accountSize,
  drawdownType: 'eod_trailing',
  maxLoss,
  dailyLossLimit,
  consistencyPct: null,
  profitTarget,
  maxMini,
  maxMicro: maxMini * 10,
  sourceUrl: TRADEIFY_GROWTH_SOURCE,
  verifiedAt: VERIFIED_AT,
});

const tradeifySelect = (
  accountSize: number,
  maxLoss: number,
  profitTarget: number,
  maxMini: number,
): TradovatePropPlanPreset => ({
  propFirm: 'Tradeify',
  planName: `Select ${accountSize / 1000}K`,
  accountType: 'evaluation',
  accountSize,
  drawdownType: 'eod_trailing',
  maxLoss,
  dailyLossLimit: null,
  consistencyPct: 40,
  profitTarget,
  maxMini,
  maxMicro: maxMini * 10,
  sourceUrl: TRADEIFY_SELECT_SOURCE,
  verifiedAt: VERIFIED_AT,
});

const lucidEvaluation = (
  family: 'LucidFlex' | 'LucidPro' | 'LucidBlack',
  accountSize: number,
  maxLoss: number,
  dailyLossLimit: number | null,
  consistencyPct: number | null,
  profitTarget: number,
  maxMini: number,
  sourceUrl: string,
): TradovatePropPlanPreset => ({
  propFirm: 'Lucid',
  planName: `${family} ${accountSize / 1000}K`,
  accountType: 'evaluation',
  accountSize,
  drawdownType: 'eod_trailing',
  maxLoss,
  dailyLossLimit,
  consistencyPct,
  profitTarget,
  maxMini,
  maxMicro: maxMini * 10,
  sourceUrl,
  verifiedAt: VERIFIED_AT,
});

const lucidDaily = (
  accountSize: number,
  maxLoss: number,
  dailyLossLimit: number | null,
  profitTarget: number,
  maxMini: number,
  drawdownType: Extract<TradovateProfileDrawdownType, 'trailing' | 'eod_trailing'>,
): TradovatePropPlanPreset => ({
  propFirm: 'Lucid',
  planName: `LucidDaily ${drawdownType === 'eod_trailing' ? 'EOD' : 'Intraday'} DLL ${dailyLossLimit == null ? 'OFF' : 'ON'} ${accountSize / 1000}K`,
  accountType: 'evaluation',
  accountSize,
  drawdownType,
  maxLoss,
  dailyLossLimit,
  consistencyPct: 50,
  profitTarget,
  maxMini,
  maxMicro: maxMini * 10,
  sourceUrl: LUCID_DAILY_SOURCE,
  verifiedAt: VERIFIED_AT,
});

const LUCID_ACCOUNT_SIZES = [
  { accountSize: 25_000, maxLoss: 1_000, dailyLoss: 600, profitTarget: 1_250, maxMini: 2 },
  { accountSize: 50_000, maxLoss: 2_000, dailyLoss: 1_200, profitTarget: 3_000, maxMini: 4 },
  { accountSize: 100_000, maxLoss: 3_000, dailyLoss: 1_800, profitTarget: 6_000, maxMini: 6 },
  { accountSize: 150_000, maxLoss: 4_500, dailyLoss: 2_700, profitTarget: 9_000, maxMini: 10 },
] as const;

const lucidPresets = LUCID_ACCOUNT_SIZES.flatMap(({ accountSize, maxLoss, dailyLoss, profitTarget, maxMini }) => [
  lucidEvaluation('LucidFlex', accountSize, maxLoss, null, 50, profitTarget, maxMini, LUCID_FLEX_SOURCE),
  lucidEvaluation('LucidPro', accountSize, maxLoss, accountSize === 25_000 ? null : dailyLoss, null, profitTarget, maxMini, LUCID_PRO_SOURCE),
  ...accountSize === 150_000 ? [] : [lucidEvaluation('LucidBlack', accountSize, maxLoss, null, 60, profitTarget, maxMini, LUCID_BLACK_SOURCE)],
  lucidDaily(accountSize, maxLoss, dailyLoss, profitTarget, maxMini, 'eod_trailing'),
  lucidDaily(accountSize, maxLoss, null, profitTarget, maxMini, 'eod_trailing'),
  lucidDaily(accountSize, maxLoss, dailyLoss, profitTarget, maxMini, 'trailing'),
  lucidDaily(accountSize, maxLoss, null, profitTarget, maxMini, 'trailing'),
]);

export const TRADOVATE_PROP_PLAN_PRESETS: TradovatePropPlanPreset[] = [
  tradeifyGrowth(25_000, 1_000, 600, 1_500, 1),
  tradeifyGrowth(50_000, 2_000, 1_250, 3_000, 4),
  tradeifyGrowth(100_000, 3_500, 2_500, 6_000, 8),
  tradeifyGrowth(150_000, 5_000, 3_750, 9_000, 12),
  tradeifySelect(25_000, 1_000, 1_500, 1),
  tradeifySelect(50_000, 2_000, 3_000, 4),
  tradeifySelect(100_000, 3_000, 6_000, 8),
  tradeifySelect(150_000, 4_500, 9_000, 12),
  ...lucidPresets,
];

const normalize = (value: string | null | undefined) => (value ?? '')
  .trim()
  .toLowerCase()
  .replace(/[$,]/g, '')
  .replace(/\s+/g, ' ');

export function findTradovatePropPlanPreset(
  propFirm: string | null | undefined,
  planName: string | null | undefined,
): TradovatePropPlanPreset | null {
  const firm = normalize(propFirm);
  const plan = normalize(planName);
  const sizeMatch = plan.match(/(?:^|\s)(25|50|100|150)\s*k?(?:\s|$)/);
  if (!sizeMatch) return null;

  if (firm.includes('tradeify')) {
    const family = plan.includes('growth') ? 'growth' : plan.includes('select') ? 'select' : null;
    if (!family) return null;

    const canonical = `${family} ${sizeMatch[1]}k`;
    return TRADOVATE_PROP_PLAN_PRESETS.find(preset => normalize(preset.planName) === canonical) ?? null;
  }

  if (!firm.includes('lucid')) return null;

  const family = plan.includes('flex')
    ? 'lucidflex'
    : plan.includes('pro')
      ? 'lucidpro'
      : plan.includes('black')
        ? 'lucidblack'
        : plan.includes('daily')
          ? 'luciddaily'
          : null;
  if (!family) return null;

  if (family === 'luciddaily') {
    const drawdown = plan.includes('intraday') ? 'intraday' : plan.includes('eod') ? 'eod' : null;
    const dll = /dll\s*on/.test(plan) ? 'on' : /dll\s*off/.test(plan) ? 'off' : null;
    if (!drawdown || !dll) return null;
    const canonical = `luciddaily ${drawdown} dll ${dll} ${sizeMatch[1]}k`;
    return TRADOVATE_PROP_PLAN_PRESETS.find(preset => normalize(preset.planName) === canonical) ?? null;
  }

  const canonical = `${family} ${sizeMatch[1]}k`;
  return TRADOVATE_PROP_PLAN_PRESETS.find(preset => normalize(preset.planName) === canonical) ?? null;
}

/**
 * Known Tradeify/Lucid simulated-funded plans stop trailing at $100 above the
 * nominal starting balance. The broker-provided trailingMaxDrawdownLimit still
 * has priority; this is only the catalog fallback when Tradovate omits it.
 */
export function fundedTradovateTrailingDrawdownLimit(
  profile: Pick<TradovateAccountProfile,
    'propFirm' | 'planName' | 'accountType' | 'accountSize' | 'drawdownType'> | undefined,
): number | null {
  const preset = profile
    ? findTradovatePropPlanPreset(profile.propFirm, profile.planName)
    : null;
  if (
    !profile
    || profile.accountType !== 'funded'
    || (profile.drawdownType !== 'trailing' && profile.drawdownType !== 'eod_trailing')
    || profile.accountSize == null
    || !Number.isFinite(profile.accountSize)
    || profile.accountSize <= 0
    || !preset
    || preset.accountSize !== profile.accountSize
  ) return null;

  return profile.accountSize + 100;
}

export function inferTradovatePropIdentity(accountName: string): Pick<TradovatePropPlanPreset, 'propFirm'> & { planName: string | null } | null {
  const normalized = accountName.trim().toUpperCase();
  if (/^(?:FTDFY|TDFY)/.test(normalized)) return { propFirm: 'Tradeify', planName: null };
  if (/^LFE/.test(normalized)) return { propFirm: 'Lucid', planName: 'LucidFlex' };
  if (/^(?:LFF|LTT)/.test(normalized) || normalized.includes('LUCID')) return { propFirm: 'Lucid', planName: null };
  return null;
}
