import { supabase } from './supabase';
import { getUserId } from './storageService';
import { BacktestTradeIdentityError, type BacktestClosedTradeIdentity } from './backtestTradeOutbox';

/** Identity projection only. Never fetch notes, drawings or analytics merely to
 * decide whether replay recovery should invoke its expensive mapper. */
export const lookupBacktestTradeIdentities = async (
  identities: readonly BacktestClosedTradeIdentity[],
  ownerId: string,
  signal?: AbortSignal,
  isCurrent?: () => boolean,
): Promise<BacktestClosedTradeIdentity[]> => {
  const guard = async () => {
    if (signal?.aborted || (isCurrent && !isCurrent())) throw new DOMException('Obnova obchodů byla zrušena.', 'AbortError');
    if (!ownerId || await getUserId() !== ownerId) throw new Error('Přihlášený uživatel se změnil.');
    if (signal?.aborted || (isCurrent && !isCurrent())) throw new DOMException('Obnova obchodů byla zrušena.', 'AbortError');
  };
  await guard();
  if (!identities.length) return [];
  const scope = identities[0];
  if (identities.length > 100 || !scope.runId || !scope.accountId || identities.some(identity =>
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.tradeId)
    || identity.runId !== scope.runId || identity.accountId !== scope.accountId || !identity.instrument)) {
    throw new BacktestTradeIdentityError('Lookup vyžaduje nejvýše 100 obchodů jednoho účtu a session.');
  }
  const requested = new Map(identities.map(identity => [identity.tradeId, identity]));
  if (requested.size !== identities.length) throw new BacktestTradeIdentityError('Lookup obsahuje duplicitní identitu obchodu.');
  // Probe only these UUIDs of this owner, then verify account/run. Filtering by
  // the expected account here would hide a collided UUID in another account as
  // "missing", allowing the legacy insert-only retry path to acknowledge it.
  let query = supabase.from('trades')
    .select('id,user_id,account_id,instrument,backtest_run_id,backtestRunId:data->>backtestRunId')
    .eq('user_id', ownerId).in('id', [...requested.keys()]);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  await guard();
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('Server nepotvrdil výsledek hledání obchodů.');
  const found = new Set<string>();
  return data.map(row => {
    const id = String(row.id);
    const expected = requested.get(id);
    const runId = row.backtest_run_id ?? row.backtestRunId;
    if (!expected || found.has(id) || row.user_id !== ownerId || row.account_id !== expected.accountId
      || runId !== expected.runId || row.instrument !== expected.instrument) {
      throw new BacktestTradeIdentityError('Server vrátil obchod s neodpovídající identitou.');
    }
    found.add(id);
    return { tradeId: id, runId, accountId: row.account_id, instrument: row.instrument };
  });
};
