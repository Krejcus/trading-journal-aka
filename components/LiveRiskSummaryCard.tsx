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

export interface LiveRiskSummaryCardProps {
  group: CopyGroupConfig | null;
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

const MiniBar = ({ label, value, detail, percent, tone }: {
  label: string;
  value: string;
  detail: string;
  percent: number | null;
  tone: MetricTone;
}) => {
  const known = percent != null;
  const width = known ? clampPercent(percent) : 0;

  return (
    <div
      data-risk-summary-metric={label}
      data-metric-known={known ? 'true' : 'false'}
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
          : { 'aria-valuetext': 'neověřeno' })}
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
  if (!actions) return null;
  const configured: Array<CopierRuleAction | null> = [
    actions.losingTrades.beforeLimit,
    actions.losingTrades.atLimit,
    actions.dailyLoss.at80Percent,
    actions.dailyLoss.atLimit,
    actions.maxTrades.atLimit,
    actions.windowEnd.atEnd,
  ];
  return configured.filter(action => action?.kind === 'lock').length;
};

const lockCountLabel = (count: number | null): string => {
  if (count == null) return '— zámků';
  if (count === 1) return '1 zámek';
  if (count >= 2 && count <= 4) return `${count} zámky`;
  return `${count} zámků`;
};

const percentOf = (current: number | null, limit: number): number | null => (
  current != null && limit > 0 ? (current / limit) * 100 : null
);

export const LiveRiskSummaryCard = ({
  group,
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
}: LiveRiskSummaryCardProps) => {
  const safety = group?.safety ?? null;
  const activePause = pause != null && pause.until > now;
  const activeDayLock = dayLockUntil > now;
  const currentCuts = new Set(
    followerCuts.filter(cut => cut.until > now).map(cut => cut.accountId),
  );
  // Worker může vyřazenému followerovi držet runtime mode=off, cut ale pořád
  // patří do jmenovatele původně kopírujících účtů až do konce session.
  const participatingFollowers = group?.followers.filter(follower => (
    follower.mode !== 'off' || currentCuts.has(follower.accountId)
  )) ?? [];
  const copyingFollowers = participatingFollowers.filter(follower => (
    follower.mode !== 'off' && !currentCuts.has(follower.accountId)
  ));
  const followerCount = group
    ? `${copyingFollowers.length}/${participatingFollowers.length} účtů kopíruje`
    : '—/— účtů kopíruje';

  const lossCurrent = dailyStats == null ? null : Math.max(0, -dailyStats.realizedPnlUsd);
  const lossPercent = safety ? percentOf(lossCurrent, safety.dailyLossLimitUsd) : null;
  const losingCurrent = dailyStats == null ? null : dailyStats.losingTrades;
  const losingPercent = safety ? percentOf(losingCurrent, safety.dailyMaxLosingTrades) : null;
  const tradesCurrent = dailyStats?.tradesToday ?? null;
  const tradesPercent = safety ? percentOf(tradesCurrent, safety.dailyMaxTrades) : null;

  const accountsById = new Map(accounts.map(account => [account.id, account]));
  const accountRiskById = new Map(accountRisk.map(snapshot => [snapshot.accountId, snapshot]));
  const limitedCopyingFollowers = copyingFollowers.filter(follower => (follower.dailyLossCutUsd ?? 0) > 0);
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

  const lossValue = safety == null || lossPercent == null || lossCurrent == null
    ? '—'
    : `−${number.format(lossCurrent)} / ${number.format(safety.dailyLossLimitUsd)} USD`;
  const losingValue = safety == null || losingPercent == null || losingCurrent == null
    ? '—'
    : `${losingCurrent} / ${safety.dailyMaxLosingTrades}`;
  const tradesValue = safety == null || tradesPercent == null || tradesCurrent == null
    ? '—'
    : `${tradesCurrent} / ${safety.dailyMaxTrades}`;

  return (
    <section data-live-risk-summary="true" className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2.5">
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
          {lockCountLabel(lockActionCount(group))} · {followerCount}
        </span>
      </header>

      <div className="mt-2 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
        <MiniBar
          label="Denní ztráta"
          value={lossValue}
          detail={lossPercent == null ? 'Limit nebo průběh není ověřený' : `${Math.round(lossPercent)} % limitu leadera`}
          percent={lossPercent}
          tone={metricTone(lossPercent, 'emerald')}
        />
        <MiniBar
          label="Ztrátové obchody"
          value={losingValue}
          detail={losingPercent == null ? 'Limit nebo průběh není ověřený' : `${Math.round(losingPercent)} % limitu leadera`}
          percent={losingPercent}
          tone={metricTone(losingPercent, 'emerald')}
        />
        <MiniBar
          label="Obchody"
          value={tradesValue}
          detail={tradesPercent == null ? 'Limit nebo průběh není ověřený' : `${Math.round(tradesPercent)} % denního limitu`}
          percent={tradesPercent}
          tone={metricTone(tradesPercent, 'indigo')}
        />
        <MiniBar
          label="Účet nejblíž limitu"
          value={nearestFollower?.account.name ?? '—'}
          detail={nearestFollower
            ? `${Math.round(nearestFollower.percent)} % · −${number.format(nearestFollower.lossUsd)} / ${number.format(nearestFollower.limitUsd)} USD`
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
