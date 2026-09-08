import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendApnsLiveActivityUpdate,
  type ApnsDevice,
  type ApnsLiveActivityContentState,
  type ApnsLiveActivityUpdate,
} from './apns.js';
import {
  loadNativeLiveActivityBrokerSnapshot,
  type NativeLiveActivityBrokerSnapshot,
} from './nativeLiveActivityBrokerSnapshot.js';
import { tradovateApiBaseUrl } from './tradovateOAuth.js';
import { marketSymbolRoot } from '../services/futuresContractSpecs.js';
import { tradovateValuePerPoint } from '../lib/tradovateLivePnl.js';
import {
  BROKER_ACCOUNTS_DAILY_PNL_LABEL,
  COPIER_LEADER_DAILY_STATS_LABEL,
} from '../lib/copierDailyStatsLabels.js';
import {
  getValidTradovateAccessToken,
  listConnectedTradovateConnectionIds,
  type TradovateServerConfig,
} from './tradovateOAuthStore.js';

export interface NativeLiveActivitySubscriptionRow {
  id: string;
  user_id: string;
  activity_id: string;
  push_token: string;
  environment: 'development' | 'production';
  bundle_id: string;
  last_payload_hash: string | null;
  last_payload_at: string | null;
}

export interface NativeLiveActivityRuntimeRow {
  device_id: string;
  user_id: string;
  connection_id: string;
  status: Record<string, unknown>;
  last_seen_at: string;
  started_at: string;
}

export interface NativeLiveActivityPlan {
  update: ApnsLiveActivityUpdate;
  payloadHash: string;
  shouldEnd: boolean;
  symbol: string;
}

export type NativeBrokerSnapshotLoader = (
  runtime: NativeLiveActivityRuntimeRow,
  options?: { allAccounts?: boolean },
) => Promise<NativeLiveActivityBrokerSnapshot | null>;

const finite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const bool = (value: unknown): boolean => value === true;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const signedMoney = (value: number): string =>
  `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`;
const optionalFinite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export interface NativeLiveActivityMarketPrice {
  symbol: string;
  price: number;
  at: number;
  continuous?: boolean;
}

/** Nejvyšší přijatelné stáří ceny z workeru (hodiny Macu vs. serveru, poll ≤ 1 s). */
export const LIVE_ACTIVITY_MARKET_PRICE_MAX_AGE_MS = 10_000;

/**
 * Cena z grafů TradingView pro čekající limit: stejný kořen kontraktu jako
 * vstup leadera, čerstvá; přesný kontrakt (`MNQU6`) má přednost před
 * kontinuálním `MNQ1!`, který se v rollover týdnu může lišit o spread.
 */
export function pickNativeLiveActivityMarketPrice(
  candidates: readonly unknown[],
  symbol: string,
  now: number,
): number | null {
  const root = marketSymbolRoot(symbol);
  const exact = symbol.trim().toUpperCase();
  const fresh = candidates.flatMap(candidate => {
    const row = object(candidate);
    const price = optionalFinite(row.price);
    const at = optionalFinite(row.at);
    if (typeof row.symbol !== 'string' || price == null || price <= 0 || at == null) return [];
    if (Math.abs(now - at) > LIVE_ACTIVITY_MARKET_PRICE_MAX_AGE_MS) return [];
    const candidateSymbol = row.symbol.trim().toUpperCase();
    if (marketSymbolRoot(candidateSymbol) !== root) return [];
    return [{ symbol: candidateSymbol, price, continuous: row.continuous === true || /\d!$/.test(candidateSymbol) }];
  });
  if (fresh.length === 0) return null;
  return (fresh.find(entry => entry.symbol === exact)
    ?? fresh.find(entry => !entry.continuous)
    ?? fresh[0]).price;
}

const controllerOf = (runtime: NativeLiveActivityRuntimeRow): Record<string, unknown> => {
  const root = object(runtime.status);
  return Object.keys(object(root.controller)).length > 0 ? object(root.controller) : root;
};

const groupOf = (runtime: NativeLiveActivityRuntimeRow): Record<string, unknown> =>
  object(object(runtime.status).group);

