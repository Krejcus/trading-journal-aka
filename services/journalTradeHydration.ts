import type { SupabaseClient } from '@supabase/supabase-js';
import type { Trade } from '../types';
import { hydrateJournalSnapshots } from './journalSnapshotHydration';
import { isEvidenceJournalTrade, isRetiredJournalTrade, mergeJournalTradeFacts, type StoredJournalTradeFacts } from '../lib/journalTradeFacts';

/** Broker execution history belongs to the owner-only evidence tables. Review
 * sharing and ordinary trade saves must not copy it into a public JSON blob. */
export function stripPrivateJournalHistory<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripPrivateJournalHistory) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'executionHistory' && key !== 'copierSnapshotLoadError')
    .map(([key, item]) => [key, stripPrivateJournalHistory(item)])) as T;
}

type Head = { connection_id: string; revision: number; completed_revision: number; generation: number };
const fingerprint = (rows: Head[]) => JSON.stringify(rows.map(row => [row.connection_id, row.revision, row.completed_revision, row.generation]).sort());

async function loadJournalHeads(client: SupabaseClient, ownerId: string, signal?: AbortSignal): Promise<Head[]> {
  const { data,error } = await client.from('tradovate_journal_projection_heads')
    .select('connection_id,revision,completed_revision,generation').eq('user_id',ownerId).order('connection_id').limit(501)
    .abortSignal(signal ? AbortSignal.any([signal,AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000));
  if (error || !Array.isArray(data) || data.length>500) throw new Error('journal-facts-unavailable');
  const rows: Head[]=data.map(row=>({ ...row,revision:Number(row.revision),completed_revision:Number(row.completed_revision),generation:Number(row.generation) }));
  if (rows.some(row=>typeof row.connection_id!=='string' || [row.revision,row.completed_revision,row.generation].some(value=>!Number.isSafeInteger(value) || value<0)
    || row.revision!==row.completed_revision) || new Set(rows.map(row=>row.connection_id)).size!==rows.length) throw new Error('journal-facts-incomplete');
  return rows;
}

/** Bracket root-row pagination as well as fact hydration: a newly imported UUID
 * could otherwise be inserted behind a page cursor before hydration starts. */
export async function journalProjectionFingerprint(client: SupabaseClient, ownerId: string, signal?: AbortSignal) {
  return fingerprint(await loadJournalHeads(client,ownerId,signal));
}

/** Read all requested financial facts consistently across bounded URL batches.
 * A generation changes even when the same evidence revision is reprojected
 * after an account mapping change; equal source cursors alone are insufficient.
 * Do not fall back to stale root prices/PnL if evidence cannot be verified. */
export async function hydrateOwnedJournalTrades(
  client: SupabaseClient, trades: readonly Trade[], ownerId: string | null, targetOwnerId: string | null,
  stillOwner: () => boolean | Promise<boolean>, options: { signal?: AbortSignal; detail?: boolean } = {},
): Promise<Trade[]> {
  const clean = trades.map(stripPrivateJournalHistory).filter(trade => !isRetiredJournalTrade(trade));
  const journal = clean.filter(isEvidenceJournalTrade);
  if (!journal.length) return clean;
  // Social/public reads must use a separately verified public financial
  // projection; never query another owner's private table or reuse their cache.
  if (!ownerId || ownerId !== targetOwnerId) return clean.filter(trade => !isEvidenceJournalTrade(trade));
  const active = async () => {
    if (options.signal?.aborted) throw new Error('journal-read-aborted');
    if (!await stillOwner()) throw new Error('journal-session-changed');
  };
  const signal = () => options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  const readHeads = async () => {
    await active();
    const rows=await loadJournalHeads(client,ownerId,options.signal);
    await active();
    return rows;
  };
  const before = await readHeads();
  const heads = new Map(before.map(row => [row.connection_id, row]));
  const ids = [...new Set(journal.map(trade => String(trade.id)))];
  const records: StoredJournalTradeFacts[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < ids.length; index += 100) {
    await active();
    const selected = ids.slice(index, index + 100);
    const { data, error } = await client.from('tradovate_journal_positions')
      .select(`trade_id,journal_account_id,status,facts,connection_id,external_account_id,revision${options.detail ? ',history' : ''}`)
      .eq('user_id', ownerId).in('trade_id', selected)
      .returns<Array<StoredJournalTradeFacts & { connection_id: string; external_account_id: number; revision: number }>>()
      .abortSignal(signal());
    await active();
    if (error || !Array.isArray(data)) throw new Error('journal-facts-unavailable');
    for (const row of data) {
      if (!selected.includes(row.trade_id) || seen.has(row.trade_id) || !heads.has(row.connection_id)
        || Number(row.revision) !== heads.get(row.connection_id)!.revision
        || !['confirmed', 'pending', 'invalidated'].includes(row.status)
        || !row.facts || typeof row.facts !== 'object' || Array.isArray(row.facts)) throw new Error('journal-facts-incomplete');
      if (options.detail && (!row.history || row.history.connectionId !== row.connection_id || row.history.environment !== 'demo'
        || row.history.accountId !== Number(row.external_account_id) || !Array.isArray(row.history.fills)
        || !Array.isArray(row.history.protection) || !Array.isArray(row.history.gaps))) throw new Error('journal-history-incomplete');
      seen.add(row.trade_id); records.push(row as unknown as StoredJournalTradeFacts);
    }
  }
  if (seen.size !== ids.length) throw new Error('journal-facts-incomplete');
  await active();
  const result = mergeJournalTradeFacts(clean, records);
  if (result.filter(isEvidenceJournalTrade).length !== records.filter(row => row.status === 'confirmed').length) {
    // A malformed confirmed member must fail the combined read, not quietly
    // reduce the account count and present the remainder as a complete result.
    throw new Error('journal-facts-incomplete');
  }
  const enriched = await hydrateJournalSnapshots(client, result, ownerId, active, signal);
  if (fingerprint(before) !== fingerprint(await readHeads())) throw new Error('journal-facts-changed-during-read');
  await active();
  return enriched;
}
