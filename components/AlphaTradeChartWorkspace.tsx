import { sharedRevealedCandles } from '../services/chartReplayPaint';
import TradeProgress from './TradeProgress';
import ChartWorkspaceMenu from './ChartWorkspaceMenu';
import { chartGlassBar, chartGlassButton, chartGlassGrip } from '../services/chartGlass';
import { historyAt, replayRevealKey, tradeTimelineEvents } from '../lib/tradeReplay';
import { candleReplayPath, partialReplayCandle, type PathPoint } from '../lib/candleReplayPath';
import { formingReplayBar, formingReplayBase } from '../services/chartReplayForming';
import { adoptJournalAppearance } from '../services/backtestAppearanceAdopt';
import { crossfadeChart } from '../lib/chartCrossfade';
import { captureTradeChartSnapshot } from '../lib/tradeChartSnapshot';
import { announceChartProfileChange } from '../services/chartProfileToast';
import { ChartWorkspaceLibraryDialog, WorkspaceImportPreview } from './ChartWorkspaceLibraryDialog';
import { saveWorkspaceTemplate } from '../services/chartWorkspaceLibrary';
import type { BacktestTagSuggestions } from '../services/backtestTagCatalog';
import type { TradeChartIndicators } from '../services/detailIndicators';
import type { ChartNote } from '../lib/chartNotes';
import ChartNotesLayer, { type ChartNoteAddRequest } from './ChartNotesLayer';
import { useDayNotesForWindow } from '../hooks/useDayNotesForWindow';
import { drawingLayerDay, drawingLayerReady, subscribeDrawingLayer } from '../services/chartDrawingLayer';
import ChartSnapshotButton from './ChartSnapshotButton';
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createBacktestWorkspaceCheckpoint, mergeWorkspacePanelSnapshots, workspaceLayoutPanelIds, workspacePanelsReady } from '../services/backtestWorkspaceCheckpoint';
import { storeWorkspaceRecovery, chartWorkspaceDocumentStorageKey, createChartWorkspaceDocument, parseChartWorkspaceDocument, type CompleteChartWorkspaceState } from '../services/chartWorkspaceDocument';
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
import { Actions as FlexLayoutActions, DockLocation as FlexLayoutDockLocation, type Model as FlexLayoutModel, type Node as FlexLayoutNode } from 'flexlayout-react';
import {
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Loader2,
  LocateFixed,
  Pause,
  Play,
  Plus,
  Redo2,
  Rewind,
  SkipForward,
  StepForward,
  Undo2,
  X,
} from 'lucide-react';
import { Trade } from '../types';
import {
  aggregateCandles,
  MARKET_TIMEFRAME_MINUTES,
  loadTradeMarketCandles,
  marketDataSchemaForTimeframe,
  marketDataWindowForEntry,
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
  rewindReplayTimeByInterval,
  chartReplayDelayMs,
  chartReplayShortcut,
  CHART_REPLAY_STEP_MINUTES,
  CHART_REPLAY_SPEEDS,
  DEFAULT_CHART_REPLAY_STATE,
  chartReplaySpeedDescription,
  isReplayAtLatestCandle,
  nearestReplayCandleTime,
  replayCandleCountAt,
  replayLatestTime,
  replayStartPresetTime,
  replayViewportAfterBarsUpdate,
  type ChartReplaySpeed,
  type ReplayStartPreset,
  type ChartReplayState,
  type ChartReplayStepMinutes,
} from '../services/chartReplay';
import ReplayGoToMenu from './ReplayGoToMenu';
import { ReplayChoiceMenu, ReplayStartMenu } from './ReplayToolbarMenus';
import { useReplayCandleMode } from '../services/chartReplayCandleMode';
import ChartWorkspaceStatusRow, { type ChartWorkspaceRange } from './ChartWorkspaceStatusRow';
import { logicalRangeCenteredOn, logicalRangeForLastSeconds } from '../services/chartWorkspaceRange';
import { tradeChartTiming } from '../services/tradeChartData';
import { prepareBacktestReplayGoTo, prepareBacktestReplayStep, ReplayDataRequestCoordinator } from '../services/backtestReplayData';
import {
  CHART_SETTINGS_EVENT,
  CHART_TIME_ZONES,
  loadChartSettings,
  type ChartSettings,
  type ChartTradingSettings,
} from '../services/chartSettings';
import { CHART_APPEARANCE_SLOTS, chartAppearanceSnapshot, chartAppearanceUserId, inheritGlobalAppearance, replaceChartAppearance, type ChartAppearanceState } from '../services/chartAppearanceScope';
import { panelSettingsTargetMatches, type PanelSettingsTarget } from '../services/chartPanelSettings';
import { installDevDragProfiler, recordDragProfilerCommit } from '../services/devDragProfiler';
import {
  DEFAULT_REPLAY_GO_TO_TIME_ZONE,
  loadReplayGoToSettings,
  REPLAY_GO_TO_FAILURE_MESSAGES,
  resolveReplayGoTo,
  type ReplayGoToRequest,
  type ReplayGoToSettings,
} from '../services/replayGoTo';

const REPLAY_TOOLBAR_POSITION_KEY = 'alphatrade.chart-replay-toolbar-position.v1';
/** Plovoucí lišta kreslení (8 px okraj + 44 px + 8 px) — panel přehrávání ji
 *  nemá zakrývat a legenda levého panelu začíná až za ní. */
const REPLAY_TOOLBAR_MIN_LEFT = 60;
const DRAWING_RAIL_COLLAPSED_KEY = 'alphatrade:chart-drawing-rail-collapsed';

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
  /** Exclusive end of continuous forward execution-data coverage. */
  loadedUntilMs?: number;
  /** Loads every crossed bar before resolving, returning the fresh execution source. */
  onEnsureReplayData?: (endMs: number) => Promise<MarketCandle[]>;
  /** A run with an execution ledger cannot rewind its account state. Seconds. */
  minimumReplayCursorTime?: number;
  /**
   * Nůžky před už vzatým obchodem: session se zeptá, zda obchody po novém
   * začátku smazat (true = smazáno a kurzor je tam). Bez něj návrat nejde.
   */
  onRequestRewind?: (targetTime: number) => Promise<boolean>;
  replayHasExecutionHistory?: boolean;
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
  registerWorkspaceCheckpoint?: (checkpoint: () => void) => (() => void);
  maxRevealedTime?: number;
  pauseReplayForDialog?: boolean;
  onSaveWorkspace?: () => Promise<{ localSaved: boolean; cloudSaved: boolean }>;
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
  tagSuggestions?: BacktestTagSuggestions;
  onTradeRecalculate?: (tradeId: string) => Trade | Promise<Trade>;
  onTradeReviewSave?: (tradeId: string, updates: Partial<Trade>, snapshotDataUrl?: string, expected?: Partial<Trade>) => Promise<void>;
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
  /**
   * Fullscreen obchodu (mimo backtest): indikátory sdílené s detailem —
   * panely s nimi startují a každé zapnutí/vypnutí se propíše zpět.
   */
  tradeIndicators?: TradeChartIndicators;
  onTradeIndicatorsChange?: (next: TradeChartIndicators) => void;
  /** Fullscreen obchodu: poznámky v grafu (stejné jako v detailu). */
  chartNotes?: readonly ChartNote[];
  onChartNotesChange?: (notes: ChartNote[]) => void;
  /** Fullscreen obchodu: tlačítko Snímek (celé rozložení grafů). */
  onSaveSnapshot?: (image: Blob) => Promise<boolean>;
  /** Review týdne: pruh pod lištou, panel vpravo a pás obchodů dole (místo časové osy plnění). */
  review?: WorkspaceReviewSlots;
  /**
   * Workspace vložený do stránky (deník dne) místo fullscreen vrstvy:
   * vyplní rodiče a nemá tlačítka zavřít.
   */
  embedded?: boolean;
  /**
   * Vlastní paměť rozložení (deník dne si pamatuje své panely zvlášť,
   * nezdědí dva grafy z detailu obchodu) a výchozí rozložení pro ni.
   */
  layoutScope?: string;
  defaultLayoutId?: ChartWorkspaceLayoutId;
}

export interface WorkspaceReviewSlots {
  /**
   * Místa pro pruh pod lištou, panel vpravo a pás dole. Review do nich kreslí
   * přes portál — změna výběru tak nepřekresluje workspace ani grafy.
   */
  onSlotsReady: (slots: ReviewSlotElements | null) => void;
  /** Obchody týdne s historií plnění — v grafu vedle vybraného. */
  trades: readonly Trade[];
  /**
   * Pozice kurzoru replaye (unix s), null mimo replay — review podle ní
   * přepne výběr na obchod, ke kterému přehrávání právě došlo.
   */
  onReplayCursor?: (cursorTime: number | null) => void;
  /** Kresby v review patří týdnu (klíč úložiště). */
  drawingKey: string;
  /**
   * Vlastní vrstva nad grafem každého panelu (deník dne: poznámky
   * připíchnuté k času a ceně). Dostane API grafu a obal panelu.
   */
  renderPanelOverlay?: (panel: WorkspacePanelOverlay) => React.ReactNode;
  /**
   * Svíčky pro jiný kořen v panelu (deník dne: MNQ i NQ mají stejnou cenu,
   * panel s NQ dostane svíčky dne místo nového — možná placeného — dotazu).
   */
  candlesForRoot?: (root: MarketRoot) => MarketCandle[] | null;
}
export interface WorkspacePanelOverlay {
  panelId: string;
  chartApi: ChartViewApi | null;
  /** Obal grafu panelu (position: relative). */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Časy svíček v grafu panelu (unix s). */
  barTimes: readonly number[];
  root: MarketRoot;
  timeframe: MarketTimeframe;
  isActive: boolean;
}
export interface ReviewSlotElements {
  header: HTMLElement; side: HTMLElement; bottom: HTMLElement;
  /** Panel vlevo od grafu (hodnocení obchodu). */
  left: HTMLElement;
  /** Plovoucí vrstva nad plochou grafu (panely na vyžádání, graf pod nimi má celou šířku). */
  overlay: HTMLElement;
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
  /** Nejstarší čas, kam lze v session vrátit replay (po obchodech = aktuální kurzor); null = bez omezení. */
  replaySelectionMinimumTime: number | null;
  setReplaySelectionTime: (time: number | null) => void;
  selectReplayStart: (time: number) => void;
  activatePanel: (id: string) => void;
  registerPanel: (id: string, control: WorkspacePanelControl) => void;
  unregisterPanel: (id: string) => void;
  /** Rychlá objednávka z vybraného position boxu — sdílí ji blesk i kontextové menu. */
  onPositionQuickOrder?: () => void;
  tradingSettings: ChartTradingSettings;
  openBacktestTradeReview: (tradeId: string) => void;
  onTradeIndicatorsChange?: (next: TradeChartIndicators) => void;
  chartNotes?: readonly ChartNote[];
  onChartNotesChange?: (notes: ChartNote[]) => void;
  review?: { trades: readonly Trade[]; drawingKey: string; renderPanelOverlay?: WorkspaceReviewSlots['renderPanelOverlay']; candlesForRoot?: WorkspaceReviewSlots['candlesForRoot'] };
  /** Ovládání panelu při najetí myší — nahrazuje tab strip (maximalizace, zavření). */
  paneActions: WorkspacePaneActions;
  /** Poznámky dne do grafu (fullscreen obchodu, Review). Deník dne je kreslí vlastní vrstvou. */
  showDayNotes: boolean;
  enableIndicatorOnAllPanels: (indicator: 'fvg' | 'levels' | 'structure') => void;
}

interface WorkspacePaneActions {
  panelCount: number;
  maximizedPanelId: string | null;
  toggleMaximize: (panelId: string) => void;
  close: (panelId: string) => void;
}

interface WorkspacePanelControl {
  config: WorkspacePanelConfig;
  /** `fromProfile`: změna přišla z profilu — nepropisovat ji zpátky. */
  updateConfig: (next: Partial<WorkspacePanelConfig>, options?: { fromProfile?: boolean }) => void;
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
  // Panely bez tabů jako v TradingView. Tab strip se vrací jen tabsetu, který
  // má víc tabů (starší rozložení), jinak by byly schované — viz efekt
  // synchronizace tab stripů u `getLiveModel`.
  tabSetEnableTabStrip: false,
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
  indicators?: TradeChartIndicators,
): WorkspacePanelConfig => ({
  root,
  timeframe,
  showFvg: indicators?.fvg ?? false,
  showLevels: indicators?.levels ?? false,
  showStructure: indicators?.structure ?? false,
});

const buildWorkspaceLayout = (
  root: MarketRoot,
  id: ChartWorkspaceLayoutId = '2h',
  suppliedConfigs?: WorkspacePanelConfig[],
  indicators?: TradeChartIndicators,
) => {
  const count = getChartWorkspaceLayout(id).panelCount;
  const defaultTimeframes: MarketTimeframe[] = ['1m', '5m', '15m', '1d'];
  const configs = Array.from({ length: count }, (_, index) => (
    suppliedConfigs?.[index]
      ? { ...suppliedConfigs[index] }
      : panelConfig(root, defaultTimeframes[index] ?? '1m', indicators)
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

/**
 * Timeframy panelů fullscreenu (profil deníku) — při dalším otevření je
 * rozložení stejné, jak sis ho nechal. Instrument se bere vždy z obchodu.
 */
const panelTimeframesKey = (layoutKey: string) => `${layoutKey}:timeframes`;
const MARKET_TIMEFRAMES: readonly MarketTimeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const loadPanelTimeframes = (layoutKey: string): MarketTimeframe[] => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(panelTimeframesKey(layoutKey)) ?? 'null') as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is MarketTimeframe => MARKET_TIMEFRAMES.includes(value as MarketTimeframe)) : [];
  } catch { return []; }
};
const savePanelTimeframes = (layoutKey: string, timeframes: MarketTimeframe[]) => {
  try { window.localStorage.setItem(panelTimeframesKey(layoutKey), JSON.stringify(timeframes)); } catch { /* private storage */ }
};

