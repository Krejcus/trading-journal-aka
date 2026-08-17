import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlexLayoutAdapter,
  LocalStoragePersistence,
  createWorkspace,
  type PanelInstance,
  type WorkspaceManager,
} from '@getcandlekit/charts/react/workspace';
import { IndicatorController, createBuiltinRegistry, type ChartViewApi } from '@getcandlekit/charts/react';
import type { Drawing } from '@getcandlekit/charts';
import 'flexlayout-react/style/light.css';
import {
  Download,
  GripVertical,
  LayoutGrid,
  Loader2,
  LocateFixed,
  Maximize2,
  Pause,
  Play,
  Plus,
  Redo2,
  Rewind,
  RotateCcw,
  Save,
  StepForward,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { Trade } from '../types';
import {
  aggregateCandles,
  loadMarketCandles,
  marketDataSchemaForTimeframe,
  marketDataWindowForEntry,
  resolveMarketSymbol,
  updateReplayAnalysisAccumulator,
  type MarketCandle,
  type MarketDataSchema,
  type MarketTimeframe,
  type ReplayAnalysisAccumulator,
} from '../services/marketData';
import CandleKitTradeChart, {
  AlphaTradeDrawingToolbar,
  WorkspaceIndicatorMenu,
  type CandleKitDrawingEngine,
} from './CandleKitTradeChart';
import ChartTimeframePicker from './ChartTimeframePicker';
import ChartLayoutPicker, {
  CurrentChartLayoutGlyph,
} from './ChartLayoutPicker';
import {
  buildChartWorkspaceLayout,
  getChartWorkspaceLayout,
  type ChartWorkspaceLayoutId,
} from '../services/chartWorkspaceLayouts';
import {
  installChartWorkspaceSync,
  type ChartWorkspaceSyncSettings,
} from '../services/chartWorkspaceSync';
import {
  ChartWorkspaceHistory,
  type ChartWorkspaceHistoryState,
  type WorkspaceSnapshot,
  type WorkspaceIndicatorState,
} from '../services/chartWorkspaceHistory';
import { transferArmedDrawingTool } from '../services/chartDrawingToolTransfer';
import { installWorkspaceDrawingSync } from '../services/chartDrawingSync';
import FibDrawingSettingsDialog, {
  FibDrawingFloatingToolbar,
} from './FibDrawingSettingsDialog';
import type { FibDrawing } from '../services/chartFibDrawing';
import GenericDrawingFloatingToolbar from './GenericDrawingFloatingToolbar';
import GenericDrawingSettingsDialog from './GenericDrawingSettingsDialog';
import PositionDrawingSettingsDialog, { PositionDrawingFloatingToolbar } from './PositionDrawingSettingsDialog';
import { isPositionDrawing, type PositionDrawing } from '../services/chartPositionDrawing';
import { countChartIndicators } from '../services/chartContextMenu';
import BacktestOrderLinesOverlay from './BacktestOrderLinesOverlay';
import BacktestTradeExecutionsOverlay from './BacktestTradeExecutionsOverlay';
import BacktestTradeReviewDialog from './BacktestTradeReviewDialog';
import type { BacktestClosedTrade, BacktestFill, BacktestOrderSide, BacktestOrderType } from '../services/backtestTypes';
import type { BacktestChartOrderLine, BacktestChartOrderLineKind } from '../services/backtestOrderLines';
import type { BacktestManagedPositionBox } from '../services/backtestManagedPosition';
import { captureChartWorkspaceSnapshotDataUrl } from '../services/chartSnapshot';
import {
  advanceReplayTimeByInterval,
  chartReplayDelayMs,
  chartReplayShortcut,
  CHART_REPLAY_STEP_MINUTES,
  CHART_REPLAY_SPEEDS,
  DEFAULT_CHART_REPLAY_STATE,
  isReplayAtLatestCandle,
  replayCandleCountAt,
  type ChartReplaySpeed,
  type ChartReplayState,
  type ChartReplayStepMinutes,
} from '../services/chartReplay';
import ReplayGoToMenu from './ReplayGoToMenu';
import {
  CHART_SETTINGS_EVENT,
  CHART_TIME_ZONES,
  loadChartSettings,
  type ChartSettings,
  type ChartTradingSettings,
} from '../services/chartSettings';
import { chartAppearanceSnapshot, type ChartAppearanceState } from '../services/chartAppearanceScope';
import { panelSettingsTargetMatches, type PanelSettingsTarget } from '../services/chartPanelSettings';
import {
  DEFAULT_REPLAY_GO_TO_TIME_ZONE,
  loadReplayGoToSettings,
  REPLAY_GO_TO_FAILURE_MESSAGES,
  resolveReplayGoTo,
  type ReplayGoToRequest,
  type ReplayGoToSettings,
} from '../services/replayGoTo';

const REPLAY_TOOLBAR_POSITION_KEY = 'alphatrade.chart-replay-toolbar-position.v1';

/** Hláška po skoku ve stejném pásmu, jaké má časová osa grafu. */
const goToTimeLabel = (unixSeconds: number, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat('cs-CZ', {
      timeZone,
      day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(unixSeconds * 1_000);
  } catch {
    return new Date(unixSeconds * 1_000).toLocaleString('cs-CZ');
  }
};
const REPLAY_TIMEFRAME_LABELS: Record<ChartReplayStepMinutes, string> = {
  1: '1m',
  5: '5m',
  15: '15m',
  30: '30m',
  60: '1h',
  240: '4h',
  1440: 'D',
};

interface ReplayToolbarPosition {
  left: number;
  top: number;
}

const loadReplayToolbarPosition = (): ReplayToolbarPosition | null => {
  try {
    const value = JSON.parse(window.localStorage.getItem(REPLAY_TOOLBAR_POSITION_KEY) ?? 'null') as Partial<ReplayToolbarPosition> | null;
    return value && Number.isFinite(value.left) && Number.isFinite(value.top)
      ? { left: Number(value.left), top: Number(value.top) }
      : null;
  } catch {
    return null;
  }
};

export type MarketRoot = 'MNQ' | 'NQ';

export interface BacktestChartSessionBridge {
  id: string;
  startMs: number;
  endMs: number;
  candlesByRoot: Partial<Record<MarketRoot, MarketCandle[]>>;
  historyCandlesByRoot?: Partial<Record<MarketRoot, Partial<Record<MarketDataSchema, MarketCandle[]>>>>;
  historyLoadingKeys?: Partial<Record<string, boolean>>;
  onNeedOlderHistory?: (root: MarketRoot, schema: MarketDataSchema, beforeMs: number) => Promise<void>;
  allowedRoots: MarketRoot[];
  executionInstrument: MarketRoot;
  initialReplay: ChartReplayState;
  workspaceState?: {
    layout?: unknown;
    panels?: WorkspaceSnapshot;
    layoutId?: string;
    activePanelId?: string;
    syncSettings?: Partial<ChartWorkspaceSyncSettings>;
  };
  onReplayChange: (replay: ChartReplayState) => void;
  onWorkspaceChange: (state: {
    layout: unknown;
    panels: WorkspaceSnapshot;
    layoutId: ChartWorkspaceLayoutId;
    activePanelId: string;
    syncSettings: ChartWorkspaceSyncSettings;
    appearance: ChartAppearanceState | undefined;
  }) => void;
  onQuickOrder?: (context: {
    drawing: PositionDrawing;
    candle: MarketCandle | null;
    instrument: MarketRoot;
  }) => { ok: boolean; message: string };
  /** Počet kontraktů z obchodního panelu — objednávka z grafu bere stejné číslo. */
  chartOrderQuantity?: number;
  /** Objednávka zadaná pravým klikem do grafu na konkrétní cenové úrovni. */
  onChartOrder?: (
    input: { side: BacktestOrderSide; type: BacktestOrderType; quantity: number; price?: number },
    candle: MarketCandle | null,
  ) => void;
  orderLines?: BacktestChartOrderLine[];
  managedPositionBoxes?: BacktestManagedPositionBox[];
  closedTrades?: BacktestClosedTrade[];
  fills?: BacktestFill[];
  journalTrades?: Trade[];
  onTradeRecalculate?: (tradeId: string) => Trade | Promise<Trade>;
  onTradeReviewSave?: (tradeId: string, updates: Partial<Trade>, snapshotDataUrl?: string) => Promise<void>;
  onOrderLineChange?: (line: BacktestChartOrderLine, kind: BacktestChartOrderLineKind, price: number) => void;
  onOrderLineCancel?: (line: BacktestChartOrderLine) => void;
  onOrderLineAddBracket?: (
    line: BacktestChartOrderLine,
    kind: Exclude<BacktestChartOrderLineKind, 'entry'>,
    price?: number,
  ) => void;
  renderTradingPanel?: (context: {
    replay: ChartReplayState;
    candle: MarketCandle | null;
    instrument: MarketRoot;
  }) => React.ReactNode;
}

interface AlphaTradeChartWorkspaceProps {
  trade: Trade;
  entryMs: number;
  exitMs: number;
  initialRoot: MarketRoot;
  initialCandles: MarketCandle[];
  isDark: boolean;
  onClose: () => void;
  backtestSession?: BacktestChartSessionBridge;
}

interface WorkspacePanelConfig extends Record<string, unknown> {
  root: MarketRoot;
  timeframe: MarketTimeframe;
  showFvg: boolean;
  showLevels: boolean;
  showStructure: boolean;
}

interface WorkspaceDataContextValue {
  trade: Trade;
  entryMs: number;
  exitMs: number;
  isDark: boolean;
  initialRoot: MarketRoot;
  initialCandles: MarketCandle[];
  backtestSession?: BacktestChartSessionBridge;
  activePanelId: string;
  replay: ChartReplayState;
  replaySelectionTime: number | null;
  setReplaySelectionTime: (time: number | null) => void;
  selectReplayStart: (time: number) => void;
  activatePanel: (id: string) => void;
  registerPanel: (id: string, control: WorkspacePanelControl) => void;
  unregisterPanel: (id: string) => void;
  /** Rychlá objednávka z vybraného position boxu — sdílí ji blesk i kontextové menu. */
  onPositionQuickOrder?: () => void;
  tradingSettings: ChartTradingSettings;
  openBacktestTradeReview: (tradeId: string) => void;
}

interface WorkspacePanelControl {
  config: WorkspacePanelConfig;
  updateConfig: (next: Partial<WorkspacePanelConfig>) => void;
  indicatorController: IndicatorController;
  activeLibraryIndicators: string[];
  focusTrade: () => void;
  drawingEngine: CandleKitDrawingEngine | null;
  chartApi: ChartViewApi | null;
  rawCandles: MarketCandle[];
  getCandles: () => MarketCandle[];
  getIndicatorState: () => WorkspaceIndicatorState;
  applyIndicatorState: (state: WorkspaceIndicatorState) => void;
}

const WorkspaceDataContext = createContext<WorkspaceDataContextValue | null>(null);
const WORKSPACE_KIND = 'alphatrade-chart';
const SAVED_LAYOUT_NAME = 'AlphaTrade workspace';
const WORKSPACE_LAYOUT_STORAGE_KEY = 'alphatrade:chart-workspace-layout';
const WORKSPACE_SYNC_STORAGE_KEY = 'alphatrade:chart-workspace-sync';
const PANEL_ID_PREFIX = 'alphatrade-chart-';
const DEFAULT_SYNC_SETTINGS: ChartWorkspaceSyncSettings = {
  symbol: false,
  interval: false,
  crosshair: true,
  time: true,
  dateRange: false,
  drawings: true,
};
const WORKSPACE_GLOBAL = {
  tabEnableClose: true,
  tabEnableRename: false,
  tabSetEnableMaximize: true,
  splitterSize: 2,
  splitterExtra: 8,
  tabSetMinWidth: 180,
  tabSetMinHeight: 140,
};

const panelConfig = (
  root: MarketRoot = 'MNQ',
  timeframe: MarketTimeframe = '1m',
): WorkspacePanelConfig => ({
  root,
  timeframe,
  showFvg: false,
  showLevels: false,
  showStructure: false,
});

const buildWorkspaceLayout = (
  root: MarketRoot,
  id: ChartWorkspaceLayoutId = '2h',
  suppliedConfigs?: WorkspacePanelConfig[],
) => {
  const count = getChartWorkspaceLayout(id).panelCount;
  const defaultTimeframes: MarketTimeframe[] = ['1m', '5m', '15m', '1d'];
  const configs = Array.from({ length: count }, (_, index) => (
    suppliedConfigs?.[index]
      ? { ...suppliedConfigs[index] }
      : panelConfig(root, defaultTimeframes[index] ?? '1m')
  ));
  return buildChartWorkspaceLayout({
    id,
    configs,
    component: WORKSPACE_KIND,
    panelIdPrefix: PANEL_ID_PREFIX,
    panelTitle: panel => `Graf ${panel}`,
    global: WORKSPACE_GLOBAL,
  });
};

const loadLayoutId = (): ChartWorkspaceLayoutId => {
  try {
    const value = window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) as ChartWorkspaceLayoutId | null;
    if (value && getChartWorkspaceLayout(value).id === value) return value;
  } catch { /* private storage */ }
  return '2h';
};

const loadSyncSettings = (): ChartWorkspaceSyncSettings => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(WORKSPACE_SYNC_STORAGE_KEY) || '{}') as Partial<ChartWorkspaceSyncSettings>;
    return {
      symbol: parsed.symbol === true,
      interval: parsed.interval === true,
      crosshair: parsed.crosshair !== false,
      time: parsed.time !== false,
      dateRange: parsed.dateRange === true,
      drawings: parsed.drawings !== false,
    };
  } catch {
    return DEFAULT_SYNC_SETTINGS;
  }
};

