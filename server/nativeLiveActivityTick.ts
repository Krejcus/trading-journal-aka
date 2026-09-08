/**
 * Rychlý tik Live Activity z relay pollu workeru.
 *
 * Minutový cron zůstává zálohou; tenhle modul běží uvnitř `poll` akce
 * copier relay (worker volá každých ~750 ms) a při armovaném copieru pošle
 * ActivityKit update nejvýše jednou za 5 s. Data bere ze stejného read-only
 * Tradovate snapshotu jako cron, takže význam P&L, SL/TP a stavů je shodný.
 * Nikdy neodesílá broker příkaz.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendApnsLiveActivityUpdate,
  type ApnsDevice,
  type ApnsLiveActivityUpdate,
  type ApnsResult,
} from './apns.js';
import {
  createNativeBrokerSnapshotLoader,
  planNativeLiveActivityUpdate,
  type NativeBrokerSnapshotLoader,
  type NativeLiveActivityPlan,
  type NativeLiveActivityRuntimeRow,
  type NativeLiveActivitySubscriptionRow,
} from './nativeLiveActivityUpdater.js';
import type { TradovateServerConfig } from './tradovateOAuthStore.js';

/** Nejkratší rozestup mezi dvěma pokusy o tik (a tedy i Tradovate snapshoty). */
export const LIVE_ACTIVITY_TICK_INTERVAL_MS = 5_000;
/** Při otevřené pozici pošleme beze změny obsahu aspoň jednou za 20 s. */
export const LIVE_ACTIVITY_TICK_HEARTBEAT_MS = 20_000;
/** Při otevřené pozici iOS označí aktivitu jako zastaralou po 30 s bez pushe. */
export const LIVE_ACTIVITY_TICK_STALE_S = 30;
/** Bez otevřené pozice zůstává původní tolerance minutového cronu. */
export const LIVE_ACTIVITY_CRON_STALE_S = 180;
/** Poll workeru nesmí kvůli tiku čekat déle; zbytek dožene další tik. */
export const LIVE_ACTIVITY_TICK_BUDGET_MS = 2_500;

export interface NativeLiveActivityTickSubscriptionRow extends NativeLiveActivitySubscriptionRow {
  updated_at: string | null;
}

export interface NativeLiveActivityTickResult {
  sent: number;
  skipped: number;
  failed: number;
  reason: 'not-armed' | 'no-subscription' | 'throttled' | 'no-broker' | 'ticked';
}

const finiteDate = (value: string | null | undefined): number => {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
};

const controllerOf = (status: Record<string, unknown>): Record<string, unknown> => {
  const controller = status.controller;
  return controller && typeof controller === 'object' && !Array.isArray(controller)
    ? controller as Record<string, unknown>
    : status;
};

/** Tik má smysl jen při armovaném copieru; ostatní stavy pokryje cron. */
export const liveActivityTickArmed = (status: Record<string, unknown>): boolean =>
  controllerOf(status).armed === true;

/**
 * Poslední pokus o tik napříč odběry. `updated_at` se zapisuje i při skipu,
 * takže nezměněný obsah nevyvolá Tradovate snapshot při každém pollu.
 */
export const liveActivityTickDue = (
  subscriptions: readonly Pick<NativeLiveActivityTickSubscriptionRow, 'last_payload_at' | 'updated_at'>[],
  now: number,
): boolean => {
  const lastAttempt = Math.max(0, ...subscriptions.map(row => Math.max(finiteDate(row.last_payload_at), finiteDate(row.updated_at))));
  return now - lastAttempt >= LIVE_ACTIVITY_TICK_INTERVAL_MS - 500;
};

/** Rozhodne, zda konkrétní odběr dostane push, nebo jen zápis pokusu. */
export const liveActivityTickShouldSend = (options: {
  plan: Pick<NativeLiveActivityPlan, 'payloadHash' | 'shouldEnd'>;
  subscription: Pick<NativeLiveActivitySubscriptionRow, 'last_payload_hash' | 'last_payload_at'>;
  positionsOpen: boolean;
  now: number;
}): boolean => {
  if (options.plan.shouldEnd) return true;
  if (options.subscription.last_payload_hash !== options.plan.payloadHash) return true;
  if (!options.positionsOpen) return false;
  return options.now - finiteDate(options.subscription.last_payload_at) >= LIVE_ACTIVITY_TICK_HEARTBEAT_MS;
};