const loadLayoutId = (storageKey: string, fallback: ChartWorkspaceLayoutId): ChartWorkspaceLayoutId => {
  try {
    const value = window.localStorage.getItem(storageKey) as ChartWorkspaceLayoutId | null;
    if (value && getChartWorkspaceLayout(value).id === value) return value;
  } catch { /* private storage */ }
  return fallback;
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

// Dev-only profiler skutečného tažení: React commity se počítají jen během
// aktivního drag gestu a záznam jde do localStorage (sdílený origin →
// čitelný z diagnostické záložky). V produkci je callback prázdný no-op.
const devWorkspaceProfilerOnRender: React.ProfilerOnRenderCallback = import.meta.env.DEV
  ? (_id, _phase, actualDuration) => recordDragProfilerCommit(actualDuration)
  : () => undefined;
if (import.meta.env.DEV && typeof window !== 'undefined') installDevDragProfiler();

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

const EMPTY_SESSION_HISTORY: MarketCandle[] = [];

const AlphaTradeWorkspacePanel: React.FC<WorkspacePanelProps> = ({ instance, updateConfig }) => {
  const context = useContext(WorkspaceDataContext);
  if (!context) throw new Error('AlphaTrade workspace panel is missing its data context.');

  // Axis labels follow this panel's setting, even when another panel is active.
  const [showOrderPriceLabels, setShowOrderPriceLabels] = useState(
    () => loadChartSettings(context.isDark, instance.id).trading.orderPriceLabels,
  );
  useEffect(() => {
    const reload = () => setShowOrderPriceLabels(loadChartSettings(context.isDark, instance.id).trading.orderPriceLabels);
    reload();
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{
        settings?: ChartSettings; target?: PanelSettingsTarget; reload?: boolean;
      }>).detail;
      if (detail?.reload) reload();
      else if (detail?.settings && panelSettingsTargetMatches(detail.target, instance.id)) {
        setShowOrderPriceLabels(detail.settings.trading.orderPriceLabels);
      }
    };
    window.addEventListener(CHART_SETTINGS_EVENT, sync);
    return () => window.removeEventListener(CHART_SETTINGS_EVENT, sync);
  }, [context.isDark, instance.id]);

  const config = { ...panelConfig(), ...instance.config };
  const backtestSession = context.backtestSession;
  const sessionCandles = backtestSession?.candlesByRoot[config.root]
    ?? (config.root === context.initialRoot ? context.initialCandles : undefined);
  const historySchema = marketDataSchemaForTimeframe(config.timeframe);
  const historyLoadingKey = `${config.root}:${historySchema}`;
  const sessionHistoryCandles = backtestSession?.historyCandlesByRoot?.[config.root]?.[historySchema] ?? EMPTY_SESSION_HISTORY;
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
  const updatePanelConfig = useCallback((next: Partial<WorkspacePanelConfig>, options?: { fromProfile?: boolean }) => {
    // Nový timeframe / trh graf přestaví — místo probliknutí se starý prolne do nového.
    if ((next.timeframe !== undefined && next.timeframe !== config.timeframe) || (next.root !== undefined && next.root !== config.root)) {
      crossfadeChart(chartAreaRef.current, chartApi, { holdMs: 140 });
    }
    if (next.root !== undefined || next.timeframe !== undefined) setChartApi(null);
    updateConfig(next);
    if (!options?.fromProfile && context.onTradeIndicatorsChange && (next.showFvg !== undefined || next.showLevels !== undefined || next.showStructure !== undefined)) {
      context.onTradeIndicatorsChange({
        fvg: next.showFvg ?? config.showFvg,
        levels: next.showLevels ?? config.showLevels,
        structure: next.showStructure ?? config.showStructure,
      });
    }
  }, [chartApi, config.root, config.showFvg, config.showLevels, config.showStructure, config.timeframe, context.onTradeIndicatorsChange, updateConfig]);
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
    const provided = context.review?.candlesForRoot?.(config.root);
    if (provided?.length) {
      setRawCandles(provided);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const { start, end } = marketDataWindowForEntry(context.entryMs);
    const entryFill = context.trade.executionHistory?.fills.filter(fill => fill.role === 'entry').sort((a, b) => a.at - b.at)[0];
    setLoading(true);
    setError(null);
    // Obchod bez uloženého kontraktu ověří cenou vstupu, že svíčky patří jeho kontraktu (rollover).
    loadTradeMarketCandles({ root: config.root, tradeSymbol: context.trade.symbol || context.trade.instrument, start, end,
      entryMs: entryFill?.at ?? context.entryMs, entryPrice: entryFill?.price ?? context.trade.entryPrice })
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
  }, [config.root, context.backtestSession?.id, context.entryMs, context.initialCandles, context.initialRoot, context.review?.candlesForRoot, context.trade.instrument, context.trade.symbol, context.trade.entryPrice, context.trade.executionHistory, sessionCandles]);

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
    () => sharedRevealedCandles(rawCandles, replayRevealedCount),
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
  // Fullscreen obchodu i review týdne: v replayi se obchody kreslí jen do
  // kurzoru, stejně jako v přehrávači detailu (vstup, SL/TP a plnění přibývají,
  // jak čas běží). Backtest kreslí obchody vlastními vrstvami.
  const journalReplay = !context.backtestSession;
  const replayCutoffMs = journalReplay && context.replay.phase === 'active' && context.replay.cursorTime !== null
    ? (context.replay.cursorTime + 60) * 1_000 - 1
    : null;
  const replayTrade = useMemo(
    () => replayCutoffMs !== null && context.trade.executionHistory
      ? { ...context.trade, executionHistory: historyAt(context.trade.executionHistory, replayCutoffMs) }
      : context.trade,
    [context.trade, replayCutoffMs],
  );
  // Review: ostatní obchody týdne v replayi — minulé celé, rozběhnutý do
  // kurzoru, budoucí ještě nejsou. Nový seznam (a přestavba jejich vrstev)
  // jen když se některý viditelně změní, ne při každém kroku.
  const reviewTrades = context.review?.trades;
  const replayCutoffRef = useRef(replayCutoffMs);
  replayCutoffRef.current = replayCutoffMs;
  const reviewRevealKey = useMemo(() => replayCutoffMs === null || !reviewTrades ? null
    : reviewTrades.map(other => other.executionHistory ? replayRevealKey(other.executionHistory, replayCutoffMs) : '-').join('|'),
  [replayCutoffMs, reviewTrades]);
  const reviewTradesAtCursor = useMemo(() => {
    const cutoff = replayCutoffRef.current;
    if (reviewRevealKey === null || cutoff === null || !reviewTrades) return reviewTrades;
    return reviewTrades.flatMap(other => {
      if (!other.executionHistory) return [other];
      const history = historyAt(other.executionHistory, cutoff);
      return history.fills.length || history.entryOrders?.length ? [{ ...other, executionHistory: history }] : [];
    });
  }, [reviewRevealKey, reviewTrades]);
  const chartAreaRef = useRef<HTMLDivElement>(null);
  // Panel u levého okraje workspace má nad sebou plovoucí lištu kreslení —
  // legenda a logo se odsadí (CSS --chart-left-inset přes data-left-edge).
  const paneRef = useRef<HTMLDivElement>(null);
  const [atLeftEdge, setAtLeftEdge] = useState(false);
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const measure = () => {
      const shell = pane.closest('.alphatrade-candlekit-workspace');
      if (!shell) return;
      setAtLeftEdge(pane.getBoundingClientRect().left - shell.getBoundingClientRect().left < 4);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  const [noteAddRequest, setNoteAddRequest] = useState<ChartNoteAddRequest | null>(null);
  const noteBarTimes = useMemo(() => candles.map(candle => candle.time), [candles]);
  const dayNotes = useDayNotesForWindow(
    rawCandles.length ? drawingLayerDay(rawCandles[0].time) : null,
    rawCandles.length ? drawingLayerDay(rawCandles[rawCandles.length - 1].time) : null,
    context.showDayNotes,
  );

  return (
    <div
      ref={paneRef}
      className={`group/pane absolute inset-0 flex flex-col alphatrade-workspace-panel ${isActive ? 'is-active' : ''} ${context.isDark ? 'is-dark bg-[#090d12]' : 'bg-white'}`}
      data-left-edge={atLeftEdge || undefined}
      onPointerDownCapture={() => context.activatePanel(instance.id)}
      data-panel-id={instance.id}
      data-active-panel={isActive || undefined}
      data-panel-root={config.root}
      data-panel-timeframe={config.timeframe}
    >
      <div ref={chartAreaRef} data-chart-area className="relative flex-1 min-h-0">
        {context.paneActions.maximizedPanelId === instance.id && (
          // Maximalizace jde přes ⌥↩ (Alt+Enter); nápověda je vidět jen
          // v maximalizovaném grafu a klikem rozložení taky vrátí.
          <button
            type="button"
            data-snapshot-hide
            onClick={() => context.paneActions.toggleMaximize(instance.id)}
            className={`absolute right-[76px] top-1.5 z-[640] flex h-7 items-center gap-1.5 rounded-lg px-2 text-[10px] font-bold ${chartGlassBar(context.isDark)} ${chartGlassButton(context.isDark)}`}
            title="Vrátit rozložení (⌥↩ / Alt+Enter)"
          ><kbd className="font-sans text-[10px]">⌥↩</kbd> Zpět na rozložení</button>
        )}
        {!loading && !error && candles.length > 0 && (
          <>
          <CandleKitTradeChart
            trade={replayTrade}
            journalHistoryInReplay={journalReplay}
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
            replaySelectionMinimumTime={context.replaySelectionMinimumTime}
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
            onIndicatorAppliedToAllPanels={context.enableIndicatorOnAllPanels}
            onAddChartNote={context.onChartNotesChange ? (clientX, clientY) => setNoteAddRequest({ clientX, clientY, nonce: Date.now() }) : undefined}
            reviewMode={Boolean(context.review)}
            contextTrades={reviewTradesAtCursor}
            drawingKeyId={context.review?.drawingKey}
          />
          {context.review?.renderPanelOverlay?.({
            panelId: instance.id, chartApi, containerRef: chartAreaRef, barTimes: noteBarTimes,
            root: config.root, timeframe: config.timeframe, isActive,
          })}
          {context.chartNotes && (
            <ChartNotesLayer
              chartApi={chartApi}
              containerRef={chartAreaRef}
              notes={context.chartNotes}
              barTimes={noteBarTimes}
              replayCursor={context.replay.phase === 'active' ? context.replay.cursorTime : null}
              editable={Boolean(context.onChartNotesChange)}
              isDark={context.isDark}
              addRequest={noteAddRequest}
              onChange={next => context.onChartNotesChange?.(next)}
            />
          )}
          {dayNotes.length > 0 && (
            <ChartNotesLayer
              chartApi={chartApi}
              containerRef={chartAreaRef}
              notes={dayNotes}
              barTimes={noteBarTimes}
              replayCursor={context.replay.phase === 'active' ? context.replay.cursorTime : null}
              editable={false}
              isDark={context.isDark}
              addRequest={null}
              onChange={() => {}}
            />
          )}
          {context.tradingSettings.orderLines && chartApi && config.root === context.backtestSession?.executionInstrument && context.backtestSession.orderLines?.length && context.backtestSession.onOrderLineChange && context.backtestSession.onOrderLineCancel ? (
            <BacktestOrderLinesOverlay
              api={chartApi}
              lines={context.backtestSession.orderLines}
              showPriceLabels={showOrderPriceLabels}
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
          <div style={{ left: 'calc(var(--chart-left-inset, 8px) + 4px)' }} className="pointer-events-none absolute top-3 z-[650] flex items-center gap-1.5 rounded-md border border-slate-700/60 bg-slate-950/80 px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-slate-300">
            <Loader2 size={11} className="animate-spin" /> Načítám starší historii
          </div>
        ) : null}
        {historyError ? (
          <div style={{ left: 'calc(var(--chart-left-inset, 8px) + 4px)' }} className="pointer-events-none absolute bottom-3 z-[650] max-w-[360px] rounded-md border border-amber-500/40 bg-amber-950/90 px-2 py-1 text-[9px] font-semibold text-amber-100">
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
  tradeIndicators,
  onTradeIndicatorsChange,
  chartNotes,
  onChartNotesChange,
  onSaveSnapshot,
  review,
  embedded = false,
  layoutScope,
  defaultLayoutId = '2h',
}) => {
  const layoutStorageKey = layoutScope ? `${WORKSPACE_LAYOUT_STORAGE_KEY}:${layoutScope}` : WORKSPACE_LAYOUT_STORAGE_KEY;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workspaceShellRef = useRef<HTMLDivElement>(null);
  const workspaceViewportRef = useRef<HTMLDivElement>(null);
  const replayToolbarRef = useRef<HTMLDivElement>(null);
  // Jen fullscreen obchodu; backtest má vlastní uložený stav panelů.
  const indicatorDefaults = backtestSession ? undefined : tradeIndicators;
  const savedLayoutId = backtestSession?.workspaceState?.layoutId as ChartWorkspaceLayoutId | undefined;
  const initialLayoutIdRef = useRef<ChartWorkspaceLayoutId>(
    savedLayoutId && getChartWorkspaceLayout(savedLayoutId).id === savedLayoutId ? savedLayoutId : loadLayoutId(layoutStorageKey, defaultLayoutId),
  );
  const nextPanelNumberRef = useRef(getChartWorkspaceLayout(initialLayoutIdRef.current).panelCount + 1);
  const [status, setStatus] = useState('Layout je možné přetahovat a měnit jeho velikost');
  const [workspaceLibraryMode, setWorkspaceLibraryMode] = useState<'save' | 'load' | null>(null);
  const [workspacePreview, setWorkspacePreview] = useState<{ input: unknown; owner: string | null | undefined; sessionId?: string; error?: string } | null>(null);
  const [workspaceApplying, setWorkspaceApplying] = useState(false);

  const [activePanelId, setActivePanelId] = useState(backtestSession?.workspaceState?.activePanelId || 'alphatrade-chart-1');
  const [reviewTradeId, setReviewTradeId] = useState<string | null>(null);
  const [replay, setReplay] = useState<ChartReplayState>(backtestSession?.initialReplay ?? DEFAULT_CHART_REPLAY_STATE);
  const [replaySelectionTime, setReplaySelectionTime] = useState<number | null>(null);
  const [replayDataLoading, setReplayDataLoading] = useState(false);
  // Krátká hláška uprostřed workspace (rychlá objednávka, odmítnutý návrat
  // replay). Stavový řádek v liště je viditelný až od šířky 2xl, takže sám
  // o sobě zpětnou vazbu nezaručí.
  const [quickOrderFeedback, setQuickOrderFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    if (!quickOrderFeedback) return;
    const timer = window.setTimeout(() => setQuickOrderFeedback(null), 3_200);
    return () => window.clearTimeout(timer);
  }, [quickOrderFeedback]);
  // Svíčky v přehrávání plynule, nebo celé — profil grafů (nastavení → Přehrávání).
  const replayCandleMode = useReplayCandleMode(isDark);
  const replayRef = useRef(replay);
  const replayInteractionPaused = Boolean(backtestSession?.pauseReplayForDialog || reviewTradeId);
  const replayInteractionPausedRef = useRef(replayInteractionPaused);
  replayInteractionPausedRef.current = replayInteractionPaused;
  const backtestSessionRef = useRef(backtestSession);
  const replayDataRequestsRef = useRef(new ReplayDataRequestCoordinator());
  replayRef.current = replay;
  backtestSessionRef.current = backtestSession;
  useEffect(() => {
    replayDataRequestsRef.current.cancel();
    setReplayDataLoading(false);
    return () => replayDataRequestsRef.current.cancel();
  }, [backtestSession?.id]);
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
  const pendingSessionPanelsRef = useRef<WorkspaceSnapshot>({ ...backtestSession?.workspaceState?.panels });
  const captureOverrideRef = useRef<CompleteChartWorkspaceState | null>(null);
  const pendingActivePanelRef = useRef<string | null>(null);
  const [workspaceMountVersion, setWorkspaceMountVersion] = useState(0);
  useLayoutEffect(() => { captureOverrideRef.current = null; }, [workspaceMountVersion]);
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
        left: Math.min(maxLeft, Math.max(REPLAY_TOOLBAR_MIN_LEFT, pointerEvent.clientX - latestViewportRect.left - grabOffsetX)),
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
    setActivePanelId(current => {
      const requested = pendingActivePanelRef.current;
      if (requested && next.has(requested)) { pendingActivePanelRef.current = null; return requested; }
      return current || id;
    });
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
    if (replayInteractionPausedRef.current) return;
    replayDataRequestsRef.current.cancel();
    setReplayDataLoading(false);
    setReplaySelectionTime(null);
    setReplay(current => current.phase === 'selecting'
      ? backtestSessionRef.current ? { ...current, phase: 'active', playing: false } : DEFAULT_CHART_REPLAY_STATE
      : { ...current, phase: 'selecting', playing: false });
    setStatus('Klikni do libovolného grafu na svíčku, od které chceš replay spustit');
  }, []);
  const selectReplayStart = useCallback((requestedTime: number) => {
    // The chart that received the click already snaps the requested timestamp
    // to one of its own candles. Trust that value here: activePanelId is
    // intentionally updated by the same pointer event and React state would
    // otherwise still point at the previously active pane for this one tick.
    if (replayInteractionPausedRef.current || !Number.isFinite(requestedTime)) return;
    const session = backtestSessionRef.current;
    const minimum = Math.max(
      session?.minimumReplayCursorTime ?? (session ? session.startMs / 1_000 : -Infinity),
      session?.replayHasExecutionHistory ? replayRef.current.cursorTime ?? -Infinity : -Infinity,
    );
    const start = () => {
      replayDataRequestsRef.current.cancel();
      setReplayDataLoading(false);
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
    };
    if (requestedTime < minimum) {
      const sessionStart = session ? session.startMs / 1_000 : -Infinity;
      if (session?.onRequestRewind && requestedTime >= sessionStart) {
        // Před vzatým obchodem: session se zeptá, co se smaže, a po potvrzení začne odtud.
        void session.onRequestRewind(requestedTime).then(confirmed => {
          if (confirmed) { start(); return; }
          // Zrušeno: výběr skončí, kurzor zůstává, kde byl.
          setReplaySelectionTime(null);
          setReplay(current => current.phase === 'selecting' ? { ...current, phase: 'active', playing: false } : current);
          setStatus('Návrat replaye zrušen');
        });
        return;
      }
      const message = 'Replay nelze vrátit před zpracované obchody. Pro nový průchod vytvoř kopii session.';
      setStatus(message);
      setQuickOrderFeedback({ ok: false, message });
      return;
    }
    start();
  }, []);
  const advanceReplayBy = useCallback((steps: number) => {
    const current = replayRef.current;
    if (replayInteractionPausedRef.current || current.phase !== 'active' || replayDataRequestsRef.current.pending) return;
    const session = backtestSessionRef.current;
    const source = session?.candlesByRoot[session.executionInstrument]
      ?? panelControlsRef.current.get(activePanelId)?.rawCandles
      ?? [];
    const nextTime = advanceReplayTimeByInterval(source, current.cursorTime, current.stepMinutes ?? 1, steps);
    if (nextTime !== null || !session?.onEnsureReplayData) {
      setReplay(value => {
        if (replayInteractionPausedRef.current || value.phase !== 'active') return value;
        const next = advanceReplayTimeByInterval(source, value.cursorTime, value.stepMinutes ?? 1, steps);
        return next === null ? { ...value, playing: false } : { ...value, cursorTime: next };
      });
      return;
    }
    const cursor = current.cursorTime;
    const stepMinutes = current.stepMinutes ?? 1;
    setReplayDataLoading(true);
    setStatus('Načítám data pro další replay krok…');
    void replayDataRequestsRef.current.run(
      `${session.id}:step:${cursor}:${stepMinutes}:${steps}`,
      isCurrent => prepareBacktestReplayStep({
        candles: source,
        loadedUntilMs: session.loadedUntilMs ?? ((source.at(-1)?.time ?? 0) + 60) * 1_000,
        endMs: session.endMs,
        ensure: session.onEnsureReplayData!,
        isCurrent,
      }, cursor, stepMinutes, steps),
      next => {
        setReplay(value => replayInteractionPausedRef.current || value.phase !== 'active' || value.cursorTime !== cursor || (value.stepMinutes ?? 1) !== stepMinutes
          ? value
          : next === null ? { ...value, playing: false } : { ...value, cursorTime: next });
        setStatus(next === null ? 'Replay dosáhl konce session' : 'Replay data načtena');
      },
      reason => {
        setReplay(value => ({ ...value, playing: false }));
        setStatus(reason instanceof Error ? `Replay: ${reason.message}` : 'Další replay data se nepodařilo načíst. Zkus krok znovu.');
      },
      () => setReplayDataLoading(false),
    );
  }, [activePanelId]);
  const advanceReplay = useCallback(() => advanceReplayBy(1), [advanceReplayBy]);
  /**
   * Krok zpět (šipka doleva). V backtestu jde přes stejný návrat jako nůžky:
   * bez dotčených obchodů jen posune kurzor, jinak se zeptá, co se smaže.
   */
  const rewindReplayBy = useCallback((steps: number) => {
    const current = replayRef.current;
    if (replayInteractionPausedRef.current || current.phase !== 'active' || replayDataRequestsRef.current.pending) return;
    const session = backtestSessionRef.current;
    const source = session?.candlesByRoot[session.executionInstrument]
      ?? panelControlsRef.current.get(activePanelId)?.rawCandles
      ?? [];
    let target = rewindReplayTimeByInterval(source, current.cursorTime, current.stepMinutes ?? 1, steps);
    if (target === null) return;
    if (session) {
      const sessionStart = session.startMs / 1_000;
      if (target < sessionStart) {
        if ((current.cursorTime ?? sessionStart) <= sessionStart) return;
        target = sessionStart;
      }
    }
    const cursorTime = target;
    const apply = () => setReplay(value => value.phase === 'active' && value.cursorTime === current.cursorTime
      ? { ...value, cursorTime, playing: false }
      : value);
    if (session?.onRequestRewind) {
      void session.onRequestRewind(cursorTime).then(confirmed => { if (confirmed) apply(); });
      return;
    }
    if (session) return;
    apply();
  }, [activePanelId]);
  /** Koalescence držené šipky: kroky se sbírají a aplikují jednou za snímek. */
  const pendingStepsRef = useRef(0);
  const stepFrameRef = useRef<number | null>(null);
  const pendingBackStepsRef = useRef(0);
  const backStepFrameRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!replayInteractionPaused) return;
    replayDataRequestsRef.current.cancel();
    pendingStepsRef.current = 0;
    if (stepFrameRef.current !== null) { window.cancelAnimationFrame(stepFrameRef.current); stepFrameRef.current = null; }
    setReplayDataLoading(false);
    setReplay(current => current.playing ? { ...current, playing: false } : current);
  }, [replayInteractionPaused]);
  const replayGoTo = useCallback((request: ReplayGoToRequest) => {
    const current = replayRef.current;
    if (replayInteractionPausedRef.current || current.phase !== 'active') return;
    const session = backtestSessionRef.current;
    const source = session?.candlesByRoot[session.executionInstrument]
      ?? panelControlsRef.current.get(activePanelId)?.rawCandles
      ?? [];
    const options = { cursorTime: current.cursorTime, settings: goToSettings, timeZone: chartTimeZone };
    const commit = (result: ReturnType<typeof resolveReplayGoTo>) => {
      if (result.kind === 'error') {
        setStatus(`Go To: ${REPLAY_GO_TO_FAILURE_MESSAGES[result.reason]}`);
        return;
      }
      if (!replayInteractionPausedRef.current && replayRef.current.phase === 'active' && replayRef.current.cursorTime === current.cursorTime) {
        // Skok záběru se prolne (posun ve směru skoku) místo probliknutí.
        const forward = (result.value.cursorTime ?? 0) >= (current.cursorTime ?? 0);
        panelControlsRef.current.forEach((control, panelId) => crossfadeChart(
          workspaceShellRef.current?.querySelector<HTMLElement>(`[data-panel-id="${panelId}"] [data-chart-area]`) ?? null,
          control.chartApi,
          { slideX: forward ? -36 : 36, holdMs: 60 },
        ));
      }
      setReplay(value => !replayInteractionPausedRef.current && value.phase === 'active' && value.cursorTime === current.cursorTime
        ? { ...value, cursorTime: result.value.cursorTime, playing: false }
        : value);
      setStatus(`Go To: ${goToTimeLabel(result.value.targetTime, chartTimeZone)}`);
    };
    if (!session?.onEnsureReplayData) {
      commit(resolveReplayGoTo(request, { ...options, candles: source }));
      return;
    }
    // Stop playback but preserve the cursor while the whole skipped interval loads.
    setReplay(value => value.playing ? { ...value, playing: false } : value);
    setReplayDataLoading(true);
    setStatus('Načítám data pro Go To…');
    void replayDataRequestsRef.current.run(
      `${session.id}:goto:${current.cursorTime}:${JSON.stringify({ request, settings: goToSettings, timeZone: chartTimeZone })}`,
      isCurrent => prepareBacktestReplayGoTo({
        candles: source,
        loadedUntilMs: session.loadedUntilMs ?? ((source.at(-1)?.time ?? 0) + 60) * 1_000,
        endMs: session.endMs,
        ensure: session.onEnsureReplayData!,
        isCurrent,
      }, request, options),
      commit,
      reason => setStatus(reason instanceof Error ? `Go To: ${reason.message}` : 'Data pro Go To se nepodařilo načíst. Zkus skok znovu.'),
      () => setReplayDataLoading(false),
    );
  }, [activePanelId, chartTimeZone, goToSettings]);
  /**
   * Start z menu panelu (datum, první, náhodná svíčka). Jen mimo backtest:
   * session hlídá zpracované obchody a data dotahuje po kouscích, takže tam
   * start jde vybrat výhradně nůžkami se stejnými kontrolami jako dosud.
   */
  const startReplayAtTime = useCallback((requestedTime: number, label: string) => {
    if (backtestSessionRef.current || replayInteractionPausedRef.current) return;
    const source = panelControlsRef.current.get(activePanelId)?.rawCandles ?? [];
    const first = source[0]?.time;
    const last = source.at(-1)?.time;
    // Mimo načtená data by se start tiše přichytil na okraj — radši říct proč ne.
    if (first !== undefined && last !== undefined && (requestedTime < first - 60 || requestedTime > last + 60)) {
      setStatus(`Bar Replay: graf má data jen ${goToTimeLabel(first, chartTimeZone)} – ${goToTimeLabel(last, chartTimeZone)}`);
      return;
    }
    const time = nearestReplayCandleTime(source, requestedTime);
    if (time === null) {
      setStatus('Bar Replay: graf ještě nemá načtená data');
      return;
    }
    selectReplayStart(time);
    setStatus(`Bar Replay: ${label} ${goToTimeLabel(time, chartTimeZone)}`);
  }, [activePanelId, chartTimeZone, selectReplayStart]);
  /** Hodina před kurzorem (nebo koncem dat), ale nikdy před první svíčkou. */
  const replayDefaultStartTime = useCallback(() => {
    const source = panelControlsRef.current.get(activePanelId)?.rawCandles ?? [];
    const first = source[0]?.time;
    const anchor = replayRef.current.cursorTime ?? source.at(-1)?.time;
    if (first === undefined || anchor === undefined || anchor === null) return null;
    return Math.max(first, anchor - 3_600);
  }, [activePanelId]);
  const startReplayPreset = useCallback((preset: ReplayStartPreset) => {
    const source = panelControlsRef.current.get(activePanelId)?.rawCandles ?? [];
    const time = replayStartPresetTime(source, preset);
    if (time === null) {
      setStatus('Bar Replay: graf ještě nemá načtená data');
      return;
    }
    startReplayAtTime(time, preset === 'first' ? 'první dostupná svíčka' : 'náhodná svíčka');
  }, [activePanelId, startReplayAtTime]);
  const enterReplaySelection = useCallback(() => {
    if (replayInteractionPausedRef.current) return;
    replayDataRequestsRef.current.cancel();
    setReplayDataLoading(false);
    setReplaySelectionTime(null);
    setReplay(current => ({ ...current, phase: 'selecting', playing: false }));
    setStatus('Klikni do libovolného grafu na svíčku, od které chceš replay spustit');
  }, []);
  /** „Jump to real-time chart“ — kurzor na poslední svíčku, replay zůstává zapnutý. */
  const jumpReplayToEnd = useCallback(() => {
    if (backtestSessionRef.current || replayInteractionPausedRef.current) return;
    const latest = replayLatestTime(panelControlsRef.current.get(activePanelId)?.rawCandles ?? []);
    if (latest === null) return;
    replayDataRequestsRef.current.cancel();
    setReplayDataLoading(false);
    setReplay(current => current.phase === 'active'
      ? { ...current, cursorTime: latest, playing: false }
      : current);
    setStatus('Bar Replay: konec dat');
  }, [activePanelId]);
  const exitReplay = useCallback(() => {
    if (backtestSessionRef.current) return;
    replayDataRequestsRef.current.cancel();
    setReplayDataLoading(false);
    setReplaySelectionTime(null);
    setReplay(DEFAULT_CHART_REPLAY_STATE);
    setStatus('Bar Replay ukončen');
  }, []);
  useEffect(() => {
    if (replay.phase !== 'active' || !replay.playing || replayDataLoading) return;
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
  }, [advanceReplayBy, replay.phase, replay.playing, replay.speed, replayDataLoading]);
  /**
   * Plynulé přehrávání jako v detailu obchodu: mezi kroky se další 1m svíčka
   * „rodí“ po cestě z candleReplayPath (plnění obchodu v ní padnou na svůj čas
   * a cenu). Kreslí se přímo do grafu mimo React; po dokončení kroku svíčku
   * převezme kurzor a běžná aktualizace dat. Jen krok 1m a mimo backtest —
   * session zpracovává příkazy po celých svíčkách.
   */
  useEffect(() => {
    if (backtestSession || replay.phase !== 'active' || !replay.playing || replayDataLoading) return;
    if ((replay.stepMinutes ?? 1) !== 1) return;
    // Nastavení grafu → Přehrávání: celá svíčka naskočí najednou.
    if (replayCandleMode !== 'smooth') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const delay = chartReplayDelayMs(replay.speed);
    if (delay < 150) return;
    const fills = trade.executionHistory?.fills ?? [];
    let frame = 0;
    let stepStartedAt = performance.now();
    let lastCursor = replayRef.current.cursorTime;
    // Cesta svíčky podle instrumentu panelu (MNQ a NQ mají jiné svíčky).
    const paths = new Map<string, { candle: MarketCandle; points: PathPoint[] } | null>();
    const bases = new Map<string, { cursor: number; base: MarketCandle | null }>();
    const appended = new Set<string>();
    const tick = (now: number) => {
      const cursor = replayRef.current.cursorTime;
      if (cursor !== lastCursor) {
        lastCursor = cursor;
        stepStartedAt = now;
        paths.clear();
        appended.clear();
      }
      if (cursor === null) { frame = window.requestAnimationFrame(tick); return; }
      const progress = Math.min(0.98, (now - stepStartedAt) / delay);
      panelControlsRef.current.forEach((control, panelId) => {
        const api = control.chartApi;
        if (!api) return;
        const root = control.config.root;
        if (!paths.has(root)) {
          const next = control.rawCandles.find(candle => candle.time > cursor);
          const minuteFills = next ? fills.filter(fill => fill.at >= next.time * 1_000 && fill.at < next.time * 1_000 + 60_000) : [];
          paths.set(root, next ? { candle: next, points: candleReplayPath(next, minuteFills) } : null);
        }
        const path = paths.get(root);
        if (!path) return;
        // Cena mezi body cesty je interpolace — zaokrouhlit na tick MNQ/NQ (0,25).
        const tick025 = (price: number) => Math.round(price * 4) / 4;
        const raw = partialReplayCandle(path.candle, path.points, progress);
        const partial = { ...raw, high: tick025(raw.high), low: tick025(raw.low), close: tick025(raw.close) };
        const timeframe = control.config.timeframe;
        let bar: MarketCandle = partial;
        if (timeframe !== '1m') {
          let cached = bases.get(panelId);
          if (!cached || cached.cursor !== cursor) {
            cached = { cursor, base: formingReplayBase(control.rawCandles, cursor, timeframe) };
            bases.set(panelId, cached);
          }
          bar = formingReplayBar(cached.base, partial, timeframe);
        }
        try {
          const controller = api.controller;
          const lastTs = controller.getBars().at(-1)?.ts;
          if (lastTs !== undefined && lastTs > bar.time * 1_000) return;
          const isNewBar = lastTs === undefined || lastTs < bar.time * 1_000;
          const timeScale = controller.getChart().timeScale();
          const rangeBefore = isNewBar ? timeScale.getVisibleLogicalRange() : null;
          const countBefore = controller.getBars().length;
          controller.updateBar({ ts: bar.time * 1_000, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
          if (isNewBar && rangeBefore && !appended.has(panelId)) {
            // Nový bar posune záběr stejně jako běžný replay krok (graf, který
            // sleduje poslední svíčku, ji drží na místě); pozdější data kroku
            // pak už žádný nový bar nepřinesou.
            timeScale.setVisibleLogicalRange(replayViewportAfterBarsUpdate(rangeBefore, countBefore, countBefore + 1));
          }
          appended.add(panelId);
        } catch { /* panel se právě přestavuje */ }
      });
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [backtestSession, replay.phase, replay.playing, replay.speed, replay.stepMinutes, replayCandleMode, replayDataLoading, trade.executionHistory]);
  /**
   * Plynulé přehrávání v backtestu: svíčka se kreslí až PO zpracování. Kurzor
   * (a s ním engine: plnění, SL/TP, příkazy) je už za ní a graf ji jen dokreslí
   * po cestě z candleReplayPath. Obrazovka tak nikdy neukáže víc, než engine
   * zná — příkaz zadaný během animace jde až od další svíčky, nahlédnout do
   * budoucnosti nejde. Po pauze nebo dalším kroku se svíčka dokreslí celá.
   */
  const backtestCandleSettleRef = useRef<(() => void) | null>(null);
  const backtestReplayCursor = backtestSession && replay.phase === 'active' && replay.playing && !replayDataLoading
    && (replay.stepMinutes ?? 1) === 1 && replayCandleMode === 'smooth' ? replay.cursorTime : null;
  useEffect(() => {
    if (backtestReplayCursor === null) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const delay = chartReplayDelayMs(replayRef.current.speed);
    if (delay < 150) return;
    const cursor = backtestReplayCursor;
    // Svíčka dorazí kousek před dalším krokem, ať na konci chvíli stojí celá.
    const duration = delay * 0.85;
    const startedAt = performance.now();
    const tick025 = (price: number) => Math.round(price * 4) / 4;
    const targets = new Map<string, { candle: MarketCandle; points: PathPoint[]; base: MarketCandle | null; timeframe: MarketTimeframe }>();
    panelControlsRef.current.forEach((control, panelId) => {
      const candle = control.rawCandles.find(item => item.time === cursor);
      if (!candle) return;
      const timeframe = control.config.timeframe;
      targets.set(panelId, {
        candle,
        points: candleReplayPath(candle),
        base: timeframe === '1m' ? null : formingReplayBase(control.rawCandles, cursor - 60, timeframe),
        timeframe,
      });
    });
    if (!targets.size) return;
    const draw = (progress: number) => {
      targets.forEach((target, panelId) => {
        const control = panelControlsRef.current.get(panelId);
        const api = control?.chartApi;
        // Panel mezitím přepnul timeframe: bar by patřil jiné mřížce.
        if (!api || control.config.timeframe !== target.timeframe) return;
        const raw = partialReplayCandle(target.candle, target.points, progress);
        const partial = progress >= 1 ? raw : { ...raw, high: tick025(raw.high), low: tick025(raw.low), close: tick025(raw.close) };
        const bar = target.timeframe === '1m' ? partial : formingReplayBar(target.base, partial, target.timeframe);
        try {
          const controller = api.controller;
          // Jen přepis baru, který už graf z kroku má — nic se nepřidává.
          if (controller.getBars().at(-1)?.ts !== bar.time * 1_000) return;
          controller.updateBar({ ts: bar.time * 1_000, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
        } catch { /* panel se právě přestavuje */ }
      });
    };
    // První snímek hned, ať se plná svíčka z kroku vůbec neukáže.
    draw(0);
    let frame = 0;
    let settled = false;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      draw(progress);
      if (progress < 1) frame = window.requestAnimationFrame(tick);
      else settled = true;
    };
    frame = window.requestAnimationFrame(tick);
    const settle = () => {
      if (settled) return;
      settled = true;
      window.cancelAnimationFrame(frame);
      // Kurzor se mezitím posunul (další krok, Go To, konec dat): poslední bar
      // už zapsal panel z nových dat — starý cíl by ho přepsal (na vyšším
      // timeframe jde o tentýž bar).
      if (replayRef.current.cursorTime === cursor) draw(1);
    };
    // Klik kamkoli do workspace (BUY/SELL, příkaz z grafu, SL/TP) svíčku
    // dokreslí hned — příkaz se pak plní proti tomu, co je vidět.
    backtestCandleSettleRef.current = settle;
    return () => {
      if (backtestCandleSettleRef.current === settle) backtestCandleSettleRef.current = null;
      settle();
    };
  }, [backtestReplayCursor]);
  useEffect(() => {
    if (!replayToolbarPosition) return;
    const clampToolbarPosition = () => {
      const toolbar = replayToolbarRef.current;
      const viewport = workspaceViewportRef.current;
      if (!toolbar || !viewport) return;
      const next = {
        left: Math.min(Math.max(0, viewport.clientWidth - toolbar.offsetWidth), Math.max(REPLAY_TOOLBAR_MIN_LEFT, replayToolbarPosition.left)),
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
    () => buildWorkspaceLayout(
      initialRoot,
      initialLayoutIdRef.current,
      backtestSession ? undefined : loadPanelTimeframes(layoutStorageKey).map(timeframe => panelConfig(initialRoot, timeframe, indicatorDefaults)),
      indicatorDefaults,
    ),
    // Indikátory jen při otevření — další přepnutí mění panely, ne rozložení.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      defaultConfig: () => panelConfig(initialRoot, '1m', indicatorDefaults),
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

  // Profil deníku: všechny panely mají stejné indikátory. Zapnutí/vypnutí
  // v jiném grafu (detail, Deník dne, jiný panel) se propíše hned, ne až při
  // dalším otevření.
  useEffect(() => {
    if (backtestSession || !tradeIndicators) return;
    panelControlsRef.current.forEach(control => {
      const { showFvg, showLevels, showStructure } = control.config;
      if (showFvg === tradeIndicators.fvg && showLevels === tradeIndicators.levels && showStructure === tradeIndicators.structure) return;
      control.updateConfig(
        { showFvg: tradeIndicators.fvg, showLevels: tradeIndicators.levels, showStructure: tradeIndicators.structure },
        { fromProfile: true },
      );
    });
  }, [backtestSession, panelControls, tradeIndicators]);
  const getLiveModel = useCallback(() => (workspace as unknown as { driver?: { getModel?: () => FlexLayoutModel | null } })
    .driver?.getModel?.() ?? null, [workspace]);
  const [paneLayout, setPaneLayout] = useState<{ count: number; maximizedPanelId: string | null }>({ count: 1, maximizedPanelId: null });
  /**
   * Bez tab stripu by druhý tab v jednom tabsetu nebyl vidět. Starší uložená
   * rozložení (a import) takové tabsety mít můžou, proto jim strip vracíme;
   * tabsety s jedním grafem ho nemají, jako panely v TradingView.
   */
  useEffect(() => {
    let frame: number | null = null;
    let retry: number | null = null;
    let attempts = 0;
    let lastModel: FlexLayoutModel | null = null;
    const sync = () => {
      frame = null;
      const model = getLiveModel();
      if (!model) {
        // FlexLayout driver vzniká až s prvním renderem adapteru.
        if (attempts++ < 50) retry = window.setTimeout(() => { retry = null; schedule(); }, 100);
        return;
      }
      // Import/reset rozložení vymění model až v efektu adapteru, tedy po
      // oznámení změny — nový model proto zkontroluj ještě jednou.
      if (lastModel !== null && model !== lastModel && retry === null) {
        retry = window.setTimeout(() => { retry = null; schedule(); }, 150);
      }
      lastModel = model;
      let count = 0;
      let maximizedPanelId: string | null = null;
      const updates: { id: string; enableTabStrip: boolean }[] = [];
      const timeframes: MarketTimeframe[] = [];
      model.visitNodes(node => {
        if (node.getType() === 'tab') {
          count += 1;
          const instance = (node as FlexLayoutNode & { getConfig?: () => { config?: Partial<WorkspacePanelConfig> } | undefined }).getConfig?.();
          const timeframe = instance?.config?.timeframe;
          if (timeframe && MARKET_TIMEFRAMES.includes(timeframe)) timeframes.push(timeframe);
        }
        if (node.getType() !== 'tabset') return;
        const tabset = node as FlexLayoutNode & { isMaximized?: () => boolean; isEnableTabStrip?: () => boolean; getSelectedNode?: () => FlexLayoutNode | undefined };
        const wantsStrip = node.getChildren().length > 1;
        if (tabset.isEnableTabStrip?.() !== wantsStrip) updates.push({ id: node.getId(), enableTabStrip: wantsStrip });
        if (tabset.isMaximized?.()) maximizedPanelId = tabset.getSelectedNode?.()?.getId() ?? null;
      });
      updates.forEach(update => model.doAction(FlexLayoutActions.updateNodeAttributes(update.id, { enableTabStrip: update.enableTabStrip })));
      if (!backtestSession && timeframes.length === count && count > 0) savePanelTimeframes(layoutStorageKey, timeframes);
      setPaneLayout(current => current.count === count && current.maximizedPanelId === maximizedPanelId
        ? current
        : { count, maximizedPanelId });
    };
    const schedule = () => { if (frame === null) frame = window.requestAnimationFrame(sync); };
    schedule();
    const unsubscribe = workspace.subscribe(() => {
      schedule();
      if (retry === null) retry = window.setTimeout(() => { retry = null; schedule(); }, 150);
    });
    // Maximalizace se do uloženého rozložení nepromítá okamžitě (debounce),
    // tlačítko ji ale hlásí hned — viz toggleMaximize.
    return () => {
      unsubscribe();
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (retry !== null) window.clearTimeout(retry);
    };
  }, [backtestSession, getLiveModel, layoutStorageKey, workspace, workspaceMountVersion]);
  const findTabset = useCallback((model: FlexLayoutModel, panelId: string) => {
    let tabsetId: string | null = null;
    model.visitNodes(node => {
      if (!tabsetId && node.getType() === 'tab' && node.getId() === panelId) tabsetId = node.getParent()?.getId() ?? null;
    });
    return tabsetId;
  }, []);
  /** Nový graf vedle aktivního (vpravo), ne jako schovaný tab. */
  const addPanelBeside = useCallback((config: WorkspacePanelConfig, title: string) => {
    const model = getLiveModel();
    const targetTabset = model ? (findTabset(model, activePanelId) ?? model.getActiveTabset()?.getId() ?? null) : null;
    if (!model || !targetTabset) {
      workspace.addPanel(WORKSPACE_KIND, config, title);
      return;
    }
    const id = `panel-${WORKSPACE_KIND}-${Date.now().toString(36)}`;
    const instance = { id, kind: WORKSPACE_KIND, title, config };
    model.doAction(FlexLayoutActions.addNode(
      { id, type: 'tab', name: title, component: WORKSPACE_KIND, config: instance },
      targetTabset,
      FlexLayoutDockLocation.RIGHT,
      -1,
      true,
    ));
    pendingActivePanelRef.current = id;
  }, [activePanelId, findTabset, getLiveModel, workspace]);
  const toggleMaximizePanel = useCallback((panelId: string) => {
    const model = getLiveModel();
    const tabsetId = model ? findTabset(model, panelId) : null;
    if (!model || !tabsetId) return;
    model.doAction(FlexLayoutActions.maximizeToggle(tabsetId));
    setPaneLayout(current => ({ ...current, maximizedPanelId: current.maximizedPanelId === panelId ? null : panelId }));
  }, [findTabset, getLiveModel]);
  const closePanel = useCallback((panelId: string) => {
    if (paneLayout.count <= 1) return;
    workspace.removePanel(panelId);
    setStatus('Graf zavřen');
  }, [paneLayout.count, workspace]);
  const showActiveRange = useCallback((range: ChartWorkspaceRange) => {
    const control = panelControlsRef.current.get(activePanelId);
    const chart = control?.chartApi?.controller.getChart();
    const target = control ? logicalRangeForLastSeconds(control.getCandles(), range.seconds) : null;
    if (!chart || !target) return;
    chart.timeScale().setVisibleLogicalRange(target);
    setStatus(range.seconds === null ? 'Celý rozsah dat' : `Posledních ${range.label}`);
  }, [activePanelId]);
  const goToActiveTime = useCallback((unixSeconds: number) => {
    const control = panelControlsRef.current.get(activePanelId);
    const chart = control?.chartApi?.controller.getChart();
    if (!control || !chart) return;
    const current = chart.timeScale().getVisibleLogicalRange();
    const target = logicalRangeCenteredOn(control.getCandles(), unixSeconds, current ? current.to - current.from : NaN);
    if (!target) {
      setStatus('Tenhle čas graf nemá načtený — data jsou jen kolem obchodu');
      return;
    }
    chart.timeScale().setVisibleLogicalRange(target);
    setStatus(`Graf na ${goToTimeLabel(unixSeconds, chartTimeZone)}`);
  }, [activePanelId, chartTimeZone]);
  const activeLatestTime = useCallback(
    () => panelControlsRef.current.get(activePanelId)?.getCandles().at(-1)?.time ?? null,
    [activePanelId],
  );
  const paneActions = useMemo<WorkspacePaneActions>(() => ({
    panelCount: paneLayout.count,
    maximizedPanelId: paneLayout.maximizedPanelId,
    toggleMaximize: toggleMaximizePanel,
    close: closePanel,
  }), [closePanel, paneLayout.count, paneLayout.maximizedPanelId, toggleMaximizePanel]);

  // Stejné pravidlo jako v selectReplayStart — graf podle něj ukáže, že nůžky
  // v dané oblasti nic neustřihnou, místo tichého odmítnutí.
  const replaySelectionMinimumTime = useMemo(() => {
    if (!backtestSession) return null;
    // S nůžkami před obchod (smazání po potvrzení) je hranicí jen začátek session.
    if (backtestSession.onRequestRewind) return backtestSession.startMs / 1_000;
    return Math.max(
      backtestSession.minimumReplayCursorTime ?? backtestSession.startMs / 1_000,
      backtestSession.replayHasExecutionHistory ? replay.cursorTime ?? -Infinity : -Infinity,
    );
  }, [backtestSession, replay.cursorTime]);
  const reviewTrades = review?.trades;
  const reviewDrawingKey = review?.drawingKey;
  const reviewPanelOverlay = review?.renderPanelOverlay;
  const reviewCandlesForRoot = review?.candlesForRoot;
  // Hodnocení i fullscreen obchodu: Bar Replay je připravený na obchod jako
  // přehrávač v detailu — panel je vidět hned a ▶ spustí přehrávání 15 min
  // před vstupem (zarovnáno na 15 min, ať sedí na svíčku 1m/5m/15m grafu).
  const reviewReplayStart = useMemo(() => {
    if (backtestSession) return null;
    const first = reviewTrades?.[0];
    const startMs = first ? tradeChartTiming(first).entryMs : review ? NaN : entryMs;
    return Number.isFinite(startMs) ? Math.floor((startMs - 15 * 60_000) / 900_000) * 900 : null;
  }, [backtestSession, entryMs, review, reviewTrades]);
  // Jiný obchod ve frontě = přehrávání předchozího obchodu končí.
  useEffect(() => {
    if (reviewReplayStart == null) return;
    replayDataRequestsRef.current.cancel();
    setReplay(DEFAULT_CHART_REPLAY_STATE);
  }, [reviewReplayStart]);
  const startReviewReplay = useCallback((action: 'play' | 'step') => {
    if (reviewReplayStart == null) return;
    selectReplayStart(reviewReplayStart);
    if (action === 'play') setReplay(current => current.phase === 'active' ? { ...current, playing: true } : current);
  }, [reviewReplayStart, selectReplayStart]);
  const reviewReplayIdle = reviewReplayStart != null && replay.phase === 'off';
  /** Obchod, ke kterému Go To nabízí skoky — v hodnocení první z fronty. */
  const replayTradeSource = backtestSession ? null : reviewTrades?.[0] ?? (review ? null : trade);
  const replayTradeEvents = useMemo(
    () => replayTradeSource ? tradeTimelineEvents(replayTradeSource.executionHistory) : [],
    [replayTradeSource],
  );
  const tradeGoTo = useMemo(() => {
    if (!replayTradeSource || reviewReplayStart == null) return null;
    const timing = tradeChartTiming(replayTradeSource);
    const minute = (ms: number) => Math.floor(ms / 60_000) * 60;
    const clock = (seconds: number) => new Intl.DateTimeFormat('cs-CZ', { timeZone: chartTimeZone, hour: '2-digit', minute: '2-digit' }).format(seconds * 1_000);
    const firstSeries = replayTradeEvents.find(event => event.seriesKey);
    const times: Record<string, number> = { start: reviewReplayStart };
    if (Number.isFinite(timing.entryMs)) times.entry = minute(timing.entryMs);
    if (firstSeries) times.series = minute(firstSeries.at);
    if (Number.isFinite(timing.exitMs)) times.exit = minute(timing.exitMs);
    const targets = [
      ...(replayTradeEvents.length ? [{ id: 'next', label: 'Další událost', hint: '→' }] : []),
      { id: 'start', label: 'Začátek', hint: clock(times.start) },
      ...(times.entry !== undefined ? [{ id: 'entry', label: 'Vstup', hint: clock(times.entry) }] : []),
      ...(times.series !== undefined ? [{ id: 'series', label: 'Posuny SL', hint: clock(times.series) }] : []),
      ...(times.exit !== undefined ? [{ id: 'exit', label: 'Výstup', hint: clock(times.exit) }] : []),
      { id: 'all', label: 'Celý obchod', hint: 'konec' },
    ];
    return { targets, times };
  }, [chartTimeZone, replayTradeEvents, replayTradeSource, reviewReplayStart]);
  /** Skok na událost obchodu jako v přehrávači detailu; před spuštěním replay rovnou nastartuje. */
  const goToTradeTarget = useCallback((id: string) => {
    if (!tradeGoTo || backtestSessionRef.current) return;
    if (id === 'all') { exitReplay(); return; }
    let time: number | undefined = tradeGoTo.times[id];
    if (id === 'next') {
      const cursor = replayRef.current.phase === 'active' ? replayRef.current.cursorTime : null;
      const cutoffMs = cursor === null ? -Infinity : (cursor + 60) * 1_000 - 1;
      const next = replayTradeEvents.find(event => event.at > cutoffMs);
      if (!next) { setStatus('Go To: žádná další událost obchodu'); return; }
      time = Math.floor(next.at / 60_000) * 60;
    }
    if (time === undefined) return;
    const source = panelControlsRef.current.get(activePanelId)?.rawCandles ?? [];
    const snapped = nearestReplayCandleTime(source, time);
    if (snapped === null) return;
    if (replayRef.current.phase === 'active') {
      replayDataRequestsRef.current.cancel();
      setReplay(current => ({ ...current, cursorTime: snapped, playing: false }));
    } else {
      selectReplayStart(snapped);
    }
    setStatus(`Go To: ${goToTimeLabel(snapped, chartTimeZone)}`);
  }, [activePanelId, chartTimeZone, exitReplay, replayTradeEvents, selectReplayStart, tradeGoTo]);
  const reviewHeaderRef = useRef<HTMLDivElement>(null);
  const reviewSideRef = useRef<HTMLDivElement>(null);
  const reviewBottomRef = useRef<HTMLDivElement>(null);
  const reviewLeftRef = useRef<HTMLDivElement>(null);
  const reviewOverlayRef = useRef<HTMLDivElement>(null);
  const onReviewSlotsReady = review?.onSlotsReady;
  useLayoutEffect(() => {
    if (!onReviewSlotsReady) return;
    const header = reviewHeaderRef.current, side = reviewSideRef.current, bottom = reviewBottomRef.current, left = reviewLeftRef.current;
    const overlay = reviewOverlayRef.current;
    if (header && side && bottom && left && overlay) onReviewSlotsReady({ header, side, bottom, left, overlay });
    return () => onReviewSlotsReady(null);
  }, [onReviewSlotsReady]);
  const onReviewReplayCursor = review?.onReplayCursor;
  const reviewCursorTime = replay.phase === 'active' ? replay.cursorTime : null;
  useEffect(() => {
    onReviewReplayCursor?.(reviewCursorTime);
  }, [onReviewReplayCursor, reviewCursorTime]);
  const enableIndicatorOnAllPanels = useCallback((indicator: 'fvg' | 'levels' | 'structure') => {
    const key = indicator === 'fvg' ? 'showFvg' : indicator === 'levels' ? 'showLevels' : 'showStructure';
    panelControlsRef.current.forEach(control => {
      if (control.config[key] !== true) control.updateConfig({ [key]: true });
    });
  }, []);
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
    replaySelectionMinimumTime,
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
    onTradeIndicatorsChange: backtestSession ? undefined : onTradeIndicatorsChange,
    chartNotes: backtestSession ? undefined : chartNotes,
    review: reviewTrades && reviewDrawingKey ? { trades: reviewTrades, drawingKey: reviewDrawingKey, renderPanelOverlay: reviewPanelOverlay, candlesForRoot: reviewCandlesForRoot } : undefined,
    onChartNotesChange: backtestSession ? undefined : onChartNotesChange,
    paneActions,
    showDayNotes: !backtestSession && layoutScope !== 'day',
    enableIndicatorOnAllPanels,
  }), [enableIndicatorOnAllPanels, layoutScope, paneActions, reviewTrades, reviewDrawingKey, reviewPanelOverlay, reviewCandlesForRoot, chartNotes, onChartNotesChange, onTradeIndicatorsChange, activatePanel, activePanelId, backtestSession, chartTradingSettings, entryMs, exitMs, initialCandles, initialRoot, isDark, openBacktestTradeReview, registerPanel, replay, replaySelectionMinimumTime, replaySelectionTime, selectReplayStart, trade, unregisterPanel]);
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
  /** Automatický snímek celého obchodu z 1m grafu jeho trhu (fullscreen, vycentrovaný). */
  const captureTradeSnapshot = useCallback(async (snapshotTrade: Trade) => {
    const root = snapshotTrade.instrument ?? snapshotTrade.symbol;
    const minutes = (control: { config: WorkspacePanelConfig }) => MARKET_TIMEFRAME_MINUTES[control.config.timeframe] ?? Infinity;
    const pick = () => [...panelControlsRef.current.values()]
      .filter(control => control.chartApi && (!root || control.config.root === root))
      .sort((left, right) => minutes(left) - minutes(right))[0];
    // Panel se mohl teprve připojovat (otevření hned po startu session) — chvíli počkat.
    let control = pick();
    for (let attempt = 0; !control?.chartApi && attempt < 10; attempt += 1) {
      await new Promise(resolve => window.setTimeout(resolve, 200));
      control = pick();
    }
    if (!control?.chartApi) throw new Error('Graf trhu obchodu není otevřený — snímek nejde pořídit.');
    const exitTime = Number.isFinite(snapshotTrade.timestamp) ? snapshotTrade.timestamp : Date.parse(snapshotTrade.date);
    return captureTradeChartSnapshot(control.chartApi, {
      instrument: root ?? '',
      direction: snapshotTrade.direction,
      entryTime: snapshotTrade.entryTime ?? exitTime,
      exitTime,
      entryPrice: snapshotTrade.entryPrice,
      exitPrice: snapshotTrade.exitPrice,
      stopLoss: snapshotTrade.stopLoss,
      takeProfit: snapshotTrade.takeProfit,
      pnl: snapshotTrade.pnl,
      riskAmount: snapshotTrade.riskAmount,
    }, isDark);
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
  // Dev diagnostika: přístup k enginům a panelům z konzole pro měření
  // sync a pointer cesty.
  if (import.meta.env.DEV) {
    const dev = window as unknown as { __atDrawingEngines?: unknown; __atPanels?: unknown; __atOpenTradeReview?: unknown; __atBacktestTrades?: unknown };
    dev.__atDrawingEngines = drawingEngines;
    dev.__atPanels = [...panelControls.values()];
    dev.__atOpenTradeReview = openBacktestTradeReview;
    dev.__atBacktestTrades = backtestSession?.closedTrades?.map(closed => ({ id: closed.id, entry: closed.entryTime, exit: closed.exitTime }));
  }
  const [workspaceHistoryState, setWorkspaceHistoryState] = useState<ChartWorkspaceHistoryState>({ canUndo: false, canRedo: false });
  const [selectedFib, setSelectedFib] = useState<{ engine: CandleKitDrawingEngine; drawing: FibDrawing } | null>(null);
  const [selectedPosition, setSelectedPosition] = useState<{ engine: CandleKitDrawingEngine; drawing: PositionDrawing } | null>(null);
  const [selectedDrawing, setSelectedDrawing] = useState<{ engine: CandleKitDrawingEngine; drawing: Drawing } | null>(null);
  const [fibSettingsOpen, setFibSettingsOpen] = useState(false);
  const [positionSettingsOpen, setPositionSettingsOpen] = useState(false);
  const [drawingSettingsOpen, setDrawingSettingsOpen] = useState(false);
  const positionQuickOrderRef = useRef<() => void>(() => {});

  // Engine mutuje kresby na místě a při tažení emituje change na každý pohyb
  // myši. Tenhle stav sedí na kořeni workspace — nový wrapper objekt za emit by
  // znamenal překreslení všech panelů za každý pohyb. Výběr proto drží identitu,
  // dokud se nezmění vybraná kresba, a překreslení toolbaru (změněný styl) se
  // doplní jedním trailing refreshem po konci bursty.
  const selectionRefreshTimerRef = useRef<number | null>(null);
  const scheduleSelectionRefresh = useCallback(() => {
    if (selectionRefreshTimerRef.current !== null) window.clearTimeout(selectionRefreshTimerRef.current);
    selectionRefreshTimerRef.current = window.setTimeout(() => {
      selectionRefreshTimerRef.current = null;
      setSelectedFib(current => (current ? { ...current } : current));
      setSelectedPosition(current => (current ? { ...current } : current));
      setSelectedDrawing(current => (current ? { ...current } : current));
    }, 160);
  }, []);
  useEffect(() => () => {
    if (selectionRefreshTimerRef.current !== null) window.clearTimeout(selectionRefreshTimerRef.current);
  }, []);

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
        setSelectedFib(current => {
          if (current && current.engine === engine && current.drawing === drawing) {
            scheduleSelectionRefresh();
            return current;
          }
          return { engine, drawing: drawing as FibDrawing };
        });
        setSelectedPosition(null);
        setSelectedDrawing(null);
        setPositionSettingsOpen(false);
        setDrawingSettingsOpen(false);
      } else if (isPositionDrawing(drawing)) {
        setSelectedFib(null);
        setSelectedPosition(current => {
          if (current && current.engine === engine && current.drawing === drawing) {
            scheduleSelectionRefresh();
            return current;
          }
          return { engine, drawing };
        });
        setSelectedDrawing(null);
        setFibSettingsOpen(false);
        setDrawingSettingsOpen(false);
      } else {
        setSelectedFib(null);
        setSelectedPosition(null);
        setFibSettingsOpen(false);
        setPositionSettingsOpen(false);
        setSelectedDrawing(current => {
          if (!drawing || drawing.id.startsWith('auto-')) return null;
          if (current && current.engine === engine && current.drawing === drawing) {
            scheduleSelectionRefresh();
            return current;
          }
          return { engine, drawing };
        });
        if (!drawing || drawing.id.startsWith('auto-')) setDrawingSettingsOpen(false);
        else if (drawing.tool === 'Text' && !drawing.style.text?.trim()) setDrawingSettingsOpen(true);
      }
    };
    sync();
    return engine.onChange(sync);
  }, [activeControl?.drawingEngine, scheduleSelectionRefresh]);

  useEffect(() => {
    workspaceHistory.updatePanels(panelControls);
  }, [panelControls, workspaceHistory]);

  useEffect(() => workspaceHistory.subscribe(setWorkspaceHistoryState), [workspaceHistory]);

  useEffect(() => {
    if (Object.keys(pendingSessionPanelsRef.current).length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      const ready = Object.fromEntries(Object.entries(pendingSessionPanelsRef.current)
        .filter(([id, saved]) => workspacePanelsReady({ [id]: saved }, panelControlsRef.current)));
      if (!Object.keys(ready).length) return;
      workspaceHistory.importSnapshot({ ...workspaceHistory.exportSnapshot(), ...ready });
      Object.keys(ready).forEach(id => { delete pendingSessionPanelsRef.current[id]; });
      if (!Object.keys(pendingSessionPanelsRef.current).length) setStatus('Session obnovena včetně kreseb, indikátorů a měřítek');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [backtestSession, panelControls, workspaceHistory]);

  useEffect(() => {
    if (!backtestSession?.id) return;
    replayChangeRef.current?.(replay);
  }, [backtestSession?.id, replay]);

  useEffect(() => {
    if (!backtestSession || replay.phase !== 'off') return;
    const first = backtestSession.candlesByRoot[backtestSession.executionInstrument]?.[0];
    if (!first) return;
    setReplay({ phase: 'active', cursorTime: first.time, startTime: first.time, playing: false, speed: 1 });
  }, [backtestSession, replay.phase]);

  const readWorkspaceState = useCallback((): CompleteChartWorkspaceState | undefined => {
      if (captureOverrideRef.current) return captureOverrideRef.current;
      if (backtestSessionRef.current && !restoredSessionLayoutRef.current) return undefined;
      const scopedAppearance = chartAppearanceSnapshot();
      if (backtestSessionRef.current && scopedAppearance === undefined) return undefined;
      const layout = workspace.exportLayout();
      const panelIds = workspaceLayoutPanelIds(layout);
      if (!panelIds.size) return undefined;
      return {
        layout,
        panels: mergeWorkspacePanelSnapshots(workspaceHistory.exportSnapshot(), pendingSessionPanelsRef.current, panelIds),
        layoutId,
        activePanelId,
        syncSettings,
        // Vzhled musí být součástí otisku, jinak by se změna barvy levelu
        // uložila až s příští úpravou layoutu nebo kresby.
        appearance: scopedAppearance ?? Object.fromEntries(CHART_APPEARANCE_SLOTS
          .map(slot => [slot, inheritGlobalAppearance(slot)])
          .filter(([, value]) => value !== undefined)),
      };
  }, [activePanelId, layoutId, syncSettings, workspace, workspaceHistory]);

  const checkpointWorkspace = useMemo(() => createBacktestWorkspaceCheckpoint(
    readWorkspaceState,
    state => workspaceChangeRef.current?.(state),
  ), [readWorkspaceState]);

  useLayoutEffect(() => backtestSession?.registerWorkspaceCheckpoint?.(checkpointWorkspace), [backtestSession?.registerWorkspaceCheckpoint, checkpointWorkspace]);

  useEffect(() => {
    if (!backtestSession) return;
    const timer = window.setInterval(checkpointWorkspace, 1_200);
    // Parent flush captures synchronously before persistence, including Close,
    // visibility/pagehide and cloud restore. An unmount capture is too late.
    return () => window.clearInterval(timer);
  }, [backtestSession?.id, checkpointWorkspace]);

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

  // ⌥↩ (Alt+Enter) maximalizuje aktivní graf a zase vrátí rozložení —
  // náhrada za tlačítka v rohu každého grafu.
  useEffect(() => {
    const handleMaximizeKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.key !== 'Enter') return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (paneActions.panelCount <= 1 && !paneActions.maximizedPanelId) return;
      event.preventDefault();
      paneActions.toggleMaximize(paneActions.maximizedPanelId ?? activePanelId);
    };
    window.addEventListener('keydown', handleMaximizeKey);
    return () => window.removeEventListener('keydown', handleMaximizeKey);
  }, [activePanelId, paneActions]);

  // Mezerník přehrává, šipka doprava krokuje o svíčku. Obojí jen v běžícím
  // replay a mimo formulářová pole — jinak by mezerník nešel napsat do poznámky
  // a šipka by neposunula kurzor v ceně objednávky.
  useEffect(() => {
    if (replay.phase !== 'active') return;
    const handleReplayKey = (event: KeyboardEvent) => {
      if (replayInteractionPausedRef.current) return;
      // `instanceof Element` není zbytečné: cílem může být i window (událost
      // poslaná programově), a ten `closest` nemá — výjimka by zkratku shodila.
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const shortcut = chartReplayShortcut(event);
      if (!shortcut) return;
      // Mezerník jinak odscrolluje stránku, šipka posune časovou osu grafu.
      event.preventDefault();
      if (shortcut === 'step-back') {
        pendingBackStepsRef.current += 1;
        if (backStepFrameRef.current === null) {
          backStepFrameRef.current = window.requestAnimationFrame(() => {
            backStepFrameRef.current = null;
            const steps = pendingBackStepsRef.current;
            pendingBackStepsRef.current = 0;
            if (steps > 0) rewindReplayBy(steps);
          });
        }
        return;
      }
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
  }, [advanceReplayBy, replay.phase, rewindReplayBy]);

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
    const fallback = activeControl?.config ?? panelConfig(initialRoot, '1m', indicatorDefaults);
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
    try { window.localStorage.setItem(layoutStorageKey, nextLayoutId); } catch { /* private storage */ }
    setStatus(`Layout ${nextLayoutId} · ${template.panelCount} graf${template.panelCount === 1 ? '' : 'y'}`);
  }, [activeControl?.config, indicatorDefaults, initialRoot, layoutStorageKey, workspace]);

  useEffect(() => installChartWorkspaceSync(panelControls, syncSettings), [
    panelControls,
    syncSettings.crosshair,
    syncSettings.dateRange,
    syncSettings.time,
  ]);

  // Panely deníku na vrstvě kreseb sdílí kresby přes vrstvu (podle trhu a času);
  // kopírování mezi panely by se s ní tlouklo — u panelů s jiným oknem dnů by
  // dokonce smazalo kresbu. Zůstává pro backtest a pro zařízení bez převodu.
  const [drawingLayerOn, setDrawingLayerOn] = useState(drawingLayerReady);
  useEffect(() => subscribeDrawingLayer(() => setDrawingLayerOn(drawingLayerReady())), []);
  useEffect(() => {
    if (!syncSettings.drawings) return () => undefined;
    if (!backtestSession && drawingLayerOn) return () => undefined;
    const activeEngine = activeControl?.drawingEngine;
    const orderedEngines = activeEngine
      ? [activeEngine, ...drawingEngines.filter(engine => engine !== activeEngine)]
      : drawingEngines;
    return installWorkspaceDrawingSync(orderedEngines);
  }, [activeControl?.drawingEngine, backtestSession, drawingEngines, drawingLayerOn, syncSettings.drawings]);

  const resetWorkspace = useCallback(() => {
    workspace.importLayout({
      version: 1,
      id: workspace.id,
      name: 'default',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tree: buildWorkspaceLayout(initialRoot, defaultLayoutId, undefined, indicatorDefaults),
      panels: {},
    });
    setLayoutId(defaultLayoutId);
    nextPanelNumberRef.current = getChartWorkspaceLayout(defaultLayoutId).panelCount + 1;
    try { window.localStorage.setItem(layoutStorageKey, defaultLayoutId); } catch { /* private storage */ }
    setActivePanelId('alphatrade-chart-1');
    setStatus('Výchozí rozložení obnoveno');
  }, [defaultLayoutId, indicatorDefaults, initialRoot, layoutStorageKey, workspace]);

  const persistWorkspaceStatus = useCallback(async (message: string) => {
    const result = await backtestSessionRef.current?.onSaveWorkspace?.();
    if (result && !result.localSaved) { setStatus(`${message}; uložení session do tohoto zařízení selhalo — zkus uložení znovu`); return; }
    setStatus(`${message}${result ? result.cloudSaved ? ' · session uložena i v cloudu' : ' · session uložená lokálně, cloud čeká na synchronizaci' : ' · v tomto zařízení'}`);
  }, []);

  const applyWorkspaceState = useCallback((next: CompleteChartWorkspaceState) => {
    const before = readWorkspaceState();
    if (!before) throw new Error('Počkej na dokončení načítání grafů.');
    // This remount is structural: panel configs and all saved drawings/indicators
    // are replaced together. A paint-only appearance edit never takes this path.
    try {
      replaceChartAppearance(next.appearance);
      workspace.importLayout(next.layout);
    } catch (reason) {
      replaceChartAppearance(before.appearance);
      workspace.importLayout(before.layout);
      throw reason;
    }
    captureOverrideRef.current = structuredClone(next);
    pendingSessionPanelsRef.current = structuredClone(next.panels);
    pendingActivePanelRef.current = next.activePanelId;
    panelControlsRef.current = new Map();
    setPanelControls(new Map());
    workspaceHistory.updatePanels(new Map());
    setLayoutId(next.layoutId);
    setActivePanelId(next.activePanelId);
    setSyncSettings(next.syncSettings);
    setWorkspaceMountVersion(version => version + 1);
    workspaceChangeRef.current?.(next);
  }, [readWorkspaceState, workspace, workspaceHistory]);

  const applyWorkspaceInput = useCallback(async (input: unknown) => {
    const parsed = parseChartWorkspaceDocument(input, { allowedRoots: backtestSessionRef.current?.allowedRoots });
    const before = readWorkspaceState();
    if (!before) throw new Error('Počkej na dokončení načítání grafů.');
    const ids = parsed.kind === 'legacy' ? workspaceLayoutPanelIds(parsed.layout) : null;
    const next = parsed.kind === 'complete' ? parsed.document.state : {
      ...before, layout: parsed.layout,
      panels: mergeWorkspacePanelSnapshots(before.panels, {}, ids!),
      activePanelId: ids!.has(before.activePanelId) ? before.activePanelId : [...ids!][0],
    };
    // Fail before mutation when quota prevents keeping a recoverable prior state.
    storeWorkspaceRecovery(chartAppearanceUserId(), backtestSessionRef.current?.id, before, window.localStorage);
    applyWorkspaceState(next);
    await persistWorkspaceStatus(parsed.kind === 'complete' ? 'Workspace obnoven včetně kreseb, indikátorů a vzhledu' : 'Starší rozložení načteno; soubor neobsahuje kresby ani vzhled');
  }, [applyWorkspaceState, persistWorkspaceStatus, readWorkspaceState]);

  const previewWorkspace = useCallback((input: unknown) => {
    // Validate structural and nested data before rendering even a preview.
    const parsed = parseChartWorkspaceDocument(input);
    const valid = parsed.kind === 'complete' ? parsed.document : parsed.layout;
    let error: string | undefined;
    try { parseChartWorkspaceDocument(valid, { allowedRoots: backtestSessionRef.current?.allowedRoots }); }
    catch (reason) { error = reason instanceof Error ? reason.message : 'Nekompatibilní workspace.'; }
    setReplay(current => ({ ...current, playing: false }));
    setWorkspacePreview({ input: valid, owner: chartAppearanceUserId(), sessionId: backtestSessionRef.current?.id, error });
    setWorkspaceLibraryMode(null);
  }, []);

  const saveWorkspace = useCallback(() => { setReplay(current => ({ ...current, playing: false })); setWorkspaceLibraryMode('save'); }, []);
  const saveNamedWorkspace = useCallback(async (input: { id?: string; name: string; makeDefault: boolean }) => {
    const state = readWorkspaceState();
    if (!state) throw new Error('Počkej na dokončení načítání grafů.');
    const owner = chartAppearanceUserId();
    const document = createChartWorkspaceDocument(state, { allowedRoots: backtestSessionRef.current?.allowedRoots });
    window.localStorage.setItem(chartWorkspaceDocumentStorageKey(owner, backtestSessionRef.current?.id), JSON.stringify(document));
    saveWorkspaceTemplate(owner, { ...input, state: document.state });
    setWorkspaceLibraryMode(null);
    await persistWorkspaceStatus(`Šablona „${input.name.trim()}“ uložena v tomto prohlížeči`);
  }, [persistWorkspaceStatus, readWorkspaceState]);

  const loadWorkspaceCheckpoint = useCallback(async () => {
    const owner = chartAppearanceUserId();
    const sessionId = backtestSessionRef.current?.id;
    try {
      const saved = window.localStorage.getItem(chartWorkspaceDocumentStorageKey(owner, sessionId));
      if (saved) { previewWorkspace(saved); return; }
      if (!sessionId && owner !== null) { setStatus('Zatím není uložený žádný checkpoint'); return; }
      const storage = new LocalStoragePersistence(window.localStorage, sessionId ? `alphatrade.candlekit.backtest.${sessionId}` : 'alphatrade.candlekit');
      const legacy = (await storage.list()).find(layout => layout.name === SAVED_LAYOUT_NAME);
      if (!legacy) { setStatus('Zatím není uložený žádný checkpoint'); return; }
      const input = await storage.get(legacy.id);
      if (owner !== chartAppearanceUserId() || sessionId !== backtestSessionRef.current?.id) throw new Error('Uživatel nebo session se změnili. Načtení zrušeno.');
      previewWorkspace(input);
    } catch (reason) { setStatus(reason instanceof Error ? reason.message : 'Workspace se nepodařilo načíst.'); }
  }, [previewWorkspace]);
  const loadWorkspace = useCallback(() => { setReplay(current => ({ ...current, playing: false })); setWorkspaceLibraryMode('load'); }, []);

  const applyWorkspacePreview = useCallback(async () => {
    if (!workspacePreview || workspaceApplying) return;
    if (workspacePreview.owner !== chartAppearanceUserId() || workspacePreview.sessionId !== backtestSessionRef.current?.id) {
      setWorkspacePreview(null); setStatus('Uživatel nebo session se změnili. Otevři náhled znovu.'); return;
    }
    setWorkspaceApplying(true);
    try { await applyWorkspaceInput(workspacePreview.input); setWorkspacePreview(null); }
    catch (reason) { setStatus(reason instanceof Error ? reason.message : 'Workspace se nepodařilo obnovit.'); }
    finally { setWorkspaceApplying(false); }
  }, [applyWorkspaceInput, workspaceApplying, workspacePreview]);

  const adoptJournalStyle = useCallback(() => {
    const undo = adoptJournalAppearance();
    if (!undo) { setStatus('Styl jde převzít jen v otevřené backtest session.'); return; }
    void persistWorkspaceStatus('Styl grafů převzatý z hlavní appky');
    announceChartProfileChange('Styl převzatý z hlavní appky', () => {
      undo();
      void persistWorkspaceStatus('Původní styl session vrácen');
    });
  }, [persistWorkspaceStatus]);
  const recoverWorkspace = useCallback(() => {
    try {
      const saved = window.localStorage.getItem(`${chartWorkspaceDocumentStorageKey(chartAppearanceUserId(), backtestSessionRef.current?.id)}:recovery`);
      if (!saved) { setStatus('Zatím není návratová kopie. Vznikne před načtením nebo importem workspace.'); return; }
      previewWorkspace(saved);
    } catch (reason) { setStatus(reason instanceof Error ? reason.message : 'Návratovou kopii nelze načíst.'); }
  }, [previewWorkspace]);

  const exportWorkspace = useCallback(() => {
    try {
    const state = readWorkspaceState();
    if (!state) throw new Error('Počkej na dokončení načítání grafů.');
    const blob = new Blob([JSON.stringify(createChartWorkspaceDocument(state), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'alphatrade-workspace.json';
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus('Úplný workspace exportován včetně kreseb a vzhledu');
    } catch (reason) { setStatus(reason instanceof Error ? reason.message : 'Export workspace selhal.'); }
  }, [readWorkspaceState]);

  const importWorkspace = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const input = event.target;
    const owner = chartAppearanceUserId();
    const sessionId = backtestSessionRef.current?.id;
    try {
      const contents = await file.text();
      if (owner !== chartAppearanceUserId() || sessionId !== backtestSessionRef.current?.id) throw new Error('Uživatel nebo session se změnili. Import zrušen.');
      previewWorkspace(contents);
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : 'Soubor neobsahuje platný workspace.');
    } finally {
      input.value = '';
    }
  }, [previewWorkspace]);

  /**
   * Dvojklik na splitter vrátí dělící čáru doprostřed mezi oba sousední
   * panely. `data-layout-path` splitteru má tvar `<cesta rodiče>/s<i>`, kde
   * `i` je index prvního ze dvou sousedů; cesta rodiče je posloupnost segmentů
   * `r<n>` / `ts<n>` (index dítěte). Funguje i pro vnořená dělení; ostatní
   * sourozenci si váhu ponechají.
   */
  const centerSplitter = useCallback((splitterPath: string | null) => {
    const segments = (splitterPath ?? '/s0').split('/').filter(Boolean);
    const splitterSegment = segments.pop();
    const splitterIndex = Number(splitterSegment?.replace(/^s/, ''));
    const parentPath = segments.length > 0 ? `/${segments.join('/')}` : '';
    // Preferovaná cesta: akce na živém FlexLayout modelu (přes záplatu
    // `driver.getModel`). Panely zůstanou namontované — žádný problik grafů.
    const liveModel = (workspace as unknown as { driver?: { getModel?: () => FlexLayoutModel | null } })
      .driver?.getModel?.() ?? null;
    if (liveModel) {
      let parentNode: FlexLayoutNode | undefined;
      liveModel.visitNodes(node => {
        if (parentNode) return;
        // Kořenová řada nemá rodiče a splitter na ní má cestu jen `/s<i>`.
        if (parentPath === '' ? node.getParent() === undefined && node.getType() === 'row' : node.getPath() === parentPath) {
          parentNode = node;
        }
      });
      const liveChildren = parentNode?.getChildren() ?? [];
      if (parentNode && liveChildren.length >= 2) {
        const weights = liveChildren.map(child => (child as { getWeight?: () => number }).getWeight?.() ?? 100);
        if (Number.isInteger(splitterIndex) && splitterIndex >= 0 && splitterIndex < weights.length - 1) {
          const half = (weights[splitterIndex] + weights[splitterIndex + 1]) / 2;
          weights[splitterIndex] = half;
          weights[splitterIndex + 1] = half;
        } else {
          weights.fill(100 / weights.length);
        }
        liveModel.doAction(FlexLayoutActions.adjustWeights(parentNode.getId(), weights));
        setStatus('Grafy vycentrovány');
        return;
      }
    }
    // Fallback bez živého modelu: úprava JSON stromu a import (remount panelů).
    const exported = workspace.exportLayout() as {
      tree?: { layout?: { children?: Array<{ weight?: number; children?: unknown[] }> } };
    };
    const next = typeof structuredClone === 'function'
      ? structuredClone(exported)
      : JSON.parse(JSON.stringify(exported));
    let parent: { children?: Array<{ weight?: number; children?: unknown[] }> } | undefined = next.tree?.layout;
    for (const segment of segments) {
      const index = Number(segment.replace(/^[a-z]+/, ''));
      const child = parent?.children?.[index] as { weight?: number; children?: unknown[] } | undefined;
      if (!child) { parent = undefined; break; }
      parent = child;
    }
    const children = parent?.children as Array<{ weight?: number }> | undefined;
    if (!Array.isArray(children) || children.length < 2) return;
    const left = Number.isInteger(splitterIndex) && splitterIndex >= 0 && splitterIndex < children.length - 1
      ? splitterIndex
      : null;
    if (left == null) {
      const equalWeight = 100 / children.length;
      children.forEach(child => { child.weight = equalWeight; });
    } else {
      const a = children[left];
      const b = children[left + 1];
      const half = ((a.weight ?? 100) + (b.weight ?? 100)) / 2;
      a.weight = half;
      b.weight = half;
    }
    workspace.importLayout(next);
    setStatus('Grafy vycentrovány');
  }, [workspace]);

  useEffect(() => {
    const shell = workspaceShellRef.current;
    if (!shell) return;
    // Druhý klik dvojkliku dopadne na dočasný překryv `flexlayout__splitter_drag`,
    // který není potomkem splitteru — cíl dvojkliku proto nestačí. Pamatujeme si
    // poslední pointerdown na splitteru a dvojklik k němu přiřadíme.
    let lastSplitter: { path: string | null; at: number } | null = null;
    const handlePointerDown = (event: PointerEvent) => {
      const splitter = (event.target as Element).closest?.('.flexlayout__splitter') as HTMLElement | null;
      lastSplitter = splitter ? { path: splitter.dataset.layoutPath ?? null, at: event.timeStamp } : null;
    };
    const handleDoubleClick = (event: MouseEvent) => {
      const target = event.target as Element;
      const splitter = target.closest?.('.flexlayout__splitter') as HTMLElement | null;
      const viaOverlay = !splitter
        && lastSplitter != null
        && event.timeStamp - lastSplitter.at < 700
        && (target.classList.contains('flexlayout__splitter_drag') || target.classList.contains('flexlayout__layout'));
      if (splitter || viaOverlay) {
        event.preventDefault();
        event.stopPropagation();
        const path = splitter?.dataset.layoutPath ?? lastSplitter?.path ?? null;
        // Až po doběhnutí flexlayout pointerup/drag-end, aby import vah nepřepsal.
        window.setTimeout(() => centerSplitter(path), 0);
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
    shell.addEventListener('pointerdown', handlePointerDown, true);
    shell.addEventListener('dblclick', handleDoubleClick, true);
    shell.addEventListener('wheel', handleWheel, true);
    shell.addEventListener('pointerup', handlePointerUp, true);
    return () => {
      shell.removeEventListener('pointerdown', handlePointerDown, true);
      shell.removeEventListener('dblclick', handleDoubleClick, true);
      shell.removeEventListener('wheel', handleWheel, true);
      shell.removeEventListener('pointerup', handlePointerUp, true);
    };
  }, [centerSplitter, selectedDrawing, selectedFib, selectedPosition, workspaceHistory]);

  const timelineEvents = useMemo(
    () => !backtestSession && !review ? tradeTimelineEvents(trade.executionHistory) : [],
    [backtestSession, review, trade.executionHistory],
  );
  // Sbalená lišta kreslení — jen ouško u okraje, oblíbené zůstávají.
  const [drawingRailCollapsed, setDrawingRailCollapsed] = useState(() => {
    try { return window.localStorage.getItem(DRAWING_RAIL_COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const setDrawingRailCollapsedPersisted = useCallback((next: boolean) => {
    setDrawingRailCollapsed(next);
    try { window.localStorage.setItem(DRAWING_RAIL_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* jen pohodlí */ }
  }, []);
  // ── Horní lišta posuvná do stran ────────────────────────────────────────
  const toolbarViewportRef = useRef<HTMLDivElement>(null);
  const toolbarRowRef = useRef<HTMLDivElement>(null);
  const [toolbarOffset, setToolbarOffset] = useState(0);
  const [toolbarMaxOffset, setToolbarMaxOffset] = useState(0);
  const [toolbarDragging, setToolbarDragging] = useState(false);
  const toolbarOffsetRef = useRef(0);
  toolbarOffsetRef.current = toolbarOffset;
  const toolbarDragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => toolbarDragCleanupRef.current?.(), []);
  const toolbarDragRef = useRef<{ startX: number; startOffset: number; moved: boolean } | null>(null);
  const toolbarDraggedRef = useRef(false);
  /** Kolik lišta přesahuje — měřeno vždy čerstvě, ResizeObserver může být o krok pozadu. */
  const toolbarOverflow = useCallback(() => {
    const viewport = toolbarViewportRef.current;
    const row = toolbarRowRef.current;
    return viewport && row ? Math.max(0, Math.ceil(row.scrollWidth - viewport.clientWidth)) : 0;
  }, []);
  /** Posun v mezích lišty; mez se spočítá mimo updater stavu. */
  const moveToolbar = useCallback((next: (current: number) => number) => {
    const max = toolbarOverflow();
    setToolbarMaxOffset(max);
    setToolbarOffset(current => Math.min(max, Math.max(0, next(current))));
  }, [toolbarOverflow]);
  const scrollToolbarBy = useCallback((delta: number) => moveToolbar(current => current + delta), [moveToolbar]);
  useLayoutEffect(() => {
    const viewport = toolbarViewportRef.current;
    const row = toolbarRowRef.current;
    if (!viewport || !row) return;
    const measure = () => {
      const max = toolbarOverflow();
      setToolbarMaxOffset(max);
      setToolbarOffset(current => Math.min(max, current));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(row);
    return () => observer.disconnect();
  }, [toolbarOverflow]);
  // Kolečko i trackpad: svislý i vodorovný pohyb posune lištu (jen když se nevejde).
  useEffect(() => {
    const viewport = toolbarViewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      const max = toolbarOverflow();
      if (max <= 0) return;
      const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const delta = event.deltaMode === 1 ? raw * 16 : raw;
      const current = toolbarOffsetRef.current;
      // Na dorazu nic nebrzdit — stránka (např. Den) se pak normálně posouvá.
      if (!delta || (delta < 0 && current <= 0) || (delta > 0 && current >= max)) return;
      event.preventDefault();
      moveToolbar(value => value + delta);
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [moveToolbar, toolbarOverflow]);
  /** Tah myší nebo prstem; klik na tlačítko po tahu se nepočítá. */
  const beginToolbarDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    toolbarDraggedRef.current = false;
    if (event.button !== 0 || toolbarOverflow() <= 0) return;
    // Uvnitř otevřeného popupu (timeframe, indikátory, layout, průběh) se netáhne.
    if ((event.target as Element | null)?.closest?.('[data-toolbar-popup],[role="dialog"]')) return;
    toolbarDragCleanupRef.current?.();
    toolbarDragRef.current = { startX: event.clientX, startOffset: toolbarOffsetRef.current, moved: false };
    const move = (moveEvent: PointerEvent) => {
      const drag = toolbarDragRef.current;
      if (!drag) return;
      const dx = moveEvent.clientX - drag.startX;
      if (!drag.moved && Math.abs(dx) < 6) return;
      if (!drag.moved) setToolbarDragging(true);
      drag.moved = true;
      toolbarDraggedRef.current = true;
      const target = drag.startOffset - dx;
      moveToolbar(() => target);
    };
    const end = () => {
      toolbarDragRef.current = null;
      toolbarDragCleanupRef.current = null;
      setToolbarDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      // Klik po tahu přijde hned po pointerup; pozdější klik (i klávesnicí) už platí.
      window.setTimeout(() => { toolbarDraggedRef.current = false; }, 0);
    };
    toolbarDragCleanupRef.current = end;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }, [moveToolbar, toolbarOverflow]);
  /** Tab na tlačítko schované za okrajem lištu posune, aby bylo vidět. */
  const revealFocusedToolbarItem = useCallback((event: React.FocusEvent) => {
    const viewport = toolbarViewportRef.current;
    const target = event.target as HTMLElement;
    // Jen fokus z klávesnice — posun pod myší mezi mousedown a mouseup by klik ztratil.
    if (!viewport || !target.matches?.(':focus-visible') || target.closest('[data-toolbar-popup],[role="dialog"]')) return;
    viewport.scrollLeft = 0;
    const view = viewport.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const edge = 28;
    if (rect.left < view.left + edge) moveToolbar(current => current - (view.left + edge - rect.left));
    else if (rect.right > view.right - edge) moveToolbar(current => current + (rect.right - (view.right - edge)));
  }, [moveToolbar]);
  const suppressToolbarClickAfterDrag = useCallback((event: React.MouseEvent) => {
    if (!toolbarDraggedRef.current) return;
    toolbarDraggedRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const toolbarSurface = isDark ? 'border-white/10 bg-[#0d1219]' : 'border-slate-200 bg-white';
  const topButton = `h-8 inline-flex items-center gap-1.5 px-2 rounded-md text-[9px] font-bold transition-colors ${isDark ? 'text-slate-400 hover:bg-white/5 hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'}`;
  const topDivider = `h-6 w-px shrink-0 ${isDark ? 'bg-white/10' : 'bg-slate-200'}`;
  const replaySource = backtestSession?.candlesByRoot[backtestSession.executionInstrument] ?? activeControl?.rawCandles ?? [];
  const replayDivider = `mx-0.5 h-5 w-px shrink-0 ${isDark ? 'bg-white/10' : 'bg-slate-900/10'}`;
  const replayButton = `h-8 inline-flex items-center gap-1.5 px-2 rounded-lg text-[9px] font-bold transition-colors ${chartGlassButton(isDark)}`;
  const replayAtEnd = isReplayAtLatestCandle(replaySource, replay.cursorTime)
    && (!backtestSession?.onEnsureReplayData || (backtestSession.loadedUntilMs ?? 0) >= backtestSession.endMs);
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
  const tradingPanel = backtestSession?.renderTradingPanel?.({ replay, candle: replayCandle, instrument: backtestSession.executionInstrument });
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
    <React.Profiler id="chart-workspace" onRender={devWorkspaceProfilerOnRender}>
    <div onPointerDownCapture={() => backtestCandleSettleRef.current?.()} className={`${embedded ? 'relative isolate h-full w-full overflow-hidden' : 'fixed inset-0 z-[300]'} flex flex-col ${isDark ? 'dark bg-[#070a0f] text-slate-100' : 'bg-[#f4f6f8] text-slate-900'}`}>
      {/* Review: řádek týdne a statistik nahoře, lišta grafu přímo nad grafem. */}
      {review && <div ref={reviewHeaderRef} className="shrink-0" />}
      <div className={`relative z-[660] h-10 shrink-0 flex items-center gap-1 border-b ${toolbarSurface}`}>
        <div className={`relative z-[120] flex h-full items-center gap-2 pl-2 pr-1 min-w-0 ${toolbarSurface}`}>
          <img
            src="/logos/at_logo_light_clean.png"
            alt="Alpha Trade"
            className={`h-8 w-8 shrink-0 object-contain ${isDark ? 'drop-shadow-[0_0_12px_rgba(34,211,238,0.35)]' : ''}`}
          />
        </div>
        {/* Nástroje se na úzkém okně posouvají do stran (kolečko, trackpad, tah
            prstem, šipky na okrajích). Posun je přes transform, ne overflow —
            rozbalovací menu z lišty (timeframy, indikátory, Průběh, Layout) by
            overflow ořízl. Logo a „Zpět“ zůstávají a zakrývají, co pod ně odjede. */}
        <div
          ref={toolbarViewportRef}
          className="relative flex h-full min-w-0 flex-1 items-center touch-pan-y"
          onPointerDown={beginToolbarDrag}
          onClickCapture={suppressToolbarClickAfterDrag}
          onFocusCapture={revealFocusedToolbarItem}
        >
          {toolbarOffset > 0 && (
            <button
              type="button"
              className={`absolute left-0 z-[115] grid h-8 w-6 place-items-center rounded-md ${toolbarSurface} ${isDark ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-slate-950'} shadow-[8px_0_10px_-6px_rgba(0,0,0,0.25)]`}
              onClick={() => scrollToolbarBy(-240)}
              aria-label="Posunout lištu doleva"
              title="Posunout lištu doleva"
            ><ChevronLeft size={15} /></button>
          )}
          <div
            ref={toolbarRowRef}
            className={`flex h-full w-max shrink-0 items-center gap-1 ${toolbarDragging ? '' : 'transition-transform duration-150 ease-out'}`}
            style={{ transform: `translateX(${-toolbarOffset}px)` }}
          >
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
        {/* Stejně jako v detailu obchodu: průběh je seznam pod tlačítkem, ne panel
            pod grafem — graf má celou výšku. */}
        {timelineEvents.length > 0 && (
          <TradeProgress
            events={timelineEvents}
            cursorMs={replay.phase === 'active' && replay.cursorTime !== null ? replay.cursorTime * 1_000 : null}
            isDark={isDark}
            orderDetails
          />
        )}
        <span className={topDivider} />
        <button type="button" className={topButton} onClick={() => {
          const panelNumber = nextPanelNumberRef.current;
          nextPanelNumberRef.current += 1;
          addPanelBeside(panelConfig(initialRoot, '1m', indicatorDefaults), `Graf ${panelNumber}`);
          setStatus('Nový panel přidán');
        }} title="Přidat nový graf"><Plus size={15} /> <span className="hidden md:inline">Graf</span></button>
        <span className={topDivider} />
        {onSaveSnapshot && !backtestSession && (
          <ChartSnapshotButton
            className={topButton}
            compactLabel
            capture={async () => {
              if (!workspaceShellRef.current || panelControlsRef.current.size === 0) throw new Error('Grafy ještě nejsou připravené.');
              return captureChartWorkspaceSnapshotDataUrl(workspaceShellRef.current, isDark, { hideControls: true });
            }}
            onSave={onSaveSnapshot}
            flashTarget={() => workspaceShellRef.current}
          />
        )}
        <div className="relative">
          <button
            type="button"
            className={`${topButton} ${layoutPickerOpen ? (isDark ? 'bg-white/10 text-white' : 'bg-slate-100 text-slate-950') : ''}`}
            onClick={() => setLayoutPickerOpen(open => !open)}
            title="Nastavení layoutu grafů · ⌥↩ (Alt+Enter) maximalizuje aktivní graf"
            aria-label="Nastavení layoutu grafů"
            aria-expanded={layoutPickerOpen}
          >
            <CurrentChartLayoutGlyph id={layoutId} />
            <span className="hidden 2xl:inline">Layout</span>
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
        <ChartWorkspaceMenu
          isDark={isDark}
          buttonClassName={topButton}
          onSave={saveWorkspace}
          onLoad={loadWorkspace}
          onReset={resetWorkspace}
          onExport={exportWorkspace}
          onImport={() => fileInputRef.current?.click()}
          onRecover={recoverWorkspace}
          onAdoptJournalStyle={backtestSession ? adoptJournalStyle : undefined}
        />
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
        <span className="hidden 2xl:block text-[8px] font-bold uppercase tracking-wider text-slate-600">{status}</span>
          </div>
          {toolbarOffset < toolbarMaxOffset && (
            <button
              type="button"
              className={`absolute right-0 z-[115] grid h-8 w-6 place-items-center rounded-md ${toolbarSurface} ${isDark ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-slate-950'} shadow-[-8px_0_10px_-6px_rgba(0,0,0,0.25)]`}
              onClick={() => scrollToolbarBy(240)}
              aria-label="Posunout lištu doprava"
              title="Posunout lištu doprava"
            ><ChevronRight size={15} /></button>
          )}
        </div>
        <div className={`relative z-[120] flex h-full shrink-0 items-center gap-1 pl-1 pr-2 ${toolbarSurface}`}>
        <span className={topDivider} />
        {!embedded && <>
        <button type="button" onClick={onClose} className={`w-8 h-8 inline-flex items-center justify-center rounded-md ${isDark ? 'text-slate-400 hover:bg-white/5 hover:text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-950'}`} title="Zavřít fullscreen (Esc)" aria-label="Zavřít fullscreen workspace"><X size={16} /></button>
        </>}
        </div>
      </div>
      {/* Dialogy mimo posuvnou lištu: transform by z ní udělal containing block
          pro `fixed` a dialog by se zmáčkl do 48 px pruhu. Nad lištou (z-660). */}
      {(workspaceLibraryMode || workspacePreview) && <div className="relative z-[700]">
        {workspaceLibraryMode && <ChartWorkspaceLibraryDialog mode={workspaceLibraryMode} isDark={isDark} onClose={() => setWorkspaceLibraryMode(null)} onSave={saveNamedWorkspace} onLoad={template => previewWorkspace(template.document)} onLoadCheckpoint={() => void loadWorkspaceCheckpoint()} />}
        {workspacePreview && <WorkspaceImportPreview input={workspacePreview.input} error={workspacePreview.error} isDark={isDark} busy={workspaceApplying} onCancel={() => setWorkspacePreview(null)} onApply={() => void applyWorkspacePreview()} />}
      </div>}
      <div className="flex flex-1 min-h-0">
      {review && <div ref={reviewLeftRef} className="shrink-0 flex min-h-0" />}
      <WorkspaceDataContext.Provider value={context}>
        <div ref={workspaceViewportRef} className={`relative flex-1 min-w-0 min-h-0 ${isDark ? 'bg-[#070a0f]' : 'bg-white'}`}>
          {quickOrderFeedback && <div
            role="status"
            className={`pointer-events-none absolute left-1/2 top-11 z-[700] -translate-x-1/2 rounded-md border px-3 py-2 text-[11px] font-bold shadow-lg ${quickOrderFeedback.ok
              ? isDark ? 'border-emerald-500/30 bg-[#10251d] text-emerald-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : isDark ? 'border-rose-500/30 bg-[#2a1519] text-rose-300' : 'border-rose-200 bg-rose-50 text-rose-700'}`}
          >{quickOrderFeedback.message}</div>}
          {selectedFib && <FibDrawingFloatingToolbar
            engine={selectedFib.engine}
            drawing={selectedFib.drawing}
            isDark={isDark}
            onOpenSettings={() => setFibSettingsOpen(true)}
          />}
          {selectedPosition && <PositionDrawingFloatingToolbar
            engine={selectedPosition.engine}
            drawing={selectedPosition.drawing}
            onClose={() => setPositionSettingsOpen(false)}
            onOpenSettings={() => setPositionSettingsOpen(true)}
            isDark={isDark}
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
          {/* Lišta kreslení plave nad grafem jako přehrávání a oblíbené — graf
              jde až k levému okraji a prosvítá pod sklem. Nad odznaky panelu
              (z-650), pod horní lištou a jejími popupy (z-660). */}
          <div className={`pointer-events-none absolute left-0 top-0 z-[655] w-[60px] ${tradingPanel ? 'bottom-[72px]' : 'bottom-7'}`}>
            <AlphaTradeDrawingToolbar
              isDark={isDark}
              drawingEngine={activeControl?.drawingEngine ?? null}
              drawingEngines={drawingEngines}
              indicatorCount={activeIndicatorCount}
              onRemoveIndicators={removeActiveIndicators}
              docked
              collapsed={drawingRailCollapsed}
              onCollapsedChange={setDrawingRailCollapsedPersisted}
            />
          </div>
          {review && (
            <div
              ref={reviewOverlayRef}
              className={`pointer-events-none absolute left-0 right-0 top-0 z-[656] ${tradingPanel ? 'bottom-[72px]' : 'bottom-7'}`}
            />
          )}
          <div
            ref={workspaceShellRef}
            className={`alphatrade-candlekit-workspace absolute top-0 left-0 right-0 ${tradingPanel ? 'bottom-[72px]' : 'bottom-7'} ${isDark ? 'is-dark' : ''}`}
            style={{ '--drawing-rail-inset': drawingRailCollapsed ? '8px' : `${REPLAY_TOOLBAR_MIN_LEFT}px` } as React.CSSProperties}
          >
            <FlexLayoutAdapter key={workspaceMountVersion} workspace={workspace} hideToolbar />
          </div>
          <div className={`absolute left-0 right-0 z-40 ${tradingPanel ? 'bottom-[44px]' : 'bottom-0'}`}>
            <ChartWorkspaceStatusRow
              onRange={showActiveRange}
              onGoToTime={goToActiveTime}
              defaultGoToTime={activeLatestTime}
              timeZone={chartTimeZone}
              timeZoneLabel={chartTimeZoneLabel}
              isDark={isDark}
            />
          </div>
          {tradingPanel && (
            <div className={`absolute bottom-0 left-0 right-0 z-40 h-[44px] border-t ${isDark ? 'border-white/10 bg-[#0d1219]' : 'border-slate-200 bg-white'}`}>
              {tradingPanel}
            </div>
          )}
          {(replay.phase !== 'off' || reviewReplayIdle) && (
            <div
              ref={replayToolbarRef}
              data-snapshot-hide
              className={`absolute z-[650] flex h-10 items-center gap-0.5 rounded-xl p-1 ${chartGlassBar(isDark)}`}
              style={replayToolbarPosition
                ? { left: replayToolbarPosition.left, top: replayToolbarPosition.top }
                : { left: '50%', bottom: tradingPanel ? 84 : 40, transform: 'translateX(-50%)' }}
              role="toolbar"
              aria-label="Bar Replay ovládání"
            >
              <button
                type="button"
                className={`flex h-8 w-5 shrink-0 touch-none cursor-grab items-center justify-center rounded active:cursor-grabbing ${chartGlassGrip(isDark)}`}
                onPointerDown={beginReplayToolbarDrag}
                title="Přetáhnout Bar Replay panel"
                aria-label="Přetáhnout Bar Replay panel"
              ><GripVertical size={14} /></button>
              {/* Fullscreen obchodu: start je obchod (Go To → Začátek), výběr
                  data nebo náhodné svíčky by tu jen překážel. */}
              {(backtestSession || review) && <ReplayStartMenu
                onSelectBar={enterReplaySelection}
                onSelectDate={time => startReplayAtTime(time, 'start')}
                onSelectPreset={startReplayPreset}
                allowJumps={!backtestSession}
                selecting={replay.phase === 'selecting'}
                defaultDateTime={replayDefaultStartTime}
                timeZone={chartTimeZone}
                timeZoneLabel={chartTimeZoneLabel}
                isDark={isDark}
                buttonClassName={replayButton}
              />}
              {(backtestSession || review) && <span className={replayDivider} />}
              <button
                type="button"
                className={`${replayButton} px-2 disabled:opacity-30`}
                disabled={!reviewReplayIdle && (replay.phase !== 'active' || replayAtEnd)}
                onClick={() => reviewReplayIdle ? startReviewReplay('play') : setReplay(current => ({ ...current, playing: !current.playing }))}
                title={replay.playing ? 'Pozastavit' : 'Přehrát'}
                aria-label={replay.playing ? 'Pozastavit Bar Replay' : 'Přehrát Bar Replay'}
              >{replay.playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button>
              <button
                type="button"
                className={`${replayButton} px-2 disabled:opacity-30`}
                disabled={!reviewReplayIdle && (replay.phase !== 'active' || replayAtEnd)}
                onClick={() => reviewReplayIdle ? startReviewReplay('step') : advanceReplay()}
                title="O jednu svíčku dopředu"
                aria-label="Bar Replay krok dopředu"
              ><StepForward size={15} /></button>
              <ReplayGoToMenu
                settings={goToSettings}
                onSettingsChange={setGoToSettings}
                onGoTo={replayGoTo}
                disabled={!tradeGoTo && (replay.phase !== 'active' || replayAtEnd)}
                tradeTargets={tradeGoTo?.targets}
                onTradeTarget={goToTradeTarget}
                standardTargets={replay.phase === 'active' && !replayAtEnd}
                isDark={isDark}
                cursorTime={replay.cursorTime}
                timeZone={chartTimeZone}
                timeZoneLabel={chartTimeZoneLabel}
                buttonClassName={replayButton}
              />
              {replayDataLoading && <span role="status" className="whitespace-nowrap px-2 text-[10px] text-blue-400">Načítám data…</span>}
              <ReplayChoiceMenu
                value={replay.speed}
                options={CHART_REPLAY_SPEEDS.map(speed => ({ value: speed, label: `${speed}x`, description: chartReplaySpeedDescription(speed) }))}
                heading="Rychlost replaye"
                onChange={speed => setReplay(current => ({ ...current, speed: speed as ChartReplaySpeed }))}
                isDark={isDark}
                buttonClassName={replayButton}
                ariaLabel="Rychlost Bar Replay"
                title="Rychlost Bar Replay"
              />
              <ReplayChoiceMenu
                value={replay.stepMinutes ?? 1}
                options={CHART_REPLAY_STEP_MINUTES.map(minutes => ({ value: minutes, label: REPLAY_TIMEFRAME_LABELS[minutes] }))}
                heading="Interval kroku"
                onChange={minutes => setReplay(current => ({ ...current, stepMinutes: minutes as ChartReplayStepMinutes }))}
                isDark={isDark}
                buttonClassName={replayButton}
                ariaLabel="Timeframe kroku Bar Replay"
                title="Timeframe jednoho replay kroku"
              />
              {!backtestSession && (
                <>
                  <span className={replayDivider} />
                  <button
                    type="button"
                    className={`${replayButton} px-2 disabled:opacity-30`}
                    disabled={replay.phase !== 'active' || replayAtEnd}
                    onClick={jumpReplayToEnd}
                    title="Skočit na konec dat"
                    aria-label="Bar Replay skok na konec dat"
                  ><SkipForward size={15} /></button>
                  <button
                    type="button"
                    className={`${replayButton} px-2 disabled:opacity-30`}
                    disabled={replay.phase === 'off'}
                    onClick={exitReplay}
                    title="Ukončit Bar Replay"
                    aria-label="Ukončit Bar Replay"
                  ><X size={15} /></button>
                </>
              )}
            </div>
          )}
          {reviewTrade && backtestSession?.onTradeReviewSave ? (
            <BacktestTradeReviewDialog
              trade={reviewTrade}
              noteCaptureContext={{ marketTime: replay.cursorTime,
                maxRevealedMarketTime: typeof backtestSession.maxRevealedTime === 'number' && Number.isFinite(backtestSession.maxRevealedTime)
                  ? Math.max(backtestSession.maxRevealedTime, replay.cursorTime ?? 0) : null,
                entryMarketTime: typeof reviewTrade.entryTime === 'number' ? reviewTrade.entryTime / 1000 : null,
                exitMarketTime: Number.isFinite(reviewTrade.timestamp) ? reviewTrade.timestamp / 1000 : null,
                closedTradeReview: true }}
              tagSuggestions={backtestSession?.tagSuggestions}
              isDark={isDark}
              onClose={() => setReviewTradeId(null)}
              onCaptureSnapshot={() => captureTradeSnapshot(reviewTrade)}
              onRecalculate={backtestSession.onTradeRecalculate
                ? () => backtestSession.onTradeRecalculate!(String(reviewTrade.id))
                : undefined}
              onSave={(updates, snapshotDataUrl, expected) => backtestSession.onTradeReviewSave!(String(reviewTrade.id), updates, snapshotDataUrl, expected)}
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
      {review && <div ref={reviewSideRef} className="shrink-0 flex min-h-0" />}
      </div>
      {review && <div ref={reviewBottomRef} className="shrink-0" />}
    </div>
    </React.Profiler>
  );
};

export default AlphaTradeChartWorkspace;
