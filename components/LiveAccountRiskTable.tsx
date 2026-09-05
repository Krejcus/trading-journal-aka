import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Lock, Save, ShieldCheck } from 'lucide-react';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import type { CopierAccountRiskSnapshot, CopierFollowerCut } from '../services/copierRuntimeController';
import type { LiveAccount } from '../services/tradecopiaLiveService';
import {
  type CopyFollowerConfig,
  type CopyFollowerCutAction,
  type CopyGroupConfig,
  validDailyLossCut,
} from '../services/liveCopyTrading';

export const ACCOUNT_RISK_FRESH_MS = 90_000;

const money = new Intl.NumberFormat('cs-CZ', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});
const time = new Intl.DateTimeFormat('cs-CZ', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Europe/Prague',
});

const signedMoney = (value: number) => `${value > 0 ? '+' : ''}${money.format(value)}`;
const clampPercent = (value: number) => Math.max(0, Math.min(100, value));
const numericAttribute = (value: number | undefined) => {
  if (value == null || !Number.isFinite(value)) return undefined;
  return String(Math.floor((value + Number.EPSILON) * 100) / 100);
};

export interface AccountRiskLimitDraft {
  dailyLossCutUsd: string;
  maxContracts: string;
  onCut: CopyFollowerCutAction;
}

export type AccountRiskLimitDrafts = Record<string, AccountRiskLimitDraft>;

export const accountRiskLimitDraftsFromGroup = (group: CopyGroupConfig | null): AccountRiskLimitDrafts => (
  Object.fromEntries((group?.followers ?? []).map(follower => [String(follower.accountId), {
    dailyLossCutUsd: follower.dailyLossCutUsd && follower.dailyLossCutUsd > 0
      ? String(follower.dailyLossCutUsd)
      : '',
    maxContracts: follower.maxContracts == null ? '' : String(follower.maxContracts),
    onCut: follower.onCut ?? 'close-copy',
  }]))
);

export const accountRiskSnapshotIsFresh = (
  snapshot: CopierAccountRiskSnapshot | undefined,
  now: number,
): snapshot is CopierAccountRiskSnapshot => (
  snapshot != null
  && !snapshot.error
  && Number.isFinite(snapshot.verifiedAt)
  && snapshot.verifiedAt > 0
  && snapshot.verifiedAt <= now
  && now - snapshot.verifiedAt < ACCOUNT_RISK_FRESH_MS
);

/**
 * Worker snapshot je pro Risk autoritativnější a průběžně čerstvější než
 * PWA broker read-model. Jakmile worker účet ve statusu zná, nesmí se jeho
 * stale/error/null hodnota potichu nahradit starší broker mapou.
 *
 * Prázdný worker feed je očekávaný při postupném nasazení Phase A; pouze tehdy
 * zachováme potvrzenou broker mapu jako kompatibilní fallback. Jakmile worker
 * vrací alespoň jeden účet, chybějící řádek je neověřený (nikoli bezpečná nula).
 */
export const verifiedAccountDailyPnl = ({
  workerRisk,
  workerRiskFeedAvailable,
  brokerPnl,
  brokerPending,
  now,
}: {
  workerRisk?: CopierAccountRiskSnapshot;
  workerRiskFeedAvailable: boolean;
  brokerPnl?: number | null;
  brokerPending: boolean;
  now: number;
}): number | null => {
  if (workerRiskFeedAvailable || workerRisk != null) {
    return accountRiskSnapshotIsFresh(workerRisk, now)
      && typeof workerRisk.realizedPnlUsd === 'number'
      && Number.isFinite(workerRisk.realizedPnlUsd)
      ? workerRisk.realizedPnlUsd
      : null;
  }
  return !brokerPending && typeof brokerPnl === 'number' && Number.isFinite(brokerPnl)
    ? brokerPnl
    : null;
};

const optionalDailyLossCut = (raw: string): { valid: boolean; value?: number } => {
  const value = raw.trim();
  if (value === '' || value === '0') return { valid: true };
  if (!/^(?:\d+|\d+\.\d{1,2}|\.\d{1,2})$/.test(value)) return { valid: false };
  const parsed = Number(value);
  return validDailyLossCut(parsed) ? { valid: true, value: parsed } : { valid: false };
};

const optionalMaxContracts = (raw: string): { valid: boolean; value?: number } => {
  const value = raw.trim();
  if (value === '') return { valid: true };
  if (!/^\d+$/.test(value)) return { valid: false };
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1
    ? { valid: true, value: parsed }
    : { valid: false };
};

