import { journalObservation, type JournalEvidence } from './tradovateJournalEvidence.js';

export interface JournalFeedScope { ownerId: string; connectionId: string; environment: 'demo' | 'live' }
export interface JournalEvidencePage {
  scope: JournalFeedScope;
  after: number;
  through: number;
  next: number;
  hasMore: boolean;
  rows: Array<{ cursor: number; event: JournalEvidence }>;
}

/** JSONB may reorder keys. Reading checks schema/scope, not JSON text order. */
export function readStoredJournalEvidence(value: unknown, scope: JournalFeedScope): JournalEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-journal-stored-evidence');
  const row = value as JournalEvidence;
  if (row.connectionId !== scope.connectionId || row.environment !== scope.environment
    || !/^[0-9a-f]{64}$/.test(row.id) || typeof row.sessionId !== 'string'
    || !Number.isSafeInteger(row.sequence) || row.sequence <= 0
    || !['stream', 'snapshot', 'transport'].includes(row.source) || typeof row.eventType !== 'string'
    || typeof row.entityType !== 'string') throw new Error('invalid-journal-stored-evidence');
  const safe = journalObservation(row.entityType, row.entity, row.source, row.eventType, row.receivedAt);
  if (!safe || Object.keys(safe.entity).length !== Object.keys(row.entity).length
    || Object.entries(safe.entity).some(([key, value]) => row.entity[key] !== value)) throw new Error('invalid-journal-stored-evidence');
  return { ...safe, id: row.id, connectionId: row.connectionId, environment: row.environment, sessionId: row.sessionId, sequence: row.sequence };
}

/** Validate the complete page before a cache commits data together with its cursor. */
export function validateJournalEvidencePage(value: unknown, scope: JournalFeedScope, after: number, through?: number): JournalEvidencePage {
  if (!value || typeof value !== 'object') throw new Error('invalid-journal-page');
  const page = value as JournalEvidencePage;
  if (page.scope?.ownerId !== scope.ownerId || page.scope?.connectionId !== scope.connectionId
    || page.scope?.environment !== scope.environment || page.after !== after
    || !Number.isSafeInteger(page.through) || page.through < after || (through != null && page.through !== through)
    || !Number.isSafeInteger(page.next) || page.next < after || page.next > page.through
    || typeof page.hasMore !== 'boolean' || !Array.isArray(page.rows) || page.rows.length > 250) throw new Error('invalid-journal-page');
  let last = after;
  const ids = new Set<string>();
  const rows = page.rows.map(row => {
    if (!Number.isSafeInteger(row.cursor) || row.cursor <= last || row.cursor > page.through) throw new Error('invalid-journal-page-order');
    last = row.cursor;
    const event = readStoredJournalEvidence(row.event, scope);
    if (ids.has(event.id)) throw new Error('invalid-journal-page-duplicate');
    ids.add(event.id); return { cursor: row.cursor, event };
  });
  if ((page.hasMore && (!rows.length || page.next !== last || page.next >= page.through))
    || (!page.hasMore && page.next !== page.through)) throw new Error('invalid-journal-page-cursor');
  return { scope: { ...scope }, after, through: page.through, next: page.next, hasMore: page.hasMore, rows };
}