export function liveActivityAccountIds(runtime: NativeLiveActivityRuntimeRow): number[] {
  const group = groupOf(runtime);
  const leader = finite(group.leaderAccountId);
  const followers = Array.isArray(group.followers) ? group.followers : [];
  return [...new Set([
    ...(Number.isSafeInteger(leader) && leader > 0 ? [leader] : []),
    ...followers.flatMap(candidate => {
      const accountId = finite(object(candidate).accountId);
      return Number.isSafeInteger(accountId) && accountId > 0 ? [accountId] : [];
    }),
  ])];
}

/** Stavy, u kterých musí uživatel zasáhnout — na kartě vyhrává jejich důvod. */
const CRITICAL_STATUSES = new Set(['DIVERGENCE', 'KILL SWITCH', 'STUCK OUTBOX']);

function statusText(runtime: NativeLiveActivityRuntimeRow, now: number): { status: string; detail: string } {
  const controller = controllerOf(runtime);
  const lastSeen = Date.parse(runtime.last_seen_at);
  if (!Number.isFinite(lastSeen) || lastSeen > now + 30_000 || now - lastSeen > 90_000) {
    return { status: 'WORKER OFFLINE', detail: 'Heartbeat je starší než 90 sekund.' };
  }
  if (bool(controller.killSwitch)) return { status: 'KILL SWITCH', detail: String(controller.lastError || 'Runtime je zastavený.') };
  // Divergence je jediný stav, který vyžaduje okamžitý ruční zásah: follower
  // drží jinou pozici než leader. Controller se u ní sám odzbrojí, takže bez
  // vlastního stavu by se na zamčené obrazovce ukázalo jen neutrální DISARMED.
  const divergent = Array.isArray(controller.divergentAccounts) ? controller.divergentAccounts : [];
  if (divergent.length > 0) {
    return {
      status: 'DIVERGENCE',
      detail: divergent.length === 1
        ? 'Jeden účet drží jinou pozici než leader.'
        : `${divergent.length} účtů drží jinou pozici než leader.`,
    };
  }
  if (controller.connected === false) return { status: 'BROKER OFFLINE', detail: 'Tradovate spojení není dostupné.' };
  if (bool(controller.stuckOutbox)) return { status: 'STUCK OUTBOX', detail: 'Nejasná operace blokuje další ARM.' };
  if (finite(controller.dayLockUntil) > now) return { status: 'DAY-LOCK', detail: String(controller.dayLockReason || 'Denní zámek je aktivní.') };
  if (finite(controller.entryCooldownUntil) > now) return { status: 'COOLDOWN', detail: 'Anti-revenge cooldown je aktivní.' };
  if (bool(controller.armed) && bool(controller.shadowMode)) return { status: 'SHADOW', detail: 'Kopírka pouze sleduje.' };
  if (bool(controller.armed)) return { status: 'ARM LIVE', detail: 'Kopírování je aktivní.' };
  return { status: 'DISARMED', detail: 'Kopírování stojí.' };
}

function positionHeadline(snapshot: NativeLiveActivityBrokerSnapshot | null): { headline: string | null; symbol: string | null } {
  if (!snapshot || snapshot.positions.length === 0) return { headline: null, symbol: null };
  const first = snapshot.positions[0];
  const same = snapshot.positions.every(position => position.side === first.side && position.symbol === first.symbol);
  if (!same) return {
    headline: `${snapshot.positions.length} otevřených pozic`,
    symbol: first.symbol,
  };
  const quantity = snapshot.positions.reduce((sum, position) => sum + position.quantity, 0);
  return {
    headline: `${first.side.toUpperCase()} ${quantity} ${first.symbol ?? 'kontraktů'} · ${snapshot.positions.length} účtů`,
    symbol: first.symbol,
  };
}

