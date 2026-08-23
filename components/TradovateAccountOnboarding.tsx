import React, { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Sparkles } from 'lucide-react';
import type { TradovateAccountProfile, TradovateProfileAccountType } from '../lib/tradovateAccountProfileTypes';
import {
  applyTradovateOnboardingBulk,
  createTradovateAccountOnboardingDraft,
  findTradovateOnboardingPlanPreset,
  getNewTradovateAccountProfiles,
  planTradovateAccountOnboardingSave,
  tradovateOnboardingPlanPresetKey,
  type TradovateAccountOnboardingDraft,
} from '../lib/tradovateAccountOnboarding';
import { TRADOVATE_PROP_PLAN_PRESETS } from '../lib/tradovatePropPlanCatalog';
import { saveTradovateAccountProfiles } from '../services/tradovateOAuthConnection';
import { saveFirmPayoutRules } from '../services/firmPayoutRules';

const inputClass = 'h-9 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2.5 text-xs font-semibold text-[var(--text-primary)] outline-none focus:border-indigo-500';

const accountTypeLabel: Record<TradovateProfileAccountType, string> = {
  evaluation: 'Evaluace',
  funded: 'Funded',
  live: 'Live',
};

const firmValue = (value: string, firms: readonly string[]) =>
  firms.find(firm => firm.toUpperCase() === value.trim().toUpperCase()) ?? '__new__';

