import type { TradovateAccountDataAccount } from '../lib/tradovateAccountDataTypes';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import { accountDisplayName, buildTradovateLiveActivity, profileMap } from '../lib/tradovateLiveView';
import type { Account, Trade } from '../types';
import { isNativeBuild } from '../utils/runtimeConfig';
import { alphaTradeNativePlugin } from './alphaTradeNativePlugin';
import {
  endNativeLiveActivity,
  getNativeLiveActivityState,
  startNativeLiveActivity,
  updateNativeLiveActivity,
  type NativeLiveActivityPayload,
} from './nativeCapabilities';
import type { CopierControllerStatus } from './copierRuntimeController';
import { scheduleNativeNotification } from './nativeNotifications';
import { planNativeWidgetLocalAlerts } from './nativeWidgetNotificationPlan';
import {
  BROKER_ACCOUNTS_DAILY_PNL_LABEL,
  COPIER_LEADER_DAILY_STATS_LABEL,
} from '../lib/copierDailyStatsLabels';

const STORAGE_KEY = 'alphatrade-native-widget-snapshot-v2';
const MAX_ACCOUNTS = 6;
const MAX_EQUITY_POINTS = 30;
const MAX_RECENT_TRADES = 5;
const SNAPSHOT_HEARTBEAT_MS = 60_000;

export interface NativeWidgetAccount {
  id: string;
  name: string;
  balance: number;
  pnl: number;
  openPnl: number;
  locked: boolean;
  lockReason: string | null;
}

export interface NativeWidgetTrade {
  id: string;
  symbol: string;
  side: 'Long' | 'Short';
  pnl: number;
  quantity: number | null;
  timestamp: number;
}

export interface NativeWidgetPosition {
  accountName: string;
  symbol: string;
  side: 'Long' | 'Short';
  quantity: number;
  averagePrice: number | null;
}

export interface NativeWidgetJournalState {
  dayPnl: number;
  dayR: number;
  tradeCount: number;
  riskPercent: number;
  discipline: number;
  equity: number[];
  accounts: NativeWidgetAccount[];
  recentTrades: NativeWidgetTrade[];
}

export interface NativeWidgetLiveState {
  connected: boolean;
  armed: boolean;
  shadowMode: boolean;
  killSwitch: boolean;
  status: string;
  statusDetail: string;
  armExpiresAt: number;
  cooldownUntil: number;
  dayLockUntil: number;
  dayLockReason: string | null;
  dailyRealizedPnl: number | null;
  dailyRealizedPnlLabel: typeof COPIER_LEADER_DAILY_STATS_LABEL;
  accountsRealizedPnl: number;
  accountsRealizedPnlLabel: typeof BROKER_ACCOUNTS_DAILY_PNL_LABEL;
  losingTrades: number;
  followerCount: number;
  openPositionCount: number;
  workingOrderCount: number;
  realizedPnl: number;
  openPnl: number;
  totalPnl: number;
  accounts: NativeWidgetAccount[];
  positions: NativeWidgetPosition[];
  recentTrades: NativeWidgetTrade[];
}

export interface NativeWidgetSnapshotV2 {
  version: 2;
  updatedAt: number;
  journal: NativeWidgetJournalState | null;
  live: NativeWidgetLiveState | null;
}

const finite = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const localDay = (value: Date): string => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const tradeDay = (trade: Trade): string => trade.exitDate || trade.date || trade.entryDate || '';

const isLiveJournalAccount = (account: Account): boolean => account.type !== 'Backtest' && !account.isArchived;

