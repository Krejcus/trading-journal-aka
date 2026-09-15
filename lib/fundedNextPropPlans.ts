import type { TradovatePropPlanPreset } from './tradovatePropPlanCatalog';

export const FUNDEDNEXT_FUTURES_SOURCE = 'https://helpfutures.fundednext.com/en/articles/14255818-what-types-and-sizes-of-challenges-are-available-at-fundednext-futures';
const article = (slug: string) => `https://helpfutures.fundednext.com/en/articles/${slug}`;
const rapidSource = article('15877643-what-is-fundednext-futures-rapid-pro-daily-challenge');
const legacySource = article('14282252-how-do-i-pass-fundednext-futures-legacy-challenge');
const flexSource = article('14878840-what-is-the-profit-target-in-the-fundednext-futures-flex-challenge');

/** Futures only. Prefixes identify the firm, never the purchased plan or DLL add-on.
 * Official rule references and the phase differences are recorded in docs/fundednext-futures-plans.md.
 */
const plan = (
  family: string, accountSize: number, maxLoss: number, profitTarget: number,
  dailyLossLimit: number | null, consistencyPct: number | null,
  maxMini: number, maxMicro: number, fundedMini: number, fundedMicro: number,
  fundedConsistency: number | null, trailingLockOffset: number, sourceUrl: string,
  discontinued = false,
): TradovatePropPlanPreset => ({
  propFirm: 'FundedNext', planName: `${family} ${accountSize / 1000}K`,
  accountType: 'evaluation', accountSize, drawdownType: 'eod_trailing', maxLoss,
  profitTarget, dailyLossLimit, consistencyPct, maxMini, maxMicro,
  fundedRules: { profitTarget: 0, consistencyPct: fundedConsistency, maxMini: fundedMini, maxMicro: fundedMicro },
  trailingLockOffset, sourceUrl, verifiedAt: '2026-09-15', discontinued,
});

const rapidSizes = [
  { size: 25_000, loss: 1_000, target: 1_500, daily: 500, mini: 2 },
  { size: 50_000, loss: 2_000, target: 3_000, daily: 1_000, mini: 4 },
  { size: 100_000, loss: 2_500, target: 5_000, daily: 1_250, mini: 6 },
];

export const FUNDEDNEXT_PROP_PLAN_PRESETS: TradovatePropPlanPreset[] = [
  ...rapidSizes.flatMap(({ size, loss, target, daily, mini }) => [
    plan('Rapid Pro DLL OFF', size, loss, target, null, null, mini, mini * 10, mini, mini * 10, 40, 100, rapidSource),
    plan('Rapid Pro DLL ON', size, loss, target, daily, null, mini, mini * 10, mini, mini * 10, 40, 100, rapidSource),
    plan('Rapid Daily', size, loss, target, daily, null, mini, mini * 10, mini, mini * 10, null, 100, rapidSource),
  ]),
  plan('Legacy', 25_000, 1_000, 1_250, null, 40, 2, 20, 3, 30, null, 0, legacySource),
  plan('Legacy', 50_000, 2_000, 3_000, null, 40, 3, 30, 5, 50, null, 0, legacySource),
  plan('Legacy', 100_000, 3_000, 6_000, null, 40, 5, 50, 7, 70, null, 0, legacySource),
  plan('Flex', 50_000, 1_500, 2_500, null, 40, 3, 30, 3, 30, null, 100, flexSource),
  plan('Flex', 100_000, 2_500, 5_000, null, 40, 5, 50, 5, 50, null, 100, flexSource),
  plan('Flex', 150_000, 4_000, 8_000, null, 40, 8, 80, 8, 80, null, 100, flexSource),
  // Retired 10 July 2026; existing accounts remain valid. Keep their distinct ratios.
  plan('Rapid', 25_000, 1_000, 1_500, null, null, 2, 10, 3, 15, 40, 0, article('14282756-how-do-i-pass-fundednext-futures-rapid-challenge'), true),
  plan('Rapid', 50_000, 2_000, 3_000, null, null, 3, 15, 5, 25, 40, 0, article('14282756-how-do-i-pass-fundednext-futures-rapid-challenge'), true),
  plan('Rapid', 100_000, 2_500, 5_000, null, null, 5, 25, 7, 35, 40, 0, article('14282756-how-do-i-pass-fundednext-futures-rapid-challenge'), true),
  plan('Bolt', 50_000, 2_000, 3_000, 1_000, 40, 3, 9, 3, 9, null, 100, 'https://fundednext.com/futures/bolt', true),
];