const panelOrder = (id: string) => Number(id.replace(PANEL_ID_PREFIX, '')) || Number.MAX_SAFE_INTEGER;

interface WorkspacePanelProps {
  instance: PanelInstance<WorkspacePanelConfig>;
  updateConfig: (next: Partial<WorkspacePanelConfig>) => void;
}

interface ResilientPanelState {
  caught: boolean;
  exhausted: boolean;
  attempt: number;
  failedAt: number[];
}

/**
 * Panel občas shodí přechodová chyba grafu — typicky volání na sérii právě
 * rušeného chartu při remountu, nebo závod při mountu tří panelů najednou.
 * FlexLayout má vlastní boundary s ručním Retry (a jedno kliknutí panel vždy
 * spolehlivě oživilo); tenhle obal udělá totéž sám. Přechodný závod je pak
 * mrknutí místo mrtvého panelu. Tři pády během minuty znamenají skutečnou
 * chybu — pak se ukáže ruční Retry, ať se smyčka netočí donekonečna.
 */
class ResilientWorkspacePanel extends React.Component<WorkspacePanelProps, ResilientPanelState> {
  state: ResilientPanelState = { caught: false, exhausted: false, attempt: 0, failedAt: [] };

  static getDerivedStateFromError(): Partial<ResilientPanelState> {
    return { caught: true };
  }

  componentDidCatch(error: unknown) {
    const now = Date.now();
    const recent = this.state.failedAt.filter(at => now - at < 60_000);
    console.warn('[Workspace] Panel spadl na přechodovou chybu, zkouším automatickou obnovu:', error);
    if (recent.length >= 2) {
      this.setState({ caught: false, exhausted: true, failedAt: [...recent, now] });
      return;
    }
    this.setState(current => ({
      caught: false,
      exhausted: false,
      attempt: current.attempt + 1,
      failedAt: [...recent, now],
    }));
  }

  render() {
    if (this.state.caught) return null;
    if (this.state.exhausted) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-sm">
          <span>Panel se opakovaně nepodařilo obnovit.</span>
          <button
            type="button"
            className="rounded-md border border-slate-300 px-4 py-1.5 text-xs font-bold hover:bg-slate-100"
            onClick={() => this.setState({ caught: false, exhausted: false, attempt: this.state.attempt + 1, failedAt: [] })}
          >Zkusit znovu</button>
        </div>
      );
    }
    return <AlphaTradeWorkspacePanel key={this.state.attempt} {...this.props} />;
  }
}

