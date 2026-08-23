import { supabase } from './supabase';

export interface CopierAccountSnapshotRow {
  connection_id: string;
  external_account_id: string;
  captured_at: string;
  balance: number;
  realized_pnl_day: number | null;
  open_pnl: number | null;
  auto_liq_level: number | null;
}

let cachedRows: CopierAccountSnapshotRow[] | null = null;
let cachedUserId: string | null = null;
let cachedAt = 0;
let pendingLoad: Promise<CopierAccountSnapshotRow[]> | null = null;

/**
 * Cron plní snapshoty á 15 minut, takže starší data než pár minut nemají
 * cenu držet. Bez životnosti se cache načetla jednou za relaci a Kokpit pak
 * ukazoval zůstatek zamrzlý na hodnotě z okamžiku otevření stránky.
 */
const CACHE_TTL_MS = 5 * 60_000;

/** Jeden sdílený dotaz za mount/session; RLS omezuje výsledek na přihlášeného uživatele. */
export function loadCopierAccountSnapshots(days = 35): Promise<CopierAccountSnapshotRow[]> {
  if (pendingLoad) return pendingLoad;
  pendingLoad = (async () => {
    try {
      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (authError || !authData.user) throw new Error('Pro načtení snapshotů účtů je nutné přihlášení.');
      if (cachedRows && cachedUserId === authData.user.id && Date.now() - cachedAt < CACHE_TTL_MS) {
        return cachedRows.map(row => ({ ...row }));
      }
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from('copier_account_snapshots')
        .select('connection_id,external_account_id,captured_at,balance,realized_pnl_day,open_pnl,auto_liq_level')
        .gte('captured_at', since)
        // PostgREST usekne výsledek na 1000 řádků AŽ PO seřazení. Vzestupně
        // by tak přežily nejstarší záznamy a `at(-1)` by vracelo zastaralý
        // zůstatek — u deseti účtů se limit vyčerpá za jediný den. Sestupné
        // řazení s explicitním limitem drží vždy ta nejčerstvější data.
        .order('captured_at', { ascending: false })
        .limit(5_000);
      if (error) throw new Error(`Načtení snapshotů účtů selhalo: ${error.message}`);
      cachedRows = ((data ?? []) as CopierAccountSnapshotRow[]).filter(row => (
        typeof row.connection_id === 'string'
        && typeof row.external_account_id === 'string'
        && Number.isFinite(row.balance)
        && Number.isFinite(Date.parse(row.captured_at))
      ));
      cachedUserId = authData.user.id;
      cachedAt = Date.now();
      return cachedRows.map(row => ({ ...row }));
    } finally {
      pendingLoad = null;
    }
  })();
  return pendingLoad;
}

export function clearCopierAccountSnapshotCacheForTests() {
  cachedRows = null;
  cachedUserId = null;
  cachedAt = 0;
  pendingLoad = null;
}