/** Pure, deterministic conversion from authoritative runtime/broker state. */
export function planNativeLiveActivityUpdate(options: {
  runtime: NativeLiveActivityRuntimeRow;
  broker: NativeLiveActivityBrokerSnapshot | null;
  now: number;
}): NativeLiveActivityPlan {
  const controller = controllerOf(options.runtime);
  const status = statusText(options.runtime, options.now);
  const position = positionHeadline(options.broker);
  const group = groupOf(options.runtime);
  const followerCount = Array.isArray(group.followers) ? group.followers.length : 0;
  const followerIds = (Array.isArray(group.followers) ? group.followers : []).flatMap(candidate => {
    const accountId = optionalFinite(object(candidate).accountId);
    return accountId != null ? [accountId] : [];
  });
  const recentEvents = Array.isArray(controller.recentCopyEvents) ? controller.recentCopyEvents : [];
  const lastEvent = object(recentEvents[recentEvents.length - 1]);
  const fallbackSymbol = typeof lastEvent.symbol === 'string' && lastEvent.symbol.trim()
    ? lastEvent.symbol.trim()
    : 'MNQ';
  const dailyStats = object(controller.dailyStats);
  const openPositionCount = options.broker?.positions.length ?? 0;
  const brokerPnl = openPositionCount > 0 && options.broker?.completeOpenPnl === true
    ? options.broker.openPnl
    : options.broker?.realizedPnl;
  const pnlAvailable = options.broker != null
    ? (openPositionCount > 0 && options.broker.completeOpenPnl
      ? true : options.broker.completeRealizedPnl !== false)
    : optionalFinite(dailyStats.realizedPnlUsd) != null;
  const pnl = brokerPnl ?? finite(dailyStats.realizedPnlUsd);
  const workingOrderCount = options.broker?.workingOrderCount
    ?? (Array.isArray(controller.workingOrderAccounts) ? controller.workingOrderAccounts.length : 0);
  const firstPosition = options.broker?.positions[0];
  const homogeneousPosition = firstPosition != null
    && options.broker?.positions.every(item => item.symbol === firstPosition.symbol && item.side === firstPosition.side);
  // Zobrazovaná velikost = leaderův obchod (uživatel myslí ve „12 MNQ",
  // ne v součtu přes followery). Bez leaderovy pozice (osiřelé kopie)
  // se ukáže celková expozice — ta je v tu chvíli to podstatné.
  const leaderAccountId = optionalFinite(group.leaderAccountId);
  const leaderQuantity = homogeneousPosition && leaderAccountId != null
    ? options.broker?.positions
      .filter(item => item.accountId === leaderAccountId)
      .reduce((sum, item) => sum + item.quantity, 0)
    : undefined;
  const positionQuantity = homogeneousPosition
    ? (leaderQuantity && leaderQuantity > 0
      ? leaderQuantity
      : options.broker?.positions.reduce((sum, item) => sum + item.quantity, 0))
    : undefined;
  const entryPrice = homogeneousPosition
    ? optionalFinite(firstPosition.entryPrice)
    : null;
  // Čekající vstup leadera (K2): příčka SL → limit → TP a riziko / cíl
  // z bracketu, ještě než je pozice. Cena před fillem je jen z TradingView
  // (worker status), v pozici zůstává autoritativní broker P&L.
  const pending = openPositionCount === 0 ? options.broker?.pendingOrder : null;
  const marketPrices = Array.isArray(object(options.runtime.status).marketPrices)
    ? object(options.runtime.status).marketPrices as unknown[]
    : [];
  const currentPrice = homogeneousPosition
    ? optionalFinite(firstPosition.currentPrice)
    : pending ? pickNativeLiveActivityMarketPrice(marketPrices, pending.symbol, options.now) : null;
  const stopPrice = homogeneousPosition
    ? optionalFinite(firstPosition.stopPrice)
    : optionalFinite(pending?.stopPrice);
  const targetPrice = homogeneousPosition
    ? optionalFinite(firstPosition.targetPrice)
    : optionalFinite(pending?.targetPrice);
  const slTpProgress = currentPrice != null && stopPrice != null && targetPrice != null
    && stopPrice !== targetPrice
    ? Math.min(1, Math.max(0, (currentPrice - stopPrice) / (targetPrice - stopPrice)))
    : null;
  // Progress bar ukazuje, KDE cena je; tohle ukazuje, CO to stojí. Sčítá se
  // přes všechny účty skupiny, protože v sázce je celá expozice, ne jen
  // leaderova pozice, kterou karta zobrazuje jako velikost obchodu.
  const pnlAtLevel = (level: 'stop' | 'target'): number | null => {
    const levelPrice = level === 'stop' ? stopPrice : targetPrice;
    if (levelPrice == null) return null;
    if (!homogeneousPosition) {
      if (!pending) return null;
      const valuePerPoint = tradovateValuePerPoint(pending.symbol);
      const quantity = pending.groupQuantity ?? pending.quantity;
      if (valuePerPoint == null || !(quantity > 0)) return null;
      return (levelPrice - pending.price) * (pending.side === 'Sell' ? -1 : 1) * quantity * valuePerPoint;
    }
    const valuePerPoint = tradovateValuePerPoint(firstPosition.symbol ?? null);
    if (valuePerPoint == null) return null;
    const positions = options.broker?.positions ?? [];
    const levelOf = (item: { stopPrice?: number | null; targetPrice?: number | null }) =>
      optionalFinite(level === 'stop' ? item.stopPrice : item.targetPrice);
    if (positions.some(item => optionalFinite(item.entryPrice) == null || levelOf(item) == null)) return null;
    return positions.reduce((sum, item) => {
      const entry = optionalFinite(item.entryPrice) ?? entryPrice;
      const price = levelOf(item) ?? levelPrice;
      if (entry == null || price == null || !(item.quantity > 0)) return sum;
      return sum + (price - entry) * (item.side === 'Short' ? -1 : 1) * item.quantity * valuePerPoint;
    }, 0);
  };
  const riskAtStop = pnlAtLevel('stop');
  const pnlAtTarget = pnlAtLevel('target');
  const signedWhole = (value: number): string => `${value < 0 ? '−' : '+'}$${Math.abs(Math.round(value))}`;
  // Denní přehled pro obrazovky mimo pozici: uzavřené obchody dne z copier
  // ledgeru workeru, limity ze safety skupiny (0 = pravidlo vypnuté),
  // cooldown / zámek / zapnutí jako epoch sekundy pro lokální odpočty.
  const safety = object(group.safety);
  const closedToday = (Array.isArray(dailyStats.recentClosedTrades) ? dailyStats.recentClosedTrades : [])
    .map(candidate => object(candidate))
    .filter(trade => optionalFinite(trade.closedAt) != null && optionalFinite(trade.realizedPnlUsd) != null)
    .sort((left, right) => finite(left.closedAt) - finite(right.closedAt))
    .slice(-8)
    .map(trade => ({
      pnl: Math.round(finite(trade.realizedPnlUsd) * 100) / 100,
      exit: trade.exitReason === 'sl' ? 'SL' as const : trade.exitReason === 'tp' ? 'TP' as const : 'M' as const,
      closedAt: finite(trade.closedAt) / 1_000,
    }));
  const tradesToday = optionalFinite(dailyStats.tradesToday) ?? (closedToday.length > 0 ? closedToday.length : null);
  const losingTrades = optionalFinite(dailyStats.losingTrades);
  const dayPnl = optionalFinite(dailyStats.realizedPnlUsd);
  const limitOf = (value: unknown): number | null => {
    const parsed = optionalFinite(value);
    return parsed != null && parsed > 0 ? parsed : null;
  };
  const maxLosingTrades = limitOf(safety.dailyMaxLosingTrades);
  const dailyLossLimitUsd = limitOf(safety.dailyLossLimitUsd);
  const maxTrades = limitOf(safety.dailyMaxTrades);
  const armedAtMs = bool(controller.armed) ? optionalFinite(controller.armedAt) : null;
  const sessionEndAtMs = optionalFinite(dailyStats.sessionEndAt);
  const cooldownUntilMs = finite(controller.entryCooldownUntil) > options.now ? finite(controller.entryCooldownUntil) : null;
  const dayLockUntilMs = finite(controller.dayLockUntil) > options.now ? finite(controller.dayLockUntil) : null;
  const daySummary: Partial<ApnsLiveActivityContentState> = {
    ...(closedToday.length > 0 ? { dayTrades: closedToday } : {}),
    ...(tradesToday != null ? { tradesToday } : {}),
    ...(losingTrades != null ? { losingTrades } : {}),
    ...(dayPnl != null ? { dayPnlText: signedWhole(dayPnl), dayLossUsd: Math.max(0, -dayPnl) } : {}),
    ...(maxLosingTrades != null ? { maxLosingTrades } : {}),
    ...(dailyLossLimitUsd != null ? { dailyLossLimitUsd } : {}),
    ...(maxTrades != null ? { maxTrades } : {}),
    ...(armedAtMs != null && armedAtMs > 0 ? { armedAt: armedAtMs / 1_000 } : {}),
    ...(sessionEndAtMs != null && sessionEndAtMs > 0 ? { sessionEndAt: sessionEndAtMs / 1_000 } : {}),
    ...(cooldownUntilMs != null ? { cooldownUntil: cooldownUntilMs / 1_000 } : {}),
    ...(dayLockUntilMs != null ? {
      dayLockUntil: dayLockUntilMs / 1_000,
      ...(typeof controller.dayLockReason === 'string' && controller.dayLockReason.trim()
        ? { dayLockReason: controller.dayLockReason.trim().slice(0, 120) } : {}),
    } : {}),
  };
  const displayEntryPrice = entryPrice ?? pending?.price ?? null;
  const mode: 'idle' | 'pending' | 'position' | undefined = options.broker == null
    ? undefined
    : openPositionCount > 0 ? 'position' : pending ? 'pending' : 'idle';
  const eventSymbol = typeof lastEvent.symbol === 'string' && lastEvent.symbol.trim()
    ? lastEvent.symbol.trim()
    : null;
  const rawStateSymbol = firstPosition?.symbol ?? pending?.symbol ?? position.symbol ?? eventSymbol;
  const stateSymbol = rawStateSymbol?.toUpperCase();
  const stateSide: 'Long' | 'Short' | undefined = firstPosition?.side
    ?? (pending?.side === 'Buy' ? 'Long' : pending?.side === 'Sell' ? 'Short' : undefined);
  const stateQuantity = positionQuantity ?? pending?.quantity;
  const heartbeatFresh = Number.isFinite(Date.parse(options.runtime.last_seen_at))
    && options.now - Date.parse(options.runtime.last_seen_at) <= 90_000
    && controller.connected !== false;
  const followersOk = !heartbeatFresh
    ? 0
    : options.broker != null && options.broker.accountStatusComplete !== false
      ? followerIds.filter(accountId => options.broker?.accounts.some(account =>
        account.accountId === accountId && account.canTrade && !account.changesLocked)).length
      : null;
  const armExpiresAtMs = bool(controller.armed) ? optionalFinite(controller.armExpiresAt) : null;
  // A failed broker read must never be interpreted as "flat". End remotely
  // only after an authoritative snapshot confirms zero open positions.
  // Cooldown drží aktivitu i po ručním DISARM: odpočet (K3) je disciplinární
  // pomůcka pro leadera bez ohledu na to, jestli kopírka běží.
  const shouldEnd = options.broker != null
    && !bool(controller.armed)
    && openPositionCount === 0
    && workingOrderCount === 0
    && finite(controller.dayLockUntil) <= options.now
    && finite(controller.entryCooldownUntil) <= options.now
    && !bool(controller.killSwitch);
  const headline = position.headline
    ?? (bool(controller.armed) ? `ARM · ${followerCount} followerů` : status.detail);
  const pnlLabel = openPositionCount > 0 && options.broker?.completeOpenPnl === true
    ? 'Účty (broker) · otevřené P&L'
    : options.broker != null
      ? BROKER_ACCOUNTS_DAILY_PNL_LABEL
      : COPIER_LEADER_DAILY_STATS_LABEL;
  const state: ApnsLiveActivityContentState = {
    status: status.status,
    headline,
    // U stavů, které volají po zásahu, je důvod cennější než počty pozic —
    // jinak by u divergence na kartě stálo jen „2 pozic · 4 příkazů".
    detail: CRITICAL_STATUSES.has(status.status)
      ? status.detail
      : `${openPositionCount} pozic · ${workingOrderCount} příkazů · ${pnlLabel}`,
    pnlText: pnlAvailable ? signedMoney(pnl) : '—',
    pnlLabel,
    isPositive: pnlAvailable && pnl >= 0,
    progress: bool(controller.killSwitch) ? 1 : bool(controller.armed) ? 0.75 : controller.connected === true ? 0.35 : 0.1,
    updatedAt: options.now / 1_000,
    // Po DISARM a flat aktivita končí shrnutím dne (L5) místo prázdné karty.
    ...(shouldEnd ? { mode: 'summary' as const } : mode ? { mode } : {}),
    ...(stateSymbol ? { symbol: stateSymbol } : {}),
    ...(stateSide ? { side: stateSide } : {}),
    ...(stateQuantity != null ? { quantity: stateQuantity } : {}),
    ...(displayEntryPrice != null ? { entryPrice: displayEntryPrice } : {}),
    ...(currentPrice != null ? { currentPrice } : {}),
    ...(stopPrice != null ? { stopPrice } : {}),
    ...(targetPrice != null ? { targetPrice } : {}),
    ...(slTpProgress != null ? { slTpProgress } : {}),
    ...(armExpiresAtMs != null && armExpiresAtMs > options.now
      ? { armExpiresAt: armExpiresAtMs / 1_000 } : {}),
    followersTotal: followerCount,
    ...(followersOk != null ? { followersOk } : {}),
    ...(riskAtStop != null ? { riskAtStopText: `${riskAtStop < 0 ? '−' : '+'}$${Math.abs(riskAtStop).toFixed(0)} na SL`, stopPnlText: signedWhole(riskAtStop) } : {}),
    ...(pnlAtTarget != null ? { targetPnlText: signedWhole(pnlAtTarget) } : {}),
    pnlCompactText: pnlAvailable ? signedWhole(pnl) : '—',
    ...daySummary,
  };
  const fingerprint = {
    event: shouldEnd ? 'end' : 'update',
    state: { ...state, updatedAt: 0 },
  };
  return {
    update: {
      state,
      event: shouldEnd ? 'end' : 'update',
      staleAt: options.now / 1_000 + 180,
      // Shrnutí dne zůstane na zámku 15 minut, pak se sklidí samo.
      ...(shouldEnd ? { dismissalAt: options.now / 1_000 + 15 * 60 } : {}),
    },
    payloadHash: createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex'),
    shouldEnd,
    symbol: (position.symbol ?? fallbackSymbol).toUpperCase().startsWith('MNQ') ? 'MNQ' : 'NQ',
  };
}

