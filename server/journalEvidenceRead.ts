import type { SupabaseClient } from '@supabase/supabase-js';
import { readStoredJournalEvidence, type JournalEvidencePage, type JournalFeedScope } from '../lib/journalEvidenceFeed.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function journalFeedCursor(value: unknown, fallback?: number): number {
  if (value == null && fallback != null) return fallback;
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('invalid-journal-cursor');
  return Number(value);
}

export async function readJournalEvidencePage(db: SupabaseClient, scope: JournalFeedScope, after: number, through?: number): Promise<JournalEvidencePage> {
  if (!UUID.test(scope.connectionId) || !Number.isSafeInteger(after) || after < 0
    || (through != null && (!Number.isSafeInteger(through) || through < after))) throw new Error('invalid-journal-cursor');
  const { data: connection, error: connectionError } = await db.from('tradovate_oauth_connections')
    .select('id').eq('id', scope.connectionId).eq('user_id', scope.ownerId).eq('environment', scope.environment).maybeSingle();
  if (connectionError) throw new Error('journal-connection-read-failed');
  if (!connection) throw new Error('journal-connection-not-found');
  const query = () => db.from('tradovate_journal_evidence').select('ingest_id,evidence')
    .eq('user_id', scope.ownerId).eq('connection_id', scope.connectionId).eq('environment', scope.environment);
  const { data: newest, error: newestError } = await query().order('ingest_id', { ascending: false }).limit(1);
  if (newestError) throw new Error('journal-evidence-read-failed');
  const latest = Number(newest?.[0]?.ingest_id ?? 0);
  if (!Number.isSafeInteger(latest) || latest < after || (through != null && through > latest)) throw new Error('invalid-journal-cursor');
  const boundary = through ?? latest;
  const { data, error } = await query().gt('ingest_id', after).lte('ingest_id', boundary).order('ingest_id', { ascending: true }).limit(251);
  if (error) throw new Error('journal-evidence-read-failed');
  const rows = (data ?? []).slice(0, 250).map(row => {
    const cursor = Number(row.ingest_id);
    if (!Number.isSafeInteger(cursor)) throw new Error('journal-evidence-cursor-out-of-range');
    return { cursor, event: readStoredJournalEvidence(row.evidence, scope) };
  });
  const hasMore = (data?.length ?? 0) > 250;
  return { scope, after, through: boundary, next: hasMore ? rows.at(-1)!.cursor : boundary, hasMore, rows };
}
