import BacktestEvidenceDialog from './BacktestEvidenceDialog';
import { buildBacktestStoreEvidence } from '../services/backtestStoreEvidence';
import { backtestResearchRecordedAt } from '../services/backtestResearchClock';
import { type BacktestAnalyticsRefreshCandidate } from '../services/backtestAnalyticsRefresh';
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
import { createBacktestAnalyticsWorkerClient } from '../services/backtestAnalyticsWorkerClient';
import { createBacktestClosedTradeEmitter } from '../services/backtestClosedTradeEmission';
import type { BacktestClosedTradeIdentity } from '../services/backtestTradeOutbox';
import {
  createBacktestLedgerCursor,
  getBacktestRunOwnerId,
  getBacktestCloudRevision,
  BacktestRunConflictError,
  BacktestRunSyncError,
  withBacktestCloudRevision,
  loadBacktestRunFromCloud,
  saveBacktestRunLocal,
  syncBacktestRunToCloud,
} from '../services/backtestRunService';
import type {
  BacktestClosedTrade,
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
  TICKET_DRAFT_ID,
  ticketDraftChartLines,
  ticketDraftOrder,
  ticketDraftWithBracket,
  type BacktestTicketDraft,
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
  onResolveClosedTrades?: (identities: readonly BacktestClosedTradeIdentity[], signal: AbortSignal) => Promise<{ durableIds: ReadonlySet<string> }>;
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
  onResolveClosedTrades,
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
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
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
  const workerRef = useRef<ReturnType<typeof createBacktestAnalyticsWorkerClient> | null>(null);
  const sessionGenerationRef = useRef(0);
  const sessionAliveRef = useRef(true);
  type ClosedTradeJob = { closed: BacktestClosedTrade; runtime: BacktestRuntimeState; config: BacktestRun['config'] };
  const emitterRef = useRef<ReturnType<typeof createBacktestClosedTradeEmitter<ClosedTradeJob>> | null>(null);
  const emissionCallbacksRef = useRef({ onTradeClosed, onResolveClosedTrades });
  emissionCallbacksRef.current = { onTradeClosed, onResolveClosedTrades };
  const analyticsWorker = useCallback(() => {
    if (!sessionAliveRef.current) throw new DOMException('Session byla zavřena.', 'AbortError');
    const worker = workerRef.current ??= createBacktestAnalyticsWorkerClient({ scopeKey: `${getBacktestRunOwnerId(initialRun)}:${initialRun.id}` });
    const snapshot = candleStore.getSnapshot();
    worker.setSources({ candlesByInstrument: snapshot.candles,
      htfCandlesByInstrument: Object.fromEntries(Object.entries(snapshot.history).map(([root, schemas]) => [root, schemas?.['ohlcv-1h']])) });
    return worker;
  }, [candleStore, initialRun]);
  useEffect(() => {
    sessionAliveRef.current = true;
    return () => {
      sessionAliveRef.current = false;
      sessionGenerationRef.current++;
      emitterRef.current?.dispose(); emitterRef.current = null;
      workerRef.current?.dispose(); workerRef.current = null;
    };
  }, []);
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
      // Local persistence clones the exact snapshot but changes only metadata.
      // Keep its immutable arrays so checkpoint ACKs do not invalidate chart/worker caches.
      // Cloud responses retain their own data, including any server normalization.
      if (!wantsCloud) saved = { ...saved, config: snapshot.config, workspaceState: snapshot.workspaceState, runtimeState: snapshot.runtimeState };
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
    workerRef.current?.setSources({ candlesByInstrument: snapshot.candles,
      htfCandlesByInstrument: Object.fromEntries(Object.entries(snapshot.history).map(([root, schemas]) => [root, schemas?.['ohlcv-1h']])) });
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
    if (!emissionCallbacksRef.current.onTradeClosed || !sessionAliveRef.current || restoringRef.current) return;
    const current = runRef.current;
    if (!emitterRef.current) {
      const generation = sessionGenerationRef.current;
      const isCurrent = () => sessionAliveRef.current && !restoringRef.current && sessionGenerationRef.current === generation;
      emitterRef.current = createBacktestClosedTradeEmitter<ClosedTradeJob>({
        ownerId: getBacktestRunOwnerId(current) ?? '', runId: current.id, accountId: current.accountId, isCurrent,
        identity: ({ closed }) => ({ tradeId: closed.id, runId: closed.runId, accountId: current.accountId, instrument: closed.instrument }),
        preflight: (identities, signal) => emissionCallbacksRef.current.onResolveClosedTrades?.(identities, signal)
          ?? Promise.resolve({ durableIds: new Set<string>() }),
        mapTrade: async ({ closed, runtime: captured, config }, signal) => {
          const mapped = await analyticsWorker().mapClosedTrade(closed, {
            accountId: current.accountId, orderEvents: captured.orderEvents ?? [], timeZone: config.timezone,
            flatTimeZone: config.flatTimeZone, flatByMinute: config.flatByMinute, strategy: config.strategy,
            researchBinding: config.researchBinding, replayHorizonTime: captured.replay.cursorTime ?? closed.exitTime,
            slippageTicks: config.slippageTicks[closed.instrument],
          }, { signal });
          return { ...mapped, recordedAt: backtestResearchRecordedAt(closed, captured.orderEvents ?? []) ?? null };
        },
        persist: trade => {
          if (!isCurrent() || !emissionCallbacksRef.current.onTradeClosed) throw new DOMException('Session byla změněna.', 'AbortError');
          return emissionCallbacksRef.current.onTradeClosed(trade);
        },
      });
    }
    const generation = sessionGenerationRef.current;
    const result = await emitterRef.current.emit(runtime.closedTrades.map(closed => ({ closed, runtime, config: current.config })));
    if (sessionAliveRef.current && generation === sessionGenerationRef.current && !result.cancelled) {
      setJournalQueueError(result.error ? `Zápis obchodu čeká na opakování. ${result.error}` : null);
    }
  }, [analyticsWorker]);

  // Recover closed rows after reopening, and retry failed local enqueue operations.
  useEffect(() => {
    if (loading || !candlesByRoot[run.executionSymbol]?.length) return;
    void emitClosedTrades(runRef.current.runtimeState);
    const timer = window.setInterval(() => void emitClosedTrades(runRef.current.runtimeState), 5_000);
    return () => window.clearInterval(timer);
  }, [loading, candlesByRoot, run.executionSymbol, emitClosedTrades]);

  // Expensive analytics run in bounded batches after UI work. Local durable ACKs
  // advance the planning stamps even while cloud sync is unavailable.
  const sessionJournalTrades = useMemo(() => {
    const ids = new Set(run.runtimeState.closedTrades.map(trade => trade.id));
    return journalTrades.filter(trade => trade.accountId === run.accountId && (trade.backtestRunId === run.id || ids.has(String(trade.id))));
  }, [journalTrades, run.accountId, run.id, run.runtimeState.closedTrades]);
  const refreshInputsRef = useRef({ journalTrades: sessionJournalTrades, analyticsPreview, onTradeAnalyticsRefresh });
  refreshInputsRef.current = { journalTrades: sessionJournalTrades, analyticsPreview, onTradeAnalyticsRefresh };
  const refreshBusyRef = useRef(false);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const refresh = async () => {
      const inputs = refreshInputsRef.current;
      const current = runRef.current;
      const horizon = current.runtimeState.replay.cursorTime;
      if (disposed || refreshBusyRef.current || restoringRef.current || loading || !inputs.onTradeAnalyticsRefresh || horizon === null) return;
      refreshBusyRef.current = true;
      try {
        const generation = sessionGenerationRef.current;
        const trades = inputs.journalTrades.map(trade => {
          const preview = inputs.analyticsPreview[trade.id];
          return preview && preview.stamp.horizonTime <= horizon
            ? { ...trade, backtestAnalyticsRefresh: preview.stamp } : trade;
        });
        const candidates = await analyticsWorker().plan({ trades,
          closedTrades: current.runtimeState.closedTrades,
          replayHorizonTime: horizon, slippageTicks: current.config.slippageTicks,
          mappingOptions: { accountId: current.accountId, orderEvents: current.runtimeState.orderEvents ?? [],
            timeZone: current.config.timezone, flatTimeZone: current.config.flatTimeZone,
            flatByMinute: current.config.flatByMinute, strategy: current.config.strategy }, maxTrades: 4,
        }, { signal: controller.signal });
        if (!candidates.length || disposed || restoringRef.current || generation !== sessionGenerationRef.current
          || (runRef.current.runtimeState.replay.cursorTime ?? -Infinity) < horizon) return;
        await inputs.onTradeAnalyticsRefresh(candidates);
        if (!disposed && !restoringRef.current && generation === sessionGenerationRef.current
          && (runRef.current.runtimeState.replay.cursorTime ?? -Infinity) >= horizon) {
          setAnalyticsPreview(previous => ({ ...previous, ...Object.fromEntries(candidates.map(item => [item.tradeId, item])) }));
          setAnalyticsQueueError(null);
        }
      } catch (reason) {
        if (reason instanceof Error && reason.name === 'AbortError') return;
        if (!disposed) setAnalyticsQueueError(reason instanceof Error ? reason.message : 'Dopočet analýz čeká na opakování.');
      } finally { refreshBusyRef.current = false; }
    };
    const first = window.setTimeout(() => void refresh(), 250);
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => { disposed = true; controller.abort(); window.clearTimeout(first); window.clearInterval(timer); };
  }, [analyticsWorker, loading]);

  const revealedJournalTrades = useMemo(() => sessionJournalTrades.map(trade => {
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
  }), [sessionJournalTrades, analyticsPreview, run.id, run.runtimeState.replay.cursorTime]);

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

  // Množství drží workspace, ne jen obchodní panel: objednávka z pravého kliku
  // do grafu musí použít přesně to číslo, které uživatel vidí vedle typu.
  const [orderQuantity, setOrderQuantity] = useState(run.config.defaultQuantity || 1);
  // Obchodní lišta: typ příkazu a návrh limit/stop čáry v grafu (jen v paměti,
  // do enginu jde až po Buy/Sell — viz ticketDraftChartLines).
  const [ticketType, setTicketType] = useState<BacktestOrderType>('market');
  const [ticketDraft, setTicketDraft] = useState<BacktestTicketDraft | null>(null);
  const ticketDraftRef = useRef(ticketDraft);
  ticketDraftRef.current = ticketDraft;
  /** Poslední odkrytá cena exekučního trhu (pro stranu návrhu). */
  const executionPrice = useCallback((): number | undefined => {
    const current = runRef.current;
    const cursor = current.runtimeState.replay.cursorTime;
    if (cursor === null) return undefined;
    return [...(candlesByRoot[current.executionSymbol] ?? [])].reverse().find(candle => candle.time <= cursor)?.close;
  }, [candlesByRoot]);

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
    if (line.ownerId === TICKET_DRAFT_ID) {
      // Posun vstupu návrhu bere SL/TP s sebou (drží jejich vzdálenost).
      setTicketDraft(draft => {
        if (!draft) return draft;
        if (kind !== 'entry') return ticketDraftWithBracket(draft, kind, executionPrice(), price);
        const delta = price - draft.price;
        return {
          ...draft,
          price,
          stopLoss: draft.stopLoss === undefined ? undefined : draft.stopLoss + delta,
          takeProfit: draft.takeProfit === undefined ? undefined : draft.takeProfit + delta,
        };
      });
      return;
    }
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
  }, [executionPrice, updateRun]);

  const cancelOrderLine = useCallback((line: BacktestChartOrderLine) => {
    if (line.ownerId === TICKET_DRAFT_ID) {
      if (line.kind === 'entry') {
        setTicketDraft(null);
        setTicketType('market');
      } else {
        const field = line.kind;
        setTicketDraft(draft => draft && { ...draft, [field]: undefined });
      }
      return;
    }
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
    if (line.ownerId === TICKET_DRAFT_ID) {
      setTicketDraft(draft => draft && ticketDraftWithBracket(draft, kind, executionPrice(), draggedPrice));
      return;
    }
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
  }, [executionPrice, updateRun]);

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
      ...(ticketDraft ? ticketDraftChartLines(ticketDraft, run.executionSymbol, orderQuantity, currentPrice) : []),
    ];
  }, [candlesByRoot, orderQuantity, run.executionSymbol, run.runtimeState, ticketDraft]);

  /** Typ v liště: limit/stop založí návrh čáry na poslední ceně, market ho zahodí. */
  const changeTicketType = useCallback((type: BacktestOrderType, candle: MarketCandle | null) => {
    setTicketType(type);
    if (type === 'market') { setTicketDraft(null); return; }
    setTicketDraft(draft => {
      if (draft) return { ...draft, type };
      const base = candle?.close ?? executionPrice();
      return Number.isFinite(base) ? { type, price: Math.round(Number(base) * 4) / 4 } : null;
    });
  }, [executionPrice]);

  const submitTicket = useCallback((side: 'buy' | 'sell', candle: MarketCandle | null) => {
    if (ticketType === 'market') return executeOrder({ side, type: 'market', quantity: orderQuantity }, candle);
    const draft = ticketDraftRef.current;
    if (!draft) return null;
    const order = executeOrder({ ...ticketDraftOrder(draft, side, executionPrice()), quantity: orderQuantity }, candle);
    if (order) {
      setTicketDraft(null);
      setTicketType('market');
    }
    return order;
  }, [executeOrder, executionPrice, orderQuantity, ticketType]);

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

  const recalculateTrade = useCallback(async (tradeId: string): Promise<Trade> => {
    const current = runRef.current;
    const closed = current.runtimeState.closedTrades.find(candidate => candidate.id === tradeId);
    if (!closed) throw new Error('Původní replay obchod už v této session není dostupný.');
    const candles = candlesByRoot[closed.instrument] ?? [];
    if (!candles.length) throw new Error(`Pro ${closed.instrument} nejsou načtené replay svíčky.`);
    return analyticsWorker().mapClosedTrade(closed, {
      accountId: current.accountId,
      orderEvents: current.runtimeState.orderEvents ?? [],
      timeZone: current.config.timezone,
      flatTimeZone: current.config.flatTimeZone,
      flatByMinute: current.config.flatByMinute,
      strategy: current.config.strategy,
          researchBinding: current.config.researchBinding,
      replayHorizonTime: current.runtimeState.replay.cursorTime ?? closed.exitTime,
      slippageTicks: current.config.slippageTicks[closed.instrument],
    });
  }, [analyticsWorker, candlesByRoot]);

  const loadEvidence = useCallback(() => {
    const current = runRef.current;
    return buildBacktestStoreEvidence({ snapshot: candleStore.getSnapshot(), run: current, replayHorizonTime: current.runtimeState.replay.cursorTime });
  }, [candleStore]);


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
    maxRevealedTime: run.runtimeState.maxRevealedTime,
    pauseReplayForDialog: evidenceOpen || sessionInfoOpen,
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
        type={ticketType}
        draftPrice={ticketDraft?.price}
        onTypeChange={changeTicketType}
        onSubmit={submitTicket}
        onCancel={cancelOrder}
        onClosePosition={closePosition}
        onChangeBracket={changeBracket}
        onOpenSessionInfo={() => {
          updateRun(current => ({ ...current, runtimeState: { ...current.runtimeState, replay: { ...current.runtimeState.replay, playing: false } } }));
          setSessionInfoOpen(true);
        }}
      />
    ),
  }), [addPositionBracketLine, candleStore, ensureReplayData, candlesByRoot, cancelOrder, cancelOrderLine, changeBracket, changeOrderLine, closePosition, executeOrder, executeQuickOrder, flush, handleReplayChange, handleWorkspaceChange, historyCandlesByRoot, historyLoadingKeys, isDark, revealedJournalTrades, tagSuggestions, loadOlderHistory, managedBoxes, onTradeReviewSave, orderLines, orderQuantity, recalculateTrade, registerWorkspaceCheckpoint, changeTicketType, submitTicket, ticketDraft, ticketType, evidenceOpen, sessionInfoOpen, updateRun, run.config.instruments, run.endAt, run.executionSymbol, run.id, run.runtimeState, run.startAt, run.workspaceState]);

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
    else setSessionInfoOpen(true);
  }, [emitClosedTrades, flush, onClose, updateRun]);

  const restoreCloud = useCallback(async () => {
    try { workspaceCheckpointRef.current?.(); }
    catch (reason) {
      setLocalSaveError(reason instanceof Error ? reason.message : 'Zachycení rozložení selhalo.');
      return;
    }
    updateRun(current => ({ ...current, runtimeState: { ...current.runtimeState, replay: { ...current.runtimeState.replay, playing: false } }, updatedAt: Date.now() }));
    restoringRef.current = true;
    sessionGenerationRef.current++;
    emitterRef.current?.dispose(); emitterRef.current = null;
    workerRef.current?.stop();
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
    <div className={`fixed inset-0 z-[400] flex flex-col items-center justify-center gap-4 ${isDark ? 'bg-[var(--bg-card)] text-white' : 'bg-[var(--bg-card)] text-slate-900'}`}>
      <Loader2 className="animate-spin text-blue-500" size={30} />
      <div className="text-center"><p className="font-black">Načítám backtest session</p><p className="text-xs text-slate-500">MNQ + NQ · první datový segment</p></div>
      <button onClick={() => void closeWorkspace()} className="absolute right-4 top-4 rounded-lg p-2 text-slate-500 hover:bg-slate-500/10"><X size={20} /></button>
    </div>
  );
  if ((error || noData) && initialCandles.length === 0) return (
    <div className={`fixed inset-0 z-[400] flex flex-col items-center justify-center gap-4 p-6 ${isDark ? 'bg-[var(--bg-card)] text-white' : 'bg-[var(--bg-card)] text-slate-900'}`}>
      <p className="max-w-lg text-center text-sm font-bold text-rose-500">{error ?? 'Ve zvoleném období nejsou dostupné svíčky.'}</p>
      <div className="flex gap-2"><button onClick={() => void loadSegment(run.cursorAt ?? run.startAt)} className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-black text-white">Zkusit znovu</button><button onClick={() => void closeWorkspace()} className="rounded-lg border px-4 py-2 text-xs font-black">Zavřít</button></div>
    </div>
  );

  return (
    <>
      {restoring && <div className="fixed inset-0 z-[600] flex items-center justify-center bg-black/60 text-white" role="status">Uchovávám lokální kopii a načítám cloud…</div>}
      {sessionInfoOpen && <div
        className="fixed inset-0 z-[550] flex items-center justify-center bg-black/60 p-4"
        onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') setSessionInfoOpen(false); }}
      >
        <section role="dialog" aria-modal="true" aria-label="Stav session" className={`max-h-[85vh] w-full max-w-md overflow-auto rounded-xl border p-5 text-xs shadow-xl ${isDark ? 'border-[var(--border-subtle)] bg-[var(--bg-card)] text-slate-100' : 'border-[var(--border-subtle)] bg-[var(--bg-card)] text-slate-900'}`}>
          <header className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-bold">Stav session</h2>
            <button autoFocus aria-label="Zavřít stav session" onClick={() => setSessionInfoOpen(false)}><X size={18} /></button>
          </header>
          <p>{saving ? 'Ukládám session…' : localSaveError ? 'Lokální uložení selhalo' : 'Průběžné ukládání do tohoto zařízení'}</p>
          {localSaveError && <p className="text-rose-400">{localSaveError}</p>}
          {cloudSaveError && <p className="mt-1 text-amber-400">{cloudSaveError}</p>}
          {journalQueueError && <p className="mt-1 text-rose-400">{journalQueueError}</p>}
          <button className="pointer-events-auto mt-1 text-violet-400 underline" onClick={() => { updateRun(current => ({ ...current, runtimeState: { ...current.runtimeState, replay: { ...current.runtimeState.replay, playing: false } } })); setSessionInfoOpen(false); setEvidenceOpen(true); }}>Kvalita dat a exekuce</button>
          {run.config.researchBinding && <details className="mt-2"><summary className="cursor-pointer text-violet-300">Pravidla session · {run.config.researchBinding.role === 'validation' ? 'plánované ověření' : 'vývoj'}</summary><p className="mt-1 whitespace-pre-wrap">{run.config.researchBinding.definition.rule}</p><p className="mt-1">Vyvrácení: {run.config.researchBinding.definition.falsification}</p><p className="mt-1 break-all text-slate-400">Verze {run.config.researchBinding.revisionId} · {run.config.researchBinding.revisionHash}</p><p className="mt-1 text-amber-400">{run.config.researchBinding.exposureAtBinding === 'already-observed' ? 'Toto období už bylo pozorované.' : 'Úplná nepozorovanost období není potvrzená.'}</p></details>}
          {analyticsQueueError && <p className="mt-1 text-amber-400">{analyticsQueueError}</p>}
          {analyticsSyncState?.pending ? <p className="mt-1 text-amber-400">Analýzy: {analyticsSyncState.pending} dopočtů čeká na cloud.</p> : null}
          {analyticsSyncState?.error && <p className="mt-1 text-amber-400">{analyticsSyncState.error}</p>}
          {journalSyncState?.pending ? <p className="mt-1 text-amber-400">Deník: {journalSyncState.pending} obchodů čeká na cloud.</p> : null}
          {journalSyncState?.error && <p className="mt-1 text-amber-400">{journalSyncState.error}</p>}
          {(localSaveError || (cloudSaveError && !cloudConflict)) && <button className="mt-1 font-bold text-blue-400" onClick={() => void flush({ cloud: true })}>Zkusit uložení znovu</button>}
          {cloudConflict && <button disabled={restoring} className="mt-1 font-bold text-blue-400" onClick={() => void restoreCloud()}>{restoring ? 'Načítám…' : 'Uchovat lokální kopii a načíst cloud'}</button>}
        </section>
      </div>}
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
  type: BacktestOrderType;
  /** Cena návrhu limit/stop čáry v grafu. */
  draftPrice?: number;
  onTypeChange: (type: BacktestOrderType, candle: MarketCandle | null) => void;
  onSubmit: (side: 'buy' | 'sell', candle: MarketCandle | null) => unknown;
  onCancel: (id: string, candle: MarketCandle | null) => void;
  onClosePosition: (quantity: number, candle: MarketCandle | null) => void;
  onChangeBracket: (stopLoss?: number, takeProfit?: number) => void;
  onOpenSessionInfo: () => void;
}

const BacktestTradingPanel: React.FC<TradingPanelProps> = ({ run, candle, isDark, quantity, onQuantityChange, type, draftPrice, onTypeChange, onSubmit, onCancel, onClosePosition, onOpenSessionInfo }) => {
  const [orderError, setOrderError] = useState<string | null>(null);
  const runtime = run.runtimeState;
  const position = runtime.positions.find(item => item.instrument === run.executionSymbol);
  const pending = runtime.orders.filter(order => order.status === 'pending');
  const field = `h-7 rounded-md border px-2 text-[11px] tabular-nums outline-none transition-colors focus:border-blue-500/70 ${isDark
    ? 'border-white/10 bg-white/[0.04] text-white placeholder:text-slate-500 hover:border-white/20'
    : 'border-slate-200 bg-slate-50 text-slate-900 placeholder:text-slate-400 hover:border-slate-300'}`;
  const divider = `h-6 w-px shrink-0 ${isDark ? 'bg-white/10' : 'bg-slate-200'}`;
  const submit = (side: 'buy' | 'sell') => {
    if (!Number.isFinite(quantity) || quantity < 1) {
      setOrderError('Zadej platný počet kontraktů.');
      return;
    }
    if (type !== 'market' && draftPrice === undefined) {
      setOrderError('Nejdřív umísti čáru příkazu v grafu.');
      return;
    }
    setOrderError(null);
    onSubmit(side, candle);
  };
  const money = (value: number, signed = false) => `${signed && value >= 0.005 ? '+' : value <= -0.005 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const priceText = (value: number | undefined) => value === undefined ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pnlTone = (value: number) => value > 0 ? 'text-emerald-500' : value < 0 ? 'text-rose-500' : '';
  const stat = (label: string, value: string, tone = '') => (
    <div className="flex shrink-0 flex-col justify-center leading-none">
      <span className="text-[8.5px] font-bold uppercase tracking-[0.08em] text-slate-500">{label}</span>
      <b className={`mt-[3px] font-mono text-[11.5px] font-semibold tabular-nums ${tone}`}>{value}</b>
    </div>
  );
  const typeLabels: Record<BacktestOrderType, string> = { market: 'Mkt', limit: 'Lmt', stop: 'Stp' };
  // Zadání příkazu: pole se štítkem uvnitř jednoho rámečku (jako ticket v platformě).
  const group = `flex h-7 items-center overflow-hidden rounded-md border transition-colors focus-within:border-blue-500/70 ${isDark
    ? 'border-white/10 bg-white/[0.04] hover:border-white/20'
    : 'border-slate-200 bg-slate-50 hover:border-slate-300'}`;
  const bare = `h-full bg-transparent px-1.5 text-[11px] tabular-nums outline-none ${isDark ? 'text-white placeholder:text-slate-600' : 'text-slate-900 placeholder:text-slate-400'}`;
  const stepButton = `flex h-full w-6 items-center justify-center text-[13px] font-bold transition-colors disabled:opacity-30 ${isDark ? 'text-slate-400 hover:bg-white/[0.07] hover:text-white' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-900'}`;
  const sideButton = 'flex h-7 min-w-[92px] items-center justify-center gap-1.5 rounded-md px-2.5 text-[11px] font-black uppercase tracking-wide text-white transition hover:brightness-110 active:translate-y-px active:brightness-95 disabled:opacity-40';
  // Market se plní za poslední cenu; limit/stop za zadanou.
  const ticketPrice = type === 'market' ? priceText(candle?.close) : priceText(draftPrice);
  return (
    // Jeden řádek (44 px) — víc místa pro graf. Pořadí: zadání příkazu → účet → pozice → čekající příkazy.
    <div className="relative flex h-full items-center gap-3 px-3 text-[11px]">
      {orderError && <span role="alert" className="pointer-events-none absolute bottom-full left-3 mb-1.5 rounded-md bg-rose-600 px-2 py-1 text-[10.5px] font-bold text-white shadow-lg">{orderError}</span>}
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto [scrollbar-width:thin]">
      <div className={`flex shrink-0 items-center rounded-lg p-0.5 ${isDark ? 'bg-white/[0.05] ring-1 ring-inset ring-white/[0.06]' : 'bg-slate-100 ring-1 ring-inset ring-slate-200'}`} role="radiogroup" aria-label="Typ objednávky">
        {(['market', 'limit', 'stop'] as const).map(option => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={type === option}
            onClick={() => { setOrderError(null); onTypeChange(option, candle); }}
            title={option === 'market' ? 'Market' : option === 'limit' ? 'Limit' : 'Stop'}
            className={`h-6 rounded-md px-2.5 text-[10.5px] font-bold transition-colors ${type === option
              ? isDark ? 'bg-white/[0.14] text-white shadow-[0_1px_2px_rgba(0,0,0,.35)]' : 'bg-white text-slate-900 shadow-sm'
              : isDark ? 'text-slate-500 hover:text-slate-200' : 'text-slate-500 hover:text-slate-800'}`}
          >{typeLabels[option]}</button>
        ))}
      </div>
      {/* Počet kontraktů: − / číslo / + v jednom poli. */}
      <div className={`${group} shrink-0`} title="Počet kontraktů — použije se i pro objednávku z pravého kliku do grafu">
        <button type="button" onClick={() => onQuantityChange(Math.max(1, quantity - 1))} disabled={quantity <= 1} className={stepButton} aria-label="Ubrat kontrakt">−</button>
        <input type="number" min={1} value={quantity} onChange={event => onQuantityChange(Math.max(1, Number(event.target.value) || 1))} className={`${bare} w-8 text-center font-bold [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`} aria-label="Počet kontraktů" />
        <button type="button" onClick={() => onQuantityChange(quantity + 1)} className={stepButton} aria-label="Přidat kontrakt">+</button>
      </div>
      {type !== 'market' && (
        <span className="shrink-0 text-[10px] font-semibold text-violet-400" title="Návrh příkazu je fialová čára v grafu — posuň ji na cenu, SL/TP přidáš tlačítky na ní">
          Posuň čáru v grafu{draftPrice !== undefined ? ` · ${priceText(draftPrice)}` : ''}
        </span>
      )}
      <div className="flex shrink-0 items-center gap-1">
        <button type="button" onClick={() => submit('buy')} disabled={!candle} className={`${sideButton} bg-gradient-to-b from-emerald-500 to-emerald-600 shadow-[0_1px_0_rgba(255,255,255,.2)_inset,0_6px_16px_-8px_rgba(16,185,129,.8)]`}>
          <span>Buy</span>
          <span className="font-mono text-[10px] font-semibold opacity-80">{ticketPrice}</span>
        </button>
        <button type="button" onClick={() => submit('sell')} disabled={!candle} className={`${sideButton} bg-gradient-to-b from-rose-500 to-rose-600 shadow-[0_1px_0_rgba(255,255,255,.2)_inset,0_6px_16px_-8px_rgba(244,63,94,.8)]`}>
          <span>Sell</span>
          <span className="font-mono text-[10px] font-semibold opacity-80">{ticketPrice}</span>
        </button>
      </div>
      <div className={divider} />
      <div className="flex shrink-0 items-center gap-4">
        {stat('Balance', money(runtime.balance))}
        {stat('Equity', money(runtime.equity))}
        {stat('Realized', money(runtime.realizedPnl, true), pnlTone(runtime.realizedPnl))}
        {stat('Open', money(runtime.unrealizedPnl, true), pnlTone(runtime.unrealizedPnl))}
      </div>
      {position && <>
        <div className={divider} />
        <div className="flex shrink-0 items-center gap-1.5">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${position.side === 'long' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/15 text-rose-500'}`}>{position.side === 'long' ? 'LONG' : 'SHORT'} {position.quantity}×</span>
          <span className="font-mono tabular-nums text-slate-400">@ {priceText(position.averagePrice)}</span>
          {position.quantity > 1 && <button type="button" onClick={() => onClosePosition(Math.floor(position.quantity / 2), candle)} className={`${field} font-bold`} title="Zavřít polovinu pozice">½</button>}
          <button type="button" onClick={() => onClosePosition(position.quantity, candle)} className={`h-7 rounded-md px-2.5 text-[10.5px] font-black transition-colors ${isDark ? 'bg-white/10 text-white hover:bg-white/15' : 'bg-slate-800 text-white hover:bg-slate-700'}`}>Zavřít</button>
        </div>
      </>}
      {pending.length > 0 && <>
        <div className={divider} />
        <div className="flex shrink-0 items-center gap-1">
          {pending.slice(0, 3).map(order => (
            <span key={order.id} className={`inline-flex h-6 items-center gap-1 rounded-md border pl-2 pr-1 text-[10px] font-bold ${isDark ? 'border-white/10 bg-white/[0.04]' : 'border-slate-200 bg-slate-50'}`}>
              <span className={order.side === 'buy' ? 'text-emerald-500' : 'text-rose-500'}>{order.side === 'buy' ? 'B' : 'S'} {order.quantity}</span>
              <span className="text-slate-500">{typeLabels[order.type]}</span>
              <span className="font-mono tabular-nums">{priceText(order.limitPrice ?? order.stopPrice)}</span>
              <button type="button" onClick={() => onCancel(order.id, candle)} className="ml-0.5 rounded px-1 text-slate-500 hover:bg-rose-500/15 hover:text-rose-500" aria-label="Zrušit objednávku" title="Zrušit objednávku">×</button>
            </span>
          ))}
          {pending.length > 3 && <span className="text-[10px] font-bold text-slate-500">+{pending.length - 3}</span>}
        </div>
      </>}
      </div>
      <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
        <span className="font-mono text-[11px] tabular-nums text-slate-400">{candle ? <><span className="font-sans font-bold text-slate-500">{run.executionSymbol}</span> {priceText(candle.close)}</> : 'Bez ceny'}</span>
        <button type="button" onClick={onOpenSessionInfo} className="h-7 rounded-md px-2 text-[10.5px] font-bold text-slate-500 transition-colors hover:bg-slate-500/10 hover:text-blue-500">Stav session</button>
      </div>
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
