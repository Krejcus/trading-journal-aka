import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readTradovatePenaltyBody } from '../lib/tradovatePenaltyBody.js';
import { monotonicGrantDeadline, isTradovateControlSnapshot, parseTradovateRequestPenalty, TradovateRemoteControlError, TRADOVATE_REQUEST_CONTROL_POLICY as POLICY,
  type TradovateRequestControlRemote, type TradovateRequestControlSnapshot,
  type TradovateRequestGrant, type TradovateRequestPenalty, type TradovateRequestPurpose } from '../lib/tradovateRequestControl.js';

/** Local admission failure is NOT an upstream 429 and must never extend it. */
export class TradovateRequestControlError extends TradovateRemoteControlError {
  readonly status = 503;
  constructor(code: string, retryAfterMs: number | null = null,
    snapshot?: TradovateRequestControlSnapshot, public readonly notDispatched = true) { super(code, retryAfterMs, snapshot); this.name = 'TradovateRequestControlError'; }
}

type RpcResult = { allowed?: boolean; code?: string; retryAfterMs?: number; snapshot?: TradovateRequestControlSnapshot; grant?: TradovateRequestGrant };
export interface ServerTradovateRequestContext {
  db: SupabaseClient;
  userId: string;
  connectionId: string;
  /** From the owner-filtered OAuth row, never from the browser request. */
  brokerUserId: number | null;
}
const validId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
const validSnapshot = isTradovateControlSnapshot;

export function createServerTradovateRequestControl(context: ServerTradovateRequestContext): TradovateRequestControlRemote {
  const rpc = async (mode: string, fields: Record<string, unknown> = {}): Promise<RpcResult> => {
    if (!validId(context.brokerUserId)) throw new TradovateRequestControlError('tradovate-request-identity-unavailable');
    const { data, error } = await context.db.rpc('tradovate_request_control_v1', {
      p_owner_user_id: context.userId, p_connection_id: context.connectionId, p_mode: mode, ...fields,
    });
    if (error) throw new TradovateRequestControlError('tradovate-request-control-unavailable');
    const result = data as RpcResult | null;
    if (!result || typeof result.allowed !== 'boolean') throw new TradovateRequestControlError('tradovate-request-control-invalid-response');
    if (result.snapshot && (!validSnapshot(result.snapshot) || result.snapshot.brokerUserId !== context.brokerUserId)) {
      throw new TradovateRequestControlError(!result.allowed && ['tradovate-request-cooldown','tradovate-request-captcha'].includes(result.code ?? '')
        ? result.code! : 'tradovate-request-control-invalid-scope');
    }
    if (!result.allowed) throw new TradovateRequestControlError(result.code ?? 'tradovate-request-control-denied',
      typeof result.retryAfterMs === 'number' && Number.isFinite(result.retryAfterMs) ? Math.max(0,result.retryAfterMs) : null, result.snapshot);
    return result;
  };
  return {
    async read() {
      const result = await rpc('read');
      if (!validSnapshot(result.snapshot)) throw new TradovateRequestControlError('tradovate-request-control-invalid-response');
      return result.snapshot;
    },
    async reserve(input) {
      const result = await rpc('reserve', { p_grant_id: input.grantId, p_purpose: input.purpose, p_units: input.units, p_ttl_ms: input.ttlMs });
      const g = result.grant;
      if (!g || g.version !== 1 || g.brokerUserId !== context.brokerUserId || g.grantId !== input.grantId || g.purpose !== input.purpose
        || g.units !== input.units || !validTime(g.serverNow) || !validTime(g.validUntil) || g.validUntil <= g.serverNow
        || g.validUntil - g.serverNow > input.ttlMs || !Number.isSafeInteger(g.epoch) || g.epoch < 0) {
        throw new TradovateRequestControlError('tradovate-request-control-invalid-grant');
      }
      return g;
    },
    async penalize(penalty) {
      const enriched = penalty as TradovateRequestPenalty & { brokerMinimumMs?: number; policyFallbackMs?: number };
      const result = await rpc('penalize', { p_evidence: penalty.evidence, p_retry_after_ms: Math.ceil(penalty.retryAfterMs),
        p_reason: penalty.reason.slice(0,200), p_captcha_required: penalty.captchaRequired === true,
        p_broker_minimum_ms: enriched.brokerMinimumMs ?? null, p_policy_fallback_ms: enriched.policyFallbackMs ?? null });
      if (!validSnapshot(result.snapshot)) throw new TradovateRequestControlError('tradovate-request-control-invalid-response');
      return result.snapshot;
    },
  };
}

