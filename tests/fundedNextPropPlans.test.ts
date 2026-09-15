import { describe, expect, it } from 'vitest';
import {
  findTradovatePropPlanPreset as find,
  fundedTradovateTrailingDrawdownLimit,
  inferTradovatePropIdentity,
  tradovateAccountFirm,
} from '../lib/tradovatePropPlanCatalog';
import { FUNDEDNEXT_PROP_PLAN_PRESETS } from '../lib/fundedNextPropPlans';
import {
  createTradovateAccountOnboardingDraft,
  planTradovateAccountOnboardingSave,
  tradovateOnboardingPlanPresetKey,
} from '../lib/tradovateAccountOnboarding';
import { buildTradovateConnectionSummaries } from '../lib/tradovateLiveConnectionCache';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import type { TradovateOAuthStatus, TradovatePreflightResult } from '../services/tradovateOAuthConnection';

describe('FundedNext Futures integration', () => {
  it('recognizes a broker prefix without inventing plan, size or phase', () => {
    expect(inferTradovatePropIdentity(' fnftchTEST123 ')).toEqual({ propFirm: 'FundedNext', planName: null });
    expect(inferTradovatePropIdentity('UNRELATED-FNFT')).toBeNull();
    expect(tradovateAccountFirm({ propFirm: '  Custom firm ' }, 'FNFTCHTEST123')).toBe('Custom firm');
    expect(tradovateAccountFirm({ propFirm: null }, 'FNFTCHTEST123')).toBe('FundedNext');
    expect(tradovateAccountFirm(undefined, undefined)).toBeNull();
  });

  it('shows an existing null-profile connection without mutating its data', () => {
    const profiles = [{ externalAccountId: '31', propFirm: null }] as TradovateAccountProfile[];
    const data = { accounts: [{ id: 31, name: 'FNFTCHTEST' }] } as TradovatePreflightResult;
    const status = { connections: [{ id: 'fundednext', organizationName: null }] } as TradovateOAuthStatus;
    expect(buildTradovateConnectionSummaries(status, { fundednext: data }, profiles).fundednext)
      .toEqual({ accountCount: 1, organizationName: 'FundedNext' });
    expect(profiles[0].propFirm).toBeNull();
  });

  it('distinguishes Legacy and Flex 50K despite their same account size', () => {
    expect(find('Funded Next', 'Legacy 50K')).toMatchObject({ maxLoss: 2_000, profitTarget: 3_000, dailyLossLimit: null, consistencyPct: 40, maxMicro: 30 });
    expect(find('FundedNext', 'Flex 50K')).toMatchObject({ maxLoss: 1_500, profitTarget: 2_500, dailyLossLimit: null, maxMicro: 30 });
    expect(find('FundedNext', 'Legacy 50K', 'funded')).toMatchObject({ accountType: 'funded', profitTarget: 0, consistencyPct: null, maxMini: 5, maxMicro: 50 });
    expect(find('FundedNext', 'Flex 50K', 'funded')).toMatchObject({ accountType: 'funded', profitTarget: 0, consistencyPct: null, maxMicro: 30 });
  });

  it('requires the Rapid Pro DLL choice and keeps Rapid Daily and retired Rapid separate', () => {
    expect(find('FundedNext', 'Rapid Pro 50K')).toBeNull();
    expect(find('FundedNext', 'Rapid Pro DLL OFF 50K', 'funded')).toMatchObject({ dailyLossLimit: null, consistencyPct: 40, maxMicro: 40 });
    expect(find('FundedNext', 'Rapid Pro DLL ON 50K')).toMatchObject({ dailyLossLimit: 1_000, consistencyPct: null });
    expect(find('FundedNext', 'Rapid Daily 50K', 'funded')).toMatchObject({ dailyLossLimit: 1_000, consistencyPct: null });
    expect(find('FundedNext', 'Rapid 50K')).toMatchObject({ maxMini: 3, maxMicro: 15, discontinued: true });
    expect(find('FundedNext', 'Rapid 50K', 'funded')).toMatchObject({ maxMini: 5, maxMicro: 25 });
    expect(find('FundedNext', 'Bolt 50K')).toMatchObject({ maxMini: 3, maxMicro: 9, discontinued: true });
    expect(find('FundedNext', 'Flex 25K')).toBeNull();
    expect(find('FundedNext', 'Stellar 50K')).toBeNull();
    expect(find('FundedNext', 'Legacy 50K', 'live')).toBeNull();
  });

  it('uses each family lock level instead of inheriting the Lucid +100 rule', () => {
    for (const [planName, expected] of [['Legacy 50K', 50_000], ['Rapid 50K', 50_000], ['Flex 50K', 50_100], ['Rapid Daily 50K', 50_100], ['Bolt 50K', 50_100]] as const) {
      expect(fundedTradovateTrailingDrawdownLimit({ propFirm: 'FundedNext', planName, accountType: 'funded', accountSize: 50_000, drawdownType: 'eod_trailing' })).toBe(expected);
    }
    expect(fundedTradovateTrailingDrawdownLimit({ propFirm: 'FundedNext', planName: 'Unknown 50K', accountType: 'funded', accountSize: 50_000, drawdownType: 'eod_trailing' })).toBeNull();
  });

  it('saves a batch of five using the selected phase and does not apply a firm-wide payout template', () => {
    const profiles = Array.from({ length: 5 }, (_, i) => ({
      id: `fn-${i}`, externalAccountId: `${i}`, accountName: `FNFTCHTEST${i}`, propFirm: null,
      planName: null, accountType: null, environment: 'demo', status: 'active', onboardedAt: null,
    })) as TradovateAccountProfile[];
    const preset = find('FundedNext', 'Legacy 50K')!;
    const drafts = profiles.map(profile => ({ ...createTradovateAccountOnboardingDraft(profile), accountType: 'funded' as const, planPresetKey: tradovateOnboardingPlanPresetKey(preset) }));
    const result = planTradovateAccountOnboardingSave({ profiles, drafts, selectedProfileIds: new Set(profiles.map(profile => profile.id)), onboardedAt: '2026-09-15T16:00:00Z' });
    expect(result.profiles).toHaveLength(5);
    for (const profile of result.profiles) expect(profile).toMatchObject({ propFirm: 'FundedNext', planName: 'Legacy 50K', accountType: 'funded', maxMicro: 50, consistencyPct: null, profitTarget: 0 });
    expect(result.ruleWrites).toEqual([]);
    expect(profiles.every(profile => profile.propFirm === null)).toBe(true);
  });

  it('provides uniquely addressable, dated presets for every supported futures size and DLL variant', () => {
    expect(FUNDEDNEXT_PROP_PLAN_PRESETS).toHaveLength(19);
    expect(new Set(FUNDEDNEXT_PROP_PLAN_PRESETS.map(preset => preset.planName)).size).toBe(19);
    for (const preset of FUNDEDNEXT_PROP_PLAN_PRESETS) {
      expect(find('FundedNext', preset.planName)).toEqual(preset);
      expect(preset.verifiedAt).toBe('2026-09-15');
      expect(preset.sourceUrl).toMatch(/^https:\/\/(helpfutures\.)?fundednext\.com\//);
      expect(find('FundedNext', preset.planName, 'funded')?.profitTarget).toBe(0);
    }
  });
});
