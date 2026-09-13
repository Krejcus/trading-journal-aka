import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { JournalFeedScope } from '../lib/journalEvidenceFeed.js';
import type { JournalPositionWrite } from '../lib/journalTradeFacts.js';

const CHUNK_BYTES = 1_000_000;
const CHUNK_ROWS = 100;
const TOTAL_BYTES = 96_000_000;
const TOTAL_ROWS = 50_000;

/** Bound each request independently. A complete, unusually large position is
 * never silently split into inconsistent financial/history fragments. */
export function journalPositionChunks(positions: readonly JournalPositionWrite[]): JournalPositionWrite[][] {
  if (positions.length > TOTAL_ROWS) throw new Error('journal-import-partition-required');
  const chunks: JournalPositionWrite[][] = [];
  let chunk: JournalPositionWrite[] = [], bytes = 2, total = 0;
  for (const position of positions) {
    const size = Buffer.byteLength(JSON.stringify(position)) + 1;
    if (size + 2 > CHUNK_BYTES || total + size > TOTAL_BYTES) throw new Error('journal-import-partition-required');
    if (chunk.length && (chunk.length >= CHUNK_ROWS || bytes + size > CHUNK_BYTES)) {
      chunks.push(chunk); chunk = []; bytes = 2;
    }
    chunk.push(position); bytes += size; total += size;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

/** Service-only staging. Retrying the same complete projection reuses its run
 * and identical chunks; only final publication changes visible history. */
export type JournalStageResult = { accepted: true; staged: true }
  | { accepted: false; stale: true } | { accepted: false; processing: true };

export async function persistStagedJournalPositions(db: SupabaseClient, scope: JournalFeedScope,
  revision: number, positions: readonly JournalPositionWrite[], receipt: Record<string, unknown>,
  options: { maxChunks?: number; maxMs?: number } = {}): Promise<JournalStageResult> {
  const maxChunks = options.maxChunks ?? 8, maxMs = options.maxMs ?? 5000;
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 64 || !Number.isFinite(maxMs) || maxMs <= 0) {
    throw new Error('invalid-journal-stage-budget');
  }
  const startedAt = Date.now();
  const chunks = journalPositionChunks(positions);
  if (!chunks.length) throw new Error('invalid-journal-stage');
  const hash = createHash('sha256').update(JSON.stringify({ revision, receipt }));
  for (const chunk of chunks) hash.update(JSON.stringify(chunk));
  const common = { p_user_id: scope.ownerId, p_connection_id: scope.connectionId };
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(name, { ...common, ...args });
    if (error) {
      const known = ['journal-legacy-reference-ambiguous', 'journal-legacy-connection-unavailable',
        'journal-import-checkpoint-mismatch', 'journal-stage-conflict', 'journal-stage-superseded']
        .find(code => error.message.includes(code));
      throw new Error(known ?? 'journal-stage-write-failed');
    }
    return data;
  };
  const started = await invoke('begin_journal_position_stage', { p_revision: revision, p_run_key: hash.digest('hex'),
    p_chunk_count: chunks.length, p_position_count: positions.length, p_import_receipt: receipt });
  if (started?.accepted === false && started.stale === true) return { accepted: false, stale: true };
  if (started?.accepted !== true || typeof started.runId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(started.runId)
    || !Array.isArray(started.completedChunks)
    || started.completedChunks.some((index: unknown) => typeof index !== 'number' || !Number.isSafeInteger(index) || index<0 || index>=chunks.length)
    || new Set(started.completedChunks).size!==started.completedChunks.length) {
    throw new Error('journal-stage-not-confirmed');
  }
  const run = { p_run_id: started.runId };
  const completed = new Set<number>(started.completedChunks);
  let written = 0;
  for (let index = 0; index < chunks.length; index++) {
    if (completed.has(index)) continue;
    if (written >= maxChunks || Date.now() - startedAt >= maxMs) return { accepted: false, processing: true };
    const ack = await invoke('write_journal_position_stage', { ...run, p_chunk_index: index, p_positions: chunks[index] });
    if (ack?.accepted !== true || ack.chunkIndex !== index || ack.positionCount !== chunks[index].length) {
      throw new Error('journal-stage-not-confirmed');
    }
    written++;
  }
  if (Date.now() - startedAt >= maxMs) return { accepted: false, processing: true };
  const ack = await invoke('publish_journal_position_stage', run);
  if (ack?.accepted === false && ack.stale === true) return { accepted: false, stale: true };
  if (ack?.accepted !== true || ack.through !== revision || ack.positionCount !== positions.length) {
    throw new Error('journal-position-write-not-confirmed');
  }
  return { accepted: true, staged: true };
}