export interface ValidateAccountRiskLimitsOptions {
  group: CopyGroupConfig | null;
  drafts: AccountRiskLimitDrafts;
  accountRisk?: readonly CopierAccountRiskSnapshot[];
  sessionArmedAt?: number;
  now?: number;
}

export interface AccountRiskLimitsValidation {
  followers: CopyFollowerConfig[] | null;
  errors: string[];
}

/**
 * UI preflight only. The worker remains authoritative and repeats all checks.
 * No partial follower array is returned when any row is invalid.
 */
export function validateAccountRiskLimits({
  group,
  drafts,
  accountRisk = [],
  sessionArmedAt = 0,
}: ValidateAccountRiskLimitsOptions): AccountRiskLimitsValidation {
  if (!group) return { followers: null, errors: ['Skupina není dostupná pro uložení limitů.'] };

  const riskById = new Map(accountRisk.map(snapshot => [snapshot.accountId, snapshot]));
  const errors: string[] = [];
  const followers = group.followers.map(follower => {
    const draft = drafts[String(follower.accountId)] ?? {
      dailyLossCutUsd: follower.dailyLossCutUsd == null ? '' : String(follower.dailyLossCutUsd),
      maxContracts: follower.maxContracts == null ? '' : String(follower.maxContracts),
      onCut: follower.onCut ?? 'close-copy',
    };
    const cut = optionalDailyLossCut(draft.dailyLossCutUsd);
    const maxContracts = optionalMaxContracts(draft.maxContracts);
    const accountLabel = `Účet ${follower.accountId}`;

    if (!cut.valid) {
      errors.push(`${accountLabel}: „Vypnout při“ musí být 0 nebo částka 0,01–1 000 000 USD, nejvýše se dvěma desetinnými místy.`);
    }
    if (!maxContracts.valid) {
      errors.push(`${accountLabel}: Max kontr. musí být celé číslo alespoň 1, nebo prázdné.`);
    }
    if (follower.accountId === group.leaderAccountId && cut.valid && cut.value != null) {
      errors.push(`${accountLabel}: leader nemůže mít limit „Vypnout při“; řídí ho Pravidla dne.`);
    }
    if (draft.onCut !== 'close-copy' && draft.onCut !== 'let-run') {
      errors.push(`${accountLabel}: Při dosažení musí být „Zavřít kopii“ nebo „Nechat dojet“.`);
    }

    const risk = riskById.get(follower.accountId);
    if (cut.valid && cut.value != null
      && risk?.propLimitUsd != null
      && Number.isFinite(risk.propLimitUsd)
      && cut.value > risk.propLimitUsd * 0.95 + Number.EPSILON) {
      errors.push(`${accountLabel}: „Vypnout při“ musí být nejvýše 95 % limitu propky (${money.format(risk.propLimitUsd * 0.95)}).`);
    }

    if (sessionArmedAt > 0 && cut.valid && maxContracts.valid) {
      const currentCut = follower.dailyLossCutUsd && follower.dailyLossCutUsd > 0
        ? follower.dailyLossCutUsd
        : undefined;
      const currentOnCut = follower.onCut ?? 'close-copy';
      if (currentCut != null && (cut.value == null || cut.value > currentCut)) {
        errors.push(`${accountLabel}: Pravidla jdou dnes jen zpřísnit — „Vypnout při“ nelze zvýšit ani vypnout.`);
      }
      if (follower.maxContracts != null
        && (maxContracts.value == null || maxContracts.value > follower.maxContracts)) {
        errors.push(`${accountLabel}: Pravidla jdou dnes jen zpřísnit — Max kontr. nelze zvýšit ani vypnout.`);
      }
      if (currentOnCut === 'close-copy' && draft.onCut === 'let-run') {
        errors.push(`${accountLabel}: Pravidla jdou dnes jen zpřísnit — akci nelze změnit na „Nechat dojet“.`);
      }
    }

    const {
      dailyLossCutUsd: _oldCut,
      maxContracts: _oldMaxContracts,
      onCut: _oldOnCut,
      ...stableFollower
    } = follower;
    return {
      ...stableFollower,
      ...(cut.valid && cut.value != null ? { dailyLossCutUsd: cut.value } : {}),
      ...(maxContracts.valid && maxContracts.value != null ? { maxContracts: maxContracts.value } : {}),
      onCut: draft.onCut,
    } as CopyFollowerConfig;
  });

  return errors.length > 0
    ? { followers: null, errors: [...new Set(errors)] }
    : { followers, errors: [] };
}

