import type {
  BacktestInstrument,
  BacktestOrder,
  BacktestPosition,
} from './backtestTypes';
import { backtestPointValue } from './backtestEngine';

export type BacktestChartOrderLineKind = 'entry' | 'stopLoss' | 'takeProfit';

export interface BacktestChartOrderLine {
  id: string;
  ownerId: string;
  ownerType: 'order' | 'position';
  kind: BacktestChartOrderLineKind;
  price: number;
  color: string;
  label: string;
  draggable: boolean;
  cancellable?: boolean;
  cancelAction?: 'cancel-order' | 'close-position' | 'remove-bracket';
  filledLabel?: boolean;
  addableBrackets?: Array<Exclude<BacktestChartOrderLineKind, 'entry'>>;
  /** Popisek pro cenu během tažení (P&L a velikost se počítají hned, ne až po puštění). */
  labelAt?: (price: number) => string;
  /** Na vstupní čáře: popisek nového SL/TP taženého z tlačítka „SL“ / „TP“. */
  bracketLabelAt?: (kind: Exclude<BacktestChartOrderLineKind, 'entry'>, price: number) => string;
}

const money = (value: number) => `${value >= 0 ? '+' : '−'}$${Math.abs(value).toFixed(2)}`;
const price = (value: number) => value.toFixed(2);
const points = (from: number, to: number) => `${Math.abs(to - from).toFixed(2)} b`;
/** „SL  −$45.00 · 22.50 b“ — P&L i vzdálenost od vstupu. */
export const bracketLineLabel = (
  kind: 'stopLoss' | 'takeProfit',
  instrument: BacktestInstrument,
  side: 'buy' | 'sell' | 'long' | 'short',
  quantity: number,
  entryPrice: number,
  value: number,
) => `${kind === 'stopLoss' ? 'SL' : 'TP'}  ${money(projectedBacktestPnl(instrument, side, quantity, entryPrice, value))} · ${points(entryPrice, value)}`;
const PENDING_COLOR = '#2563eb';
const PROFIT_COLOR = '#059669';
const LOSS_COLOR = '#ef4444';

const positionEntryColor = (livePnl?: number) => {
  if (livePnl === undefined || livePnl === 0) return PENDING_COLOR;
  return livePnl > 0 ? PROFIT_COLOR : LOSS_COLOR;
};

export const projectedBacktestPnl = (
  instrument: BacktestInstrument,
  side: 'buy' | 'sell' | 'long' | 'short',
  quantity: number,
  entryPrice: number,
  exitPrice: number,
) => {
  const long = side === 'buy' || side === 'long';
  const points = long ? exitPrice - entryPrice : entryPrice - exitPrice;
  return points * backtestPointValue(instrument) * quantity;
};

export const pendingOrderChartLines = (order: BacktestOrder): BacktestChartOrderLine[] => {
  if (order.status !== 'pending' || order.type === 'market') return [];
  const entry = order.type === 'limit' ? order.limitPrice : order.stopPrice;
  if (!Number.isFinite(entry)) return [];
  const entryPrice = Number(entry);
  const prefix = `${order.side.toUpperCase()} ${order.quantity} ${order.type.toUpperCase()}`;
  // Objednávka nemusí brackety dostat při zadání — z pravého kliku do grafu
  // vzniká holá. Nabídni je proto stejně jako u otevřené pozice, ať jde SL/TP
  // doplnit a natáhnout přímo v grafu.
  const addableBrackets = ([
    !Number.isFinite(order.stopLoss) ? 'stopLoss' : null,
    !Number.isFinite(order.takeProfit) ? 'takeProfit' : null,
  ].filter(Boolean) as Array<'stopLoss' | 'takeProfit'>);
  const lines: BacktestChartOrderLine[] = [{
    id: `${order.id}:entry`, ownerId: order.id, ownerType: 'order', kind: 'entry',
    price: entryPrice, color: PENDING_COLOR, label: `${prefix}  ${price(entryPrice)}`,
    draggable: true, cancellable: true, cancelAction: 'cancel-order',
    addableBrackets: addableBrackets.length > 0 ? addableBrackets : undefined,
    labelAt: next => `${prefix}  ${price(next)}`,
    bracketLabelAt: (kind, next) => bracketLineLabel(kind, order.instrument, order.side, order.quantity, entryPrice, next),
  }];
  if (Number.isFinite(order.stopLoss)) {
    const value = Number(order.stopLoss);
    lines.push({
      id: `${order.id}:stopLoss`, ownerId: order.id, ownerType: 'order', kind: 'stopLoss',
      price: value, color: '#ef4444', label: bracketLineLabel('stopLoss', order.instrument, order.side, order.quantity, entryPrice, value),
      labelAt: next => bracketLineLabel('stopLoss', order.instrument, order.side, order.quantity, entryPrice, next),
      draggable: true, cancellable: true, cancelAction: 'remove-bracket',
    });
  }
  if (Number.isFinite(order.takeProfit)) {
    const value = Number(order.takeProfit);
    lines.push({
      id: `${order.id}:takeProfit`, ownerId: order.id, ownerType: 'order', kind: 'takeProfit',
      price: value, color: '#0f9f8f', label: bracketLineLabel('takeProfit', order.instrument, order.side, order.quantity, entryPrice, value),
      labelAt: next => bracketLineLabel('takeProfit', order.instrument, order.side, order.quantity, entryPrice, next),
      draggable: true, cancellable: true, cancelAction: 'remove-bracket',
    });
  }
  return lines;
};

