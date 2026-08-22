import React, { useMemo, useState } from 'react';
import { Check, ExternalLink, Layers3, Loader2, Sparkles, X } from 'lucide-react';
import type { TradovatePreflightAccount } from '../services/tradovateOAuthConnection';
import { saveTradovateAccountProfiles } from '../services/tradovateOAuthConnection';
import type {
  TradovateAccountProfile,
  TradovateAccountProfileInput,
  TradovateProfileAccountType,
  TradovateProfileDrawdownType,
} from '../lib/tradovateAccountProfileTypes';
import {
  findTradovatePropPlanPreset,
  inferTradovatePropIdentity,
  LUCID_FLEX_SOURCE,
  TRADOVATE_PROP_PLAN_PRESETS,
  type TradovatePropPlanPreset,
} from '../lib/tradovatePropPlanCatalog';
import { FIRM_LOGOS } from '../utils/accountFirm';

type FormProfile = Omit<TradovateAccountProfileInput,
  'accountSize' | 'maxLoss' | 'dailyLossLimit' | 'consistencyPct' | 'profitTarget' | 'maxMini' | 'maxMicro'> & {
  accountSize: string;
  maxLoss: string;
  dailyLossLimit: string;
  consistencyPct: string;
  profitTarget: string;
  maxMini: string;
  maxMicro: string;
};

type BulkProfile = Omit<FormProfile, 'externalAccountId' | 'accountName' | 'displayName' | 'mappedAccountId'>;

const numberText = (value: number | null | undefined) => value == null ? '' : String(value);

