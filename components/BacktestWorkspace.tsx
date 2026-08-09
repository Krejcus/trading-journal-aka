import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import type { Trade } from '../types';
import AlphaTradeChartWorkspace, { type BacktestChartSessionBridge, type MarketRoot } from './AlphaTradeChartWorkspace';
import {
  completedHistoricalCandles,
  loadMarketCandles,
  resolveMarketSymbol,
  type MarketCandle,
  type MarketDataSchema,
} from '../services/marketData';
import {
  cancelBacktestOrder,
  clearPendingBacktestOrderBracket,
  createBacktestOrder,
  enqueueBacktestOrder,
  processBacktestCandle,
  updatePendingBacktestOrder,
  updatePositionBracket,
} from '../services/backtestEngine';
import { backtestClosedTradeToTrade } from '../services/backtestIntel';
import { createBacktestContextSource } from '../services/backtestEntryContext';
import { saveBacktestRun } from '../services/backtestRunService';
import type {
  BacktestInstrument,
  BacktestOrderType,
  BacktestRun,
  BacktestRuntimeState,
  BacktestWorkspaceState,
} from '../services/backtestTypes';
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
// Deep context is requested in the native provider resolution needed by the
// panel. Intraday charts stay on bounded 1m chunks; HTF charts can jump a year
// at a time with hourly bars instead of downloading and aggregating hundreds
// of thousands of minutes in the browser.
const HISTORY_SEGMENT_MS: Record<MarketDataSchema, number> = {
  'ohlcv-1m': 7 * 24 * 60 * 60 * 1_000,
  'ohlcv-1h': 365 * 24 * 60 * 60 * 1_000,
};

type HistoricalCandlesByRoot = Partial<Record<MarketRoot, Partial<Record<MarketDataSchema, MarketCandle[]>>>>;

const mergeCandles = (current: MarketCandle[], incoming: MarketCandle[]) => {
  const byTime = new Map(current.map(candle => [candle.time, candle]));
  incoming.forEach(candle => byTime.set(candle.time, candle));
  return [...byTime.values()].sort((left, right) => left.time - right.time);
};

interface Props {
  run: BacktestRun;
  isDark: boolean;
  onClose: (run: BacktestRun) => void;
  onTradeClosed?: (trade: Trade) => void;
}