export async function submitAccountRiskLimits(
  options: ValidateAccountRiskLimitsOptions & {
    onSave?: (followers: CopyFollowerConfig[]) => Promise<void> | void;
  },
): Promise<CopyFollowerConfig[]> {
  const validation = validateAccountRiskLimits(options);
  if (!validation.followers) throw new Error(validation.errors.join(' '));
  if (!options.onSave) throw new Error('Worker není dostupný pro uložení limitů.');
  // Preserve the worker/relay error verbatim. The caller decides how to display it.
  await options.onSave(validation.followers);
  return validation.followers;
}

export interface LiveAccountRiskTableProps {
  group: CopyGroupConfig | null;
  accounts: LiveAccount[];
  accountProfiles?: TradovateAccountProfile[];
  accountRisk?: CopierAccountRiskSnapshot[];
  followerCuts?: CopierFollowerCut[];
  brokerDailyPnlByAccount?: Readonly<Record<string, number | null>>;
  brokerDailyPnlPending?: boolean;
  sessionArmedAt?: number;
  disabled?: boolean;
  now?: number;
  onSave?: (followers: CopyFollowerConfig[]) => Promise<void> | void;
}

interface AccountIdentity {
  name: string;
  firm: string;
  phase: string;
}

const accountIdentity = (
  accountId: number,
  accountsById: ReadonlyMap<number, LiveAccount>,
  profilesById: ReadonlyMap<number, TradovateAccountProfile>,
): AccountIdentity => {
  const account = accountsById.get(accountId);
  const profile = profilesById.get(accountId);
  const name = profile?.displayName?.trim()
    || account?.name?.trim()
    || profile?.accountName?.trim()
    || `Účet ${accountId}`;
  const firm = profile?.propFirm?.trim() || account?.firm?.trim() || 'Tradovate';
  const phase = [profile?.planName?.trim(), profile?.accountType ?? account?.phase]
    .filter((part): part is string => !!part)
    .join(' · ') || 'fáze nevyplněna';
  return { name, firm, phase };
};

const activeCutMap = (
  cuts: readonly CopierFollowerCut[],
  followerIds: ReadonlySet<number>,
  now: number,
) => new Map(cuts
  .filter(cut => followerIds.has(cut.accountId) && cut.until > now)
  .map(cut => [cut.accountId, cut]));