export const positionChartLines = (
  position: BacktestPosition,
  currentPrice?: number,
  showInlineBracketControls = true,
): BacktestChartOrderLine[] => {
  const livePnl = Number.isFinite(currentPrice)
    ? projectedBacktestPnl(position.instrument, position.side, position.quantity, position.averagePrice, Number(currentPrice))
    : undefined;
  const addableBrackets = showInlineBracketControls
    ? ([
        !Number.isFinite(position.stopLoss) ? 'stopLoss' : null,
        !Number.isFinite(position.takeProfit) ? 'takeProfit' : null,
      ].filter(Boolean) as Array<'stopLoss' | 'takeProfit'>)
    : [];
  const lines: BacktestChartOrderLine[] = [{
    id: `${position.instrument}:position:entry`, ownerId: position.instrument, ownerType: 'position', kind: 'entry',
    price: position.averagePrice, color: positionEntryColor(livePnl),
    label: `${position.side.toUpperCase()} ${position.quantity}  ${price(position.averagePrice)}${livePnl === undefined ? '' : `  P&L ${money(livePnl)}`}`,
    draggable: false, cancellable: true, cancelAction: 'close-position', filledLabel: true,
    // Inline SL/TP shortcuts belong to market entries. Limit/stop orders already
    // define their brackets before filling and keep the dedicated order lines.
    addableBrackets: addableBrackets.length > 0 ? addableBrackets : undefined,
    bracketLabelAt: (kind, next) => bracketLineLabel(kind, position.instrument, position.side, position.quantity, position.averagePrice, next),
  }];
  if (Number.isFinite(position.stopLoss)) {
    const value = Number(position.stopLoss);
    lines.push({
      id: `${position.instrument}:position:stopLoss`, ownerId: position.instrument, ownerType: 'position', kind: 'stopLoss',
      price: value, color: '#ef4444', label: bracketLineLabel('stopLoss', position.instrument, position.side, position.quantity, position.averagePrice, value),
      labelAt: next => bracketLineLabel('stopLoss', position.instrument, position.side, position.quantity, position.averagePrice, next),
      draggable: true, cancellable: true, cancelAction: 'remove-bracket',
    });
  }
  if (Number.isFinite(position.takeProfit)) {
    const value = Number(position.takeProfit);
    lines.push({
      id: `${position.instrument}:position:takeProfit`, ownerId: position.instrument, ownerType: 'position', kind: 'takeProfit',
      price: value, color: '#0f9f8f', label: bracketLineLabel('takeProfit', position.instrument, position.side, position.quantity, position.averagePrice, value),
      labelAt: next => bracketLineLabel('takeProfit', position.instrument, position.side, position.quantity, position.averagePrice, next),
      draggable: true, cancellable: true, cancelAction: 'remove-bracket',
    });
  }
  return lines;
};

/**
 * Návrh limit/stop příkazu z obchodní lišty: čára v grafu, kterou uživatel
 * posune na cenu a doplní SL/TP. Do enginu nejde nic, dokud nestiskne
 * Buy/Sell — v přehrávání ho tak nic nevyplní dřív, než je hotový.
 */
export const TICKET_DRAFT_ID = 'ticket-draft';
const DRAFT_COLOR = '#8b5cf6';
const TICK = 0.25;
const roundTick = (value: number) => Math.round(value / TICK) * TICK;

export interface BacktestTicketDraft {
  type: 'limit' | 'stop';
  price: number;
  stopLoss?: number;
  takeProfit?: number;
}

