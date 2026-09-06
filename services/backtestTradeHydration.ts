import type { Trade } from '../types';
import type { BacktestClosedTradeIdentity } from './backtestTradeOutbox';

export interface BacktestTradeHydratorOptions {
  ownerId: string;
  runId: string;
  accountId: string;
  /** Capture auth + active-run generation, including same-ID reopen. */
  isCurrent: () => boolean;
  hasTrade: (id: string) => boolean;
  load: (id: string, signal?: AbortSignal) => Promise<Trade | null>;
  /** Caller must add only when its current state still lacks this ID. */
  onTrade: (trade: Trade) => void;
  onError?: (message: string | null) => void;
  signal?: AbortSignal;
  retryMs?: number;
  maxPending?: number;
}

const sameIdentity = (left: BacktestClosedTradeIdentity, right: BacktestClosedTradeIdentity) =>
  left.tradeId === right.tradeId && left.runId === right.runId && left.accountId === right.accountId && left.instrument === right.instrument;

/** One independent identity-hydration queue per captured owner/run lifetime.
 * No mapper, no database writes, no durability ACKs. Null can mean a transient
 * read failure or a locally queued row; neither permanently suppresses retry. */
export const createBacktestTradeHydrator = (options: BacktestTradeHydratorOptions) => {
  if (!options.ownerId || !options.runId || !options.accountId) throw new Error('Načítání obchodů vyžaduje vlastníka, účet a session.');
  const retryMs = options.retryMs ?? 5_000;
  const maxPending = options.maxPending ?? 1_000;
  if (!Number.isFinite(retryMs) || retryMs < 100 || !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 1_000) {
    throw new Error('Neplatný limit fronty načítání obchodů.');
  }
  type Entry = { identity: BacktestClosedTradeIdentity; dueAt: number };
  const pending = new Map<string, Entry>();
  const delivered = new Map<string, BacktestClosedTradeIdentity>();
  const controller = new AbortController();
  let disposed = false;
  let active = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let yieldTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseYield: (() => void) | undefined;
  let lastError: string | null = null;

  const dispose = () => {
    if (disposed) return;
    disposed = true; controller.abort();
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    if (yieldTimer !== undefined) clearTimeout(yieldTimer);
    retryTimer = undefined; yieldTimer = undefined;
    releaseYield?.(); releaseYield = undefined;
    pending.clear(); delivered.clear();
    options.signal?.removeEventListener('abort', dispose);
  };
  const current = () => {
    if (!disposed && (options.signal?.aborted || !options.isCurrent())) dispose();
    return !disposed;
  };
  const report = (message: string | null) => {
    if (!current() || message === lastError) return;
    lastError = message; options.onError?.(message);
  };
  const yieldTask = () => new Promise<void>(resolve => {
    releaseYield = resolve;
    yieldTimer = setTimeout(() => { yieldTimer = undefined; releaseYield = undefined; resolve(); }, 0);
  });
  const schedule = () => {
    if (!current() || active || !pending.size) return;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    const next = Math.min(...[...pending.values()].map(entry => entry.dueAt));
    retryTimer = setTimeout(() => { retryTimer = undefined; void drain(); }, Math.max(0, next - Date.now()));
  };
  const drain = async () => {
    if (!current() || active) return;
    active = true;
    try {
      while (current() && pending.size) {
        const entry = [...pending.values()].find(value => value.dueAt <= Date.now());
        if (!entry) break;
        const { identity } = entry;
        if (options.hasTrade(identity.tradeId)) {
          pending.delete(identity.tradeId); delivered.set(identity.tradeId, identity); continue;
        }
        await yieldTask();
        if (!current()) break;
        try {
          const row = await options.load(identity.tradeId, controller.signal);
          if (!current()) break;
          if (!row) {
            entry.dueAt = Date.now() + retryMs;
            report('Uložené obchody čekají na načtení. Další pokus proběhne automaticky.');
            continue;
          }
          if (!sameIdentity(identity, { tradeId: String(row.id), runId: row.backtestRunId ?? '',
            accountId: row.accountId, instrument: row.instrument })) throw new Error('Načtený obchod nepatří této replay session.');
          if (!options.hasTrade(identity.tradeId)) options.onTrade(row);
          if (!current()) break;
          pending.delete(identity.tradeId); delivered.set(identity.tradeId, identity);
        } catch (reason) {
          if (!current()) break;
          entry.dueAt = Date.now() + retryMs;
          report(reason instanceof Error ? reason.message : 'Uložený obchod se nepodařilo načíst.');
        }
      }
      if (!pending.size) report(null);
    } catch (reason) {
      if (current()) {
        pending.forEach(entry => { entry.dueAt = Date.now() + retryMs; });
        report(reason instanceof Error ? reason.message : 'Načítání obchodů čeká na opakování.');
      }
    } finally {
      active = false;
      schedule();
    }
  };
  const enqueue = (identities: readonly BacktestClosedTradeIdentity[]) => {
    if (!current()) return;
    const additions = new Map<string, BacktestClosedTradeIdentity>();
    for (const identity of identities) {
      const previous = pending.get(identity.tradeId)?.identity ?? delivered.get(identity.tradeId) ?? additions.get(identity.tradeId);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.tradeId)
        || identity.runId !== options.runId || identity.accountId !== options.accountId || !identity.instrument
        || (previous && !sameIdentity(previous, identity))) throw new Error('Fronta obsahuje obchod jiné session nebo účtu.');
      if (!previous && !options.hasTrade(identity.tradeId)) additions.set(identity.tradeId, { ...identity });
    }
    if (pending.size + additions.size > maxPending) throw new Error(`Načítání čeká na příliš mnoho obchodů (limit ${maxPending}). Žádná část nové dávky nebyla zahozená ani potvrzená.`);
    additions.forEach(identity => pending.set(identity.tradeId, { identity, dueAt: Date.now() }));
    schedule();
  };
  options.signal?.addEventListener('abort', dispose, { once: true });
  if (options.signal?.aborted) dispose();
  return { enqueue, dispose, getPendingCount: () => pending.size };
};