/** Opakování po předběžném odmítnutí: klient stejně čeká nejméně 15 s; jednotky drží minutové okno ~65 s. */
export const BACKGROUND_CAPACITY_RETRY_MS = 20_000;

/**
 * Předběžná kontrola kapacity pro vícedotazové zobrazovací čtení (plné načtení účtů =
 * 8 + 4 × účty dotazů). Do 11. 11. 2026 se takové čtení pustilo vždy: narazilo na minutový
 * strop uprostřed, celé se zahodilo a jeho jednotky zablokovaly i další pokus — dvě appky
 * se tak navzájem držely v „Načítání omezeno rozpočtem“ celé minuty.
 *
 * Jen poradní: nic nerezervuje a nic nepovoluje. Každý fyzický dotaz si dál bere vlastní
 * jednotku a prochází všemi branami (cooldown, captcha, epocha, penalizace). Selhání
 * kontroly samotné čtení neblokuje. Cooldown a captcha nechává rozhodnout původní cestu,
 * aby jejich kód a čas zůstaly beze změny (INV-TRAD-04, INV-TRAD-09).
 */
export async function assertTradovateBackgroundCapacity(context: ServerTradovateRequestContext, units: number): Promise<void> {
  if (!validId(context.brokerUserId) || !Number.isFinite(units) || units <= 0) return;
  let state: TradovateRequestControlSnapshot;
  try { state = await createServerTradovateRequestControl(context).read(); } catch { return; }
  if (state.captchaRequired || (state.blockedUntil != null && state.blockedUntil > state.serverNow)) return;
  // Čtení větší než celý minutový strop projít nemůže nikdy; smí to zkusit jen do prázdné minuty.
  const need = Math.min(Math.ceil(units), POLICY.backgroundMinute);
  const overMinute = state.backgroundReservedMinute + need > POLICY.backgroundMinute;
  const overHour = state.backgroundReservedHour + need > POLICY.backgroundHour
    || (state.totalReservedHour ?? 0) + need > POLICY.totalSoftHour;
  if (overMinute || overHour) {
    throw new TradovateRequestControlError('tradovate-request-budget', overHour ? 60_000 : BACKGROUND_CAPACITY_RETRY_MS, state);
  }
}

