import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, ChevronDown, Clock3, Lock, Save, Unlock, X } from 'lucide-react';
import type { CopierControllerStatus } from '../services/copierRuntimeController';
import {
  DEFAULT_COPY_GROUP_SAFETY,
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
}

export interface DailyRulesValidationResult {
  safety: CopyGroupSafetySettings | null;
  errors: string[];
}

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

const clockMinutes = (value: string): number | null => {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
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
    || entryCooldownMinutes == null) {
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
    },
    errors: [],
  };
}

export const validUnlockDayReason = (reason: string): boolean => {
  const trimmed = reason.trim();
  return trimmed.length >= 3
    && trimmed.length <= 200
    && !/[\u0000-\u001f\u007f]/.test(trimmed);
};

export const unlockDayCanSubmit = (reason: string, secondsRemaining: number, busy = false): boolean => (
  !busy && secondsRemaining <= 0 && validUnlockDayReason(reason)
);

export async function submitUnlockDay(
  reason: string,
  secondsRemaining: number,
  onUnlock: (reason: string) => Promise<void> | void,
): Promise<void> {
  if (!unlockDayCanSubmit(reason, secondsRemaining)) {
    throw new Error(secondsRemaining > 0
      ? `Odemknutí bude dostupné za ${secondsRemaining} s.`
      : 'Důvod musí mít 3 až 200 znaků a nesmí obsahovat řídicí znaky.');
  }
  await onUnlock(reason.trim());
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
  <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${count > 0
    ? 'border-rose-500/30 bg-rose-500/10 text-rose-500'
    : 'border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-600'}`}>
    <span className={`h-1.5 w-1.5 rounded-full ${count > 0 ? 'bg-rose-500' : 'bg-emerald-500'}`} />
    {count} z 6 pravidel spuštěno
  </span>
);

const RuleToggle = ({ checked, label, onChange }: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={`${label}: ${checked ? 'zapnuto' : 'vypnuto'}`}
    onClick={() => onChange(!checked)}
    className={`relative h-5 w-[34px] shrink-0 rounded-full transition-colors ${checked ? 'bg-emerald-500' : 'bg-[var(--border-subtle)] ring-1 ring-inset ring-white/10'}`}
  >
    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
  </button>
);

const Progress = ({ value, tone = 'emerald', label }: {
  value: number;
  tone?: 'emerald' | 'amber' | 'rose' | 'indigo' | 'muted';
  label: string;
}) => {
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
      aria-valuenow={Math.round(clampPercent(value))}
      data-progress-value={Math.round(clampPercent(value))}
      className="h-[5px] overflow-hidden rounded-full bg-[var(--border-subtle)]"
    >
      <span className={`block h-full rounded-full ${color}`} style={{ width: `${clampPercent(value)}%` }} />
    </div>
  );
};

const Rule = ({ title, detail, enabled, triggered, onToggle, children }: {
  title: string;
  detail: string;
  enabled: boolean;
  triggered: boolean;
  onToggle: (checked: boolean) => void;
  children: React.ReactNode;
}) => (
  <article
    data-rule-triggered={triggered ? 'true' : 'false'}
    className={`flex min-w-0 flex-col gap-3 rounded-lg border p-3 ${triggered
      ? 'border-rose-500/35 bg-rose-500/[0.045]'
      : 'border-[var(--border-subtle)] bg-[var(--bg-input)]'}`}
  >
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h4 className="text-xs font-extrabold text-[var(--text-primary)]">{title}</h4>
        <p className="mt-0.5 text-[11px] leading-[15px] text-[var(--text-secondary)]">{detail}</p>
      </div>
      <RuleToggle checked={enabled} label={title} onChange={onToggle} />
    </div>
    {children}
  </article>
);

const numericInputClass = 'h-8 w-24 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2.5 text-right text-xs font-bold tabular-nums text-[var(--text-primary)] outline-none focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-45';
const timeInputClass = 'h-8 w-[78px] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-center font-mono text-xs font-bold text-[var(--text-primary)] outline-none focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-45';

export interface DayLockBannerProps {
  until: number;
  at?: number | null;
  trigger?: DayLockTrigger | null;
  reason?: string | null;
  now?: number;
  onUnlock: () => void;
}

export const DayLockBanner = ({ until, at = null, trigger = null, reason = null, now = Date.now(), onUnlock }: DayLockBannerProps) => {
  if (!(until > now)) return null;
  const automatic = trigger != null && trigger !== 'manual';
  const source = trigger ? TRIGGER_LABELS[trigger] : 'Pravidlo dne';
  const engagedAt = at ? time.format(at) : null;
  const detail = automatic
    ? `Automaticky${engagedAt ? ` v ${engagedAt}` : ''} — pravidlo „${source}“${reason ? ` · ${reason}` : ''}.`
    : `Ručně${engagedAt ? ` v ${engagedAt}` : ''}${reason ? ` — ${reason}` : ''}.`;

  return (
    <section data-day-lock-banner="true" className="flex flex-col gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 sm:flex-row sm:items-center">
      <Lock size={18} className="shrink-0 text-rose-400" />
      <div className="min-w-0 flex-1">
        <h2 className="text-[13px] font-black text-rose-400">Den je zamčený do {time.format(until)}</h2>
        <p className="mt-0.5 text-xs leading-relaxed text-rose-300">{detail} Copier je VYPNUTO a zapnutí je blokované do konce session.</p>
      </div>
      <button type="button" onClick={onUnlock} className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-rose-500/40 px-3 text-[11px] font-extrabold text-rose-400 hover:bg-rose-500/10">
        <Unlock size={13} /> Odemknout…
      </button>
    </section>
  );
};

export const UnlockDayDialog = ({ trigger, at, reason, busy, secondsRemaining, error, onReason, onClose, onConfirm }: {
  trigger: DayLockTrigger | null;
  at: number | null;
  reason: string;
  busy: boolean;
  secondsRemaining: number;
  error: string | null;
  onReason: (reason: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) => {
  const canSubmit = unlockDayCanSubmit(reason, secondsRemaining, busy);
  const rule = trigger ? TRIGGER_LABELS[trigger] : 'Pravidlo dne';
  return (
    <section role="alertdialog" aria-modal="true" aria-label="Odemknout den" className="w-full max-w-md rounded-xl border border-rose-500/30 bg-[var(--bg-card)] p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-black uppercase tracking-[0.1em] text-rose-500">ZAMČENO</div>
          <h3 className="mt-1 text-lg font-black text-[var(--text-primary)]">Opravdu odemknout den?</h3>
        </div>
        <button type="button" aria-label="Nechat den zamčený" disabled={busy} onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-page)] disabled:opacity-40"><X size={16} /></button>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-[var(--text-secondary)]">
        Lock spustilo pravidlo <b className="text-[var(--text-primary)]">{rule}</b>{at ? ` v ${time.format(at)}` : ''}.
        {' '}Odemknutí se zapíše do deníku i s důvodem a toto pravidlo dnes už znovu nezasáhne.
      </p>
      <label className="mt-4 block">
        <span className="text-[10px] font-bold text-[var(--text-secondary)]">Důvod (povinné, 3–200 znaků)</span>
        <input
          autoFocus
          value={reason}
          maxLength={200}
          disabled={busy}
          onChange={event => onReason(event.target.value)}
          placeholder="Proč chci dnes pokračovat…"
          aria-invalid={reason.length > 0 && !validUnlockDayReason(reason)}
          className="mt-1 h-9 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-3 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-rose-500 disabled:opacity-50"
        />
      </label>
      <div className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] font-bold leading-relaxed text-amber-600">
        Odemknutí copier nikdy nezapne. Po úspěchu zůstane VYPNUTO; případné zapnutí je samostatný krok.
      </div>
      {error ? <p role="alert" className="mt-3 rounded-md border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2 text-xs font-bold text-rose-500">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="h-9 rounded-md border border-[var(--border-subtle)] px-3 text-xs font-bold text-[var(--text-primary)] disabled:opacity-50">Nechat zamčené</button>
        <button type="button" onClick={onConfirm} disabled={!canSubmit} className="h-9 rounded-md bg-rose-600 px-3 text-xs font-extrabold text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-45">
          {busy ? 'Odemykám…' : secondsRemaining > 0 ? `Odemknout (za ${secondsRemaining} s)` : 'Odemknout'}
        </button>
      </div>
    </section>
  );
};

export interface LiveDayRulesCardProps {
  groupName?: string;
  safety?: CopyGroupSafetySettings | null;
  dailyStats?: CopierControllerStatus['dailyStats'];
  dayLockUntil?: number;
  dayLockReason?: string | null;
  dayLockTrigger?: DayLockTrigger | null;
  dayLockAt?: number | null;
  cooldownUntil?: number;
  armedAt?: number;
  armExpiresAt?: number;
  disabled?: boolean;
  onSave?: (safety: CopyGroupSafetySettings) => Promise<void> | void;
  onUnlockDay?: (reason: string) => Promise<void> | void;
  /** Telefon: karta začíná sbalená na hlavičku + stav pravidel; rozbalí se klepnutím. */
  collapsible?: boolean;
}

export const LiveDayRulesCard = ({
  groupName,
  safety = DEFAULT_COPY_GROUP_SAFETY,
  dailyStats = null,
  dayLockUntil = 0,
  dayLockReason = null,
  dayLockTrigger = null,
  dayLockAt = null,
  cooldownUntil = 0,
  armedAt = 0,
  armExpiresAt = 0,
  disabled = false,
  onSave,
  onUnlockDay,
  collapsible = false,
}: LiveDayRulesCardProps) => {
  const [expanded, setExpanded] = useState(!collapsible);
  const effectiveSafety = safety ?? DEFAULT_COPY_GROUP_SAFETY;
  const [draft, setDraft] = useState(() => dailyRulesDraftFromSafety(effectiveSafety));
  const [now, setNow] = useState(() => Date.now());
  const [saving, setSaving] = useState(false);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockReason, setUnlockReason] = useState('');
  const [unlockSeconds, setUnlockSeconds] = useState(10);
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  useEffect(() => setDraft(dailyRulesDraftFromSafety(effectiveSafety)), [effectiveSafety]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!unlockOpen || unlockSeconds <= 0) return;
    const timer = window.setTimeout(() => setUnlockSeconds(value => Math.max(0, value - 1)), 1_000);
    return () => window.clearTimeout(timer);
  }, [unlockOpen, unlockSeconds]);

  const lockActive = dayLockUntil > now;
  const losingTriggered = lockActive && dayLockTrigger === 'losing-trades';
  const lossTriggered = lockActive && dayLockTrigger === 'daily-loss';
  const tradesTriggered = lockActive && dayLockTrigger === 'max-trades';
  const windowTriggered = lockActive && dayLockTrigger === 'window-end';
  const cooldownActive = cooldownUntil > now;
  // Header počítá pravidla, která skutečně spustila denní zámek. Běžící
  // cooldown a průběh LIVE expirace jsou průběhové stavy, ne další locky.
  const triggeredCount = [losingTriggered, lossTriggered, tradesTriggered, windowTriggered].filter(Boolean).length;
  const warnedRules = useMemo(() => new Set(dailyStats?.warnedRules?.map(warning => warning.rule) ?? []), [dailyStats?.warnedRules]);

  const losingCurrent = dailyStats?.losingTrades ?? 0;
  const lossCurrent = Math.max(0, -(dailyStats?.realizedPnlUsd ?? 0));
  const tradesCurrent = dailyStats?.tradesToday ?? 0;
  const losingLimit = Number(draft.dailyMaxLosingTrades) || 0;
  const lossLimit = Number(draft.dailyLossLimitUsd) || 0;
  const tradesLimit = Number(draft.dailyMaxTrades) || 0;
  const from = clockMinutes(draft.tradingWindowFrom);
  const to = clockMinutes(draft.tradingWindowTo);
  const currentMinute = minuteOfDay(now);
  const windowProgress = from != null && to != null && currentMinute >= from
    ? progressPercent(currentMinute - from, to - from)
    : 0;
  const cooldownDuration = Math.max(0, Number(draft.entryCooldownMinutes) * 60_000);
  const cooldownRemaining = Math.max(0, cooldownUntil - now);
  const cooldownProgress = cooldownActive && cooldownDuration > 0
    ? clampPercent(((cooldownDuration - cooldownRemaining) / cooldownDuration) * 100)
    : 0;
  const expiryProgress = armExpiresAt > armedAt && armedAt > 0
    ? progressPercent(now - armedAt, armExpiresAt - armedAt)
    : 0;

  const set = <K extends keyof DailyRulesDraft>(key: K, value: DailyRulesDraft[K]) => {
    setDraft(current => ({ ...current, [key]: value }));
    setSaveErrors([]);
    setNotice(null);
  };
  const openUnlock = () => {
    setUnlockReason('');
    setUnlockSeconds(10);
    setUnlockError(null);
    setUnlockOpen(true);
  };
  const save = async () => {
    const validated = validateDailyRulesDraft(draft, effectiveSafety);
    if (!validated.safety) {
      setSaveErrors(validated.errors);
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
      setNotice('Pravidla byla uložena. Začnou platit od příštího zapnutí.');
    } catch (error) {
      setSaveErrors([error instanceof Error ? error.message : 'Pravidla se nepodařilo uložit.']);
    } finally {
      setSaving(false);
    }
  };
  const unlock = async () => {
    if (!onUnlockDay) {
      setUnlockError('Worker relay není dostupný. Den zůstává ZAMČENO.');
      return;
    }
    setUnlockBusy(true);
    setUnlockError(null);
    try {
      await submitUnlockDay(unlockReason, unlockSeconds, onUnlockDay);
      setUnlockOpen(false);
      setNotice('Den je odemknutý. Copier zůstává VYPNUTO; zapnutí je samostatný krok.');
    } catch (error) {
      setUnlockError(error instanceof Error ? error.message : 'Worker den neodemkl. Den zůstává ZAMČENO.');
    } finally {
      setUnlockBusy(false);
    }
  };

  return (
    <>
      <DayLockBanner
        until={dayLockUntil}
        at={dayLockAt}
        trigger={dayLockTrigger}
        reason={dayLockReason}
        now={now}
        onUnlock={openUnlock}
      />

      <section data-live-day-rules="true" className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-black text-[var(--text-primary)]">Pravidla dne</h3>
            {expanded ? (
              <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                Když pravidlo platí, copier se vypne a zamkne do konce session. Odemknutí je možné jen tady, s důvodem.
                {groupName ? ` Skupina: ${groupName}.` : ''}
              </p>
            ) : (
              <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                {groupName ? `Skupina: ${groupName}. ` : ''}Klepnutím rozbalíš a upravíš pravidla.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <TriggerPill count={triggeredCount} />
            {collapsible ? (
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? 'Sbalit pravidla dne' : 'Rozbalit pravidla dne'}
                onClick={() => setExpanded(value => !value)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)]"
              >
                <ChevronDown size={16} className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
              </button>
            ) : null}
          </div>
        </header>

        {expanded ? (<>
        <div className="mt-3 grid gap-2.5 md:grid-cols-2">
          <Rule title="Max ztrátových obchodů za den" detail="Anti-revenge: po N ztrátách dnes už ne." enabled={draft.losingTradesEnabled} triggered={losingTriggered} onToggle={checked => set('losingTradesEnabled', checked)}>
            <div className="flex items-center gap-3">
              <label className="flex shrink-0 items-center gap-1.5">
                <input aria-label="Max ztrátových obchodů za den" type="number" min="1" max="50" step="1" disabled={!draft.losingTradesEnabled} value={draft.dailyMaxLosingTrades} onChange={event => set('dailyMaxLosingTrades', event.target.value)} className={numericInputClass} />
                <span className="text-[10px] font-bold text-[var(--text-muted)]">obchody</span>
              </label>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]"><span>Dnes</span><b className={losingTriggered ? 'text-rose-500' : 'text-[var(--text-primary)]'}>{losingCurrent} / {draft.losingTradesEnabled ? losingLimit : '—'}{losingTriggered && dayLockAt ? ` · lock ${time.format(dayLockAt)}` : ''}</b></div>
                <Progress label="Průběh ztrátových obchodů" value={draft.losingTradesEnabled ? progressPercent(losingCurrent, losingLimit) : 0} tone={losingTriggered ? 'rose' : warnedRules.has('losing-trades') ? 'amber' : draft.losingTradesEnabled ? 'emerald' : 'muted'} />
              </div>
            </div>
          </Rule>

          <Rule title="Denní ztrátový limit" detail="Realizovaná ztráta leadera za den (USD)." enabled={draft.lossLimitEnabled} triggered={lossTriggered} onToggle={checked => set('lossLimitEnabled', checked)}>
            <div className="flex items-center gap-3">
              <label className="flex shrink-0 items-center gap-1.5">
                <input aria-label="Denní ztrátový limit v USD" type="number" min="0.01" max="1000000" step="0.01" disabled={!draft.lossLimitEnabled} value={draft.dailyLossLimitUsd} onChange={event => set('dailyLossLimitUsd', event.target.value)} className={numericInputClass} />
                <span className="text-[10px] font-bold text-[var(--text-muted)]">USD</span>
              </label>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]"><span>Dnes</span><b className={lossTriggered ? 'text-rose-500' : 'text-[var(--text-primary)]'}>−{number.format(lossCurrent)} · {draft.lossLimitEnabled ? `${Math.round(progressPercent(lossCurrent, lossLimit))} %` : 'vypnuto'}</b></div>
                <Progress label="Průběh denní ztráty" value={draft.lossLimitEnabled ? progressPercent(lossCurrent, lossLimit) : 0} tone={lossTriggered ? 'rose' : warnedRules.has('daily-loss') ? 'amber' : draft.lossLimitEnabled ? 'emerald' : 'muted'} />
              </div>
            </div>
          </Rule>

          <Rule title="Max obchodů za den" detail="Overtrading brzda — uzavřené obchody leadera." enabled={draft.maxTradesEnabled} triggered={tradesTriggered} onToggle={checked => set('maxTradesEnabled', checked)}>
            <div className="flex items-center gap-3">
              <label className="flex shrink-0 items-center gap-1.5">
                <input aria-label="Max obchodů za den" type="number" min="1" max="200" step="1" disabled={!draft.maxTradesEnabled} value={draft.dailyMaxTrades} onChange={event => set('dailyMaxTrades', event.target.value)} className={numericInputClass} />
                <span className="text-[10px] font-bold text-[var(--text-muted)]">obchodů</span>
              </label>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]"><span>Dnes</span><b className={tradesTriggered ? 'text-rose-500' : 'text-[var(--text-primary)]'}>{tradesCurrent} / {draft.maxTradesEnabled ? tradesLimit : '—'}</b></div>
                <Progress label="Průběh obchodů za den" value={draft.maxTradesEnabled ? progressPercent(tradesCurrent, tradesLimit) : 0} tone={tradesTriggered ? 'rose' : warnedRules.has('max-trades') ? 'amber' : draft.maxTradesEnabled ? 'emerald' : 'muted'} />
              </div>
            </div>
          </Rule>

          <Rule title="Obchodní okno" detail="Mimo okno se kopie neposílá; po konci okna se den zamkne." enabled={draft.tradingWindowEnabled} triggered={windowTriggered} onToggle={checked => set('tradingWindowEnabled', checked)}>
            <div className="flex flex-wrap items-center gap-2">
              <input aria-label="Obchodní okno od" type="time" disabled={!draft.tradingWindowEnabled} value={draft.tradingWindowFrom} onChange={event => set('tradingWindowFrom', event.target.value)} className={timeInputClass} />
              <span className="text-xs text-[var(--text-muted)]">–</span>
              <input aria-label="Obchodní okno do" type="time" disabled={!draft.tradingWindowEnabled} value={draft.tradingWindowTo} onChange={event => set('tradingWindowTo', event.target.value)} className={timeInputClass} />
              <span className="rounded bg-indigo-500/10 px-1.5 py-1 text-[9px] font-black text-indigo-500">Europe/Prague</span>
              <div className="min-w-[150px] flex-1">
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]"><span>Nyní <span className="font-mono">{time.format(now)}</span></span><b className={windowTriggered ? 'text-rose-500' : dailyStats?.windowState === 'inside' ? 'text-emerald-500' : 'text-[var(--text-primary)]'}>{!draft.tradingWindowEnabled || dailyStats?.windowState === 'off' ? 'vypnuto' : dailyStats?.windowState === 'inside' ? 'uvnitř okna' : dailyStats?.windowState === 'outside' ? 'mimo okno' : 'stav nedostupný'}</b></div>
                <Progress label="Průběh obchodního okna" value={draft.tradingWindowEnabled ? windowProgress : 0} tone={windowTriggered ? 'rose' : warnedRules.has('window-end') ? 'amber' : draft.tradingWindowEnabled ? 'emerald' : 'muted'} />
              </div>
            </div>
          </Rule>

          <Rule title="Cooldown po uzavření" detail="Po flat leadera blokuje nové zapnutí na N minut." enabled={draft.cooldownEnabled} triggered={false} onToggle={checked => set('cooldownEnabled', checked)}>
            <div className="flex items-center gap-3">
              <label className="flex shrink-0 items-center gap-1.5">
                <input aria-label="Cooldown po uzavření v minutách" type="number" min="1" max="720" step="1" disabled={!draft.cooldownEnabled} value={draft.entryCooldownMinutes} onChange={event => set('entryCooldownMinutes', event.target.value)} className={numericInputClass} />
                <span className="text-[10px] font-bold text-[var(--text-muted)]">min</span>
              </label>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]"><span>Dnes</span><b className={cooldownActive ? 'text-amber-500' : 'text-[var(--text-primary)]'}>{cooldownActive ? `do ${time.format(cooldownUntil)} · ${duration(cooldownRemaining)}` : !draft.cooldownEnabled ? 'vypnuto' : 'připraven'}</b></div>
                <Progress label="Průběh cooldownu" value={cooldownProgress} tone={cooldownActive ? 'amber' : draft.cooldownEnabled ? 'emerald' : 'muted'} />
              </div>
            </div>
          </Rule>

          <Rule title="Expirace LIVE session" detail="Nejpozději 17:00 Chicago; podle scope zavře otevřené kopie." enabled={draft.sessionExpiryEnabled} triggered={false} onToggle={checked => set('sessionExpiryEnabled', checked)}>
            <div className="flex items-center gap-3">
              <select aria-label="Scope po expiraci LIVE session" disabled={!draft.sessionExpiryEnabled} value={draft.armExpiryFlatten} onChange={event => set('armExpiryFlatten', event.target.value as DailyRulesDraft['armExpiryFlatten'])} className="h-8 w-36 shrink-0 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-[11px] font-bold text-[var(--text-primary)] outline-none focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-45">
                <option value="followers">Zavřít followery</option>
                <option value="group">Zavřít celou skupinu</option>
              </select>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]"><span>Dnes</span><b className="text-[var(--text-primary)]">{!draft.sessionExpiryEnabled ? 'vypnuto' : armExpiresAt > now ? `${time.format(armExpiresAt)} · zbývá ${duration(armExpiresAt - now)}` : armExpiresAt > 0 ? 'session vypršela' : 'od příštího LIVE'}</b></div>
                <Progress label="Průběh LIVE session" value={expiryProgress} tone={draft.sessionExpiryEnabled ? 'indigo' : 'muted'} />
              </div>
            </div>
          </Rule>
        </div>

        {saveErrors.length > 0 ? (
          <div role="alert" className="mt-3 rounded-md border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2 text-xs font-bold text-rose-500">
            {saveErrors.map(error => <div key={error}>{error}</div>)}
            <div className="mt-1">Pravidla nebyla uložena.</div>
          </div>
        ) : null}
        {notice ? <div role="status" className="mt-3 flex items-center gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2 text-xs font-bold text-emerald-600"><CheckCircle2 size={14} />{notice}</div> : null}

        <footer className="mt-3 flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-3xl text-[11px] leading-relaxed text-[var(--text-muted)]">
            Pravidla vyhodnocuje worker ze svého fill ledgeru a session — ne broker. Změna platí od příštího zapnutí.
          </p>
          <button type="button" disabled={disabled || saving || !onSave} onClick={() => void save()} className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-3.5 text-xs font-black text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-45">
            {saving ? <Clock3 size={13} className="animate-spin" /> : <Save size={13} />}{saving ? 'Ukládám…' : 'Uložit pravidla'}
          </button>
        </footer>
        </>) : null}
      </section>

      {unlockOpen && typeof document !== 'undefined' ? createPortal(
        <div className="fixed inset-0 z-[175] flex items-center justify-center bg-slate-950/50 p-4" onMouseDown={event => { if (event.target === event.currentTarget && !unlockBusy) setUnlockOpen(false); }}>
          <UnlockDayDialog
            trigger={dayLockTrigger}
            at={dayLockAt}
            reason={unlockReason}
            busy={unlockBusy}
            secondsRemaining={unlockSeconds}
            error={unlockError}
            onReason={setUnlockReason}
            onClose={() => setUnlockOpen(false)}
            onConfirm={() => void unlock()}
          />
        </div>,
        document.body,
      ) : null}
    </>
  );
};

export default LiveDayRulesCard;
