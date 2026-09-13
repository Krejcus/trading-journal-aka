import type { SupabaseClient } from '@supabase/supabase-js';
import type { Account } from '../types.js';
import { projectJournalAccounts } from '../lib/journalAccountProjection.js';
import { journalPositionWrite } from '../lib/journalTradeFacts.js';
import type { JournalFeedScope } from '../lib/journalEvidenceFeed.js';
import { persistStagedJournalPositions } from './journalStagedImport.js';
import { prepareJournalInput } from './journalIncrementalInput.js';

export interface JournalImportResult {
  accepted: boolean;
  stale?: boolean;
  unchanged?: boolean;
  processing?: boolean;
  targetThrough?: number;
  through: number;
  confirmed: number;
  pending: number;
  unassigned: number;
}

/** Browser supplies only the connection ID. Recompute financial facts from
 * owner-scoped immutable evidence; do not trust prices or PnL in a request.
 * New source batches update durable derived input; the financial account set is
 * published only after that fixed source snapshot is fully processed. */
export async function importJournalPositions(db: SupabaseClient, scope: JournalFeedScope): Promise<JournalImportResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scope.connectionId)) throw new Error('invalid-journal-cursor');
  if (scope.environment !== 'demo') throw new Error('invalid-journal-environment');
  const { data: checkpoint, error: checkpointError } = await db.rpc('read_journal_import_checkpoint', {
    p_user_id: scope.ownerId, p_connection_id: scope.connectionId,
  });
  if (checkpointError) throw new Error(checkpointError.message.includes('journal-connection-not-found')
    ? 'journal-connection-not-found' : 'journal-checkpoint-read-failed');
  if (checkpoint != null) {
    if (checkpoint.accepted !== true || checkpoint.unchanged !== true
      || ![checkpoint.through, checkpoint.confirmed, checkpoint.pending, checkpoint.unassigned]
        .every((value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      || (checkpoint.through === 0 && checkpoint.confirmed + checkpoint.pending + checkpoint.unassigned > 0)) {
      throw new Error('journal-checkpoint-invalid');
    }
    return { accepted: true, unchanged: true, through: checkpoint.through,
      confirmed: checkpoint.confirmed, pending: checkpoint.pending, unassigned: checkpoint.unassigned };
  }

  const input=await prepareJournalInput(db,scope);
  const through=input.through;
  if (!input.ready) return { accepted:false,processing:true,through,targetThrough:input.targetThrough,confirmed:0,pending:0,unassigned:0 };
  const events=input.events;
  const { data, error } = await db.from('accounts').select('id,meta').eq('user_id', scope.ownerId)
    .contains('meta', { oauth: { provider: 'tradovate', environment: scope.environment, connectionId: scope.connectionId } }).limit(251);
  if (error) throw new Error('journal-account-read-failed');
  if ((data?.length ?? 0) > 250) throw new Error('journal-import-partition-required');
  const accounts: Pick<Account, 'id' | 'oauth'>[] = (data ?? []).map(row => ({ id: row.id, oauth: row.meta?.oauth }));
  const projection = projectJournalAccounts(events, accounts);
  const positions = [...projection.ready.map(journalPositionWrite), ...projection.pending.map(journalPositionWrite)];
  const receipt = { version: 2, accounts: [...accounts].sort((a,b) => a.id.localeCompare(b.id)),
    confirmed: projection.ready.length, pending: projection.pending.length, unassigned: projection.unassignedFillIds.length };
  if (positions.length > 100 || Buffer.byteLength(JSON.stringify(positions)) > 1_000_000) {
    const staged = await persistStagedJournalPositions(db, scope, through, positions, receipt);
    if (!staged.accepted) return 'processing' in staged
      ? { accepted: false, processing: true, through, targetThrough: through, confirmed: 0, pending: 0, unassigned: 0 }
      : { accepted: false, stale: true, through, confirmed: 0, pending: 0, unassigned: 0 };
    return { accepted: true, through, confirmed: receipt.confirmed, pending: receipt.pending, unassigned: receipt.unassigned };
  }
  const { data: ack, error: persistError } = await db.rpc('persist_tradovate_journal_positions', {
    p_user_id: scope.ownerId, p_connection_id: scope.connectionId, p_revision: through, p_positions: positions,
    p_import_receipt: receipt,
  });
  if (persistError) {
    const reason = ['journal-legacy-reference-ambiguous', 'journal-legacy-connection-unavailable']
      .find(code => persistError.message.includes(code));
    throw new Error(reason ?? 'journal-position-write-failed');
  }
  if (ack?.accepted === false && ack.stale === true) {
    return { accepted: false, stale: true, through, confirmed: 0, pending: 0, unassigned: 0 };
  }
  if (ack?.accepted !== true || !Array.isArray(ack.tradeIds) || ack.tradeIds.length !== positions.length
    || new Set(ack.tradeIds).size !== positions.length) throw new Error('journal-position-write-not-confirmed');
  return { accepted: true, through, confirmed: projection.ready.length, pending: projection.pending.length,
    unassigned: projection.unassignedFillIds.length };
}
