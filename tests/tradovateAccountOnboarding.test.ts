import { describe, expect, it } from 'vitest';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import {
  buildMissingTradovateOnboardingProfileInputs,
  createTradovateAccountOnboardingDraft,
  findTradovateOnboardingPlanPreset,
  getNewTradovateAccountProfiles,
  isTradovateAccountOnboardingAvailable,
  payoutRulesForOnboardingPlanPreset,
  planTradovateAccountOnboardingSave,
  tradovateOnboardingPlanPresetKey,
} from '../lib/tradovateAccountOnboarding';
import { findTradovatePropPlanPreset } from '../lib/tradovatePropPlanCatalog';

const profile = (id: string, patch: Partial<TradovateAccountProfile> = {}): TradovateAccountProfile => ({
  id,
  provider: 'tradovate',
  environment: 'demo',
  externalAccountId: id,
  accountName: id === 'p1' ? 'TDFYG50621860230' : 'LFE05066846490015',
  displayName: null,
  propFirm: null,
  planName: null,
  accountType: null,
  accountSize: null,
  drawdownType: null,
  maxLoss: null,
  dailyLossLimit: null,
  consistencyPct: null,
  profitTarget: null,
  maxMini: null,
  maxMicro: null,
  mappedAccountId: null,
  status: 'active',
  lastSeenAt: '2026-08-23T07:00:00.000Z',
  createdAt: '2026-08-23T07:00:00.000Z',
  updatedAt: '2026-08-23T07:00:00.000Z',
  ...patch,
});

const preset = (firm: string, planName: string) => {
  const result = findTradovatePropPlanPreset(firm, planName);
  if (!result) throw new Error(`Chybí testovací preset ${firm} ${planName}.`);
  return result;
};

describe('detekce nových Tradovate účtů', () => {
  it('před migrací onboarding úplně skryje a po migraci vrátí jen aktivní NULL profily', () => {
    expect(isTradovateAccountOnboardingAvailable([profile('legacy')])).toBe(false);
    expect(getNewTradovateAccountProfiles([profile('legacy')])).toEqual([]);

    const rows = [
      profile('new', { onboardedAt: null }),
      profile('done', { onboardedAt: '2026-08-23T07:05:00.000Z' }),
      profile('archived', { onboardedAt: null, status: 'archived' }),
    ];
    expect(isTradovateAccountOnboardingAvailable(rows)).toBe(true);
    expect(getNewTradovateAccountProfiles(rows).map(row => row.id)).toEqual(['new']);
  });

  it('bez velikosti z broker názvu nehádá plán a založí chybějící profily bez rizikových parametrů', () => {
    expect(createTradovateAccountOnboardingDraft(profile('p1', { onboardedAt: null }))).toMatchObject({
      propFirm: 'Tradeify', accountType: 'evaluation', planPresetKey: null,
    });
    const missing = buildMissingTradovateOnboardingProfileInputs({
      brokerAccounts: [{ id: 'p1', name: 'TDFYG50621860230' }, { id: 'p2', name: 'LFE05066846490015' }],
      profiles: [profile('p1', { onboardedAt: '2026-08-23T07:00:00.000Z' })],
    });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      externalAccountId: 'p2',
      propFirm: 'Lucid',
      planName: 'LucidFlex',
      accountType: null,
      accountSize: null,
      drawdownType: null,
      maxLoss: null,
      dailyLossLimit: null,
      consistencyPct: null,
      profitTarget: null,
      maxMini: null,
      maxMicro: null,
      onboardedAt: null,
    });
  });

  it('předvyplní stabilní klíč plánu, jen když profil obsahuje dost údajů pro přesný preset', () => {
    const draft = createTradovateAccountOnboardingDraft(profile('p1', {
      onboardedAt: null,
      propFirm: 'Tradeify',
      planName: 'Growth 50K',
    }));
    expect(findTradovateOnboardingPlanPreset(draft.planPresetKey)).toMatchObject({
      propFirm: 'Tradeify', planName: 'Growth 50K', accountSize: 50_000,
    });
  });
});

