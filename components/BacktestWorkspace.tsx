import BacktestEvidenceDialog from './BacktestEvidenceDialog';
import { buildBacktestStoreEvidence } from '../services/backtestStoreEvidence';
import { backtestResearchRecordedAt } from '../services/backtestResearchClock';
import { type BacktestAnalyticsRefreshCandidate } from '../services/backtestAnalyticsRefresh';
import { buildBacktestTradeRecalculationUpdates } from '../services/backtestTradeRecalculation';
import type { BacktestTagSuggestions } from '../services/backtestTagCatalog';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2, PanelRightClose, PanelRightOpen, X } from 'lucide-react';
import type { Trade } from '../types';
import AlphaTradeChartWorkspace, { type BacktestChartSessionBridge, type MarketRoot } from './AlphaTradeChartWorkspace';
import BacktestOrderTicket, { type BacktestTicketSubmitResult } from './BacktestOrderTicket';
import LiveTradeToasts from './LiveTradeToasts';
import { formatUsd } from './LiveOrderTicket';
import {
  LIVE_DRAFT_ID,
  clickedOrderType,
  liveDraftChartLines,
  newTicketDraft,
  snapToTick,
  ticketQuantity,
  withBracket,
  withEntryPrice,
  type TicketBracketUnits,
  type TicketDraft,
  type TicketSide,
} from '../lib/liveOrderTicket';
import {
  BACKTEST_BREAK_EVEN_ACTION,
  backtestBreakEven,
  backtestPositionSummary,
  backtestRuntimeToasts,
  backtestSubmitDraft,
  backtestTicketInstrument,
  backtestTicketQuote,
  seedBacktestToastSeen,
  shiftDraftBrackets,
  withBacktestLineControls,
  type BacktestPositionSummary,
} from '../lib/backtestChartTrading';
import type { TradeToast } from '../lib/liveTradeToasts';
import { readTradeChartIndicators } from '../services/detailIndicators';
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
import { applyBacktestRewind, planBacktestRewind, type BacktestRewindPlan } from '../services/backtestRewind';
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
  type BacktestChartOrderLine,
  type BacktestChartOrderLineKind,
} from '../services/backtestOrderLines';

