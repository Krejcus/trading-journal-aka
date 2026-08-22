import type { SupabaseClient } from '@supabase/supabase-js';

export const shouldRunTvAlertPurge = (now: Date): boolean => now.getUTCMinutes() === 0;

/**
 * Deletes only objects referenced by expired tv_alerts and only metadata rows
 * explicitly tagged `tv-alert`. Entry/exit/sl-moved copier evidence is outside
 * both delete predicates and remains journal data.
 */
export async function purgeExpiredTvAlerts(options: {
  db: SupabaseClient;
  now?: number;
}): Promise<{ alerts: number; objects: number }> {
  const cutoff = new Date((options.now ?? Date.now()) - 24 * 60 * 60_000).toISOString();
  const { data, error } = await options.db.from('tv_alerts')
    .select('id,snapshot_path').lt('created_at', cutoff).limit(500);
  if (error) throw new Error(`tv-alert-purge-query-failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; snapshot_path: string | null }>;
  if (rows.length === 0) return { alerts: 0, objects: 0 };
  const paths = [...new Set(rows.flatMap(row => row.snapshot_path ? [row.snapshot_path] : []))];
  if (paths.length > 0) {
    const removed = await options.db.storage.from('copier-snapshots').remove(paths);
    if (removed.error) throw new Error(`tv-alert-purge-storage-failed: ${removed.error.message}`);
  }
  const ids = rows.map(row => row.id);
  const metadata = await options.db.from('copier_trade_snapshots')
    .delete().eq('kind', 'tv-alert').in('episode_id', ids);
  if (metadata.error) throw new Error(`tv-alert-purge-metadata-failed: ${metadata.error.message}`);
  const deleted = await options.db.from('tv_alerts').delete().in('id', ids).lt('created_at', cutoff);
  if (deleted.error) throw new Error(`tv-alert-purge-rows-failed: ${deleted.error.message}`);
  return { alerts: rows.length, objects: paths.length };
}