const AlphaTradeWorkspacePanel: React.FC<WorkspacePanelProps> = ({ instance, updateConfig }) => {
  const context = useContext(WorkspaceDataContext);
  if (!context) throw new Error('AlphaTrade workspace panel is missing its data context.');

  const config = { ...panelConfig(), ...instance.config };
  const backtestSession = context.backtestSession;
  const sessionCandles = backtestSession?.candlesByRoot[config.root]
    ?? (config.root === context.initialRoot ? context.initialCandles : undefined);
  const historySchema = marketDataSchemaForTimeframe(config.timeframe);
  const historyLoadingKey = `${config.root}:${historySchema}`;
  const sessionHistoryCandles = backtestSession?.historyCandlesByRoot?.[config.root]?.[historySchema] ?? [];
  const sessionHistoryLoading = backtestSession?.historyLoadingKeys?.[historyLoadingKey] === true;
  const requestSessionHistory = backtestSession?.onNeedOlderHistory;
  const [rawCandles, setRawCandles] = useState<MarketCandle[]>(
    sessionCandles ?? (config.root === context.initialRoot ? context.initialCandles : []),
  );
  const [loading, setLoading] = useState(sessionCandles ? false : config.root !== context.initialRoot);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [chartApi, setChartApi] = useState<ChartViewApi | null>(null);
  const [activeLibraryIndicators, setActiveLibraryIndicators] = useState<string[]>([]);
  const indicatorController = useMemo(
    () => new IndicatorController(createBuiltinRegistry(), { onChange: setActiveLibraryIndicators }),
    [],
  );
  const focusTrade = useCallback(() => setFocusRequest(value => value + 1), []);
  const handleChartApiReady = useCallback((api: ChartViewApi | null) => setChartApi(api), []);
  const updatePanelConfig = useCallback((next: Partial<WorkspacePanelConfig>) => {
    if (next.root !== undefined || next.timeframe !== undefined) setChartApi(null);
    updateConfig(next);
  }, [updateConfig]);
  const getIndicatorState = useCallback((): WorkspaceIndicatorState => ({
    custom: {
      fvg: config.showFvg,
      levels: config.showLevels,
      structure: config.showStructure,
    },
    library: indicatorController.activeNames().sort().flatMap(name => {
      const active = indicatorController.getActive(name);
      return active ? [{ name: active.name, params: { ...active.params } }] : [];
    }),
  }), [config.showFvg, config.showLevels, config.showStructure, indicatorController]);
  const applyIndicatorState = useCallback((state: WorkspaceIndicatorState) => {
    indicatorController.clear();
    state.library.forEach(indicator => indicatorController.add(indicator.name, indicator.params));
    updatePanelConfig({
      showFvg: state.custom.fvg,
      showLevels: state.custom.levels,
      showStructure: state.custom.structure,
    });
  }, [indicatorController, updatePanelConfig]);

  useEffect(() => () => context.unregisterPanel(instance.id), [context.unregisterPanel, instance.id]);

  useEffect(() => {
    if (context.backtestSession) {
      const next = context.backtestSession.candlesByRoot[config.root]
        ?? (config.root === context.initialRoot ? context.initialCandles : []);
      setRawCandles(next);
      setLoading(next.length === 0);
      setError(null);
      return;
    }
    if (config.root === context.initialRoot && context.initialCandles.length > 0) {
      setRawCandles(context.initialCandles);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const { start, end } = marketDataWindowForEntry(context.entryMs);
    const symbol = resolveMarketSymbol(config.root, context.trade.symbol || context.trade.instrument);
    setLoading(true);
    setError(null);
    loadMarketCandles({ symbol, start, end })
      .then(response => {
        if (!cancelled) setRawCandles(response.candles);
      })
      .catch(reason => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Tržní data se nepodařilo načíst.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [config.root, context.backtestSession?.id, context.entryMs, context.initialCandles, context.initialRoot, context.trade.instrument, context.trade.symbol, sessionCandles]);

  // Older session context is intentionally lazy. Eagerly requesting another
  // full minute-data segment for every panel/root doubled the initial MNQ + NQ
  // payload and could crash Chromium while opening a saved session. The chart
  // calls `requestOlderHistory` as soon as the user reaches its left edge, so
  // the complete past remains reachable without paying that cost up front.
  useEffect(() => {
    if (sessionHistoryCandles.length > 0) setHistoryError(null);
  }, [sessionHistoryCandles.length]);

  const replayRevealedCount = useMemo(() => {
    if (!backtestSession) return context.replay.phase === 'active'
      ? replayCandleCountAt(rawCandles, context.replay.cursorTime)
      : rawCandles.length;
    const sessionStartSeconds = Math.floor(backtestSession.startMs / 1_000);
    return replayCandleCountAt(rawCandles, context.replay.cursorTime ?? sessionStartSeconds);
  }, [backtestSession?.startMs, context.replay.cursorTime, context.replay.phase, rawCandles]);
  const replayRawCandles = useMemo(
    () => replayRevealedCount === rawCandles.length
      ? rawCandles
      : rawCandles.slice(0, replayRevealedCount),
    [rawCandles, replayRevealedCount],
  );
  const replayAnalysisAccumulatorRef = useRef<ReplayAnalysisAccumulator | null>(null);
  const candles = useMemo(() => {
    if (!backtestSession) {
      replayAnalysisAccumulatorRef.current = null;
      return aggregateCandles(replayRawCandles, config.timeframe);
    }
    const next = updateReplayAnalysisAccumulator(replayAnalysisAccumulatorRef.current, {
      historicalMinute: sessionHistoryCandles,
      sessionMinute: rawCandles,
      timeframe: config.timeframe,
      replayStartSeconds: Math.floor(backtestSession.startMs / 1_000),
      revealedCount: replayRevealedCount,
    });
    replayAnalysisAccumulatorRef.current = next;
    return next.candles;
  }, [backtestSession?.startMs, config.timeframe, rawCandles, replayRawCandles, replayRevealedCount, sessionHistoryCandles]);
  const requestOlderHistory = useCallback((oldestTime: number) => {
    if (!requestSessionHistory) return;
    setHistoryError(null);
    void requestSessionHistory(config.root, historySchema, oldestTime * 1_000).catch(reason => {
      setHistoryError(reason instanceof Error ? reason.message : 'Starší historii se nepodařilo načíst.');
    });
  }, [config.root, historySchema, requestSessionHistory]);
  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const getCandles = useCallback(() => candlesRef.current, []);

  useEffect(() => {
    context.registerPanel(instance.id, {
      config,
      updateConfig: updatePanelConfig,
      indicatorController,
      activeLibraryIndicators,
      focusTrade,
      drawingEngine: chartApi?.drawing?.engine ?? null,
      chartApi,
      rawCandles,
      getCandles,
      getIndicatorState,
      applyIndicatorState,
    });
  }, [activeLibraryIndicators, applyIndicatorState, chartApi, config.root, config.showFvg, config.showLevels, config.showStructure, config.timeframe, context.registerPanel, focusTrade, getCandles, getIndicatorState, indicatorController, instance.id, rawCandles, updatePanelConfig]);

  const isActive = context.activePanelId === instance.id;

  return (
    <div
      className={`absolute inset-0 flex flex-col alphatrade-workspace-panel ${isActive ? 'is-active' : ''} ${context.isDark ? 'is-dark bg-[#090d12]' : 'bg-white'}`}
      onPointerDownCapture={() => context.activatePanel(instance.id)}
      data-panel-id={instance.id}
      data-active-panel={isActive || undefined}
      data-panel-root={config.root}
      data-panel-timeframe={config.timeframe}
    >
      <div className="relative flex-1 min-h-0">
        {!loading && !error && candles.length > 0 && (
          <>
          <CandleKitTradeChart
            trade={context.trade}
            candles={candles}
            rawCandles={replayRawCandles}
            timeframe={config.timeframe}
            instrumentRoot={config.root}
            entryMs={context.entryMs}
            exitMs={context.exitMs}
            showFvg={config.showFvg}
            showLevels={config.showLevels}
            showStructure={config.showStructure}
            isDark={context.isDark}
            drawingScope={`${context.backtestSession ? `backtest:${context.backtestSession.id}` : 'workspace'}:${instance.id}:${config.root}:${config.timeframe}`}
            settingsPanelId={instance.id}
            compactToolbar
            indicatorController={indicatorController}
            focusRequest={focusRequest}
            hideFocusButton
            hideDrawingToolbar
            keyboardShortcutsActive={isActive}
            // Výběr nového startu v backtest session je overlay nad ZMRAZENÝM
            // replay pohledem: graf zůstává, kde je, a uživatel táhne odtud.
            // Přepnutí do ne-replay režimu (dřívější chování) resetovalo okno
            // na initialWindow — u backtest pseudo-obchodu ukotvené na začátek
            // session, takže graf odskočil — a dávkově přepočítalo indikátory
            // přes celé pole, což byl ten zásek. Standalone graf obchodu
            // (mimo session) si nechává původní chování: tam výběr záměrně
            // ukazuje celou historii.
            replayActive={context.replay.phase === 'active'
              || (Boolean(context.backtestSession) && context.replay.phase === 'selecting')}
            replayCursorTime={context.replay.cursorTime}
            replaySelecting={context.replay.phase === 'selecting'}
            replaySelectionCandles={rawCandles}
            replaySelectionTime={context.replaySelectionTime}
            managedPositionBoxes={context.tradingSettings.positionBoxes && config.root === context.backtestSession?.executionInstrument
              ? context.backtestSession.managedPositionBoxes
              : undefined}
            showManagedPositionBoxes={context.tradingSettings.positionBoxes}
            chartOrderQuantity={context.backtestSession?.chartOrderQuantity}
            onPositionQuickOrder={context.tradingSettings.quickOrderButton ? context.onPositionQuickOrder : undefined}
            onChartOrder={config.root === context.backtestSession?.executionInstrument
              ? context.backtestSession.onChartOrder
              : undefined}
            onNeedOlderHistory={backtestSession ? requestOlderHistory : undefined}
            olderHistoryLoading={sessionHistoryLoading}
            onReplaySelectionTimeChange={context.setReplaySelectionTime}
            onReplayStart={context.selectReplayStart}
            onChartApiReady={handleChartApiReady}
            activeLibraryIndicators={activeLibraryIndicators}
            onToggleFvg={() => updatePanelConfig({ showFvg: !config.showFvg })}
            onToggleLevels={() => updatePanelConfig({ showLevels: !config.showLevels })}
            onToggleStructure={() => updatePanelConfig({ showStructure: !config.showStructure })}
          />
          {context.tradingSettings.orderLines && chartApi && config.root === context.backtestSession?.executionInstrument && context.backtestSession.orderLines?.length && context.backtestSession.onOrderLineChange && context.backtestSession.onOrderLineCancel ? (
            <BacktestOrderLinesOverlay
              api={chartApi}
              lines={context.backtestSession.orderLines}
              onChange={context.backtestSession.onOrderLineChange}
              onCancel={context.backtestSession.onOrderLineCancel}
              onAddBracket={context.backtestSession.onOrderLineAddBracket}
            />
          ) : null}
          {(context.tradingSettings.tradeLines || context.tradingSettings.executionMarkers) && chartApi && config.root === context.backtestSession?.executionInstrument && (context.backtestSession.fills?.length || context.backtestSession.closedTrades?.length) ? (
            <BacktestTradeExecutionsOverlay
              api={chartApi}
              trades={context.backtestSession.closedTrades ?? []}
              fills={context.backtestSession.fills ?? []}
              isDark={context.isDark}
              showTradeLines={context.tradingSettings.tradeLines}
              showExecutionMarkers={context.tradingSettings.executionMarkers}
              executionMarkerSize={context.tradingSettings.executionMarkerSize}
              onTradeSelect={context.backtestSession.onTradeReviewSave ? context.openBacktestTradeReview : undefined}
            />
          ) : null}
          </>
        )}
        {sessionHistoryLoading ? (
          <div className="pointer-events-none absolute left-3 top-3 z-[650] flex items-center gap-1.5 rounded-md border border-slate-700/60 bg-slate-950/80 px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-slate-300">
            <Loader2 size={11} className="animate-spin" /> Načítám starší historii
          </div>
        ) : null}
        {historyError ? (
          <div className="pointer-events-none absolute bottom-3 left-3 z-[650] max-w-[360px] rounded-md border border-amber-500/40 bg-amber-950/90 px-2 py-1 text-[9px] font-semibold text-amber-100">
            Starší historie není dostupná: {historyError}
          </div>
        ) : null}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-[10px] font-black uppercase tracking-wider text-slate-500">
            <Loader2 size={18} className="animate-spin text-emerald-500" /> Načítám {config.root}
          </div>
        )}
        {!loading && error && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-xs font-bold text-rose-400">{error}</div>
        )}
      </div>
    </div>
  );
};

