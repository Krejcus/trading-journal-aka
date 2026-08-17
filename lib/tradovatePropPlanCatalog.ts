import type {
  TradovateProfileAccountType,
  TradovateProfileDrawdownType,
} from './tradovateAccountProfileTypes';

export interface TradovatePropPlanPreset {
  propFirm: 'Tradeify';
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
const VERIFIED_AT = '2026-08-15';

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

export const TRADOVATE_PROP_PLAN_PRESETS: TradovatePropPlanPreset[] = [
  tradeifyGrowth(25_000, 1_000, 600, 1_500, 1),
  tradeifyGrowth(50_000, 2_000, 1_250, 3_000, 4),
  tradeifyGrowth(100_000, 3_500, 2_500, 6_000, 8),
  tradeifyGrowth(150_000, 5_000, 3_750, 9_000, 12),
  tradeifySelect(25_000, 1_000, 1_500, 1),
  tradeifySelect(50_000, 2_000, 3_000, 4),
  tradeifySelect(100_000, 3_000, 6_000, 8),
  tradeifySelect(150_000, 4_500, 9_000, 12),
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
  if (!firm.includes('tradeify')) return null;

  const family = plan.includes('growth') ? 'growth' : plan.includes('select') ? 'select' : null;
  const sizeMatch = plan.match(/(?:^|\s)(25|50|100|150)\s*k?(?:\s|$)/);
  if (!family || !sizeMatch) return null;

  const canonical = `${family} ${sizeMatch[1]}k`;
  return TRADOVATE_PROP_PLAN_PRESETS.find(preset => normalize(preset.planName) === canonical) ?? null;
}
