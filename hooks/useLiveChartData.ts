import { useMemo } from 'react';
import type { TradovateAccountDataResult } from '../lib/tradovateAccountDataTypes';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import type { LiveAccount } from '../services/tradecopiaLiveService';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { overlayWorkerExposure, WORKER_EXPOSURE_MAX_AGE_MS } from '../lib/tradovateWorkerExposureOverlay';
import { tradovateCopyTradeOrders, tradovateCopyTradeSnapshot } from '../lib/tradovateCopyTradeBridge';
import { tradeCardFeeRates } from '../lib/liveTradeCard';
import { buildLiveTradeGroup, liveChartDisarm, liveTradeGroupKey, type LiveChartDisarm } from '../lib/liveTradeGroupSource';
import { liveChartPosition, NO_LIVE_CHART_POSITION, type LiveChartPosition } from '../lib/liveChartPosition';
import type { JournalLiveTarget } from '../lib/journalLivePosition';
import type { LiveTradeGroup, LiveTradeTarget } from '../lib/liveTradeTarget';
import { useLiveTradeCardView } from './useLiveTradeCardView';

/**
 * Data LIVE → Graf ze stejných vstupů jako přehled LIVE (jen zobrazení):
 * skupina a účty, živá pozice zvoleného cíle a stav tlačítka Vypnout.
 * Volá ho desk; obrazovka grafu dostane jen hotové modely.
 */
export function useLiveChartData(input: {
  enabled: boolean;
  data: TradovateAccountDataResult | null;
  profiles: TradovateAccountProfile[];
  agentStatus: LocalCopierAgentStatus | null;
  /** Kdy přišel pollovaný status — čerstvost workeru (verdikty, zapnutost kopírky). */
  agentStatusObservedAt: number | null;
  /** Stáří zobrazené expozice (F2a: novější z kanálu, jinak = agentStatusObservedAt); jen overlay pozic. */
  exposureObservedAt?: number | null;
  /** Čerstvý stav této instance (`armStatusRef.fresh`: ne obnovený, ne po grace). */
  statusFresh: boolean;
  /** Účty se zobrazovacími hodnotami přehledu (dnešní výsledek, limit). */
  displayAccounts: readonly LiveAccount[];
  group: CopyGroupConfig | null;
  nameOf: (accountId: number) => string;
  root: string;
  target: LiveTradeTarget;
  now: number;
}): { group: LiveTradeGroup | null; groupKey: string; position: LiveChartPosition; disarm: LiveChartDisarm | null } {
  const { enabled, data, profiles, agentStatus, agentStatusObservedAt, statusFresh, group, now } = input;
  const exposureObservedAt = input.exposureObservedAt === undefined ? agentStatusObservedAt : input.exposureObservedAt;
  // Pozice z heartbeatu jen do 8 s podle hodin desku (ne až s dalšími daty).
  const chartData = useMemo(
    () => (enabled ? overlayWorkerExposure(data, agentStatus, exposureObservedAt, now) : null),
    [enabled, data, agentStatus, exposureObservedAt, now],
  );
  const accounts = useMemo(() => (chartData ? tradovateCopyTradeSnapshot(chartData, profiles).accounts : []), [chartData, profiles]);
  const orders = useMemo(() => (chartData ? tradovateCopyTradeOrders(chartData) : []), [chartData]);
  const feeRates = useMemo(() => (chartData ? tradeCardFeeRates(chartData.accounts) : new Map<string, number>()), [chartData]);
  const controller = agentStatus?.controller ?? null;

  const tradeGroup = useMemo(() => (enabled ? buildLiveTradeGroup({
    group,
    controller,
    statusFresh,
    displayAccounts: input.displayAccounts,
    positionAccounts: accounts,
    orders,
    nameOf: input.nameOf,
    root: input.root,
    now,
  }) : null), [enabled, group, controller, statusFresh, input.displayAccounts, accounts, orders, input.nameOf, input.root, now]);
  const groupKey = liveTradeGroupKey(tradeGroup);

  // Pohled na pozici: skupina jen z kopírujících účtů (vyřazený follower
  // s vlastní pozicí do souhrnu nepatří), účet mimo skupinu sám za sebe.
  const excludedKey = statusFresh ? (controller?.excludedForeignFollowers ?? []).join(',') : '';
  const { viewGroup, requested } = useMemo<{ viewGroup: CopyGroupConfig | null; requested: JournalLiveTarget }>(() => {
    const excluded = new Set(excludedKey ? excludedKey.split(',').map(Number) : []);
    const inCopy = group ? { ...group, followers: group.followers.filter(follower => !excluded.has(follower.accountId)) } : null;
    if (input.target.kind === 'group') return { viewGroup: inCopy, requested: 'group' };
    const accountId = Number(input.target.accountId);
    const member = group && (group.leaderAccountId === accountId || group.followers.some(follower => follower.accountId === accountId));
    if (member) return { viewGroup: group, requested: accountId };
    return {
      viewGroup: { id: `outside:${accountId}`, name: 'Účet mimo skupinu', enabled: true, leaderAccountId: accountId, followers: [] },
      requested: accountId,
    };
  }, [group, excludedKey, input.target]);
  const workerFresh = statusFresh && agentStatusObservedAt != null && now - agentStatusObservedAt <= WORKER_EXPOSURE_MAX_AGE_MS;
  const view = useLiveTradeCardView({
    active: enabled && viewGroup != null,
    accounts,
    orders,
    feeRates,
    group: viewGroup,
    target: requested,
    worker: workerFresh ? agentStatus : null,
    now,
  });
  const position = useMemo(
    () => (enabled && viewGroup ? liveChartPosition(view, requested) : NO_LIVE_CHART_POSITION),
    [enabled, viewGroup, view, requested],
  );
  const disarm = liveChartDisarm(controller, statusFresh);
  return { group: tradeGroup, groupKey, position, disarm };
}