const BacktestWorkspace: React.FC<Props> = ({ run: initialRun, isDark, onClose, onTradeClosed }) => {
  const [run, setRun] = useState(initialRun);
  const runRef = useRef(initialRun);
  const [candlesByRoot, setCandlesByRoot] = useState<Partial<Record<MarketRoot, MarketCandle[]>>>({});
  const [historyCandlesByRoot, setHistoryCandlesByRoot] = useState<HistoricalCandlesByRoot>({});
  const [historyLoadingKeys, setHistoryLoadingKeys] = useState<Partial<Record<string, boolean>>>({});
  const historyLoadedFromRef = useRef<Record<string, number>>({});
  const historyLoadingRef = useRef(new Set<string>());
  const loadedUntilRef = useRef(initialRun.startAt);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadingSegmentRef = useRef(false);
  const dirtyRef = useRef(false);
  const persistedRevisionRef = useRef(initialRun.revision);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const emittedTradesRef = useRef(new Set(initialRun.runtimeState.closedTrades.map(trade => trade.id)));
  const lastProcessedCursorRef = useRef<number | null>(initialRun.runtimeState.replay.cursorTime);

  const updateRun = useCallback((updater: (current: BacktestRun) => BacktestRun) => {
    const next = updater(runRef.current);
    runRef.current = next;
    setRun(next);
    dirtyRef.current = true;
  }, []);

  const flush = useCallback(() => {
    if (!dirtyRef.current) return saveChainRef.current;
    dirtyRef.current = false;
    const snapshot = runRef.current;
    saveChainRef.current = saveChainRef.current.then(async () => {
      const saved = await saveBacktestRun({ ...snapshot, revision: persistedRevisionRef.current }, {
        status: snapshot.status,
        cursorAt: snapshot.cursorAt,
        config: snapshot.config,
        workspaceState: snapshot.workspaceState,
        runtimeState: snapshot.runtimeState,
        lastOpenedAt: snapshot.lastOpenedAt,
      });
      persistedRevisionRef.current = saved.revision;
      if (runRef.current.updatedAt <= snapshot.updatedAt) {
        runRef.current = saved;
        setRun(saved);
      } else {
        runRef.current = { ...runRef.current, revision: saved.revision };
      }
    }).catch(reason => {
      console.error('[Backtest] checkpoint failed:', reason);
      dirtyRef.current = true;
    });
    return saveChainRef.current;
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void flush(), 1_500);
    return () => window.clearInterval(timer);
  }, [flush]);

  const loadSegment = useCallback(async (requestedStart: number) => {
    if (loadingSegmentRef.current || requestedStart >= runRef.current.endAt) return;
    loadingSegmentRef.current = true;
    setError(null);
    const start = Math.max(runRef.current.startAt, requestedStart);
    const end = Math.min(runRef.current.endAt, start + SEGMENT_MS);
    try {
      const roots = runRef.current.config.instruments;
      const responses = await Promise.all(roots.map(async root => ({
        root,
        response: await loadMarketCandles({ symbol: resolveMarketSymbol(root), start: new Date(start), end: new Date(end) }),
      })));
      setCandlesByRoot(current => {
        const next = { ...current };
        responses.forEach(({ root, response }) => { next[root] = mergeCandles(next[root] ?? [], response.candles); });
        return next;
      });
      loadedUntilRef.current = end;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Tržní data se nepodařilo načíst.');
    } finally {
      loadingSegmentRef.current = false;
      setLoading(false);
    }
  }, []);

  const loadOlderHistory = useCallback(async (root: MarketRoot, schema: MarketDataSchema, requestedBeforeMs: number) => {
    const key = `${root}:${schema}`;
    if (historyLoadingRef.current.has(key)) return;
    const loadedFrom = historyLoadedFromRef.current[key] ?? runRef.current.startAt;
    const end = Math.min(requestedBeforeMs, loadedFrom, runRef.current.startAt);
    if (!Number.isFinite(end)) return;
    const start = end - HISTORY_SEGMENT_MS[schema];
    historyLoadingRef.current.add(key);
    setHistoryLoadingKeys(current => ({ ...current, [key]: true }));
    try {
      const response = await loadMarketCandles({
        symbol: resolveMarketSymbol(root),
        start: new Date(start),
        end: new Date(end),
        schema,
      });
      const safeCandles = completedHistoricalCandles({
        candles: response.candles,
        schema,
        endMs: end,
        replayStartMs: runRef.current.startAt,
      });
      setHistoryCandlesByRoot(current => ({
        ...current,
        [root]: {
          ...current[root],
          [schema]: mergeCandles(current[root]?.[schema] ?? [], safeCandles),
        },
      }));
      historyLoadedFromRef.current[key] = start;
    } finally {
      historyLoadingRef.current.delete(key);
      setHistoryLoadingKeys(current => ({ ...current, [key]: false }));
    }
  }, []);

  useEffect(() => {
    const cursorMs = initialRun.cursorAt ?? initialRun.startAt;
    const contextStart = Math.max(initialRun.startAt, cursorMs - SEGMENT_MS + PREFETCH_MS);
    void loadSegment(contextStart);
  }, [initialRun.cursorAt, initialRun.startAt, loadSegment]);

  const emitClosedTrades = useCallback((runtime: BacktestRuntimeState) => {
    const pending = runtime.closedTrades.filter(closed => !emittedTradesRef.current.has(closed.id));
    if (pending.length === 0) return;
    const current = runRef.current;
    // Jeden zdroj kontextu na celou dávku: levely a struktura se počítají přes
    // celé pole svíček, takže per-obchod by to byl zbytečně násobený průchod.
    const contextSources = new Map<BacktestInstrument, ReturnType<typeof createBacktestContextSource>>();
    const contextFor = (instrument: BacktestInstrument) => {
      const cached = contextSources.get(instrument);
      if (cached) return cached;
      const source = createBacktestContextSource({
        candles: candlesByRoot[instrument] ?? [],
        htfCandles: historyCandlesByRoot[instrument]?.['ohlcv-1h'],
        timeZone: current.config.timezone,
      });
      contextSources.set(instrument, source);
      return source;
    };
    pending.forEach(closed => {
      emittedTradesRef.current.add(closed.id);
      onTradeClosed?.(backtestClosedTradeToTrade(closed, {
        accountId: current.accountId,
        // Excursion i counterfactual potřebují bary za výstupem. Prefetch je
        // v tu chvíli většinou má; když ne, metriky se označí jako nedostupné
        // místo aby se počítaly z useknutých dat.
        candles: candlesByRoot[closed.instrument] ?? [],
        orderEvents: runtime.orderEvents ?? [],
        timeZone: current.config.timezone,
        strategy: current.config.strategy,
        contextSource: contextFor(closed.instrument),
      }));
    });
  }, [candlesByRoot, historyCandlesByRoot, onTradeClosed]);

  const handleReplayChange = useCallback((replay: ChartReplayState) => {
    const executionInstrument = runRef.current.executionSymbol;
    const executionCandles = candlesByRoot[executionInstrument] ?? [];
    let runtime: BacktestRuntimeState = { ...runRef.current.runtimeState, replay: { ...replay, playing: replay.playing } };
    const previous = lastProcessedCursorRef.current;
    if (replay.phase === 'active' && replay.cursorTime !== null && (previous === null || replay.cursorTime > previous)) {
      const revealed = executionCandles.filter(candle => candle.time > (previous ?? replay.cursorTime - 1) && candle.time <= replay.cursorTime!);
      revealed.forEach(candle => { runtime = processBacktestCandle(runtime, runRef.current.id, executionInstrument, candle, runRef.current.config); });
      lastProcessedCursorRef.current = replay.cursorTime;
    } else if (replay.cursorTime !== null) {
      lastProcessedCursorRef.current = replay.cursorTime;
    }
    updateRun(current => ({
      ...current,
      cursorAt: replay.cursorTime ? replay.cursorTime * 1_000 : current.cursorAt,
      runtimeState: runtime,
      status: replay.playing ? 'active' : current.status === 'completed' ? 'completed' : 'paused',
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
    }));
    if (replay.cursorTime && (replay.cursorTime * 1_000) >= loadedUntilRef.current - PREFETCH_MS && loadedUntilRef.current < runRef.current.endAt) {
      void loadSegment(loadedUntilRef.current);
    }
    emitClosedTrades(runtime);
  }, [candlesByRoot, emitClosedTrades, loadSegment, updateRun]);

  const handleWorkspaceChange = useCallback((workspaceState: BacktestWorkspaceState) => {
    updateRun(current => ({ ...current, workspaceState, updatedAt: Date.now() }));
  }, [updateRun]);

  const executeOrder = useCallback((input: {
    side: 'buy' | 'sell'; type: BacktestOrderType; quantity: number; price?: number; stopLoss?: number; takeProfit?: number; reduceOnly?: boolean;
  }, candle: MarketCandle | null, sourceDrawing?: PositionDrawing) => {
    if (!candle || candle.time * 1_000 < runRef.current.startAt) return null;
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
      if (input.type === 'market') runtime = processBacktestCandle(runtime, current.id, current.executionSymbol, candle, current.config);
      emitClosedTrades(runtime);
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
    allowedRoots: run.config.instruments,
    executionInstrument: run.executionSymbol,
    initialReplay: run.runtimeState.replay,
    workspaceState: run.workspaceState,
    onReplayChange: handleReplayChange,
    onWorkspaceChange: handleWorkspaceChange,
    onQuickOrder: ({ drawing, candle, instrument }) => executeQuickOrder(drawing, candle, instrument),
    chartOrderQuantity: orderQuantity,
    onChartOrder: (input, candle) => {
      executeOrder({ side: input.side, type: input.type, quantity: input.quantity, price: input.price }, candle);
    },
    orderLines,
    managedPositionBoxes: managedBoxes,
    fills: run.runtimeState.fills.filter(fill => fill.instrument === run.executionSymbol),
    closedTrades: run.runtimeState.closedTrades.filter(trade => trade.instrument === run.executionSymbol),
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
  }), [addPositionBracketLine, candlesByRoot, cancelOrderLine, changeBracket, changeOrderLine, closePosition, executeOrder, executeQuickOrder, handleReplayChange, handleWorkspaceChange, historyCandlesByRoot, historyLoadingKeys, isDark, loadOlderHistory, managedBoxes, orderLines, orderQuantity, run.endAt, run.executionSymbol, run.id, run.runtimeState, run.startAt, run.workspaceState]);

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
    await flush();
    onClose(runRef.current);
  }, [flush, onClose, updateRun]);

  const initialCandles = candlesByRoot.MNQ ?? [];
  if (loading && initialCandles.length === 0) return (
    <div className={`fixed inset-0 z-[400] flex flex-col items-center justify-center gap-4 ${isDark ? 'bg-[#070a0f] text-white' : 'bg-white text-slate-900'}`}>
      <Loader2 className="animate-spin text-blue-500" size={30} />
      <div className="text-center"><p className="font-black">Načítám backtest session</p><p className="text-xs text-slate-500">MNQ + NQ · první datový segment</p></div>
      <button onClick={() => void closeWorkspace()} className="absolute right-4 top-4 rounded-lg p-2 text-slate-500 hover:bg-slate-500/10"><X size={20} /></button>
    </div>
  );
  if (error && initialCandles.length === 0) return (
    <div className={`fixed inset-0 z-[400] flex flex-col items-center justify-center gap-4 p-6 ${isDark ? 'bg-[#070a0f] text-white' : 'bg-white text-slate-900'}`}>
      <p className="max-w-lg text-center text-sm font-bold text-rose-500">{error}</p>
      <div className="flex gap-2"><button onClick={() => void loadSegment(run.cursorAt ?? run.startAt)} className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-black text-white">Zkusit znovu</button><button onClick={() => void closeWorkspace()} className="rounded-lg border px-4 py-2 text-xs font-black">Zavřít</button></div>
    </div>
  );

  return <AlphaTradeChartWorkspace
    trade={syntheticTrade}
    entryMs={run.startAt}
    exitMs={run.endAt}
    initialRoot="MNQ"
    initialCandles={initialCandles}
    isDark={isDark}
    onClose={() => void closeWorkspace()}
    backtestSession={bridge}
  />;
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
        <div className="min-w-[260px]"><div className="mb-1 font-black"><span className={position.side === 'long' ? 'text-emerald-500' : 'text-rose-500'}>{position.side.toUpperCase()} {position.quantity}×</span> @ {position.averagePrice.toFixed(2)}</div><div className="flex gap-1"><input className={`${field} w-16`} defaultValue={position.stopLoss ?? ''} placeholder="SL" onBlur={event => onChangeBracket(num(event.target.value), position.takeProfit)} /><input className={`${field} w-16`} defaultValue={position.takeProfit ?? ''} placeholder="TP" onBlur={event => onChangeBracket(position.stopLoss, num(event.target.value))} />{position.quantity > 1 && <button onClick={() => onClosePosition(Math.floor(position.quantity / 2), candle)} className={`${field} font-bold`}>½ ven</button>}<button onClick={() => onClosePosition(position.quantity, candle)} className="h-7 rounded bg-slate-700 px-2 font-black text-white">Zavřít</button></div></div>
      </>}
      {pending.length > 0 && <>
        <div className={`h-12 w-px shrink-0 ${isDark ? 'bg-white/10' : 'bg-slate-200'}`} />
        <div className="min-w-[190px] space-y-1">{pending.slice(0, 3).map(order => <div key={order.id} className="flex items-center gap-2"><span className="font-bold">{order.side.toUpperCase()} {order.quantity} {order.type} @{order.limitPrice ?? order.stopPrice}</span><button onClick={() => onCancel(order.id, candle)} className="text-rose-500">×</button></div>)}</div>
      </>}
      <div className="ml-auto whitespace-nowrap text-slate-500">{candle ? `${run.executionSymbol} ${candle.close.toFixed(2)}` : 'Bez ceny'}</div>
    </div>
  );
};

export default BacktestWorkspace;
