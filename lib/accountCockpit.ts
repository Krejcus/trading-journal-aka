import type { Account } from '../types';
import type { CopierAccountSnapshotRow } from '../services/copierAccountSnapshots';
import type { TradovateAccountProfile } from './tradovateAccountProfileTypes';
import type { TradovateAccountDataAccount } from './tradovateAccountDataTypes';
import type { FirmPayoutRules } from './propFirmRules';
import { accountRiskFloor, accountRiskPeak } from './tradovateLiveView';
import {
  breachDetector,
  chicagoTradingDate,
  consistencyCheck,
  dailyLedger,
  dailyLimitUsage,
  drawdownFloor,
  drawdownUsage,
  evaluationProgress,
  payoutEligibility,
  profitDayProgress,
  withdrawableProfit,
  type ConsistencyCheck,
  type DrawdownFloorResult,
  type EvaluationProgress,
  type LimitUsage,
  type PayoutEligibility,
  type ProfitDayProgress,
  type RiskLevel,
} from './propFirmMetrics';

interface CockpitDrawdownSnapshot {
  capturedAt: string;
  balance: number;
  autoLiqLevel: number | null;
}

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Stejný floor jako LIVE desk, následovaný broker snapshotem a až pak výpočtem. */
export function resolveCockpitDrawdown({
  snapshots,
  profile,
  liveAccount,
  liveCapturedAt,
}: {
  snapshots: readonly CockpitDrawdownSnapshot[];
  profile: TradovateAccountProfile;
  liveAccount?: TradovateAccountDataAccount | null;
  liveCapturedAt?: string | null;
}): DrawdownFloorResult | null {
  if (profile.drawdownType == null || profile.drawdownType === 'none') return null;
  const computed = drawdownFloor(snapshots, profile);
  const brokerHistory = snapshots.flatMap(snapshot => finite(snapshot.autoLiqLevel) ? [{
    at: snapshot.capturedAt,
    balance: snapshot.balance,
    floor: snapshot.autoLiqLevel,
    distance: snapshot.balance - snapshot.autoLiqLevel,
  }] : []);
  const liveFloor = liveAccount ? accountRiskFloor(liveAccount, profile) : null;
  const liveBalance = liveAccount?.balance.netLiq ?? liveAccount?.balance.totalCashValue ?? null;
  if (finite(liveFloor) && finite(liveBalance)) {
    const at = liveCapturedAt && Number.isFinite(Date.parse(liveCapturedAt))
      ? new Date(liveCapturedAt).toISOString() : new Date().toISOString();
    const history = brokerHistory.length > 0 ? brokerHistory : [...(computed?.history ?? [])];
    history.push({ at, balance: liveBalance, floor: liveFloor, distance: liveBalance - liveFloor });
    return {
      floor: liveFloor,
      balance: liveBalance,
      distance: liveBalance - liveFloor,
      highWatermark: accountRiskPeak(liveAccount, profile) ?? liveFloor + (profile.maxLoss ?? 0),
      highWatermarkBasis: profile.drawdownType === 'static' ? 'static'
        : profile.drawdownType === 'trailing' ? 'intraday' : 'eod',
      history,
    };
  }
  const latestBroker = brokerHistory.at(-1);
  if (latestBroker) {
    return {
      floor: latestBroker.floor,
      balance: latestBroker.balance,
      distance: latestBroker.distance,
      highWatermark: latestBroker.floor + (profile.maxLoss ?? 0),
      highWatermarkBasis: profile.drawdownType === 'static' ? 'static'
        : profile.drawdownType === 'trailing' ? 'intraday' : 'eod',
      history: brokerHistory,
    };
  }
  return computed;
}

export interface AccountCockpitModel {
  accountId: string;
  balance: number | null;
  todayPnl: number | null;
  equity: number[];
  dailyLimit: LimitUsage | null;
  drawdown: (DrawdownFloorResult & { usage: LimitUsage }) | null;
  breached: boolean;
  breachAt?: string;
  breachDate?: string;
  profitDays: ProfitDayProgress | null;
  consistency: ConsistencyCheck | null;
  payout: PayoutEligibility | null;
  evaluation: EvaluationProgress | null;
  risk: RiskLevel;
}

const riskRank: Record<RiskLevel, number> = { ok: 0, warning: 1, danger: 2 };

const higherRisk = (...levels: Array<RiskLevel | null | undefined>): RiskLevel =>
  levels.reduce<RiskLevel>((highest, level) => level && riskRank[level] > riskRank[highest] ? level : highest, 'ok');

