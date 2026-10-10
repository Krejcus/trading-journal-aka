import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, ChevronDown, ExternalLink, Loader2, X } from 'lucide-react';
import type { TradovatePreflightAccount } from '../services/tradovateOAuthConnection';
import { saveTradovateAccountProfiles } from '../services/tradovateOAuthConnection';
import type {
  TradovateAccountProfile,
  TradovateProfileAccountType,
  TradovateProfileDrawdownType,
} from '../lib/tradovateAccountProfileTypes';
import { LUCID_FLEX_SOURCE } from '../lib/tradovatePropPlanCatalog';
import { FUNDEDNEXT_FUTURES_SOURCE } from '../lib/fundedNextPropPlans';
import {
  catalogVerifiedLabel,
  groupProfilesByFirm,
  identityPatch,
  PHASES,
  planOptionsForFirm,
  profileFormFromAccount,
  profileFormToInput,
  profileRuleSummary,
  profileSetupMissing,
  SETUP_PROP_FIRMS,
  type IdentityPatch,
  type ProfileForm,
} from '../lib/tradovateProfileSetup';
import { FIRM_LOGOS } from '../utils/accountFirm';

/*
 * Plány účtů: účty z Tradovate seskupené podle propky. Hromadné nastavení má
 * každá propka zvlášť (plán Lucidu se nesmí propsat do FundedNext), řádek
 * ukazuje plán, fázi a přehled pravidel; ruční čísla se rozbalí pod řádkem.
 */

const field = 'h-[30px] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2 text-[12.5px] font-medium text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-blue-500';

const firmLogo = (firm: string) => FIRM_LOGOS[firm.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')];

const countLabel = (count: number) => `${count} ${count === 1 ? 'účet' : count >= 2 && count <= 4 ? 'účty' : 'účtů'}`;

/** Přepínač fáze s jezdcem, který přejede na vybranou možnost. */
const PhaseSegment = ({ value, onChange, label }: {
  value: TradovateProfileAccountType | null | undefined;
  onChange: (value: TradovateProfileAccountType) => void;
  label: string;
}) => {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const seg = ref.current;
    const active = seg?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    if (!seg) return;
    seg.style.setProperty('--seg-o', active ? '1' : '0');
    if (active) {
      seg.style.setProperty('--seg-x', `${active.offsetLeft}px`);
      seg.style.setProperty('--seg-w', `${active.offsetWidth}px`);
    }
  }, [value]);
  return (
    <span ref={ref} className="aps-seg" role="group" aria-label={label}>
      {PHASES.map(phase => (
        <button
          key={phase.value}
          type="button"
          title={phase.label}
          aria-pressed={value === phase.value}
          onClick={() => onChange(phase.value)}
        >
          {phase.short}
        </button>
      ))}
    </span>
  );
};

const PlanSelect = ({ firm, value, onChange, label, className = '' }: {
  firm: string | null | undefined;
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  label: string;
  className?: string;
}) => {
  const options = planOptionsForFirm(firm);
  const current = value?.trim() || '';
  const custom = current && !options.some(option => option.value === current);
  const active = options.filter(option => !option.legacy);
  const legacy = options.filter(option => option.legacy);
  return (
    <select aria-label={label} className={`${field} ${className}`} value={current} onChange={event => onChange(event.target.value || null)}>
      <option value="">Vyber plán…</option>
      {custom ? <option value={current}>{current} · bez velikosti</option> : null}
      {active.map(option => <option key={option.value} value={option.value}>{option.value}</option>)}
      {legacy.length ? (
        <optgroup label="Starší účty">
          {legacy.map(option => <option key={option.value} value={option.value}>{option.value}</option>)}
        </optgroup>
      ) : null}
    </select>
  );
};

const FirmSelect = ({ value, onChange, className = '' }: { value: string | null | undefined; onChange: (value: string | null) => void; className?: string }) => (
  <select aria-label="Prop firma" className={`${field} ${className}`} value={value?.trim() || ''} onChange={event => onChange(event.target.value || null)}>
    <option value="">Vyber propku…</option>
    {SETUP_PROP_FIRMS.map(firm => <option key={firm} value={firm}>{firm}</option>)}
    {value?.trim() && !SETUP_PROP_FIRMS.includes(value.trim()) ? <option value={value.trim()}>{value.trim()}</option> : null}
  </select>
);