export const latestNativeRuntimeByUser = (runtimes: readonly NativeLiveActivityRuntimeRow[]) => {
  const result = new Map<string, NativeLiveActivityRuntimeRow>();
  for (const runtime of runtimes) {
    const current = result.get(runtime.user_id);
    if (!current || Date.parse(runtime.last_seen_at) > Date.parse(current.last_seen_at)) {
      result.set(runtime.user_id, runtime);
    }
  }
  return result;
};

/**
 * One read-only Tradovate snapshot per user/connection and cron tick. The
 * returned loader is shared by Live Activities and financial APNs alerts so
 * adding alert coverage does not double broker traffic.
 */
/** Připojení runtime zařízení první, ostatní připojená připojení uživatele za ním. */
async function liveActivityConnectionIds(options: {
  db: SupabaseClient;
  config: TradovateServerConfig;
  runtime: NativeLiveActivityRuntimeRow;
}): Promise<string[]> {
  const others = await listConnectedTradovateConnectionIds({
    db: options.db,
    userId: options.runtime.user_id,
    environment: options.config.environment,
  });
  return [...new Set([options.runtime.connection_id, ...others])];
}

export function createNativeBrokerSnapshotLoader(options: {
  db: SupabaseClient;
  config: TradovateServerConfig;
  now: number;
  fetchImpl?: typeof fetch;
}): NativeBrokerSnapshotLoader {
  const brokerByConnection = new Map<string, Promise<NativeLiveActivityBrokerSnapshot | null>>();
  return (runtime, loadOptions) => {
    // Rozsah musí být součástí klíče: sběrač účtů si bere `allAccounts`, a bez
    // něj by Live Activity dostala z cache i pozice účtů mimo copier skupinu —
    // započetly by se do jejího P&L a bránily ukončení prázdné aktivity.
    // Sběr účtů (`allAccounts`) je per připojení — cron ho volá pro každé
    // zvlášť. Skupina Live Activity naopak může ležet na více Tradovate
    // loginech (leader u jedné propky, followeři u jiné) a každý token vidí
    // jen své účty, proto se čte přes všechna připojená OAuth připojení.
    const scope = loadOptions?.allAccounts
      ? `${runtime.connection_id}:all`
      : `group:${liveActivityAccountIds(runtime).slice().sort().join(',')}`;
    const key = `${runtime.user_id}:${scope}`;
    let pending = brokerByConnection.get(key);
    if (!pending) {
      pending = (async () => {
        const runtimeAccountIds = liveActivityAccountIds(runtime);
        const accountIds = loadOptions?.allAccounts ? null : runtimeAccountIds;
        if (accountIds?.length === 0) return null;
        const connectionIds = loadOptions?.allAccounts
          ? [runtime.connection_id]
          : await liveActivityConnectionIds({ db: options.db, config: options.config, runtime });
        // Fail-closed: chybějící token kteréhokoli připojení znamená neúplný
        // obraz skupiny, a ten se nesmí tvářit jako celkové P&L.
        const tokens = await Promise.all(connectionIds.map(connectionId => getValidTradovateAccessToken({
          db: options.db,
          config: options.config,
          userId: runtime.user_id,
          connectionId,
          minimumValidityMs: 180_000,
          fetchImpl: options.fetchImpl,
        })));
        return loadNativeLiveActivityBrokerSnapshot({
          baseUrl: tradovateApiBaseUrl(options.config.environment),
          accessTokens: tokens.map(token => token.accessToken),
          accountIds,
          leaderAccountId: runtimeAccountIds[0] ?? null,
          fetchImpl: options.fetchImpl,
          now: options.now,
        });
      })().catch(error => {
        console.error('[Native Broker Snapshot] Read failed:', error instanceof Error ? error.message : String(error));
        return null;
      });
      brokerByConnection.set(key, pending);
    }
    return pending;
  };
}

