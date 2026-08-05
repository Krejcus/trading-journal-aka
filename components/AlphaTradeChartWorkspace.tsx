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
  BarChart3,
  CalendarClock,
  Download,
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
  marketDataWindowForEntry,
  resolveMarketSymbol,
  type MarketCandle,
  type MarketTimeframe,
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
import FibDrawingSettingsDialog, {
  FibDrawingFloatingToolbar,
} from './FibDrawingSettingsDialog';
import type { FibDrawing } from '../services/chartFibDrawing';
import GenericDrawingFloatingToolbar from './GenericDrawingFloatingToolbar';
import GenericDrawingSettingsDialog from './GenericDrawingSettingsDialog';
import PositionDrawingSettingsDialog, { PositionDrawingFloatingToolbar } from './PositionDrawingSettingsDialog';
import { isPositionDrawing, type PositionDrawing } from '../services/chartPositionDrawing';
import { countChartIndicators } from '../services/chartContextMenu';
import {
  advanceReplayTime,
  chartReplayDelayMs,
  CHART_REPLAY_SPEEDS,
  DEFAULT_CHART_REPLAY_STATE,
  isReplayAtLatestCandle,
  revealReplayCandles,
  type ChartReplaySpeed,
  type ChartReplayState,
} from '../services/chartReplay';

export type MarketRoot = 'MNQ' | 'NQ';

export interface BacktestChartSessionBridge {
  id: string;
  startMs: number;
  endMs: number;
  candlesByRoot: Partial<Record<MarketRoot, MarketCandle[]>>;
  allowedRoots: MarketRoot[];
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
  }) => void;
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
    };
  } catch {
    return DEFAULT_SYNC_SETTINGS;
  }
};

const panelOrder = (id: string) => Number(id.replace(PANEL_ID_PREFIX, '')) || Number.MAX_SAFE_INTEGER;

