import type { CopierControllerStatus, CopierDisplayStuckOperation } from '../services/copierRuntimeController';

/** Nevyřešené ruční vstupy ze statusu jako položky panelu „čekající na ruční kontrolu“. */
export function manualEntryDisplayStuckOperations(
  status: Pick<CopierControllerStatus, 'manualEntries' | 'manualOrderActions'> | null | undefined,
): CopierDisplayStuckOperation[] {
  // Posun limitu, který ani po čtení nejde rozhodnout: worker umí `manage:` vyřešit ručně, nic se neposílá.
  const moves: CopierDisplayStuckOperation[] = (status?.manualOrderActions ?? [])
    .filter(action => action.action === 'move-limit' && action.status === 'unknown')
    .map(action => ({
      kind: 'manual-entry' as const, key: action.operationId, status: 'unknown' as const, leaderSequence: 0, updatedAt: action.updatedAt,
      reason: `Posun limitu na ${action.toPrice}: ${action.reason ?? 'výsledek neznámý'}`,
    }));
  return [...moves, ...(status?.manualEntries ?? [])
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
