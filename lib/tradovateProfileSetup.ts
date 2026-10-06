import type {
  TradovateAccountProfile,
  TradovateAccountProfileInput,
  TradovateProfileAccountType,
  TradovateProfileDrawdownType,
} from './tradovateAccountProfileTypes';
import {
  findTradovatePropPlanPreset,
  inferTradovatePropIdentity,
  TRADOVATE_PROP_PLAN_PRESETS,
  type TradovatePropPlanPreset,
} from './tradovatePropPlanCatalog';

/*
 * Okno „Plány účtů“: formulářový stav profilu Tradovate účtu a čisté výpočty
 * nad ním — seskupení podle propky, co účtu do dokončeného plánu chybí,
 * krátký přehled pravidel a doplnění limitů z katalogu plánů.
 */

export type ProfileForm = Omit<TradovateAccountProfileInput,
  'accountSize' | 'maxLoss' | 'dailyLossLimit' | 'consistencyPct' | 'profitTarget' | 'maxMini' | 'maxMicro'> & {
  accountSize: string;
  maxLoss: string;
  dailyLossLimit: string;
  consistencyPct: string;
  profitTarget: string;
  maxMini: string;
  maxMicro: string;
};

export type IdentityPatch = Partial<Pick<ProfileForm, 'propFirm' | 'planName' | 'accountType'>>;

const numberText = (value: number | null | undefined) => value == null ? '' : String(value);

const presetPatch = (preset: TradovatePropPlanPreset): Partial<ProfileForm> => ({
  propFirm: preset.propFirm,
  planName: preset.planName,
  accountType: preset.accountType,
  accountSize: String(preset.accountSize),
  drawdownType: preset.drawdownType,
  maxLoss: String(preset.maxLoss),
  dailyLossLimit: numberText(preset.dailyLossLimit),
  consistencyPct: numberText(preset.consistencyPct),
  profitTarget: String(preset.profitTarget),
  maxMini: String(preset.maxMini),
  maxMicro: String(preset.maxMicro),
});

const fillMissingFromPreset = (profile: ProfileForm, preset: TradovatePropPlanPreset): ProfileForm => ({
  ...profile,
  accountType: profile.accountType ?? preset.accountType,
  accountSize: profile.accountSize || String(preset.accountSize),
  drawdownType: profile.drawdownType ?? preset.drawdownType,
  maxLoss: profile.maxLoss || String(preset.maxLoss),
  dailyLossLimit: profile.dailyLossLimit || numberText(preset.dailyLossLimit),
  consistencyPct: profile.consistencyPct || numberText(preset.consistencyPct),
  profitTarget: profile.profitTarget || String(preset.profitTarget),
  maxMini: profile.maxMini || String(preset.maxMini),
  maxMicro: profile.maxMicro || String(preset.maxMicro),
});

export const profileFormFromAccount = (
  account: { id: number | string; name: string },
  profile: TradovateAccountProfile | undefined,
): ProfileForm => {
  const inferred = inferTradovatePropIdentity(account.name);
  const result: ProfileForm = {
    externalAccountId: String(account.id),
    accountName: account.name,
    displayName: profile?.displayName ?? account.name,
    propFirm: profile?.propFirm ?? inferred?.propFirm ?? null,
    planName: profile?.planName ?? inferred?.planName ?? null,
    accountType: profile?.accountType ?? null,
    accountSize: numberText(profile?.accountSize),
    drawdownType: profile?.drawdownType ?? null,
    maxLoss: numberText(profile?.maxLoss),
    dailyLossLimit: numberText(profile?.dailyLossLimit),
    consistencyPct: numberText(profile?.consistencyPct),
    profitTarget: numberText(profile?.profitTarget),
    maxMini: numberText(profile?.maxMini),
    maxMicro: numberText(profile?.maxMicro),
    mappedAccountId: profile?.mappedAccountId ?? null,
  };
  const preset = findTradovatePropPlanPreset(result.propFirm, result.planName, result.accountType);
  return preset ? fillMissingFromPreset(result, preset) : result;
};

