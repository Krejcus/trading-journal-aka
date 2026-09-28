export interface CopierRelayStatusEnvelope<T> {
  status: T;
  lastSeenAt: string;
  connected: boolean;
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
