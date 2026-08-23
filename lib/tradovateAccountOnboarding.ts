import type {
  TradovateAccountProfile,
  TradovateAccountProfileInput,
  TradovateProfileAccountType,
} from './tradovateAccountProfileTypes';
import {
  FIRM_PAYOUT_RULE_TEMPLATES,
  normalizeFirmPayoutRules,
  type FirmPayoutRules,
} from './propFirmRules';
import {
  findTradovatePropPlanPreset,
  inferTradovatePropIdentity,
  TRADOVATE_PROP_PLAN_PRESETS,
  type TradovatePropPlanPreset,
} from './tradovatePropPlanCatalog';

export type OnboardingRuleTemplateKey =
  | 'TRADEIFY_GROWTH'
  | 'TRADEIFY_LIGHTNING'
  | 'LUCID_FLEX'
  | 'LUCID_PRO';

export interface TradovateAccountOnboardingDraft {
  profileId: string;
  displayName: string;
  propFirm: string;
  accountType: TradovateProfileAccountType;
  planPresetKey: string | null;
}

export interface TradovateOnboardingRuleWrite {
  firmKey: string;
  rules: FirmPayoutRules;
}

export const tradovateOnboardingPlanPresetKey = (
  preset: Pick<TradovatePropPlanPreset, 'propFirm' | 'planName'>,
): string => JSON.stringify([preset.propFirm, preset.planName]);

export const findTradovateOnboardingPlanPreset = (
  presetKey: string | null,
): TradovatePropPlanPreset | null => {
  if (!presetKey) return null;
  return TRADOVATE_PROP_PLAN_PRESETS.find(
    preset => tradovateOnboardingPlanPresetKey(preset) === presetKey,
  ) ?? null;
};

/** Jakmile jediný profil nemá klíč onboardedAt, server ještě čte staré schéma. */
export function isTradovateAccountOnboardingAvailable(
  profiles: readonly TradovateAccountProfile[],
): boolean {
  return profiles.length > 0 && profiles.every(profile => profile.onboardedAt !== undefined);
}

export function getNewTradovateAccountProfiles(
  profiles: readonly TradovateAccountProfile[],
): TradovateAccountProfile[] {
  if (!isTradovateAccountOnboardingAvailable(profiles)) return [];
  return profiles.filter(profile => profile.status === 'active' && profile.onboardedAt === null);
}

const defaultAccountType = (profile: Pick<TradovateAccountProfile, 'accountType' | 'accountName' | 'environment'>) => {
  if (profile.accountType) return profile.accountType;
  const inferred = inferTradovatePropIdentity(profile.accountName);
  if (inferred) {
    const preset = findTradovatePropPlanPreset(inferred.propFirm, inferred.planName);
    return preset?.accountType ?? 'evaluation';
  }
  return profile.environment === 'live' ? 'live' : 'funded';
};

export function createTradovateAccountOnboardingDraft(
  profile: TradovateAccountProfile,
): TradovateAccountOnboardingDraft {
  const inferred = inferTradovatePropIdentity(profile.accountName);
  const propFirm = profile.propFirm?.trim() || inferred?.propFirm || '';
  const planName = profile.planName ?? inferred?.planName ?? null;
  const preset = findTradovatePropPlanPreset(propFirm, planName);
  return {
    profileId: profile.id,
    displayName: profile.displayName?.trim() || profile.accountName,
    propFirm,
    accountType: preset?.accountType ?? defaultAccountType(profile),
    planPresetKey: preset ? tradovateOnboardingPlanPresetKey(preset) : null,
  };
}

export function applyTradovateOnboardingBulk(
  drafts: readonly TradovateAccountOnboardingDraft[],
  selectedProfileIds: ReadonlySet<string>,
  patch: Partial<Pick<TradovateAccountOnboardingDraft, 'propFirm' | 'accountType' | 'planPresetKey'>>,
): TradovateAccountOnboardingDraft[] {
  return drafts.map(draft => selectedProfileIds.has(draft.profileId) ? { ...draft, ...patch } : draft);
}

const payoutTemplateKeyForPlanPreset = (
  preset: TradovatePropPlanPreset,
): OnboardingRuleTemplateKey | null => {
  const family = preset.planName.trim().toUpperCase();
  if (preset.propFirm === 'Tradeify') {
    if (family.startsWith('GROWTH ')) return 'TRADEIFY_GROWTH';
    if (family.startsWith('LIGHTNING ')) return 'TRADEIFY_LIGHTNING';
  }
  if (preset.propFirm === 'Lucid') {
    if (family.startsWith('LUCIDFLEX ')) return 'LUCID_FLEX';
    if (family.startsWith('LUCIDPRO ')) return 'LUCID_PRO';
  }
  return null;
};