/**
 * Změna firmy, plánu nebo fáze → limity z katalogu. Bez nalezeného plánu se
 * u FundedNext limity vyprázdní (nesmí zůstat limity jiného plánu), u
 * ostatních zůstanou, jak jsou.
 */
export const identityPatch = (profile: ProfileForm, patch: IdentityPatch): Partial<ProfileForm> => {
  const candidate = { ...profile, ...patch };
  const preset = findTradovatePropPlanPreset(candidate.propFirm, candidate.planName, candidate.accountType);
  if (!preset) {
    if (candidate.propFirm?.replace(/\s/g, '').toLowerCase() === 'fundednext') {
      return { ...patch, accountSize: '', drawdownType: null, maxLoss: '', dailyLossLimit: '', consistencyPct: '', profitTarget: '', maxMini: '', maxMicro: '' };
    }
    return patch;
  }
  const filled = presetPatch(preset);
  // Změna názvu plánu nesmí funded/live účet potichu vrátit do Evaluation.
  // U dosud nezařazeného účtu zůstává bezpečný katalogový default.
  if (candidate.accountType != null) filled.accountType = candidate.accountType;
  return { ...patch, ...filled };
};

const optionalNumber = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Číselné hodnoty musí být nezáporná čísla.');
  return parsed;
};

const optionalInteger = (value: string): number | null => {
  const parsed = optionalNumber(value);
  if (parsed != null && !Number.isInteger(parsed)) throw new Error('Limity kontraktů musí být celá čísla.');
  return parsed;
};

export const profileFormToInput = (profile: ProfileForm): TradovateAccountProfileInput => ({
  ...profile,
  displayName: profile.displayName?.trim() || null,
  propFirm: profile.propFirm?.trim() || null,
  planName: profile.planName?.trim() || null,
  accountSize: optionalNumber(profile.accountSize),
  maxLoss: optionalNumber(profile.maxLoss),
  dailyLossLimit: optionalNumber(profile.dailyLossLimit),
  consistencyPct: optionalNumber(profile.consistencyPct),
  profitTarget: optionalNumber(profile.profitTarget),
  maxMini: optionalInteger(profile.maxMini),
  maxMicro: optionalInteger(profile.maxMicro),
});

/** Firmy z katalogu v pevném pořadí — nabídka u účtu bez rozpoznané propky. */
export const SETUP_PROP_FIRMS: readonly string[] = Array.from(new Set(TRADOVATE_PROP_PLAN_PRESETS.map(preset => preset.propFirm)));

export const UNKNOWN_FIRM = '';

const firmKey = (firm: string | null | undefined) => (firm ?? '').trim();

/** Skupiny podle propky v pořadí prvního výskytu; účty bez firmy až na konci. */
export const groupProfilesByFirm = <T extends Pick<ProfileForm, 'propFirm'>>(rows: readonly T[]): Array<{ firm: string; rows: T[] }> => {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = firmKey(row.propFirm);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const ordered = [...groups.entries()].filter(([firm]) => firm !== UNKNOWN_FIRM);
  if (groups.has(UNKNOWN_FIRM)) ordered.push([UNKNOWN_FIRM, groups.get(UNKNOWN_FIRM)!]);
  return ordered.map(([firm, items]) => ({ firm, rows: items }));
};

export interface PlanOption { value: string; legacy: boolean }