export async function updateNativeLiveActivities(options: {
  db: SupabaseClient;
  runtimes: readonly NativeLiveActivityRuntimeRow[];
  config: TradovateServerConfig;
  now?: number;
  fetchImpl?: typeof fetch;
  brokerSnapshot?: NativeBrokerSnapshotLoader;
}): Promise<{ registered: number; sent: number; ended: number; skipped: number; failed: number }> {
  const now = options.now ?? Date.now();
  const { data, error } = await options.db.from('native_live_activity_subscriptions')
    .select('id,user_id,activity_id,push_token,environment,bundle_id,last_payload_hash,last_payload_at')
    .is('expires_at', null);
  if (error) throw new Error(`native-live-activity-query-failed: ${error.message}`);
  const subscriptions = (data ?? []) as NativeLiveActivitySubscriptionRow[];
  const runtimesByUser = latestNativeRuntimeByUser(options.runtimes);
  const brokerSnapshot = options.brokerSnapshot ?? createNativeBrokerSnapshotLoader({
    db: options.db,
    config: options.config,
    now,
    fetchImpl: options.fetchImpl,
  });
  let sent = 0;
  let ended = 0;
  let skipped = 0;
  let failed = 0;

  for (const subscription of subscriptions) {
    const runtime = runtimesByUser.get(subscription.user_id);
    if (!runtime) {
      skipped++;
      continue;
    }
    const plan = planNativeLiveActivityUpdate({
      runtime,
      broker: await brokerSnapshot(runtime),
      now,
    });
    const lastPayloadAt = Date.parse(subscription.last_payload_at ?? '');
    const heartbeatDue = !Number.isFinite(lastPayloadAt) || now - lastPayloadAt >= 110_000;
    if (!plan.shouldEnd && subscription.last_payload_hash === plan.payloadHash && !heartbeatDue) {
      skipped++;
      continue;
    }
    const result = await sendApnsLiveActivityUpdate({
      id: subscription.activity_id,
      deviceToken: subscription.push_token,
      environment: subscription.environment,
      bundleId: subscription.bundle_id,
    } as ApnsDevice, plan.update);
    const nowIso = new Date(now).toISOString();
    if (result.status === 'sent') {
      sent++;
      if (plan.shouldEnd) ended++;
      await options.db.from('native_live_activity_subscriptions').update({
        last_payload_hash: plan.payloadHash,
        last_payload_at: nowIso,
        last_error: null,
        updated_at: nowIso,
        ...(plan.shouldEnd ? { expires_at: nowIso } : {}),
      }).eq('id', subscription.id);
    } else {
      failed++;
      await options.db.from('native_live_activity_subscriptions').update({
        last_error: result.error ?? `APNs HTTP ${result.statusCode ?? 0}`,
        updated_at: nowIso,
        ...(result.status === 'expired' ? { expires_at: nowIso } : {}),
      }).eq('id', subscription.id);
    }
  }
  return { registered: subscriptions.length, sent, ended, skipped, failed };
}
