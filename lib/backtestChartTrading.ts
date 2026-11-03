import type {
  BacktestClosedTrade,
  BacktestFill,
  BacktestInstrument,
  BacktestOrder,
  BacktestPosition,
  BacktestRuntimeState,
} from '../services/backtestTypes';
import { backtestPointValue, backtestTickSize } from '../services/backtestEngine';
import { projectedBacktestPnl, type BacktestChartOrderLine } from '../services/backtestOrderLines';
import { breakEvenStop } from './liveChartPosition';
import { snapToTick, ticketProblems, ticketQuantity, type TicketDraft, type TicketInstrument, type TicketProblem, type TicketQuote } from './liveOrderTicket';
import type { TradeToast } from './liveTradeToasts';

/**
 * Obchodování v backtest grafu stejně jako v LIVE (Filip 3. 11. 2026: „backtest
 * graf je hodně pozadu od live“): panel Objednávka, BE a potvrzení ve štítcích,
 * karta pozice a karty obchodů vlevo dole. Jen simulovaný engine session —
 * žádný relay, broker ani kopírka.
 */

export const BACKTEST_BREAK_EVEN_ACTION = 'break-even';
/** Chvění při kliknutí na čáru nesmí posunout příkaz (jako LIVE). */
const LINE_DEAD_ZONE_PX = 4;

export const backtestTicketInstrument = (instrument: BacktestInstrument): TicketInstrument => ({
  symbol: instrument,
  tickSize: backtestTickSize(instrument),
  pointValue: backtestPointValue(instrument),
});

/**
 * Replay nemá bid/ask: obě strany jsou závěr poslední odkryté svíčky. Engine
 * plní Market za tenhle závěr (+ skluz session), limit/stop podle svíček.
 */
export const backtestTicketQuote = (price: number | null | undefined): TicketQuote | null => (
  price != null && Number.isFinite(price) ? { bid: price, ask: price } : null
);

/** SL a TP návrhu posunuté o kus (Market jede s cenou a drží vzdálenost od vstupu). */
export const shiftDraftBrackets = (draft: TicketDraft, delta: number, tickSize: number): TicketDraft => ({
  ...draft,
  stopLoss: draft.stopLoss == null ? null : snapToTick(draft.stopLoss + delta, tickSize),
  takeProfit: draft.takeProfit == null ? null : snapToTick(draft.takeProfit + delta, tickSize),
});

/**
 * Návrh k odeslání proti ČERSTVÉ svíčce: panel a čáry ukazují cenu z posledního
 * překreslení (při přehrávání až ~0,5 s starou), engine plní za aktuální závěr.
 * Market proto SL/TP posune o rozdíl (stejná vzdálenost jako na obrazovce)
 * a vše se znovu zkontroluje — SL za cenou by se vyplnil hned na další svíčce.
 */
export function backtestSubmitDraft(
  draft: TicketDraft,
  shown: TicketQuote | null,
  fresh: TicketQuote,
  instrument: TicketInstrument,
): { draft: TicketDraft; quantity: number; blocked: string | null } {
  const delta = draft.type === 'market' && shown ? fresh.ask - shown.ask : 0;
  const anchored = delta !== 0 ? shiftDraftBrackets(draft, delta, instrument.tickSize) : draft;
  const quantity = ticketQuantity(anchored, instrument, fresh);
  const error = ticketProblems(anchored, instrument, fresh, null).find(problem => problem.level === 'error');
  return {
    draft: anchored,
    quantity,
    blocked: error ? (shown?.ask !== fresh.ask ? `cena replaye se mezitím pohnula — ${error.text}` : error.text) : null,
  };
}

/**
 * Upozornění panelu, když session už drží pozici: engine při přikoupení
 * nahradí SL/TP celé pozice závorkami nového příkazu (i SL na BE) a příkaz
 * proti pozici ji nejdřív zmenší — jeho závorky platí jen pro případný zbytek.
 */
export function backtestPositionDraftProblem(
  draft: Pick<TicketDraft, 'side' | 'stopLoss' | 'takeProfit'>,
  position: Pick<BacktestPosition, 'side'> | null | undefined,
): TicketProblem | null {
  if (!position) return null;
  const adds = (draft.side === 'buy') === (position.side === 'long');
  if (adds) {
    return draft.stopLoss != null || draft.takeProfit != null
      ? { level: 'warning', text: 'Přikoupení: SL/TP návrhu nahradí SL/TP celé pozice (i SL na BE).' }
      : null;
  }
  return { level: 'warning', text: 'Příkaz proti pozici ji nejdřív zmenší; SL/TP návrhu platí jen pro případnou novou pozici.' };
}