const AlphaTradeChartWorkspace: React.FC<AlphaTradeChartWorkspaceProps> = ({
  trade,
  entryMs,
  exitMs,
  initialRoot,
  initialCandles,
  isDark,
  onClose,
  backtestSession,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workspaceShellRef = useRef<HTMLDivElement>(null);
  const workspaceViewportRef = useRef<HTMLDivElement>(null);
  const replayToolbarRef = useRef<HTMLDivElement>(null);
  const savedLayoutId = backtestSession?.workspaceState?.layoutId as ChartWorkspaceLayoutId | undefined;
  const initialLayoutIdRef = useRef<ChartWorkspaceLayoutId>(
    savedLayoutId && getChartWorkspaceLayout(savedLayoutId).id === savedLayoutId ? savedLayoutId : loadLayoutId(),
  );
  const nextPanelNumberRef = useRef(getChartWorkspaceLayout(initialLayoutIdRef.current).panelCount + 1);
  const [status, setStatus] = useState('Layout je možné přetahovat a měnit jeho velikost');
  const [activePanelId, setActivePanelId] = useState(backtestSession?.workspaceState?.activePanelId || 'alphatrade-chart-1');
  const [reviewTradeId, setReviewTradeId] = useState<string | null>(null);
  const [replay, setReplay] = useState<ChartReplayState>(backtestSession?.initialReplay ?? DEFAULT_CHART_REPLAY_STATE);
  const [replaySelectionTime, setReplaySelectionTime] = useState<number | null>(null);
  // Pásmo bere z nastavení grafu, aby Go To ukazovalo stejná čísla jako časová
  // osa. Sleduje i změnu v Nastavení grafu, jinak by po přepnutí zóny nabízelo
  // časy z jiného světa.
  const [chartTimeZone, setChartTimeZone] = useState(
    () => loadChartSettings(isDark, activePanelId).symbol.timeZone || DEFAULT_REPLAY_GO_TO_TIME_ZONE,
  );
  const [chartTradingSettings, setChartTradingSettings] = useState<ChartTradingSettings>(
    () => loadChartSettings(isDark, activePanelId).trading,
  );
  // Nastavení je od téhle chvíle po panelech, takže lišta ukazuje hodnoty
  // aktivního grafu — a přepnutí panelu je načte znovu.
  useEffect(() => {
    const apply = (settings: ChartSettings) => {
      setChartTimeZone(settings.symbol.timeZone || DEFAULT_REPLAY_GO_TO_TIME_ZONE);
      setChartTradingSettings(settings.trading);
    };
    apply(loadChartSettings(isDark, activePanelId));
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{
        settings?: ChartSettings;
        target?: PanelSettingsTarget;
        reload?: boolean;
      }>).detail;
      if (!detail) return;
      if (detail.reload) return apply(loadChartSettings(isDark, activePanelId));
      if (!detail.settings || !panelSettingsTargetMatches(detail.target, activePanelId)) return;
      apply(detail.settings);
    };
    window.addEventListener(CHART_SETTINGS_EVENT, sync);
    return () => window.removeEventListener(CHART_SETTINGS_EVENT, sync);
  }, [activePanelId, isDark]);
  const chartTimeZoneLabel = useMemo(
    () => CHART_TIME_ZONES.find(zone => zone.id === chartTimeZone)?.label ?? chartTimeZone,
    [chartTimeZone],
  );
  const [goToSettings, setGoToSettings] = useState<ReplayGoToSettings>(
    () => loadReplayGoToSettings(loadChartSettings(isDark, activePanelId).symbol.timeZone || DEFAULT_REPLAY_GO_TO_TIME_ZONE),
  );
  const [replayToolbarPosition, setReplayToolbarPosition] = useState<ReplayToolbarPosition | null>(loadReplayToolbarPosition);
  const [layoutId, setLayoutId] = useState<ChartWorkspaceLayoutId>(initialLayoutIdRef.current);
  const [layoutPickerOpen, setLayoutPickerOpen] = useState(false);
  const [syncSettings, setSyncSettings] = useState<ChartWorkspaceSyncSettings>(() => ({
    ...loadSyncSettings(),
    ...backtestSession?.workspaceState?.syncSettings,
  }));
  const panelControlsRef = useRef<Map<string, WorkspacePanelControl>>(new Map());
  const [panelControls, setPanelControls] = useState<Map<string, WorkspacePanelControl>>(panelControlsRef.current);
  const [workspaceHistory] = useState(() => new ChartWorkspaceHistory());
  const restoredSessionLayoutRef = useRef(false);
  const restoredSessionPanelsRef = useRef(false);
  const replayChangeRef = useRef(backtestSession?.onReplayChange);
  const workspaceChangeRef = useRef(backtestSession?.onWorkspaceChange);
  replayChangeRef.current = backtestSession?.onReplayChange;
  workspaceChangeRef.current = backtestSession?.onWorkspaceChange;
  const beginReplayToolbarDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const toolbar = replayToolbarRef.current;
    const viewport = workspaceViewportRef.current;
    if (!toolbar || !viewport) return;
    event.preventDefault();
    event.stopPropagation();

    const viewportRect = viewport.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    const grabOffsetX = event.clientX - toolbarRect.left;
    const grabOffsetY = event.clientY - toolbarRect.top;
    let finalPosition: ReplayToolbarPosition = {
      left: toolbarRect.left - viewportRect.left,
      top: toolbarRect.top - viewportRect.top,
    };

    toolbar.style.transform = 'none';
    toolbar.style.bottom = 'auto';
    toolbar.style.left = `${finalPosition.left}px`;
    toolbar.style.top = `${finalPosition.top}px`;

    const moveToolbar = (pointerEvent: PointerEvent) => {
      const latestViewportRect = viewport.getBoundingClientRect();
      const maxLeft = Math.max(0, latestViewportRect.width - toolbar.offsetWidth);
      const maxTop = Math.max(0, latestViewportRect.height - toolbar.offsetHeight);
      finalPosition = {
        left: Math.min(maxLeft, Math.max(0, pointerEvent.clientX - latestViewportRect.left - grabOffsetX)),
        top: Math.min(maxTop, Math.max(0, pointerEvent.clientY - latestViewportRect.top - grabOffsetY)),
      };
      toolbar.style.left = `${finalPosition.left}px`;
      toolbar.style.top = `${finalPosition.top}px`;
    };
    const finishToolbarDrag = () => {
      window.removeEventListener('pointermove', moveToolbar);
      window.removeEventListener('pointerup', finishToolbarDrag);
      window.removeEventListener('pointercancel', finishToolbarDrag);
      setReplayToolbarPosition(finalPosition);
      try {
        window.localStorage.setItem(REPLAY_TOOLBAR_POSITION_KEY, JSON.stringify(finalPosition));
      } catch {
        // Position persistence is optional; dragging still works without storage.
      }
    };

    window.addEventListener('pointermove', moveToolbar);
    window.addEventListener('pointerup', finishToolbarDrag, { once: true });
    window.addEventListener('pointercancel', finishToolbarDrag, { once: true });
  }, []);
  const registerPanel = useCallback((id: string, control: WorkspacePanelControl) => {
    const next = new Map(panelControlsRef.current);
    next.set(id, control);
    panelControlsRef.current = next;
    setPanelControls(next);
    setActivePanelId(current => current || id);
  }, []);
  const openBacktestTradeReview = useCallback((tradeId: string) => setReviewTradeId(tradeId), []);
  const unregisterPanel = useCallback((id: string) => {
    const next = new Map(panelControlsRef.current);
    next.delete(id);
    panelControlsRef.current = next;
    setPanelControls(next);
    setActivePanelId(active => active === id ? (next.keys().next().value || '') : active);
  }, []);
  const beginReplaySelection = useCallback(() => {
    setReplaySelectionTime(null);
    setReplay(current => current.phase === 'selecting'
      ? DEFAULT_CHART_REPLAY_STATE
      : { ...current, phase: 'selecting', playing: false });
    setStatus('Klikni do libovolného grafu na svíčku, od které chceš replay spustit');
  }, []);
  const selectReplayStart = useCallback((requestedTime: number) => {
    // The chart that received the click already snaps the requested timestamp
    // to one of its own candles. Trust that value here: activePanelId is
    // intentionally updated by the same pointer event and React state would
    // otherwise still point at the previously active pane for this one tick.
    if (!Number.isFinite(requestedTime)) return;
    const cursorTime = requestedTime;
    setReplaySelectionTime(null);
    setReplay(current => ({
      ...current,
      phase: 'active',
      cursorTime,
      startTime: cursorTime,
      playing: false,
    }));
    setStatus('Bar Replay spuštěn');
  }, []);
  const advanceReplayBy = useCallback((steps: number) => {
    setReplay(current => {
      if (current.phase !== 'active') return current;
      const source = backtestSession?.candlesByRoot.MNQ
        ?? panelControlsRef.current.get(activePanelId)?.rawCandles
        ?? [];
      const nextTime = advanceReplayTimeByInterval(
        source,
        current.cursorTime,
        current.stepMinutes ?? 1,
        steps,
      );
      if (nextTime === null) return { ...current, playing: false };
      return { ...current, cursorTime: nextTime };
    });
  }, [activePanelId, backtestSession?.candlesByRoot.MNQ]);
  const advanceReplay = useCallback(() => advanceReplayBy(1), [advanceReplayBy]);
  /** Koalescence držené šipky: kroky se sbírají a aplikují jednou za snímek. */
  const pendingStepsRef = useRef(0);
  const stepFrameRef = useRef<number | null>(null);
  const replayGoTo = useCallback((request: ReplayGoToRequest) => {
    if (replay.phase !== 'active') return;
    const source = backtestSession?.candlesByRoot.MNQ
      ?? panelControlsRef.current.get(activePanelId)?.rawCandles
      ?? [];
    const result = resolveReplayGoTo(request, {
      candles: source,
      cursorTime: replay.cursorTime,
      settings: goToSettings,
      timeZone: chartTimeZone,
      // Konec session, ne konec už načtených svíček — backtest dotahuje data po
      // blocích a cíl skoro vždy leží až za posledním načteným barem.
      dataEndTime: backtestSession ? Math.floor(backtestSession.endMs / 1_000) : null,
    });
    if (result.kind === 'error') {
      setStatus(`Go To: ${REPLAY_GO_TO_FAILURE_MESSAGES[result.reason]}`);
      return;
    }
    // Pauza je záměr: po skoku má uživatel rozhodnout, kdy se trh rozjede.
    setReplay(current => ({ ...current, cursorTime: result.value.cursorTime, playing: false }));
    setStatus(`Go To: ${goToTimeLabel(result.value.targetTime, chartTimeZone)}`);
  }, [activePanelId, backtestSession, chartTimeZone, goToSettings, replay.cursorTime, replay.phase]);
  useEffect(() => {
    if (replay.phase !== 'active' || !replay.playing) return;
    const delay = chartReplayDelayMs(replay.speed);
    let lastAdvanceAt = performance.now();
    const tick = () => {
      const now = performance.now();
      const dueSteps = Math.floor((now - lastAdvanceAt) / delay);
      if (dueSteps < 1) return;
      lastAdvanceAt += dueSteps * delay;
      advanceReplayBy(Math.min(dueSteps, 100));
    };
    const timer = window.setInterval(tick, Math.min(delay, 50));
    return () => window.clearInterval(timer);
  }, [advanceReplayBy, replay.phase, replay.playing, replay.speed]);
  useEffect(() => {
    if (!replayToolbarPosition) return;
    const clampToolbarPosition = () => {
      const toolbar = replayToolbarRef.current;
      const viewport = workspaceViewportRef.current;
      if (!toolbar || !viewport) return;
      const next = {
        left: Math.min(Math.max(0, viewport.clientWidth - toolbar.offsetWidth), Math.max(0, replayToolbarPosition.left)),
        top: Math.min(Math.max(0, viewport.clientHeight - toolbar.offsetHeight), Math.max(0, replayToolbarPosition.top)),
      };
      if (next.left === replayToolbarPosition.left && next.top === replayToolbarPosition.top) return;
      setReplayToolbarPosition(next);
      try {
        window.localStorage.setItem(REPLAY_TOOLBAR_POSITION_KEY, JSON.stringify(next));
      } catch {
        // Position persistence is optional.
      }
    };
    window.addEventListener('resize', clampToolbarPosition);
    clampToolbarPosition();
    return () => window.removeEventListener('resize', clampToolbarPosition);
  }, [replayToolbarPosition]);
  const activatePanel = useCallback((id: string) => {
    if (id === activePanelId) return;
    const source = panelControlsRef.current.get(activePanelId)?.drawingEngine;
    const target = panelControlsRef.current.get(id)?.drawingEngine;
    transferArmedDrawingTool(source, target);
    setActivePanelId(id);
  }, [activePanelId]);
  const initialLayout = useMemo(
    () => buildWorkspaceLayout(initialRoot, initialLayoutIdRef.current),
    [initialRoot],
  );
  const workspace = useMemo<WorkspaceManager>(() => {
    const manager = createWorkspace({
      id: backtestSession ? `alphatrade-backtest-${backtestSession.id}` : 'alphatrade-market-workspace',
      storage: new LocalStoragePersistence(window.localStorage, backtestSession ? `alphatrade.candlekit.backtest.${backtestSession.id}` : 'alphatrade.candlekit'),
      initialLayout,
    });
    manager.registerPanel({
      kind: WORKSPACE_KIND,
      component: ResilientWorkspacePanel,
      displayName: 'MNQ / NQ graf',
      defaultConfig: () => panelConfig(initialRoot, '1m'),
    });
    return manager;
  }, [backtestSession?.id, initialLayout, initialRoot]);

  useEffect(() => {
    if (!backtestSession || restoredSessionLayoutRef.current) return;
    const saved = backtestSession.workspaceState?.layout;
    if (saved) {
      try { workspace.importLayout(saved as Parameters<WorkspaceManager['importLayout']>[0]); } catch { /* invalid old snapshot */ }
    }
    restoredSessionLayoutRef.current = true;
  }, [backtestSession, workspace]);

  const context = useMemo<WorkspaceDataContextValue>(() => ({
    trade,
    entryMs,
    exitMs,
    initialRoot,
    initialCandles,
    backtestSession,
    isDark,
    activePanelId,
    replay,
    replaySelectionTime,
    setReplaySelectionTime,
    selectReplayStart,
    activatePanel,
    registerPanel,
    unregisterPanel,
    // Přes ref, protože akce vzniká až pod kontextem (potřebuje replay svíčku).
    onPositionQuickOrder: backtestSession?.onQuickOrder
      ? () => positionQuickOrderRef.current()
      : undefined,
    tradingSettings: chartTradingSettings,
    openBacktestTradeReview,
  }), [activatePanel, activePanelId, backtestSession, chartTradingSettings, entryMs, exitMs, initialCandles, initialRoot, isDark, openBacktestTradeReview, registerPanel, replay, replaySelectionTime, selectReplayStart, trade, unregisterPanel]);
  const activeControl = panelControls.get(activePanelId) ?? null;
  const reviewTrade = reviewTradeId
    ? backtestSession?.journalTrades?.find(candidate => String(candidate.id) === reviewTradeId)
    : undefined;
  const captureVisibleCharts = useCallback(async () => {
    const workspaceElement = workspaceShellRef.current;
    if (!workspaceElement || panelControlsRef.current.size === 0) {
      throw new Error('Grafy ještě nejsou připravené.');
    }
    return captureChartWorkspaceSnapshotDataUrl(workspaceElement, isDark);
  }, [isDark]);
  const activeIndicatorCount = activeControl ? countChartIndicators(
    [
      activeControl.config.showFvg,
      activeControl.config.showLevels,
      activeControl.config.showStructure,
    ],
    activeControl.activeLibraryIndicators,
  ) : 0;
  const removeActiveIndicators = useCallback(() => {
    if (!activeControl) return;
    activeControl.indicatorController.clear();
    activeControl.updateConfig({ showFvg: false, showLevels: false, showStructure: false });
  }, [activeControl]);
  const drawingEngines = useMemo(
    () => [...new Set([...panelControls.values()].map(control => control.drawingEngine).filter((engine): engine is CandleKitDrawingEngine => Boolean(engine)))],
    [panelControls],
  );
  // Dev diagnostika: přístup k enginům z konzole pro měření sync cesty.
  if (import.meta.env.DEV) {
    (window as unknown as { __atDrawingEngines?: unknown }).__atDrawingEngines = drawingEngines;
  }
  const [workspaceHistoryState, setWorkspaceHistoryState] = useState<ChartWorkspaceHistoryState>({ canUndo: false, canRedo: false });
  const [selectedFib, setSelectedFib] = useState<{ engine: CandleKitDrawingEngine; drawing: FibDrawing } | null>(null);
  const [selectedPosition, setSelectedPosition] = useState<{ engine: CandleKitDrawingEngine; drawing: PositionDrawing } | null>(null);
  const [selectedDrawing, setSelectedDrawing] = useState<{ engine: CandleKitDrawingEngine; drawing: Drawing } | null>(null);
  const [fibSettingsOpen, setFibSettingsOpen] = useState(false);
  const [positionSettingsOpen, setPositionSettingsOpen] = useState(false);
  const [drawingSettingsOpen, setDrawingSettingsOpen] = useState(false);
  const [quickOrderFeedback, setQuickOrderFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const positionQuickOrderRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!quickOrderFeedback) return;
    const timer = window.setTimeout(() => setQuickOrderFeedback(null), 2_600);
    return () => window.clearTimeout(timer);
  }, [quickOrderFeedback]);

  useEffect(() => {
    const engine = activeControl?.drawingEngine;
    if (!engine) {
      setSelectedFib(null);
      setSelectedPosition(null);
      setSelectedDrawing(null);
      setFibSettingsOpen(false);
      setPositionSettingsOpen(false);
      setDrawingSettingsOpen(false);
      return;
    }
    const sync = () => {
      const selectedId = engine.getSelectedId();
      const drawing = selectedId ? engine.getById(selectedId) : undefined;
      if (drawing?.tool === 'FibRetracement') {
        setSelectedFib({ engine, drawing: drawing as FibDrawing });
        setSelectedPosition(null);
        setSelectedDrawing(null);
        setPositionSettingsOpen(false);
        setDrawingSettingsOpen(false);
      } else if (isPositionDrawing(drawing)) {
        setSelectedFib(null);
        setSelectedPosition({ engine, drawing });
        setSelectedDrawing(null);
        setFibSettingsOpen(false);
        setDrawingSettingsOpen(false);
      } else {
        setSelectedFib(null);
        setSelectedPosition(null);
        setFibSettingsOpen(false);
        setPositionSettingsOpen(false);
        setSelectedDrawing(drawing && !drawing.id.startsWith('auto-') ? { engine, drawing } : null);
        if (!drawing || drawing.id.startsWith('auto-')) setDrawingSettingsOpen(false);
        else if (drawing.tool === 'Text' && !drawing.style.text?.trim()) setDrawingSettingsOpen(true);
      }
    };
    sync();
    return engine.onChange(sync);
  }, [activeControl?.drawingEngine]);

  useEffect(() => {
    workspaceHistory.updatePanels(panelControls);
  }, [panelControls, workspaceHistory]);

  useEffect(() => workspaceHistory.subscribe(setWorkspaceHistoryState), [workspaceHistory]);

  useEffect(() => {
    if (!backtestSession || restoredSessionPanelsRef.current) return;
    const snapshot = backtestSession.workspaceState?.panels;
    if (!snapshot || Object.keys(snapshot).length === 0) {
      restoredSessionPanelsRef.current = true;
      return;
    }
    if (panelControls.size < Object.keys(snapshot).length) return;
    const frame = window.requestAnimationFrame(() => {
      workspaceHistory.importSnapshot(snapshot);
      restoredSessionPanelsRef.current = true;
      setStatus('Session obnovena včetně kreseb, indikátorů a měřítek');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [backtestSession, panelControls, workspaceHistory]);

  useEffect(() => {
    if (!backtestSession?.id) return;
    replayChangeRef.current?.(replay);
  }, [backtestSession?.id, replay]);

  useEffect(() => {
    if (!backtestSession || replay.phase !== 'off') return;
    const first = backtestSession.candlesByRoot.MNQ?.[0];
    if (!first) return;
    setReplay({ phase: 'active', cursorTime: first.time, startTime: first.time, playing: false, speed: 1 });
  }, [backtestSession, replay.phase]);

  useEffect(() => {
    if (!backtestSession) return;
    let lastFingerprint = '';
    const checkpoint = () => {
      const state = {
        layout: workspace.exportLayout(),
        panels: workspaceHistory.exportSnapshot(),
        layoutId,
        activePanelId,
        syncSettings,
        // Vzhled musí být součástí otisku, jinak by se změna barvy levelu
        // uložila až s příští úpravou layoutu nebo kresby.
        appearance: chartAppearanceSnapshot(),
      };
      const fingerprint = JSON.stringify(state);
      if (fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      workspaceChangeRef.current?.(state);
    };
    const timer = window.setInterval(checkpoint, 1_200);
    const handleVisibility = () => { if (document.visibilityState === 'hidden') checkpoint(); };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
      checkpoint();
    };
  }, [activePanelId, backtestSession?.id, layoutId, syncSettings, workspace, workspaceHistory]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const command = event.metaKey || event.ctrlKey;
      if (!command) return;
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) workspaceHistory.redo();
        else workspaceHistory.undo();
      } else if (event.ctrlKey && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        workspaceHistory.redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspaceHistory]);

  // Mezerník přehrává, šipka doprava krokuje o svíčku. Obojí jen v běžícím
  // replay a mimo formulářová pole — jinak by mezerník nešel napsat do poznámky
  // a šipka by neposunula kurzor v ceně objednávky.
  useEffect(() => {
    if (replay.phase !== 'active') return;
    const handleReplayKey = (event: KeyboardEvent) => {
      // `instanceof Element` není zbytečné: cílem může být i window (událost
      // poslaná programově), a ten `closest` nemá — výjimka by zkratku shodila.
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const shortcut = chartReplayShortcut(event);
      if (!shortcut) return;
      // Mezerník jinak odscrolluje stránku, šipka posune časovou osu grafu.
      event.preventDefault();
      if (shortcut === 'step-forward') {
        // Držená šipka opakuje keydown až 30× za sekundu — víc, než stihne
        // jeden render cyklus. Kroky se proto sbírají a aplikují jednou za
        // snímek; při zdravém frameratu je to pořád krok na stisk, při
        // pomalém se slijí do jednoho posunu místo fronty trhaných renderů.
        pendingStepsRef.current += 1;
        if (stepFrameRef.current === null) {
          stepFrameRef.current = window.requestAnimationFrame(() => {
            stepFrameRef.current = null;
            const steps = pendingStepsRef.current;
            pendingStepsRef.current = 0;
            if (steps > 0) advanceReplayBy(steps);
          });
        }
        return;
      }
      setReplay(current => current.phase === 'active'
        ? { ...current, playing: !current.playing }
        : current);
    };
    window.addEventListener('keydown', handleReplayKey);
    return () => {
      window.removeEventListener('keydown', handleReplayKey);
      if (stepFrameRef.current !== null) {
        window.cancelAnimationFrame(stepFrameRef.current);
        stepFrameRef.current = null;
        pendingStepsRef.current = 0;
      }
    };
  }, [advanceReplayBy, replay.phase]);

  const updateSyncSetting = useCallback((key: keyof ChartWorkspaceSyncSettings, value: boolean) => {
    setSyncSettings(current => {
      const next = { ...current, [key]: value };
      try { window.localStorage.setItem(WORKSPACE_SYNC_STORAGE_KEY, JSON.stringify(next)); } catch { /* private storage */ }
      return next;
    });
  }, []);

  const updateInstrument = useCallback((root: MarketRoot) => {
    if (backtestSession && !backtestSession.allowedRoots.includes(root)) return;
    if (!activeControl) return;
    if (syncSettings.symbol) {
      panelControlsRef.current.forEach(control => control.updateConfig({ root }));
      setStatus(`Symbol ${root} synchronizován ve všech grafech`);
    } else {
      activeControl.updateConfig({ root });
    }
  }, [activeControl, backtestSession, syncSettings.symbol]);

  const updateTimeframe = useCallback((timeframe: MarketTimeframe) => {
    if (!activeControl) return;
    if (syncSettings.interval) {
      panelControlsRef.current.forEach(control => control.updateConfig({ timeframe }));
      setStatus(`Interval ${timeframe} synchronizován ve všech grafech`);
    } else {
      activeControl.updateConfig({ timeframe });
    }
  }, [activeControl, syncSettings.interval]);

  const applyWorkspaceLayout = useCallback((nextLayoutId: ChartWorkspaceLayoutId) => {
    const template = getChartWorkspaceLayout(nextLayoutId);
    const existing = [...panelControlsRef.current.entries()]
      .sort(([left], [right]) => panelOrder(left) - panelOrder(right))
      .map(([, control]) => ({ ...control.config }));
    const fallback = activeControl?.config ?? panelConfig(initialRoot, '1m');
    const defaultTimeframes: MarketTimeframe[] = ['1m', '5m', '15m', '1d'];
    const configs = Array.from({ length: template.panelCount }, (_, index) => (
      existing[index]
        ? { ...existing[index] }
        : { ...fallback, timeframe: defaultTimeframes[index] ?? fallback.timeframe }
    ));
    const now = new Date().toISOString();
    workspace.importLayout({
      version: 1,
      id: workspace.id,
      name: `layout-${nextLayoutId}`,
      createdAt: now,
      updatedAt: now,
      tree: buildWorkspaceLayout(initialRoot, nextLayoutId, configs),
      panels: {},
    });
    nextPanelNumberRef.current = template.panelCount + 1;
    setLayoutId(nextLayoutId);
    setActivePanelId(`${PANEL_ID_PREFIX}1`);
    setLayoutPickerOpen(false);
    try { window.localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, nextLayoutId); } catch { /* private storage */ }
    setStatus(`Layout ${nextLayoutId} · ${template.panelCount} graf${template.panelCount === 1 ? '' : 'y'}`);
  }, [activeControl?.config, initialRoot, workspace]);

  useEffect(() => installChartWorkspaceSync(panelControls, syncSettings), [
    panelControls,
    syncSettings.crosshair,
    syncSettings.dateRange,
    syncSettings.time,
  ]);

  useEffect(() => {
    if (!syncSettings.drawings) return () => undefined;
    const activeEngine = activeControl?.drawingEngine;
    const orderedEngines = activeEngine
      ? [activeEngine, ...drawingEngines.filter(engine => engine !== activeEngine)]
      : drawingEngines;
    return installWorkspaceDrawingSync(orderedEngines);
  }, [activeControl?.drawingEngine, drawingEngines, syncSettings.drawings]);

  const resetWorkspace = useCallback(() => {
    workspace.importLayout({
      version: 1,
      id: workspace.id,
      name: 'default',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tree: buildWorkspaceLayout(initialRoot, '2h'),
      panels: {},
    });
    setLayoutId('2h');
    nextPanelNumberRef.current = 3;
    try { window.localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, '2h'); } catch { /* private storage */ }
    setActivePanelId('alphatrade-chart-1');
    setStatus('Výchozí rozložení obnoveno');
  }, [initialRoot, workspace]);

  const saveWorkspace = useCallback(async () => {
    await workspace.saveLayout(SAVED_LAYOUT_NAME);
    setStatus('Rozložení uloženo');
  }, [workspace]);

  const loadWorkspace = useCallback(async () => {
    const layouts = await workspace.listLayouts();
    if (!layouts.some(layout => layout.name === SAVED_LAYOUT_NAME)) {
      setStatus('Zatím není uložené žádné rozložení');
      return;
    }
    await workspace.loadLayout(SAVED_LAYOUT_NAME);
    setActivePanelId('');
    setStatus('Uložené rozložení načteno');
  }, [workspace]);

  const exportWorkspace = useCallback(() => {
    const blob = new Blob([JSON.stringify(workspace.exportLayout(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'alphatrade-workspace.json';
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus('Rozložení exportováno');
  }, [workspace]);

  const importWorkspace = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      workspace.importLayout(JSON.parse(await file.text()));
      setStatus('Rozložení importováno');
    } catch {
      setStatus('Soubor neobsahuje platné rozložení');
    } finally {
      event.target.value = '';
    }
  }, [workspace]);

  const centerMainSplit = useCallback(() => {
    const exported = workspace.exportLayout() as {
      tree?: { layout?: { children?: Array<Record<string, unknown>> } };
    };
    const next = typeof structuredClone === 'function'
      ? structuredClone(exported)
      : JSON.parse(JSON.stringify(exported));
    const children = next.tree?.layout?.children;
    if (!Array.isArray(children) || children.length < 2) return;
    const equalWeight = 100 / children.length;
    children.forEach(child => { child.weight = equalWeight; });
    workspace.importLayout(next);
    setStatus('Grafy vycentrovány');
  }, [workspace]);

  useEffect(() => {
    const shell = workspaceShellRef.current;
    if (!shell) return;
    const handleDoubleClick = (event: MouseEvent) => {
      if ((event.target as Element).closest('.flexlayout__splitter')) {
        event.preventDefault();
        event.stopPropagation();
        centerMainSplit();
        return;
      }
      if (selectedFib || selectedPosition || selectedDrawing) {
        event.preventDefault();
        event.stopPropagation();
        if (selectedFib) setFibSettingsOpen(true);
        else if (selectedPosition) setPositionSettingsOpen(true);
        else setDrawingSettingsOpen(true);
      }
    };
    const handleWheel = () => workspaceHistory.captureAfterEvent('změnu měřítka grafu');
    const handlePointerUp = () => workspaceHistory.captureAfterEvent('posun nebo změnu měřítka grafu');
    shell.addEventListener('dblclick', handleDoubleClick, true);
    shell.addEventListener('wheel', handleWheel, true);
    shell.addEventListener('pointerup', handlePointerUp, true);
    return () => {
      shell.removeEventListener('dblclick', handleDoubleClick, true);
      shell.removeEventListener('wheel', handleWheel, true);
      shell.removeEventListener('pointerup', handlePointerUp, true);
    };
  }, [centerMainSplit, selectedDrawing, selectedFib, selectedPosition, workspaceHistory]);

  const topButton = `h-8 inline-flex items-center gap-1.5 px-2 rounded-md text-[9px] font-bold transition-colors ${isDark ? 'text-slate-400 hover:bg-white/5 hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'}`;
  const topDivider = `h-6 w-px shrink-0 ${isDark ? 'bg-white/10' : 'bg-slate-200'}`;
  const replaySource = backtestSession?.candlesByRoot.MNQ ?? activeControl?.rawCandles ?? [];
  const replayAtEnd = isReplayAtLatestCandle(replaySource, replay.cursorTime);
  // Poslední odhalená svíčka. Dřív se tu při každém renderu kopírovalo
  // a otáčelo celé pole svíček a hledalo se lineárně — na delší historii
  // to byly tři průchody tisíci prvky na jedno překreslení. Svíčky jsou
  // seřazené, takže stačí půlení intervalu.
  const replayCandle = useMemo(() => {
    if (replay.cursorTime === null || replaySource.length === 0) return null;
    let low = 0;
    let high = replaySource.length - 1;
    let found: MarketCandle | null = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (replaySource[mid].time <= replay.cursorTime) { found = replaySource[mid]; low = mid + 1; }
      else high = mid - 1;
    }
    return found;
  }, [replaySource, replay.cursorTime]);
  const tradingPanel = backtestSession?.renderTradingPanel?.({ replay, candle: replayCandle, instrument: 'MNQ' });
  const selectedPositionInstrument = activeControl?.config.root ?? initialRoot;
  const quickOrderDisabledReason = !replayCandle
    ? 'Quick Order není dostupný bez aktuální replay ceny'
    : backtestSession && selectedPositionInstrument !== backtestSession.executionInstrument
      ? `Quick Order lze zadat jen z ${backtestSession.executionInstrument} grafu`
      : null;
  const submitSelectedPositionQuickOrder = () => {
    if (!backtestSession?.onQuickOrder) return;
    // Z kontextového menu se sem dá kliknout i v situaci, kdy to nejde —
    // tichý návrat by vypadal jako rozbitá položka, tak řekni důvod.
    if (quickOrderDisabledReason) {
      setStatus(quickOrderDisabledReason);
      return;
    }
    if (!selectedPosition) {
      setStatus('Rychlá objednávka potřebuje vybraný position box');
      return;
    }
    const result = backtestSession.onQuickOrder({
      drawing: selectedPosition.drawing,
      candle: replayCandle,
      instrument: selectedPositionInstrument,
    });
    if (result.ok) selectedPosition.engine.remove(selectedPosition.drawing.id);
    setQuickOrderFeedback(result);
    setStatus(result.message);
  };
  positionQuickOrderRef.current = submitSelectedPositionQuickOrder;
  return (
    <div className={`fixed inset-0 z-[300] flex flex-col ${isDark ? 'dark bg-[#070a0f] text-slate-100' : 'bg-[#f4f6f8] text-slate-900'}`}>
      <div className={`h-12 shrink-0 flex items-center gap-1 px-2 border-b ${isDark ? 'border-white/10 bg-[#0d1219]' : 'border-slate-200 bg-white'}`}>
        <div className="flex items-center gap-2 mr-1 min-w-0">
          <img
            src="/logos/at_logo_light_clean.png"
            alt="Alpha Trade"
            className={`h-8 w-8 shrink-0 object-contain ${isDark ? 'drop-shadow-[0_0_12px_rgba(34,211,238,0.35)]' : ''}`}
          />
        </div>
        <select
          value={activeControl?.config.root ?? initialRoot}
          onChange={event => updateInstrument(event.target.value as MarketRoot)}
          disabled={!activeControl}
          className={`h-8 px-1.5 rounded-md border-0 bg-transparent outline-none text-[11px] font-black cursor-pointer ${isDark ? 'text-slate-100 hover:bg-white/5' : 'text-slate-950 hover:bg-slate-100'}`}
          aria-label="Instrument aktivního grafu"
        >
          {(backtestSession?.allowedRoots ?? ['MNQ', 'NQ']).map(root => (
            <option key={root} value={root}>{root}1!</option>
          ))}
        </select>
        <ChartTimeframePicker
          value={activeControl?.config.timeframe ?? '1m'}
          onChange={updateTimeframe}
          isDark={isDark}
          compact
        />
        {activeControl && <WorkspaceIndicatorMenu
          controller={activeControl.indicatorController}
          timeframe={activeControl.config.timeframe}
          isDark={isDark}
          inline
          custom={{
            showFvg: activeControl.config.showFvg,
            showLevels: activeControl.config.showLevels,
            showStructure: activeControl.config.showStructure,
            onToggleFvg: () => activeControl.updateConfig({ showFvg: !activeControl.config.showFvg }),
            onToggleLevels: () => activeControl.updateConfig({ showLevels: !activeControl.config.showLevels }),
            onToggleStructure: () => activeControl.updateConfig({ showStructure: !activeControl.config.showStructure }),
          }}
        />}
        <button
          type="button"
          className={`${topButton} px-2 ${replay.phase !== 'off' ? (isDark ? 'bg-white/10 text-white' : 'bg-slate-100 text-slate-950') : ''}`}
          onClick={beginReplaySelection}
          title={replay.phase === 'selecting' ? 'Zrušit výběr Bar Replay' : 'Bar Replay'}
          aria-label="Bar Replay"
          aria-pressed={replay.phase !== 'off'}
        ><Rewind size={15} fill={replay.phase !== 'off' ? 'currentColor' : 'none'} /></button>
        <button
          type="button"
          className={topButton}
          onClick={() => activeControl?.focusTrade()}
          disabled={!activeControl}
          title="Zaměřit aktivní graf na obchod"
        ><LocateFixed size={14} /><span className="hidden xl:inline">Obchod</span></button>
        <span className={topDivider} />
        <button type="button" className={topButton} onClick={() => {
          const panelNumber = nextPanelNumberRef.current;
          nextPanelNumberRef.current += 1;
          workspace.addPanel(WORKSPACE_KIND, panelConfig(initialRoot, '1m'), `Graf ${panelNumber}`);
          setStatus('Nový panel přidán');
        }} title="Přidat nový graf"><Plus size={15} /> <span className="hidden md:inline">Graf</span></button>
        <span className={topDivider} />
        <button type="button" className={topButton} onClick={resetWorkspace} title="Obnovit výchozí rozložení"><RotateCcw size={14} /> <span className="hidden lg:inline">Reset</span></button>
        <button type="button" className={topButton} onClick={saveWorkspace} title="Uložit rozložení"><Save size={14} /> <span className="hidden lg:inline">Uložit</span></button>
        <div className="relative">
          <button
            type="button"
            className={`${topButton} ${layoutPickerOpen ? (isDark ? 'bg-white/10 text-white' : 'bg-slate-100 text-slate-950') : ''}`}
            onClick={() => setLayoutPickerOpen(open => !open)}
            title="Nastavení layoutu grafů"
            aria-label="Nastavení layoutu grafů"
            aria-expanded={layoutPickerOpen}
          >
            <CurrentChartLayoutGlyph id={layoutId} />
            <span className="hidden lg:inline">Layout</span>
          </button>
          {layoutPickerOpen && (
            <ChartLayoutPicker
              isDark={isDark}
              layoutId={layoutId}
              sync={syncSettings}
              onLayoutChange={applyWorkspaceLayout}
              onSyncChange={updateSyncSetting}
              onClose={() => setLayoutPickerOpen(false)}
            />
          )}
        </div>
        <button type="button" className={topButton} onClick={loadWorkspace} title="Načíst uložené rozložení"><LayoutGrid size={14} /> <span className="hidden xl:inline">Načíst</span></button>
        <span className={`${topDivider} hidden md:block`} />
        <button type="button" className={`${topButton} hidden md:inline-flex`} onClick={exportWorkspace} title="Exportovat workspace"><Download size={14} /></button>
        <button type="button" className={`${topButton} hidden md:inline-flex`} onClick={() => fileInputRef.current?.click()} title="Importovat workspace"><Upload size={14} /></button>
        <input ref={fileInputRef} type="file" accept="application/json" className="hidden" onChange={importWorkspace} />
        <span className={topDivider} />
        <button
          type="button"
          className={`${topButton} px-1.5 disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent`}
          onClick={() => workspaceHistory.undo()}
          disabled={!workspaceHistoryState.canUndo}
          title={workspaceHistoryState.undoLabel ? `Zpět: ${workspaceHistoryState.undoLabel} (⌘/Ctrl+Z)` : 'Zpět (⌘/Ctrl+Z)'}
          aria-label="Vrátit poslední změnu workspace"
        ><Undo2 size={15} /></button>
        <button
          type="button"
          className={`${topButton} px-1.5 disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent`}
          onClick={() => workspaceHistory.redo()}
          disabled={!workspaceHistoryState.canRedo}
          title={workspaceHistoryState.redoLabel ? `Dopředu: ${workspaceHistoryState.redoLabel} (Shift+⌘/Ctrl+Z)` : 'Dopředu (Shift+⌘/Ctrl+Z)'}
          aria-label="Opakovat poslední změnu workspace"
        ><Redo2 size={15} /></button>
        <span className="ml-auto hidden 2xl:block text-[8px] font-bold uppercase tracking-wider text-slate-600">{status}</span>
        <span className={topDivider} />
        <button type="button" className={`${topButton} px-2`} onClick={onClose} title="Zavřít fullscreen (Esc)"><Maximize2 size={14} className="rotate-180" /><span className="hidden sm:inline">Zpět</span></button>
        <button type="button" onClick={onClose} className={`w-8 h-8 inline-flex items-center justify-center rounded-md ${isDark ? 'text-slate-400 hover:bg-white/5 hover:text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-950'}`} aria-label="Zavřít fullscreen workspace"><X size={16} /></button>
      </div>
      <WorkspaceDataContext.Provider value={context}>
        <div ref={workspaceViewportRef} className={`relative flex-1 min-h-0 ${isDark ? 'bg-[#070a0f]' : 'bg-white'}`}>
          {quickOrderFeedback && <div
            role="status"
            className={`pointer-events-none absolute left-1/2 top-11 z-[700] -translate-x-1/2 rounded-md border px-3 py-2 text-[11px] font-bold shadow-lg ${quickOrderFeedback.ok
              ? isDark ? 'border-emerald-500/30 bg-[#10251d] text-emerald-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : isDark ? 'border-rose-500/30 bg-[#2a1519] text-rose-300' : 'border-rose-200 bg-rose-50 text-rose-700'}`}
          >{quickOrderFeedback.message}</div>}
          {selectedFib && <FibDrawingFloatingToolbar
            engine={selectedFib.engine}
            drawing={selectedFib.drawing}
            onOpenSettings={() => setFibSettingsOpen(true)}
          />}
          {selectedPosition && <PositionDrawingFloatingToolbar
            engine={selectedPosition.engine}
            drawing={selectedPosition.drawing}
            onClose={() => setPositionSettingsOpen(false)}
            onOpenSettings={() => setPositionSettingsOpen(true)}
            onQuickOrder={chartTradingSettings.quickOrderButton && backtestSession?.onQuickOrder ? submitSelectedPositionQuickOrder : undefined}
            quickOrderDisabled={Boolean(quickOrderDisabledReason)}
            quickOrderTitle={quickOrderDisabledReason ?? 'Quick Order — ihned zadat Market / Limit / Stop z position boxu'}
          />}
          {selectedDrawing && <GenericDrawingFloatingToolbar
            engine={selectedDrawing.engine}
            drawing={selectedDrawing.drawing}
            isDark={isDark}
            onOpenSettings={() => setDrawingSettingsOpen(true)}
          />}
          <AlphaTradeDrawingToolbar
            isDark={isDark}
            drawingEngine={activeControl?.drawingEngine ?? null}
            drawingEngines={drawingEngines}
            indicatorCount={activeIndicatorCount}
            onRemoveIndicators={removeActiveIndicators}
            docked
          />
          <div
            ref={workspaceShellRef}
            className={`alphatrade-candlekit-workspace absolute top-0 left-[52px] right-0 ${tradingPanel ? 'bottom-[88px]' : 'bottom-0'} ${isDark ? 'is-dark' : ''}`}
          >
            <FlexLayoutAdapter workspace={workspace} hideToolbar />
          </div>
          {tradingPanel && (
            <div className={`absolute bottom-0 left-[52px] right-0 z-40 h-[88px] border-t ${isDark ? 'border-white/10 bg-[#0d1219]' : 'border-slate-200 bg-white'}`}>
              {tradingPanel}
            </div>
          )}
          {replay.phase !== 'off' && (
            <div
              ref={replayToolbarRef}
              className={`absolute z-[650] flex h-10 items-center gap-0.5 rounded-lg border p-1 shadow-xl backdrop-blur-md ${isDark ? 'border-white/10 bg-[#101720]/95 text-slate-300 shadow-black/40' : 'border-slate-200 bg-white/95 text-slate-700 shadow-slate-900/15'}`}
              style={replayToolbarPosition
                ? { left: replayToolbarPosition.left, top: replayToolbarPosition.top }
                : { left: '50%', bottom: tradingPanel ? 100 : 12, transform: 'translateX(-50%)' }}
              role="toolbar"
              aria-label="Bar Replay ovládání"
            >
              <button
                type="button"
                className={`flex h-8 w-5 shrink-0 touch-none cursor-grab items-center justify-center rounded active:cursor-grabbing ${isDark ? 'text-slate-600 hover:bg-white/5 hover:text-slate-300' : 'text-slate-300 hover:bg-slate-100 hover:text-slate-500'}`}
                onPointerDown={beginReplayToolbarDrag}
                title="Přetáhnout Bar Replay panel"
                aria-label="Přetáhnout Bar Replay panel"
              ><GripVertical size={14} /></button>
              <button
                type="button"
                className={`${topButton} px-2 disabled:opacity-30`}
                disabled={replay.phase !== 'active' || replayAtEnd}
                onClick={() => setReplay(current => ({ ...current, playing: !current.playing }))}
                title={replay.playing ? 'Pozastavit' : 'Přehrát'}
                aria-label={replay.playing ? 'Pozastavit Bar Replay' : 'Přehrát Bar Replay'}
              >{replay.playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button>
              <button
                type="button"
                className={`${topButton} px-2 disabled:opacity-30`}
                disabled={replay.phase !== 'active' || replayAtEnd}
                onClick={advanceReplay}
                title="O jednu svíčku dopředu"
                aria-label="Bar Replay krok dopředu"
              ><StepForward size={15} /></button>
              <ReplayGoToMenu
                settings={goToSettings}
                onSettingsChange={setGoToSettings}
                onGoTo={replayGoTo}
                disabled={replay.phase !== 'active' || replayAtEnd}
                isDark={isDark}
                cursorTime={replay.cursorTime}
                timeZone={chartTimeZone}
                timeZoneLabel={chartTimeZoneLabel}
                buttonClassName={topButton}
              />
              <select
                value={replay.speed}
                onChange={event => setReplay(current => ({ ...current, speed: Number(event.target.value) as ChartReplaySpeed }))}
                className={`h-8 rounded-md border-0 px-2 text-[10px] font-bold outline-none ${isDark ? 'bg-transparent text-slate-300 hover:bg-white/5' : 'bg-transparent text-slate-700 hover:bg-slate-100'}`}
                aria-label="Rychlost Bar Replay"
                title="Rychlost Bar Replay"
              >
                {CHART_REPLAY_SPEEDS.map(speed => <option key={speed} value={speed}>{speed}x</option>)}
              </select>
              <select
                value={replay.stepMinutes ?? 1}
                onChange={event => setReplay(current => ({
                  ...current,
                  stepMinutes: Number(event.target.value) as ChartReplayStepMinutes,
                }))}
                className={`h-8 rounded-md border-0 px-2 text-[10px] font-bold outline-none ${isDark ? 'bg-transparent text-slate-300 hover:bg-white/5' : 'bg-transparent text-slate-700 hover:bg-slate-100'}`}
                aria-label="Timeframe kroku Bar Replay"
                title="Timeframe jednoho replay kroku"
              >
                {CHART_REPLAY_STEP_MINUTES.map(minutes => (
                  <option key={minutes} value={minutes}>{REPLAY_TIMEFRAME_LABELS[minutes]}</option>
                ))}
              </select>
            </div>
          )}
          {reviewTrade && backtestSession?.onTradeReviewSave ? (
            <BacktestTradeReviewDialog
              trade={reviewTrade}
              isDark={isDark}
              onClose={() => setReviewTradeId(null)}
              onCaptureSnapshot={captureVisibleCharts}
              onRecalculate={backtestSession.onTradeRecalculate
                ? () => backtestSession.onTradeRecalculate!(String(reviewTrade.id))
                : undefined}
              onSave={(updates, snapshotDataUrl) => backtestSession.onTradeReviewSave!(String(reviewTrade.id), updates, snapshotDataUrl)}
            />
          ) : null}
          {selectedFib && fibSettingsOpen && <FibDrawingSettingsDialog
            engine={selectedFib.engine}
            drawing={selectedFib.drawing}
            onClose={() => setFibSettingsOpen(false)}
          />}
          {selectedPosition && positionSettingsOpen && <PositionDrawingSettingsDialog
            key={selectedPosition.drawing.id}
            engine={selectedPosition.engine}
            drawing={selectedPosition.drawing}
            onClose={() => setPositionSettingsOpen(false)}
          />}
          {selectedDrawing && drawingSettingsOpen && <GenericDrawingSettingsDialog
            key={selectedDrawing.drawing.id}
            engine={selectedDrawing.engine}
            drawing={selectedDrawing.drawing}
            onClose={() => setDrawingSettingsOpen(false)}
          />}
        </div>
      </WorkspaceDataContext.Provider>
    </div>
  );
};

export default AlphaTradeChartWorkspace;
