import type { Trade } from '../types.js';

/** The input is money from the confirmed SQL projection. Do not manufacture R
 * from a later stop or a stale legacy risk attached to a journal import. */
export function sharedTradeResult(trade: Pick<Trade, 'pnl' | 'riskAmount' | 'copierTradeId'>,
  unit: 'usd' | 'rr' | 'hidden'): { pnl: number | null; riskAmount: number | undefined } {
  const riskAmount = !trade.copierTradeId?.startsWith('journal:')
    && typeof trade.riskAmount === 'number' && Number.isFinite(trade.riskAmount) && trade.riskAmount > 0
    ? trade.riskAmount : undefined;
  if (unit === 'hidden' || !Number.isFinite(trade.pnl)) return { pnl: null, riskAmount: undefined };
  if (unit === 'usd') return { pnl: trade.pnl, riskAmount };
  if (!riskAmount) return { pnl: null, riskAmount: undefined };
  const pnl = trade.pnl / riskAmount;
  return Number.isFinite(pnl) ? { pnl, riskAmount: 1 } : { pnl: null, riskAmount: undefined };
}