/** Stale-date podle toho, jestli tik reálně běží (otevřená pozice) nebo ne. */
export const liveActivityTickStaleAt = (now: number, positionsOpen: boolean): number =>
  now / 1_000 + (positionsOpen ? LIVE_ACTIVITY_TICK_STALE_S : LIVE_ACTIVITY_CRON_STALE_S);

export async function tickNativeLiveActivities(options: {
  db: SupabaseClient;
  userId: string;
  deviceId: string;
  connectionId: string;
  status: Record<string, unknown>;
  config: TradovateServerConfig;
  now?: number;
  fetchImpl?: typeof fetch;
  brokerSnapshot?: NativeBrokerSnapshotLoader;
  send?: (device: ApnsDevice, update: ApnsLiveActivityUpdate) => Promise<ApnsResult>;
}): Promise<NativeLiveActivityTickResult> {
  const now = options.now ?? Date.now();
  if (!liveActivityTickArmed(options.status)) return { sent: 0, skipped: 0, failed: 0, reason: 'not-armed' };

  const { data, error } = await options.db.from('native_live_activity_subscriptions')
    .select('id,user_id,activity_id,push_token,environment,bundle_id,last_payload_hash,last_payload_at,updated_at')
    .eq('user_id', options.userId)
    .is('expires_at', null);
  if (error) throw new Error(`native-live-activity-tick-query-failed: ${error.message}`);
  const subscriptions = (data ?? []) as NativeLiveActivityTickSubscriptionRow[];
  if (subscriptions.length === 0) return { sent: 0, skipped: 0, failed: 0, reason: 'no-subscription' };
  if (!liveActivityTickDue(subscriptions, now)) {
    return { sent: 0, skipped: subscriptions.length, failed: 0, reason: 'throttled' };
  }

  const nowIso = new Date(now).toISOString();
  const runtime: NativeLiveActivityRuntimeRow = {
    device_id: options.deviceId,
    user_id: options.userId,
    connection_id: options.connectionId,
    status: options.status,
    last_seen_at: nowIso,
    started_at: typeof options.status.startedAt === 'string' ? options.status.startedAt : nowIso,
  };
  const loader = options.brokerSnapshot ?? createNativeBrokerSnapshotLoader({
    db: options.db,
    config: options.config,
    now,
    fetchImpl: options.fetchImpl,
  });
  const broker = await loader(runtime);
  if (!broker) {
    // Bez snapshotu nic neposíláme; zapíšeme pokus, ať se hned neopakuje.
    for (const subscription of subscriptions) {
      await options.db.from('native_live_activity_subscriptions')
        .update({ updated_at: nowIso }).eq('id', subscription.id);
    }
    return { sent: 0, skipped: subscriptions.length, failed: 0, reason: 'no-broker' };
  }
  const positionsOpen = broker.positions.length > 0;
  const plan = planNativeLiveActivityUpdate({ runtime, broker, now });
  const update: ApnsLiveActivityUpdate = { ...plan.update, staleAt: liveActivityTickStaleAt(now, positionsOpen) };
  const send = options.send ?? sendApnsLiveActivityUpdate;

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const subscription of subscriptions) {
    if (!liveActivityTickShouldSend({ plan, subscription, positionsOpen, now })) {
      skipped++;
      await options.db.from('native_live_activity_subscriptions')
        .update({ updated_at: nowIso }).eq('id', subscription.id);
      continue;
    }
    const result = await send({
      id: subscription.activity_id,
      deviceToken: subscription.push_token,
      environment: subscription.environment,
      bundleId: subscription.bundle_id,
    } as ApnsDevice, update);
    if (result.status === 'sent') {
      sent++;
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
  return { sent, skipped, failed, reason: 'ticked' };
}

/** Tik s časovým rozpočtem: poll workeru nesmí kvůli němu zpozdit příkaz. */
export async function tickNativeLiveActivitiesWithinBudget(
  options: Parameters<typeof tickNativeLiveActivities>[0] & { budgetMs?: number },
): Promise<NativeLiveActivityTickResult | { reason: 'timeout' }> {
  const budgetMs = options.budgetMs ?? LIVE_ACTIVITY_TICK_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ reason: 'timeout' }>(resolve => {
    timer = setTimeout(() => resolve({ reason: 'timeout' }), budgetMs);
  });
  try {
    return await Promise.race([tickNativeLiveActivities(options), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
