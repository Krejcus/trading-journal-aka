import type { Account } from '../types';
import { JOURNAL_BACKFILL_TYPES } from '../lib/journalBackfillPlan';
import type { JournalBackfillType } from '../lib/journalAccountingBackfill';

export interface JournalSourceStatus {
  type: JournalBackfillType;
  recordedAt: number | null;
  metadata: null | {
    kind: 'observed' | 'unavailable'; startedAt: number; completedAt: number;
    scope: 'available-list' | 'known-parents' | null;
    scanned: number | null; recorded: number | null; contended: number | null;
    requested: number | null; remaining: number | null;
  };
}
export interface JournalConnectionSources {
  connectionId: string; environment: 'demo' | 'live'; sources: JournalSourceStatus[];
}
export interface JournalSourceConnection { connectionId: string; accountCount: number }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('journal-source-invalid-response');
  return value as Record<string, unknown>;
};
const fail = (): never => { throw new Error('journal-source-invalid-response'); };
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): number | null => value == null ? null
  : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fail();

/** Deduplicate archived/current accounts and share one availability section per
 * connection. Its count describes linked accounts, never completed copies. */
export function journalSourceConnections(accounts: readonly Account[], extraIds: readonly string[] = []): JournalSourceConnection[] {
  const grouped = new Map<string, Set<string>>();
  for (const id of extraIds) grouped.set(id.toLowerCase(), new Set());
  for (const account of accounts) if (account.oauth?.provider === 'tradovate') {
    const id = account.oauth.connectionId.toLowerCase();
    if (!grouped.has(id)) grouped.set(id, new Set());
    grouped.get(id)!.add(account.id);
  }
  return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([connectionId, ids]) => ({ connectionId, accountCount: ids.size }));
}

export function decodeJournalSourceStatus(value: unknown, expected: readonly string[], now = Date.now()): JournalConnectionSources[] {
  const rows = object(value).connections;
  if (!Array.isArray(rows) || rows.length !== expected.length) return fail();
  const seen = new Set<string>();
  return rows.map(value => {
    const row = object(value);
    if (typeof row.connectionId !== 'string' || !expected.includes(row.connectionId) || seen.has(row.connectionId)
      || !['demo', 'live'].includes(String(row.environment)) || !Array.isArray(row.sources)
      || row.sources.length !== JOURNAL_BACKFILL_TYPES.length) return fail();
    seen.add(row.connectionId);
    const types = new Set<string>();
    const sources = row.sources.map(value => {
      const source = object(value); const type = source.type as JournalBackfillType;
      if (!JOURNAL_BACKFILL_TYPES.includes(type) || types.has(type)) return fail();
      types.add(type);
      if (source.metadata === null && source.recordedAt === null) return { type, metadata: null, recordedAt: null };
      const metadata = object(source.metadata);
      const recordedAt = typeof source.recordedAt === 'string' ? Date.parse(source.recordedAt) : NaN;
      const startedAt = count(metadata.startedAt), completedAt = count(metadata.completedAt);
      if (!Number.isFinite(recordedAt) || recordedAt <= 0 || recordedAt > now + 300_000
        || !startedAt || !completedAt || startedAt > completedAt || completedAt > recordedAt + 1_000
        || !['observed', 'unavailable'].includes(String(metadata.kind))
        || !(metadata.scope == null || ['available-list', 'known-parents'].includes(String(metadata.scope)))) return fail();
      const scanned = count(metadata.scanned, 10_000), recorded = count(metadata.recorded, 10_000), contended = count(metadata.contended, 10_000);
      const requested = count(metadata.requested, 100), remaining = count(metadata.remaining);
      if (metadata.kind === 'observed' && (scanned === null || recorded === null || contended === null || recorded + contended > scanned)) return fail();
      if (metadata.scope === 'known-parents' && (requested === null || remaining === null)) return fail();
      return { type, recordedAt, metadata: { kind: metadata.kind as 'observed' | 'unavailable', startedAt, completedAt,
        scope: metadata.scope as 'available-list' | 'known-parents' | null ?? null, scanned, recorded, contended, requested, remaining } };
    });
    return { connectionId: row.connectionId, environment: row.environment as 'demo' | 'live', sources };
  });
}

/** Bounded owner RPC batches; no partial success or stale session result. */
export async function readJournalSourceStatus(readBatch: (ids: readonly string[], signal: AbortSignal) => Promise<unknown>, owner: string, ids: readonly string[],
  stillOwner: () => boolean | Promise<boolean>, signal?: AbortSignal): Promise<JournalConnectionSources[]> {
  const active = async () => {
    if (signal?.aborted || !await stillOwner()) throw new Error('journal-source-session-changed');
  };
  await active();
  if (!uuid.test(owner) || ids.length > 250 || ids.some(id => !uuid.test(id)) || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) throw new Error('journal-source-invalid-scope');
  const timeout = AbortSignal.timeout(60_000);
  const result: JournalConnectionSources[] = [];
  for (let offset = 0; offset < ids.length; offset += 25) {
    await active();
    const batch = ids.slice(offset, offset + 25).map(id => id.toLowerCase());
    const data = await readBatch(batch, AbortSignal.any([timeout, AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]));
    await active();
    if (timeout.aborted) throw new Error('journal-source-unavailable');
    result.push(...decodeJournalSourceStatus(data, batch));
  }
  await active();
  return result;
}
