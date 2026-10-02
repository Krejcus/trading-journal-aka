import {
  startCopierRelayStatusPoll,
  type CopierRelayStatusCandidate,
  type CopierRelayStatusEnvelope,
} from './copierRelayStatusPoll';

/**
 * Relay polling helpers that keep a slow connection from holding back the
 * selected worker status. Pure state, no React — the LIVE desk owns one
 * instance per mounted poller.
 *
 * Safety: nothing here accepts a copier status. Status acceptance stays in
 * the desk (identity check, poll fence, revision order). These helpers only
 * decide which relay reads to start and how display feeds from reads that
 * finish at different times are combined.
 */

/** Tracks relay reads per connection so a new poll never starts a second read
 * for a connection whose previous read is still pending. The pending read is
 * NOT shared with the new poll: its result belongs to the poll that started
 * it and is judged by that poll's fence generation. */
export class CopierRelayInFlight {
  private readonly pending = new Set<string>();

  /** Connection IDs that may start a read now (input order preserved). */
  launchable(connectionIds: readonly string[]): string[] {
    return connectionIds.filter(id => !this.pending.has(id));
  }

  hasPending(connectionIds: readonly string[]): boolean {
    return connectionIds.some(id => this.pending.has(id));
  }

  track<T>(connectionId: string, read: () => Promise<T>): Promise<T> {
    this.pending.add(connectionId);
    let promise: Promise<T>;
    try {
      promise = read();
    } catch (error) {
      this.pending.delete(connectionId);
      return Promise.reject(error);
    }
    return promise.finally(() => {
      this.pending.delete(connectionId);
    });
  }
}

/** Display feeds keyed by the relay connection that delivered them. A feed
 * set is replaced only by a read from the same or a newer poll, so a slow
 * read finishing late never overwrites what a newer poll already showed, and
 * a fast poll never drops feeds of connections it did not read. */
export class CopierRelayFeedSources<F> {
  private readonly sources = new Map<string, { sequence: number; feeds: readonly F[] }>();
  private lastRound = 0;

  /** Pořadí kola vydává úložiště samo, aby po remountu LIVE (sdílené
   * úložiště, nová instance pollu) nové kolo nebylo „starší“ než uložené. */
  beginRound(): number {
    this.lastRound += 1;
    return this.lastRound;
  }

  /** Connected candidate delivered feeds. Returns false when a newer poll
   * already published this source. */
  set(connectionId: string, sequence: number, feeds: readonly F[]): boolean {
    const current = this.sources.get(connectionId);
    if (current && current.sequence > sequence) return false;
    this.sources.set(connectionId, { sequence, feeds });
    return true;
  }

  /** Candidate answered but its worker is not connected: its feeds no longer
   * describe a live worker. Older polls cannot remove newer feeds. */
  drop(connectionId: string, sequence: number): boolean {
    const current = this.sources.get(connectionId);
    if (!current || current.sequence > sequence) return false;
    this.sources.delete(connectionId);
    return true;
  }

  clear(): void {
    this.sources.clear();
  }

  /** Feeds of sources that are still among the user's active connections. */
  feeds(activeConnectionIds: readonly string[]): F[] {
    const active = new Set(activeConnectionIds);
    return [...this.sources.entries()]
      .filter(([connectionId]) => active.has(connectionId))
      .flatMap(([, source]) => source.feeds);
  }
}

export type CopierRelayStatusRoundResult<T> =
  /** Nic nespuštěno: všechna spojení mají předchozí čtení ještě v běhu. */
  | { outcome: 'pending' }
  /** První spojení s živým workerem předáno `onFirstConnected`; ostatní se
   * dočtou na pozadí do `onSettled` a další kolo na ně nečeká. */
  | { outcome: 'connected' }
  /** Žádné právě čtené spojení nemá živý worker. `skippedPending` = některé
   * starší čtení ještě běží, o stavu tedy rozhodne to kolo. */
  | { outcome: 'settled'; candidates: CopierRelayStatusCandidate<T>[]; skippedPending: boolean };

/**
 * Jedno kolo relay dotazování workeru. Rychlé spojení s živým workerem se
 * přijme hned; pomalé vedlejší spojení kolo neblokuje a nové kolo ho znovu
 * nečte, dokud jeho čtení běží. Přijetí stavu (identita, fence, pořadí
 * revizí) zůstává na volajícím v `onFirstConnected` / `onSettled`.
 */
export async function runCopierRelayStatusRound<T>(options: {
  connectionIds: readonly string[];
  preferredConnectionId: string | null;
  inFlight: CopierRelayInFlight;
  load: (connectionId: string) => Promise<CopierRelayStatusEnvelope<T> | null>;
  onFirstConnected: (candidate: CopierRelayStatusCandidate<T>) => void;
  onSettled: (candidates: CopierRelayStatusCandidate<T>[]) => void;
}): Promise<CopierRelayStatusRoundResult<T>> {
  const launchable = options.inFlight.launchable(options.connectionIds);
  const skippedPending = options.inFlight.hasPending(options.connectionIds);
  if (launchable.length === 0 && skippedPending) return { outcome: 'pending' };
  const poll = startCopierRelayStatusPoll(
    launchable,
    options.preferredConnectionId,
    connectionId => options.inFlight.track(connectionId, () => options.load(connectionId)),
  );
  const first = await poll.firstConnected;
  if (first) {
    options.onFirstConnected(first);
    void poll.settled.then(options.onSettled);
    return { outcome: 'connected' };
  }
  const candidates = await poll.settled;
  options.onSettled(candidates);
  return { outcome: 'settled', candidates, skippedPending };
}
