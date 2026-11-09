/** Per-account, read-only continuity proof. An ACK/heartbeat never creates one. */
export function createTradovateStreamReadProof<T>(session: () => string, now: () => number) {
  let unknownRevision = 0, readGeneration = 0, readSequence = 0;
  const revisions = new Map<number, number>();
  type Origin = { session: string; unknownRevision: number; generation: number; at: number; sequence: number };
  type Fence = Origin & { revision: number };
  type Row = { fence: Fence; positions?: T; positionsAt?: number; positionsSequence?: number; ordersAt?: number; ordersSequence?: number; baselineAt?: number };
  const rows = new Map<number, Row>();
  const current = (accountId: number, fence: Fence) => fence.session !== '' && fence.session === session()
    && fence.revision === (revisions.get(accountId) ?? 0) && fence.unknownRevision === unknownRevision;
  const captureRead = (): Origin => ({session: session(), unknownRevision, generation: readGeneration, at: now(), sequence: ++readSequence});
  return {
    captureRead,
    generation: () => readGeneration,
    invalidate(accountId?: number) {
      readGeneration += 1;
      if (accountId == null) { unknownRevision += 1; rows.clear(); }
      else { revisions.set(accountId, (revisions.get(accountId) ?? 0) + 1); rows.delete(accountId); }
    },
    capture(accountId: number, origin = captureRead()): Fence { return { ...origin, revision: revisions.get(accountId) ?? 0 }; },
    accept(accountId: number, fence: Fence, part: 'positions' | 'orders', positions?: T) {
      if (!current(accountId, fence) || fence.generation !== readGeneration) return;
      const old = rows.get(accountId);
      const row: Row = old && current(accountId, old.fence) && old.fence.generation === fence.generation ? old : { fence };
      if (part === 'positions') {
        if (fence.sequence <= (row.positionsSequence ?? -1)) return;
        row.positions = positions; row.positionsAt = fence.at; row.positionsSequence = fence.sequence;
      } else {
        if (fence.sequence <= (row.ordersSequence ?? -1)) return;
        row.ordersAt = fence.at; row.ordersSequence = fence.sequence;
      }
      // Keep the original read timestamps, never the time a heartbeat renders them.
      if (row.positions !== undefined && row.positionsAt != null && row.ordersAt != null) row.baselineAt = Math.min(row.positionsAt!, row.ordersAt);
      rows.set(accountId, row);
    },
    get(accountId: number): { at: number; positions: T } | null {
      const row = rows.get(accountId);
      return row && current(accountId, row.fence) && row.baselineAt != null && row.positions !== undefined
        ? { at: row.baselineAt, positions: row.positions } : null;
    },
  };
}
