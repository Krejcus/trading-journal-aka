import type { TradovateAccountDisplayFeedState, TradovateAccountDisplaySnapshot } from '../lib/tradovateAccountDisplayTypes.js';

export interface TradovateDisplayReadError extends Error { retryAfterMs?: number; status?: number }

/** One bounded queue per OAuth connection, completely separate from execution. */
export function createTradovateAccountDisplayFeed(options: {
  connectionId: string;
  environment: 'demo' | 'live';
  accountIds: () => readonly number[];
  read: (accountId: number, signal: AbortSignal) => Promise<TradovateAccountDisplaySnapshot['fields']>;
  clock?: () => number;
  coalesceMs?: number;
  minReadIntervalMs?: number;
  auditIntervalMs?: number;
}) {
  const clock = options.clock ?? Date.now;
  const pending = new Set<number>();
  const snapshots = new Map<number, TradovateAccountDisplaySnapshot>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: AbortController | null = null;
  let closed = false;
  let streamConnected = false;
  let generation = 0;
  let nextReadAt = 0;
  let lastErrorAt: string | null = null;
  let retryAt: number | null = null;
  let failures = 0;
  const allowed = () => new Set(options.accountIds().filter(id => Number.isSafeInteger(id) && id > 0).slice(0, 100));
  const schedule = () => {
    if (closed || timer || active || pending.size === 0) return;
    timer = setTimeout(() => { timer = null; void drain(); }, Math.max(options.coalesceMs ?? 250, nextReadAt - clock(), (retryAt ?? 0) - clock()));
  };
  const invalidate = (accountId: number | null) => {
    if (closed) return;
    const ids = allowed();
    if (accountId == null) ids.forEach(id => pending.add(id));
    else if (ids.has(accountId)) pending.add(accountId);
    schedule();
  };
  const drain = async () => {
    if (closed || active) return;
    const ids = allowed();
    for (const id of pending) if (!ids.has(id)) pending.delete(id);
    const accountId = pending.values().next().value as number | undefined;
    if (accountId == null) return;
    pending.delete(accountId);
    const currentGeneration = generation;
    const requestedAt = clock();
    const abort = new AbortController();
    active = abort;
    const timeout = setTimeout(() => abort.abort(), 10_000);
    try {
      // Bound the queue even when a transport ignores AbortSignal. A late
      // completion cannot reach the merge after the wrapper has rejected.
      const fields = await new Promise<TradovateAccountDisplaySnapshot['fields']>((resolve, reject) => {
        const cancelled = () => reject(new Error('display-read-aborted'));
        abort.signal.addEventListener('abort', cancelled, { once: true });
        Promise.resolve().then(() => options.read(accountId, abort.signal)).then(resolve, reject)
          .finally(() => abort.signal.removeEventListener('abort', cancelled));
      });
      if (closed || abort.signal.aborted || generation !== currentGeneration || !allowed().has(accountId)) return;
      // A partial response remains partial: never relabel retained fields with a new time.
      const safeFields: TradovateAccountDisplaySnapshot['fields'] = {};
      for (const key of ['dailyRealizedPnL', 'totalCashValue', 'totalCashValueSOD', 'realizedPnL', 'netLiq', 'openPnL'] as const) {
        const value = fields[key];
        if (typeof value === 'number' && Number.isFinite(value)) safeFields[key] = value;
      }
      if (Object.keys(safeFields).length === 0) throw new Error('empty-display-snapshot');
      snapshots.set(accountId, { accountId, connectionId: options.connectionId, environment: options.environment,
        requestedAt: new Date(requestedAt).toISOString(), confirmedAt: new Date(clock()).toISOString(), fields: safeFields });
      failures = 0; retryAt = null;
      if (pending.size === 0) lastErrorAt = null;
    } catch (error) {
      if (closed || generation !== currentGeneration) return;
      pending.add(accountId);
      lastErrorAt = new Date(clock()).toISOString();
      failures += 1;
      const failure = error as TradovateDisplayReadError;
      const delay = typeof failure.retryAfterMs === 'number' && Number.isFinite(failure.retryAfterMs) && failure.retryAfterMs > 0
        ? failure.retryAfterMs : failure.status === 429 ? 60_000 : Math.min(60_000, 2_000 * 2 ** Math.min(failures - 1, 5));
      retryAt = clock() + delay;
    } finally {
      clearTimeout(timeout);
      active = null;
      nextReadAt = clock() + (options.minReadIntervalMs ?? 1_000);
      schedule();
    }
  };
  const audit = setInterval(() => invalidate(null), options.auditIntervalMs ?? 10 * 60_000);
  return {
    invalidate,
    setStreamConnected(connected: boolean) { if (!closed) streamConnected = connected; },
    /** Revoked/replaced connection: in-flight data must never cross the boundary. */
    reset() {
      generation += 1; active?.abort(); pending.clear(); snapshots.clear();
      lastErrorAt = null; retryAt = null; failures = 0;
      if (timer) clearTimeout(timer); timer = null;
    },
    state(): TradovateAccountDisplayFeedState {
      const ids = allowed();
      return { streamConnected, connectionId: options.connectionId, environment: options.environment,
        snapshots: [...snapshots.values()].filter(s => ids.has(s.accountId)).map(s => ({ ...s, fields: { ...s.fields } })),
        pendingAccountIds: [...pending].filter(id => ids.has(id)), lastErrorAt,
        retryAt: retryAt == null ? null : new Date(retryAt).toISOString() };
    },
    close() { closed = true; generation += 1; active?.abort(); clearInterval(audit); if (timer) clearTimeout(timer); pending.clear(); },
  };
}