describe('dávkový onboarding plán', () => {
  it('odvodí payout šablonu z rodiny presetu a nenamapovatelný plán přeskočí', () => {
    const growth = preset('Tradeify', 'Growth 50K');
    const first = payoutRulesForOnboardingPlanPreset(growth);
    const second = payoutRulesForOnboardingPlanPreset(growth);
    expect(first).toMatchObject({
      templateKey: 'TRADEIFY_GROWTH',
      rules: { planName: 'Growth Funded', profitDaysRequired: 5, minBalanceToRequestUsd: 53_000 },
    });
    expect(first?.rules).not.toBe(second?.rules);
    expect(payoutRulesForOnboardingPlanPreset(preset('Tradeify', 'Select 50K'))).toBeNull();
  });

  it('potvrzení zapíše rizikové parametry presetu a jediný upsert pravidel pro společnou firmu', () => {
    const profiles = [profile('p1', { onboardedAt: null }), profile('p2', { onboardedAt: null })];
    const growth = preset('Tradeify', 'Growth 50K');
    const drafts = profiles.map(createTradovateAccountOnboardingDraft).map(draft => ({
      ...draft,
      accountType: 'funded' as const,
      planPresetKey: tradovateOnboardingPlanPresetKey(growth),
    }));
    const plan = planTradovateAccountOnboardingSave({
      profiles,
      drafts,
      selectedProfileIds: new Set(['p1', 'p2']),
      onboardedAt: '2026-08-23T07:10:00.000Z',
    });
    expect(plan.profiles.map(item => item.onboardedAt)).toEqual([
      '2026-08-23T07:10:00.000Z',
      '2026-08-23T07:10:00.000Z',
    ]);
    expect(plan.profiles.every(item => (
      item.propFirm === 'Tradeify'
      && item.planName === 'Growth 50K'
      && item.accountType === 'funded'
      && item.accountSize === 50_000
      && item.drawdownType === 'eod_trailing'
      && item.maxLoss === 2_000
      && item.dailyLossLimit === 1_250
      && item.consistencyPct === null
      && item.profitTarget === 3_000
      && item.maxMini === 4
      && item.maxMicro === 40
    ))).toBe(true);
    expect(plan.ruleWrites).toHaveLength(1);
    expect(plan.ruleWrites[0]).toMatchObject({ firmKey: 'TRADEIFY', rules: { planName: 'Growth Funded' } });
  });

  it('odmítne dva plány jedné firmy, které odvozují rozdílné payout šablony', () => {
    const profiles = [profile('p1', { onboardedAt: null }), profile('p2', { onboardedAt: null })];
    const flex = preset('Lucid', 'LucidFlex 50K');
    const pro = preset('Lucid', 'LucidPro 50K');
    const drafts = profiles.map(createTradovateAccountOnboardingDraft);
    drafts[0].planPresetKey = tradovateOnboardingPlanPresetKey(flex);
    drafts[1].planPresetKey = tradovateOnboardingPlanPresetKey(pro);
    expect(() => planTradovateAccountOnboardingSave({
      profiles,
      drafts,
      selectedProfileIds: new Set(['p1', 'p2']),
      onboardedAt: '2026-08-23T07:10:00.000Z',
    })).toThrow('Firma Lucid má ve výběru dvě různé šablony pravidel.');
  });

  it('ponechá nezaškrtnutý profil beze změny a bez plánu nemaže ani neupsertuje pravidla', () => {
    const profiles = [
      profile('p1', { onboardedAt: null }),
      profile('p2', { onboardedAt: null, planName: 'Vlastní', maxLoss: 777 }),
    ];
    const drafts = profiles.map(createTradovateAccountOnboardingDraft).map(draft => ({
      ...draft, propFirm: 'Lucid', planPresetKey: null,
    }));
    const plan = planTradovateAccountOnboardingSave({
      profiles,
      drafts,
      selectedProfileIds: new Set(['p2']),
      onboardedAt: '2026-08-23T07:10:00.000Z',
    });
    expect(plan.profiles[0]).toBe(profiles[0]);
    expect(plan.profiles[1]).toMatchObject({
      propFirm: 'Lucid',
      planName: 'Vlastní',
      maxLoss: 777,
      onboardedAt: '2026-08-23T07:10:00.000Z',
    });
    expect(plan.ruleWrites).toEqual([]);
  });
});
