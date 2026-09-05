import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, Clock3, Lock, Save } from 'lucide-react';
import type { CopierControllerStatus } from '../services/copierRuntimeController';
import {
  DEFAULT_COPY_GROUP_SAFETY,
  type CopierRuleAction,
  type CopyGroupSafetySettings,
} from '../services/liveCopyTrading';

type DayLockTrigger = NonNullable<CopierControllerStatus['dayLockTrigger']>;

const PRAGUE_TIME_ZONE = 'Europe/Prague';
const time = new Intl.DateTimeFormat('cs-CZ', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: PRAGUE_TIME_ZONE,
});
const number = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 });

const TRIGGER_LABELS: Record<DayLockTrigger, string> = {
  manual: 'Ruční zámek dne',
  'daily-loss': 'Denní ztrátový limit',
  'losing-trades': 'Max ztrátových obchodů za den',
  'max-trades': 'Max obchodů za den',
  'window-end': 'Konec obchodního okna',
};

export interface DailyRulesDraft {
  losingTradesEnabled: boolean;
  dailyMaxLosingTrades: string;
  lossLimitEnabled: boolean;
  dailyLossLimitUsd: string;
  maxTradesEnabled: boolean;
  dailyMaxTrades: string;
  tradingWindowEnabled: boolean;
  tradingWindowFrom: string;
  tradingWindowTo: string;
  cooldownEnabled: boolean;
  entryCooldownMinutes: string;
  sessionExpiryEnabled: boolean;
  armExpiryFlatten: Exclude<CopyGroupSafetySettings['armExpiryFlatten'], 'off'>;
  losingTradesBeforeAction: CopierRuleAction['kind'] | null;
  losingTradesBeforeMinutes: string;
  losingTradesAtAction: CopierRuleAction['kind'] | null;
  losingTradesAtMinutes: string;
  dailyLoss80Action: CopierRuleAction['kind'] | null;
  dailyLoss80Minutes: string;
  dailyLossAtAction: CopierRuleAction['kind'] | null;
  dailyLossAtMinutes: string;
  maxTradesAtAction: CopierRuleAction['kind'] | null;
  maxTradesAtMinutes: string;
  windowEndAction: CopierRuleAction['kind'] | null;
  windowEndMinutes: string;
}

export interface DailyRulesValidationResult {
  safety: CopyGroupSafetySettings | null;
  errors: string[];
}

const actionKind = (action: CopierRuleAction | null): CopierRuleAction['kind'] | null => action?.kind ?? null;
const actionMinutes = (action: CopierRuleAction | null, fallback: number): string => (
  String(action?.kind === 'pause' ? action.minutes : fallback)
);

export const dailyRulesDraftFromSafety = (safety: CopyGroupSafetySettings): DailyRulesDraft => ({
  losingTradesEnabled: safety.dailyMaxLosingTrades > 0,
  dailyMaxLosingTrades: String(safety.dailyMaxLosingTrades || 2),
  lossLimitEnabled: safety.dailyLossLimitUsd > 0,
  dailyLossLimitUsd: String(safety.dailyLossLimitUsd || 1_000),
  maxTradesEnabled: safety.dailyMaxTrades > 0,
  dailyMaxTrades: String(safety.dailyMaxTrades || 10),
  tradingWindowEnabled: safety.tradingWindow.enabled,
  tradingWindowFrom: safety.tradingWindow.from,
  tradingWindowTo: safety.tradingWindow.to,
  cooldownEnabled: safety.entryCooldownMinutes > 0,
  entryCooldownMinutes: String(safety.entryCooldownMinutes || 15),
  sessionExpiryEnabled: safety.armExpiryFlatten !== 'off',
  armExpiryFlatten: safety.armExpiryFlatten === 'group' ? 'group' : 'followers',
  losingTradesBeforeAction: actionKind(safety.dayRuleActions.losingTrades.beforeLimit),
  losingTradesBeforeMinutes: actionMinutes(safety.dayRuleActions.losingTrades.beforeLimit, 20),
  losingTradesAtAction: actionKind(safety.dayRuleActions.losingTrades.atLimit),
  losingTradesAtMinutes: actionMinutes(safety.dayRuleActions.losingTrades.atLimit, 20),
  dailyLoss80Action: actionKind(safety.dayRuleActions.dailyLoss.at80Percent),
  dailyLoss80Minutes: actionMinutes(safety.dayRuleActions.dailyLoss.at80Percent, 30),
  dailyLossAtAction: actionKind(safety.dayRuleActions.dailyLoss.atLimit),
  dailyLossAtMinutes: actionMinutes(safety.dayRuleActions.dailyLoss.atLimit, 30),
  maxTradesAtAction: actionKind(safety.dayRuleActions.maxTrades.atLimit),
  maxTradesAtMinutes: actionMinutes(safety.dayRuleActions.maxTrades.atLimit, 30),
  windowEndAction: actionKind(safety.dayRuleActions.windowEnd.atEnd),
  windowEndMinutes: actionMinutes(safety.dayRuleActions.windowEnd.atEnd, 30),
});

const integerInRange = (value: string, minimum: number, maximum: number): number | null => {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
};

