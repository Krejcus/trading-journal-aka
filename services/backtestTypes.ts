import type { ChartAppearanceState } from './chartAppearanceScope';
import type { ChartReplayState } from './chartReplay';
import type { WorkspaceSnapshot } from './chartWorkspaceHistory';
import type { ChartWorkspaceSyncSettings } from './chartWorkspaceSync';
import type { ChartWorkspaceLayoutId } from './chartWorkspaceLayouts';
import type { PositionDrawing } from './chartPositionDrawing';
import { DEFAULT_BACKTEST_FLAT_BY_MINUTE, DEFAULT_BACKTEST_FLAT_TIME_ZONE } from './backtestSessionClose';

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
  /** Denní prop-firm cutoff. Pozice ani čekající příkazy přes něj nepokračují. */
  flatTimeZone?: string;
  flatByMinute?: number;
}

export interface BacktestWorkspaceState {
  layout?: unknown;
  panels?: WorkspaceSnapshot;
  layoutId?: ChartWorkspaceLayoutId;
  activePanelId?: string;
  syncSettings?: Partial<ChartWorkspaceSyncSettings>;
  /** Vzhled grafu vázaný na session — nastavení grafu, indikátorů a stylů kreseb. */
  appearance?: ChartAppearanceState;
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
  reason: 'entry' | 'manual' | 'stop-loss' | 'take-profit' | 'session-close' | 'order';
}

export interface BacktestPosition {
  instrument: BacktestInstrument;
  side: 'long' | 'short';
  quantity: number;
  averagePrice: number;
  stopLoss?: number;
  takeProfit?: number;
  /**
   * Brackety platné v okamžiku vstupu. `stopLoss` se dá za běhu posouvat, takže
   * z něj po zavření nejde spočítat 1R — riziko, které obchod skutečně nesl na
   * začátku, drží až tato dvojice.
   */
  initialStopLoss?: number;
  initialTakeProfit?: number;
  /** Nejlepší a nejhorší cena, kterou pozice viděla (bez vstupní svíčky). */
  maxFavorablePrice?: number;
  maxAdversePrice?: number;
  openedAt: number;
  entryFillIds: string[];
  entryCommission: number;
}

/**
 * Immutable snapshot created when a Position drawing is converted into an
 * executable backtest order. The chart derives its moving right edge from the
 * replay cursor, while the original manual drawing can safely be removed.
 */
export interface BacktestManagedPositionPlan {
  id: string;
  orderId: string;
  instrument: BacktestInstrument;
  tool: PositionDrawing['tool'];
  startTime: number;
  /** Fixed right edge used while the attached entry order is waiting for fill. */
  initialEndTime?: number;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  style: PositionDrawing['style'];
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
  /** Bracket platný v okamžiku výstupu (po případných posunech). */
  stopLoss?: number;
  takeProfit?: number;
  /** Bracket zadaný při vstupu — základ pro 1R. */
  initialStopLoss?: number;
  initialTakeProfit?: number;
  /** 1R v dolarech = |entry − initialStopLoss| × point value × množství. */
  riskAmount?: number;
  /** Maximální pohyb ve prospěch / proti pozici v bodech (vždy ≥ 0). */
  mfePoints?: number;
  maePoints?: number;
  /** Totéž v R — jen když je známý `riskAmount`. */
  mfeR?: number;
  maeR?: number;
  /**
   * Svíčka trefila stopku i target najednou. Engine v takovém případě volí
   * stopku, ale výsledek je z minutových dat neurčitelný a analytika o tom
   * musí vědět.
   */
  outcomeAmbiguous?: boolean;
}

export type BacktestOrderEventKind =
  | 'created'
  | 'entry-moved'
  | 'stop-moved'
  | 'target-moved'
  | 'stop-cleared'
  | 'target-cleared'
  | 'cancelled'
  | 'filled'
  | 'position-stop-moved'
  | 'position-target-moved'
  | 'position-stop-cleared'
  | 'position-target-cleared';

/**
 * Jeden zápis do append-only journalu objednávek.
 *
 * Objednávka sama drží jen svůj poslední stav — `updatedAt` přepisuje předchozí
 * změnu. Journal je jediné místo, odkud se dá zpětně zjistit, kolikrát se
 * hýbalo se stopkou nebo kolik vstupů skončilo zrušením.
 *
 * Dvě časové osy záměrně: `marketTime` říká, kde stál trh, `recordedAt`, kdy
 * uživatel klikl. Rozdíl mezi nimi je jediný zdroj informace o rozvaze —
 * v replay se dá nad jednou svíčkou strávit vteřina i deset minut.
 */
export interface BacktestOrderEvent {
  id: string;
  runId: string;
  orderId: string;
  kind: BacktestOrderEventKind;
  instrument: BacktestInstrument;
  /** Čas svíčky v replay (unix sekundy). */
  marketTime: number;
  /** Reálný čas kliknutí (unix ms). Chybí u událostí generovaných enginem. */
  recordedAt?: number;
  side?: BacktestOrderSide;
  quantity?: number;
  price?: number;
  previousPrice?: number;
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
  managedPositionPlans?: BacktestManagedPositionPlan[];
  /** Optional so sessions saved before the journal existed load without it. */
  orderEvents?: BacktestOrderEvent[];
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
  flatTimeZone: DEFAULT_BACKTEST_FLAT_TIME_ZONE,
  flatByMinute: DEFAULT_BACKTEST_FLAT_BY_MINUTE,
};