/** Strana podle polohy čáry vůči trhu: buy limit pod cenou, buy stop nad ní. */
export const ticketDraftSide = (draft: BacktestTicketDraft, marketPrice: number | undefined): 'buy' | 'sell' => {
  if (!Number.isFinite(marketPrice)) return 'buy';
  const below = draft.price <= Number(marketPrice);
  return draft.type === 'limit' ? (below ? 'buy' : 'sell') : (below ? 'sell' : 'buy');
};

/** SL/TP na správné straně vstupu (aspoň o tick), jinak by se vyplnil hned. */
const clampBracket = (kind: 'stopLoss' | 'takeProfit', side: 'buy' | 'sell', entry: number, value: number) => (side === 'buy'
  ? kind === 'stopLoss' ? Math.min(value, entry - TICK) : Math.max(value, entry + TICK)
  : kind === 'stopLoss' ? Math.max(value, entry + TICK) : Math.min(value, entry - TICK));

export const ticketDraftChartLines = (
  draft: BacktestTicketDraft,
  instrument: BacktestInstrument,
  quantity: number,
  marketPrice: number | undefined,
): BacktestChartOrderLine[] => {
  const side = ticketDraftSide(draft, marketPrice);
  const name = `${side.toUpperCase()} ${quantity} ${draft.type.toUpperCase()}`;
  const addable = ([
    draft.stopLoss === undefined ? 'stopLoss' : null,
    draft.takeProfit === undefined ? 'takeProfit' : null,
  ].filter(Boolean) as Array<'stopLoss' | 'takeProfit'>);
  const lines: BacktestChartOrderLine[] = [{
    id: `${TICKET_DRAFT_ID}:entry`, ownerId: TICKET_DRAFT_ID, ownerType: 'order', kind: 'entry',
    price: draft.price, color: DRAFT_COLOR, label: `${name}  ${price(draft.price)} · návrh`,
    draggable: true, cancellable: true, cancelAction: 'cancel-order',
    addableBrackets: addable.length ? addable : undefined,
    labelAt: next => `${ticketDraftSide({ ...draft, price: next }, marketPrice).toUpperCase()} ${quantity} ${draft.type.toUpperCase()}  ${price(next)} · návrh`,
    bracketLabelAt: (kind, next) => bracketLineLabel(kind, instrument, side, quantity, draft.price, next),
  }];
  for (const kind of ['stopLoss', 'takeProfit'] as const) {
    const value = draft[kind];
    if (value === undefined) continue;
    lines.push({
      id: `${TICKET_DRAFT_ID}:${kind}`, ownerId: TICKET_DRAFT_ID, ownerType: 'order', kind,
      price: value, color: kind === 'stopLoss' ? '#ef4444' : '#0f9f8f',
      label: bracketLineLabel(kind, instrument, side, quantity, draft.price, value),
      labelAt: next => bracketLineLabel(kind, instrument, side, quantity, draft.price, next),
      draggable: true, cancellable: true, cancelAction: 'remove-bracket',
    });
  }
  return lines;
};

/** SL/TP přidaný k návrhu: tažený na cenu, jinak zrcadlo protějšku nebo 20 bodů. */
export const ticketDraftWithBracket = (
  draft: BacktestTicketDraft,
  kind: 'stopLoss' | 'takeProfit',
  marketPrice: number | undefined,
  requested?: number,
): BacktestTicketDraft => {
  const side = ticketDraftSide(draft, marketPrice);
  const opposite = kind === 'stopLoss' ? draft.takeProfit : draft.stopLoss;
  const distance = Math.min(100, Math.max(TICK, roundTick(opposite === undefined ? 20 : Math.abs(opposite - draft.price))));
  const suggested = (side === 'buy') === (kind === 'takeProfit') ? draft.price + distance : draft.price - distance;
  const value = Number.isFinite(requested) ? roundTick(Number(requested)) : suggested;
  return { ...draft, [kind]: clampBracket(kind, side, draft.price, value) };
};

/**
 * Odeslání návrhu stranou z tlačítka. SL/TP stojí na straně odvozené z čáry —
 * když uživatel stiskne opačné tlačítko, brackety se zrcadlí kolem vstupu
 * (stejná vzdálenost), ať nejsou hned vyplněné.
 */
export const ticketDraftOrder = (draft: BacktestTicketDraft, side: 'buy' | 'sell', marketPrice: number | undefined) => {
  const drawnSide = ticketDraftSide(draft, marketPrice);
  const mirror = (value: number | undefined) => value === undefined ? undefined
    : drawnSide === side ? value : roundTick(2 * draft.price - value);
  return { side, type: draft.type, price: draft.price, stopLoss: mirror(draft.stopLoss), takeProfit: mirror(draft.takeProfit) };
};
