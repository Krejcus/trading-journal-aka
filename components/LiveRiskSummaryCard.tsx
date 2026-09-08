import React from 'react';
import { ArrowRight, Lock, Pause, Shield } from 'lucide-react';
import type {
  CopierAccountRiskSnapshot,
  CopierControllerStatus,
  CopierFollowerCut,
} from '../services/copierRuntimeController';
import {
  type CopierRuleAction,
  type CopyGroupConfig,
} from '../services/liveCopyTrading';
import type { LiveAccount } from '../services/tradecopiaLiveService';
import { verifiedAccountDailyPnl } from './LiveAccountRiskTable';
import { copierRuntimePresentation } from '../lib/copierRuntimePresentation';
import { copierAccountEligibilityPresentation } from '../lib/copierAccountEligibilityPresentation';

export interface LiveRiskSummaryCardProps {
  group: CopyGroupConfig | null;
  status?: CopierControllerStatus | null;
  runtimeAvailable?: boolean;
  riskConfigSupported?: boolean;
  dailyStats?: CopierControllerStatus['dailyStats'];
  pause?: CopierControllerStatus['pause'];
  dayLockUntil?: number;
  followerCuts?: CopierFollowerCut[];
  accountRisk?: CopierAccountRiskSnapshot[];
  accounts?: LiveAccount[];
  brokerDailyPnlByAccount?: Readonly<Record<string, number | null>>;
  brokerDailyPnlPending?: boolean;
  now?: number;
  onOpenRisk?: () => void;
  /** Telefon: jeden klepnutelný řádek místo čtyř dlaždic; detail je v záložce Risk. */
  compact?: boolean;
}

type MetricTone = 'emerald' | 'amber' | 'rose' | 'indigo';

const number = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 });

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

const metricTone = (percent: number | null, fallback: MetricTone): MetricTone => {
  if (percent == null) return fallback;
  if (percent >= 100) return 'rose';
  if (percent >= 80) return 'amber';
  return fallback;
};

const barColor: Record<MetricTone, string> = {
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
  indigo: 'bg-indigo-500',
};

const valueColor: Record<MetricTone, string> = {
  emerald: 'text-emerald-600',
  amber: 'text-amber-500',
  rose: 'text-rose-500',
  indigo: 'text-indigo-500',
};

const MiniBar = ({ label, value, detail, percent, tone, disabled = false }: {
  label: string;
  value: string;
  detail: string;
  percent: number | null;
  tone: MetricTone;
  disabled?: boolean;
}) => {
  const known = percent != null;
  const width = known ? clampPercent(percent) : 0;

  return (
    <div
      data-risk-summary-metric={label}
      data-metric-known={known ? 'true' : 'false'}
      data-rule-disabled={disabled ? 'true' : 'false'}
      className="min-w-0 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2.5 py-2"
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="truncate text-[9.5px] font-black uppercase tracking-[0.08em] text-[var(--text-muted)]">{label}</span>
        <b className={`truncate text-right text-[11px] font-black tabular-nums ${known ? valueColor[tone] : 'text-[var(--text-secondary)]'}`}>{value}</b>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(known
          ? { 'aria-valuenow': Math.round(width), 'aria-valuetext': `${Math.round(width)} %` }
          : { 'aria-valuetext': disabled ? 'vypnuto' : 'neověřeno' })}
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--border-subtle)]"
      >
        <span className={`block h-full rounded-full ${barColor[tone]}`} style={{ width: `${width}%` }} />
      </div>
      <p className="mt-1 truncate text-[9.5px] leading-3 text-[var(--text-muted)]" title={detail}>{detail}</p>
    </div>
  );
};

