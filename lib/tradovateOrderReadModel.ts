export interface TradovateOrderVersionEntity {
  id?: number;
  orderId?: number;
  orderQty?: number;
  orderType?: string;
  price?: number;
  stopPrice?: number;
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Tradovate keeps the mutable order fields on OrderVersion, not reliably on
 * Order. Pick the newest version so every read model uses the broker's latest
 * quantity, type and prices.
 */
export const latestTradovateOrderVersionsByOrderId = <T extends TradovateOrderVersionEntity>(
  versions: readonly T[],
): Map<number, T> => {
  const latest = new Map<number, T>();
  for (const version of versions) {
    const orderId = finite(version.orderId);
    if (orderId == null) continue;
    const current = latest.get(orderId);
    if (!current || (finite(version.id) ?? 0) >= (finite(current.id) ?? 0)) {
      latest.set(orderId, version);
    }
  }
  return latest;
};

/**
 * Only venue-confirmed Working orders count as live protection or pending
 * entries. Suspended/unknown transitional rows must fail closed in the UI.
 */
export const isTradovateWorkingStatus = (status: string | null | undefined): boolean =>
  (status ?? '').trim().toLowerCase() === 'working';
