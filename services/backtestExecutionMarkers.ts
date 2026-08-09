import type { BacktestFill } from './backtestTypes';

export interface BacktestExecutionMarker {
  id: string;
  time: number;
  price: number;
  instrument: BacktestFill['instrument'];
  side: BacktestFill['side'];
  quantity: number;
  pointsUp: boolean;
  color: string;
}

const fillColor = (fill: BacktestFill) => {
  if (fill.realizedPnl > 0) return '#059669';
  if (fill.realizedPnl < 0) return '#ef4444';
  return '#2563eb';
};

/** Every actual fill gets a marker immediately; buy points up, sell points down. */
export const backtestExecutionMarkers = (
  fills: BacktestFill[],
): BacktestExecutionMarker[] => fills.map(fill => ({
  id: fill.id,
  time: fill.filledAt,
  price: fill.price,
  instrument: fill.instrument,
  side: fill.side,
  quantity: fill.quantity,
  pointsUp: fill.side === 'buy',
  color: fillColor(fill),
}));