const Progress = ({ percent, tone, label }: {
  percent: number;
  tone: 'emerald' | 'amber' | 'rose' | 'muted';
  label: string;
}) => {
  const value = clampPercent(percent);
  const color = tone === 'rose' ? 'bg-rose-500'
    : tone === 'amber' ? 'bg-amber-500'
      : tone === 'muted' ? 'bg-[var(--text-muted)]'
        : 'bg-emerald-500';
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      data-progress-value={Math.round(value)}
      className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--border-subtle)]"
    >
      <span className={`block h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
    </div>
  );
};

const inputClass = 'h-7 w-[88px] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-right text-[11px] font-bold tabular-nums text-[var(--text-primary)] outline-none focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-45';
const selectClass = 'h-7 w-[116px] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-1.5 text-[10.5px] font-bold text-[var(--text-primary)] outline-none focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-45';
const cellClass = 'px-3 py-2 align-middle text-[11px]';

export const LiveAccountRiskTable = ({
  group,
  accounts,
  accountProfiles = [],
  accountRisk = [],
  followerCuts = [],
  brokerDailyPnlByAccount = {},
  brokerDailyPnlPending = false,
  sessionArmedAt = 0,
  disabled = false,
  now = Date.now(),
  onSave,
}: LiveAccountRiskTableProps) => {
  const groupKey = JSON.stringify([group?.id ?? null, group?.followers ?? [], sessionArmedAt > 0]);
  const appliedGroupKey = useRef(groupKey);
  const [drafts, setDrafts] = useState<AccountRiskLimitDrafts>(() => accountRiskLimitDraftsFromGroup(group));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (appliedGroupKey.current === groupKey) return;
    appliedGroupKey.current = groupKey;
    setDrafts(accountRiskLimitDraftsFromGroup(group));
    setErrors([]);
    setNotice(null);
  }, [group, groupKey]);

  const accountsById = useMemo(() => new Map(accounts.map(account => [account.id, account])), [accounts]);
  const profilesById = useMemo(() => new Map(accountProfiles.flatMap(profile => {
    const accountId = Number(profile.externalAccountId);
    return Number.isSafeInteger(accountId) ? [[accountId, profile] as const] : [];
  })), [accountProfiles]);
  const riskById = useMemo(() => new Map(accountRisk.map(snapshot => [snapshot.accountId, snapshot])), [accountRisk]);
  const followerIds = useMemo(() => new Set(group?.followers.map(follower => follower.accountId) ?? []), [group]);
  const cutsById = useMemo(() => activeCutMap(followerCuts, followerIds, now), [followerCuts, followerIds, now]);
  const tightenOnly = sessionArmedAt > 0;

  const setDraft = <K extends keyof AccountRiskLimitDraft>(
    accountId: number,
    key: K,
    value: AccountRiskLimitDraft[K],
  ) => {
    setDrafts(current => ({
      ...current,
      [String(accountId)]: {
        ...(current[String(accountId)] ?? { dailyLossCutUsd: '', maxContracts: '', onCut: 'close-copy' }),
        [key]: value,
      },
    }));
    setErrors([]);
    setNotice(null);
  };

  const save = async () => {
    setSaving(true);
    setErrors([]);
    setNotice(null);
    try {
      await submitAccountRiskLimits({
        group,
        drafts,
        accountRisk,
        sessionArmedAt,
        now,
        onSave,
      });
      // Do not update group/drafts optimistically. A fresh worker status owns the values.
      setNotice('Limity potvrdil worker.');
    } catch (reason) {
      setErrors([reason instanceof Error ? reason.message : String(reason)]);
    } finally {
      setSaving(false);
    }
  };

  const rows: Array<{ accountId: number; role: 'leader'; follower?: never } | { accountId: number; role: 'follower'; follower: CopyFollowerConfig }> = [];
  if (group?.leaderAccountId != null) rows.push({ accountId: group.leaderAccountId, role: 'leader' });
  for (const follower of group?.followers ?? []) rows.push({ accountId: follower.accountId, role: 'follower', follower });

  return (
    <section data-live-account-risk-table="true" className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-black text-[var(--text-primary)]">Účty a propky</h3>
          <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">Limity jsou per účet; vyřazení followera nezamyká skupinu.</p>
        </div>
        {tightenOnly ? (
          <span title="dnes jen zpřísnit" className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/[0.07] px-2 py-0.5 text-[10px] font-bold text-amber-600">
            <Lock size={11} /> jen zpřísnit
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void save()}
          disabled={disabled || saving || !group || !onSave}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-indigo-600 px-3 text-[11px] font-black text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Save size={12} /> {saving ? 'Ukládám…' : 'Uložit limity'}
        </button>
      </header>

      {cutsById.size > 0 ? (
        <div data-follower-cut-banner="true" className="flex items-start gap-2 border-b border-rose-500/25 bg-rose-500/[0.07] px-3 py-2 text-[11px] font-bold text-rose-500">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{cutsById.size === 1 ? '1 účet je vyřazen do konce session' : `${cutsById.size} účty jsou vyřazené do konce session`}: {[...cutsById.keys()].map(accountId => accountIdentity(accountId, accountsById, profilesById).name).join(', ')}</span>
        </div>
      ) : null}

      {errors.length > 0 ? (
        <div role="alert" className="border-b border-rose-500/25 bg-rose-500/[0.07] px-3 py-2 text-[11px] font-bold text-rose-500">
          {errors.map(error => <div key={error}>{error}</div>)}
          <div className="mt-0.5">Limity nebyly uloženy.</div>
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="flex items-center gap-2 border-b border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2 text-[11px] font-bold text-emerald-600">
          <CheckCircle2 size={13} /> {notice}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] border-collapse">
          <thead className="bg-[var(--bg-page)] text-left text-[9px] font-black uppercase tracking-[0.1em] text-[var(--text-secondary)]">
            <tr>
              <th data-risk-column="account" className="px-3 py-2">Účet</th>
              <th data-risk-column="prop" className="px-3 py-2">Propka</th>
              <th data-risk-column="prop-limit" className="px-3 py-2">Limit propky</th>
              <th data-risk-column="cut" className="px-3 py-2">Vypnout při</th>
              <th data-risk-column="contracts" className="px-3 py-2">Max kontr.</th>
              <th data-risk-column="pnl" className="px-3 py-2">Dnes vč. poplatků</th>
              <th data-risk-column="cut-action" className="px-3 py-2">Při dosažení</th>
              <th data-risk-column="status" className="px-3 py-2">Stav</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border-subtle)]">
            {rows.map(row => {
              const identity = accountIdentity(row.accountId, accountsById, profilesById);
              const risk = riskById.get(row.accountId);
              const riskFresh = accountRiskSnapshotIsFresh(risk, now);
              const propLimit = riskFresh && risk.propLimitUsd != null && Number.isFinite(risk.propLimitUsd)
                ? risk.propLimitUsd
                : null;
              const knownPropLimit = risk?.propLimitUsd != null && Number.isFinite(risk.propLimitUsd)
                ? risk.propLimitUsd
                : null;
              const brokerPnl = brokerDailyPnlByAccount[String(row.accountId)];
              const pnl = verifiedAccountDailyPnl({
                workerRisk: risk,
                workerRiskFeedAvailable: accountRisk.length > 0,
                brokerPnl,
                brokerPending: brokerDailyPnlPending,
                now,
              });
              const follower = row.role === 'follower' ? row.follower : null;
              const draft = follower ? (drafts[String(row.accountId)] ?? {
                dailyLossCutUsd: follower.dailyLossCutUsd == null ? '' : String(follower.dailyLossCutUsd),
                maxContracts: follower.maxContracts == null ? '' : String(follower.maxContracts),
                onCut: follower.onCut ?? 'close-copy',
              }) : null;
              const currentCut = follower?.dailyLossCutUsd && follower.dailyLossCutUsd > 0
                ? follower.dailyLossCutUsd
                : undefined;
              const draftCut = draft ? optionalDailyLossCut(draft.dailyLossCutUsd).value : undefined;
              const loss = pnl == null ? null : Math.max(0, -pnl);
              const progress = loss != null && draftCut != null ? (loss / draftCut) * 100 : 0;
              const cut = cutsById.get(row.accountId);
              const nearLimit = !cut && follower?.mode !== 'off' && currentCut != null && loss != null
                && loss / currentCut >= 0.8;
              const currentOnCut = follower?.onCut ?? 'close-copy';
              const propMax = knownPropLimit == null ? undefined : knownPropLimit * 0.95;
              const cutMax = tightenOnly && currentCut != null
                ? Math.min(currentCut, propMax ?? currentCut)
                : propMax;
              const maxContractsMax = tightenOnly && follower?.maxContracts != null
                ? follower.maxContracts
                : undefined;
              const tightenCutTitle = tightenOnly && currentCut != null ? 'dnes jen zpřísnit' : undefined;
              const tightenContractsTitle = tightenOnly && follower?.maxContracts != null ? 'dnes jen zpřísnit' : undefined;
              const tightenActionTitle = tightenOnly && currentOnCut === 'close-copy' ? 'dnes jen zpřísnit' : undefined;

              const setCut = (value: string) => {
                const parsed = optionalDailyLossCut(value);
                if (tightenOnly && currentCut != null
                  && (!parsed.valid || parsed.value == null || parsed.value > currentCut)) return;
                setDraft(row.accountId, 'dailyLossCutUsd', value);
              };
              const setMaxContracts = (value: string) => {
                const parsed = optionalMaxContracts(value);
                if (tightenOnly && follower?.maxContracts != null
                  && (!parsed.valid || parsed.value == null || parsed.value > follower.maxContracts)) return;
                setDraft(row.accountId, 'maxContracts', value);
              };

              const status = row.role === 'leader'
                ? { key: 'leader', title: 'Obchoduje pro leadera', detail: '', tone: 'text-indigo-500' }
                : cut
                  ? {
                    key: 'cut',
                    title: 'Vyřazen do konce session',
                    detail: `vypnout při ${money.format(cut.cutUsd)} · ${cut.closed === false
                      ? 'kopii se nepodařilo zavřít'
                      : typeof cut.closed === 'number'
                        ? `kopie zavřena ${time.format(cut.closed)}`
                        : 'stav otevřené kopie neověřen'}`,
                    tone: 'text-rose-500',
                  }
                  : follower?.mode === 'off'
                    ? { key: 'off', title: 'Nekopíruje', detail: '', tone: 'text-[var(--text-secondary)]' }
                    : nearLimit
                      ? { key: 'near', title: 'Kopíruje · blízko limitu', detail: `${Math.round((loss! / currentCut!) * 100)} % limitu`, tone: 'text-amber-500' }
                      : { key: 'copying', title: 'Kopíruje', detail: '', tone: 'text-emerald-500' };

              return (
                <tr key={`${row.role}-${row.accountId}`} data-account-id={row.accountId} data-account-risk-state={status.key}>
                  <td className={cellClass}>
                    <b className="block text-[var(--text-primary)]">{identity.name}</b>
                    <span className="block text-[9.5px] text-[var(--text-muted)]">ID {row.accountId} · {row.role}</span>
                  </td>
                  <td className={cellClass}>
                    <b className="block text-[var(--text-primary)]">{identity.firm}</b>
                    <span className="block text-[9.5px] text-[var(--text-muted)]">{identity.phase}</span>
                  </td>
                  <td className={cellClass}>
                    {propLimit != null ? (
                      <span className="inline-flex items-center gap-1.5 font-bold text-[var(--text-primary)]" title="Ověřeno workerem před méně než 90 s">
                        <ShieldCheck size={13} className="text-emerald-500" /> {money.format(propLimit)}
                      </span>
                    ) : (
                      <>
                        <span className="font-bold text-amber-500">neověřeno</span>
                        {risk?.error ? <span className="mt-0.5 block max-w-[180px] text-[9.5px] leading-3 text-amber-600">{risk.error}</span> : null}
                      </>
                    )}
                  </td>
                  <td className={cellClass}>
                    {draft ? (
                      <label className="inline-flex items-center gap-1" title={tightenCutTitle}>
                        <input
                          aria-label={`Vypnout při pro účet ${row.accountId}`}
                          type="number"
                          min="0.01"
                          max={numericAttribute(cutMax)}
                          step="0.01"
                          placeholder="vypnuto"
                          value={draft.dailyLossCutUsd}
                          disabled={disabled}
                          onChange={event => setCut(event.target.value)}
                          className={inputClass}
                        />
                        <span className="text-[9.5px] font-bold text-[var(--text-muted)]">USD</span>
                      </label>
                    ) : <span className="text-[var(--text-muted)]">—</span>}
                  </td>
                  <td className={cellClass}>
                    {draft ? (
                      <input
                        aria-label={`Max kontraktů pro účet ${row.accountId}`}
                        title={tightenContractsTitle}
                        type="number"
                        min="1"
                        max={maxContractsMax}
                        step="1"
                        placeholder="bez limitu"
                        value={draft.maxContracts}
                        disabled={disabled}
                        onChange={event => setMaxContracts(event.target.value)}
                        className={inputClass}
                      />
                    ) : <span className="text-[var(--text-muted)]">—</span>}
                  </td>
                  <td className={cellClass}>
                    <b className={`block tabular-nums ${pnl == null ? 'text-[var(--text-muted)]' : pnl < 0 ? 'text-rose-500' : pnl > 0 ? 'text-emerald-500' : 'text-[var(--text-primary)]'}`}>
                      {pnl == null ? 'neověřeno' : signedMoney(pnl)}
                    </b>
                    {draftCut != null && pnl != null ? (
                      <Progress
                        percent={progress}
                        tone={cut ? 'rose' : progress >= 80 ? 'amber' : 'emerald'}
                        label={`Využití limitu účtu ${row.accountId}`}
                      />
                    ) : null}
                  </td>
                  <td className={cellClass}>
                    {draft ? (
                      <select
                        aria-label={`Při dosažení limitu účtu ${row.accountId}`}
                        title={tightenActionTitle}
                        value={draft.onCut}
                        disabled={disabled}
                        onChange={event => setDraft(row.accountId, 'onCut', event.target.value as CopyFollowerCutAction)}
                        className={selectClass}
                      >
                        <option value="close-copy">Zavřít kopii</option>
                        <option value="let-run" disabled={tightenOnly && currentOnCut === 'close-copy'}>Nechat dojet</option>
                      </select>
                    ) : <span className="text-[var(--text-muted)]">—</span>}
                  </td>
                  <td className={cellClass}>
                    <b className={`block ${status.tone}`}>{status.title}</b>
                    {status.detail ? <span className="mt-0.5 block max-w-[220px] text-[9.5px] leading-3 text-[var(--text-muted)]">{status.detail}</span> : null}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-[11px] text-[var(--text-secondary)]">Skupina není dostupná.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default LiveAccountRiskTable;
