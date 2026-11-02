import type { SupabaseClient } from '@supabase/supabase-js';
import { claimTradovateCopierCommandV2 } from './tradovateCopierCommandRelay.js';
import { COPIER_COMMAND_PUSH_EVENT, copierCommandPushGrant, signCopierCommandPush } from './copierCommandPush.js';

/** Runtime workeru musí být takhle čerstvý, aby server navázal příkaz k jeho nečinné delivery. */
export const COPIER_PUSH_RUNTIME_MAX_AGE_MS = 4_000;
/** Strop každého kroku (čtení runtime, claim RPC, broadcast): brzda ani 202 na push nečekají déle. */
export const COPIER_PUSH_STEP_TIMEOUT_MS = 1_000;

export type CopierPushOutcome = 'pushed' | 'no-grant' | 'no-idle' | 'stale' | 'not-claimed' | 'failed';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * F1b′ (docs/reviews/hot-path-f1b2-fees-close-20261102.md): po durable enqueue naváže
 * frontu zařízení k jeho nečinné delivery STEJNOU RPC jako poll workeru (advisory lock,
 * přednost brzd, FIFO) a navázaný řádek pošle podepsaný na téma zařízení. Nic nevytváří
 * ani neprodlužuje; ztracený push = poll se stejným id vrátí totéž.
 *
 * Nikdy nevyhodí a každý krok má vlastní limit — volá se souběžně s kickem a long-pollem
 * a jeho selhání nesmí změnit odpověď 202 ani zdržet brzdu (INV-BRAKE-03). Zrušený
 * request může RPC v Postgresu dokončit později; to je v pořádku (worker ho vezme pollem).
 */
export async function pushBoundCopierCommand(options: {
  db: SupabaseClient;
  deviceId: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  stepTimeoutMs?: number;
}): Promise<CopierPushOutcome> {
  try {
    const grant = copierCommandPushGrant(options.deviceId);
    if (!grant) return 'no-grant';
    const now = options.now ?? Date.now;
    const step = options.stepTimeoutMs ?? COPIER_PUSH_STEP_TIMEOUT_MS;
    const { data, error } = await options.db.from('tradovate_copier_device_runtime')
      .select('relay_idle:status->relayIdle,last_seen_at')
      .eq('device_id', options.deviceId)
      .abortSignal(AbortSignal.timeout(step))
      .maybeSingle<{ relay_idle: { deliveryId?: unknown } | null; last_seen_at: string }>();
    if (error || !data) return 'failed';
    const deliveryId = data.relay_idle?.deliveryId;
    if (typeof deliveryId !== 'string' || !UUID.test(deliveryId)) return 'no-idle';
    const seenAt = Date.parse(data.last_seen_at);
    if (!Number.isFinite(seenAt) || now() - seenAt > COPIER_PUSH_RUNTIME_MAX_AGE_MS) return 'stale';
    const command = await claimTradovateCopierCommandV2({ db: options.db, deviceId: options.deviceId, deliveryId, signal: AbortSignal.timeout(step) });
    // Vázaný řádek může být starší hotový (relayIdle ještě před rotací) — ten se neposílá.
    if (!command || command.status !== 'claimed' || !command.command) return 'not-claimed';
    const message = signCopierCommandPush({ deviceId: options.deviceId, deliveryId, command });
    if (!message) return 'no-grant';
    const response = await (options.fetchImpl ?? fetch)(`${options.supabaseUrl}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: options.serviceRoleKey, Authorization: `Bearer ${options.serviceRoleKey}` },
      body: JSON.stringify({ messages: [{ topic: grant.topic, event: COPIER_COMMAND_PUSH_EVENT, payload: message }] }),
      signal: AbortSignal.timeout(step),
    });
    return response.ok ? 'pushed' : 'failed';
  } catch {
    return 'failed';
  }
}
