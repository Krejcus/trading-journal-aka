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
}

const money = (value: number) => `${value >= 0 ? '+' : '−'}$${Math.abs(value).toFixed(2)}`;
const price = (value: number) => value.toFixed(2);
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
  }];
  if (Number.isFinite(order.stopLoss)) {
    const value = Number(order.stopLoss);
    lines.push({
      id: `${order.id}:stopLoss`, ownerId: order.id, ownerType: 'order', kind: 'stopLoss',
      price: value, color: '#ef4444', label: `SL  ${money(projectedBacktestPnl(order.instrument, order.side, order.quantity, entryPrice, value))}`,
      draggable: true, cancellable: true, cancelAction: 'remove-bracket',
    });
  }
  if (Number.isFinite(order.takeProfit)) {
    const value = Number(order.takeProfit);
    lines.push({
      id: `${order.id}:takeProfit`, ownerId: order.id, ownerType: 'order', kind: 'takeProfit',
      price: value, color: '#0f9f8f', label: `TP  ${money(projectedBacktestPnl(order.instrument, order.side, order.quantity, entryPrice, value))}`,
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
  }];
  if (Number.isFinite(position.stopLoss)) {
    const value = Number(position.stopLoss);
    lines.push({
      id: `${position.instrument}:position:stopLoss`, ownerId: position.instrument, ownerType: 'position', kind: 'stopLoss',
      price: value, color: '#ef4444', label: `SL  ${money(projectedBacktestPnl(position.instrument, position.side, position.quantity, position.averagePrice, value))}`,
      draggable: true, cancellable: true, cancelAction: 'remove-bracket',
    });
  }
  if (Number.isFinite(position.takeProfit)) {
    const value = Number(position.takeProfit);
    lines.push({
      id: `${position.instrument}:position:takeProfit`, ownerId: position.instrument, ownerType: 'position', kind: 'takeProfit',
      price: value, color: '#0f9f8f', label: `TP  ${money(projectedBacktestPnl(position.instrument, position.side, position.quantity, position.averagePrice, value))}`,
      draggable: true, cancellable: true, cancelAction: 'remove-bracket',
    });
  }
  return lines;
};
