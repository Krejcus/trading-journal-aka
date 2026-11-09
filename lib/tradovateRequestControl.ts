/** Request governance is execution health, never authority to trade. */
export const TRADOVATE_REQUEST_CONTROL_CAPABILITY = 'tradovate-request-control-v1';
export const TRADOVATE_REQUEST_CONTROL_POLICY = Object.freeze({
  version: 1 as const,
  backgroundHour: 3_000,
  backgroundMinute: 120,
  totalSoftHour: 4_000,
  grantPool: 4,
  maxGrantUnits: 64,
  grantTtlMs: 5_000,
  maxGrantTtlMs: 15_000,
  controlSyncMs: 2_000,
  maxControlAgeMs: 5_000,
  backgroundBurst: 16,
  backgroundConcurrency: 8,
  raw429Ms: 3_600_000,
});

export type TradovateRequestPurpose = 'background' | 'risk' | 'entry' | 'management' | 'control';
export type TradovatePenaltyEvidence = 'raw-429' | 'retry-after' | 'p-time' | 'captcha';

export interface TradovateRequestPenalty {
  evidence: TradovatePenaltyEvidence;
  /** A duration, not a caller-controlled absolute server timestamp. */
  retryAfterMs: number;
  reason: string;
  captchaRequired?: boolean;
  brokerMinimumMs?: number | null;
  policyFallbackMs?: number;
}

export interface TradovateRequestControlSnapshot {
  version: 1;
  brokerUserId: number;
  serverNow: number;
  epoch: number;
  blockedUntil: number | null;
  captchaRequired: boolean;
  evidence: TradovatePenaltyEvidence | null;
  reason: string | null;
  backgroundReservedHour: number;
  backgroundReservedMinute: number;
}

export interface TradovateRequestGrant {
  version: 1;
  grantId: string;
  brokerUserId: number;
  purpose: TradovateRequestPurpose;
  units: number;
  serverNow: number;
  validUntil: number;
  epoch: number;
}

export interface TradovateRequestControlRemote {
  read(): Promise<TradovateRequestControlSnapshot>;
  reserve(input: { grantId: string; purpose: TradovateRequestPurpose; units: number; ttlMs: number }): Promise<TradovateRequestGrant>;
  penalize(penalty: TradovateRequestPenalty): Promise<TradovateRequestControlSnapshot>;
}

export interface TradovateRequestDispatchCounts {
  dispatchAttempts: number;
  blockedBeforeDispatch: number;
  responses: number;
  transportUnknown: number;
}

/** Additive, display-only read model; it does not replace worker/risk/route fences. */
export interface TradovateRequestHealth {
  version: 1;
  brokerUserId: number | null;
  state: 'ready' | 'budget-limited' | 'cooldown' | 'captcha' | 'unavailable';
  observedAt: number;
  blockedUntil: number | null;
  reason: string | null;
  evidence: TradovatePenaltyEvidence | null;
  controlFreshUntil: number | null;
  /** This is a local policy/cached authority estimate, not measured broker availability. */
  cooldownIsLocalEstimate: true;
  counts: TradovateRequestDispatchCounts;
}

/** Complete baseline plus continuing stream, not a timestamp borrowed from heartbeat. */
export interface TradovateWorkerAccountCoverage {
  accountId: number;
  connectionId: string;
  environment: 'demo' | 'live';
  routeEpoch: number;
  currentRouteEpoch: number;
  sessionId: string;
  currentSessionId: string;
  baselineAt: number;
  lastDataAt: number;
  socketLive: boolean;
  synchronized: boolean;
  gap: boolean;
  backlog: boolean;
  mergeInProgress: boolean;
  observedAt: number;
}

/** Preserve broker minima separately from our conservative raw-429 policy. */
export function parseTradovateRequestPenalty(
  status: number,
  body: unknown,
  retryAfter: string | null = null,
  now = Date.now(),
): TradovateRequestPenalty | null {
  const row = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
  // Saturate only beyond the representable operational date range. Treat an
  // absurd upstream duration as a practically permanent stop, never Infinity
  // (which JSON would silently turn into null) or a short retry fallback.
  const secondsToMs = (seconds: number) => Math.min(seconds * 1_000, 8e15);
  const headerSeconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
  const headerDate = retryAfter && !Number.isFinite(headerSeconds) ? Date.parse(retryAfter) : NaN;
  const headerMs = positive(headerSeconds) ? secondsToMs(headerSeconds)
    : Number.isFinite(headerDate) && headerDate > now ? headerDate - now : null;
  const pTimeMs = positive(row['p-time']) ? secondsToMs(row['p-time']) : null;
  const brokerMinimumMs = headerMs == null ? pTimeMs : pTimeMs == null ? headerMs : Math.max(headerMs, pTimeMs);
  if (row['p-captcha'] === true) return {
    evidence: 'captcha', captchaRequired: true, reason: 'Tradovate vyžaduje ruční ověření captcha.',
    retryAfterMs: Math.max(TRADOVATE_REQUEST_CONTROL_POLICY.raw429Ms, brokerMinimumMs ?? 0), brokerMinimumMs,
  };
  if (status === 429) return {
    evidence: 'raw-429', reason: 'Tradovate odmítl požadavky (HTTP 429).',
    retryAfterMs: Math.max(TRADOVATE_REQUEST_CONTROL_POLICY.raw429Ms, brokerMinimumMs ?? 0),
    brokerMinimumMs, policyFallbackMs: TRADOVATE_REQUEST_CONTROL_POLICY.raw429Ms,
  };
  if (row['p-ticket'] != null || status === 423) return {
    evidence: pTimeMs != null ? 'p-time' : headerMs != null ? 'retry-after' : 'p-time',
    reason: 'Tradovate vrátil penalizaci požadavku.', retryAfterMs: brokerMinimumMs ?? TRADOVATE_REQUEST_CONTROL_POLICY.raw429Ms,
    brokerMinimumMs, ...(brokerMinimumMs == null ? { policyFallbackMs: TRADOVATE_REQUEST_CONTROL_POLICY.raw429Ms } : {}),
  };
  return null;
}

/** Starting before the network call subtracts all elapsed RTT from usable grant life. */
export function monotonicGrantDeadline(startedAt: number, serverNow: number, validUntil: number): number {
  if (![startedAt, serverNow, validUntil].every(Number.isFinite) || startedAt < 0 || validUntil < serverNow) return startedAt;
  return startedAt + Math.max(0, validUntil - serverNow);
}

export function isTradovateRequestGrant(value: unknown): value is TradovateRequestGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.version === 1 && typeof row.grantId === 'string' && /^[A-Za-z0-9:_-]{8,120}$/.test(row.grantId)
    && Number.isSafeInteger(row.brokerUserId) && Number(row.brokerUserId) > 0
    && ['background', 'risk', 'entry', 'management', 'control'].includes(String(row.purpose))
    && Number.isSafeInteger(row.units) && Number(row.units) >= 1 && Number(row.units) <= TRADOVATE_REQUEST_CONTROL_POLICY.maxGrantUnits
    && typeof row.serverNow === 'number' && Number.isFinite(row.serverNow) && row.serverNow >= 0
    && typeof row.validUntil === 'number' && Number.isFinite(row.validUntil) && row.validUntil > row.serverNow
    && row.validUntil - row.serverNow <= TRADOVATE_REQUEST_CONTROL_POLICY.maxGrantTtlMs
    && Number.isSafeInteger(row.epoch) && Number(row.epoch) >= 0;
}
