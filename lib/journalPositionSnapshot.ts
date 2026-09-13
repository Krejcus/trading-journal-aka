import { latestJournalEvidence, orderedJournalEvidence, type JournalEvidence, type JournalObservation } from './tradovateJournalEvidence.js';

const integer = (value: unknown): value is number => Number.isSafeInteger(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Successful complete REST lists only. Completion rows witness the exact number
 * of position rows for each explicitly visible account. No account credentials. */
export function positionSnapshotObservations(snapshotId: string, accounts: unknown, positions: unknown,
  startedAt: number, completedAt: number): JournalObservation[] {
  if (!Array.isArray(accounts) || !Array.isArray(positions) || accounts.length > 250 || positions.length > 100_000
    || !Number.isFinite(startedAt) || !Number.isFinite(completedAt) || startedAt > completedAt) throw new Error('journal-invalid-position-snapshot');
  const byAccount = new Map<number, Map<number, number>>();
  for (const row of accounts) {
    if (!object(row) || !integer(row.id) || row.id <= 0 || byAccount.has(row.id)) throw new Error('journal-invalid-account-snapshot');
    byAccount.set(row.id, new Map());
  }
  for (const row of positions) {
    if (!object(row) || !integer(row.accountId) || !integer(row.contractId) || row.contractId <= 0 || !integer(row.netPos)) throw new Error('journal-invalid-position-snapshot');
    const own = byAccount.get(row.accountId);
    if (!own || own.has(row.contractId)) throw new Error('journal-position-snapshot-account-conflict');
    own.set(row.contractId, row.netPos);
  }
  const result: JournalObservation[] = [];
  const emit = (entity: JournalObservation['entity']) => result.push({ entityType: 'positionsnapshot', entity,
    source: 'snapshot', eventType: 'Observed', receivedAt: completedAt });
  for (const [accountId, rows] of byAccount) {
    for (const [contractId, netPos] of rows) emit({ id: `${snapshotId}:${accountId}:${contractId}`, snapshotId,
      kind: 'position', accountId, contractId, netPos, startedAt, completedAt });
    emit({ id: `${snapshotId}:${accountId}:complete`, snapshotId, kind: 'complete', accountId,
      rowCount: rows.size, startedAt, completedAt });
  }
  return result;
}

export interface JournalPositionAnchor { accountId: number; contractId: number; at: number; net: number }

/** A snapshot only establishes forward state. Missing rows, gaps and exposure
 * changes during its REST window invalidate it, including late-arriving fills. */
export function journalSnapshotAnchors(evidence: readonly JournalEvidence[],
  lanes: readonly { accountId: number; contractId: number }[], gaps: readonly { from: number; to: number | null }[]): JournalPositionAnchor[] {
  const groups = new Map<string, JournalEvidence[]>();
  const latest = latestJournalEvidence(evidence);
  const activity = new Map<number, number[]>();
  const unknownActivity: number[] = [];
  const addActivity = (account: unknown, at: number) => {
    if (!integer(account)) { unknownActivity.push(at); return; }
    const times = activity.get(account) ?? []; times.push(at); activity.set(account, times);
  };
  for (const event of orderedJournalEvidence(evidence)) {
    const row = event.entity;
    if (event.entityType === 'positionsnapshot') {
      if (event.source !== 'snapshot' || typeof row.snapshotId !== 'string' || !integer(row.accountId)) continue;
      const key = `${event.connectionId}:${event.environment}:${event.sessionId}:${row.snapshotId}:${row.accountId}`;
      const group = groups.get(key) ?? []; group.push(event); groups.set(key, group);
    } else if (event.entityType === 'fill' || (event.entityType === 'position' && event.source === 'stream' && row.netPos != null)) {
      const accountId = row.accountId ?? (row.orderId != null ? latest.get(`order:${row.orderId}`)?.entity.accountId : undefined);
      const timestamp = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
      // Receipt is also relevant: a patch arriving during the request means the
      // REST result cannot be assigned an exact point inside that window.
      addActivity(accountId, event.receivedAt);
      if (Number.isFinite(timestamp)) addActivity(accountId, timestamp);
    }
  }
  for (const times of [...activity.values(), unknownActivity]) times.sort((a, b) => a - b);
  const intersects = (times: readonly number[], from: number, to: number) => {
    let low = 0, high = times.length;
    while (low < high) { const middle = (low + high) >>> 1; if (times[middle] < from) low = middle + 1; else high = middle; }
    return low < times.length && times[low] <= to;
  };
  const contracts = new Map<number, Set<number>>();
  for (const lane of lanes) {
    const ids = contracts.get(lane.accountId) ?? new Set<number>(); ids.add(lane.contractId); contracts.set(lane.accountId, ids);
  }
  const result: JournalPositionAnchor[] = [];
  for (const group of groups.values()) {
    const completions = group.filter(event => event.entity.kind === 'complete');
    if (completions.length !== 1) continue;
    const complete = completions[0], row = complete.entity;
    const { accountId, startedAt, completedAt, rowCount } = row;
    if (!integer(accountId) || !integer(startedAt) || !integer(completedAt) || startedAt < 0 || completedAt < startedAt
      || completedAt !== complete.receivedAt || !integer(rowCount) || rowCount < 0
      || group.length !== rowCount + 1) continue;
    if (gaps.some(gap => gap.from <= completedAt && (gap.to ?? Infinity) > startedAt)
      || intersects(unknownActivity, startedAt, completedAt) || intersects(activity.get(accountId) ?? [], startedAt, completedAt)) continue;
    const positions = new Map<number, number>();
    let valid = true;
    for (const item of group) {
      if (item === complete) continue;
      const position = item.entity;
      if (position.kind !== 'position' || position.startedAt !== startedAt || position.completedAt !== completedAt
        || item.receivedAt !== completedAt || !integer(position.contractId) || position.contractId <= 0
        || !integer(position.netPos) || positions.has(position.contractId)) { valid = false; break; }
      positions.set(position.contractId, position.netPos);
    }
    if (!valid) continue;
    for (const contractId of new Set([...contracts.get(accountId) ?? [], ...positions.keys()])) {
      result.push({ accountId, contractId, at: completedAt, net: positions.get(contractId) ?? 0 });
    }
  }
  return result;
}