/** Plány dané propky bez duplicit; ukončené plány zvlášť (starší účty). */
export const planOptionsForFirm = (firm: string | null | undefined): PlanOption[] => {
  const wanted = firmKey(firm).toLowerCase();
  if (!wanted) return [];
  const seen = new Set<string>();
  const options: PlanOption[] = [];
  for (const preset of TRADOVATE_PROP_PLAN_PRESETS) {
    if (preset.propFirm.toLowerCase() !== wanted || seen.has(preset.planName)) continue;
    seen.add(preset.planName);
    options.push({ value: preset.planName, legacy: !!preset.discontinued });
  }
  // Katalog je seřazený po velikostech napříč rodinami; v nabídce mají být
  // pohromadě všechny velikosti jedné rodiny (LucidFlex 25K, 50K, …).
  const family = (name: string) => name.replace(/\s*\d+\s*K$/i, '');
  const size = (name: string) => Number(name.match(/(\d+)\s*K$/i)?.[1] ?? 0);
  const familyOrder = [...new Set(options.map(option => family(option.value)))];
  return options.sort((a, b) =>
    familyOrder.indexOf(family(a.value)) - familyOrder.indexOf(family(b.value)) || size(a.value) - size(b.value));
};

const filled = (value: string) => value.trim() !== '' && Number(value.replace(',', '.')) > 0;

/**
 * Co účtu chybí do dokončeného plánu — stejná kritéria jako upozornění
 * v LIVE (`tradovateAccountProfileNeedsPlan`), jen řečená konkrétně.
 */
export const profileSetupMissing = (row: ProfileForm): string | null => {
  if (!firmKey(row.propFirm)) return 'Chybí propka';
  if (!row.planName?.trim()) return 'Chybí plán';
  if (!row.accountType) return 'Chybí fáze';
  if (!filled(row.accountSize) || !row.drawdownType || (row.drawdownType !== 'none' && !filled(row.maxLoss))) return 'Chybí limity';
  return null;
};

const money = (value: string): string | null => {
  if (!filled(value)) return null;
  return `$${Math.round(Number(value.replace(',', '.'))).toLocaleString('cs-CZ')}`;
};

const DRAWDOWN_LABEL: Record<TradovateProfileDrawdownType, string> = {
  trailing: 'trailing', eod_trailing: 'EOD trailing', static: 'static', none: 'bez drawdownu',
};

/** Dva řádky přehledu: hlavní limity a doplňky. Cíl jen pro Evaluation. */
export const profileRuleSummary = (row: ProfileForm): { main: string; extra: string } | null => {
  const mll = money(row.maxLoss);
  const size = filled(row.accountSize) ? `${Math.round(Number(row.accountSize) / 1000)}K` : null;
  if (!mll && !size) return null;
  const evaluation = row.accountType == null || row.accountType === 'evaluation';
  const main = [
    `MLL ${mll ?? '—'}`,
    `DLL ${money(row.dailyLossLimit) ?? '—'}`,
    evaluation && money(row.profitTarget) ? `cíl ${money(row.profitTarget)}` : null,
  ].filter(Boolean).join(' · ');
  const extra = [
    [size, row.drawdownType ? DRAWDOWN_LABEL[row.drawdownType] : null].filter(Boolean).join(' · ') || null,
    filled(row.consistencyPct) ? `konzistence ${row.consistencyPct.trim()} %` : null,
    filled(row.maxMini) || filled(row.maxMicro) ? `${row.maxMini.trim() || '—'} mini / ${row.maxMicro.trim() || '—'} micro` : null,
  ].filter(Boolean).join(' · ');
  return { main, extra };
};

export const PHASES: ReadonlyArray<{ value: TradovateProfileAccountType; short: string; label: string }> = [
  { value: 'evaluation', short: 'Eval', label: 'Evaluation' },
  { value: 'funded', short: 'Funded', label: 'Funded' },
  { value: 'live', short: 'Live', label: 'Live' },
];

/** Nejnovější datum ověření pravidel v katalogu, česky. */
export const catalogVerifiedLabel = (): string | null => {
  const latest = TRADOVATE_PROP_PLAN_PRESETS.map(preset => preset.verifiedAt).filter(Boolean).sort().pop();
  if (!latest) return null;
  const [y, m, d] = latest.split('-').map(Number);
  return y && m && d ? `${d}. ${m}. ${y}` : latest;
};