const usd = new Intl.NumberFormat('cs-CZ', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const drawdownLabel = {
  trailing: 'Trailing',
  eod_trailing: 'EOD trailing',
  static: 'Static',
  none: 'Bez drawdownu',
} as const;

const PlanDetails = ({ presetKey }: { presetKey: string | null }) => {
  const preset = findTradovateOnboardingPlanPreset(presetKey);
  if (!preset) return null;
  return <p className="mt-1 text-[9px] font-semibold leading-4 text-[var(--text-secondary)]">
    {usd.format(preset.accountSize)} · max loss {usd.format(preset.maxLoss)} · {drawdownLabel[preset.drawdownType]}
  </p>;
};

const PlanSelect = ({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
}) => <div>
  <select className={inputClass} value={value ?? ''} onChange={event => onChange(event.target.value || null)}>
    <option value="">Bez plánu</option>
    {TRADOVATE_PROP_PLAN_PRESETS.map(preset => {
      const key = tradovateOnboardingPlanPresetKey(preset);
      return <option key={key} value={key}>{preset.propFirm} · {preset.planName}</option>;
    })}
  </select>
  <PlanDetails presetKey={value} />
</div>;

const FirmField = ({
  value,
  firms,
  onChange,
}: {
  value: string;
  firms: readonly string[];
  onChange: (value: string) => void;
}) => {
  const selected = firmValue(value, firms);
  return <div className="space-y-1">
    <select className={inputClass} value={selected} onChange={event => onChange(event.target.value === '__new__' ? '' : event.target.value)}>
      {firms.map(firm => <option key={firm} value={firm}>{firm}</option>)}
      <option value="__new__">Nová…</option>
    </select>
    {selected === '__new__' && <input className={inputClass} value={value} placeholder="Název nové firmy" onChange={event => onChange(event.target.value)} />}
  </div>;
};

export default function TradovateAccountOnboarding({
  profiles,
  firms,
  onProfilesSaved,
  onRulesSaved,
}: {
  profiles: TradovateAccountProfile[];
  firms: string[];
  onProfilesSaved: (profiles: TradovateAccountProfile[]) => void;
  onRulesSaved: (entries: Array<{ firmKey: string; rules: Awaited<ReturnType<typeof saveFirmPayoutRules>> }>) => void;
}) {
  const newProfiles = useMemo(() => getNewTradovateAccountProfiles(profiles), [profiles]);
  const [drafts, setDrafts] = useState<TradovateAccountOnboardingDraft[]>(() => newProfiles.map(createTradovateAccountOnboardingDraft));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(newProfiles.map(profile => profile.id)));
  const [bulkFirm, setBulkFirm] = useState(() => drafts[0]?.propFirm ?? firms[0] ?? '');
  const [bulkType, setBulkType] = useState<TradovateProfileAccountType>(() => drafts[0]?.accountType ?? 'evaluation');
  const [bulkPlanPresetKey, setBulkPlanPresetKey] = useState<string | null>(() => drafts[0]?.planPresetKey ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signature = newProfiles.map(profile => `${profile.id}:${profile.updatedAt}`).join('|');
  useEffect(() => {
    const next = newProfiles.map(createTradovateAccountOnboardingDraft);
    setDrafts(next);
    setSelectedIds(new Set(next.map(draft => draft.profileId)));
    if (next[0]) {
      setBulkFirm(next[0].propFirm);
      setBulkType(next[0].accountType);
      setBulkPlanPresetKey(next[0].planPresetKey);
    }
  // Stabilní podpis brání resetu rozepsaných polí při změně identity props.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const patchDraft = (profileId: string, patch: Partial<TradovateAccountOnboardingDraft>) => {
    setDrafts(current => current.map(draft => draft.profileId === profileId ? { ...draft, ...patch } : draft));
  };

  const toggleSelected = (profileId: string) => setSelectedIds(current => {
    const next = new Set(current);
    if (next.has(profileId)) next.delete(profileId); else next.add(profileId);
    return next;
  });

  const applyBulk = () => {
    setDrafts(current => applyTradovateOnboardingBulk(current, selectedIds, {
      propFirm: bulkFirm,
      accountType: bulkType,
      planPresetKey: bulkPlanPresetKey,
    }));
  };

  const changeBulkPlan = (planPresetKey: string | null) => {
    setBulkPlanPresetKey(planPresetKey);
    const preset = findTradovateOnboardingPlanPreset(planPresetKey);
    if (preset) {
      setBulkFirm(preset.propFirm);
      setBulkType(preset.accountType);
    }
  };

  const changeDraftPlan = (profileId: string, planPresetKey: string | null) => {
    const preset = findTradovateOnboardingPlanPreset(planPresetKey);
    patchDraft(profileId, {
      planPresetKey,
      ...(preset ? { propFirm: preset.propFirm, accountType: preset.accountType } : {}),
    });
  };

  const confirm = async () => {
    setSaving(true);
    setError(null);
    try {
      const plan = planTradovateAccountOnboardingSave({
        profiles,
        drafts,
        selectedProfileIds: selectedIds,
        onboardedAt: new Date().toISOString(),
      });
      // Pravidla ukládáme první; onboarded_at je až poslední potvrzovací krok.
      const savedRules = await Promise.all(plan.ruleWrites.map(async write => ({
        firmKey: write.firmKey,
        rules: await saveFirmPayoutRules(write.firmKey, write.rules),
      })));
      const result = await saveTradovateAccountProfiles(plan.profiles);
      onRulesSaved(savedRules);
      onProfilesSaved(result.profiles);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Onboarding účtů se nepodařilo uložit.');
    } finally {
      setSaving(false);
    }
  };

  if (newProfiles.length === 0) return null;
  const allSelected = selectedIds.size === newProfiles.length;

  return <section className="overflow-hidden rounded-xl border border-indigo-500/25 bg-[var(--bg-card)] shadow-sm">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-indigo-500/[0.06] px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="rounded-md bg-indigo-500/15 p-2 text-indigo-500"><Sparkles size={17} /></span>
        <div><h2 className="text-sm font-black text-[var(--text-primary)]">{newProfiles.length} nových účtů ke kontrole</h2><p className="text-[11px] text-[var(--text-secondary)]">Zkontroluj zařazení a potvrď jen vybrané účty.</p></div>
      </div>
      <button type="button" disabled={saving || selectedIds.size === 0} onClick={() => void confirm()} className="flex h-9 items-center gap-2 rounded-md bg-indigo-600 px-4 text-xs font-black text-white disabled:opacity-50">
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Potvrdit vybrané ({selectedIds.size})
      </button>
    </header>

    <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-page)] p-3">
      <div className="grid gap-2 md:grid-cols-[minmax(160px,1fr)_150px_minmax(210px,1fr)_auto]">
        <FirmField value={bulkFirm} firms={firms} onChange={value => {
          setBulkFirm(value);
          setBulkPlanPresetKey(null);
        }} />
        <select className={inputClass} value={bulkType} onChange={event => setBulkType(event.target.value as TradovateProfileAccountType)}>
          {Object.entries(accountTypeLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <PlanSelect value={bulkPlanPresetKey} onChange={changeBulkPlan} />
        <button type="button" disabled={selectedIds.size === 0 || !bulkFirm.trim()} onClick={applyBulk} className="h-9 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-4 text-[10px] font-black uppercase text-indigo-500 disabled:opacity-50">Použít pro vybrané</button>
      </div>
    </div>

    <div className="overflow-x-auto">
      <table className="w-full min-w-[1040px] text-left text-xs">
        <thead className="bg-[var(--bg-card)] text-[9px] font-black uppercase tracking-wider text-[var(--text-secondary)]"><tr>
          <th className="w-12 px-4 py-2"><input type="checkbox" aria-label="Vybrat všechny nové účty" checked={allSelected} onChange={() => setSelectedIds(allSelected ? new Set() : new Set(newProfiles.map(profile => profile.id)))} /></th>
          <th className="px-2 py-2">Jméno</th><th className="px-2 py-2">Firma</th><th className="px-2 py-2">Typ</th><th className="px-2 py-2">Plán</th>
        </tr></thead>
        <tbody>{drafts.map(draft => {
          const profile = newProfiles.find(candidate => candidate.id === draft.profileId);
          return <tr key={draft.profileId} className="border-t border-[var(--border-subtle)] align-top">
            <td className="px-4 py-3"><input type="checkbox" aria-label={`Vybrat ${draft.displayName}`} checked={selectedIds.has(draft.profileId)} onChange={() => toggleSelected(draft.profileId)} /></td>
            <td className="px-2 py-3"><input className={inputClass} value={draft.displayName} onChange={event => patchDraft(draft.profileId, { displayName: event.target.value })} /><p className="mt-1 truncate font-mono text-[9px] text-[var(--text-secondary)]">{profile?.accountName}</p></td>
            <td className="px-2 py-3"><FirmField value={draft.propFirm} firms={firms} onChange={propFirm => patchDraft(draft.profileId, { propFirm, planPresetKey: null })} /></td>
            <td className="px-2 py-3"><select className={inputClass} value={draft.accountType} onChange={event => patchDraft(draft.profileId, { accountType: event.target.value as TradovateProfileAccountType })}>{Object.entries(accountTypeLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td>
            <td className="px-2 py-3"><PlanSelect value={draft.planPresetKey} onChange={planPresetKey => changeDraftPlan(draft.profileId, planPresetKey)} /></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {error && <p className="border-t border-rose-500/20 bg-rose-500/10 px-4 py-3 text-xs font-bold text-rose-500">{error}</p>}
  </section>;
}