export function payoutRulesForOnboardingPlanPreset(
  preset: TradovatePropPlanPreset,
): { templateKey: OnboardingRuleTemplateKey; rules: FirmPayoutRules } | null {
  const templateKey = payoutTemplateKeyForPlanPreset(preset);
  if (!templateKey) return null;
  const template = FIRM_PAYOUT_RULE_TEMPLATES[templateKey];
  if (!template) throw new Error('Neznámá šablona payout pravidel.');
  return { templateKey, rules: normalizeFirmPayoutRules({ ...template }) };
}

export function planTradovateAccountOnboardingSave({
  profiles,
  drafts,
  selectedProfileIds,
  onboardedAt,
}: {
  profiles: readonly TradovateAccountProfile[];
  drafts: readonly TradovateAccountOnboardingDraft[];
  selectedProfileIds: ReadonlySet<string>;
  onboardedAt: string;
}): { profiles: TradovateAccountProfileInput[]; ruleWrites: TradovateOnboardingRuleWrite[] } {
  if (selectedProfileIds.size === 0) throw new Error('Vyber alespoň jeden účet.');
  if (!Number.isFinite(Date.parse(onboardedAt))) throw new Error('Neplatný čas potvrzení onboardingu.');
  const draftById = new Map(drafts.map(draft => [draft.profileId, draft]));
  const ruleByFirm = new Map<string, { templateKey: OnboardingRuleTemplateKey; rules: FirmPayoutRules }>();
  let matched = 0;

  const nextProfiles = profiles.map(profile => {
    if (!selectedProfileIds.has(profile.id)) return profile;
    const draft = draftById.get(profile.id);
    if (!draft) throw new Error('Chybí rozpracované nastavení vybraného účtu.');
    const displayName = draft.displayName.trim();
    if (!displayName) throw new Error('Každý vybraný účet musí mít jméno.');
    const preset = draft.planPresetKey
      ? findTradovateOnboardingPlanPreset(draft.planPresetKey)
      : null;
    if (draft.planPresetKey && !preset) throw new Error('Vybraný plán už není v katalogu dostupný.');
    const propFirm = preset?.propFirm ?? draft.propFirm.trim();
    if (!propFirm) throw new Error('Každý vybraný účet musí mít firmu.');
    matched += 1;
    const payout = preset ? payoutRulesForOnboardingPlanPreset(preset) : null;
    if (payout) {
      const firmKey = propFirm.toUpperCase();
      const existing = ruleByFirm.get(firmKey);
      if (existing && existing.templateKey !== payout.templateKey) {
        throw new Error(`Firma ${propFirm} má ve výběru dvě různé šablony pravidel.`);
      }
      ruleByFirm.set(firmKey, {
        templateKey: payout.templateKey,
        rules: payout.rules,
      });
    }
    return {
      ...profile,
      displayName,
      propFirm,
      ...(preset ? {
        planName: preset.planName,
        accountSize: preset.accountSize,
        drawdownType: preset.drawdownType,
        maxLoss: preset.maxLoss,
        dailyLossLimit: preset.dailyLossLimit,
        consistencyPct: preset.consistencyPct,
        profitTarget: preset.profitTarget,
        maxMini: preset.maxMini,
        maxMicro: preset.maxMicro,
      } : {}),
      accountType: draft.accountType,
      onboardedAt: new Date(onboardedAt).toISOString(),
    };
  });

  if (matched !== selectedProfileIds.size) throw new Error('Některý vybraný účet už není dostupný.');
  return {
    profiles: nextProfiles,
    ruleWrites: [...ruleByFirm.entries()].map(([firmKey, value]) => ({ firmKey, rules: value.rules })),
  };
}

export function buildMissingTradovateOnboardingProfileInputs({
  brokerAccounts,
  profiles,
}: {
  brokerAccounts: ReadonlyArray<{ id: string | number; name: string }>;
  profiles: readonly TradovateAccountProfile[];
}): TradovateAccountProfileInput[] {
  const existingIds = new Set(profiles.map(profile => profile.externalAccountId));
  return brokerAccounts.flatMap(account => {
    const externalAccountId = String(account.id);
    if (existingIds.has(externalAccountId)) return [];
    const inferred = inferTradovatePropIdentity(account.name);
    return [{
      externalAccountId,
      accountName: account.name,
      displayName: account.name,
      propFirm: inferred?.propFirm ?? null,
      planName: inferred?.planName ?? null,
      // Nechat NULL je důležité pro konzervativní F0 healing: journal nejdřív
      // vznikne ve výchozím Funded/Funded stavu a až potvrzená non-funded volba
      // ho smí přepnout. UI si odhad typu počítá zvlášť v draftu.
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
      onboardedAt: null,
    }];
  });
}
