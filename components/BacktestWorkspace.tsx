import BacktestResearchPanel from './BacktestResearchPanel';
import { appendBacktestResearch, captureBacktestResearchContext, reviseBacktestResearch, type BacktestResearchDraft } from '../services/backtestResearchJournal';
import BacktestEvidenceDialog from './BacktestEvidenceDialog';
import { buildBacktestStoreEvidence } from '../services/backtestStoreEvidence';
import { backtestResearchRecordedAt } from '../services/backtestResearchClock';
import { planBacktestAnalyticsRefresh, type BacktestAnalyticsRefreshCandidate } from '../services/backtestAnalyticsRefresh';
import { buildBacktestTradeRecalculationUpdates } from '../services/backtestTradeRecalculation';
import type { BacktestTagSuggestions } from '../services/backtestTagCatalog';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import type { Trade } from '../types';
import AlphaTradeChartWorkspace, { type BacktestChartSessionBridge, type MarketRoot } from './AlphaTradeChartWorkspace';
import {
  type MarketCandle,
  type MarketDataSchema,
} from '../services/marketData';
import {
  cancelBacktestOrder,
  clearPendingBacktestOrderBracket,
  createBacktestOrder,
  enqueueBacktestOrder,
  executeBacktestMarketOrder,
  processBacktestCandles,
  updatePendingBacktestOrder,
  updatePositionBracket,
} from '../services/backtestEngine';
import { createBacktestCandleStore } from '../services/backtestCandleStore';
import { backtestClosedTradeToTrade } from '../services/backtestIntel';
import {
  createBacktestLedgerCursor,
  getBacktestCloudRevision,
  BacktestRunConflictError,
  BacktestRunSyncError,
  withBacktestCloudRevision,
  loadBacktestRunFromCloud,
  saveBacktestRunLocal,
  syncBacktestRunToCloud,
} from '../services/backtestRunService';
import type {
  BacktestOrderType,
  BacktestRun,
  BacktestRuntimeState,
  BacktestWorkspaceState,
} from '../services/backtestTypes';
import {
  createChartAppearanceSession,
  inheritGlobalAppearance,
} from '../services/chartAppearanceScope';
import type { ChartReplayState } from '../services/chartReplay';
import { backtestQuickOrderLabel, createBacktestQuickOrderDraft } from '../services/backtestQuickOrder';
import { createManagedPositionPlan, managedPositionBoxes } from '../services/backtestManagedPosition';
import type { PositionDrawing } from '../services/chartPositionDrawing';
import {
  pendingOrderChartLines,
  positionChartLines,
  type BacktestChartOrderLine,
  type BacktestChartOrderLineKind,
} from '../services/backtestOrderLines';

// Keep the replay timeline progressive. Loading two weeks of 1m MNQ + NQ in
// both workspace panels at once can exhaust Chromium's renderer before the
// chart has a chance to apply its bounded render window. Three days still
// leaves ample playback headroom; the existing prefetch extends it before the
// cursor reaches the edge.
const SEGMENT_MS = 3 * 24 * 60 * 60 * 1_000;
const PREFETCH_MS = 24 * 60 * 60 * 1_000;
/**
 * Prefetch se spustí, jakmile kurzoru zbývá méně než tolik načtených barů.
 * Čtyři hodiny 1m barů = ~24 s předstihu při nejvyšší rychlosti přehrávání.
 */
const PREFETCH_MIN_BARS = 240;
/** Jak často jde plný stav do Supabase; lokální checkpoint běží každých 1,5 s. */
const CLOUD_SYNC_INTERVAL_MS = 60_000;
/** Nejdelší doba, po kterou smí React při přehrávání ukazovat starší equity. */
const RUNTIME_RENDER_INTERVAL_MS = 500;
/** Trailing doběh po tiché sérii kroků — poslední stav vždy dorazí. */
const RUNTIME_RENDER_TRAILING_MS = 180;
type HistoricalCandlesByRoot = Partial<Record<MarketRoot, Partial<Record<MarketDataSchema, MarketCandle[]>>>>;

/** První index svíčky s časem > `time` (pole je seřazené podle času). */
const candleIndexAfter = (candles: MarketCandle[], time: number): number => {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (candles[mid].time <= time) low = mid + 1;
    else high = mid;
  }
  return low;
};


interface Props {
  run: BacktestRun;
  isDark: boolean;
  onClose: (run: BacktestRun) => void;
  onTradeClosed?: (trade: Trade) => Promise<void>;
  onTradeAnalyticsRefresh?: (candidates: BacktestAnalyticsRefreshCandidate[]) => Promise<void>;
  analyticsSyncState?: { pending: number; error?: string | null };
  journalSyncState?: { pending: number; error?: string | null };
  journalTrades?: Trade[];
  tagSuggestions?: BacktestTagSuggestions;
  onTradeReviewSave?: (tradeId: string, updates: Partial<Trade>, snapshotDataUrl?: string, expected?: Partial<Trade>) => Promise<void>;
}

