import type { CopierControllerStatus, CopierDisplayStuckOperation } from '../services/copierRuntimeController';

/** Změna obchodu (`manage:`) kopírku nevypíná ani neblokuje ruční zapnutí; ostatní operace ano. */
export const isStuckManageChange = (key: string) => key.startsWith('manage:');
export const stuckResolvedText = (key: string) => (isStuckManageChange(key)
  ? 'Změna obchodu označena za vyřešenou. Kopírka zůstává ve svém stavu.'
  : 'Operace označena za vyřešenou. Runtime je VYPNUTO; před zapnutím proběhne nová kontrola pozic.');

/** Nevyřešené ruční vstupy ze statusu jako položky panelu „čekající na ruční kontrolu“. */
export function manualEntryDisplayStuckOperations(
  status: Pick<CopierControllerStatus, 'manualEntries' | 'unresolvedManualOrderActions'> | null | undefined,
): CopierDisplayStuckOperation[] {
  // Změna obchodu s neznámým výsledkem (posun, doplnění SL/TP): sama se nevyřeší a blokuje další kroky.
  const actions = (status?.unresolvedManualOrderActions ?? [])
    .filter(action => action.status === 'unknown' || Date.now() - action.updatedAt > 60_000)
    .map(action => ({
      kind: 'manual-entry' as const,
      key: action.operationId,
      status: 'unknown' as const,
      leaderSequence: 0,
      updatedAt: action.updatedAt,
      reason: `Změna obchodu ${action.action}${action.symbol ? ` ${action.symbol}` : ''}: ${action.reason ?? 'výsledek neznámý'}`,
    }));
  return [...actions, ...(status?.manualEntries ?? [])
    // `sending` déle než minutu = neuložený neznámý výsledek (odeslání trvá max. pár sekund).
    .filter(entry => entry.status === 'unknown' || entry.status === 'abandoned'
      || (entry.status === 'sending' && Date.now() - entry.updatedAt > 60_000))
    .map(entry => ({
      kind: 'manual-entry' as const,
      key: entry.operationId,
      status: entry.status === 'abandoned' ? 'abandoned' as const : 'unknown' as const,
      leaderSequence: 0,
      updatedAt: entry.updatedAt,
      reason: `Ruční vstup ${entry.side === 'Buy' ? 'BUY' : 'SELL'} ${entry.quantity} ${entry.symbol}: ${entry.reason ?? 'výsledek neznámý'}`,
      ...(entry.entryBrokerOrderId ? { brokerOrderId: entry.entryBrokerOrderId } : {}),
    }))];
}
