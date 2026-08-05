import type { ChartReplayState } from './chartReplay';
import type { WorkspaceSnapshot } from './chartWorkspaceHistory';
import type { ChartWorkspaceSyncSettings } from './chartWorkspaceSync';
import type { ChartWorkspaceLayoutId } from './chartWorkspaceLayouts';

export type BacktestRunStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';
export type BacktestInstrument = 'MNQ' | 'NQ';
export type BacktestOrderSide = 'buy' | 'sell';
export type BacktestOrderType = 'market' | 'limit' | 'stop';
export type BacktestOrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected';

export interface BacktestRunConfig {
  instruments: BacktestInstrument[];
  executionInstrument: BacktestInstrument;
  timezone: string;
  commissionPerSide: Record<BacktestInstrument, number>;
  slippageTicks: Record<BacktestInstrument, number>;
  strategy?: string;
  defaultQuantity: number;
  defaultStopPoints?: number;
  defaultTargetPoints?: number;
  contractPolicy: 'continuous';
}

export interface BacktestWorkspaceState {
  layout?: unknown;
  panels?: WorkspaceSnapshot;
  layoutId?: ChartWorkspaceLayoutId;
  activePanelId?: string;
  syncSettings?: Partial<ChartWorkspaceSyncSettings>;
}

export interface BacktestOrder {
  id: string;
  runId: string;
  instrument: BacktestInstrument;
  side: BacktestOrderSide;
  type: BacktestOrderType;
  status: BacktestOrderStatus;
  quantity: number;
  remainingQuantity: number;
  limitPrice?: number;
  stopPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  reduceOnly?: boolean;
  createdAt: number;
  updatedAt: number;
  filledAt?: number;
  cancelledAt?: number;
}

export interface BacktestFill {
  id: string;
  runId: string;
  orderId?: string;
  instrument: BacktestInstrument;
  side: BacktestOrderSide;
  quantity: number;
  price: number;
  commission: number;
  realizedPnl: number;
  filledAt: number;
  reason: 'entry' | 'manual' | 'stop-loss' | 'take-profit' | 'order';
}

export interface BacktestPosition {
  instrument: BacktestInstrument;
  side: 'long' | 'short';
  quantity: number;
  averagePrice: number;
  stopLoss?: number;
  takeProfit?: number;
  openedAt: number;
  entryFillIds: string[];
  entryCommission: number;
}

export interface BacktestClosedTrade {
  id: string;
  runId: string;
  instrument: BacktestInstrument;
  direction: 'Long' | 'Short';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  grossPnl: number;
  commission: number;
  pnl: number;
  reason: BacktestFill['reason'];
}

export interface BacktestRuntimeState {
  balance: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  commissions: number;
  orders: BacktestOrder[];
  fills: BacktestFill[];
  positions: BacktestPosition[];
  closedTrades: BacktestClosedTrade[];
  replay: ChartReplayState;
}

export interface BacktestRun {
  id: string;
  accountId: string;
  name: string;
  status: BacktestRunStatus;
  initialCapital: number;
  baseCurrency: string;
  startAt: number;
  endAt: number;
  executionSymbol: BacktestInstrument;
  replayInterval: '1m';
  cursorAt: number | null;
  config: BacktestRunConfig;
  workspaceState: BacktestWorkspaceState;
  runtimeState: BacktestRuntimeState;
  revision: number;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestRunConfig = {
  instruments: ['MNQ', 'NQ'],
  executionInstrument: 'MNQ',
  timezone: 'Europe/Prague',
  commissionPerSide: { MNQ: 0.37, NQ: 1.4 },
  slippageTicks: { MNQ: 0, NQ: 0 },
  defaultQuantity: 1,
  contractPolicy: 'continuous',
};