export function buildAccountCockpitModel({
  account,
  rows,
  profile,
  rules,
  liveAccount,
  liveCapturedAt,
  now = new Date(),
}: {
  account: Account;
  rows: readonly CopierAccountSnapshotRow[];
  profile: TradovateAccountProfile | null;
  rules: FirmPayoutRules | null;
  liveAccount?: TradovateAccountDataAccount | null;
  liveCapturedAt?: string | null;
  now?: Date;
}): AccountCockpitModel {
  const ordered = rows
    .filter(row => row.connection_id === account.oauth?.connectionId
      && row.external_account_id === account.oauth?.externalAccountId)
    .sort((left, right) => Date.parse(left.captured_at) - Date.parse(right.captured_at));
  const snapshots = ordered.map(row => ({
    capturedAt: row.captured_at,
    balance: row.balance,
    autoLiqLevel: row.auto_liq_level,
  }));
  const ledger = dailyLedger(snapshots);
  const today = ledger.find(day => day.date === chicagoTradingDate(now));
  const balance = ordered.at(-1)?.balance ?? null;
  const todayPnl = today?.pnl ?? null;

  const dailyLimit = todayPnl != null && profile?.dailyLossLimit != null
    ? dailyLimitUsage(todayPnl, profile.dailyLossLimit) : null;
  const floor = profile ? resolveCockpitDrawdown({ snapshots, profile, liveAccount, liveCapturedAt }) : null;
  const floorUsage = floor && profile?.maxLoss != null ? drawdownUsage(floor, profile.maxLoss) : null;
  const drawdown = floor && floorUsage ? { ...floor, usage: floorUsage } : null;
  const breach = floor ? breachDetector(snapshots, floor) : { breached: false as const };

  const consistencyRules = account.phase !== 'Funded' && profile?.consistencyPct != null
    ? {
      planName: profile.planName ?? 'Evaluation', profitDaysRequired: null, minProfitPerDayUsd: null,
      minPayoutUsd: null, maxPayoutUsd: null, withdrawablePctOfProfit: null,
      minBalanceToRequestUsd: null, payoutCycleDays: null, splitPct: null, drawdownType: null,
      ...(rules ?? {}), consistencyPct: rules?.consistencyPct ?? profile.consistencyPct,
    } satisfies FirmPayoutRules
    : rules;
  const consistency = consistencyRules?.consistencyPct != null ? consistencyCheck(ledger, consistencyRules) : null;
  const profitDays = account.phase === 'Funded' && rules ? profitDayProgress(ledger, rules) : null;
  const withdrawable = balance != null && profile?.accountSize != null
    ? withdrawableProfit(balance, profile.accountSize) : null;
  const hasPayoutRule = Boolean(rules && (rules.profitDaysRequired != null || rules.minPayoutUsd != null
    || rules.maxPayoutUsd != null || rules.payoutCycleDays != null
    || rules.withdrawablePctOfProfit != null || rules.minBalanceToRequestUsd != null));
  const payout = account.phase === 'Funded' && rules && hasPayoutRule && withdrawable != null
    ? payoutEligibility(ledger, rules, withdrawable, balance) : null;
  const evaluation = account.phase !== 'Funded' && balance != null
    && profile?.accountSize != null && profile.profitTarget != null
    ? evaluationProgress(balance, profile.accountSize, profile.profitTarget) : null;
  const consistencyRisk: RiskLevel | null = consistency?.limit == null ? null
    : consistency.breached ? 'danger'
      : consistency.pct >= consistency.limit * 0.8 ? 'warning' : 'ok';

  return {
    accountId: account.id,
    balance,
    todayPnl,
    equity: ordered.map(row => row.balance),
    dailyLimit,
    drawdown,
    breached: breach.breached,
    ...(breach.at ? { breachAt: breach.at } : {}),
    ...(breach.at ? { breachDate: chicagoTradingDate(breach.at) } : {}),
    profitDays,
    consistency,
    payout,
    evaluation,
    risk: higherRisk(breach.breached ? 'danger' : null, dailyLimit?.level, drawdown?.usage.level, consistencyRisk),
  };
}

export function sortAccountsRiskFirst(accounts: readonly Account[], models: ReadonlyMap<string, AccountCockpitModel>): Account[] {
  return [...accounts].sort((left, right) => {
    const riskDifference = riskRank[models.get(right.id)?.risk ?? 'ok'] - riskRank[models.get(left.id)?.risk ?? 'ok'];
    if (riskDifference) return riskDifference;
    const leftMaster = left.parentAccountId ? 1 : 0;
    const rightMaster = right.parentAccountId ? 1 : 0;
    return leftMaster - rightMaster || left.name.localeCompare(right.name, 'cs', { numeric: true });
  });
}

export function summarizeAccountCockpit(models: readonly AccountCockpitModel[]) {
  const withBalance = models.filter(model => model.balance != null);
  const payoutCandidates = models
    .filter(model => model.payout && model.payout.missing.profitDays == null && model.payout.missing.amountUsd != null)
    .sort((left, right) => left.payout!.missing.amountUsd! - right.payout!.missing.amountUsd!);
  const ready = models.find(model => model.payout?.eligible);
  return {
    totalEquity: withBalance.length ? withBalance.reduce((sum, model) => sum + model.balance!, 0) : null,
    todayPnl: models.some(model => model.todayPnl != null)
      ? models.reduce((sum, model) => sum + (model.todayPnl ?? 0), 0) : null,
    riskCount: models.filter(model => model.risk !== 'ok').length,
    payoutCandidate: ready ? { accountId: ready.accountId, amountUsd: 0 }
      : payoutCandidates[0] ? { accountId: payoutCandidates[0].accountId, amountUsd: payoutCandidates[0].payout!.missing.amountUsd! }
        : null,
  };
}
