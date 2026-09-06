import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase', () => ({ supabase: {} }));
import { buildBacktestStoreEvidence } from '../services/backtestStoreEvidence';
import { createBacktestCandleStore } from '../services/backtestCandleStore';
import { DEFAULT_BACKTEST_CONFIG } from '../services/backtestTypes';
import { MarketDataError, type MarketCandleResponse, type loadMarketCandles } from '../services/marketData';
const start = Date.UTC(2026, 7, 3, 14);
const run = { id: 'evidence-run', startAt: start, endAt: start + 6 * 60_000, cursorAt: start, config: { ...DEFAULT_BACKTEST_CONFIG, instruments: ['MNQ' as const] } };
const candle = (index: number) => ({ time: start / 1000 + index * 60, open: 100, high: 101, low: 99, close: 100, volume: 5 });
const loader = async (params: Parameters<typeof loadMarketCandles>[0]): Promise<MarketCandleResponse> => ({ provider:'databento',dataset:'GLBX.MDP3',schema:'ohlcv-1m',symbol:params.symbol,sourceSymbol:'MNQU6',start:params.start.toISOString(),end:params.end.toISOString(),candles:[0,1,2,3,4,5].map(candle) });
describe('revealed store evidence', () => {
  it('clips prices and fetch ranges to revealed candle-open; later prefetch does not affect identity', async () => {
    const store = createBacktestCandleStore(run, loader); await store.loadInitial();
    const snapshot = store.getSnapshot();
    const first = await buildBacktestStoreEvidence({ snapshot, run, replayHorizonTime: start / 1000 + 60 });
    expect(first.manifests[0].manifest.coverage).toMatchObject({ observedGridSlots: 2, fetchedGridSlots: 2 });
    expect(first.manifests[0].provenance[0].range.endMs).toBe(start + 120_000);
    expect(first.manifests[0].sourceSymbols).toEqual(['MNQU6']);
    const altered = { ...snapshot, candles: { MNQ: [...snapshot.candles.MNQ!.slice(0,2), { ...candle(5), close: 9999 }] } };
    expect(await buildBacktestStoreEvidence({ snapshot: altered, run, replayHorizonTime: start / 1000 + 60 })).toEqual(first);
  });
  it('does not invent a response contract or calendar closure for no-data', async () => {
    const store = createBacktestCandleStore(run, async () => { throw new MarketDataError('empty', 'no-data'); }); await store.loadInitial();
    const evidence = await buildBacktestStoreEvidence({ snapshot: store.getSnapshot(), run, replayHorizonTime: start / 1000 });
    expect(evidence.manifests[0].manifest.source.basis).toBe('configured-loader');
    expect(evidence.manifests[0].sourceSymbols).toEqual([]);
    expect(evidence.manifests[0].manifest.coverage.gaps[0].kind).toBe('unknown-schedule');
  });
  it('retains detached immutable metadata and emits no market manifest before replay', async () => {
    const response = await loader({symbol:'MNQ.v.0',start:new Date(start),end:new Date(run.endAt)});
    const store = createBacktestCandleStore(run, async () => response); await store.loadInitial();
    response.sourceSymbol = 'later mutation';
    expect(store.getSnapshot().provenance[0].response?.sourceSymbol).toBe('MNQU6');
    expect(Object.isFrozen(store.getSnapshot().provenance[0].response)).toBe(true);
    expect((await buildBacktestStoreEvidence({ snapshot: store.getSnapshot(), run, replayHorizonTime: null })).manifests).toEqual([]);
  });
});