const NumberField = ({ label, value, onChange, wide = false }: { label: string; value: string; onChange: (value: string) => void; wide?: boolean }) => (
  <label className={`grid gap-1 text-[11.5px] font-medium text-[var(--text-secondary)] ${wide ? 'sm:col-span-2' : ''}`}>
    {label}
    <input className={`${field} w-full`} inputMode="decimal" value={value} placeholder="—" onChange={event => onChange(event.target.value)} />
  </label>
);

const ProfileEditor = ({ row, onChange, onIdentity }: {
  row: ProfileForm;
  onChange: (patch: Partial<ProfileForm>) => void;
  onIdentity: (patch: IdentityPatch) => void;
}) => (
  <>
    <div className="grid grid-cols-2 gap-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-input)] p-3 sm:grid-cols-4">
      <label className="grid gap-1 text-[11.5px] font-medium text-[var(--text-secondary)] sm:col-span-2">
        Vlastní název
        <input className={`${field} w-full`} value={row.displayName ?? ''} placeholder={row.accountName} onChange={event => onChange({ displayName: event.target.value || null })} />
      </label>
      <label className="grid gap-1 text-[11.5px] font-medium text-[var(--text-secondary)]">
        Prop firma
        <FirmSelect value={row.propFirm} onChange={propFirm => onIdentity({ propFirm, planName: null })} className="w-full" />
      </label>
      <NumberField label="Velikost účtu" value={row.accountSize} onChange={accountSize => onChange({ accountSize })} />
      <label className="grid gap-1 text-[11.5px] font-medium text-[var(--text-secondary)]">
        Drawdown
        <select className={`${field} w-full`} value={row.drawdownType ?? ''} onChange={event => onChange({ drawdownType: (event.target.value || null) as TradovateProfileDrawdownType | null })}>
          <option value="">Nenastaveno</option>
          <option value="eod_trailing">EOD trailing</option>
          <option value="trailing">Trailing</option>
          <option value="static">Static</option>
          <option value="none">Bez drawdownu</option>
        </select>
      </label>
      <NumberField label="Max loss (MLL)" value={row.maxLoss} onChange={maxLoss => onChange({ maxLoss })} />
      <NumberField label="Denní limit (DLL)" value={row.dailyLossLimit} onChange={dailyLossLimit => onChange({ dailyLossLimit })} />
      <NumberField label="Cíl zisku" value={row.profitTarget} onChange={profitTarget => onChange({ profitTarget })} />
      <NumberField label="Konzistence %" value={row.consistencyPct} onChange={consistencyPct => onChange({ consistencyPct })} />
      <NumberField label="Max mini" value={row.maxMini} onChange={maxMini => onChange({ maxMini })} />
      <NumberField label="Max micro" value={row.maxMicro} onChange={maxMicro => onChange({ maxMicro })} />
    </div>
    <p className="mx-0.5 mt-2 text-[11.5px] text-[var(--text-muted)]">
      Hodnoty předvyplnil plán. Uprav je, jen když ti propka přidělila jiné limity — reálný Live účet nastav podle přidělených limitů.
    </p>
  </>
);

