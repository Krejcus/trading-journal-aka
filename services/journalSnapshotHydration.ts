import type { SupabaseClient } from '@supabase/supabase-js';
import type { Trade } from '../types';
import { isEvidenceJournalTrade } from '../lib/journalTradeFacts';

type Snapshot = NonNullable<Trade['copierSnapshots']>[number];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Read-only media enrichment after financial verification. A missing media
 * service must not change PnL or retain previously linked, unverified images. */
export async function hydrateJournalSnapshots(client: SupabaseClient, trades: readonly Trade[], ownerId: string,
  active: () => Promise<void>, signal: () => AbortSignal): Promise<Trade[]> {
  const journal = trades.filter(isEvidenceJournalTrade);
  if (!journal.length) return [...trades];
  const results = new Map<string, Partial<Trade>>();
  for (let index = 0; index < journal.length; index += 100) {
    const selected = journal.slice(index, index + 100);
    const byId = new Map(selected.map(trade => [String(trade.id), trade]));
    const snapshots = new Map<string, Snapshot[]>(), episodes = new Map<string, string>();
    try {
      let after = '', count = 0, bytes = 0;
      for (;;) {
        await active();
        const { data, error } = await client.from('journal_trade_snapshots')
          .select('page_key,user_id,trade_id,journal_account_id,snapshot_id,episode_id,kind,at,storage_path')
          .eq('user_id', ownerId).in('trade_id', [...byId.keys()]).gt('page_key', after)
          .order('page_key').limit(250).abortSignal(signal());
        await active();
        if (error || !Array.isArray(data) || data.length > 250) throw new Error('journal-snapshots-unavailable');
        if (!data.length) break; // A lower server page cap does not mean EOF.
        count += data.length; bytes += JSON.stringify(data).length;
        if (count > 20_000 || bytes > 8_000_000) throw new Error('journal-snapshots-partition-required');
        for (const row of data) {
          const trade = byId.get(row.trade_id), at = Date.parse(row.at);
          if (!trade || row.user_id !== ownerId || row.journal_account_id !== trade.accountId
            || typeof row.page_key !== 'string' || row.page_key <= after || !uuid.test(row.snapshot_id) || !uuid.test(row.episode_id)
            || row.page_key !== `${row.trade_id}:${row.snapshot_id}` || !['entry', 'exit', 'sl-moved'].includes(row.kind)
            || !Number.isSafeInteger(at) || at <= 0
            || row.storage_path !== `${ownerId}/${row.episode_id}/${row.kind}-${at}.png`
            || (episodes.has(row.trade_id) && episodes.get(row.trade_id) !== row.episode_id)) throw new Error('journal-snapshots-invalid');
          after = row.page_key;
          episodes.set(row.trade_id, row.episode_id);
          const list = snapshots.get(row.trade_id) ?? [];
          list.push({ kind: row.kind, at, path: row.storage_path }); snapshots.set(row.trade_id, list);
        }
      }
      for (const trade of selected) results.set(String(trade.id), {
        copierSnapshots: (snapshots.get(String(trade.id)) ?? []).sort((a,b) => a.at-b.at || a.path.localeCompare(b.path)),
        copierEpisodeId: episodes.get(String(trade.id)), copierSnapshotLoadError: false,
      });
    } catch {
      // Authentication/cancellation still aborts the whole owner read.
      await active();
      for (const trade of selected) results.set(String(trade.id), {
        copierSnapshots: [], copierEpisodeId: undefined, copierSnapshotLoadError: true,
      });
    }
  }
  await active();
  return trades.map(trade => ({ ...trade, ...results.get(String(trade.id)) }));
}