/** Panel Objednávka otevřený / zavřený — pamatuje si ho prohlížeč (jen pohodlí). */
const TICKET_OPEN_KEY = 'alphatrade:backtest-ticket-open';
const readTicketOpen = () => {
  try { return window.localStorage.getItem(TICKET_OPEN_KEY) === '1'; } catch { return false; }
};

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
  /** Návrat replaye smazal tyto obchody — pryč z deníku i z front. */
  onTradesDiscarded?: (tradeIds: string[]) => Promise<void>;
  /**
   * Dočasná session (slepé hodnocení): vložený graf, nic se neukládá ani nejde do
   * deníku. `replayStopAt` zastaví replay, callbacky hlásí kurzor a rozložení.
   */
  scratch?: {
    replayStopAt?: number;
    onReplay?: (replay: ChartReplayState) => void;
    onWorkspaceState?: (state: BacktestWorkspaceState) => void;
  };
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
  onTradesDiscarded,
  scratch,
}) => {
  const scratchRef = useRef(scratch);
  scratchRef.current = scratch;
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
    if (scratchRef.current) {
      dirtyRef.current = false;
      cloudDirtyRef.current = false;
      return Promise.resolve(true);
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
    scratchRef.current?.onReplay?.(replay);
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
    scratchRef.current?.onWorkspaceState?.(workspaceState);
  }, [updateRun]);

  // Panel Objednávka jako v LIVE: návrh (vstup, SL, TP) žije jen v paměti a do
  // enginu jde až velkým tlačítkem. Pravý klik do grafu ho jen vyplní.
  const instrument = useMemo(() => backtestTicketInstrument(run.executionSymbol), [run.executionSymbol]);
  // Indikátory jako LIVE a deník (FVG, levely vč. VWAP, struktura) — jen start
  // nové session / nového panelu; uložené panely session si drží svůj stav.
  const [startIndicators] = useState(readTradeChartIndicators);
  const [ticketOpen, setTicketOpenState] = useState(readTicketOpen);
  const setTicketOpen = useCallback((open: boolean) => {
    setTicketOpenState(open);
    try { window.localStorage.setItem(TICKET_OPEN_KEY, open ? '1' : '0'); } catch { /* jen pohodlí */ }
  }, []);
  const [draft, setDraft] = useState<TicketDraft | null>(null);
  const [units, setUnits] = useState<TicketBracketUnits>('pts');
  // Velikost dalšího návrhu (pravý klik, Koupit/Prodat) = poslední použitá.
  const sizingRef = useRef<Pick<TicketDraft, 'sizing' | 'quantity' | 'riskUsd'>>({ sizing: 'qty', quantity: run.config.defaultQuantity || 1, riskUsd: 200 });
  useEffect(() => {
    if (draft) sizingRef.current = { sizing: draft.sizing, quantity: draft.quantity, riskUsd: draft.riskUsd };
  }, [draft]);
  /** Svíčka exekučního trhu pod kurzorem replaye (čerstvá i mezi překresleními). */
  const executionCandle = useCallback((): MarketCandle | null => {
    const current = runRef.current;
    const cursor = current.runtimeState.replay.cursorTime;
    if (cursor === null) return null;
    const candles = candlesByRoot[current.executionSymbol] ?? [];
    const index = candleIndexAfter(candles, cursor) - 1;
    return index >= 0 ? candles[index] : null;
  }, [candlesByRoot]);
  /** Poslední odkrytá svíčka exekučního trhu (panel, návrh, štítky, BE). */
  const markCandle = useMemo(() => {
    const cursor = run.runtimeState.replay.cursorTime;
    if (cursor === null) return null;
    const candles = candlesByRoot[run.executionSymbol] ?? [];
    const index = candleIndexAfter(candles, cursor) - 1;
    return index >= 0 ? candles[index] : null;
  }, [candlesByRoot, run.executionSymbol, run.runtimeState.replay.cursorTime]);
  const markPrice = markCandle?.close ?? null;
  const quote = useMemo(() => backtestTicketQuote(markPrice), [markPrice]);
  const quoteRef = useRef(quote);
  quoteRef.current = quote;
  // Market: SL a TP jedou s cenou replaye (drží nastavenou vzdálenost od vstupu).
  const marketEntryRef = useRef<number | null>(null);
  useEffect(() => {
    if (!quote || draft?.type !== 'market') { marketEntryRef.current = null; return; }
    const previous = marketEntryRef.current;
    marketEntryRef.current = quote.ask;
    if (previous == null || previous === quote.ask) return;
    const delta = quote.ask - previous;
    setDraft(current => (current && current.type === 'market' && (current.stopLoss != null || current.takeProfit != null)
      ? shiftDraftBrackets(current, delta, instrument.tickSize)
      : current));
  }, [draft?.type, instrument.tickSize, quote]);
  // Nový start replaye: návrh na staré absolutní ceně by tam nedával smysl.
  const replayStartTime = run.runtimeState.replay.startTime;
  useEffect(() => { setDraft(null); }, [replayStartTime]);
  // Hlášky štítků (BE nejde, …) nahoře nad grafem jako v LIVE.
  const [lineNotice, setLineNotice] = useState<{ tone: 'ok' | 'bad'; text: string; at: number } | null>(null);
  useEffect(() => {
    if (!lineNotice) return undefined;
    const timer = window.setTimeout(() => setLineNotice(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [lineNotice]);
  // Karty obchodů vlevo dole: nové události enginu od otevření session.
  const [toastSeen] = useState(() => seedBacktestToastSeen(initialRun.runtimeState));
  const [toasts, setToasts] = useState<TradeToast[]>([]);
  const { orders: runtimeOrders, fills: runtimeFills, closedTrades: runtimeClosedTrades } = run.runtimeState;
  useEffect(() => {
    const fresh = backtestRuntimeToasts({ orders: runtimeOrders, fills: runtimeFills, closedTrades: runtimeClosedTrades }, toastSeen);
    if (fresh.length) setToasts(fresh);
  }, [runtimeOrders, runtimeFills, runtimeClosedTrades, toastSeen]);

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

  const changeOrderLine = useCallback((line: BacktestChartOrderLine, kind: BacktestChartOrderLineKind, price: number) => {
    if (line.ownerId === LIVE_DRAFT_ID) {
      // Návrh panelu stejně jako v LIVE: vstup se posouvá sám, SL/TP na tick.
      setDraft(previous => {
        if (!previous) return previous;
        if (kind === 'entry') return withEntryPrice(previous, price, instrument);
        const snapped = snapToTick(price, instrument.tickSize);
        return kind === 'stopLoss' ? { ...previous, stopLoss: snapped } : { ...previous, takeProfit: snapped };
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
  }, [instrument, updateRun]);

  const cancelOrderLine = useCallback((line: BacktestChartOrderLine) => {
    if (line.ownerId === LIVE_DRAFT_ID) {
      if (line.kind === 'entry') setDraft(null);
      else setDraft(previous => (previous ? (line.kind === 'stopLoss' ? { ...previous, stopLoss: null } : { ...previous, takeProfit: null }) : previous));
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
    if (line.ownerId === LIVE_DRAFT_ID) {
      const current = quoteRef.current;
      if (current) setDraft(previous => (previous ? withBracket(previous, kind === 'stopLoss' ? 'sl' : 'tp', instrument, current, draggedPrice) : previous));
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
  }, [instrument, updateRun]);

  const orderLines = useMemo(() => {
    const runtime = run.runtimeState;
    const currentPrice = markPrice ?? undefined;
    const engineLines = [
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
    return [
      ...withBacktestLineControls(engineLines, runtime.positions, markPrice, LIVE_DRAFT_ID),
      // Návrh jen s otevřeným panelem (jako LIVE) — schovaný panel nenechá v grafu fialové čáry.
      ...(draft && quote && ticketOpen ? liveDraftChartLines(draft, instrument, quote) : []),
    ];
  }, [draft, instrument, markPrice, quote, run.executionSymbol, run.runtimeState, ticketOpen]);

  const positionSummary = useMemo(() => {
    const position = run.runtimeState.positions.find(item => item.instrument === run.executionSymbol);
    return position ? backtestPositionSummary(position, markPrice) : null;
  }, [markPrice, run.executionSymbol, run.runtimeState.positions]);
  // Pravý klik do grafu ukazuje stejný počet kontraktů jako návrh v panelu.
  const chartOrderQuantity = draft && quote ? Math.max(1, ticketQuantity(draft, instrument, quote)) : sizingRef.current.quantity;

  /** BE ve štítku pozice: SL na průměrný vstup, jen když už je cena za ním. */
  const orderLineAction = useCallback((line: BacktestChartOrderLine, actionId: string) => {
    if (actionId !== BACKTEST_BREAK_EVEN_ACTION || line.ownerType !== 'position') return;
    const current = runRef.current;
    const position = current.runtimeState.positions.find(item => item.instrument === line.ownerId);
    if (!position) return;
    const be = backtestBreakEven(position, executionCandle()?.close, instrument.tickSize);
    if (be.blocked || be.price == null) { setLineNotice({ at: Date.now(), tone: 'bad', text: be.blocked ?? 'BE teď nejde.' }); return; }
    const price = be.price;
    updateRun(runState => ({
      ...runState,
      runtimeState: updatePositionBracket(
        runState.runtimeState,
        position.instrument,
        price,
        position.takeProfit,
        runState.runtimeState.replay.cursorTime ?? Math.floor(Date.now() / 1_000),
        Date.now(),
      ),
      updatedAt: Date.now(),
    }));
    const at = (current.runtimeState.replay.cursorTime ?? Math.floor(Date.now() / 1_000)) * 1_000;
    setToasts([{ id: `be:${position.instrument}:${Date.now()}`, at, tone: 'amber', badge: 'BE', title: 'SL na break-even', line: `SL → ${price.toFixed(2)}`, pnl: null, accounts: 0, sticky: false }]);
  }, [executionCandle, instrument.tickSize, updateRun]);

  /** Velké tlačítko panelu: návrh do enginu (Market hned za závěr svíčky, Limit/Stop čekají). */
  const submitTicket = useCallback((next: TicketDraft): BacktestTicketSubmitResult => {
    const candle = executionCandle();
    const current = backtestTicketQuote(candle?.close);
    if (!candle || !current) return { ok: false, text: 'Neodesláno: replay nemá cenu — spusť přehrávání.' };
    // Panel ukazuje cenu posledního překreslení; engine plní za čerstvý závěr svíčky.
    const prepared = backtestSubmitDraft(next, quoteRef.current, current, instrument);
    if (prepared.blocked) return { ok: false, text: `Neodesláno: ${prepared.blocked}` };
    const { quantity } = prepared;
    if (quantity < 1) return { ok: false, text: 'Neodesláno: riziko nestačí ani na 1 kontrakt.' };
    let orderId: string;
    try {
      const order = executeOrder({
        side: next.side,
        type: next.type,
        quantity,
        price: next.type === 'market' ? undefined : next.price,
        stopLoss: prepared.draft.stopLoss ?? undefined,
        takeProfit: prepared.draft.takeProfit ?? undefined,
      }, candle);
      if (!order) return { ok: false, text: 'Neodesláno: obchodovat jde až od začátku replay session.' };
      orderId = order.id;
    } catch (reason) {
      return { ok: false, text: `Neodesláno: ${reason instanceof Error ? reason.message : 'příkaz se nepodařilo vytvořit.'}` };
    }
    // Engine Market v čase flat session (konec dne) zruší — „Vyplněno“ jen po skutečném plnění.
    const status = runRef.current.runtimeState.orders.find(order => order.id === orderId)?.status;
    if (next.type === 'market' && status !== 'filled') return { ok: false, text: 'Nevyplněno: v tomhle čase session obchod neotevře (flat / konec dne).' };
    const action = `${next.side === 'buy' ? 'Koupit' : 'Prodat'} ${quantity} ${instrument.symbol}`;
    return { ok: true, text: next.type === 'market' ? `Vyplněno · ${action}` : `Zadáno · ${action} ${next.type === 'limit' ? 'LMT' : 'STP'}` };
  }, [executeOrder, executionCandle, instrument]);

  /** Nový návrh (Koupit/Prodat v panelu, pravý klik do grafu) s poslední velikostí. */
  const startDraft = useCallback((side: TicketSide, type: TicketDraft['type'], price: number | undefined, quantity?: number) => {
    const current = quoteRef.current;
    if (!current) return;
    // Typ podle ceny replaye, ne podle viditelné svíčky (odscrollovaná historie).
    const resolved = price != null ? clickedOrderType(side, snapToTick(price, instrument.tickSize), current, instrument.tickSize) : type;
    const base = sizingRef.current;
    setDraft(newTicketDraft(side, resolved, price ?? (side === 'buy' ? current.ask - 10 : current.bid + 10), instrument, current, {
      sizing: base.sizing,
      quantity: quantity ?? base.quantity,
      riskUsd: base.riskUsd,
    }));
    setTicketOpen(true);
  }, [instrument, setTicketOpen]);

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


  // Nůžky před vzatým obchodem: dotaz, co se smaže, a po potvrzení návrat.
  const [rewindRequest, setRewindRequest] = useState<{ plan: BacktestRewindPlan; resolve: (confirmed: boolean) => void } | null>(null);
  const applyRewind = useCallback((plan: BacktestRewindPlan) => {
    updateRun(current => ({
      ...current,
      cursorAt: plan.targetTime * 1_000,
      runtimeState: applyBacktestRewind(current.runtimeState, plan, current.initialCapital),
      updatedAt: Date.now(),
    }));
    lastProcessedCursorRef.current = plan.targetTime;
    setDraft(null);
    const removedIds = plan.removedTrades.map(trade => trade.id);
    if (removedIds.length && onTradesDiscarded) {
      void onTradesDiscarded(removedIds).catch(reason => {
        setError(reason instanceof Error ? `Smazané obchody se nepodařilo odebrat z deníku: ${reason.message}` : 'Smazané obchody se nepodařilo odebrat z deníku.');
      });
    }
    // Smazané obchody hned do cloudu; obyčejný krok zpět stačí uložit lokálně.
    void flush(removedIds.length || plan.removedPositions.length || plan.removedOrderIds.length ? { cloud: true } : undefined);
  }, [flush, onTradesDiscarded, updateRun]);
  const requestRewind = useCallback((targetTime: number) => new Promise<boolean>(resolve => {
    const plan = planBacktestRewind(runRef.current.runtimeState, targetTime);
    if (plan.empty) {
      applyRewind(plan);
      resolve(true);
      return;
    }
    setRewindRequest(current => {
      current?.resolve(false);
      return { plan, resolve };
    });
  }), [applyRewind]);

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
    replayStopAt: scratch?.replayStopAt,
    onWorkspaceChange: handleWorkspaceChange,
    registerWorkspaceCheckpoint,
    maxRevealedTime: run.runtimeState.maxRevealedTime,
    pauseReplayForDialog: evidenceOpen || sessionInfoOpen || rewindRequest !== null,
    onSaveWorkspace: async () => ({ localSaved: await flush({ cloud: true }), cloudSaved: !cloudDirtyRef.current && !conflictRef.current }),
    onQuickOrder: ({ drawing, candle, instrument }) => executeQuickOrder(drawing, candle, instrument),
    chartOrderQuantity,
    // Pravý klik do grafu jen vyplní panel Objednávka (jako LIVE); odeslání je tlačítkem panelu.
    onChartOrder: input => startDraft(input.side, input.type, input.price, input.quantity),
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
    onOrderLineAction: orderLineAction,
    onRequestRewind: onTradesDiscarded ? requestRewind : undefined,
    renderTradingPanel: ({ candle }) => (
      <BacktestTradingPanel
        run={runRef.current}
        candle={candle}
        isDark={isDark}
        ticketOpen={ticketOpen}
        onToggleTicket={() => setTicketOpen(!ticketOpen)}
        position={positionSummary}
        onCancel={cancelOrder}
        onClosePosition={closePosition}
        onOpenSessionInfo={() => {
          updateRun(current => ({ ...current, runtimeState: { ...current.runtimeState, replay: { ...current.runtimeState.replay, playing: false } } }));
          setSessionInfoOpen(true);
        }}
      />
    ),
    // Zavřený panel zůstává připojený (bez šířky, inert) kvůli plynulé animaci — jako LIVE.
    renderTradingDock: () => (
      <div className={`live-chart-ticket-dock ${ticketOpen ? 'is-open' : ''}`} inert={!ticketOpen} aria-hidden={!ticketOpen || undefined}>
        <aside data-bt-ticket="" className="live-chart-ticket h-full w-[304px]">
          <BacktestOrderTicket
            isDark={isDark}
            instrument={instrument}
            quote={quote}
            quoteTime={markCandle?.time ?? null}
            timeZone={run.config.timezone || 'Europe/Prague'}
            draft={draft}
            onDraft={setDraft}
            units={units}
            onUnits={setUnits}
            sessionName={run.name}
            balance={run.runtimeState.balance}
            equity={run.runtimeState.equity}
            position={positionSummary}
            onSubmit={submitTicket}
            onNewDraft={side => startDraft(side, 'limit', quote ? (side === 'buy' ? quote.ask - 10 : quote.bid + 10) : undefined)}
            onClose={() => setTicketOpen(false)}
          />
        </aside>
      </div>
    ),
    renderChartOverlay: () => (
      <>
        {lineNotice && <div role="status" className={`pointer-events-none absolute left-1/2 top-11 z-[700] max-w-[440px] -translate-x-1/2 rounded-lg border px-3 py-1.5 text-[11.5px] font-bold shadow-lg ${lineNotice.tone === 'ok'
          ? 'border-emerald-500/40 bg-emerald-950/90 text-emerald-200'
          : 'border-rose-500/40 bg-rose-950/90 text-rose-200'}`}>{lineNotice.text}</div>}
        {/* Nad lištou stavu a obchodní lištou, vpravo od lišty kreslení. */}
        <LiveTradeToasts events={undefined} copierArmed={false} isDark={isDark} extra={toasts} placement={{ left: 68, bottom: 84 }} />
      </>
    ),
  }), [scratch?.replayStopAt, addPositionBracketLine, candleStore, ensureReplayData, candlesByRoot, cancelOrder, cancelOrderLine, changeOrderLine, chartOrderQuantity, closePosition, draft, executeQuickOrder, flush, handleReplayChange, handleWorkspaceChange, historyCandlesByRoot, historyLoadingKeys, instrument, isDark, lineNotice, markCandle?.time, revealedJournalTrades, tagSuggestions, loadOlderHistory, managedBoxes, onTradeReviewSave, orderLineAction, orderLines, positionSummary, quote, recalculateTrade, registerWorkspaceCheckpoint, setTicketOpen, startDraft, submitTicket, ticketOpen, toasts, units, onTradesDiscarded, requestRewind, evidenceOpen, sessionInfoOpen, rewindRequest, updateRun, run.config.instruments, run.config.timezone, run.endAt, run.executionSymbol, run.id, run.name, run.runtimeState, run.startAt, run.workspaceState]);

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
        tradeIndicators={startIndicators}
        embedded={Boolean(scratch)}
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
      {rewindRequest && (() => {
        const { plan, resolve } = rewindRequest;
        const close = (confirmed: boolean) => {
          setRewindRequest(null);
          if (confirmed) applyRewind(plan);
          resolve(confirmed);
        };
        const time = (seconds: number) => new Date(seconds * 1_000).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', timeZone: run.config.timezone || 'Europe/Prague' });
        const day = (seconds: number) => new Date(seconds * 1_000).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', timeZone: run.config.timezone || 'Europe/Prague' });
        const total = plan.removedTrades.reduce((sum, trade) => sum + trade.pnl, 0);
        const money = (value: number) => `${value >= 0 ? '+' : '−'}$${Math.abs(value).toFixed(2)}`;
        return (
          <div className="fixed inset-0 z-[950] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-[2px]" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close(false); }}>
            <section role="alertdialog" aria-modal="true" aria-labelledby="backtest-rewind-title" className={`w-full max-w-md overflow-hidden rounded-xl border shadow-2xl ${isDark ? 'border-white/10 bg-[#10161f] text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}>
              <div className="px-5 pt-5">
                <h2 id="backtest-rewind-title" className="text-base font-black">Vrátit replay na {day(plan.targetTime)} {time(plan.targetTime)}?</h2>
                <p className="mt-1.5 text-[12.5px] text-slate-500">Po tomhle čase už byl vzatý obchod. Je to backtest — obchody, které by v novém čase ještě neproběhly, se smažou ze session i z deníku.</p>
              </div>
              <div className="mx-5 mt-4 max-h-56 overflow-y-auto rounded-lg border border-[var(--border-subtle)]">
                {plan.removedTrades.map(trade => (
                  <div key={trade.id} className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-3 py-2 text-[12px] last:border-b-0">
                    <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-black ${trade.direction === 'Long' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/15 text-rose-500'}`}>{trade.direction}</span>
                    <span className="font-mono tabular-nums text-slate-400">{time(trade.entryTime)} → {time(trade.exitTime)}</span>
                    <span className={`ml-auto font-mono font-semibold tabular-nums ${trade.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{money(trade.pnl)}</span>
                  </div>
                ))}
                {plan.removedPositions.length > 0 && <div className="px-3 py-2 text-[12px] font-semibold text-amber-500">+ otevřená pozice se zavře bez obchodu</div>}
                {plan.removedOrderIds.length > 0 && plan.removedTrades.length === 0 && plan.removedPositions.length === 0 && <div className="px-3 py-2 text-[12px] text-slate-500">Zruší se {plan.removedOrderIds.length} příkaz(y) zadané po tomto čase.</div>}
              </div>
              {plan.removedTrades.length > 0 && <p className="mx-5 mt-2 text-right text-[11.5px] text-slate-500">Celkem {money(total)} · zůstatek se přepočítá</p>}
              <div className="mt-4 flex justify-end gap-2 border-t border-[var(--border-subtle)] px-5 py-3">
                <button type="button" autoFocus onClick={() => close(false)} className={`h-9 rounded-lg px-4 text-xs font-black ${isDark ? 'hover:bg-white/10' : 'hover:bg-slate-100'}`}>Zrušit</button>
                <button type="button" onClick={() => close(true)} className="h-9 rounded-lg bg-rose-600 px-4 text-xs font-black text-white hover:bg-rose-500">
                  {plan.removedTrades.length ? `Vrátit a smazat ${plan.removedTrades.length} ${plan.removedTrades.length === 1 ? 'obchod' : plan.removedTrades.length < 5 ? 'obchody' : 'obchodů'}` : 'Vrátit replay'}
                </button>
              </div>
            </section>
          </div>
        );
      })()}
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
  ticketOpen: boolean;
  onToggleTicket: () => void;
  position: BacktestPositionSummary | null;
  onCancel: (id: string, candle: MarketCandle | null) => void;
  onClosePosition: (quantity: number, candle: MarketCandle | null) => void;
  onOpenSessionInfo: () => void;
}

/**
 * Spodní lišta session: tlačítko panelu Objednávka (jako v hlavičce LIVE),
 * účet, pozice a čekající příkazy. Zadávání příkazů je v panelu.
 */
const BacktestTradingPanel: React.FC<TradingPanelProps> = ({ run, candle, isDark, ticketOpen, onToggleTicket, position, onCancel, onClosePosition, onOpenSessionInfo }) => {
  const runtime = run.runtimeState;
  const pending = runtime.orders.filter(order => order.status === 'pending');
  const field = `h-7 rounded-md border px-2 text-[11px] tabular-nums outline-none transition-colors focus:border-blue-500/70 ${isDark
    ? 'border-white/10 bg-white/[0.04] text-white placeholder:text-slate-500 hover:border-white/20'
    : 'border-slate-200 bg-slate-50 text-slate-900 placeholder:text-slate-400 hover:border-slate-300'}`;
  const divider = `h-6 w-px shrink-0 ${isDark ? 'bg-white/10' : 'bg-slate-200'}`;
  const money = (value: number, signed = false) => `${signed && value >= 0.005 ? '+' : value <= -0.005 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const priceText = (value: number | undefined) => value === undefined ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pnlTone = (value: number) => value > 0 ? 'text-emerald-500' : value < 0 ? 'text-rose-500' : '';
  const stat = (label: string, value: string, tone = '') => (
    <div data-bt-metric="" className="flex shrink-0 flex-col justify-center leading-none">
      <span className="text-[8.5px] font-bold uppercase tracking-[0.08em] text-slate-500">{label}</span>
      <b className={`mt-[3px] font-mono text-[11.5px] font-semibold tabular-nums ${tone}`}>{value}</b>
    </div>
  );
  const typeLabels: Record<BacktestOrderType, string> = { market: 'Mkt', limit: 'Lmt', stop: 'Stp' };
  return (
    // Jeden řádek (44 px) — víc místa pro graf. Pořadí: Objednávka → účet → pozice → čekající příkazy.
    <div data-bt-metrics="" className="relative flex h-full items-center gap-3 px-3 text-[11px]">
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto [scrollbar-width:thin]">
      <button
        type="button"
        onClick={onToggleTicket}
        aria-expanded={ticketOpen}
        className={`flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[11px] font-extrabold ${ticketOpen
          ? isDark ? 'bg-white/10 text-white' : 'bg-slate-900/[0.06] text-slate-900'
          : 'bg-gradient-to-b from-blue-500 to-blue-600 text-white shadow-[0_6px_16px_-8px_#2563eb]'}`}
      >{ticketOpen ? <><PanelRightClose size={13} />Skrýt objednávku</> : <><PanelRightOpen size={13} />Objednávka</>}
        {/* Se zavřeným panelem ukazuje tlačítko běžící pozici (jako LIVE). */}
        {!ticketOpen && position && <span className="rounded-[5px] bg-white/[0.18] px-1.5 py-px font-mono text-[10px] font-extrabold">
          {position.side === 'long' ? 'LONG' : 'SHORT'} {position.quantity}{position.openPnl != null ? ` · ${formatUsd(position.openPnl)}` : ''}
        </span>}
      </button>
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
          <span className="font-mono tabular-nums text-slate-400">@ {priceText(position.entry)}</span>
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
