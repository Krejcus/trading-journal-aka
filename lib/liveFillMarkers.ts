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

/** Stáří expozice workeru, nad kterým šipky nekreslíme (stejné jako overlay expozice). */
const LIVE_FILLS_MAX_AGE_MS = 8_000;
const LIVE_FILLS_FUTURE_MS = 5_000;

/**
 * Šipky plnění leadera ze statusu workeru (2. 11. 2026) — JEN zobrazení. Nic, pokud stav
 * není čerstvý a neobnovený, expozice je starší než 8 s (nebo „z budoucnosti“), worker je
 * odpojený, expozici nezná, epizoda není celá (`fromFlat`) nebo má mezeru. `open` jen
 * z autoritativní expozice leadera; když nesedí se znaménkem plnění (Position/Fill
 * závod), `undefined` = skryto — nikdy „flat“ z neznáma (INV-UI-01/03).
 */
export function liveFillMarkersFromStatus(input: {
  controller: {
    connected?: boolean;
    exposure?: { positions: readonly { accountId: number; symbol: string; netQuantity: number }[] } | null;
    leaderFills?: {
      symbol: string; fromFlat: boolean; gap?: true; netAfter: number;
      fills: readonly { fillId: string; orderId: string; at: number; price: number; side: 'Buy' | 'Sell'; quantity: number; role: 'entry' | 'exit' }[];
    } | null;
  } | null | undefined;
  exposureObservedAt: number | null;
  fresh: boolean;
  leaderAccountId: number | null | undefined;
  /** Kořen grafu (MNQ — NQ i MNQ kontrakty téže rodiny se nekreslí přes sebe). */
  root: string;
  now: number;
}): { fills: LiveFillMarker[]; open: boolean | undefined } {
  const none = { fills: [] as LiveFillMarker[], open: undefined };
  const controller = input.controller;
  const ring = controller?.leaderFills;
  if (!input.fresh || !controller || controller.connected !== true || !ring || !ring.fromFlat || ring.gap) return none;
  if (input.exposureObservedAt == null || input.now - input.exposureObservedAt > LIVE_FILLS_MAX_AGE_MS
    || input.exposureObservedAt > input.now + LIVE_FILLS_FUTURE_MS) return none;
  if (!controller.exposure || input.leaderAccountId == null) return none;
  if (!new RegExp(`^${input.root}[FGHJKMNQUVXZ]\\d{1,2}$`).test(ring.symbol)) return none;
  const net = controller.exposure.positions
    .find(position => position.accountId === input.leaderAccountId && position.symbol === ring.symbol)?.netQuantity ?? 0;
  if (Math.sign(net) !== Math.sign(ring.netAfter)) return none;
  return {
    fills: ring.fills.map(fill => ({ id: fill.fillId, orderId: fill.orderId, at: fill.at, price: fill.price, side: fill.side, role: fill.role, quantity: fill.quantity })),
    open: net !== 0,
  };
}

/** Plnění, která už kreslí deník (stejné id plnění u brokera), se živě nezdvojí. */
export function liveFillsNotInJournal(fills: readonly LiveFillMarker[], journalFillIds: ReadonlySet<string>): LiveFillMarker[] {
  // Jakmile je v deníku kterékoli plnění epizody, kreslí ji deník celou — živé šipky pryč
  // (jinak by zbyla půlka obchodu, např. jen výstup).
  return fills.some(fill => journalFillIds.has(fill.id)) ? [] : [...fills];
}
