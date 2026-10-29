import type { CopierControllerStatus, CopierDisplayStuckOperation } from '../services/copierRuntimeController';

/** Nevyřešené ruční vstupy ze statusu jako položky panelu „čekající na ruční kontrolu“. */
export function manualEntryDisplayStuckOperations(
  status: Pick<CopierControllerStatus, 'manualEntries'> | null | undefined,
): CopierDisplayStuckOperation[] {
  return (status?.manualEntries ?? [])
    .filter(entry => entry.status === 'unknown' || entry.status === 'abandoned')
    .map(entry => ({
      kind: 'manual-entry' as const,
      key: entry.operationId,
      status: entry.status === 'abandoned' ? 'abandoned' as const : 'unknown' as const,
      leaderSequence: 0,
      updatedAt: entry.updatedAt,
      reason: `Ruční vstup ${entry.side === 'Buy' ? 'BUY' : 'SELL'} ${entry.quantity} ${entry.symbol}: ${entry.reason ?? 'výsledek neznámý'}`,
      ...(entry.entryBrokerOrderId ? { brokerOrderId: entry.entryBrokerOrderId } : {}),
    }));
}