const AlphaTradeWorkspacePanel: React.FC<{
  instance: PanelInstance<WorkspacePanelConfig>;
  updateConfig: (next: Partial<WorkspacePanelConfig>) => void;
}> = ({ instance, updateConfig }) => {
  const context = useContext(WorkspaceDataContext);
  if (!context) throw new Error('AlphaTrade workspace panel is missing its data context.');

  const config = { ...panelConfig(), ...instance.config };
  const sessionCandles = context.backtestSession?.candlesByRoot[config.root]
    ?? (config.root === context.initialRoot ? context.initialCandles : undefined);
  const [rawCandles, setRawCandles] = useState<MarketCandle[]>(
    sessionCandles ?? (config.root === context.initialRoot ? context.initialCandles : []),
  );
  const [loading, setLoading] = useState(sessionCandles ? false : config.root !== context.initialRoot);
  const [error, setError] = useState<string | null>(null);
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

  const replayRawCandles = useMemo(
    () => context.replay.phase === 'active'
      ? revealReplayCandles(rawCandles, context.replay.cursorTime)
      : rawCandles,
    [context.replay.cursorTime, context.replay.phase, rawCandles],
  );
  const candles = useMemo(
    () => aggregateCandles(replayRawCandles, config.timeframe),
    [replayRawCandles, config.timeframe],
  );
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
            compactToolbar
            indicatorController={indicatorController}
            focusRequest={focusRequest}
            hideFocusButton
            hideDrawingToolbar
            keyboardShortcutsActive={isActive}
            replayActive={context.replay.phase === 'active'}
            replayCursorTime={context.replay.cursorTime}
            replaySelecting={context.replay.phase === 'selecting'}
            replaySelectionCandles={rawCandles}
            replaySelectionTime={context.replaySelectionTime}
            onReplaySelectionTimeChange={context.setReplaySelectionTime}
            onReplayStart={context.selectReplayStart}
            onChartApiReady={handleChartApiReady}
            activeLibraryIndicators={activeLibraryIndicators}
            onToggleFvg={() => updatePanelConfig({ showFvg: !config.showFvg })}
            onToggleLevels={() => updatePanelConfig({ showLevels: !config.showLevels })}
            onToggleStructure={() => updatePanelConfig({ showStructure: !config.showStructure })}
          />
        )}
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
  const savedLayoutId = backtestSession?.workspaceState?.layoutId as ChartWorkspaceLayoutId | undefined;
  const initialLayoutIdRef = useRef<ChartWorkspaceLayoutId>(
    savedLayoutId && getChartWorkspaceLayout(savedLayoutId).id === savedLayoutId ? savedLayoutId : loadLayoutId(),
  );
  const nextPanelNumberRef = useRef(getChartWorkspaceLayout(initialLayoutIdRef.current).panelCount + 1);
  const [status, setStatus] = useState('Layout je možné přetahovat a měnit jeho velikost');
  const [activePanelId, setActivePanelId] = useState(backtestSession?.workspaceState?.activePanelId || 'alphatrade-chart-1');
  const [replay, setReplay] = useState<ChartReplayState>(backtestSession?.initialReplay ?? DEFAULT_CHART_REPLAY_STATE);
  const [replaySelectionTime, setReplaySelectionTime] = useState<number | null>(null);
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
  const registerPanel = useCallback((id: string, control: WorkspacePanelControl) => {
    const next = new Map(panelControlsRef.current);
    next.set(id, control);
    panelControlsRef.current = next;
    setPanelControls(next);
    setActivePanelId(current => current || id);
  }, []);
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
      const nextTime = advanceReplayTime(source, current.cursorTime, steps);
      if (nextTime === null) return { ...current, playing: false };
      return { ...current, cursorTime: nextTime };
    });
  }, [activePanelId, backtestSession?.candlesByRoot.MNQ]);
  const advanceReplay = useCallback(() => advanceReplayBy(1), [advanceReplayBy]);
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
      component: AlphaTradeWorkspacePanel,
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
  }), [activatePanel, activePanelId, backtestSession, entryMs, exitMs, initialCandles, initialRoot, isDark, registerPanel, replay, replaySelectionTime, selectReplayStart, trade, unregisterPanel]);
  const activeControl = panelControls.get(activePanelId) ?? null;
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
  const [workspaceHistoryState, setWorkspaceHistoryState] = useState<ChartWorkspaceHistoryState>({ canUndo: false, canRedo: false });
  const [selectedFib, setSelectedFib] = useState<{ engine: CandleKitDrawingEngine; drawing: FibDrawing } | null>(null);
  const [selectedPosition, setSelectedPosition] = useState<{ engine: CandleKitDrawingEngine; drawing: PositionDrawing } | null>(null);
  const [selectedDrawing, setSelectedDrawing] = useState<{ engine: CandleKitDrawingEngine; drawing: Drawing } | null>(null);
  const [fibSettingsOpen, setFibSettingsOpen] = useState(false);
  const [positionSettingsOpen, setPositionSettingsOpen] = useState(false);
  const [drawingSettingsOpen, setDrawingSettingsOpen] = useState(false);

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
  const replayCandle = replay.cursorTime === null ? null : [...replaySource].reverse().find(candle => candle.time <= replay.cursorTime) ?? null;
  const tradingPanel = backtestSession?.renderTradingPanel?.({ replay, candle: replayCandle, instrument: 'MNQ' });
  const formatReplayDate = (time: number | null) => time === null
    ? 'Vyber počáteční datum'
    : new Date(time * 1_000).toLocaleString('cs-CZ', {
      timeZone: 'Europe/Prague',
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className={`fixed inset-0 z-[300] flex flex-col ${isDark ? 'dark bg-[#070a0f] text-slate-100' : 'bg-[#f4f6f8] text-slate-900'}`}>
      <div className={`h-12 shrink-0 flex items-center gap-1 px-2 border-b ${isDark ? 'border-white/10 bg-[#0d1219]' : 'border-slate-200 bg-white'}`}>
        <div className="flex items-center gap-2 mr-1 min-w-0">
          <div className="w-8 h-8 rounded-full bg-[#2962ff] flex items-center justify-center text-white"><BarChart3 size={16} /></div>
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
        <div className={`relative flex-1 min-h-0 ${isDark ? 'bg-[#070a0f]' : 'bg-white'}`}>
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
            className={`alphatrade-candlekit-workspace absolute top-0 left-[52px] right-0 ${tradingPanel ? 'bottom-[126px]' : replay.phase === 'off' ? 'bottom-0' : 'bottom-[38px]'} ${isDark ? 'is-dark' : ''}`}
          >
            <FlexLayoutAdapter workspace={workspace} hideToolbar />
          </div>
          {tradingPanel && (
            <div className={`absolute bottom-[38px] left-[52px] right-0 z-40 h-[88px] border-t ${isDark ? 'border-white/10 bg-[#0d1219]' : 'border-slate-200 bg-white'}`}>
              {tradingPanel}
            </div>
          )}
          {replay.phase !== 'off' && (
            <div
              className={`absolute bottom-0 left-[52px] right-0 z-40 h-[38px] flex items-center justify-center gap-1 border-t ${isDark ? 'border-white/10 bg-[#0d1219] text-slate-300' : 'border-slate-200 bg-white text-slate-700'}`}
              role="toolbar"
              aria-label="Bar Replay ovládání"
            >
              <button
                type="button"
                className={`${topButton} min-w-[174px] justify-start`}
                onClick={beginReplaySelection}
                title="Vybrat jiný počáteční bod"
              ><CalendarClock size={14} /><span>{formatReplayDate(replay.startTime)}</span></button>
              <span className={topDivider} />
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
              <select
                value={replay.speed}
                onChange={event => setReplay(current => ({ ...current, speed: Number(event.target.value) as ChartReplaySpeed }))}
                className={`h-8 rounded-md border-0 px-2 text-[10px] font-bold outline-none ${isDark ? 'bg-transparent text-slate-300 hover:bg-white/5' : 'bg-transparent text-slate-700 hover:bg-slate-100'}`}
                aria-label="Rychlost Bar Replay"
                title="Rychlost Bar Replay"
              >
                {CHART_REPLAY_SPEEDS.map(speed => <option key={speed} value={speed}>{speed}x</option>)}
              </select>
              <button type="button" className={`${topButton} cursor-default px-2`} title="Interval aktualizace je podle zdrojových minutových dat">1m</button>
              <span className={topDivider} />
              <button
                type="button"
                className={`${topButton} px-2 disabled:opacity-30`}
                disabled={replay.phase !== 'active' || replaySource.length === 0}
                onClick={() => setReplay(current => ({
                  ...current,
                  phase: 'active',
                  cursorTime: replaySource.at(-1)?.time ?? current.cursorTime,
                  playing: false,
                }))}
                title="Přejít na aktuální konec dat"
                aria-label="Přejít na konec dostupných dat"
              ><LocateFixed size={15} /></button>
              <button
                type="button"
                className={`${topButton} px-2`}
                onClick={() => {
                  setReplaySelectionTime(null);
                  setReplay(DEFAULT_CHART_REPLAY_STATE);
                  setStatus('Bar Replay ukončen');
                }}
                title="Ukončit Bar Replay"
                aria-label="Ukončit Bar Replay"
              ><X size={16} /></button>
            </div>
          )}
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
