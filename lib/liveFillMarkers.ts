import type { TradeExecutionHistory } from './tradeExecutionHistory';

/**
 * Plnění živého obchodu pro šipky v LIVE grafu telefonu — hned po vyplnění,
 * ne až když obchod dorazí do deníku. Kreslí je stejná primitiva jako graf
 * deníku (`services/journalChartPrimitive.ts`), proto se z plnění skládá
 * syntetická historie. Jen zobrazení: cenu a čas dodá datová vrstva z
 * plnění brokera (stream workeru), nikdy z ceny grafu ani TradingView.
 */
export interface LiveFillMarker {
  /** Stabilní ID plnění u brokera (fill id). */
  id: string;
  /** ID příkazu: dílčí plnění jednoho příkazu = jedna šipka. */
  orderId: string;
  /** Čas plnění v ms (broker). */
  at: number;
  price: number;
  side: 'Buy' | 'Sell';
  role: 'entry' | 'exit';
  quantity: number;
}

export function liveFillHistory(fills: readonly LiveFillMarker[], open: boolean): TradeExecutionHistory | null {
  const valid = fills.filter(fill => Number.isFinite(fill.at) && Number.isFinite(fill.price) && fill.price > 0 && fill.quantity > 0)
    .slice().sort((a, b) => a.at - b.at);
  if (!valid.length) return null;
  const entries = valid.filter(fill => fill.role === 'entry');
  return {
    connectionId: 'live',
    environment: 'live',
    accountId: 0,
    fills: valid.map(fill => ({
      id: fill.id, orderId: fill.orderId, accountId: 0, contractId: 0, at: fill.at, timeSource: 'broker' as const,
      side: fill.side, quantity: fill.quantity, price: fill.price, fees: null, feeCurrencyId: null,
      role: fill.role, allocatedQuantity: fill.quantity,
    })),
    protection: [],
    gaps: [],
    grossPnl: null,
    fees: null,
    netPnl: null,
    complete: false,
    issues: [],
    position: {
      id: 'live',
      status: open ? 'open' : 'closed',
      openedAt: (entries[0] ?? valid[0]).at,
      closedAt: open ? null : valid[valid.length - 1].at,
      openQuantity: null,
      peakQuantity: entries.reduce((sum, fill) => sum + fill.quantity, 0),
    },
  };
}

/** Klíč pro překreslení: nová šipka jen při novém plnění, ne s každým tickem. */
export const liveFillKey = (fills: readonly LiveFillMarker[]): string => fills.map(fill => `${fill.id}@${fill.price}`).join('|');
