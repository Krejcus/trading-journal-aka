import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Account } from '../types.js';
import { projectJournalAccounts } from '../lib/journalAccountProjection.js';
import { journalPositionWrite } from '../lib/journalTradeFacts.js';
import type { JournalFeedScope } from '../lib/journalEvidenceFeed.js';
import { persistStagedJournalPositions } from './journalStagedImport.js';
import { prepareJournalInput } from './journalIncrementalInput.js';
import { persistJournalUntakenOrders } from './journalUntakenOrders.js';
import { stable } from '../lib/journalCheckpoint.js';
import { advanceJournalCheckpoint, journalReopenTarget, markJournalEvaluated, readJournalCheckpoints, reopenJournalCheckpoint } from './journalCheckpointStore.js';

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

  // 17. 9. 2026: web, iPhone a localhost importovaly totéž připojení naráz;
  // každý commit posunul generaci ostatním a jejich snapshot čtení padalo na
  // `journal-input-changed`. Jeden importér na připojení; ostatní dostanou
  // `processing` a přijdou s dalším cyklem.
  const holder = randomUUID();
  const { data: acquired, error: leaseError } = await db.rpc('claim_journal_import_lease', {
    p_user_id: scope.ownerId, p_connection_id: scope.connectionId, p_holder: holder, p_ttl_ms: JOURNAL_IMPORT_LEASE_MS,
  });
  if (leaseError) throw new Error('journal-lease-unavailable');
  if (acquired !== true) return { accepted: false, processing: true, through: 0, targetThrough: 0, confirmed: 0, pending: 0, unassigned: 0 };
  try {
    // Rezerva před vypršením lease (120 s): posun bodu se jinak dokončí příště.
    return await importWithLease(db, scope, Date.now() + JOURNAL_IMPORT_LEASE_MS - 30_000);
  } finally {
    await db.rpc('release_journal_import_lease', { p_user_id: scope.ownerId, p_connection_id: scope.connectionId, p_holder: holder })
      .then(() => undefined, () => undefined);
  }
}

/** Longest single import a holder may run before another importer may take over. */
export const JOURNAL_IMPORT_LEASE_MS = 120_000;

async function importWithLease(db: SupabaseClient, scope: JournalFeedScope, deadline: number): Promise<JournalImportResult> {
  const input=await prepareJournalInput(db,scope);
  const through=input.through;
  const processing = (): JournalImportResult => ({ accepted:false,processing:true,through,targetThrough:input.targetThrough ?? through,confirmed:0,pending:0,unassigned:0 });
  if (!input.ready) return processing();
  const events=input.events;
  const { data, error } = await db.from('accounts').select('id,meta').eq('user_id', scope.ownerId)
    .contains('meta', { oauth: { provider: 'tradovate', environment: scope.environment, connectionId: scope.connectionId } }).limit(251);
  if (error) throw new Error('journal-account-read-failed');
  if ((data?.length ?? 0) > 250) throw new Error('journal-import-partition-required');
  const accounts: Pick<Account, 'id' | 'oauth'>[] = (data ?? []).map(row => ({ id: row.id, oauth: row.meta?.oauth }));
  const bindings = [...accounts].sort((a,b) => a.id.localeCompare(b.id));
  // Živý deník (14. 10. 2026): obchody před kontrolním bodem jsou zmrazené.
  // Změněné propojení účtů nebo pozdní evidence k nim bod vrátí zpět.
  const state = await readJournalCheckpoints(db, scope);
  if (state.epoch !== input.checkpointEpoch) return processing();
  if (state.active) {
    const target = stable(state.active.bindings) !== stable(bindings) ? 0
      : await journalReopenTarget(db, scope, events, state);
    if (target != null) {
      await reopenJournalCheckpoint(db, scope, target, state.epoch);
      return processing();
    }
  }
  const window = state.active ? { start: state.active.at, flatAccounts: new Set(state.active.flatAccounts) } : undefined;
  const projection = projectJournalAccounts(events, accounts, window);
  const positions = [...projection.ready.map(journalPositionWrite), ...projection.pending.map(journalPositionWrite)];
  const counts = { confirmed: projection.ready.length, pending: projection.pending.length, unassigned: projection.unassignedFillIds.length };
  const hash = createHash('sha256').update(JSON.stringify({ epoch: state.epoch, positions, bindings, counts })).digest('hex');
  const receipt = { version: 2, accounts: bindings, ...counts, hash };
  const cas = { checkpointEpoch: state.epoch, inputGeneration: input.generation };
  const { data: head } = await db.from('tradovate_journal_projection_heads').select('revision,completed_revision,import_receipt')
    .eq('user_id', scope.ownerId).eq('connection_id', scope.connectionId).maybeSingle();
  let result: JournalImportResult;
  if (head && Number(head.revision) === Number(head.completed_revision) && head.import_receipt?.hash === hash) {
    // Pozice se nezměnily: jen posunout vstup, žádná nová generace pro čtenáře.
    if (!await markJournalEvaluated(db, scope, through, state.epoch, input.generation)) {
      return { accepted: false, stale: true, through, confirmed: 0, pending: 0, unassigned: 0 };
    }
    result = { accepted: true, unchanged: true, through: Number(head.completed_revision), ...counts };
  } else if (positions.length > 100 || Buffer.byteLength(JSON.stringify(positions)) > 1_000_000) {
    const staged = await persistStagedJournalPositions(db, scope, through, positions, receipt, cas);
    if (!staged.accepted) return 'processing' in staged ? processing()
      : { accepted: false, stale: true, through, confirmed: 0, pending: 0, unassigned: 0 };
    result = { accepted: true, through, ...counts };
  } else {
    const { data: ack, error: persistError } = await db.rpc('persist_tradovate_journal_positions', {
      p_user_id: scope.ownerId, p_connection_id: scope.connectionId, p_revision: through, p_positions: positions,
      p_import_receipt: receipt, p_checkpoint_epoch: cas.checkpointEpoch, p_input_generation: cas.inputGeneration,
    });
    if (persistError) {
      const reason = ['journal-legacy-reference-ambiguous', 'journal-legacy-connection-unavailable', 'journal-frozen-conflict']
        .find(code => persistError.message.includes(code));
      throw new Error(reason ?? 'journal-position-write-failed');
    }
    if (ack?.accepted === false && ack.stale === true) {
      return { accepted: false, stale: true, through, confirmed: 0, pending: 0, unassigned: 0 };
    }
    if (ack?.accepted !== true || !Array.isArray(ack.tradeIds) || ack.tradeIds.length !== positions.length
      || new Set(ack.tradeIds).size !== positions.length) throw new Error('journal-position-write-not-confirmed');
    result = { accepted: true, through, ...counts };
  }
  await persistJournalUntakenOrders(db, scope, projection.untaken);
  // Posun bodu jen nad právě zapsaným (nebo nezměněným) stavem a v rozpočtu.
  try {
    await advanceJournalCheckpoint(db, scope, { events, state, bindings, deadline,
      reference: { episodes: projection.episodes.episodes, untakenOrders: projection.episodes.untakenOrders } });
  } catch (reason) {
    console.warn('[journal-import] checkpoint not advanced', reason instanceof Error ? reason.message : String(reason));
  }
  return result;
}
