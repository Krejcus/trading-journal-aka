import type { Trade } from '../types';
import type { BacktestClosedTradeIdentity } from './backtestTradeOutbox';

export interface BacktestClosedTradeEmissionResult {
  durableIds: string[];
  failedIds: string[];
  error: string | null;
  cancelled: boolean;
}
export interface BacktestClosedTradeEmitterOptions<Job> {
  ownerId: string;
  runId: string;
  accountId: string;
  /** Caller must include auth + session generation, not just an owner string. */
  isCurrent?: () => boolean;
  identity: (job: Job) => BacktestClosedTradeIdentity;
  preflight: (identities: readonly BacktestClosedTradeIdentity[], signal: AbortSignal) => Promise<{ durableIds: ReadonlySet<string> }>;
  /** May run in a worker. Its context must retain the captured replay horizon. */
  mapTrade: (job: Job, signal: AbortSignal) => Promise<Trade>;
  /** Resolves only after complete local durability (or an authoritative ACK). */
  persist: (trade: Trade) => Promise<unknown>;
  /** A task boundary, not Promise.resolve(): give input/paint a chance to run. */
  yieldTask?: (signal: AbortSignal) => Promise<void>;
}

const cancelled = () => new DOMException('Obnova obchodů byla zrušena.', 'AbortError');
const sameIdentity = (a: BacktestClosedTradeIdentity, b: BacktestClosedTradeIdentity) =>
  a.tradeId === b.tradeId && a.runId === b.runId && a.accountId === b.accountId && a.instrument === b.instrument;
const yieldToTask = (signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(cancelled()); return; }
  const abort = () => { clearTimeout(timer); reject(cancelled()); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 0);
  signal.addEventListener('abort', abort, { once: true });
});

/** One bounded emission queue per owner/run generation. Runtime closed records
 * remain the recovery source until each individual persist resolves; failures
 * and cancellation never populate the durable set. */
export const createBacktestClosedTradeEmitter = <Job>(options: BacktestClosedTradeEmitterOptions<Job>) => {
  const controller = new AbortController();
  const known = new Map<string, BacktestClosedTradeIdentity>();
  const identities = new Map<string, BacktestClosedTradeIdentity>();
  let pending = new Map<string, Job>();
  let attempted = new Set<string>();
  let active: Promise<BacktestClosedTradeEmissionResult> | undefined;
  const guard = () => {
    if (controller.signal.aborted || (options.isCurrent && !options.isCurrent())) throw cancelled();
  };
  const identity = (job: Job) => {
    const value = options.identity(job);
    if (!options.ownerId || !value.tradeId || !value.instrument || value.runId !== options.runId
      || value.accountId !== options.accountId || (identities.has(value.tradeId) && !sameIdentity(identities.get(value.tradeId)!, value))) {
      throw new Error('Obchod ve frontě nepatří této session nebo účtu.');
    }
    return value;
  };
  const drain = async (): Promise<BacktestClosedTradeEmissionResult> => {
    const result: BacktestClosedTradeEmissionResult = { durableIds: [], failedIds: [], error: null, cancelled: false };
    const fail = (ids: string[], reason: unknown) => {
      result.failedIds.push(...ids);
      result.error ??= reason instanceof Error ? reason.message : String(reason);
    };
    try {
      const checked = new Set<string>();
      while (pending.size) {
        guard();
        const [firstId] = pending.keys();
        if (!checked.has(firstId)) {
          const batch = [...pending.entries()].slice(0, 100).filter(([id]) => !checked.has(id));
          try {
            const found = await options.preflight(batch.map(([, job]) => identity(job)), controller.signal);
            guard();
            const expected = new Set(batch.map(([id]) => id));
            if ([...found.durableIds].some(id => !expected.has(id))) throw new Error('Potvrzení obsahuje obchod mimo dávku obnovy.');
            for (const [id, job] of batch) {
              checked.add(id);
              if (found.durableIds.has(id)) {
                known.set(id, identity(job)); result.durableIds.push(id); pending.delete(id);
              }
            }
          } catch (reason) {
            guard();
            if (reason instanceof Error && reason.name === 'AbortError') throw reason;
            fail([...pending.keys()], reason);
            pending.forEach((_, id) => attempted.add(id));
            pending.clear();
            break;
          }
          // Re-read the queue after an async lookup: a fresh close has priority.
          await (options.yieldTask ?? yieldToTask)(controller.signal);
          continue;
        }
        const job = pending.get(firstId)!;
        const expected = identity(job);
        pending.delete(firstId); attempted.add(firstId);
        try {
          await (options.yieldTask ?? yieldToTask)(controller.signal);
          guard();
          const trade = await options.mapTrade(job, controller.signal);
          guard();
          if (!sameIdentity(expected, { tradeId: String(trade.id), runId: trade.backtestRunId ?? '',
            accountId: trade.accountId, instrument: trade.instrument })) throw new Error('Přepočet vrátil jinou identitu obchodu.');
          await options.persist(trade);
          guard();
          known.set(firstId, expected); result.durableIds.push(firstId);
        } catch (reason) {
          guard();
          if (reason instanceof Error && reason.name === 'AbortError') throw reason;
          fail([firstId], reason);
        }
      }
    } catch (reason) {
      if (controller.signal.aborted || (options.isCurrent && !options.isCurrent())
        || (reason instanceof Error && reason.name === 'AbortError')) result.cancelled = true;
      else fail([...pending.keys()], reason);
      pending.clear();
    }
    return result;
  };
  const emit = (jobs: readonly Job[]): Promise<BacktestClosedTradeEmissionResult> => {
    try {
      guard();
      const added = new Map<string, Job>();
      for (const job of jobs) {
        const value = identity(job);
        if (!identities.has(value.tradeId)) identities.set(value.tradeId, { ...value });
        if (!known.has(value.tradeId) && !pending.has(value.tradeId) && !attempted.has(value.tradeId)) added.set(value.tradeId, job);
      }
      // New closes jump ahead of the old recovery backlog after the active job.
      if (added.size) pending = new Map([...added, ...pending]);
      if (active) return active;
      attempted = new Set();
      active = drain().finally(() => { active = undefined; attempted.clear(); });
      return active;
    } catch (reason) {
      return Promise.resolve({ durableIds: [], failedIds: [], error: reason instanceof Error ? reason.message : String(reason),
        cancelled: controller.signal.aborted || (options.isCurrent ? !options.isCurrent() : false) });
    }
  };
  return { emit, dispose: () => { controller.abort(); pending.clear(); known.clear(); identities.clear(); } };
};