const lockActionCount = (group: CopyGroupConfig | null): number | null => {
  const actions = group?.safety?.dayRuleActions;
  const safety = group?.safety;
  if (!actions || !safety) return null;
  const configured: Array<CopierRuleAction | null> = [
    safety.dailyMaxLosingTrades > 0 ? actions.losingTrades.beforeLimit : null,
    safety.dailyMaxLosingTrades > 0 ? actions.losingTrades.atLimit : null,
    safety.dailyLossLimitUsd > 0 ? actions.dailyLoss.at80Percent : null,
    safety.dailyLossLimitUsd > 0 ? actions.dailyLoss.atLimit : null,
    safety.dailyMaxTrades > 0 ? actions.maxTrades.atLimit : null,
    safety.tradingWindow.enabled ? actions.windowEnd.atEnd : null,
  ];
  return configured.filter(action => action?.kind === 'lock').length;
};

const lockCountLabel = (count: number | null): string => {
  if (count == null) return 'Pravidla neověřena';
  if (count === 1) return '1 zámek';
  if (count >= 2 && count <= 4) return `${count} zámky`;
  return `${count} zámků`;
};

const percentOf = (current: number | null, limit: number): number | null => (
  current != null && limit > 0 ? (current / limit) * 100 : null
);

export const LiveRiskSummaryCard = ({
  group,
  status = null,
  runtimeAvailable = false,
  riskConfigSupported = false,
  dailyStats = null,
  pause = null,
  dayLockUntil = 0,
  followerCuts = [],
  accountRisk = [],
  accounts = [],
  brokerDailyPnlByAccount = {},
  brokerDailyPnlPending = false,
  now = Date.now(),
  onOpenRisk,
  compact = false,
}: LiveRiskSummaryCardProps) => {
  const safety = riskConfigSupported ? group?.safety ?? null : null;
  const runtime = copierRuntimePresentation(status, runtimeAvailable, now);
  const activePause = runtimeAvailable && pause != null && pause.until > now;
  const activeDayLock = runtimeAvailable && dayLockUntil > now;
  const currentCuts = new Set(
    (runtimeAvailable ? followerCuts : []).filter(cut => cut.until > now).map(cut => cut.accountId),
  );
  // Worker může vyřazenému followerovi držet runtime mode=off, cut ale pořád
  // patří do jmenovatele původně kopírujících účtů až do konce session.
  const participatingFollowers = group?.followers.filter(follower => (
    follower.mode !== 'off' || currentCuts.has(follower.accountId)
  )) ?? [];
  const copyingFollowers = participatingFollowers.filter(follower => (
    follower.mode !== 'off' && !currentCuts.has(follower.accountId)
      && copierAccountEligibilityPresentation(status, follower.accountId).active
  ));
  const eligibilityKnown = Array.isArray(status?.accountEligibility);
  const followerCount = group
    ? runtime.copying && group.enabled
      ? eligibilityKnown
        ? `${copyingFollowers.length}/${participatingFollowers.length} účtů kopíruje`
        : `Nastavené účty: ${participatingFollowers.length} · Způsobilost účtů neověřena`
      : `Nastavené účty: ${participatingFollowers.length} · ${!runtime.copying || group.enabled ? runtime.label : 'Skupina vypnutá'}`
    : 'Účty nejsou ověřené';

  const lossCurrent = !runtimeAvailable || dailyStats == null ? null : Math.max(0, -dailyStats.realizedPnlUsd);
  const lossPercent = safety ? percentOf(lossCurrent, safety.dailyLossLimitUsd) : null;
  const losingCurrent = !runtimeAvailable || dailyStats == null ? null : dailyStats.losingTrades;
  const losingPercent = safety ? percentOf(losingCurrent, safety.dailyMaxLosingTrades) : null;
  const tradesCurrent = runtimeAvailable ? dailyStats?.tradesToday ?? null : null;
  const tradesPercent = safety ? percentOf(tradesCurrent, safety.dailyMaxTrades) : null;

  const accountsById = new Map(accounts.map(account => [account.id, account]));
  const accountRiskById = new Map(accountRisk.map(snapshot => [snapshot.accountId, snapshot]));
  const limitedCopyingFollowers = (riskConfigSupported ? copyingFollowers : []).filter(follower => (follower.dailyLossCutUsd ?? 0) > 0);
  const pnlForAccount = (accountId: number): number | null => {
    return verifiedAccountDailyPnl({
      workerRisk: accountRiskById.get(accountId),
      workerRiskFeedAvailable: accountRisk.length > 0,
      brokerPnl: brokerDailyPnlByAccount[String(accountId)],
      brokerPending: brokerDailyPnlPending,
      now,
    });
  };
  const nearestFollowerDataKnown = limitedCopyingFollowers.length > 0
    && limitedCopyingFollowers.every(follower => (
      accountsById.has(follower.accountId) && pnlForAccount(follower.accountId) != null
    ));
  // U částečného snapshotu nelze bezpečně tvrdit, který follower je nejblíž
  // limitu: chybějící účet může být ve skutečnosti ten nejrizikovější.
  const nearestFollower = !nearestFollowerDataKnown
    ? null
    : limitedCopyingFollowers.reduce<{
        account: LiveAccount;
        lossUsd: number;
        limitUsd: number;
        percent: number;
      } | null>((nearest, follower) => {
        const limitUsd = follower.dailyLossCutUsd ?? 0;
        const account = accountsById.get(follower.accountId)!;
        const pnl = pnlForAccount(follower.accountId)!;
        const lossUsd = Math.max(0, -pnl);
        const percent = (lossUsd / limitUsd) * 100;
        return nearest == null || percent > nearest.percent
          ? { account, lossUsd, limitUsd, percent }
          : nearest;
      }, null);

  const lossDisabled = safety?.dailyLossLimitUsd === 0;
  const losingDisabled = safety?.dailyMaxLosingTrades === 0;
  const tradesDisabled = safety?.dailyMaxTrades === 0;
  const lossValue = lossDisabled ? 'Vypnuto' : safety == null || lossPercent == null || lossCurrent == null
    ? '—'
    : `−${number.format(lossCurrent)} / ${number.format(safety.dailyLossLimitUsd)} USD`;
  const losingValue = losingDisabled ? 'Vypnuto' : safety == null || losingPercent == null || losingCurrent == null
    ? '—'
    : `${losingCurrent} / ${safety.dailyMaxLosingTrades}`;
  const tradesValue = tradesDisabled ? 'Vypnuto' : safety == null || tradesPercent == null || tradesCurrent == null
    ? '—'
    : `${tradesCurrent} / ${safety.dailyMaxTrades}`;

  if (compact) {
    const compactTone = (percent: number | null, disabled: boolean): string => disabled
      ? 'text-[var(--text-muted)]'
      : percent == null ? 'text-[var(--text-secondary)]' : percent >= 100 ? 'text-rose-500' : percent >= 80 ? 'text-amber-500' : 'text-[var(--text-primary)]';
    const compactValue = (value: string): string => value === 'Vypnuto' ? 'vyp.' : value.replace(' USD', '');
    return (
      <a
        href="?page=live&tab=risk"
        onClick={event => {
          if (!onOpenRisk) return;
          event.preventDefault();
          onOpenRisk();
        }}
        data-live-risk-summary="true"
        data-live-risk-compact="true"
        data-copier-runtime-state={runtime.key}
        className="flex items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2.5 text-left"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-500"><Shield size={15} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-[12px] font-black text-[var(--text-primary)]">Risk</span>
            {activeDayLock ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[9px] font-black text-rose-500"><Lock size={9} /> Zámek</span>
            ) : activePause ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-black text-amber-600"><Pause size={9} /> Pauza</span>
            ) : null}
            <span className="truncate text-[10.5px] font-semibold text-[var(--text-secondary)]">{followerCount}</span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-x-3 text-[11px] font-bold tabular-nums">
            <span className="whitespace-nowrap"><span className="text-[var(--text-muted)]">Ztráta </span><span className={compactTone(lossPercent, lossDisabled)}>{compactValue(lossValue)}</span></span>
            <span className="whitespace-nowrap"><span className="text-[var(--text-muted)]">Ztrátové </span><span className={compactTone(losingPercent, losingDisabled)}>{compactValue(losingValue)}</span></span>
            <span className="whitespace-nowrap"><span className="text-[var(--text-muted)]">Obchody </span><span className={compactTone(tradesPercent, tradesDisabled)}>{compactValue(tradesValue)}</span></span>
            {nearestFollower ? (
              <span className="truncate"><span className="text-[var(--text-muted)]">Nejblíž </span><span className={compactTone(nearestFollower.percent, false)}>{Math.round(nearestFollower.percent)} %</span></span>
            ) : null}
          </span>
        </span>
        <ArrowRight size={14} className="shrink-0 text-indigo-500" />
      </a>
    );
  }

  return (
    <section data-live-risk-summary="true" data-copier-runtime-state={runtime.key} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2.5">
      <header className="flex flex-wrap items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-500"><Shield size={14} /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-black text-[var(--text-primary)]">Risk</h3>
          <p className="truncate text-[10px] text-[var(--text-muted)]">{group?.name ?? 'Skupina není dostupná'}</p>
        </div>
        {activeDayLock ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-black text-rose-500"><Lock size={10} /> Zámek dne</span>
        ) : activePause ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-black text-amber-600"><Pause size={10} /> Pauza</span>
        ) : null}
        <span className="shrink-0 text-[10.5px] font-bold text-[var(--text-secondary)]">
          {riskConfigSupported ? lockCountLabel(lockActionCount(group)) : 'Pravidla worker nepotvrdil'} · {followerCount}
        </span>
      </header>

      <div className="mt-2 grid gap-1.5 sm:grid-cols-2 md:grid-cols-4">
        <MiniBar
          label="Denní ztráta"
          value={lossValue}
          disabled={lossDisabled}
          detail={lossDisabled ? 'Denní ztrátový limit je vypnutý' : lossPercent == null ? 'Limit nebo průběh není ověřený' : `${Math.round(lossPercent)} % limitu leadera`}
          percent={lossPercent}
          tone={metricTone(lossPercent, 'emerald')}
        />
        <MiniBar
          label="Ztrátové obchody"
          value={losingValue}
          disabled={losingDisabled}
          detail={losingDisabled ? 'Limit ztrátových obchodů je vypnutý' : losingPercent == null ? 'Limit nebo průběh není ověřený' : `${Math.round(losingPercent)} % limitu leadera`}
          percent={losingPercent}
          tone={metricTone(losingPercent, 'emerald')}
        />
        <MiniBar
          label="Obchody"
          value={tradesValue}
          disabled={tradesDisabled}
          detail={tradesDisabled ? 'Denní limit obchodů je vypnutý' : tradesPercent == null ? 'Limit nebo průběh není ověřený' : `${Math.round(tradesPercent)} % denního limitu`}
          percent={tradesPercent}
          tone={metricTone(tradesPercent, 'indigo')}
        />
        <MiniBar
          label="Účet nejblíž limitu"
          value={nearestFollower?.account.name ?? '—'}
          detail={nearestFollower
            ? `${Math.round(nearestFollower.percent)} % · −${number.format(nearestFollower.lossUsd)} / ${number.format(nearestFollower.limitUsd)} USD`
            : !riskConfigSupported
              ? runtimeAvailable ? 'Risk vyžaduje aktualizaci workeru' : 'Podpora Risk pravidel není ověřená'
              : brokerDailyPnlPending && accountRisk.length === 0
              ? 'Denní P&L se načítá'
              : limitedCopyingFollowers.length === 0
                ? 'Účet s aktivním limitem není dostupný'
                : 'Denní P&L všech účtů není ověřené'}
          percent={nearestFollower?.percent ?? null}
          tone={metricTone(nearestFollower?.percent ?? null, 'emerald')}
        />
      </div>

      <footer className="mt-2 flex justify-end">
        <a
          href="?page=live&tab=risk"
          onClick={event => {
            if (!onOpenRisk) return;
            event.preventDefault();
            onOpenRisk();
          }}
          className="inline-flex items-center gap-1.5 text-[11px] font-black text-indigo-500 hover:text-indigo-400"
        >
          Otevřít Risk <ArrowRight size={12} />
        </a>
      </footer>
    </section>
  );
};

export default LiveRiskSummaryCard;