const BacktestWorkspaceSession: React.FC<Props & { onReloadRun: (run: BacktestRun) => void }> = ({
  run: initialRun,
  isDark,
  onClose,
  onTradeClosed,
  onReloadRun,
  onTradeAnalyticsRefresh,
  analyticsSyncState,
  journalSyncState,
  journalTrades = [],
  tagSuggestions,
  onTradeReviewSave,
}) => {
  const [appearanceSession] = useState(() => createChartAppearanceSession(
    `backtest:${initialRun.id}`, initialRun.workspaceState?.appearance, inheritGlobalAppearance,
  ));
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const researchCaptureRef = useRef<(() => Promise<string>) | null>(null);
  const registerResearchCapture = useCallback((capture: () => Promise<string>) => {
    researchCaptureRef.current = capture;
    return () => { if (researchCaptureRef.current === capture) researchCaptureRef.current = null; };
  }, []);
  const [appearanceReady, setAppearanceReady] = useState(false);
  useLayoutEffect(() => {
    appearanceSession.activate();
    setAppearanceReady(true);
    return appearanceSession.deactivate;
  }, [appearanceSession]);

  const [run, setRun] = useState(initialRun);
  const runRef = useRef(initialRun);
  const [candleStore] = useState(() => createBacktestCandleStore(initialRun));
  const candleRequestsRef = useRef(0);
  const marketLoadFailedRef = useRef(false);
  const [candlesByRoot, setCandlesByRoot] = useState<Partial<Record<MarketRoot, MarketCandle[]>>>({});
  const [historyCandlesByRoot, setHistoryCandlesByRoot] = useState<HistoricalCandlesByRoot>({});
  const [historyLoadingKeys, setHistoryLoadingKeys] = useState<Partial<Record<string, boolean>>>({});
  const historyLoadingRef = useRef(new Set<string>());
  const loadedUntilRef = useRef(initialRun.startAt);
  const [loading, setLoading] = useState(true);
  /** Dotahování dalších dat za běhu — pill místo tichého ztuhnutí na hraně. */
  const [loadingAhead, setLoadingAhead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const mutationGenerationRef = useRef(0);
  const workspaceCheckpointRef = useRef<(() => void) | null>(null);
  const registerWorkspaceCheckpoint = useCallback((checkpoint: () => void) => {
    workspaceCheckpointRef.current = checkpoint;
    return () => {
      if (workspaceCheckpointRef.current === checkpoint) workspaceCheckpointRef.current = null;
    };
  }, []);
  const cloudDirtyRef = useRef(initialRun.revision !== getBacktestCloudRevision(initialRun));
  const [localSaveError, setLocalSaveError] = useState<string | null>(null);
  const [cloudSaveError, setCloudSaveError] = useState<string | null>(null);
  const [analyticsQueueError, setAnalyticsQueueError] = useState<string | null>(null);
  const [analyticsPreview, setAnalyticsPreview] = useState<Record<string, BacktestAnalyticsRefreshCandidate>>({});
  const [journalQueueError, setJournalQueueError] = useState<string | null>(null);
  const [cloudConflict, setCloudConflict] = useState(false);
  const conflictRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const restoringRef = useRef(false);
  const lastCloudAttemptRef = useRef(0);
  const persistedRevisionRef = useRef(initialRun.revision);
  /** Revize, kterou má cloudový řádek — lokální mezitím běží napřed. */
  const cloudRevisionRef = useRef(getBacktestCloudRevision(initialRun));
  const lastCloudSyncRef = useRef(cloudDirtyRef.current ? 0 : Date.now());
  const ledgerCursorRef = useRef(createBacktestLedgerCursor());
  const saveChainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const emittedTradesRef = useRef(new Set<string>());
  const emittingTradesRef = useRef(new Map<string, Promise<void>>());
  const lastProcessedCursorRef = useRef<number | null>(initialRun.runtimeState.replay.cursorTime);
  const lastRuntimeRenderRef = useRef(0);
  const trailingRenderRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (trailingRenderRef.current !== null) window.clearTimeout(trailingRenderRef.current);
  }, []);

  /**
   * `render: false` aktualizuje jen ref a dirty flagy — checkpoint i engine
   * vidí čerstvý stav, ale React se nepřekresluje. Přehrávání tak neplatí
   * jeden re-render celého workspace za každý tik kurzoru; do stavu se stav
   * propíše při událostech enginu, pauze, nebo nejpozději po půl sekundě.
   */
  const updateRun = useCallback((
    updater: (current: BacktestRun) => BacktestRun,
    options?: { render?: boolean },
  ) => {
    if (restoringRef.current) return;
    const next = updater(runRef.current);
    runRef.current = next;
    mutationGenerationRef.current += 1;
    dirtyRef.current = true;
    cloudDirtyRef.current = true;
    if (options?.render !== false) {
      lastRuntimeRenderRef.current = performance.now();
      setRun(next);
    }
  }, []);

  /**
   * Checkpoint má dvě kadence. Lokální (IndexedDB) běží každých 1,5 s a nic
   * nestojí — to je crash-recovery. Cloud dostává celý ~400KB stav, takže jede
   * jen jednou za minutu a při pauze/zavření/schování záložky; ledger se navíc
   * posílá přírůstkově přes kurzor. Dřív šel celý stav + všechny orders a fills
   * do Supabase každých 1,5 s — ~1 GB uploadu za hodinu přehrávání.
   */
  const flush = useCallback((options?: { cloud?: boolean }) => {
    try { workspaceCheckpointRef.current?.(); }
    catch (reason) {
      setLocalSaveError(reason instanceof Error ? reason.message : 'Zachycení rozložení selhalo.');
      return Promise.resolve(false);
    }
    const wantsCloud = cloudDirtyRef.current && !conflictRef.current
      && (options?.cloud === true || (Date.now() - lastCloudSyncRef.current >= CLOUD_SYNC_INTERVAL_MS
        && Date.now() - lastCloudAttemptRef.current >= 5_000));
    if (!dirtyRef.current && !wantsCloud) return saveChainRef.current;
    const locallyDirty = dirtyRef.current;
    dirtyRef.current = false;
    if (wantsCloud) cloudDirtyRef.current = false;
    const snapshot = runRef.current;
    const snapshotGeneration = mutationGenerationRef.current;
    saveChainRef.current = saveChainRef.current.then(async () => {
      setSaving(true);
      const checkpoint = withBacktestCloudRevision(
        { ...snapshot, revision: persistedRevisionRef.current }, cloudRevisionRef.current,
      );
      let saved = locallyDirty
        ? await saveBacktestRunLocal(checkpoint, {
          status: snapshot.status,
          cursorAt: snapshot.cursorAt,
          config: snapshot.config,
          workspaceState: snapshot.workspaceState,
          runtimeState: snapshot.runtimeState,
          lastOpenedAt: snapshot.lastOpenedAt,
        })
        : checkpoint;
      persistedRevisionRef.current = saved.revision;
      setLocalSaveError(null);
      if (wantsCloud && !conflictRef.current) {
        try {
          lastCloudAttemptRef.current = Date.now();
          saved = await syncBacktestRunToCloud(saved, cloudRevisionRef.current, ledgerCursorRef.current);
          persistedRevisionRef.current = saved.revision;
          cloudRevisionRef.current = saved.revision;
          lastCloudSyncRef.current = Date.now();
          setCloudSaveError(null);
        } catch (reason) {
          if (reason instanceof BacktestRunSyncError) {
            saved = reason.confirmedRun;
            persistedRevisionRef.current = saved.revision;
            cloudRevisionRef.current = saved.revision;
          }
          cloudDirtyRef.current = true;
          setCloudSaveError(reason instanceof Error ? reason.message : 'Cloud je nedostupný. Postup je uložený v tomto zařízení.');
          if (reason instanceof BacktestRunConflictError) { conflictRef.current = true; setCloudConflict(true); }
        }
      }
      // Wall clocks can tie or move backwards; only this exact mutation generation may replace the draft.
      if (mutationGenerationRef.current === snapshotGeneration) {
        runRef.current = saved;
        setRun(saved);
      } else {
        runRef.current = withBacktestCloudRevision(
          { ...runRef.current, revision: saved.revision }, cloudRevisionRef.current,
        );
      }
      return true;
    }).catch(reason => {
      setLocalSaveError(reason instanceof Error ? reason.message : 'Lokální uložení selhalo.');
      dirtyRef.current = true;
      cloudDirtyRef.current = true;
      return false;
    }).finally(() => setSaving(false));
    return saveChainRef.current;
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void flush(), 1_500);
    return () => window.clearInterval(timer);
  }, [flush]);

  // Schování záložky (zavření, přepnutí) je poslední spolehlivá šance dostat
  // stav do cloudu — beforeunload už na síťový zápis čekat neumí.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') void flush({ cloud: true });
    };
    const handleOnline = () => void flush({ cloud: true });
    const handlePageHide = () => void flush();
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('online', handleOnline);
    window.addEventListener('pagehide', handlePageHide);
    return () => { document.removeEventListener('visibilitychange', handleVisibility); window.removeEventListener('online', handleOnline); window.removeEventListener('pagehide', handlePageHide); };
  }, [flush]);

  // Pauza přehrávání = přirozený commit point: uživatel se zastavil, stav je
  // stabilní a cloud si zaslouží čerstvou kopii hned, ne až za minutu.
  const wasPlayingRef = useRef(initialRun.runtimeState.replay.playing);
  useEffect(() => {
    const playing = run.runtimeState.replay.playing;
    if (wasPlayingRef.current && !playing) void flush({ cloud: true });
    wasPlayingRef.current = playing;
  }, [flush, run.runtimeState.replay.playing]);

  const syncCandles = useCallback(() => {
    const snapshot = candleStore.getSnapshot();
    loadedUntilRef.current = snapshot.loadedUntilMs;
    setCandlesByRoot(snapshot.candles);
    setHistoryCandlesByRoot(snapshot.history);
  }, [candleStore]);

  const ensureReplayData = useCallback(async (endMs: number): Promise<MarketCandle[]> => {
    candleRequestsRef.current++;
    marketLoadFailedRef.current = false;
    setLoadingAhead(true);
    setError(null);
    try {
      await candleStore.ensureThrough(endMs);
      return candleStore.getSnapshot().candles[runRef.current.executionSymbol] ?? [];
    } catch (reason) {
      marketLoadFailedRef.current = true;
      setError(reason instanceof Error ? reason.message : 'Tržní data se nepodařilo načíst.');
      throw reason;
    } finally {
      // The ref/store is current before the child commits its awaited cursor.
      syncCandles();
      candleRequestsRef.current--;
      setLoading(false);
      setLoadingAhead(candleRequestsRef.current > 0);
    }
  }, [candleStore, syncCandles]);

  const loadSegment = useCallback(async (requestedStart: number, targetEndMs?: number) => {
    try {
      await ensureReplayData(Math.min(runRef.current.endAt, Math.max(requestedStart + SEGMENT_MS, targetEndMs ?? 0)));
    } catch { /* The data error and retry action remain visible. */ }
  }, [ensureReplayData]);

  const loadOlderHistory = useCallback(async (root: MarketRoot, schema: MarketDataSchema, beforeMs: number) => {
    const key = `${root}:${schema}`;
    if (historyLoadingRef.current.has(key)) return;
    historyLoadingRef.current.add(key);
    setHistoryLoadingKeys(current => ({ ...current, [key]: true }));
    try {
      await candleStore.loadOlder(root, schema, beforeMs);
      syncCandles();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Starší historii se nepodařilo načíst.');
    } finally {
      historyLoadingRef.current.delete(key);
      setHistoryLoadingKeys(current => ({ ...current, [key]: false }));
    }
  }, [candleStore, syncCandles]);

  useEffect(() => {
    const start = Math.max(initialRun.startAt, (initialRun.cursorAt ?? initialRun.startAt) - SEGMENT_MS + PREFETCH_MS);
    void loadSegment(start);
  }, [initialRun.cursorAt, initialRun.startAt, loadSegment]);

  /**
   * Prefetch podle svíček, ne podle hodin. Časová vzdálenost od `loadedUntil`
   * přes víkend lže (okno sahá do neděle, bary končí pátkem); počet načtených
   * barů před kurzorem ne. Načítá se s předstihem — dřív, než kurzor narazí
   * do zdi — a po Go To skoku se celá mezera stáhne jedním voláním.
   */
  const maybePrefetch = useCallback((cursorTime: number | null, executionCandles: MarketCandle[]) => {
    if (candleRequestsRef.current > 0 || marketLoadFailedRef.current || cursorTime === null || loadedUntilRef.current >= runRef.current.endAt) return;
    const lastLoaded = executionCandles[executionCandles.length - 1];
    if (!lastLoaded || cursorTime >= lastLoaded.time) {
      void loadSegment(loadedUntilRef.current, cursorTime * 1_000 + PREFETCH_MS);
      return;
    }
    let low = 0;
    let high = executionCandles.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (executionCandles[mid].time <= cursorTime) low = mid + 1;
      else high = mid;
    }
    if (executionCandles.length - low < PREFETCH_MIN_BARS) void loadSegment(loadedUntilRef.current);
  }, [loadSegment]);

  // Záchytná síť pro stavy, které neprojdou přes handleReplayChange — otevření
  // session s kurzorem přímo na hraně dat nebo obnova po chybě načítání.
  useEffect(() => {
    const replay = run.runtimeState.replay;
    if (!loading && !error && candleRequestsRef.current === 0 && !(candlesByRoot[run.executionSymbol]?.length) && loadedUntilRef.current < run.endAt) {
      void loadSegment(loadedUntilRef.current);
      return;
    }
    if (replay.phase !== 'active' || replay.cursorTime === null) return;
    maybePrefetch(replay.cursorTime, candlesByRoot[run.executionSymbol] ?? []);
  }, [candlesByRoot, loading, error, loadSegment, maybePrefetch, run.endAt, run.executionSymbol, run.runtimeState.replay]);

  const emitClosedTrades = useCallback(async (runtime: BacktestRuntimeState) => {
    if (!onTradeClosed) return;
    const current = runRef.current;
    const snapshot = candleStore.getSnapshot();
    const tasks = runtime.closedTrades.filter(closed => !emittedTradesRef.current.has(closed.id)).map(closed => {
      const active = emittingTradesRef.current.get(closed.id);
      if (active) return active;
      const task = Promise.resolve().then(() => {
        return onTradeClosed({ ...backtestClosedTradeToTrade(closed, {
          accountId: current.accountId, candles: snapshot.candles[closed.instrument] ?? [],
          htfCandles: snapshot.history[closed.instrument]?.['ohlcv-1h'],
          orderEvents: runtime.orderEvents ?? [], timeZone: current.config.timezone,
          flatTimeZone: current.config.flatTimeZone, flatByMinute: current.config.flatByMinute,
          strategy: current.config.strategy,
          researchBinding: current.config.researchBinding,
          replayHorizonTime: runtime.replay.cursorTime ?? closed.exitTime,
          slippageTicks: current.config.slippageTicks[closed.instrument],
        }), recordedAt: backtestResearchRecordedAt(closed, runtime.orderEvents ?? []) ?? null });
      }).then(() => {
        // The parent resolves only once the original snapshot is durable locally.
        emittedTradesRef.current.add(closed.id);
      }).finally(() => emittingTradesRef.current.delete(closed.id));
      emittingTradesRef.current.set(closed.id, task);
      return task;
    });
    const results = await Promise.allSettled(tasks);
    const failed = results.find(result => result.status === 'rejected');
    setJournalQueueError(failed?.status === 'rejected'
      ? `Zápis obchodu čeká na opakování. ${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}` : null);
  }, [candleStore, onTradeClosed]);

  // Recover closed rows after reopening, and retry failed local enqueue operations.
  useEffect(() => {
    if (loading || !candlesByRoot[run.executionSymbol]?.length) return;
    void emitClosedTrades(runRef.current.runtimeState);
    const timer = window.setInterval(() => void emitClosedTrades(runRef.current.runtimeState), 5_000);
    return () => window.clearInterval(timer);
  }, [loading, candlesByRoot, run.executionSymbol, emitClosedTrades]);

  // Expensive analytics run in bounded batches after UI work. Local durable ACKs
  // advance the planning stamps even while cloud sync is unavailable.
  const refreshInputsRef = useRef({ journalTrades, analyticsPreview, onTradeAnalyticsRefresh });
  refreshInputsRef.current = { journalTrades, analyticsPreview, onTradeAnalyticsRefresh };
  const refreshBusyRef = useRef(false);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const inputs = refreshInputsRef.current;
      const current = runRef.current;
      const horizon = current.runtimeState.replay.cursorTime;
      if (disposed || refreshBusyRef.current || restoringRef.current || loading || !inputs.onTradeAnalyticsRefresh || horizon === null) return;
      refreshBusyRef.current = true;
      try {
        const snapshot = candleStore.getSnapshot();
        const trades = inputs.journalTrades.map(trade => {
          const preview = inputs.analyticsPreview[trade.id];
          return preview && preview.stamp.horizonTime <= horizon
            ? { ...trade, backtestAnalyticsRefresh: preview.stamp } : trade;
        });
        const candidates = planBacktestAnalyticsRefresh({ trades,
          closedTrades: [...current.runtimeState.closedTrades].sort((a, b) => (trades.find(trade => trade.id === a.id)?.backtestAnalyticsRefresh?.horizonTime ?? -Infinity) - (trades.find(trade => trade.id === b.id)?.backtestAnalyticsRefresh?.horizonTime ?? -Infinity)),
          candlesByInstrument: snapshot.candles,
          htfCandlesByInstrument: Object.fromEntries(Object.entries(snapshot.history).map(([root, schemas]) => [root, schemas?.['ohlcv-1h']])),
          replayHorizonTime: horizon, slippageTicks: current.config.slippageTicks,
          mappingOptions: { accountId: current.accountId, orderEvents: current.runtimeState.orderEvents ?? [],
            timeZone: current.config.timezone, flatTimeZone: current.config.flatTimeZone,
            flatByMinute: current.config.flatByMinute, strategy: current.config.strategy }, maxTrades: 4,
        });
        if (!candidates.length) return;
        await inputs.onTradeAnalyticsRefresh(candidates);
        if (!disposed) {
          setAnalyticsPreview(previous => ({ ...previous, ...Object.fromEntries(candidates.map(item => [item.tradeId, item])) }));
          setAnalyticsQueueError(null);
        }
      } catch (reason) {
        if (!disposed) setAnalyticsQueueError(reason instanceof Error ? reason.message : 'Dopočet analýz čeká na opakování.');
      } finally { refreshBusyRef.current = false; }
    };
    const first = window.setTimeout(() => void refresh(), 250);
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => { disposed = true; window.clearTimeout(first); window.clearInterval(timer); };
  }, [candleStore, loading]);

  const revealedJournalTrades = useMemo(() => journalTrades.map(trade => {
    const preview = analyticsPreview[trade.id];
    const horizon = run.runtimeState.replay.cursorTime;
    if (preview && horizon !== null && preview.stamp.horizonTime <= horizon) {
      return { ...trade, ...buildBacktestTradeRecalculationUpdates(trade, preview.recalculated), backtestAnalyticsRefresh: preview.stamp };
    }
    // Historical pre-fix analytics may contain prefetched future. Keep the review
    // visible, but withhold those derived paths until a bounded refresh arrives.
    if (trade.backtestRunId === run.id && (!trade.backtestAnalyticsRefresh || horizon === null || trade.backtestAnalyticsRefresh.horizonTime > horizon)) {
      return { ...trade, counterfactual: undefined, excursion: undefined, executionPath: undefined,
        excursionAvailable: false, excursionComplete: false, executionPathComplete: false };
    }
    return trade;
  }), [journalTrades, analyticsPreview, run.id, run.runtimeState.replay.cursorTime]);

  const handleReplayChange = useCallback((replay: ChartReplayState) => {
    if (restoringRef.current) return;
    const currentRuntime = runRef.current.runtimeState;
    const hasExecution = currentRuntime.orders.length || currentRuntime.fills.length || currentRuntime.positions.length || currentRuntime.closedTrades.length;
    if (hasExecution && replay.cursorTime !== null && currentRuntime.replay.cursorTime !== null && replay.cursorTime < currentRuntime.replay.cursorTime) {
      setError('Po zadání objednávky nelze vrátit kurzor zpět. Pro nové přehrání otevři novou session.');
      return;
    }
    const executionInstrument = runRef.current.executionSymbol;
    const snapshot = candleStore.getSnapshot();
    const executionCandles = snapshot.candles[executionInstrument] ?? [];
    if (replay.cursorTime !== null && replay.cursorTime * 1000 >= snapshot.loadedUntilMs) return;
    // Missing legacy history stays unknown; rewinding never erases prior exposure.
    const knownHorizon = currentRuntime.maxRevealedTime;
    let runtime: BacktestRuntimeState = { ...currentRuntime,
      ...(typeof knownHorizon === 'number' && Number.isFinite(knownHorizon) && knownHorizon >= 0
        ? { maxRevealedTime: Math.max(knownHorizon, replay.cursorTime ?? 0, currentRuntime.replay.cursorTime ?? 0) } : {}),
      replay: { ...replay, playing: replay.playing } };
    const previous = lastProcessedCursorRef.current;
    if (replay.phase === 'active' && replay.cursorTime !== null && (previous === null || replay.cursorTime > previous)) {
      // Binary search místo filtru: filtr skenoval celé pole načtených svíček
      // (po delší session desítky tisíc) při každém kroku kurzoru.
      const fromIndex = candleIndexAfter(executionCandles, previous ?? Math.floor(runRef.current.startAt / 1000) - 1);
      const toIndex = candleIndexAfter(executionCandles, replay.cursorTime);
      const revealed = executionCandles.slice(fromIndex, toIndex);
      runtime = processBacktestCandles(runtime, runRef.current.id, executionInstrument, revealed, runRef.current.config);
      lastProcessedCursorRef.current = replay.cursorTime;
    } else if (replay.cursorTime !== null) {
      lastProcessedCursorRef.current = replay.cursorTime;
    }
    // Tik, který nezměnil nic než kurzor a mark-to-market, nemusí překreslit
    // workspace: graf posouvá kurzor vlastní cestou (setReplay) a runtime tu
    // čte checkpoint i engine z refu. React dostane stav při událostech
    // enginu (fill, objednávka, pozice), nejméně dvakrát za sekundu kvůli
    // equity, a trailing doběh zaručí, že poslední stav dorazí i po sérii
    // tichých kroků — držená šipka tak neplatí render za každý keydown.
    const previousRuntime = runRef.current.runtimeState;
    const engineChanged = runtime.orders !== previousRuntime.orders
      || runtime.fills !== previousRuntime.fills
      || runtime.positions !== previousRuntime.positions
      || runtime.closedTrades !== previousRuntime.closedTrades;
    const wasPlaying = previousRuntime.replay.playing;
    const render = engineChanged
      || replay.playing !== wasPlaying
      || performance.now() - lastRuntimeRenderRef.current >= RUNTIME_RENDER_INTERVAL_MS;
    updateRun(current => ({
      ...current,
      cursorAt: replay.cursorTime ? replay.cursorTime * 1_000 : current.cursorAt,
      runtimeState: runtime,
      status: replay.playing ? 'active' : current.status === 'completed' ? 'completed' : 'paused',
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
    }), { render });
    if (render) {
      if (trailingRenderRef.current !== null) {
        window.clearTimeout(trailingRenderRef.current);
        trailingRenderRef.current = null;
      }
    } else {
      if (trailingRenderRef.current !== null) window.clearTimeout(trailingRenderRef.current);
      trailingRenderRef.current = window.setTimeout(() => {
        trailingRenderRef.current = null;
        lastRuntimeRenderRef.current = performance.now();
        setRun(runRef.current);
      }, RUNTIME_RENDER_TRAILING_MS);
    }
    maybePrefetch(replay.cursorTime, executionCandles);
    void emitClosedTrades(runtime);
  }, [candleStore, emitClosedTrades, maybePrefetch, updateRun]);

  const handleWorkspaceChange = useCallback((workspaceState: BacktestWorkspaceState) => {
    updateRun(current => ({ ...current, workspaceState, updatedAt: Date.now() }));
  }, [updateRun]);

  const executeOrder = useCallback((input: {
    side: 'buy' | 'sell'; type: BacktestOrderType; quantity: number; price?: number; stopLoss?: number; takeProfit?: number; reduceOnly?: boolean;
  }, candle: MarketCandle | null, sourceDrawing?: PositionDrawing) => {
    if (restoringRef.current || !candle || candle.time * 1_000 < runRef.current.startAt) return null;
    const order = createBacktestOrder({
      runId: runRef.current.id,
      instrument: runRef.current.executionSymbol,
      side: input.side,
      type: input.type,
      quantity: input.quantity,
      limitPrice: input.type === 'limit' ? input.price : undefined,
      stopPrice: input.type === 'stop' ? input.price : undefined,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      reduceOnly: input.reduceOnly,
      now: candle.time,
    });
    updateRun(current => {
      let runtime = enqueueBacktestOrder(current.runtimeState, order, Date.now());
      if (sourceDrawing) {
        runtime = {
          ...runtime,
          managedPositionPlans: [
            ...(runtime.managedPositionPlans ?? []).filter(plan => plan.orderId !== order.id),
            createManagedPositionPlan(sourceDrawing, order),
          ],
        };
      }
      if (input.type === 'market') runtime = executeBacktestMarketOrder(runtime, order.id, candle, current.config);
      void emitClosedTrades(runtime);
      return { ...current, runtimeState: runtime, updatedAt: Date.now() };
    });
    return order;
  }, [emitClosedTrades, updateRun]);

  const closePosition = useCallback((quantity: number, candle: MarketCandle | null) => {
    const position = runRef.current.runtimeState.positions.find(item => item.instrument === runRef.current.executionSymbol);
    if (!position || !candle) return;
    executeOrder({ side: position.side === 'long' ? 'sell' : 'buy', type: 'market', quantity: Math.min(quantity, position.quantity), reduceOnly: true }, candle);
  }, [executeOrder]);

  const cancelOrder = useCallback((id: string, candle: MarketCandle | null) => {
    updateRun(current => ({ ...current, runtimeState: cancelBacktestOrder(current.runtimeState, id, candle?.time ?? Math.floor(Date.now() / 1_000), Date.now()), updatedAt: Date.now() }));
  }, [updateRun]);

  const changeBracket = useCallback((stopLoss?: number, takeProfit?: number) => {
    updateRun(current => ({
      ...current,
      runtimeState: updatePositionBracket(
        current.runtimeState,
        current.executionSymbol,
        stopLoss,
        takeProfit,
        current.runtimeState.replay.cursorTime ?? undefined,
        Date.now(),
      ),
      updatedAt: Date.now(),
    }));
  }, [updateRun]);

  const changeOrderLine = useCallback((line: BacktestChartOrderLine, kind: BacktestChartOrderLineKind, price: number) => {
    updateRun(current => {
      if (line.ownerType === 'order') {
        return {
          ...current,
          runtimeState: updatePendingBacktestOrder(
            current.runtimeState,
            line.ownerId,
            kind,
            price,
            current.runtimeState.replay.cursorTime ?? Math.floor(Date.now() / 1_000),
            Date.now(),
          ),
          updatedAt: Date.now(),
        };
      }
      const position = current.runtimeState.positions.find(item => item.instrument === line.ownerId);
      if (!position) return current;
      return {
        ...current,
        runtimeState: updatePositionBracket(
          current.runtimeState,
          position.instrument,
          kind === 'stopLoss' ? price : position.stopLoss,
          kind === 'takeProfit' ? price : position.takeProfit,
          current.runtimeState.replay.cursorTime ?? Math.floor(Date.now() / 1_000),
          Date.now(),
        ),
        updatedAt: Date.now(),
      };
    });
  }, [updateRun]);

  const cancelOrderLine = useCallback((line: BacktestChartOrderLine) => {
    if (line.ownerType === 'position') {
      const current = runRef.current;
      const position = current.runtimeState.positions.find(item => item.instrument === line.ownerId);
      if (!position) return;
      if (line.cancelAction === 'close-position' || line.kind === 'entry') {
        const cursor = current.runtimeState.replay.cursorTime;
        const candle = cursor === null
          ? null
          : [...(candlesByRoot[position.instrument] ?? [])].reverse().find(item => item.time <= cursor) ?? null;
        closePosition(position.quantity, candle);
        return;
      }
      updateRun(runState => ({
        ...runState,
        runtimeState: updatePositionBracket(
          runState.runtimeState,
          position.instrument,
          line.kind === 'stopLoss' ? undefined : position.stopLoss,
          line.kind === 'takeProfit' ? undefined : position.takeProfit,
          runState.runtimeState.replay.cursorTime ?? Math.floor(Date.now() / 1_000),
          Date.now(),
        ),
        updatedAt: Date.now(),
      }));
      return;
    }
    // Křížek na SL/TP lince objednávky maže jen ten bracket. Zrušit celou
    // objednávku patří výhradně křížku na entry lince.
    if (line.cancelAction === 'remove-bracket' && line.kind !== 'entry') {
      const field = line.kind;
      updateRun(current => ({
        ...current,
        runtimeState: clearPendingBacktestOrderBracket(
          current.runtimeState,
          line.ownerId,
          field,
          current.runtimeState.replay.cursorTime ?? Math.floor(Date.now() / 1_000),
          Date.now(),
        ),
        updatedAt: Date.now(),
      }));
      return;
    }
    updateRun(current => ({
      ...current,
      runtimeState: cancelBacktestOrder(
        current.runtimeState,
        line.ownerId,
        current.runtimeState.replay.cursorTime ?? Math.floor(Date.now() / 1_000),
        Date.now(),
      ),
      updatedAt: Date.now(),
    }));
  }, [candlesByRoot, closePosition, updateRun]);

  const addPositionBracketLine = useCallback((
    line: BacktestChartOrderLine,
    kind: Exclude<BacktestChartOrderLineKind, 'entry'>,
    draggedPrice?: number,
  ) => {
    updateRun(current => {
      // Čekající objednávka: bracket se počítá od její vstupní ceny, ne od
      // pozice — ta ještě neexistuje.
      if (line.ownerType === 'order') {
        const order = current.runtimeState.orders.find(item => item.id === line.ownerId && item.status === 'pending');
        if (!order) return current;
        const entry = order.type === 'limit' ? order.limitPrice : order.stopPrice;
        if (!Number.isFinite(entry)) return current;
        const entryPrice = Number(entry);
        const opposite = kind === 'stopLoss' && Number.isFinite(order.takeProfit)
          ? Math.abs(Number(order.takeProfit) - entryPrice)
          : kind === 'takeProfit' && Number.isFinite(order.stopLoss)
            ? Math.abs(entryPrice - Number(order.stopLoss))
            : 20;
        const distance = Math.min(100, Math.max(0.25, Math.round(opposite / 0.25) * 0.25));
        const long = order.side === 'buy';
        const suggested = long
          ? entryPrice + (kind === 'takeProfit' ? distance : -distance)
          : entryPrice + (kind === 'takeProfit' ? -distance : distance);
        const requested = Number.isFinite(draggedPrice) ? Number(draggedPrice) : suggested;
        // Bracket na špatné straně vstupu by se vyplnil hned po otevření.
        const bracketPrice = long
          ? kind === 'stopLoss' ? Math.min(requested, entryPrice - 0.25) : Math.max(requested, entryPrice + 0.25)
          : kind === 'stopLoss' ? Math.max(requested, entryPrice + 0.25) : Math.min(requested, entryPrice - 0.25);
        return {
          ...current,
          runtimeState: updatePendingBacktestOrder(
            current.runtimeState,
            order.id,
            kind,
            bracketPrice,
            current.runtimeState.replay.cursorTime ?? Math.floor(Date.now() / 1_000),
          ),
          updatedAt: Date.now(),
        };
      }
      const position = current.runtimeState.positions.find(item => item.instrument === line.ownerId);
      if (!position) return current;
      const entry = position.averagePrice;
      const oppositeDistance = kind === 'stopLoss' && Number.isFinite(position.takeProfit)
        ? Math.abs(Number(position.takeProfit) - entry)
        : kind === 'takeProfit' && Number.isFinite(position.stopLoss)
          ? Math.abs(entry - Number(position.stopLoss))
          : 20;
      // Legacy sessions can contain bracket prices far outside the loaded chart.
      // Cap the mirrored distance so pressing SL/TP always creates a visible,
      // immediately draggable order line near the market position.
      const distance = Math.min(100, Math.max(0.25, Math.round(oppositeDistance / 0.25) * 0.25));
      const suggestedPrice = position.side === 'long'
        ? entry + (kind === 'takeProfit' ? distance : -distance)
        : entry + (kind === 'takeProfit' ? -distance : distance);
      const requestedPrice = Number.isFinite(draggedPrice) ? Number(draggedPrice) : suggestedPrice;
      const bracketPrice = position.side === 'long'
        ? kind === 'stopLoss'
          ? Math.min(requestedPrice, entry - 0.25)
          : Math.max(requestedPrice, entry + 0.25)
        : kind === 'stopLoss'
          ? Math.max(requestedPrice, entry + 0.25)
          : Math.min(requestedPrice, entry - 0.25);
      return {
        ...current,
        runtimeState: updatePositionBracket(
          current.runtimeState,
          position.instrument,
          kind === 'stopLoss' ? bracketPrice : position.stopLoss,
          kind === 'takeProfit' ? bracketPrice : position.takeProfit,
          current.runtimeState.replay.cursorTime ?? Math.floor(current.startAt / 1000),
          Date.now(),
        ),
        updatedAt: Date.now(),
      };
    });
  }, [updateRun]);

  const orderLines = useMemo(() => {
    const runtime = run.runtimeState;
    const cursor = runtime.replay.cursorTime;
    const currentPrice = cursor === null
      ? undefined
      : [...(candlesByRoot[run.executionSymbol] ?? [])].reverse().find(candle => candle.time <= cursor)?.close;
    return [
      ...runtime.orders.flatMap(pendingOrderChartLines),
      ...runtime.positions
        .filter(position => position.instrument === run.executionSymbol)
        .flatMap(position => {
          const enteredByMarketOrder = position.entryFillIds.some(fillId => {
            const fill = runtime.fills.find(candidate => candidate.id === fillId);
            if (!fill?.orderId) return false;
            return runtime.orders.find(order => order.id === fill.orderId)?.type === 'market';
          });
          return positionChartLines(position, currentPrice, enteredByMarketOrder);
        }),
    ];
  }, [candlesByRoot, run.executionSymbol, run.runtimeState]);

  const executeQuickOrder = useCallback((drawing: PositionDrawing, candle: MarketCandle | null, instrument: MarketRoot) => {
    if (instrument !== runRef.current.executionSymbol) {
      return { ok: false, message: `Quick Order lze zadat jen z ${runRef.current.executionSymbol} grafu.` };
    }
    if (!candle) return { ok: false, message: 'Quick Order není dostupný bez aktuální replay ceny.' };
    try {
      const order = createBacktestQuickOrderDraft(drawing, candle);
      const submitted = executeOrder(order, candle, drawing);
      if (!submitted) return { ok: false, message: 'Obchodování je povolené až od začátku replay session.' };
      return { ok: true, message: `${backtestQuickOrderLabel(order)} odeslán z position boxu.` };
    } catch (reason) {
      return { ok: false, message: reason instanceof Error ? reason.message : 'Quick Order se nepodařilo vytvořit.' };
    }
  }, [executeOrder]);

  const managedBoxes = useMemo(
    () => managedPositionBoxes(run.runtimeState),
    [run.runtimeState],
  );

  const recalculateTrade = useCallback((tradeId: string): Trade => {
    const current = runRef.current;
    const closed = current.runtimeState.closedTrades.find(candidate => candidate.id === tradeId);
    if (!closed) throw new Error('Původní replay obchod už v této session není dostupný.');
    const candles = candlesByRoot[closed.instrument] ?? [];
    if (!candles.length) throw new Error(`Pro ${closed.instrument} nejsou načtené replay svíčky.`);
    return backtestClosedTradeToTrade(closed, {
      accountId: current.accountId,
      candles,
      htfCandles: historyCandlesByRoot[closed.instrument]?.['ohlcv-1h'],
      orderEvents: current.runtimeState.orderEvents ?? [],
      timeZone: current.config.timezone,
      flatTimeZone: current.config.flatTimeZone,
      flatByMinute: current.config.flatByMinute,
      strategy: current.config.strategy,
          researchBinding: current.config.researchBinding,
      replayHorizonTime: current.runtimeState.replay.cursorTime ?? closed.exitTime,
      slippageTicks: current.config.slippageTicks[closed.instrument],
    });
  }, [candlesByRoot, historyCandlesByRoot]);

  const loadEvidence = useCallback(() => {
    const current = runRef.current;
    return buildBacktestStoreEvidence({ snapshot: candleStore.getSnapshot(), run: current, replayHorizonTime: current.runtimeState.replay.cursorTime });
  }, [candleStore]);

  const researchContext = useCallback(() => {
    const current = runRef.current;
    return captureBacktestResearchContext({ runId: current.id, instrument: current.executionSymbol,
      runtime: current.runtimeState, candles: candleStore.getSnapshot().candles[current.executionSymbol] ?? [],
      runCompleted: current.status === 'completed' });
  }, [candleStore]);
  const saveResearch = useCallback(async (draft: BacktestResearchDraft, operation: { id: string; recordedAt: number }, edit?: { id: string; expectedRevisionId: string; archived?: boolean }) => {
    if (restoringRef.current || conflictRef.current) throw new Error('Nejdřív vyřeš konflikt session. Rozepsaný text zůstává otevřený.');
    const current = runRef.current;
    const context = researchContext();
    const result = edit ? reviseBacktestResearch({ journal: current.runtimeState.researchJournal!,
      id: edit.id, expectedRevisionId: edit.expectedRevisionId, patch: { title: draft.title, text: draft.text, tags: draft.tags, action: draft.action, archived: edit.archived },
      context, recordedAt: operation.recordedAt, opId: operation.id })
      : appendBacktestResearch(current.runtimeState.researchJournal, draft, context, operation.recordedAt, operation.id);
    updateRun(value => ({ ...value, runtimeState: { ...value.runtimeState, researchJournal: result.journal }, updatedAt: Date.now() }));
    const localSaved = await flush({ cloud: true });
    return { localSaved, cloudSaved: localSaved && !cloudDirtyRef.current && !conflictRef.current };
  }, [flush, researchContext, updateRun]);
  const captureResearch = useCallback(async () => {
    if (!researchCaptureRef.current) throw new Error('Graf ještě není připravený.');
    return researchCaptureRef.current();
  }, []);

  // Množství drží workspace, ne jen obchodní panel: objednávka z pravého kliku
  // do grafu musí použít přesně to číslo, které uživatel vidí vedle typu.
  const [orderQuantity, setOrderQuantity] = useState(run.config.defaultQuantity || 1);

  const bridge = useMemo<BacktestChartSessionBridge>(() => ({
    id: run.id,
    startMs: run.startAt,
    endMs: run.endAt,
    candlesByRoot,
    historyCandlesByRoot,
    historyLoadingKeys,
    onNeedOlderHistory: loadOlderHistory,
    loadedUntilMs: candleStore.getSnapshot().loadedUntilMs,
    onEnsureReplayData: ensureReplayData,
    replayHasExecutionHistory: Boolean(run.runtimeState.orders.length || run.runtimeState.fills.length || run.runtimeState.positions.length || run.runtimeState.closedTrades.length),
    minimumReplayCursorTime: run.runtimeState.orders.length || run.runtimeState.fills.length
      ? run.runtimeState.replay.cursorTime ?? Math.floor(run.startAt / 1000)
      : Math.floor(run.startAt / 1000),
    allowedRoots: run.config.instruments,
    executionInstrument: run.executionSymbol,
    initialReplay: run.runtimeState.replay,
    workspaceState: run.workspaceState,
    onReplayChange: handleReplayChange,
    onWorkspaceChange: handleWorkspaceChange,
    registerWorkspaceCheckpoint,
    registerResearchCapture,
    maxRevealedTime: run.runtimeState.maxRevealedTime,
    pauseReplayForDialog: researchOpen || evidenceOpen,
    onSaveWorkspace: async () => ({ localSaved: await flush({ cloud: true }), cloudSaved: !cloudDirtyRef.current && !conflictRef.current }),
    onQuickOrder: ({ drawing, candle, instrument }) => executeQuickOrder(drawing, candle, instrument),
    chartOrderQuantity: orderQuantity,
    onChartOrder: (input, candle) => {
      executeOrder({ side: input.side, type: input.type, quantity: input.quantity, price: input.price }, candle);
    },
    orderLines,
    managedPositionBoxes: managedBoxes,
    fills: run.runtimeState.fills.filter(fill => fill.instrument === run.executionSymbol),
    closedTrades: run.runtimeState.closedTrades.filter(trade => trade.instrument === run.executionSymbol),
    tagSuggestions,
    journalTrades: revealedJournalTrades.filter(trade => (
      trade.backtestRunId === run.id
      || run.runtimeState.closedTrades.some(closed => closed.id === String(trade.id))
    )),
    onTradeRecalculate: recalculateTrade,
    onTradeReviewSave,
    onOrderLineChange: changeOrderLine,
    onOrderLineCancel: cancelOrderLine,
    onOrderLineAddBracket: addPositionBracketLine,
    renderTradingPanel: ({ candle }) => (
      <BacktestTradingPanel
        run={runRef.current}
        candle={candle}
        isDark={isDark}
        quantity={orderQuantity}
        onQuantityChange={setOrderQuantity}
        onOrder={executeOrder}
        onCancel={cancelOrder}
        onClosePosition={closePosition}
        onChangeBracket={changeBracket}
      />
    ),
  }), [addPositionBracketLine, candleStore, ensureReplayData, candlesByRoot, cancelOrder, cancelOrderLine, changeBracket, changeOrderLine, closePosition, executeOrder, executeQuickOrder, flush, handleReplayChange, handleWorkspaceChange, historyCandlesByRoot, historyLoadingKeys, isDark, revealedJournalTrades, tagSuggestions, loadOlderHistory, managedBoxes, onTradeReviewSave, orderLines, orderQuantity, recalculateTrade, registerResearchCapture, registerWorkspaceCheckpoint, researchOpen, evidenceOpen, run.config.instruments, run.endAt, run.executionSymbol, run.id, run.runtimeState, run.startAt, run.workspaceState]);

  const syntheticTrade = useMemo<Trade>(() => ({
    id: `backtest-${run.id}`,
    accountId: run.accountId,
    backtestRunId: run.id,
    instrument: run.executionSymbol,
    symbol: run.executionSymbol,
    signal: 'Bar Replay',
    // This object is chart metadata, not the live trading ledger. Keeping P&L
    // here would recreate the trade after every fill/commission update. The
    // chart treats a new trade object as a reason to rebuild its overlays and
    // focus the trade again, which made BUY/SELL reset the user's viewport.
    // Balance, realized and open P&L are rendered from runtimeState below.
    pnl: 0,
    runUp: 0,
    drawdown: 0,
    date: new Date(run.startAt).toISOString(),
    timestamp: run.startAt,
    direction: 'Long',
    duration: '',
    durationMinutes: 0,
  }), [run.accountId, run.executionSymbol, run.id, run.startAt]);

  const closeWorkspace = useCallback(async () => {
    updateRun(current => ({
      ...current,
      status: current.status === 'completed' ? 'completed' : 'paused',
      runtimeState: { ...current.runtimeState, replay: { ...current.runtimeState.replay, playing: false } },
      updatedAt: Date.now(),
    }));
    await emitClosedTrades(runRef.current.runtimeState);
    if (await flush({ cloud: true })) onClose(runRef.current);
  }, [emitClosedTrades, flush, onClose, updateRun]);

  const restoreCloud = useCallback(async () => {
    try { workspaceCheckpointRef.current?.(); }
    catch (reason) {
      setLocalSaveError(reason instanceof Error ? reason.message : 'Zachycení rozložení selhalo.');
      return;
    }
    updateRun(current => ({ ...current, runtimeState: { ...current.runtimeState, replay: { ...current.runtimeState.replay, playing: false } }, updatedAt: Date.now() }));
    restoringRef.current = true;
    setRestoring(true);
    try {
      if (!await flush()) return;
      const remote = await loadBacktestRunFromCloud(runRef.current.id);
      onReloadRun(remote);
    } catch (reason) { setCloudSaveError(reason instanceof Error ? reason.message : String(reason)); }
    finally { restoringRef.current = false; setRestoring(false); }
  }, [flush, onReloadRun, updateRun]);

  const initialCandles = candlesByRoot.MNQ ?? [];
  if (!appearanceReady) return null;
  const noData = !loading && initialCandles.length === 0 && candleStore.getSnapshot().loadedUntilMs >= run.endAt;
  if (loading && initialCandles.length === 0) return (
    <div className={`fixed inset-0 z-[400] flex flex-col items-center justify-center gap-4 ${isDark ? 'bg-[#070a0f] text-white' : 'bg-white text-slate-900'}`}>
      <Loader2 className="animate-spin text-blue-500" size={30} />
      <div className="text-center"><p className="font-black">Načítám backtest session</p><p className="text-xs text-slate-500">MNQ + NQ · první datový segment</p></div>
      <button onClick={() => void closeWorkspace()} className="absolute right-4 top-4 rounded-lg p-2 text-slate-500 hover:bg-slate-500/10"><X size={20} /></button>
    </div>
  );
  if ((error || noData) && initialCandles.length === 0) return (
    <div className={`fixed inset-0 z-[400] flex flex-col items-center justify-center gap-4 p-6 ${isDark ? 'bg-[#070a0f] text-white' : 'bg-white text-slate-900'}`}>
      <p className="max-w-lg text-center text-sm font-bold text-rose-500">{error ?? 'Ve zvoleném období nejsou dostupné svíčky.'}</p>
      <div className="flex gap-2"><button onClick={() => void loadSegment(run.cursorAt ?? run.startAt)} className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-black text-white">Zkusit znovu</button><button onClick={() => void closeWorkspace()} className="rounded-lg border px-4 py-2 text-xs font-black">Zavřít</button></div>
    </div>
  );

  return (
    <>
      {restoring && <div className="fixed inset-0 z-[600] flex items-center justify-center bg-black/60 text-white" role="status">Uchovávám lokální kopii a načítám cloud…</div>}
      <div className="fixed right-4 top-14 z-[550] max-w-md rounded-lg border border-slate-500/30 bg-slate-950/90 px-3 py-2 text-[11px] text-slate-200 shadow-lg" role="status">
        <p>{saving ? 'Ukládám session…' : localSaveError ? 'Lokální uložení selhalo' : 'Průběžné ukládání do tohoto zařízení'}</p>
        {localSaveError && <p className="text-rose-400">{localSaveError}</p>}
        {cloudSaveError && <p className="mt-1 text-amber-400">{cloudSaveError}</p>}
        {journalQueueError && <p className="mt-1 text-rose-400">{journalQueueError}</p>}
        <button className="pointer-events-auto mt-1 text-violet-400 underline" onClick={() => { updateRun(current => ({ ...current, runtimeState: { ...current.runtimeState, replay: { ...current.runtimeState.replay, playing: false } } })); setEvidenceOpen(true); }}>Kvalita dat a exekuce</button>
        <button className="pointer-events-auto ml-3 mt-1 text-violet-400 underline" onClick={() => { updateRun(current => ({ ...current, runtimeState: { ...current.runtimeState, replay: { ...current.runtimeState.replay, playing: false } } })); setResearchOpen(true); }}>Rozhodovací deník</button>
        {run.config.researchBinding && <details className="mt-2"><summary className="cursor-pointer text-violet-300">Pravidla session · {run.config.researchBinding.role === 'validation' ? 'plánované ověření' : 'vývoj'}</summary><p className="mt-1 whitespace-pre-wrap">{run.config.researchBinding.definition.rule}</p><p className="mt-1">Vyvrácení: {run.config.researchBinding.definition.falsification}</p><p className="mt-1 break-all text-slate-400">Verze {run.config.researchBinding.revisionId} · {run.config.researchBinding.revisionHash}</p><p className="mt-1 text-amber-400">{run.config.researchBinding.exposureAtBinding === 'already-observed' ? 'Toto období už bylo pozorované.' : 'Úplná nepozorovanost období není potvrzená.'}</p></details>}
        {analyticsQueueError && <p className="mt-1 text-amber-400">{analyticsQueueError}</p>}
        {analyticsSyncState?.pending ? <p className="mt-1 text-amber-400">Analýzy: {analyticsSyncState.pending} dopočtů čeká na cloud.</p> : null}
        {analyticsSyncState?.error && <p className="mt-1 text-amber-400">{analyticsSyncState.error}</p>}
        {journalSyncState?.pending ? <p className="mt-1 text-amber-400">Deník: {journalSyncState.pending} obchodů čeká na cloud.</p> : null}
        {journalSyncState?.error && <p className="mt-1 text-amber-400">{journalSyncState.error}</p>}
        {(localSaveError || (cloudSaveError && !cloudConflict)) && <button className="mt-1 font-bold text-blue-400" onClick={() => void flush({ cloud: true })}>Zkusit uložení znovu</button>}
        {cloudConflict && <button disabled={restoring} className="mt-1 font-bold text-blue-400" onClick={() => void restoreCloud()}>{restoring ? 'Načítám…' : 'Uchovat lokální kopii a načíst cloud'}</button>}
      </div>
      <AlphaTradeChartWorkspace
        trade={syntheticTrade}
        entryMs={run.startAt}
        exitMs={run.endAt}
        initialRoot="MNQ"
        initialCandles={initialCandles}
        isDark={isDark}
        onClose={() => void closeWorkspace()}
        backtestSession={bridge}
      />
      {/* Selhání dalšího segmentu se dřív jen zapsalo do stavu a nikde
          neukázalo — chart už svíčky měl, takže chybová obrazovka výš se
          nespustila a uživatel viděl jen zamčené přehrávání bez vysvětlení. */}
      {/* Dotahování dat za běhu bylo dřív neviditelné — kurzor na hraně vypadal
          jako zamrznutí. Pill říká, že se pracuje. */}
      {loadingAhead && !error && initialCandles.length > 0 && (
        <div className="native-fixed-above-tab-bar fixed bottom-4 left-1/2 z-[500] flex -translate-x-1/2 items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3.5 py-1.5 backdrop-blur">
          <Loader2 size={12} className="animate-spin text-blue-400" />
          <span className="text-[11px] font-bold text-blue-400">Načítám další data…</span>
        </div>
      )}
      <BacktestResearchPanel open={researchOpen} isDark={isDark} runId={run.id}
        journal={run.runtimeState.researchJournal} onSave={saveResearch} onCapture={captureResearch}
        onClose={() => setResearchOpen(false)} persistenceError={localSaveError || cloudSaveError}
        cursorTime={run.runtimeState.replay.cursorTime} />
      {evidenceOpen && <BacktestEvidenceDialog load={loadEvidence} isDark={isDark} onClose={() => setEvidenceOpen(false)} />}
      {error && initialCandles.length > 0 && (
        <div className="native-fixed-above-tab-bar fixed bottom-4 left-1/2 z-[500] flex -translate-x-1/2 items-center gap-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 backdrop-blur">
          <span className="text-xs font-bold text-rose-500">{error}</span>
          <button
            onClick={() => void loadSegment(loadedUntilRef.current)}
            className="rounded-md bg-rose-500 px-2.5 py-1 text-[11px] font-black text-white hover:bg-rose-400"
          >Zkusit znovu</button>
          <button
            onClick={() => setError(null)}
            className="text-[11px] font-bold text-rose-500/70 hover:text-rose-500"
            aria-label="Skrýt hlášku"
          >Skrýt</button>
        </div>
      )}
    </>
  );
};