export function buildNativeJournalWidgetState(options: {
  trades: readonly Trade[];
  accounts: readonly Account[];
  now?: Date;
}): NativeWidgetJournalState {
  const now = options.now ?? new Date();
  const today = localDay(now);
  const liveAccounts = options.accounts.filter(isLiveJournalAccount);
  const accountIds = new Set(liveAccounts.map(account => account.id));
  const trades = options.trades
    .filter(trade => accountIds.has(trade.accountId))
    .slice()
    .sort((a, b) => finite(a.timestamp) - finite(b.timestamp));
  const todayTrades = trades.filter(trade => tradeDay(trade) === today);
  const dayPnl = todayTrades.reduce((sum, trade) => sum + finite(trade.pnl), 0);
  const dayR = todayTrades.reduce((sum, trade) => {
    const risk = finite(trade.riskAmount);
    return sum + (risk > 0 ? finite(trade.pnl) / risk : 0);
  }, 0);
  const riskValues = todayTrades
    .map(trade => finite(trade.riskPercent, NaN))
    .filter(Number.isFinite);
  const disciplineValues = todayTrades.map(trade => {
    if (trade.planAdherence === 'Yes') return 100;
    if (trade.planAdherence === 'Partial') return 50;
    if (trade.planAdherence === 'No' || trade.isValid === false) return 0;
    return trade.isValid === true ? 100 : 50;
  });

  const startingBalance = liveAccounts.reduce((sum, account) => sum + finite(account.initialBalance), 0);
  let running = startingBalance;
  const equity = [running];
  for (const trade of trades) {
    running += finite(trade.pnl);
    equity.push(running);
  }

  const accounts = liveAccounts.map(account => {
    const accountTrades = trades.filter(trade => trade.accountId === account.id);
    const accountDayPnl = accountTrades
      .filter(trade => tradeDay(trade) === today)
      .reduce((sum, trade) => sum + finite(trade.pnl), 0);
    return {
      id: account.id,
      name: account.name,
      balance: finite(account.initialBalance) + accountTrades.reduce((sum, trade) => sum + finite(trade.pnl), 0),
      pnl: accountDayPnl,
      openPnl: 0,
      locked: account.status !== 'Active',
      lockReason: account.status !== 'Active' ? `Účet je ${account.status.toLowerCase()}` : null,
    };
  }).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, MAX_ACCOUNTS);

  const recentTrades = trades.slice(-MAX_RECENT_TRADES).reverse().map(trade => ({
    id: String(trade.id),
    symbol: trade.instrument || trade.symbol || 'NQ',
    side: trade.direction,
    pnl: finite(trade.pnl),
    quantity: typeof trade.positionSize === 'number' && Number.isFinite(trade.positionSize)
      ? trade.positionSize
      : null,
    timestamp: finite(trade.timestamp),
  }));

  return {
    dayPnl,
    dayR,
    tradeCount: todayTrades.length,
    riskPercent: riskValues.length > 0
      ? Math.round(riskValues.reduce((sum, value) => sum + value, 0) / riskValues.length)
      : 0,
    discipline: disciplineValues.length > 0
      ? Math.round(disciplineValues.reduce((sum, value) => sum + value, 0) / disciplineValues.length)
      : 100,
    equity: equity.slice(-MAX_EQUITY_POINTS),
    accounts,
    recentTrades,
  };
}

function liveStatus(controller: CopierControllerStatus | null, now: number): Pick<NativeWidgetLiveState, 'status' | 'statusDetail'> {
  if (!controller) return { status: 'ČEKÁ NA WORKER', statusDetail: 'Otevři LIVE a ověř spojení.' };
  if (controller.killSwitch) return { status: 'KILL SWITCH', statusDetail: controller.lastError || 'Runtime je bezpečně zastavený.' };
  if (!controller.connected) return { status: 'BROKER OFFLINE', statusDetail: 'Tradovate spojení není dostupné.' };
  if (controller.stuckOutbox) return { status: 'STUCK OUTBOX', statusDetail: 'Nejasná operace blokuje další ARM.' };
  if ((controller.dayLockUntil ?? 0) > now) return { status: 'DAY-LOCK', statusDetail: controller.dayLockReason || 'ARM je zablokovaný do konce session.' };
  if ((controller.entryCooldownUntil ?? 0) > now) return { status: 'COOLDOWN', statusDetail: 'Anti-revenge cooldown je aktivní.' };
  if (controller.armed && controller.shadowMode) return { status: 'SHADOW', statusDetail: 'Kopírka jen sleduje; objednávky neodesílá.' };
  if (controller.armed) return { status: 'ARM LIVE', statusDetail: 'Kopírování je aktivní.' };
  return { status: 'DISARMED', statusDetail: 'Kopírování stojí.' };
}

