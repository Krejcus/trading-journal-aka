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

/** Risk-redukční správa dostane kick hned — prohraný závod u ní stojí jen optimalizaci (oponentura P2). */
const IMMEDIATE_KICK_MANAGE_ACTIONS = new Set(['close-position', 'cancel-entry', 'attach-brackets']);

/**
 * Kick až po pokusu o push jen pro vstup, náhled a posuny SL/TP z grafu (DEMO 2. 11.: jinak kick
 * a poll workeru předběhnou push ve 2 ze 4 případů). Brzdy, Flatten, ARM a risk-redukční správa:
 * kick hned jako dřív.
 */
export function copierKickWaitsForPush(command: unknown): boolean {
  const candidate = command as { type?: unknown; command?: { type?: unknown; action?: unknown } } | null;
  if (candidate?.type !== 'copy-command') return false;
  const inner = candidate.command;
  if (inner?.type === 'preview-leader-entry' || inner?.type === 'place-leader-entry') return true;
  return inner?.type === 'manage-leader-order' && typeof inner.action === 'string' && !IMMEDIATE_KICK_MANAGE_ACTIONS.has(inner.action);
}

export const COPIER_KICK_AFTER_PUSH_MS = 250;
export const COPIER_KICK_MAX_DELAY_MS = 400;

/**
 * Naplánuje záložní kick po pokusu o push: neúspěch → hned, úspěch → +250 ms, nejpozději 400 ms
 * od zařazení. Když mezitím přišel výsledek (`settled`), kick se už neposílá. Nikdy nevyhodí.
 */
export async function scheduleCopierKickAfterPush(options: {
  push: Promise<CopierPushOutcome>;
  sendKick: () => Promise<void>;
  settled: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}): Promise<'sent' | 'skipped'> {
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  try {
    const outcome = await Promise.race([options.push, sleep(COPIER_KICK_MAX_DELAY_MS).then(() => 'late' as const)]);
    if (outcome === 'pushed') await sleep(COPIER_KICK_AFTER_PUSH_MS);
    if (options.settled()) return 'skipped';
    await options.sendKick();
    return 'sent';
  } catch {
    return 'skipped';
  }
}
