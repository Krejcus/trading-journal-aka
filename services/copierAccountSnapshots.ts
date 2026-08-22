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
let pendingLoad: Promise<CopierAccountSnapshotRow[]> | null = null;

/** Jeden sdílený dotaz za mount/session; RLS omezuje výsledek na přihlášeného uživatele. */
export function loadCopierAccountSnapshots(days = 35): Promise<CopierAccountSnapshotRow[]> {
  if (pendingLoad) return pendingLoad;
  pendingLoad = (async () => {
    try {
      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (authError || !authData.user) throw new Error('Pro načtení snapshotů účtů je nutné přihlášení.');
      if (cachedRows && cachedUserId === authData.user.id) return cachedRows.map(row => ({ ...row }));
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from('copier_account_snapshots')
        .select('connection_id,external_account_id,captured_at,balance,realized_pnl_day,open_pnl,auto_liq_level')
        .gte('captured_at', since)
        .order('captured_at', { ascending: true });
      if (error) throw new Error(`Načtení snapshotů účtů selhalo: ${error.message}`);
      cachedRows = ((data ?? []) as CopierAccountSnapshotRow[]).filter(row => (
        typeof row.connection_id === 'string'
        && typeof row.external_account_id === 'string'
        && Number.isFinite(row.balance)
        && Number.isFinite(Date.parse(row.captured_at))
      ));
      cachedUserId = authData.user.id;
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
  pendingLoad = null;
}