// A broker observation is fenced synchronously before attempting the remote
// persistence. Vercel process loss before DB commit remains an explicit gap;
// a warm process must never forget the observation after an RPC outage.
interface PendingPenalty { penalty: TradovateRequestPenalty; flushing?: Promise<void>; }
const pendingPenalties = new Map<number, PendingPenalty>();
const penaltyInspections = new Map<number, number>();
/** Test isolation only. Production has no automatic local reset/unblock. */
export function resetServerTradovatePendingPenaltiesForTests(): void { pendingPenalties.clear(); penaltyInspections.clear(); }
function holdPenaltyInspection(principal: number): () => void {
  penaltyInspections.set(principal, (penaltyInspections.get(principal) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return; released = true;
    const remaining = (penaltyInspections.get(principal) ?? 1) - 1;
    if (remaining > 0) penaltyInspections.set(principal, remaining);
    else penaltyInspections.delete(principal);
  };
}
function recordPendingPenalty(principal: number, penalty: TradovateRequestPenalty): void {
  const prior = pendingPenalties.get(principal)?.penalty;
  if (!prior) { pendingPenalties.set(principal, { penalty }); return; }
  const selected = penalty.retryAfterMs >= prior.retryAfterMs ? penalty : prior;
  const captcha = prior.captchaRequired === true || penalty.captchaRequired === true;
  pendingPenalties.set(principal, { penalty: { ...selected,
    retryAfterMs: Math.max(prior.retryAfterMs, penalty.retryAfterMs),
    ...(captcha ? { evidence: 'captcha', captchaRequired: true } : {}),
    brokerMinimumMs: Math.max(prior.brokerMinimumMs ?? 0, penalty.brokerMinimumMs ?? 0) || null,
    policyFallbackMs: Math.max(prior.policyFallbackMs ?? 0, penalty.policyFallbackMs ?? 0),
  } });
}
async function flushPendingPenalties(principal: number, control: TradovateRequestControlRemote): Promise<void> {
  for (;;) {
    const pending = pendingPenalties.get(principal);
    if (!pending) return;
    if (!pending.flushing) {
      pending.flushing = control.penalize(pending.penalty).then(() => {
        if (pendingPenalties.get(principal) === pending) pendingPenalties.delete(principal);
      }).catch(error => { pending.flushing = undefined; throw error; });
    }
    try { await pending.flushing; }
    catch { throw new TradovateRequestControlError('tradovate-request-penalty-persist-pending', pending.penalty.retryAfterMs); }
    // A concurrent response may have observed a stronger penalty during flush.
  }
}

/** Each background HTTP dispatch uses one shared credit. Internal management
 * maintenance obeys authority/cooldown but is exempt from the soft budget. */
export function createControlledTradovateServerFetch(context: ServerTradovateRequestContext, upstream: typeof fetch = fetch,
  purpose: TradovateRequestPurpose = 'background', clock = Date.now, monotonic = () => performance.now()): typeof fetch {
  const control = createServerTradovateRequestControl(context);
  return async (input, init) => {
    init?.signal?.throwIfAborted();
    if (validId(context.brokerUserId) && penaltyInspections.has(context.brokerUserId)) {
      throw new TradovateRequestControlError('tradovate-request-penalty-inspection-pending');
    }
    if (validId(context.brokerUserId)) await flushPendingPenalties(context.brokerUserId, control);
    const started = monotonic();
    // Credential maintenance cannot lose the ability to renew a management
    // token after background exhaustion. Identity and actual broker fences stay.
    const grant = purpose === 'management' ? null
      : await control.reserve({ grantId: randomUUID(), purpose, units: 1, ttlMs: POLICY.grantTtlMs });
    init?.signal?.throwIfAborted();
    const deadline = grant ? monotonicGrantDeadline(started, grant.serverNow, grant.validUntil) : Infinity;
    const readStarted = monotonic();
    const state = await control.read();
    init?.signal?.throwIfAborted();
    // No await remains between these final gates and physical fetch invocation.
    const pending = pendingPenalties.get(state.brokerUserId);
    if (penaltyInspections.has(state.brokerUserId)) throw new TradovateRequestControlError('tradovate-request-penalty-inspection-pending');
    if (pending) throw new TradovateRequestControlError('tradovate-request-penalty-persist-pending', pending.penalty.retryAfterMs);
    if (state.captchaRequired || state.blockedUntil != null && state.blockedUntil > state.serverNow) {
      throw new TradovateRequestControlError(state.captchaRequired ? 'tradovate-request-captcha' : 'tradovate-request-cooldown',
        state.blockedUntil == null ? null : Math.max(0,state.blockedUntil-state.serverNow),state);
    }
    if (monotonic() - readStarted >= POLICY.maxControlAgeMs) throw new TradovateRequestControlError('tradovate-request-control-stale');
    if ((grant && state.epoch !== grant.epoch) || monotonic() >= deadline) throw new TradovateRequestControlError('tradovate-request-grant-expired');
    const response = await upstream(input, init);
    // HTTP429 is known at headers. Fence the principal before any body await;
    // parsing may later strengthen this to a longer minimum/actual captcha.
    if (response.status === 429) {
      const headerPenalty = parseTradovateRequestPenalty(429, null, response.headers.get('retry-after'), clock());
      if (headerPenalty) recordPendingPenalty(state.brokerUserId, headerPenalty);
      try { await flushPendingPenalties(state.brokerUserId, control); }
      catch { throw new TradovateRequestControlError('tradovate-request-penalty-persist-failed', null, undefined, false); }
    }
    // 423 confirms a penalty but may carry a short p-time in its body. Stop
    // other local dispatches while inspecting it instead of inventing an hour.
    const releaseInspection = response.status === 423 ? holdPenaltyInspection(state.brokerUserId) : () => {};
    try {
    const contentType = response.headers.get('content-type') ?? '';
    const body = response.status === 429 || response.status === 423
      ? await readTradovatePenaltyBody(response)
      : !contentType.includes('csv') ? await response.clone().json().catch(() => null) : null;
    const penalty = parseTradovateRequestPenalty(response.status, body, response.headers.get('retry-after'), clock());
    if (penalty) {
      recordPendingPenalty(state.brokerUserId, penalty);
      try { await flushPendingPenalties(state.brokerUserId, control); }
      catch {
        // HTTP already happened; a persistence error never claims not-sent.
        throw new TradovateRequestControlError('tradovate-request-penalty-persist-failed', null, undefined, false);
      }
    }
    return response;
    } finally { releaseInspection(); }
  };
}