export function buildNativeLiveWidgetState(options: {
  accounts: readonly TradovateAccountDataAccount[];
  profiles: readonly TradovateAccountProfile[];
  controller: CopierControllerStatus | null;
  followerCount: number;
  now?: number;
}): NativeWidgetLiveState {
  const now = options.now ?? Date.now();
  const names = profileMap([...options.profiles]);
  const dayLocked = (options.controller?.dayLockUntil ?? 0) > now;
  const accounts = options.accounts.map(account => {
    const realized = finite(account.balance.realizedPnL);
    const openPnl = finite(account.balance.openPnL);
    const pnl = account.balance.totalPnL == null ? realized + openPnl : finite(account.balance.totalPnL);
    const locked = dayLocked || account.risk.changesLocked === true || !account.canTrade;
    return {
      id: String(account.id),
      name: accountDisplayName(account, names),
      balance: finite(account.balance.netLiq ?? account.balance.totalCashValue),
      pnl,
      openPnl,
      locked,
      lockReason: dayLocked
        ? options.controller?.dayLockReason || 'DAY-LOCK'
        : account.risk.changesLocked === true
          ? 'Změny účtu jsou zamčené brokerem'
          : !account.canTrade ? 'Účet nemůže obchodovat' : null,
    };
  }).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, MAX_ACCOUNTS);

  const positions = options.accounts.flatMap(account => account.positions
    .filter(position => position.netPosition !== 0)
    .map(position => ({
      accountName: accountDisplayName(account, names),
      symbol: position.symbol || 'NQ',
      side: position.netPosition > 0 ? 'Long' as const : 'Short' as const,
      quantity: Math.abs(position.netPosition),
      averagePrice: position.averagePrice,
    }))).slice(0, MAX_ACCOUNTS);
  // Widget P&L and its edge-triggered notification must only use a fully
  // paired, broker-confirmed close. Raw entry/exit fills are useful in LIVE,
  // but treating them as completed trades would create a misleading $0 P&L
  // notification while a position is merely being opened.
  const activity = buildTradovateLiveActivity([...options.accounts], MAX_RECENT_TRADES * 3)
    .filter(event => event.kind === 'trade' && event.semantic === 'trade-closed')
    .slice(0, MAX_RECENT_TRADES);
  const recentTrades = activity.slice(0, MAX_RECENT_TRADES).map(event => ({
    id: event.id,
    symbol: event.symbol || 'NQ',
    side: event.side || 'Long',
    pnl: finite(event.pnl),
    quantity: event.quantity,
    timestamp: Date.parse(event.timestamp),
  }));
  const realizedPnl = options.accounts.reduce((sum, account) => sum + finite(account.balance.realizedPnL), 0);
  const openPnl = options.accounts.reduce((sum, account) => sum + finite(account.balance.openPnL), 0);
  const status = liveStatus(options.controller, now);

  return {
    connected: options.controller?.connected === true,
    armed: options.controller?.armed === true,
    shadowMode: options.controller?.shadowMode === true,
    killSwitch: options.controller?.killSwitch === true,
    ...status,
    armExpiresAt: options.controller?.armExpiresAt ?? 0,
    cooldownUntil: options.controller?.entryCooldownUntil ?? 0,
    dayLockUntil: options.controller?.dayLockUntil ?? 0,
    dayLockReason: options.controller?.dayLockReason ?? null,
    dailyRealizedPnl: options.controller?.dailyStats?.realizedPnlUsd ?? null,
    dailyRealizedPnlLabel: COPIER_LEADER_DAILY_STATS_LABEL,
    accountsRealizedPnl: realizedPnl,
    accountsRealizedPnlLabel: BROKER_ACCOUNTS_DAILY_PNL_LABEL,
    losingTrades: options.controller?.dailyStats?.losingTrades ?? 0,
    followerCount: Math.max(0, Math.floor(options.followerCount)),
    openPositionCount: positions.length,
    workingOrderCount: options.accounts.reduce((sum, account) => sum + account.workingOrderCount, 0),
    realizedPnl,
    openPnl,
    totalPnl: realizedPnl + openPnl,
    accounts,
    positions,
    recentTrades,
  };
}

function loadSnapshot(): NativeWidgetSnapshotV2 {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '') as NativeWidgetSnapshotV2;
    if (parsed?.version === 2) return parsed;
  } catch {
    // Fresh install or an old/corrupt local cache starts empty.
  }
  return { version: 2, updatedAt: 0, journal: null, live: null };
}