const decimalInRange = (value: string, minimum: number, maximum: number): number | null => {
  if (!/^(?:\d+|\d+\.\d{1,2}|\.\d{1,2})$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
};

const ruleActionFromDraft = (
  kind: CopierRuleAction['kind'] | null,
  minutes: string,
  label: string,
  errors: string[],
  allowNull = false,
): CopierRuleAction | null => {
  if (kind == null) {
    if (!allowNull) errors.push(`${label}: vyber pauzu nebo zámek dne.`);
    return null;
  }
  if (kind === 'lock') return { kind: 'lock' };
  const parsed = integerInRange(minutes, 1, 720);
  if (parsed == null) {
    errors.push(`${label}: pauza musí být celé číslo od 1 do 720 minut.`);
    return null;
  }
  return { kind: 'pause', minutes: parsed };
};

const clockMinutes = (value: string): number | null => {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
};

const weakerRuleAction = (previous: CopierRuleAction | null, next: CopierRuleAction | null): boolean => {
  if (previous == null) return false;
  if (next == null) return true;
  if (previous.kind === 'lock') return next.kind !== 'lock';
  return next.kind === 'pause' && next.minutes < previous.minutes;
};

/** Poslední UI preflight; worker/relay zůstává autoritativní druhá hranice. */
export const isWeakerDailyRulesSafety = (
  previous: CopyGroupSafetySettings,
  next: CopyGroupSafetySettings,
): boolean => {
  const upperBoundWeakened = (before: number, after: number) => before > 0 && (after === 0 || after > before);
  const previousFrom = clockMinutes(previous.tradingWindow.from);
  const previousTo = clockMinutes(previous.tradingWindow.to);
  const nextFrom = clockMinutes(next.tradingWindow.from);
  const nextTo = clockMinutes(next.tradingWindow.to);
  const expiryRank: Record<CopyGroupSafetySettings['armExpiryFlatten'], number> = {
    off: 0,
    followers: 1,
    group: 2,
  };

  return upperBoundWeakened(previous.dailyMaxLosingTrades, next.dailyMaxLosingTrades)
    || upperBoundWeakened(previous.dailyLossLimitUsd, next.dailyLossLimitUsd)
    || upperBoundWeakened(previous.dailyMaxTrades, next.dailyMaxTrades)
    || next.entryCooldownMinutes < previous.entryCooldownMinutes
    || (previous.tradingWindow.enabled && (
      !next.tradingWindow.enabled
      || (previousFrom != null && nextFrom != null && nextFrom < previousFrom)
      || (previousTo != null && nextTo != null && nextTo > previousTo)
    ))
    || expiryRank[next.armExpiryFlatten] < expiryRank[previous.armExpiryFlatten]
    || weakerRuleAction(previous.dayRuleActions.losingTrades.beforeLimit, next.dayRuleActions.losingTrades.beforeLimit)
    || weakerRuleAction(previous.dayRuleActions.losingTrades.atLimit, next.dayRuleActions.losingTrades.atLimit)
    || weakerRuleAction(previous.dayRuleActions.dailyLoss.at80Percent, next.dayRuleActions.dailyLoss.at80Percent)
    || weakerRuleAction(previous.dayRuleActions.dailyLoss.atLimit, next.dayRuleActions.dailyLoss.atLimit)
    || weakerRuleAction(previous.dayRuleActions.maxTrades.atLimit, next.dayRuleActions.maxTrades.atLimit)
    || weakerRuleAction(previous.dayRuleActions.windowEnd.atEnd, next.dayRuleActions.windowEnd.atEnd);
};

export function validateDailyRulesDraft(
  draft: DailyRulesDraft,
  baseSafety: CopyGroupSafetySettings,
): DailyRulesValidationResult {
  const errors: string[] = [];
  const dailyMaxLosingTrades = draft.losingTradesEnabled
    ? integerInRange(draft.dailyMaxLosingTrades, 1, 50)
    : 0;
  const dailyLossLimitUsd = draft.lossLimitEnabled
    ? decimalInRange(draft.dailyLossLimitUsd, 0.01, 1_000_000)
    : 0;
  const dailyMaxTrades = draft.maxTradesEnabled
    ? integerInRange(draft.dailyMaxTrades, 1, 200)
    : 0;
  const entryCooldownMinutes = draft.cooldownEnabled
    ? integerInRange(draft.entryCooldownMinutes, 1, 720)
    : 0;
  const fromMinutes = clockMinutes(draft.tradingWindowFrom);
  const toMinutes = clockMinutes(draft.tradingWindowTo);
  const losingBefore = ruleActionFromDraft(
    draft.losingTradesBeforeAction,
    draft.losingTradesBeforeMinutes,
    'Ztrátové obchody před limitem',
    errors,
    true,
  );
  const losingAt = ruleActionFromDraft(
    draft.losingTradesAtAction,
    draft.losingTradesAtMinutes,
    'Ztrátové obchody na limitu',
    errors,
  );
  const loss80 = ruleActionFromDraft(
    draft.dailyLoss80Action,
    draft.dailyLoss80Minutes,
    'Denní ztráta na 80 %',
    errors,
    true,
  );
  const lossAt = ruleActionFromDraft(
    draft.dailyLossAtAction,
    draft.dailyLossAtMinutes,
    'Denní ztráta na limitu',
    errors,
  );
  const tradesAt = ruleActionFromDraft(
    draft.maxTradesAtAction,
    draft.maxTradesAtMinutes,
    'Max obchodů',
    errors,
  );
  const windowEnd = ruleActionFromDraft(
    draft.windowEndAction,
    draft.windowEndMinutes,
    'Konec obchodního okna',
    errors,
  );

  if (dailyMaxLosingTrades == null) errors.push('Max ztrátových obchodů musí být celé číslo od 1 do 50.');
  if (dailyLossLimitUsd == null) errors.push('Denní ztrátový limit musí být číslo od 0,01 do 1 000 000 USD.');
  if (dailyMaxTrades == null) errors.push('Max obchodů za den musí být celé číslo od 1 do 200.');
  if (entryCooldownMinutes == null) errors.push('Cooldown musí být celé číslo od 1 do 720 minut.');
  if (fromMinutes == null || toMinutes == null) {
    errors.push('Obchodní okno musí používat platný čas HH:MM.');
  } else if (fromMinutes >= toMinutes) {
    errors.push('Začátek obchodního okna musí být před jeho koncem; okno přes půlnoc není podporované.');
  }

  if (errors.length > 0
    || dailyMaxLosingTrades == null
    || dailyLossLimitUsd == null
    || dailyMaxTrades == null
    || entryCooldownMinutes == null
    || losingAt == null
    || lossAt == null
    || tradesAt == null
    || windowEnd == null) {
    return { safety: null, errors };
  }

  return {
    safety: {
      ...baseSafety,
      dailyMaxLosingTrades,
      dailyLossLimitUsd,
      dailyMaxTrades,
      entryCooldownMinutes,
      tradingWindow: {
        enabled: draft.tradingWindowEnabled,
        from: draft.tradingWindowFrom,
        to: draft.tradingWindowTo,
        timeZone: PRAGUE_TIME_ZONE,
      },
      armExpiryFlatten: draft.sessionExpiryEnabled ? draft.armExpiryFlatten : 'off',
      dayRuleActions: {
        losingTrades: { beforeLimit: losingBefore, atLimit: losingAt },
        dailyLoss: { at80Percent: loss80, atLimit: lossAt },
        maxTrades: { atLimit: tradesAt },
        windowEnd: { atEnd: windowEnd },
      },
    },
    errors: [],
  };
}

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));
const progressPercent = (current: number, limit: number): number => (
  limit > 0 ? clampPercent((current / limit) * 100) : 0
);
const minuteOfDay = (at: number): number => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: PRAGUE_TIME_ZONE,
  }).formatToParts(at);
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
};
const duration = (milliseconds: number): string => {
  const totalMinutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
};