const presetPatch = (preset: TradovatePropPlanPreset): Partial<FormProfile> => ({
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

const fillMissingFromPreset = (profile: FormProfile, preset: TradovatePropPlanPreset): FormProfile => ({
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

const fromAccount = (
  account: TradovatePreflightAccount,
  profile: TradovateAccountProfile | undefined,
): FormProfile => {
  const inferred = inferTradovatePropIdentity(account.name);
  const result: FormProfile = {
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
  const preset = findTradovatePropPlanPreset(result.propFirm, result.planName);
  return preset ? fillMissingFromPreset(result, preset) : result;
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

const toInput = (profile: FormProfile): TradovateAccountProfileInput => ({
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

const inputClass = 'h-9 min-w-[112px] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2.5 text-xs font-semibold text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-indigo-500';

const emptyBulk = (): BulkProfile => ({
  propFirm: null,
  planName: null,
  accountType: null,
  accountSize: '',
  drawdownType: null,
  maxLoss: '',
  dailyLossLimit: '',
  consistencyPct: '',
  profitTarget: '',
  maxMini: '',
  maxMicro: '',
});

const text = (value: string | null, setter: (value: string | null) => void, placeholder: string, list?: string) => (
  <input className={inputClass} value={value ?? ''} placeholder={placeholder} list={list} onChange={event => setter(event.target.value || null)} />
);

const PropFirmInput = ({ value, onChange }: { value: string | null; onChange: (value: string | null) => void }) => {
  const key = (value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const logo = FIRM_LOGOS[key];
  return <div className="relative">
    {logo ? <img src={logo} alt="" className="pointer-events-none absolute left-2 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full border border-black/10 bg-white object-cover" /> : null}
    <input className={`${inputClass} ${logo ? 'pl-8' : ''}`} value={value ?? ''} placeholder="Tradeify nebo Lucid" list="tradovate-prop-firms" onChange={event => onChange(event.target.value || null)} />
  </div>;
};

const numberInput = (value: string, setter: (value: string) => void, placeholder = '0') => (
  <input className={inputClass} inputMode="decimal" value={value} placeholder={placeholder} onChange={event => setter(event.target.value)} />
);

const ProfileRow = ({
  profile,
  onChange,
  accountLabel,
  accountId,
  bulkAction,
}: {
  profile: FormProfile | BulkProfile;
  onChange: (patch: Partial<FormProfile>) => void;
  accountLabel: string;
  accountId?: string;
  bulkAction?: () => void;
}) => {
  const changeIdentity = (patch: Pick<Partial<FormProfile>, 'propFirm' | 'planName'>) => {
    const candidate = { ...profile, ...patch };
    const preset = findTradovatePropPlanPreset(candidate.propFirm, candidate.planName);
    onChange(preset ? { ...patch, ...presetPatch(preset) } : patch);
  };

  return (
  <div className={`grid min-w-[2100px] grid-cols-[210px_190px_150px_150px_140px_120px_150px_120px_120px_120px_120px_100px_100px] items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 text-xs last:border-0 ${bulkAction ? 'bg-indigo-500/[0.055]' : 'bg-[var(--bg-card)]'}`}>
    <div className="min-w-0">
      <div className="truncate font-black text-[var(--text-primary)]">{accountLabel}</div>
      {accountId ? <div className="mt-0.5 font-mono text-[9px] text-[var(--text-secondary)]">ID {accountId}</div> : <button type="button" onClick={bulkAction} className="mt-1 h-7 rounded-md bg-indigo-600 px-2.5 text-[9px] font-black uppercase text-white">Použít na všechny</button>}
    </div>
    {'displayName' in profile ? text(profile.displayName, displayName => onChange({ displayName }), 'Vlastní název') : <span className="text-[10px] text-[var(--text-secondary)]">Ponechá individuální názvy</span>}
    <PropFirmInput value={profile.propFirm} onChange={propFirm => changeIdentity({ propFirm })} />
    {text(profile.planName, planName => changeIdentity({ planName }), 'Growth 50K / LucidFlex 50K', 'tradovate-prop-plans')}
    <label>
      <span className="sr-only">Typ účtu</span>
      <select className={inputClass} value={profile.accountType ?? ''} onChange={event => onChange({ accountType: (event.target.value || null) as TradovateProfileAccountType | null })}>
        <option value="">Nenastaveno</option><option value="evaluation">Evaluation</option><option value="funded">Funded</option><option value="live">Live</option>
      </select>
    </label>
    {numberInput(profile.accountSize, accountSize => onChange({ accountSize }), '50000')}
    <label>
      <span className="sr-only">Drawdown</span>
      <select className={inputClass} value={profile.drawdownType ?? ''} onChange={event => onChange({ drawdownType: (event.target.value || null) as TradovateProfileDrawdownType | null })}>
        <option value="">Nenastaveno</option><option value="trailing">Trailing</option><option value="eod_trailing">EOD Trailing</option><option value="static">Static</option><option value="none">None</option>
      </select>
    </label>
    {numberInput(profile.maxLoss, maxLoss => onChange({ maxLoss }))}
    {numberInput(profile.dailyLossLimit, dailyLossLimit => onChange({ dailyLossLimit }))}
    {numberInput(profile.consistencyPct, consistencyPct => onChange({ consistencyPct }))}
    {numberInput(profile.profitTarget, profitTarget => onChange({ profitTarget }))}
    {numberInput(profile.maxMini, maxMini => onChange({ maxMini }))}
    {numberInput(profile.maxMicro, maxMicro => onChange({ maxMicro }))}
  </div>
  );
};

export default function TradovateAccountProfileSetup({
  accounts,
  profiles,
  onClose,
  onSaved,
}: {
  accounts: TradovatePreflightAccount[];
  profiles: TradovateAccountProfile[];
  onClose: () => void;
  onSaved: (profiles: TradovateAccountProfile[]) => void;
}) {
  const existing = useMemo(() => new Map(profiles.map(profile => [profile.externalAccountId, profile])), [profiles]);
  const [rows, setRows] = useState<FormProfile[]>(() => accounts.map(account => fromAccount(account, existing.get(String(account.id)))));
  const [bulk, setBulk] = useState<BulkProfile>(emptyBulk);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patchRow = (externalAccountId: string, patch: Partial<FormProfile>) => {
    setRows(current => current.map(row => row.externalAccountId === externalAccountId ? { ...row, ...patch } : row));
  };

  const applyBulk = () => {
    const entries = Object.entries(bulk).filter(([, value]) => value != null && value !== '');
    if (entries.length === 0) return;
    const patch = Object.fromEntries(entries) as Partial<FormProfile>;
    setRows(current => current.map(row => ({ ...row, ...patch })));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await saveTradovateAccountProfiles(rows.map(toInput));
      onSaved(result.profiles);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Profily účtů se nepodařilo uložit.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-slate-950/55 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Nastavení Tradovate účtů">
      <section className="max-h-[94vh] w-full max-w-[1500px] overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-primary)] shadow-2xl">
        <datalist id="tradovate-prop-firms"><option value="Tradeify" /><option value="Lucid" /></datalist>
        <datalist id="tradovate-prop-plans">{TRADOVATE_PROP_PLAN_PRESETS.map(preset => <option key={`${preset.propFirm}-${preset.planName}`} value={preset.planName} />)}</datalist>
        <header className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] px-5 py-4">
          <div>
            <div className="flex items-center gap-2 text-[var(--text-primary)]"><Layers3 size={18} className="text-indigo-500" /><h2 className="text-base font-black">Nastavit detekované účty</h2></div>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">Hodnoty se vážou na stabilní Tradovate ID a zůstanou uložené i po odpojení OAuth.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-card)]" aria-label="Zavřít"><X size={18} /></button>
        </header>

        <div className="max-h-[calc(94vh-145px)] overflow-y-auto bg-[var(--bg-page)] p-5">
          <p className="mb-3 text-xs text-[var(--text-secondary)]">Každý účet je jeden řádek. Společný řádek vyplň jen tam, kde chceš hodnotu propsat do všech {rows.length} účtů.</p>
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.06] px-3 py-2.5 text-[11px] leading-5 text-[var(--text-secondary)]">
            <Sparkles size={15} className="mt-0.5 shrink-0 text-indigo-500" />
            <span>Po zadání firmy a přesného plánu se pravidla automaticky doplní z oficiálního katalogu (ověřeno 18. 8. 2026). Podporujeme <b className="text-[var(--text-primary)]">Tradeify Growth/Select</b> a <b className="text-[var(--text-primary)]">LucidFlex, LucidPro, LucidDaily a legacy LucidBlack</b>. LucidDaily vyber včetně EOD/Intraday a DLL ON/OFF; aplikace tuto volbu záměrně nehádá. Hodnoty můžeš dál ručně upravit. <a className="inline-flex items-center gap-1 font-bold text-indigo-500 hover:underline" href={LUCID_FLEX_SOURCE} target="_blank" rel="noreferrer">Lucid zdroj <ExternalLink size={11} /></a></span>
          </div>
          <div className="overflow-x-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-sm">
            <div className="sticky top-0 z-10 grid min-w-[2100px] grid-cols-[210px_190px_150px_150px_140px_120px_150px_120px_120px_120px_120px_100px_100px] gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2.5 text-[9px] font-black uppercase tracking-[0.1em] text-[var(--text-secondary)]">
              <span>Account</span><span>Vlastní název</span><span>Prop firma</span><span>Plán</span><span>Typ účtu</span><span>Velikost</span><span>Drawdown</span><span>Max loss</span><span>Daily loss</span><span>Consistency %</span><span>Profit target</span><span>Max mini</span><span>Max micro</span>
            </div>
            <ProfileRow profile={bulk} accountLabel="Společné hodnoty" bulkAction={applyBulk} onChange={patch => setBulk(current => ({ ...current, ...patch }))} />
            {rows.map(row => <ProfileRow key={row.externalAccountId} profile={row} accountLabel={row.accountName} accountId={row.externalAccountId} onChange={patch => patchRow(row.externalAccountId, patch)} />)}
          </div>
          {error && <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-xs font-bold text-rose-500">{error}</div>}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-card)] px-5 py-3">
          <button type="button" onClick={onClose} disabled={saving} className="h-9 rounded-md border border-[var(--border-subtle)] px-4 text-xs font-black text-[var(--text-secondary)] disabled:opacity-50">Přeskočit</button>
          <button type="button" onClick={() => void save()} disabled={saving} className="flex h-9 items-center gap-2 rounded-md bg-indigo-600 px-4 text-xs font-black text-white disabled:opacity-50">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Uložit profily
          </button>
        </footer>
      </section>
    </div>
  );
}