async function persistSnapshot(snapshot: NativeWidgetSnapshotV2): Promise<void> {
  if (!isNativeBuild) return;
  const snapshotJson = JSON.stringify(snapshot);
  localStorage.setItem(STORAGE_KEY, snapshotJson);
  await alphaTradeNativePlugin.updateWidgetSnapshot({ snapshotJson });
}

export async function syncNativeJournalWidgetSnapshot(state: NativeWidgetJournalState): Promise<void> {
  if (!isNativeBuild) return;
  const fingerprint = JSON.stringify(state);
  if (fingerprint === lastJournalSnapshotFingerprint) return;
  await persistSnapshot({ ...loadSnapshot(), updatedAt: Date.now(), journal: state });
  lastJournalSnapshotFingerprint = fingerprint;
}

let lastJournalSnapshotFingerprint = '';
let lastLiveSnapshotFingerprint = '';
let lastLiveActivityFingerprint = '';
let liveActivityBusy = false;

const signedMoney = (value: number): string => `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`;

function liveActivityPayload(live: NativeWidgetLiveState): NativeLiveActivityPayload {
  const position = live.positions[0];
  const lockText = live.dayLockUntil > Date.now() ? ' · DAY-LOCK' : '';
  return {
    symbol: position?.symbol.toUpperCase().startsWith('MNQ') ? 'MNQ' : 'NQ',
    status: live.status,
    headline: position
      ? `${position.side.toUpperCase()} ${position.quantity} ${position.symbol}`
      : live.armed ? `ARM · ${live.followerCount} followerů` : live.statusDetail,
    detail: `${live.openPositionCount} pozic · ${live.workingOrderCount} příkazů · ${live.accountsRealizedPnlLabel}${lockText}`,
    pnlText: signedMoney(live.totalPnl),
    pnlLabel: live.openPositionCount > 0
      ? 'Účty (broker) · realizované + otevřené P&L'
      : live.accountsRealizedPnlLabel,
    isPositive: live.totalPnl >= 0,
    progress: live.killSwitch ? 1 : live.armed ? 0.75 : live.connected ? 0.35 : 0.1,
  };
}

async function syncLiveActivity(live: NativeWidgetLiveState): Promise<void> {
  if (liveActivityBusy) return;
  const shouldBeActive = live.armed || live.openPositionCount > 0 || live.dayLockUntil > Date.now() || live.killSwitch;
  const payload = liveActivityPayload(live);
  const fingerprint = JSON.stringify({ shouldBeActive, payload });
  if (fingerprint === lastLiveActivityFingerprint) return;
  liveActivityBusy = true;
  try {
    const state = await getNativeLiveActivityState();
    if (shouldBeActive) {
      if (state.activeCount > 0) await updateNativeLiveActivity(payload);
      else await startNativeLiveActivity(payload);
    } else if (state.activeCount > 0) {
      await endNativeLiveActivity();
    }
    lastLiveActivityFingerprint = fingerprint;
  } catch {
    // A disabled Live Activity must never disrupt the trading UI.
  } finally {
    liveActivityBusy = false;
  }
}

export async function syncNativeLiveWidgetSnapshot(state: NativeWidgetLiveState): Promise<void> {
  if (!isNativeBuild) return;
  const stored = loadSnapshot();
  const previous = stored.live;
  const fingerprint = JSON.stringify(state);
  if (fingerprint !== lastLiveSnapshotFingerprint || Date.now() - stored.updatedAt >= SNAPSHOT_HEARTBEAT_MS) {
    await persistSnapshot({ ...stored, updatedAt: Date.now(), live: state });
    lastLiveSnapshotFingerprint = fingerprint;
  }
  for (const alert of planNativeWidgetLocalAlerts(previous, state)) {
    await scheduleNativeNotification({
      title: alert.title,
      body: alert.body,
      delayMs: 1_000,
      route: 'live',
      threadIdentifier: alert.kind === 'trade' ? 'alphatrade-live-pnl' : 'alphatrade-account-locks',
      actionType: alert.kind,
      interruptionLevel: alert.kind === 'risk' ? 'timeSensitive' : 'active',
    }).catch(() => undefined);
  }
  await syncLiveActivity(state);
}

export async function clearNativeWidgetSnapshot(): Promise<void> {
  if (!isNativeBuild) return;
  localStorage.removeItem(STORAGE_KEY);
  await alphaTradeNativePlugin.clearWidgetSnapshot();
  await endNativeLiveActivity().catch(() => undefined);
}