/** Stav tlačítka BE na štítku pozice: SL na průměrný vstup (bez poplatků). */
export function backtestBreakEven(
  position: Pick<BacktestPosition, 'side' | 'averagePrice' | 'stopLoss'>,
  mark: number | null | undefined,
  tickSize: number,
): { price: number | null; blocked: string | null } {
  const price = breakEvenStop(position.side, position.averagePrice, tickSize);
  if (price == null) return { price, blocked: 'Průměrný vstup pozice není známý.' };
  const long = position.side === 'long';
  const stop = Number.isFinite(position.stopLoss) ? Number(position.stopLoss) : null;
  if (stop != null && Math.abs(stop - price) < tickSize / 2) return { price, blocked: 'SL už je na BE.' };
  if (stop != null && (long ? stop > price : stop < price)) return { price, blocked: 'SL už je v zisku — BE by ho povolil.' };
  if (mark == null || !Number.isFinite(mark)) return { price, blocked: 'Bez ceny replaye BE nejde.' };
  // SL na vstupu za cenou trhu by se vyplnil hned na další svíčce.
  if (long ? mark - price < tickSize - 1e-9 : price - mark < tickSize - 1e-9) {
    return { price, blocked: `Cena ještě není ${long ? 'nad' : 'pod'} vstupem — SL na BE by se hned vyplnil.` };
  }
  return { price, blocked: null };
}

/**
 * Čáry enginu se stejným ovládáním jako LIVE: BE ve štítku pozice (dvoukrokově),
 * mrtvá zóna při tažení a × čekajícího příkazu na potvrzení. × u pozice zavírá
 * jedním kliknutím jako v LIVE (Filip 30. 10.). Návrh panelu se nemění.
 */
export function withBacktestLineControls(
  lines: readonly BacktestChartOrderLine[],
  positions: readonly BacktestPosition[],
  mark: number | null | undefined,
  draftOwnerId: string,
): BacktestChartOrderLine[] {
  return lines.map(line => {
    if (line.ownerId === draftOwnerId) return line;
    if (line.ownerType === 'position' && line.kind === 'entry') {
      const position = positions.find(item => item.instrument === line.ownerId);
      if (!position) return line;
      const be = backtestBreakEven(position, mark, backtestTickSize(position.instrument));
      return {
        ...line,
        actions: [{
          id: BACKTEST_BREAK_EVEN_ACTION,
          label: 'BE',
          confirm: true,
          disabled: be.blocked != null,
          title: be.blocked ?? `SL na BE ${be.price?.toFixed(2)} (bez poplatků)`,
        }],
      };
    }
    if (line.kind === 'entry') return { ...line, confirmCancel: true, dragDeadZonePx: LINE_DEAD_ZONE_PX };
    return { ...line, dragDeadZonePx: LINE_DEAD_ZONE_PX };
  });
}

/** Karta pozice v panelu Objednávka (jen zobrazení z enginu session). */
export interface BacktestPositionSummary {
  side: 'long' | 'short';
  quantity: number;
  entry: number;
  mark: number | null;
  /** Hrubé otevřené P&L z ceny replaye (poplatky se odečtou při výstupu). */
  openPnl: number | null;
  stop: number | null;
  target: number | null;
  protection: string;
}

export function backtestPositionSummary(position: BacktestPosition, mark: number | null | undefined): BacktestPositionSummary {
  const stop = Number.isFinite(position.stopLoss) ? Number(position.stopLoss) : null;
  const target = Number.isFinite(position.takeProfit) ? Number(position.takeProfit) : null;
  const priced = mark != null && Number.isFinite(mark);
  return {
    side: position.side,
    quantity: position.quantity,
    entry: position.averagePrice,
    mark: priced ? Number(mark) : null,
    openPnl: priced ? projectedBacktestPnl(position.instrument, position.side, position.quantity, position.averagePrice, Number(mark)) : null,
    stop,
    target,
    protection: stop != null && target != null ? 'SL i TP' : stop != null ? 'jen SL' : target != null ? 'jen TP' : 'bez SL a TP',
  };
}

/** Co už karty obchodů ukázaly — první načtení session se jen zapamatuje. */
export interface BacktestToastSeen {
  orders: Set<string>;
  fills: Set<string>;
  trades: Set<string>;
}

export const seedBacktestToastSeen = (runtime: Pick<BacktestRuntimeState, 'orders' | 'fills' | 'closedTrades'>): BacktestToastSeen => ({
  orders: new Set(runtime.orders.map(order => order.id)),
  fills: new Set(runtime.fills.map(fill => fill.id)),
  trades: new Set(runtime.closedTrades.map(trade => trade.id)),
});

