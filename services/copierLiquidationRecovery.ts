import { isOpenOrderStatus, type BrokerPort, type BrokerPosition } from './brokerPort';
import {
  markLiquidationAwaitingCleanup,
  markLiquidationConfirmedByState,
  needsLiquidationStateRecovery,
  type OutboxEntry,
} from './copierOutbox';

export interface LiquidationRecoveryResult {
  entry: OutboxEntry;
  resolution: 'not-applicable' | 'confirmed-by-state' | 'awaiting-cleanup' | 'unresolved';
  netQuantity?: number;
  workingOrders?: number;
  error?: string;
}

const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

export function netQuantityForSymbol(
  positions: readonly BrokerPosition[],
  accountId: number,
  symbol: string,
): number {
  return positions
    .filter(position => position.accountId === accountId && position.symbol === symbol)
    .reduce((sum, position) => sum + position.netQuantity, 0);
}

const asLegacyLiquidation = (entry: OutboxEntry): OutboxEntry => entry.liquidationAttempt
  ? { ...entry, operationKind: 'liquidate-position' }
  : {
    ...entry,
    operationKind: 'liquidate-position',
    liquidationAttempt: {
      status: 'legacy-unknown',
      observedAt: entry.updatedAt,
      ...(entry.reason ? { reason: entry.reason } : {}),
    },
  };

/**
 * Read-only recovery nativního liquidation outboxu.
 *
 * `liquidateposition` nepřenáší náš tag, takže tag lookup nikdy nemůže
 * rozhodnout o retry. Dvě position čtení kolem order snapshotu potvrzují
 * pouze bezpečný cílový stav; netvrdí, který příkaz jej způsobil.
 */
export async function recoverLiquidationEntryByState(options: {
  entry: OutboxEntry;
  broker: BrokerPort;
  clock: () => number;
}): Promise<LiquidationRecoveryResult> {
  if (!needsLiquidationStateRecovery(options.entry)) {
    return { entry: options.entry, resolution: 'not-applicable' };
  }

  const entry = asLegacyLiquidation(options.entry);
  const { accountId, symbol } = entry.request;
  try {
    const positionsBefore = await options.broker.listPositions(accountId);
    const orders = await options.broker.listOrders(accountId);
    const positionsAfter = await options.broker.listPositions(accountId);
    const beforeNet = netQuantityForSymbol(positionsBefore, accountId, symbol);
    const afterNet = netQuantityForSymbol(positionsAfter, accountId, symbol);
    const workingOrders = orders.filter(order => (
      order.accountId === accountId
      && order.symbol === symbol
      && isOpenOrderStatus(order.status)
    )).length;
    const observedAt = options.clock();

    if (beforeNet === 0 && afterNet === 0 && workingOrders === 0) {
      return {
        entry: markLiquidationConfirmedByState(entry, {
          accountId,
          symbol,
          observedAt,
          source: 'restart-recovery',
        }),
        resolution: 'confirmed-by-state',
        netQuantity: 0,
        workingOrders: 0,
      };
    }

    if (beforeNet === 0 && afterNet === 0) {
      return {
        entry: markLiquidationAwaitingCleanup(entry, observedAt),
        resolution: 'awaiting-cleanup',
        netQuantity: 0,
        workingOrders,
      };
    }

    const unresolved = entry.status === 'planned' && entry.attempts > 0
      ? {
        ...entry,
        status: 'unknown' as const,
        liquidationPhase: 'awaiting-state' as const,
        reason: 'Legacy liquidate už mohl být odeslán; tag lookup ani blind retry nejsou bezpečné',
        updatedAt: observedAt,
      }
      : entry;
    return {
      entry: unresolved,
      resolution: 'unresolved',
      netQuantity: afterNet,
      workingOrders,
    };
  } catch (reason) {
    return {
      entry,
      resolution: 'unresolved',
      error: errorMessage(reason),
    };
  }
}