interface TradingPanelProps {
  run: BacktestRun;
  candle: MarketCandle | null;
  isDark: boolean;
  quantity: number;
  onQuantityChange: (quantity: number) => void;
  onOrder: (input: { side: 'buy' | 'sell'; type: BacktestOrderType; quantity: number; price?: number; stopLoss?: number; takeProfit?: number; reduceOnly?: boolean }, candle: MarketCandle | null) => void;
  onCancel: (id: string, candle: MarketCandle | null) => void;
  onClosePosition: (quantity: number, candle: MarketCandle | null) => void;
  onChangeBracket: (stopLoss?: number, takeProfit?: number) => void;
}

const BacktestTradingPanel: React.FC<TradingPanelProps> = ({ run, candle, isDark, quantity, onQuantityChange, onOrder, onCancel, onClosePosition, onChangeBracket }) => {
  const [type, setType] = useState<BacktestOrderType>('market');
  const [price, setPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [orderError, setOrderError] = useState<string | null>(null);
  const runtime = run.runtimeState;
  const position = runtime.positions.find(item => item.instrument === run.executionSymbol);
  const [positionStop, setPositionStop] = useState('');
  const [positionTarget, setPositionTarget] = useState('');
  useEffect(() => { setPositionStop(position?.stopLoss?.toString() ?? ''); }, [position?.positionId, position?.stopLoss]);
  useEffect(() => { setPositionTarget(position?.takeProfit?.toString() ?? ''); }, [position?.positionId, position?.takeProfit]);
  const pending = runtime.orders.filter(order => order.status === 'pending');
  const field = `h-7 rounded border px-2 text-[10px] outline-none ${isDark ? 'border-white/10 bg-white/5 text-white' : 'border-slate-200 bg-white text-slate-900'}`;
  const num = (value: string) => value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined;
  const submit = (side: 'buy' | 'sell') => {
    const orderPrice = num(price);
    if (!Number.isFinite(quantity) || quantity < 1) {
      setOrderError('Zadej platný počet kontraktů.');
      return;
    }
    if (type !== 'market' && (!Number.isFinite(orderPrice) || Number(orderPrice) <= 0)) {
      setOrderError(`${type === 'limit' ? 'Limitní' : 'Stop'} objednávka potřebuje cenu.`);
      return;
    }
    setOrderError(null);
    onOrder({ side, type, quantity, price: orderPrice, stopLoss: num(stopLoss), takeProfit: num(takeProfit) }, candle);
  };
  return (
    <div className="flex h-full items-center gap-3 overflow-x-auto px-3 text-[10px]">
      <div className="min-w-[245px]">
        <div className="mb-1 flex gap-1">
          <select value={type} onChange={event => setType(event.target.value as BacktestOrderType)} className={`${field} w-20`}><option value="market">Market</option><option value="limit">Limit</option><option value="stop">Stop</option></select>
          <input type="number" min={1} value={quantity} onChange={event => onQuantityChange(Math.max(1, Number(event.target.value)))} className={`${field} w-14`} title="Počet kontraktů — použije se i pro objednávku z pravého kliku do grafu" />
          {type !== 'market' && <input type="number" step="0.25" value={price} onChange={event => setPrice(event.target.value)} placeholder="Cena" className={`${field} w-20`} />}
          <input type="number" step="0.25" value={stopLoss} onChange={event => setStopLoss(event.target.value)} placeholder="SL" className={`${field} w-16`} />
          <input type="number" step="0.25" value={takeProfit} onChange={event => setTakeProfit(event.target.value)} placeholder="TP" className={`${field} w-16`} />
        </div>
        <div className="flex gap-1"><button onClick={() => submit('buy')} disabled={!candle} className="h-7 flex-1 rounded bg-emerald-600 font-black text-white disabled:opacity-40">BUY</button><button onClick={() => submit('sell')} disabled={!candle} className="h-7 flex-1 rounded bg-rose-600 font-black text-white disabled:opacity-40">SELL</button></div>
        {orderError && <div className="mt-1 text-[9px] font-bold text-rose-500">{orderError}</div>}
      </div>
      <div className={`h-12 w-px shrink-0 ${isDark ? 'bg-white/10' : 'bg-slate-200'}`} />
      <div className="grid min-w-[280px] grid-cols-4 gap-x-4 gap-y-1 font-mono">
        <span className="text-slate-500">Balance</span><b>${runtime.balance.toFixed(2)}</b><span className="text-slate-500">Equity</span><b>${runtime.equity.toFixed(2)}</b>
        <span className="text-slate-500">Realized</span><b className={runtime.realizedPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}>{runtime.realizedPnl >= 0 ? '+' : ''}${runtime.realizedPnl.toFixed(2)}</b><span className="text-slate-500">Open</span><b>{runtime.unrealizedPnl >= 0 ? '+' : ''}${runtime.unrealizedPnl.toFixed(2)}</b>
      </div>
      {position && <>
        <div className={`h-12 w-px shrink-0 ${isDark ? 'bg-white/10' : 'bg-slate-200'}`} />
        <div className="min-w-[260px]"><div className="mb-1 font-black"><span className={position.side === 'long' ? 'text-emerald-500' : 'text-rose-500'}>{position.side.toUpperCase()} {position.quantity}×</span> @ {position.averagePrice.toFixed(2)}</div><div className="flex gap-1"><input className={`${field} w-16`} value={positionStop} onChange={event => setPositionStop(event.target.value)} placeholder="SL" onBlur={event => onChangeBracket(num(event.target.value), position.takeProfit)} /><input className={`${field} w-16`} value={positionTarget} onChange={event => setPositionTarget(event.target.value)} placeholder="TP" onBlur={event => onChangeBracket(position.stopLoss, num(event.target.value))} />{position.quantity > 1 && <button onClick={() => onClosePosition(Math.floor(position.quantity / 2), candle)} className={`${field} font-bold`}>½ ven</button>}<button onClick={() => onClosePosition(position.quantity, candle)} className="h-7 rounded bg-slate-700 px-2 font-black text-white">Zavřít</button></div></div>
      </>}
      {pending.length > 0 && <>
        <div className={`h-12 w-px shrink-0 ${isDark ? 'bg-white/10' : 'bg-slate-200'}`} />
        <div className="min-w-[190px] space-y-1">{pending.slice(0, 3).map(order => <div key={order.id} className="flex items-center gap-2"><span className="font-bold">{order.side.toUpperCase()} {order.quantity} {order.type} @{order.limitPrice ?? order.stopPrice}</span><button onClick={() => onCancel(order.id, candle)} className="text-rose-500">×</button></div>)}</div>
      </>}
      <div className="ml-auto whitespace-nowrap text-slate-500">{candle ? `${run.executionSymbol} ${candle.close.toFixed(2)}` : 'Bez ceny'}</div>
    </div>
  );
};

const BacktestWorkspace: React.FC<Props> = props => {
  const [restored, setRestored] = useState<{ sourceId: string; run: BacktestRun; version: number } | null>(null);
  const current = restored?.sourceId === props.run.id ? restored : null;
  return <BacktestWorkspaceSession {...props} key={`${props.run.id}:${current?.version ?? 0}`} run={current?.run ?? props.run}
    onReloadRun={next => setRestored(previous => ({ sourceId: props.run.id, run: next, version: (previous?.version ?? 0) + 1 }))} />;
};

export default BacktestWorkspace;
