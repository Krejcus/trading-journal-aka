import type { RithmicFields } from './rithmicCodec';

export interface RithmicQuantityLimits { buy: number; sell: number; order: number }

/** RMS presence bits distinguish a supplied zero from an absent limit. */
export function quantityLimits(account: string, product: string, accounts: RithmicFields[], products: RithmicFields[], identity?: { fcmId: string; ibId: string }): RithmicQuantityLimits | null {
  const matching = accounts.filter(row => row.account_id === account);
  if (matching.length !== 1 || !product) return null;
  const overrides = products.filter(row => row.account_id === account && row.product_code === product);
  if (overrides.length !== 1) return null;
  const rows = [...matching, ...overrides];
  if (identity && rows.some(row => (row.fcm_id != null && row.fcm_id !== identity.fcmId)
    || (row.ib_id != null && row.ib_id !== identity.ibId))) return null;
  if (products.some(row => row.account_id === account && !row.product_code && Number(row.presence_bits) > 0)) return null;
  const bound = (field: string, bit: number) => {
    const limits: number[] = [];
    for (const row of rows) {
      if (!Number.isInteger(row.presence_bits)) return null;
      if (!((row.presence_bits as number) & bit)) continue;
      const value = row[field];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
      limits.push(value);
    }
    return limits.length ? Math.min(...limits) : null;
  };
  const buy = bound('buy_limit', 1);
  const sell = bound('sell_limit', 2);
  const order = bound('max_order_quantity', 8);
  return buy === null || sell === null || order === null ? null : { buy, sell, order };
}
