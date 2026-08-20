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
import {
  getValidTradovateAccessToken,
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
) => Promise<NativeLiveActivityBrokerSnapshot | null>;

const finite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const bool = (value: unknown): boolean => value === true;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const signedMoney = (value: number): string =>
  `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`;

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

function statusText(runtime: NativeLiveActivityRuntimeRow, now: number): { status: string; detail: string } {
  const controller = controllerOf(runtime);
  const lastSeen = Date.parse(runtime.last_seen_at);
  if (!Number.isFinite(lastSeen) || now - lastSeen > 90_000) {
    return { status: 'WORKER OFFLINE', detail: 'Heartbeat je starší než 90 sekund.' };
  }
  if (bool(controller.killSwitch)) return { status: 'KILL SWITCH', detail: String(controller.lastError || 'Runtime je zastavený.') };
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
  const recentEvents = Array.isArray(controller.recentCopyEvents) ? controller.recentCopyEvents : [];
  const lastEvent = object(recentEvents[recentEvents.length - 1]);
  const fallbackSymbol = typeof lastEvent.symbol === 'string' && lastEvent.symbol.trim()
    ? lastEvent.symbol.trim()
    : 'MNQ';
  const brokerPnl = options.broker?.completeOpenPnl === true
    ? options.broker.totalPnl
    : options.broker?.realizedPnl;
  const dailyStats = object(controller.dailyStats);
  const pnl = brokerPnl ?? finite(dailyStats.realizedPnlUsd);
  const openPositionCount = options.broker?.positions.length ?? 0;
  const workingOrderCount = options.broker?.workingOrderCount
    ?? (Array.isArray(controller.workingOrderAccounts) ? controller.workingOrderAccounts.length : 0);
  // A failed broker read must never be interpreted as "flat". End remotely
  // only after an authoritative snapshot confirms zero open positions.
  const shouldEnd = options.broker != null
    && !bool(controller.armed)
    && openPositionCount === 0
    && finite(controller.dayLockUntil) <= options.now
    && !bool(controller.killSwitch);
  const headline = position.headline
    ?? (bool(controller.armed) ? `ARM · ${followerCount} followerů` : status.detail);
  const pnlLabel = options.broker?.completeOpenPnl === false ? 'Realized P&L' : 'Celkové P&L';
  const state: ApnsLiveActivityContentState = {
    status: status.status,
    headline,
    detail: `${openPositionCount} pozic · ${workingOrderCount} příkazů · ${pnlLabel}`,
    pnlText: signedMoney(pnl),
    isPositive: pnl >= 0,
    progress: bool(controller.killSwitch) ? 1 : bool(controller.armed) ? 0.75 : controller.connected === true ? 0.35 : 0.1,
    updatedAt: options.now / 1_000,
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
      ...(shouldEnd ? { dismissalAt: options.now / 1_000 + 30 } : {}),
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
export function createNativeBrokerSnapshotLoader(options: {
  db: SupabaseClient;
  config: TradovateServerConfig;
  now: number;
  fetchImpl?: typeof fetch;
}): NativeBrokerSnapshotLoader {
  const brokerByConnection = new Map<string, Promise<NativeLiveActivityBrokerSnapshot | null>>();
  return runtime => {
    const key = `${runtime.user_id}:${runtime.connection_id}`;
    let pending = brokerByConnection.get(key);
    if (!pending) {
      pending = (async () => {
        const accountIds = liveActivityAccountIds(runtime);
        if (accountIds.length === 0) return null;
        const { accessToken } = await getValidTradovateAccessToken({
          db: options.db,
          config: options.config,
          userId: runtime.user_id,
          connectionId: runtime.connection_id,
          minimumValidityMs: 180_000,
          fetchImpl: options.fetchImpl,
        });
        return loadNativeLiveActivityBrokerSnapshot({
          baseUrl: tradovateApiBaseUrl(options.config.environment),
          accessToken,
          accountIds,
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
