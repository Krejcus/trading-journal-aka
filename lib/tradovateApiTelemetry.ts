export interface TradovateApiUsageWindow {
  requests: number;
  failures: number;
  rateLimited: number;
}

export interface TradovateApiTelemetrySnapshot {
  minute: TradovateApiUsageWindow;
  hour: TradovateApiUsageWindow;
  day: TradovateApiUsageWindow;
  inFlight: number;
  lastStatus: number | null;
  lastUpdatedAt: number | null;
  rateLimitedUntil: number | null;
}

interface UsageBucket extends TradovateApiUsageWindow {
  minuteStart: number;
}

export interface TradovateApiRequestToken {
  startedAt: number;
  minuteStart: number;
}

const MINUTE_MS = 60_000;
const buckets = new Map<number, UsageBucket>();
const listeners = new Set<() => void>();
let inFlight = 0;
let lastStatus: number | null = null;
let lastUpdatedAt: number | null = null;
let rateLimitedUntil: number | null = null;

const emptyWindow = (): TradovateApiUsageWindow => ({ requests: 0, failures: 0, rateLimited: 0 });
const minuteStartOf = (at: number) => Math.floor(at / MINUTE_MS) * MINUTE_MS;

const prune = (now: number) => {
  const oldest = minuteStartOf(now - (24 * 60 + 1) * MINUTE_MS);
  for (const key of buckets.keys()) if (key < oldest) buckets.delete(key);
};

const windowAt = (minutes: number, now: number): TradovateApiUsageWindow => {
  const result = emptyWindow();
  const threshold = minuteStartOf(now - (minutes - 1) * MINUTE_MS);
  for (const bucket of buckets.values()) {
    if (bucket.minuteStart < threshold) continue;
    result.requests += bucket.requests;
    result.failures += bucket.failures;
    result.rateLimited += bucket.rateLimited;
  }
  return result;
};

let snapshot: TradovateApiTelemetrySnapshot = {
  minute: emptyWindow(),
  hour: emptyWindow(),
  day: emptyWindow(),
  inFlight: 0,
  lastStatus: null,
  lastUpdatedAt: null,
  rateLimitedUntil: null,
};

const publish = (now: number) => {
  prune(now);
  snapshot = {
    minute: windowAt(1, now),
    hour: windowAt(60, now),
    day: windowAt(24 * 60, now),
    inFlight,
    lastStatus,
    lastUpdatedAt,
    rateLimitedUntil: rateLimitedUntil != null && rateLimitedUntil > now ? rateLimitedUntil : null,
  };
  for (const listener of listeners) listener();
};

export const beginTradovateApiRequest = (now = Date.now()): TradovateApiRequestToken => {
  const minuteStart = minuteStartOf(now);
  const bucket = buckets.get(minuteStart) ?? { minuteStart, ...emptyWindow() };
  bucket.requests += 1;
  buckets.set(minuteStart, bucket);
  inFlight += 1;
  lastUpdatedAt = now;
  publish(now);
  return { startedAt: now, minuteStart };
};

export const finishTradovateApiRequest = (
  token: TradovateApiRequestToken,
  status: number,
  retryAfterMs: number | null = null,
  now = Date.now(),
) => {
  const bucket = buckets.get(token.minuteStart) ?? { minuteStart: token.minuteStart, ...emptyWindow() };
  if (status === 0 || status >= 400) bucket.failures += 1;
  if (status === 429) {
    bucket.rateLimited += 1;
    rateLimitedUntil = Math.max(rateLimitedUntil ?? 0, now + (retryAfterMs ?? 0));
  }
  buckets.set(token.minuteStart, bucket);
  inFlight = Math.max(0, inFlight - 1);
  lastStatus = status;
  lastUpdatedAt = now;
  publish(now);
};

export const getTradovateApiTelemetrySnapshot = () => snapshot;

/** Posune rolling okna i v době, kdy právě nepřichází nový požadavek. */
export const refreshTradovateApiTelemetry = (now = Date.now()) => publish(now);

export const subscribeTradovateApiTelemetry = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Pouze pro izolované testy. Produkční UI historii telemetrie nikdy nemaže. */
export const resetTradovateApiTelemetryForTests = () => {
  buckets.clear();
  inFlight = 0;
  lastStatus = null;
  lastUpdatedAt = null;
  rateLimitedUntil = null;
  publish(0);
};
