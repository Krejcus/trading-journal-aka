import type { PositionDrawing } from './chartPositionDrawing';
import { calculatePositionMetrics, normalizePositionSettings } from './chartPositionDrawing';
import type { MarketCandle } from './marketData';
import type { BacktestOrderSide, BacktestOrderType } from './backtestTypes';

export interface BacktestQuickOrderDraft {
  side: BacktestOrderSide;
  type: BacktestOrderType;
  quantity: number;
  price?: number;
  stopLoss: number;
  takeProfit: number;
}

/**
 * Typ příkazu podle toho, na které straně trhu cena leží — stejné pravidlo,
 * jaké nabízí kontextové menu TradingView i FX Replay. Nákup pod trhem je
 * limit, nad trhem stop; u prodeje obráceně.
 */
const inferOrderType = (
  side: BacktestOrderSide,
  entryPrice: number,
  marketPrice: number,
  tickSize: number,
): BacktestOrderType => {
  if (Math.abs(entryPrice - marketPrice) < tickSize / 2) return 'market';
  if (side === 'buy') return entryPrice < marketPrice ? 'limit' : 'stop';
  return entryPrice > marketPrice ? 'limit' : 'stop';
};

/**
 * Desetinná místa samotného ticku, ne jeho řádu: 0,25 potřebuje dvě místa,
 * i když log10 vychází na jedno.
 */
const tickDecimals = (tickSize: number): number => {
  const text = String(tickSize);
  if (text.includes('e') || text.includes('E')) return 8;
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
};

export interface ChartClickOrderOption {
  side: BacktestOrderSide;
  type: BacktestOrderType;
  /** U market příkazu chybí — plní se až aktuální cenou při odeslání. */
  price?: number;
  quantity: number;
  label: string;
}

/**
 * Dvojice příkazů, kterou nabídne pravý klik do grafu na dané cenové úrovni.
 *
 * Množství se nepočítá z rizika jako u position boxu — bere se rovnou z pole
 * vedle typu příkazu v obchodním panelu, aby klik dělal přesně to, co je vidět.
 */
export const chartClickOrderOptions = (params: {
  price: number;
  marketPrice: number;
  quantity: number;
  tickSize: number;
  symbol: string;
  /** Počet desetinných míst v popisku; odvozeno od tick size instrumentu. */
  pricePrecision?: number;
}): ChartClickOrderOption[] => {
  const { price, marketPrice, quantity, tickSize, symbol } = params;
  if (![price, marketPrice, quantity, tickSize].every(value => Number.isFinite(value))) return [];
  if (quantity < 1 || tickSize <= 0) return [];

  // Zarovnání na tick: klik je pixel, ne cena. Bez toho by objednávka mířila
  // na úroveň, kterou instrument neumí zobchodovat.
  const aligned = Math.round(price / tickSize) * tickSize;
  const precision = params.pricePrecision ?? tickDecimals(tickSize);
  const text = aligned.toFixed(precision);

  return (['buy', 'sell'] as BacktestOrderSide[]).map(side => {
    const type = inferOrderType(side, aligned, marketPrice, tickSize);
    return {
      side,
      type,
      price: type === 'market' ? undefined : aligned,
      quantity,
      label: `${side === 'buy' ? 'Koupit' : 'Prodat'} ${quantity} ${symbol} @ ${text} ${type}`,
    };
  });
};

export const createBacktestQuickOrderDraft = (
  drawing: PositionDrawing,
  candle: MarketCandle,
): BacktestQuickOrderDraft => {
  const metrics = calculatePositionMetrics(drawing);
  if (!metrics) throw new Error('Position box nemá kompletní Entry, TP a SL.');

  const settings = normalizePositionSettings(drawing.style.position);
  const side: BacktestOrderSide = drawing.tool === 'LongPosition' ? 'buy' : 'sell';
  const validGeometry = side === 'buy'
    ? metrics.target > metrics.entry && metrics.stop < metrics.entry
    : metrics.target < metrics.entry && metrics.stop > metrics.entry;
  if (!validGeometry) {
    throw new Error(side === 'buy'
      ? 'Long box musí mít TP nad Entry a SL pod Entry.'
      : 'Short box musí mít TP pod Entry a SL nad Entry.');
  }

  // Futures contracts are indivisible. Rounding down never exceeds the risk
  // encoded by the position tool; a sub-contract position is rejected rather
  // than silently increasing risk to one contract.
  const quantity = Math.floor(metrics.quantity + Number.EPSILON);
  if (quantity < 1) throw new Error('Nastavený risk nestačí ani na 1 kontrakt.');

  const type = inferOrderType(side, metrics.entry, candle.close, settings.tickSize);
  return {
    side,
    type,
    quantity,
    price: type === 'market' ? undefined : metrics.entry,
    stopLoss: metrics.stop,
    takeProfit: metrics.target,
  };
};

export const backtestQuickOrderLabel = (order: BacktestQuickOrderDraft) => (
  `${order.side === 'buy' ? 'BUY' : 'SELL'} ${order.type.toUpperCase()} · ${order.quantity}×`
);