const TriggerPill = ({ count }: { count: number }) => (
  <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold ${count > 0
    ? 'border-rose-500/30 bg-rose-500/10 text-rose-500'
    : 'border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-600'}`}>
    <span className={`h-1.5 w-1.5 rounded-full ${count > 0 ? 'bg-rose-500' : 'bg-emerald-500'}`} />
    {count} {count === 1 ? 'zámek' : count > 1 && count < 5 ? 'zámky' : 'zámků'}
  </span>
);

const RuleToggle = ({ checked, label, disabled = false, title, onChange }: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  title?: string;
  onChange: (checked: boolean) => void;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={`${label}: ${checked ? 'zapnuto' : 'vypnuto'}`}
    disabled={disabled}
    title={title}
    onClick={() => onChange(!checked)}
    className={`relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${checked ? 'bg-emerald-500' : 'bg-[var(--border-subtle)] ring-1 ring-inset ring-white/10'}`}
  >
    <span className="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-[left] duration-150" style={{ left: checked ? 14 : 2 }} />
  </button>
);

type ProgressTone = 'emerald' | 'amber' | 'rose' | 'indigo' | 'muted';

const Progress = ({ value, tone = 'emerald', label }: {
  value: number | null;
  tone?: ProgressTone;
  label: string;
}) => {
  const known = value != null;
  const safeValue = known ? clampPercent(value) : 0;
  const color = tone === 'rose' ? 'bg-rose-500'
    : tone === 'amber' ? 'bg-amber-500'
      : tone === 'indigo' ? 'bg-indigo-500'
        : tone === 'muted' ? 'bg-[var(--text-muted)]'
          : 'bg-emerald-500';
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(known
        ? { 'aria-valuenow': Math.round(safeValue), 'aria-valuetext': `${Math.round(safeValue)} %` }
        : { 'aria-valuetext': 'neověřeno' })}
      data-progress-known={known ? 'true' : 'false'}
      data-progress-value={known ? Math.round(safeValue) : undefined}
      className="h-1 overflow-hidden rounded-full bg-[var(--border-subtle)]"
    >
      <span className={`block h-full rounded-full ${color} transition-[width] duration-300`} style={{ width: `${safeValue}%` }} />
    </div>
  );
};

const statusToneClass: Record<ProgressTone, string> = {
  rose: 'text-rose-500',
  amber: 'text-amber-500',
  indigo: 'text-indigo-500',
  muted: 'text-[var(--text-muted)]',
  emerald: 'text-[var(--text-primary)]',
};

/**
 * Jeden řádek pravidla: přepínač · název + detail · průběh (text + lišta) ·
 * ovládací prvek. Na úzké obrazovce se průběh zalomí pod řádek.
 */
const Rule = ({ title, detail, enabled, triggered, onToggle, toggleDisabled, tightenOnly, control, action, status, statusTone = 'emerald', progress, progressTone, progressLabel }: {
  title: string;
  detail: string;
  enabled: boolean;
  triggered: boolean;
  onToggle: (checked: boolean) => void;
  toggleDisabled?: boolean;
  tightenOnly?: boolean;
  control: React.ReactNode;
  action?: React.ReactNode;
  status: React.ReactNode;
  statusTone?: ProgressTone;
  progress: number | null;
  progressTone: ProgressTone;
  progressLabel: string;
}) => (
  <article
    data-rule-triggered={triggered ? 'true' : 'false'}
    className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-md border px-2.5 py-1.5 sm:grid-cols-[auto_minmax(0,1fr)_minmax(96px,132px)_auto_minmax(118px,auto)] ${triggered
      ? 'border-rose-500/35 bg-rose-500/[0.045]'
      : 'border-[var(--border-subtle)] bg-[var(--bg-input)]'}`}
  >
    <RuleToggle checked={enabled} label={title} disabled={toggleDisabled} title={toggleDisabled && tightenOnly ? 'dnes jen zpřísnit' : undefined} onChange={onToggle} />
    <div className="min-w-0" title={detail}>
      <h4 className={`truncate text-[11.5px] font-extrabold leading-4 ${enabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>{title}</h4>
      <p className="truncate text-[10px] leading-[13px] text-[var(--text-muted)]">{detail}</p>
    </div>
    <div className="order-3 col-span-3 flex flex-col gap-1 sm:order-none sm:col-span-1">
      <b className={`truncate text-right text-[10.5px] font-bold leading-3 tabular-nums ${statusToneClass[statusTone]}`}>{status}</b>
      <Progress label={progressLabel} value={progress} tone={progressTone} />
    </div>
    <div className="flex shrink-0 items-center gap-1.5">{control}</div>
    <div className="col-span-3 flex min-w-0 justify-end sm:col-span-1">{action ?? <span className="text-[10px] font-bold text-[var(--text-muted)]">pevná akce</span>}</div>
  </article>
);

const numericInputClass = 'h-7 w-[68px] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-right text-[11px] font-bold tabular-nums text-[var(--text-primary)] outline-none focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-45';
const timeInputClass = 'h-7 w-[70px] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-1.5 text-center font-mono text-[11px] font-bold text-[var(--text-primary)] outline-none focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-45';
const unitClass = 'text-[9.5px] font-bold text-[var(--text-muted)]';
const actionSelectClass = 'h-7 min-w-[102px] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-1.5 text-[10.5px] font-bold text-[var(--text-primary)] outline-none focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-45';
const actionMinutesClass = 'h-7 w-[50px] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-1.5 text-right text-[10.5px] font-bold tabular-nums text-[var(--text-primary)] outline-none focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-45';

const isWeakerAction = (
  base: CopierRuleAction | null,
  kind: CopierRuleAction['kind'] | null,
  minutes: string,
): boolean => {
  if (base == null) return false;
  if (base.kind === 'lock') return kind !== 'lock';
  if (kind === 'lock') return false;
  if (kind == null) return true;
  const parsed = integerInRange(minutes, 1, 720);
  return parsed != null && parsed < base.minutes;
};

const ActionEditor = ({ label, kind, minutes, base, enabled, allowNone = false, tightenOnly, onKind, onMinutes }: {
  label: string;
  kind: CopierRuleAction['kind'] | null;
  minutes: string;
  base: CopierRuleAction | null;
  enabled: boolean;
  allowNone?: boolean;
  tightenOnly: boolean;
  onKind: (kind: CopierRuleAction['kind'] | null) => void;
  onMinutes: (minutes: string) => void;
}) => {
  const pauseBlocked = tightenOnly && base?.kind === 'lock';
  const noneBlocked = tightenOnly && base != null;
  const minimum = tightenOnly && base?.kind === 'pause' ? base.minutes : 1;
  const title = tightenOnly ? 'dnes jen zpřísnit' : undefined;
  return (
    <div className="flex min-w-0 items-center justify-end gap-1" data-risk-rule-action={label}>
      <span className="hidden text-[9px] font-bold text-[var(--text-muted)] xl:inline">{label}</span>
      <select
        aria-label={`${label} – akce`}
        value={kind ?? ''}
        disabled={!enabled}
        title={title}
        onChange={event => {
          const next = event.target.value === ''
            ? null
            : event.target.value as CopierRuleAction['kind'];
          if (!tightenOnly || !isWeakerAction(base, next, minutes)) onKind(next);
        }}
        className={actionSelectClass}
      >
        {allowNone ? <option value="" disabled={noneBlocked}>Bez akce</option> : null}
        <option value="pause" disabled={pauseBlocked}>Pauza</option>
        <option value="lock">Zámek dne</option>
      </select>
      {kind === 'pause' ? (
        <>
          <input
            aria-label={`${label} – délka pauzy v minutách`}
            type="number"
            min={minimum}
            max="720"
            step="1"
            value={minutes}
            disabled={!enabled}
            title={title}
            onChange={event => {
              if (!tightenOnly || !isWeakerAction(base, kind, event.target.value)) onMinutes(event.target.value);
            }}
            className={actionMinutesClass}
          />
          <span className={unitClass}>min</span>
        </>
      ) : null}
    </div>
  );
};

const actionSummary = (kind: CopierRuleAction['kind'] | null, minutes: string): string => (
  kind == null ? 'bez akce' : kind === 'lock' ? 'zámek dne' : `pauza ${minutes || '—'} min`
);

const COLLAPSED_STORAGE_KEY = 'at:live:day-rules-collapsed';
const readCollapsed = (): boolean => {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};
const writeCollapsed = (collapsed: boolean) => {
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // localStorage může být nedostupné (private mode) — sbalení je jen pohodlí.
  }
};

export interface DayLockBannerProps {
  until: number;
  at?: number | null;
  trigger?: DayLockTrigger | null;
  reason?: string | null;
  now?: number;
}

export const DayLockBanner = ({ until, at = null, trigger = null, reason = null, now = Date.now() }: DayLockBannerProps) => {
  if (!(until > now)) return null;
  const engagedAt = at ? time.format(at) : null;
  const detail = trigger == null
    ? `Původ zámku není ověřen${engagedAt ? ` · aktivní od ${engagedAt}` : ''}${reason ? ` · ${reason}` : ''}.`
    : trigger === 'manual'
      ? `Ručně${engagedAt ? ` v ${engagedAt}` : ''}${reason ? ` — ${reason}` : ''}.`
      : `Automaticky${engagedAt ? ` v ${engagedAt}` : ''} — pravidlo „${TRIGGER_LABELS[trigger]}“${reason ? ` · ${reason}` : ''}.`;

  return (
    <section data-day-lock-banner="true" className="flex flex-col gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 sm:flex-row sm:items-center">
      <Lock size={18} className="shrink-0 text-rose-400" />
      <div className="min-w-0 flex-1">
        <h2 className="text-[13px] font-black text-rose-500">Den je zamčený do {time.format(until)}</h2>
        <p className="mt-0.5 text-xs leading-relaxed text-rose-400">
          {detail} Zámek skončí s koncem session (00:00 Chicago); pravidla jdou dnes jen zpřísnit.
        </p>
      </div>
    </section>
  );
};

export interface LiveDayRulesCardProps {
  groupId?: string;
  groupName?: string;
  safety?: CopyGroupSafetySettings | null;
  dailyStats?: CopierControllerStatus['dailyStats'];
  dayLockUntil?: number;
  dayLockTrigger?: DayLockTrigger | null;
  dayLockAt?: number | null;
  pause?: CopierControllerStatus['pause'];
  sessionArmedAt?: number;
  cooldownUntil?: number;
  armedAt?: number;
  armExpiresAt?: number;
  runtimeAvailable?: boolean;
  disabled?: boolean;
  onSave?: (safety: CopyGroupSafetySettings) => Promise<void> | void;
}

export const LiveDayRulesCard = ({
  groupId,
  groupName,
  safety = null,
  dailyStats = null,
  dayLockUntil = 0,
  dayLockTrigger = null,
  dayLockAt = null,
  pause = null,
  sessionArmedAt = 0,
  cooldownUntil = 0,
  armedAt = 0,
  armExpiresAt = 0,
  runtimeAvailable = true,
  disabled = false,
  onSave,
}: LiveDayRulesCardProps) => {
  const effectiveSafety = safety ?? DEFAULT_COPY_GROUP_SAFETY;
  const tightenOnly = sessionArmedAt > 0;
  // Parent posílá při každém pollu nový objekt safety se stejným obsahem.
  // Draft se proto resetuje jen při skutečné změně hodnot, jinak by
  // rozepsané přepínače po pár sekundách skočily zpět.
  const safetyKey = JSON.stringify([groupId ?? null, effectiveSafety]);
  const appliedSafetyKey = useRef(safetyKey);
  const appliedTightenOnly = useRef(tightenOnly);
  const [draft, setDraft] = useState(() => dailyRulesDraftFromSafety(effectiveSafety));
  const [now, setNow] = useState(() => Date.now());
  const [saving, setSaving] = useState(false);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    const enteredTightenOnly = !appliedTightenOnly.current && tightenOnly;
    appliedTightenOnly.current = tightenOnly;
    if (appliedSafetyKey.current === safetyKey && !enteredTightenOnly) return;
    appliedSafetyKey.current = safetyKey;
    setDraft(dailyRulesDraftFromSafety(effectiveSafety));
    setSaveErrors([]);
    setNotice(null);
  }, [safetyKey, effectiveSafety, tightenOnly]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const lockActive = dayLockUntil > now;
  const pauseActive = pause != null && pause.until > now;
  const losingTriggered = lockActive && dayLockTrigger === 'losing-trades';
  const lossTriggered = lockActive && dayLockTrigger === 'daily-loss';
  const tradesTriggered = lockActive && dayLockTrigger === 'max-trades';
  const windowTriggered = lockActive && dayLockTrigger === 'window-end';
  const cooldownActive = cooldownUntil > now;
  // Header počítá pravidla, která skutečně spustila denní zámek. Běžící
  // cooldown a průběh LIVE expirace jsou průběhové stavy, ne další locky.
  const configuredLockCount = [
    draft.losingTradesBeforeAction,
    draft.losingTradesAtAction,
    draft.dailyLoss80Action,
    draft.dailyLossAtAction,
    draft.maxTradesAtAction,
    draft.windowEndAction,
  ].filter(kind => kind === 'lock').length;
  const warnedRules = useMemo(() => new Set(dailyStats?.warnedRules?.map(warning => warning.rule) ?? []), [dailyStats?.warnedRules]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(dailyRulesDraftFromSafety(effectiveSafety));

  const dailyStatsKnown = runtimeAvailable && dailyStats != null;
  const losingCurrent = dailyStatsKnown ? dailyStats.losingTrades : null;
  const lossCurrent = dailyStatsKnown ? Math.max(0, -dailyStats.realizedPnlUsd) : null;
  const tradesCurrent = dailyStatsKnown ? dailyStats.tradesToday : null;
  const losingLimit = Number(draft.dailyMaxLosingTrades) || 0;
  const lossLimit = Number(draft.dailyLossLimitUsd) || 0;
  const tradesLimit = Number(draft.dailyMaxTrades) || 0;
  const from = clockMinutes(draft.tradingWindowFrom);
  const to = clockMinutes(draft.tradingWindowTo);
  const currentMinute = minuteOfDay(now);
  const windowProgress = dailyStatsKnown && from != null && to != null && currentMinute >= from
    ? progressPercent(currentMinute - from, to - from)
    : dailyStatsKnown ? 0 : null;
  const cooldownDuration = Math.max(0, Number(draft.entryCooldownMinutes) * 60_000);
  const cooldownRemaining = Math.max(0, cooldownUntil - now);
  const cooldownProgress = !runtimeAvailable
    ? null
    : cooldownActive && cooldownDuration > 0
      ? clampPercent(((cooldownDuration - cooldownRemaining) / cooldownDuration) * 100)
      : 0;
  const expiryProgress = !runtimeAvailable
    ? null
    : armExpiresAt > armedAt && armedAt > 0
      ? progressPercent(now - armedAt, armExpiresAt - armedAt)
      : 0;
  const losingBeforeLabel = losingLimit >= 2 ? `${losingLimit - 1}. ztráta` : 'Před limitem';
  const losingAtLabel = losingLimit > 0 ? `${losingLimit}. ztráta` : 'Na limitu';
  const losingBeforeApplies = draft.losingTradesEnabled && losingLimit >= 2;
  const losingActionDetail = losingLimit >= 2
    ? `${losingBeforeLabel} ${actionSummary(draft.losingTradesBeforeAction, draft.losingTradesBeforeMinutes)} · ${losingAtLabel} ${actionSummary(draft.losingTradesAtAction, draft.losingTradesAtMinutes)}`
    : `Před limitem se nespouští · ${losingAtLabel} ${actionSummary(draft.losingTradesAtAction, draft.losingTradesAtMinutes)}`;
  const lossActionDetail = `80 % ${actionSummary(draft.dailyLoss80Action, draft.dailyLoss80Minutes)} · 100 % ${actionSummary(draft.dailyLossAtAction, draft.dailyLossAtMinutes)}`;

  // Barva lišty: červená = zámek nebo limit dosažen, oranžová = varování
  // workeru nebo ≥ 80 % limitu, zelená = běžný průběh, šedá = pravidlo vypnuté.
  const ruleTone = (triggered: boolean, enabled: boolean, warned: boolean, percent: number | null = null): ProgressTone => (
    !enabled ? 'muted' : triggered ? 'rose' : percent == null ? 'muted' : percent >= 100 ? 'rose' : warned || percent >= 80 ? 'amber' : 'emerald'
  );
  const losingPercent = losingCurrent == null ? null : progressPercent(losingCurrent, losingLimit);
  const lossPercent = lossCurrent == null ? null : progressPercent(lossCurrent, lossLimit);
  const tradesPercent = tradesCurrent == null ? null : progressPercent(tradesCurrent, tradesLimit);
  const losingTone = ruleTone(losingTriggered, draft.losingTradesEnabled, warnedRules.has('losing-trades'), losingPercent);
  const lossTone = ruleTone(lossTriggered, draft.lossLimitEnabled, warnedRules.has('daily-loss'), lossPercent);
  const tradesTone = ruleTone(tradesTriggered, draft.maxTradesEnabled, warnedRules.has('max-trades'), tradesPercent);
  const windowTone = ruleTone(windowTriggered, draft.tradingWindowEnabled, warnedRules.has('window-end'), windowProgress);
  const windowStatus = !draft.tradingWindowEnabled || dailyStats?.windowState === 'off'
    ? 'vypnuto'
    : dailyStats?.windowState === 'inside' ? 'uvnitř okna'
      : dailyStats?.windowState === 'outside' ? 'mimo okno'
        : 'stav nedostupný';

  // Jednořádkový souhrn pro sbalenou kartu — čísla musí jít přečíst i bez rozbalení.
  const summary = [
    draft.losingTradesEnabled ? `ztrátové ${losingCurrent ?? '—'}/${losingLimit}` : null,
    draft.lossLimitEnabled ? `ztráta ${lossCurrent == null ? '—' : `−${number.format(lossCurrent)}`}/${number.format(lossLimit)} USD` : null,
    draft.maxTradesEnabled ? `obchody ${tradesCurrent ?? '—'}/${tradesLimit}` : null,
    draft.tradingWindowEnabled ? `okno ${draft.tradingWindowFrom}–${draft.tradingWindowTo}` : null,
    draft.cooldownEnabled ? `cooldown ${draft.entryCooldownMinutes} min` : null,
    draft.sessionExpiryEnabled ? `expirace: ${draft.armExpiryFlatten === 'group' ? 'skupina' : 'followeři'}` : null,
  ].filter((item): item is string => item != null);

  const set = <K extends keyof DailyRulesDraft>(key: K, value: DailyRulesDraft[K]) => {
    setDraft(current => ({ ...current, [key]: value }));
    setSaveErrors([]);
    setNotice(null);
  };
  const setUpperBound = (
    key: 'dailyMaxLosingTrades' | 'dailyLossLimitUsd' | 'dailyMaxTrades',
    value: string,
    base: number,
  ) => {
    const parsed = Number(value);
    if (tightenOnly && base > 0 && Number.isFinite(parsed) && (parsed <= 0 || parsed > base)) return;
    set(key, value);
  };
  const setCooldown = (value: string) => {
    const parsed = Number(value);
    if (tightenOnly
      && effectiveSafety.entryCooldownMinutes > 0
      && Number.isFinite(parsed)
      && parsed < effectiveSafety.entryCooldownMinutes) return;
    set('entryCooldownMinutes', value);
  };
  const setWindowTime = (key: 'tradingWindowFrom' | 'tradingWindowTo', value: string) => {
    const parsed = clockMinutes(value);
    const base = clockMinutes(key === 'tradingWindowFrom'
      ? effectiveSafety.tradingWindow.from
      : effectiveSafety.tradingWindow.to);
    const weaker = parsed != null && base != null && (
      key === 'tradingWindowFrom' ? parsed < base : parsed > base
    );
    if (tightenOnly && effectiveSafety.tradingWindow.enabled && weaker) return;
    set(key, value);
  };
  const toggleCollapsed = () => {
    setCollapsed(current => {
      writeCollapsed(!current);
      return !current;
    });
  };
  const save = async () => {
    const validated = validateDailyRulesDraft(draft, effectiveSafety);
    if (!validated.safety) {
      setSaveErrors(validated.errors);
      setNotice(null);
      return;
    }
    if (tightenOnly && isWeakerDailyRulesSafety(effectiveSafety, validated.safety)) {
      setSaveErrors(['Pravidla jdou dnes jen zpřísnit; mírnější změna nebyla odeslána.']);
      setNotice(null);
      return;
    }
    if (!onSave) {
      setSaveErrors(['Skupina není dostupná pro uložení pravidel.']);
      return;
    }
    setSaving(true);
    setSaveErrors([]);
    try {
      await onSave(validated.safety);
      setNotice('Pravidla byla potvrzena workerem.');
    } catch (error) {
      setSaveErrors([error instanceof Error ? error.message : 'Pravidla se nepodařilo uložit.']);
    } finally {
      setSaving(false);
    }
  };

  if (safety == null) {
    return (
      <section data-live-day-rules="true" data-rules-known="false" className="rounded-lg border border-amber-500/25 bg-[var(--bg-card)] px-3 py-2.5">
        <header className="flex items-center gap-2.5">
          <h3 className="flex-1 text-[13px] font-black text-[var(--text-primary)]">Pravidla dne</h3>
          <span className="rounded-full border border-amber-500/25 bg-amber-500/[0.07] px-2 py-0.5 text-[10px] font-bold text-amber-600">neověřeno</span>
        </header>
        <p className="mt-2 text-[11px] font-semibold text-[var(--text-secondary)]">Worker nevrátil autoritativní konfiguraci skupiny. Pravidla nelze zobrazit ani uložit.</p>
      </section>
    );
  }

  return (
      <section data-live-day-rules="true" data-rules-known="true" data-collapsed={collapsed ? 'true' : 'false'} data-tighten-only={tightenOnly ? 'true' : 'false'} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2.5">
        <header className="flex items-center gap-2.5">
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Rozbalit pravidla dne' : 'Sbalit pravidla dne'}
            onClick={toggleCollapsed}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-input)] hover:text-[var(--text-primary)]"
          >
            <ChevronDown size={14} style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 200ms' }} />
          </button>
          <h3 className="shrink-0 text-[13px] font-black text-[var(--text-primary)]">Pravidla dne</h3>
          {groupName ? <span className="hidden shrink-0 text-[10.5px] font-bold text-[var(--text-muted)] sm:inline">· {groupName}</span> : null}
          {collapsed ? (
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--text-secondary)]" title={summary.join(' · ')}>
              {summary.length > 0 ? summary.join(' · ') : 'žádné pravidlo není zapnuté'}
            </span>
          ) : <span className="flex-1" />}
          {dirty && !collapsed ? <span className="shrink-0 text-[10px] font-bold text-amber-500">neuloženo</span> : null}
          {tightenOnly ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-indigo-500/25 bg-indigo-500/[0.07] px-2 py-0.5 text-[10px] font-bold text-indigo-500" title="dnes jen zpřísnit">
              <Lock size={10} /> jen zpřísnit
            </span>
          ) : null}
          {pauseActive ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-600">
              <Clock3 size={10} /> Pauza
            </span>
          ) : null}
          <TriggerPill count={configuredLockCount} />
        </header>

        {collapsed ? null : (
          <>
            <div className="mt-1 hidden grid-cols-[auto_minmax(0,1fr)_minmax(96px,132px)_auto_minmax(118px,auto)] gap-x-3 px-2.5 text-[9px] font-black uppercase tracking-[0.08em] text-[var(--text-muted)] sm:grid">
              <span />
              <span>Pravidlo</span>
              <span className="text-right">Dnešní průběh</span>
              <span className="text-right">Hodnota</span>
              <span className="text-right">Akce</span>
            </div>
            <div className="mt-2 grid gap-1.5 md:grid-cols-2">
              <Rule
                title="Ztrátové obchody / den"
                detail={losingActionDetail}
                enabled={draft.losingTradesEnabled}
                triggered={losingTriggered}
                tightenOnly={tightenOnly}
                toggleDisabled={tightenOnly && effectiveSafety.dailyMaxLosingTrades > 0}
                onToggle={checked => set('losingTradesEnabled', checked)}
                status={<>{losingCurrent ?? '—'} / {draft.losingTradesEnabled ? losingLimit : '—'}{losingTriggered && dayLockAt ? ` · lock ${time.format(dayLockAt)}` : ''}</>}
                statusTone={losingTone}
                progress={draft.losingTradesEnabled ? losingPercent : 0}
                progressTone={losingTone}
                progressLabel="Průběh ztrátových obchodů"
                control={<>
                  <input aria-label="Max ztrátových obchodů za den" type="number" min="1" max={tightenOnly && effectiveSafety.dailyMaxLosingTrades > 0 ? effectiveSafety.dailyMaxLosingTrades : 50} step="1" disabled={!draft.losingTradesEnabled} title={tightenOnly ? 'dnes jen zpřísnit' : undefined} value={draft.dailyMaxLosingTrades} onChange={event => setUpperBound('dailyMaxLosingTrades', event.target.value, effectiveSafety.dailyMaxLosingTrades)} className={numericInputClass} />
                  <span className={unitClass}>obch.</span>
                </>}
                action={<div className="flex min-w-0 flex-col items-end gap-1">
                  <b className="text-[9.5px] font-black text-indigo-500">Stupňovitě</b>
                  <ActionEditor label={losingBeforeLabel} kind={draft.losingTradesBeforeAction} minutes={draft.losingTradesBeforeMinutes} base={effectiveSafety.dayRuleActions.losingTrades.beforeLimit} enabled={losingBeforeApplies} allowNone tightenOnly={tightenOnly} onKind={value => set('losingTradesBeforeAction', value)} onMinutes={value => set('losingTradesBeforeMinutes', value)} />
                  <ActionEditor label={losingAtLabel} kind={draft.losingTradesAtAction} minutes={draft.losingTradesAtMinutes} base={effectiveSafety.dayRuleActions.losingTrades.atLimit} enabled={draft.losingTradesEnabled} tightenOnly={tightenOnly} onKind={value => set('losingTradesAtAction', value)} onMinutes={value => set('losingTradesAtMinutes', value)} />
                </div>}
              />

              <Rule
                title="Denní ztráta (USD)"
                detail={lossActionDetail}
                enabled={draft.lossLimitEnabled}
                triggered={lossTriggered}
                tightenOnly={tightenOnly}
                toggleDisabled={tightenOnly && effectiveSafety.dailyLossLimitUsd > 0}
                onToggle={checked => set('lossLimitEnabled', checked)}
                status={<>{lossCurrent == null ? '—' : `−${number.format(lossCurrent)}`} · {draft.lossLimitEnabled ? (lossPercent == null ? 'stav nedostupný' : `${Math.round(lossPercent)} %`) : 'vypnuto'}</>}
                statusTone={lossTone}
                progress={draft.lossLimitEnabled ? lossPercent : 0}
                progressTone={lossTone}
                progressLabel="Průběh denní ztráty"
                control={<>
                  <input aria-label="Denní ztrátový limit v USD" type="number" min="0.01" max={tightenOnly && effectiveSafety.dailyLossLimitUsd > 0 ? effectiveSafety.dailyLossLimitUsd : 1_000_000} step="0.01" disabled={!draft.lossLimitEnabled} title={tightenOnly ? 'dnes jen zpřísnit' : undefined} value={draft.dailyLossLimitUsd} onChange={event => setUpperBound('dailyLossLimitUsd', event.target.value, effectiveSafety.dailyLossLimitUsd)} className={numericInputClass} />
                  <span className={unitClass}>USD</span>
                </>}
                action={<div className="flex min-w-0 flex-col items-end gap-1">
                  <b className="text-[9.5px] font-black text-indigo-500">Stupňovitě</b>
                  <ActionEditor label="80 %" kind={draft.dailyLoss80Action} minutes={draft.dailyLoss80Minutes} base={effectiveSafety.dayRuleActions.dailyLoss.at80Percent} enabled={draft.lossLimitEnabled} allowNone tightenOnly={tightenOnly} onKind={value => set('dailyLoss80Action', value)} onMinutes={value => set('dailyLoss80Minutes', value)} />
                  <ActionEditor label="100 %" kind={draft.dailyLossAtAction} minutes={draft.dailyLossAtMinutes} base={effectiveSafety.dayRuleActions.dailyLoss.atLimit} enabled={draft.lossLimitEnabled} tightenOnly={tightenOnly} onKind={value => set('dailyLossAtAction', value)} onMinutes={value => set('dailyLossAtMinutes', value)} />
                </div>}
              />

              <Rule
                title="Obchody / den"
                detail="Max obchodů za den — overtrading brzda, uzavřené obchody leadera."
                enabled={draft.maxTradesEnabled}
                triggered={tradesTriggered}
                tightenOnly={tightenOnly}
                toggleDisabled={tightenOnly && effectiveSafety.dailyMaxTrades > 0}
                onToggle={checked => set('maxTradesEnabled', checked)}
                status={<>{tradesCurrent ?? '—'} / {draft.maxTradesEnabled ? tradesLimit : '—'}</>}
                statusTone={tradesTone}
                progress={draft.maxTradesEnabled ? tradesPercent : 0}
                progressTone={tradesTone}
                progressLabel="Průběh obchodů za den"
                control={<>
                  <input aria-label="Max obchodů za den" type="number" min="1" max={tightenOnly && effectiveSafety.dailyMaxTrades > 0 ? effectiveSafety.dailyMaxTrades : 200} step="1" disabled={!draft.maxTradesEnabled} title={tightenOnly ? 'dnes jen zpřísnit' : undefined} value={draft.dailyMaxTrades} onChange={event => setUpperBound('dailyMaxTrades', event.target.value, effectiveSafety.dailyMaxTrades)} className={numericInputClass} />
                  <span className={unitClass}>obch.</span>
                </>}
                action={<ActionEditor label="Na limitu" kind={draft.maxTradesAtAction} minutes={draft.maxTradesAtMinutes} base={effectiveSafety.dayRuleActions.maxTrades.atLimit} enabled={draft.maxTradesEnabled} tightenOnly={tightenOnly} onKind={value => set('maxTradesAtAction', value)} onMinutes={value => set('maxTradesAtMinutes', value)} />}
              />

              <Rule
                title="Obchodní okno"
                detail="Europe/Prague. Mimo okno se kopie neposílá; po konci okna se den zamkne."
                enabled={draft.tradingWindowEnabled}
                triggered={windowTriggered}
                tightenOnly={tightenOnly}
                toggleDisabled={tightenOnly && effectiveSafety.tradingWindow.enabled}
                onToggle={checked => set('tradingWindowEnabled', checked)}
                status={<>{time.format(now)} · {windowStatus}</>}
                statusTone={windowTriggered ? 'rose' : draft.tradingWindowEnabled && dailyStats?.windowState === 'inside' ? 'emerald' : draft.tradingWindowEnabled ? 'amber' : 'muted'}
                progress={draft.tradingWindowEnabled ? windowProgress : 0}
                progressTone={windowTone}
                progressLabel="Průběh obchodního okna"
                control={<>
                  <input aria-label="Obchodní okno od" type="time" min={tightenOnly && effectiveSafety.tradingWindow.enabled ? effectiveSafety.tradingWindow.from : undefined} disabled={!draft.tradingWindowEnabled} title={tightenOnly ? 'dnes jen zpřísnit' : undefined} value={draft.tradingWindowFrom} onChange={event => setWindowTime('tradingWindowFrom', event.target.value)} className={timeInputClass} />
                  <span className="text-[10px] text-[var(--text-muted)]">–</span>
                  <input aria-label="Obchodní okno do" type="time" max={tightenOnly && effectiveSafety.tradingWindow.enabled ? effectiveSafety.tradingWindow.to : undefined} disabled={!draft.tradingWindowEnabled} title={tightenOnly ? 'dnes jen zpřísnit' : undefined} value={draft.tradingWindowTo} onChange={event => setWindowTime('tradingWindowTo', event.target.value)} className={timeInputClass} />
                </>}
                action={<ActionEditor label="Na konci" kind={draft.windowEndAction} minutes={draft.windowEndMinutes} base={effectiveSafety.dayRuleActions.windowEnd.atEnd} enabled={draft.tradingWindowEnabled} tightenOnly={tightenOnly} onKind={value => set('windowEndAction', value)} onMinutes={value => set('windowEndMinutes', value)} />}
              />

              <Rule
                title="Cooldown po flat"
                detail="Cooldown po uzavření — po flat leadera blokuje nové zapnutí na N minut."
                enabled={draft.cooldownEnabled}
                triggered={false}
                tightenOnly={tightenOnly}
                toggleDisabled={tightenOnly && effectiveSafety.entryCooldownMinutes > 0}
                onToggle={checked => set('cooldownEnabled', checked)}
                status={!runtimeAvailable ? 'stav nedostupný' : cooldownActive ? `do ${time.format(cooldownUntil)} · ${duration(cooldownRemaining)}` : !draft.cooldownEnabled ? 'vypnuto' : 'připraven'}
                statusTone={!runtimeAvailable ? 'muted' : cooldownActive ? 'amber' : draft.cooldownEnabled ? 'emerald' : 'muted'}
                progress={cooldownProgress}
                progressTone={cooldownActive ? 'amber' : draft.cooldownEnabled ? 'emerald' : 'muted'}
                progressLabel="Průběh cooldownu"
                control={<>
                  <input aria-label="Cooldown po uzavření v minutách" type="number" min={tightenOnly && effectiveSafety.entryCooldownMinutes > 0 ? effectiveSafety.entryCooldownMinutes : 1} max="720" step="1" disabled={!draft.cooldownEnabled} title={tightenOnly ? 'dnes jen zpřísnit' : undefined} value={draft.entryCooldownMinutes} onChange={event => setCooldown(event.target.value)} className={numericInputClass} />
                  <span className={unitClass}>min</span>
                </>}
                action={<span className="text-[10px] font-bold text-amber-600">Pauza {draft.entryCooldownMinutes} min</span>}
              />

              <Rule
                title="Expirace LIVE"
                detail="Expirace LIVE session — nejpozději 17:00 Chicago; podle scope zavře otevřené kopie."
                enabled={draft.sessionExpiryEnabled}
                triggered={false}
                tightenOnly={tightenOnly}
                toggleDisabled={tightenOnly && effectiveSafety.armExpiryFlatten !== 'off'}
                onToggle={checked => set('sessionExpiryEnabled', checked)}
                status={!runtimeAvailable ? 'stav nedostupný' : !draft.sessionExpiryEnabled ? 'vypnuto' : armExpiresAt > now ? `${time.format(armExpiresAt)} · zbývá ${duration(armExpiresAt - now)}` : armExpiresAt > 0 ? 'session vypršela' : 'od příštího LIVE'}
                statusTone={!runtimeAvailable ? 'muted' : draft.sessionExpiryEnabled ? (armExpiresAt > now ? 'indigo' : 'emerald') : 'muted'}
                progress={expiryProgress}
                progressTone={draft.sessionExpiryEnabled ? 'indigo' : 'muted'}
                progressLabel="Průběh LIVE session"
                control={
                  <select aria-label="Scope po expiraci LIVE session" disabled={!draft.sessionExpiryEnabled} title={tightenOnly ? 'dnes jen zpřísnit' : undefined} value={draft.armExpiryFlatten} onChange={event => {
                    const next = event.target.value as DailyRulesDraft['armExpiryFlatten'];
                    if (!(tightenOnly && effectiveSafety.armExpiryFlatten === 'group' && next === 'followers')) set('armExpiryFlatten', next);
                  }} className="h-7 w-[118px] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-1.5 text-[10.5px] font-bold text-[var(--text-primary)] outline-none focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-45">
                    <option value="followers" disabled={tightenOnly && effectiveSafety.armExpiryFlatten === 'group'}>Zavřít followery</option>
                    <option value="group">Zavřít skupinu</option>
                  </select>
                }
                action={<span className="text-[10px] font-bold text-indigo-500">Bezpečný konec session</span>}
              />
            </div>

            {saveErrors.length > 0 ? (
              <div role="alert" className="mt-2 rounded-md border border-rose-500/25 bg-rose-500/[0.07] px-3 py-1.5 text-[11px] font-bold text-rose-500">
                {saveErrors.map(error => <div key={error}>{error}</div>)}
                <div className="mt-0.5">Pravidla nebyla uložena.</div>
              </div>
            ) : null}
            {notice ? <div role="status" className="mt-2 flex items-center gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-1.5 text-[11px] font-bold text-emerald-600"><CheckCircle2 size={13} />{notice}</div> : null}

            <footer className="mt-2 flex items-center justify-between gap-3">
              <p className="min-w-0 truncate text-[10px] text-[var(--text-muted)]" title="Pravidla vyhodnocuje worker ze svého fill ledgeru a session, ne PWA. Zámek skončí až s koncem session; po prvním ARM jdou pravidla jen zpřísnit.">
                Vyhodnocuje worker · zámek končí se session · po prvním ARM dnes jen zpřísnit.
              </p>
              <button type="button" disabled={disabled || saving || !onSave} onClick={() => void save()} className={`inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-[11px] font-black text-white disabled:cursor-not-allowed disabled:opacity-45 ${dirty ? 'bg-indigo-600 hover:bg-indigo-500' : 'bg-indigo-600/60 hover:bg-indigo-500/70'}`}>
                {saving ? <Clock3 size={12} className="animate-spin" /> : <Save size={12} />}{saving ? 'Ukládám…' : 'Uložit pravidla'}
              </button>
            </footer>
          </>
        )}
      </section>
  );
};

export default LiveDayRulesCard;
