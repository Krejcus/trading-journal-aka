export interface CopierRelayStatusEnvelope<T> {
  status: T;
  lastSeenAt: string;
  connected: boolean;
  /** Stáří spočítané serverem vůči stejným hodinám jako lastSeenAt. */
  ageMs?: number;
}

/** Převod serverového stáří na lokální monotónní bod přijetí bez porovnání
 * hodin klienta a DB. Záporné serverové stáří tolerujeme jako nulu. */
export function copierRelayObservedAt(
  remote: Pick<CopierRelayStatusEnvelope<unknown>, 'ageMs' | 'connected'>,
  receivedAt: number,
): number {
  if (Number.isFinite(remote.ageMs)) return receivedAt - Math.max(0, remote.ageMs!);
  return remote.connected ? receivedAt : Number.NEGATIVE_INFINITY;
}

export interface CopierRelayStatusCandidate<T> {
  connectionId: string;
  remote: CopierRelayStatusEnvelope<T> | null;
}

export function startCopierRelayStatusPoll<T>(
  connectionIds: readonly string[],
  preferredConnectionId: string | null,
  load: (connectionId: string) => Promise<CopierRelayStatusEnvelope<T> | null>,
): {
  firstConnected: Promise<CopierRelayStatusCandidate<T> | null>;
  settled: Promise<CopierRelayStatusCandidate<T>[]>;
} {
  const orderedIds = [...new Set(connectionIds)].sort((left, right) => (
    left === preferredConnectionId ? -1 : right === preferredConnectionId ? 1 : 0
  ));
  let pending = orderedIds.length;
  let resolved = false;
  let resolveFirst!: (candidate: CopierRelayStatusCandidate<T> | null) => void;
  const firstConnected = new Promise<CopierRelayStatusCandidate<T> | null>(resolve => {
    resolveFirst = resolve;
    if (pending === 0) {
      resolved = true;
      resolve(null);
    }
  });

  const reads = orderedIds.map(async connectionId => ({ connectionId, remote: await load(connectionId) }));
  for (const read of reads) {
    void read.then(candidate => {
      if (!resolved && candidate.remote?.connected) {
        resolved = true;
        resolveFirst(candidate);
      }
    }).catch(() => undefined).finally(() => {
      pending -= 1;
      if (!resolved && pending === 0) {
        resolved = true;
        resolveFirst(null);
      }
    });
  }

  const settled = Promise.allSettled(reads).then(results => results.flatMap(result => (
    result.status === 'fulfilled' ? [result.value] : []
  )));
  return { firstConnected, settled };
}

export function newestCopierRelaySnapshot<T>(
  candidates: readonly CopierRelayStatusCandidate<T>[],
  preferredConnectionId: string | null,
): CopierRelayStatusCandidate<T> | null {
  return [...candidates]
    .filter((candidate): candidate is CopierRelayStatusCandidate<T> & { remote: CopierRelayStatusEnvelope<T> } => candidate.remote != null)
    .sort((left, right) => {
      const timeDifference = Date.parse(right.remote.lastSeenAt) - Date.parse(left.remote.lastSeenAt);
      if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference;
      return left.connectionId === preferredConnectionId ? -1 : right.connectionId === preferredConnectionId ? 1 : 0;
    })[0] ?? null;
}
