import type { Trade } from '../types';
import type { MarketCandle } from './marketDataCalculations';
import type { BacktestClosedTrade, BacktestInstrument, BacktestOrderEvent } from './backtestTypes';
import type { BacktestTradeMappingOptions } from './backtestIntel';
import type { BacktestAnalyticsRefreshInput, BacktestAnalyticsRefreshCandidate } from './backtestAnalyticsRefresh';

export interface BacktestWorkerSources {
  candlesByInstrument: Partial<Record<BacktestInstrument, readonly MarketCandle[]>>;
  htfCandlesByInstrument?: Partial<Record<BacktestInstrument, readonly MarketCandle[]>>;
}
export type BacktestWorkerPlanInput = Omit<BacktestAnalyticsRefreshInput, 'candlesByInstrument' | 'htfCandlesByInstrument'>;
export type BacktestWorkerMappingOptions = Omit<BacktestTradeMappingOptions,
  'candles' | 'htfCandles' | 'contextSource' | 'replayHorizonTime' | 'sessionPreNotes' | 'sessionPostNotes'> & { replayHorizonTime: number };
type SourcesPatch = Partial<Record<BacktestInstrument, readonly MarketCandle[] | null>>;
export type BacktestAnalyticsWorkerRequest =
  | { type: 'sources'; scopeKey: string; sourceVersion: number; candles: SourcesPatch; htfCandles: SourcesPatch }
  | { type: 'ledger'; scopeKey: string; orderEvents?: readonly BacktestOrderEvent[]; closedTrades?: readonly BacktestClosedTrade[] }
  | { type: 'plan'; scopeKey: string; id: number; sourceVersion: number;
      input: Omit<BacktestWorkerPlanInput, 'closedTrades' | 'mappingOptions'> & { mappingOptions: Omit<BacktestWorkerPlanInput['mappingOptions'], 'orderEvents'> } }
  | { type: 'map'; scopeKey: string; id: number; sourceVersion: number; closed: BacktestClosedTrade; options: Omit<BacktestWorkerMappingOptions, 'orderEvents'> };
export type BacktestAnalyticsWorkerResponse = { scopeKey: string; id: number; sourceVersion: number } & (
  | { type: 'planned'; candidates: BacktestAnalyticsRefreshCandidate[] }
  | { type: 'mapped'; trade: Trade }
  | { type: 'error'; error: string }
);