const price = (value: number | undefined) => (value == null || !Number.isFinite(value) ? '—' : value.toFixed(2));
const typeKey = (order: BacktestOrder) => (order.type === 'limit' ? 'LMT' : order.type === 'stop' ? 'STP' : 'MKT');

const orderToast = (order: BacktestOrder): TradeToast => {
  const levels = [order.stopLoss != null ? `SL ${price(order.stopLoss)}` : null, order.takeProfit != null ? `TP ${price(order.takeProfit)}` : null].filter(Boolean).join(' · ');
  const action = `${order.side === 'buy' ? 'BUY' : 'SELL'} ${order.quantity} ${typeKey(order)} @ ${price(order.limitPrice ?? order.stopPrice)}`;
  return { id: `order:${order.id}`, at: order.createdAt * 1_000, tone: 'blue', badge: 'Zadáno', title: 'Příkaz zadán', line: levels ? `${action} · ${levels}` : action, pnl: null, accounts: 0, sticky: false };
};

const fillToast = (fill: BacktestFill): TradeToast => {
  const flip = fill.closedPositionId != null;
  return {
    id: `fill:${fill.id}`, at: fill.filledAt * 1_000, tone: flip ? 'amber' : 'violet',
    badge: flip ? 'Otočeno' : 'Vyplněno', title: flip ? 'Pozice otočena' : 'Vstup vyplněn',
    line: `${fill.side === 'buy' ? 'LONG' : 'SHORT'} ${fill.quantity} ${fill.instrument} @ ${price(fill.price)}`,
    pnl: null, accounts: 0, sticky: false,
  };
};

const tradeToast = (trade: BacktestClosedTrade, tickValue: number, tickSize: number): TradeToast => {
  const base = {
    id: `trade:${trade.id}`, at: trade.exitTime * 1_000, accounts: 0, sticky: false, pnl: trade.pnl,
    line: `${trade.direction === 'Long' ? 'LONG' : 'SHORT'} ${trade.quantity} ${trade.instrument} · ${price(trade.entryPrice)} → ${price(trade.exitPrice)}`,
  };
  switch (trade.reason) {
    case 'take-profit': return { ...base, tone: 'green', badge: 'TP', title: 'TP zasažen' };
    case 'stop-loss':
      // SL na vstupu skončí kolem nuly (poplatky, skluz) — to je BE, ne prohra.
      return (trade.stopLoss != null ? Math.abs(trade.stopLoss - trade.entryPrice) < tickSize : Math.abs(trade.grossPnl) < tickValue)
        ? { ...base, tone: 'amber', badge: 'BE', title: 'SL na BE zasažen' }
        : trade.grossPnl > 0
          ? { ...base, tone: 'teal', badge: 'SL', title: 'SL v zisku zasažen' }
          : { ...base, tone: 'red', badge: 'SL', title: 'SL zasažen' };
    case 'session-close': return { ...base, tone: 'amber', badge: 'Konec', title: 'Zavřeno koncem session' };
    default: return { ...base, tone: 'muted', badge: 'Výstup', title: 'Pozice zavřena' };
  }
};

/**
 * Nové události enginu od posledního zobrazení → karty obchodů (stejné jako
 * LIVE, bez teček kopií). Čas karty je čas replaye. `seen` se doplní.
 */
export function backtestRuntimeToasts(
  runtime: Pick<BacktestRuntimeState, 'orders' | 'fills' | 'closedTrades'>,
  seen: BacktestToastSeen,
): TradeToast[] {
  const toasts: TradeToast[] = [];
  for (const order of runtime.orders) {
    if (seen.orders.has(order.id)) continue;
    seen.orders.add(order.id);
    // Market se vyplní hned — kartu dá jeho plnění.
    if (order.type !== 'market' && order.status === 'pending') toasts.push(orderToast(order));
  }
  for (const fill of runtime.fills) {
    if (seen.fills.has(fill.id)) continue;
    seen.fills.add(fill.id);
    // Čistý výstup ukáže uzavřený obchod (s P&L); vstup a otočení plnění.
    if (fill.positionId != null) toasts.push(fillToast(fill));
  }
  for (const trade of runtime.closedTrades) {
    if (seen.trades.has(trade.id)) continue;
    seen.trades.add(trade.id);
    const tickSize = backtestTickSize(trade.instrument);
    toasts.push(tradeToast(trade, tickSize * backtestPointValue(trade.instrument) * trade.quantity, tickSize));
  }
  return toasts;
}