const ProfileRow = ({ row, open, onToggle, onChange, onIdentity }: {
  row: ProfileForm;
  open: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<ProfileForm>) => void;
  onIdentity: (patch: IdentityPatch) => void;
}) => {
  const missing = profileSetupMissing(row);
  const summary = profileRuleSummary(row);
  const name = row.displayName?.trim() && row.displayName.trim() !== row.accountName ? row.displayName.trim() : null;
  const summaryKey = summary ? `${summary.main}|${summary.extra}` : missing ?? '';
  return (
    <>
      <div
        className={`aps-row hover:bg-[var(--bg-page)]${missing ? ' aps-warn' : ''}${open ? ' aps-open' : ''}`}
        data-profile-row={row.externalAccountId}
      >
        <div className="aps-cell-acc min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <b className="truncate text-[12.5px] font-semibold" title={row.accountName}>{name ?? row.accountName}</b>
            <span className="aps-dot" aria-hidden />
          </div>
          <div className="truncate font-mono text-[10.5px] text-[var(--text-muted)]">{name ? row.accountName : `ID ${row.externalAccountId}`}</div>
        </div>
        <div className="aps-cell-plan min-w-0">
          {row.propFirm?.trim()
            ? <PlanSelect firm={row.propFirm} value={row.planName} label={`Plán účtu ${row.accountName}`} onChange={planName => onIdentity({ planName })} className="w-full min-w-0" />
            : <FirmSelect value={row.propFirm} onChange={propFirm => onIdentity({ propFirm, planName: null })} className="w-full min-w-0" />}
        </div>
        <div className="aps-cell-phase">
          <PhaseSegment value={row.accountType} label={`Fáze účtu ${row.accountName}`} onChange={accountType => onIdentity({ accountType })} />
        </div>
        <div key={summaryKey} className="aps-swap aps-cell-rules min-w-0 tabular-nums">
          {summary ? (
            <>
              <div className="truncate text-[12.5px] font-semibold text-[var(--text-primary)]">{summary.main}</div>
              {summary.extra ? <div className="truncate text-[11.5px] text-[var(--text-muted)]">{summary.extra}</div> : null}
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold aps-warn-text">
              <AlertTriangle size={13} /> {missing === 'Chybí propka' ? 'Vyber propku' : row.planName?.trim() ? 'Vyber plán s velikostí — pravidla se doplní' : 'Vyber plán — pravidla se doplní'}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          title={open ? 'Sbalit' : 'Upravit hodnoty'}
          className="aps-chev aps-cell-chev grid h-7 w-7 place-items-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)]"
        >
          <ChevronDown size={15} />
        </button>
      </div>
      <div className={`aps-edit${open ? ' aps-edit-open' : ''}`}>
        <div>
          <div className="aps-edit-in">
            <ProfileEditor row={row} onChange={onChange} onIdentity={onIdentity} />
          </div>
        </div>
      </div>
    </>
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
  const [rows, setRows] = useState<ProfileForm[]>(() => accounts.map(account => profileFormFromAccount(account, existing.get(String(account.id)))));
  const [bulk, setBulk] = useState<Record<string, IdentityPatch>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ ids: string[]; n: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => groupProfilesByFirm(rows), [rows]);
  const todo = rows.filter(row => profileSetupMissing(row)).length;
  const verified = catalogVerifiedLabel();

  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose, saving]);

  // Po hromadném použití řádky propky postupně bliknou — vidět, kam se hodnoty propsaly.
  useEffect(() => {
    if (!flash) return;
    flash.ids.forEach((id, index) => {
      const el = bodyRef.current?.querySelector<HTMLElement>(`[data-profile-row="${CSS.escape(id)}"]`);
      if (!el) return;
      el.style.setProperty('--aps-delay', `${index * 0.06}s`);
      el.classList.remove('aps-flash');
      void el.offsetWidth;
      el.classList.add('aps-flash');
    });
  }, [flash]);

  const patchRow = (id: string, patch: Partial<ProfileForm>) => {
    setRows(current => current.map(row => row.externalAccountId === id ? { ...row, ...patch } : row));
  };
  const patchIdentity = (id: string, patch: IdentityPatch) => {
    setRows(current => current.map(row => row.externalAccountId === id ? { ...row, ...identityPatch(row, patch) } : row));
  };

  const applyBulk = (firm: string) => {
    const choice = bulk[firm];
    if (!choice?.planName && !choice?.accountType) return;
    const patch: IdentityPatch = {};
    if (choice.planName) patch.planName = choice.planName;
    if (choice.accountType) patch.accountType = choice.accountType;
    const ids = rows.filter(row => (row.propFirm ?? '').trim() === firm).map(row => row.externalAccountId);
    setRows(current => current.map(row => ids.includes(row.externalAccountId) ? { ...row, ...identityPatch(row, patch) } : row));
    setFlash(previous => ({ ids, n: (previous?.n ?? 0) + 1 }));
  };

  const toggle = (id: string) => setOpen(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await saveTradovateAccountProfiles(rows.map(profileFormToInput));
      onSaved(result.profiles);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Profily účtů se nepodařilo uložit.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-slate-900/20 p-3 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="Plány účtů"
      onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose(); }}
    >
      <section className="glass-modal aps-modal flex max-h-[92vh] w-full max-w-[1000px] flex-col overflow-hidden text-[var(--text-primary)]">
        <header className="flex items-start gap-3 border-b border-[var(--border-subtle)] px-[18px] pb-3.5 pt-4">
          <div className="min-w-0">
            <h2 className="text-base font-bold">Plány účtů</h2>
            <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
              {countLabel(rows.length)} z Tradovate · plán určuje pravidla pro Risk, LIVE a kopírku. Uloží se k Tradovate ID, takže vydrží i odpojení.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="ml-auto grid h-[30px] w-[30px] shrink-0 place-items-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-page)]" aria-label="Zavřít">
            <X size={16} />
          </button>
        </header>

        <div ref={bodyRef} className="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-[18px] pb-[18px] pt-3.5">
          {groups.map((group, groupIndex) => {
            const logo = group.firm ? firmLogo(group.firm) : null;
            const choice = bulk[group.firm] ?? {};
            return (
              <section
                key={group.firm || 'unknown'}
                className="aps-firm flex-none overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)]"
                style={{ animationDelay: `${groupIndex * 0.05}s` }}
              >
                <div className="flex flex-wrap items-center gap-2.5 border-b border-[var(--border-subtle)] px-3 py-2.5">
                  {logo ? <img src={logo} alt="" className="h-6 w-6 shrink-0 rounded-full border border-black/10 bg-white object-cover" /> : null}
                  <b className="text-sm font-bold">{group.firm || 'Bez propky'}</b>
                  <span className="text-xs text-[var(--text-muted)]">{countLabel(group.rows.length)}</span>
                  {group.firm ? (
                    <div className="flex w-full flex-wrap items-center gap-1.5 md:ml-auto md:w-auto">
                      <span className="text-xs text-[var(--text-secondary)]">Všem v {group.firm}:</span>
                      <PlanSelect
                        firm={group.firm}
                        value={choice.planName}
                        label={`Plán pro všechny účty ${group.firm}`}
                        onChange={planName => setBulk(current => ({ ...current, [group.firm]: { ...current[group.firm], planName } }))}
                        className="max-w-[220px]"
                      />
                      <PhaseSegment
                        value={choice.accountType}
                        label={`Fáze pro všechny účty ${group.firm}`}
                        onChange={accountType => setBulk(current => ({ ...current, [group.firm]: { ...current[group.firm], accountType } }))}
                      />
                      <button
                        type="button"
                        onClick={() => applyBulk(group.firm)}
                        disabled={!choice.planName && !choice.accountType}
                        className="inline-flex h-[30px] items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2.5 text-[12.5px] font-semibold hover:bg-[var(--bg-page)] disabled:opacity-45"
                      >
                        <ArrowRight size={13} /> Použít
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs text-[var(--text-secondary)] md:ml-auto">Appka propku z názvu nepoznala — vyber ji u účtu.</span>
                  )}
                </div>
                <div className="aps-rows">
                  {group.rows.map(row => (
                    <ProfileRow
                      key={row.externalAccountId}
                      row={row}
                      open={open.has(row.externalAccountId)}
                      onToggle={() => toggle(row.externalAccountId)}
                      onChange={patch => patchRow(row.externalAccountId, patch)}
                      onIdentity={patch => patchIdentity(row.externalAccountId, patch)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
          {error ? <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-xs font-semibold text-rose-500">{error}</div> : null}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] px-[18px] py-3">
          <span className="text-[11.5px] text-[var(--text-muted)]">
            {verified ? `Pravidla z plánů ověřena ${verified} · ` : ''}
            <a className="inline-flex items-center gap-0.5 font-semibold text-blue-500 hover:underline" href={LUCID_FLEX_SOURCE} target="_blank" rel="noreferrer">Lucid <ExternalLink size={10} /></a>
            {' · '}
            <a className="inline-flex items-center gap-0.5 font-semibold text-blue-500 hover:underline" href={FUNDEDNEXT_FUTURES_SOURCE} target="_blank" rel="noreferrer">FundedNext <ExternalLink size={10} /></a>
          </span>
          <span className="flex-1" />
          <span key={todo} className={`aps-bump inline-flex items-center gap-1.5 text-xs font-semibold ${todo ? 'aps-warn-text' : 'aps-ok-text'}`}>
            {todo ? <AlertTriangle size={13} /> : <Check size={13} />}
            {todo ? `${countLabel(todo)} bez plánu nebo fáze` : 'Všechny účty mají plán'}
          </span>
          <button type="button" onClick={onClose} disabled={saving} className="h-[30px] rounded-md px-3 text-[12.5px] font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-page)] disabled:opacity-50">Později</button>
          <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex h-[30px] items-center gap-1.5 rounded-md bg-blue-600 px-3.5 text-[12.5px] font-semibold text-white hover:bg-blue-500 disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Uložit
          </button>
        </footer>
      </section>
    </div>
  );
}
