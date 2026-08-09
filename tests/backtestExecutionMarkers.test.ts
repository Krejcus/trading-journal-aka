import { describe, expect, it } from 'vitest';
import { backtestExecutionMarkers } from '../services/backtestExecutionMarkers';
import type { BacktestFill } from '../services/backtestTypes';

const fill = (overrides: Partial<BacktestFill>): BacktestFill => ({
  id: 'fill',
  runId: 'run',
  instrument: 'MNQ',
  side: 'buy',
  quantity: 1,
  price: 100,
  commission: 0.74,
  realizedPnl: 0,
  filledAt: 60,
  reason: 'entry',
  ...overrides,
});

describe('backtest execution markers', () => {
  it('creates an immediate blue marker for an entry fill', () => {
    expect(backtestExecutionMarkers([fill({})])).toEqual([{
      id: 'fill', time: 60, price: 100, instrument: 'MNQ', side: 'buy', quantity: 1,
      pointsUp: true, color: '#2563eb',
    }]);
  });

  it('points buy fills up and sell fills down', () => {
    const markers = backtestExecutionMarkers([
      fill({ id: 'buy', side: 'buy' }),
      fill({ id: 'sell', side: 'sell' }),
    ]);

    expect(markers.map(marker => marker.pointsUp)).toEqual([true, false]);
  });

  it('colors exit fills immediately by realized result', () => {
    const markers = backtestExecutionMarkers([
      fill({ id: 'profit', side: 'sell', realizedPnl: 20, reason: 'take-profit' }),
      fill({ id: 'loss', side: 'sell', realizedPnl: -10, reason: 'stop-loss' }),
    ]);

    expect(markers.map(marker => marker.color)).toEqual(['#059669', '#ef4444']);
  });
});
