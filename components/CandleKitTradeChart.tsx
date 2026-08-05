import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Drawing } from '@getcandlekit/charts';
import {
  ChartView,
  IndicatorController,
  MeasurementOverlay,
  createBuiltinRegistry,
  darkTheme,
  lightTheme,
  type ChartViewApi,
  type DrawingToolId,
  useChartApiOptional,
} from '@getcandlekit/charts/react';
import '@getcandlekit/charts/styles.css';
import {
  ColorType,
  createSeriesMarkers,
  type ISeriesApi,
  type IChartApi,
  type IPrimitivePaneRenderer,
  type ISeriesPrimitive,
  type ISeriesPrimitiveAxisView,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  Eraser,
  Eye,
  EyeOff,
  GripVertical,
  Lock,
  LocateFixed,
  RotateCcw,
  Scissors,
  Settings,
  Star,
  Trash2,
  Unlock,
} from 'lucide-react';
import { Trade } from '../types';
import ChartIndicatorSettingsDialog, {
  DEFAULT_INDICATOR_SETTINGS,
  indicatorVisibleOnTimeframe,
  type AlphaTradeIndicatorSettings,
} from './ChartIndicatorSettingsDialog';
import { protectGeneratedDrawings } from '../services/chartDrawingProtection';
import { ALPHATRADE_CHART_STYLE as chartStyle } from '../services/chartVisualStyle';
import { formatNqMnqTickPrice } from '../services/chartPriceTick';
import {
  chartInstrumentLegend,
  resolveNasdaqFuturesRoot,
  type NasdaqFuturesRoot,
} from '../services/chartInstrumentLegend';
import {
  calculateMarketStructure,
  findEntryFairValueGap,
  findEntryStructureEvent,
  findFairValueGaps,
  MARKET_TIMEFRAME_MINUTES,
  type MarketCandle,
  type MarketTimeframe,
} from '../services/marketData';
import { calculateLiquidityLevels, type LiquidityLevelsResult } from '../services/liquidityLevels';
import {
  createDrawingMagnetResolver,
  getDrawingMagnetSettings,
  installDrawingMagnet,
  setDrawingMagnetSettings,
  subscribeDrawingMagnetSettings,
  type DrawingMagnetSettings,
} from '../services/chartDrawingMagnet';
import {
  installWorkspaceDrawingToolSync,
  setWorkspaceDrawingTool,
} from '../services/chartDrawingToolTransfer';
import { chartDrawingToolForShortcut } from '../services/chartDrawingShortcuts';
import { installKeepDrawingBehavior } from '../services/chartDrawingContinuation';
import {
  CHART_DRAWING_TOOL_GROUPS,
  chartDrawingToolGroupFor,
  defaultChartDrawingToolSelections,
  normalizeChartDrawingFavorites,
  rememberChartDrawingTool,
  toggleChartDrawingFavorite,
  type ChartDrawingToolGroupId,
} from '../services/chartDrawingToolGroups';
import {
  applyFibRuntimeTimeframe,
  installFibDrawingDefaults,
  timeframeMinutes,
  type FibDrawing,
} from '../services/chartFibDrawing';
import FibDrawingSettingsDialog, {
  FibDrawingFloatingToolbar,
} from './FibDrawingSettingsDialog';
import GenericDrawingFloatingToolbar from './GenericDrawingFloatingToolbar';
import GenericDrawingSettingsDialog from './GenericDrawingSettingsDialog';
import { installDrawingStyleDefaults } from '../services/chartDrawingStyleDefaults';
import { installPositionDrawingDefaults } from '../services/chartPositionDrawing';
import {
  countChartIndicators,
  countManualChartDrawings,
  isResetChartViewShortcut,
  removeManualChartDrawings,
  resetChartView,
} from '../services/chartContextMenu';
import { nearestReplayCandleTime } from '../services/chartReplay';

interface CandleKitTradeChartProps {
  trade: Trade;
  candles: MarketCandle[];
  rawCandles: MarketCandle[];
  timeframe: MarketTimeframe;
  entryMs: number;
  exitMs: number;
  showFvg: boolean;
  showLevels: boolean;
  showStructure: boolean;
  isDark: boolean;
  drawingScope?: string;
  compactToolbar?: boolean;
  showIndicatorPicker?: boolean;
  indicatorController?: IndicatorController | null;
  focusRequest?: number;
  hideFocusButton?: boolean;
  compactMode?: boolean;
  hideDrawingToolbar?: boolean;
  keyboardShortcutsActive?: boolean;
  onChartApiReady?: (api: ChartViewApi | null) => void;
  activeLibraryIndicators?: string[];
  onToggleFvg?: () => void;
  onToggleLevels?: () => void;
  onToggleStructure?: () => void;
  instrumentRoot?: NasdaqFuturesRoot;
  replayActive?: boolean;
  replayCursorTime?: number | null;
  replaySelecting?: boolean;
  replaySelectionCandles?: MarketCandle[];
  replaySelectionTime?: number | null;
  onReplaySelectionTimeChange?: (time: number | null) => void;
  onReplayStart?: (time: number) => void;
}

type AlphaTradeIndicatorId = 'fvg' | 'levels' | 'structure';

interface ChartIndicatorLegendItem {
  id: string;
  title: string;
  customId?: AlphaTradeIndicatorId;
  libraryName?: string;
}

const ChartIndicatorLegend: React.FC<{
  isDark: boolean;
  timeframe: MarketTimeframe;
  showFvg: boolean;
  showLevels: boolean;
  showStructure: boolean;
  hiddenCustom: Set<AlphaTradeIndicatorId>;
  setCustomHidden: (id: AlphaTradeIndicatorId, hidden: boolean) => void;
  onToggleFvg?: () => void;
  onToggleLevels?: () => void;
  onToggleStructure?: () => void;
  controller: IndicatorController | null;
  activeLibraryIndicators: string[];
  onEditCustom: (id: AlphaTradeIndicatorId) => void;
  offsetForToolbar: boolean;
}> = ({
  isDark,
  timeframe,
  showFvg,
  showLevels,
  showStructure,
  hiddenCustom,
  setCustomHidden,
  onToggleFvg,
  onToggleLevels,
  onToggleStructure,
  controller,
  activeLibraryIndicators,
  onEditCustom,
  offsetForToolbar,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [hiddenLibrary, setHiddenLibrary] = useState<Map<string, Record<string, unknown>>>(new Map());

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setSettingsFor(null);
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const customItems: ChartIndicatorLegendItem[] = [
    ...(showStructure ? [{ id: 'custom:structure', title: 'AlphaTrade BOS/CHoCH (CZ)', customId: 'structure' as const }] : []),
    ...(showFvg ? [{ id: 'custom:fvg', title: 'AlphaTrade FVG INSTANT (CZ)', customId: 'fvg' as const }] : []),
    ...(showLevels ? [{ id: 'custom:levels', title: 'Liquidity Levels CZ – Advanced', customId: 'levels' as const }] : []),
  ];
  const libraryNames = Array.from(new Set([...activeLibraryIndicators, ...hiddenLibrary.keys()]));
  const libraryTitles = new Map(
    Object.values(controller?.available() ?? {}).flat().map(indicator => [indicator.name, indicator.title]),
  );
  const items: ChartIndicatorLegendItem[] = [
    ...customItems,
    ...libraryNames.map(name => ({ id: `library:${name}`, title: libraryTitles.get(name) ?? name, libraryName: name })),
  ];

  const isHidden = (item: ChartIndicatorLegendItem) => item.customId
    ? hiddenCustom.has(item.customId)
    : Boolean(item.libraryName && hiddenLibrary.has(item.libraryName));
  const toggleVisibility = (item: ChartIndicatorLegendItem) => {
    if (item.customId) {
      setCustomHidden(item.customId, !hiddenCustom.has(item.customId));
      return;
    }
    if (!controller || !item.libraryName) return;
    const saved = hiddenLibrary.get(item.libraryName);
    if (saved) {
      controller.add(item.libraryName, saved);
      setHiddenLibrary(current => {
        const next = new Map(current);
        next.delete(item.libraryName!);
        return next;
      });
      return;
    }
    const active = controller.getActive(item.libraryName);
    if (!active) return;
    setHiddenLibrary(current => new Map(current).set(item.libraryName!, active.params));
    controller.remove(item.libraryName);
  };
  const remove = (item: ChartIndicatorLegendItem) => {
    if (item.customId) {
      ({ fvg: onToggleFvg, levels: onToggleLevels, structure: onToggleStructure }[item.customId])?.();
      setCustomHidden(item.customId, false);
    } else if (controller && item.libraryName) {
      controller.remove(item.libraryName);
      setHiddenLibrary(current => {
        const next = new Map(current);
        next.delete(item.libraryName!);
        return next;
      });
    }
    setSettingsFor(null);
  };

  return (
    <div ref={containerRef} className={`absolute top-11 z-30 text-[9px] ${offsetForToolbar ? 'left-14' : 'left-2'}`}>
      <button
        type="button"
        onClick={() => { setOpen(value => !value); setSettingsFor(null); }}
        className={`flex h-5 items-center gap-0.5 rounded border px-1 transition-colors ${isDark ? 'border-white/10 bg-[#111821]/90 text-slate-300 hover:bg-[#18212d]' : 'border-slate-200 bg-white/90 text-slate-700 hover:bg-slate-50'}`}
        aria-label="Zobrazit aktivní indikátory"
        aria-expanded={open}
      >
        <ChevronDown size={10} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        <span className="font-semibold tabular-nums">{items.length}</span>
      </button>
      {open && (
        <div className="mt-1 min-w-[280px] max-w-[380px] space-y-0.5">
          {items.length === 0 && (
            <div className={`rounded px-2 py-1.5 ${isDark ? 'bg-[#111821]/90 text-slate-500' : 'bg-white/90 text-slate-500'}`}>Žádné aktivní indikátory</div>
          )}
          {items.map(item => {
            const hidden = isHidden(item);
            return (
              <div key={item.id} className="group relative">
                <div className={`flex h-7 items-center rounded px-2 pr-1 shadow-sm ${hidden ? 'opacity-55' : ''} ${isDark ? 'bg-[#111821]/92 text-slate-200' : 'bg-white/95 text-slate-800'}`}>
                  <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
                  <div className={`pointer-events-none ml-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 ${isDark ? 'bg-[#111821]' : 'bg-white'}`}>
                    <button type="button" onClick={() => toggleVisibility(item)} className="rounded p-1 hover:bg-slate-500/15" title={hidden ? 'Zobrazit indikátor' : 'Skrýt indikátor'} aria-label={hidden ? `Zobrazit ${item.title}` : `Skrýt ${item.title}`}>
                      {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                    <button type="button" onClick={() => {
                      if (item.customId) {
                        setOpen(false);
                        onEditCustom(item.customId);
                      } else {
                        setSettingsFor(current => current === item.id ? null : item.id);
                      }
                    }} className="rounded p-1 hover:bg-slate-500/15" title="Nastavení indikátoru" aria-label={`Nastavit ${item.title}`}>
                      <Settings size={14} />
                    </button>
                    <button type="button" onClick={() => remove(item)} className="rounded p-1 hover:bg-red-500/10 hover:text-red-500" title="Odebrat indikátor" aria-label={`Odebrat ${item.title}`}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {settingsFor === item.id && (
                  <div className={`absolute left-full top-0 z-40 ml-1 w-56 rounded-lg border p-2.5 shadow-xl ${isDark ? 'border-white/10 bg-[#111821] text-slate-200' : 'border-slate-200 bg-white text-slate-800'}`}>
                    <div className="truncate text-[10px] font-bold">{item.title}</div>
                    <button type="button" onClick={() => toggleVisibility(item)} className={`mt-2 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-50'}`}>
                      <span>Viditelnost</span><span className="font-semibold">{hidden ? 'Skrytý' : 'Viditelný'}</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export interface WorkspaceIndicatorControls {
  showFvg: boolean;
  showLevels: boolean;
  showStructure: boolean;
  onToggleFvg: () => void;
  onToggleLevels: () => void;
  onToggleStructure: () => void;
}

export const WorkspaceIndicatorMenu: React.FC<{
  controller: IndicatorController;
  custom: WorkspaceIndicatorControls;
  timeframe: MarketTimeframe;
  isDark: boolean;
  inline?: boolean;
}> = ({ controller, custom, timeframe, isDark, inline = false }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'custom' | 'library'>('custom');
  const [, refresh] = useState(0);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const available = useMemo(
    () => Object.values(controller.available()).flat(),
    [controller],
  );
  const activeNames = controller.activeNames();
  const rowClass = `w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-[10px] font-bold transition-colors ${isDark ? 'hover:bg-white/5 text-slate-300' : 'hover:bg-slate-50 text-slate-700'}`;
  const checkClass = (active: boolean) => `w-4 h-4 shrink-0 rounded border flex items-center justify-center ${active ? 'bg-blue-500 border-blue-500 text-white' : isDark ? 'border-white/15' : 'border-slate-300'}`;

  const customRows = [
    { label: 'Fair Value Gaps', detail: 'FVG', active: custom.showFvg, onClick: custom.onToggleFvg },
    { label: 'AlphaTrade levely', detail: 'PDH, PDL, PWH, PWL…', active: custom.showLevels, onClick: custom.onToggleLevels },
    { label: 'Market Structure', detail: timeframe === '1m' ? 'CHoCH / BOS' : 'CHoCH / BOS · pouze 1m', active: custom.showStructure, onClick: custom.onToggleStructure },
  ];

  return (
    <div ref={containerRef} className={inline ? 'relative z-[80] shrink-0' : 'absolute top-[7px] right-[72px] z-[60]'}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className={`${inline ? 'h-8 border-transparent shadow-none bg-transparent' : 'h-7 shadow-sm'} inline-flex items-center gap-1.5 px-2.5 rounded-md border text-[9px] font-black ${isDark ? inline ? 'text-slate-300 hover:bg-white/5 hover:text-white' : 'bg-[#111821] border-white/10 text-slate-200' : inline ? 'text-slate-600 hover:bg-slate-100 hover:text-slate-950' : 'bg-white border-slate-200 text-slate-700'}`}
        aria-expanded={open}
      >
        ƒ Indikátory <ChevronDown size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className={`absolute ${inline ? 'left-0 top-8' : 'right-0 top-9'} w-[290px] max-h-[420px] overflow-hidden rounded-xl border shadow-2xl ${isDark ? 'bg-[#111821] border-white/10' : 'bg-white border-slate-200'}`}>
          <div className={`grid grid-cols-2 p-1 border-b ${isDark ? 'border-white/10' : 'border-slate-100'}`}>
            <button type="button" onClick={() => setTab('custom')} className={`h-8 rounded-lg text-[9px] font-black uppercase tracking-wider ${tab === 'custom' ? 'bg-blue-500 text-white' : 'text-slate-500'}`}>Vlastní</button>
            <button type="button" onClick={() => setTab('library')} className={`h-8 rounded-lg text-[9px] font-black uppercase tracking-wider ${tab === 'library' ? 'bg-blue-500 text-white' : 'text-slate-500'}`}>Knihovna</button>
          </div>
          <div className="max-h-[370px] overflow-y-auto py-1">
            {tab === 'custom' ? customRows.map(item => (
              <button key={item.label} type="button" onClick={item.onClick} className={rowClass}>
                <span><span className="block">{item.label}</span><span className="block mt-0.5 text-[8px] font-semibold text-slate-500">{item.detail}</span></span>
                <span className={checkClass(item.active)}>{item.active && <Check size={11} strokeWidth={3} />}</span>
              </button>
            )) : available.map(indicator => {
              const active = activeNames.includes(indicator.name);
              return (
                <button
                  key={indicator.name}
                  type="button"
                  onClick={() => { controller.toggle(indicator.name); refresh(value => value + 1); }}
                  className={rowClass}
                >
                  <span><span className="block">{indicator.title}</span><span className="block mt-0.5 text-[8px] font-semibold uppercase text-slate-500">{indicator.category}</span></span>
                  <span className={checkClass(active)}>{active && <Check size={11} strokeWidth={3} />}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

const CONTEXT_BARS: Record<MarketTimeframe, { before: number; after: number }> = {
  '1m': { before: 45, after: 45 },
  '5m': { before: 48, after: 24 },
  '15m': { before: 32, after: 16 },
  '30m': { before: 24, after: 10 },
  '1h': { before: 24, after: 8 },
  '4h': { before: 12, after: 4 },
  '1d': { before: 8, after: 2 },
};

const EMPTY_LIQUIDITY_LEVELS: LiquidityLevelsResult = {
  levels: [],
  sessionBoxes: [],
  vwap: [],
  upper1: [],
  lower1: [],
  upper2: [],
  lower2: [],
  biasRows: [],
};

const INITIAL_WINDOW_BARS: Record<MarketTimeframe, { before: number; after: number; chunk: number }> = {
  '1m': { before: 1_200, after: 600, chunk: 1_500 },
  '5m': { before: 700, after: 350, chunk: 900 },
  '15m': { before: 450, after: 220, chunk: 600 },
  '30m': { before: 300, after: 120, chunk: 400 },
  '1h': { before: 240, after: 120, chunk: 320 },
  '4h': { before: 100, after: 40, chunk: 120 },
  '1d': { before: 30, after: 8, chunk: 30 },
};

const COMPACT_WINDOW_BARS: Record<MarketTimeframe, { before: number; after: number; chunk: number }> = {
  '1m': { before: 320, after: 180, chunk: 750 },
  '5m': { before: 240, after: 120, chunk: 500 },
  '15m': { before: 180, after: 90, chunk: 360 },
  '30m': { before: 140, after: 60, chunk: 240 },
  '1h': { before: 120, after: 60, chunk: 240 },
  '4h': { before: 60, after: 24, chunk: 80 },
  '1d': { before: 20, after: 6, chunk: 20 },
};

interface CandleWindow {
  start: number;
  end: number;
}

const unsubscribeVisibleRangeSafely = (subscription: { chart: IChartApi; handler: () => void } | null) => {
  if (!subscription) return;
  try {
    subscription.chart.timeScale().unsubscribeVisibleLogicalRangeChange(subscription.handler);
  } catch {
    // The previous chart may already be disposed during a window remount.
  }
};

const unsubscribeCrosshairSafely = (subscription: {
  chart: IChartApi;
  handler: Parameters<IChartApi['subscribeCrosshairMove']>[0];
} | null) => {
  if (!subscription) return;
  try {
    subscription.chart.unsubscribeCrosshairMove(subscription.handler);
  } catch {
    // The previous chart may already be disposed during a workspace remount.
  }
};

const initialCandleWindow = (
  candles: MarketCandle[],
  timeframe: MarketTimeframe,
  trade: Trade,
  entryMs: number,
  exitMs: number,
  compactMode: boolean,
): CandleWindow => {
  if (candles.length === 0) return { start: 0, end: 0 };
  const sizing = (compactMode ? COMPACT_WINDOW_BARS : INITIAL_WINDOW_BARS)[timeframe];
  const entryIndex = nearestCandleIndex(candles, asUnix(trade.entryTime || trade.entryDate, entryMs));
  const exitIndex = nearestCandleIndex(candles, asUnix(trade.timestamp || trade.exitDate, exitMs));
  return {
    start: Math.max(0, Math.min(entryIndex, exitIndex) - sizing.before),
    end: Math.min(candles.length, Math.max(entryIndex, exitIndex) + sizing.after + 1),
  };
};

interface AlphaTradeDrawingTool {
  id: DrawingToolId;
  title: string;
  icon: React.ComponentType<ToolIconProps>;
  dividerBefore?: boolean;
  shortcut?: string;
}

interface ToolIconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

const ToolSvg: React.FC<ToolIconProps & { children: React.ReactNode }> = ({ size = 24, className, strokeWidth = 0.95, children }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {children}
  </svg>
);

const CursorToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M12 2.5v6.25M12 15.25v6.25M2.5 12h6.25M15.25 12h6.25" />
</ToolSvg>;
const TrendLineToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M5.5 18.5l13-13" /><circle cx="5" cy="19" r="1.9" /><circle cx="19" cy="5" r="1.9" />
</ToolSvg>;
const RayToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M5.5 18.5 12 12 21 3" /><circle cx="5" cy="19" r="1.9" /><circle cx="12" cy="12" r="1.9" />
</ToolSvg>;
const ExtendedLineToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M2.5 21.5 21.5 2.5" /><circle cx="8" cy="16" r="1.75" /><circle cx="16" cy="8" r="1.75" />
</ToolSvg>;
const HorizontalLineToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M3 12h18" /><circle cx="12" cy="12" r="1.9" />
</ToolSvg>;
const HorizontalRayToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M5 12h16" /><circle cx="5" cy="12" r="1.9" />
</ToolSvg>;
const VerticalLineToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M12 3v18" /><circle cx="12" cy="12" r="1.9" />
</ToolSvg>;
const CrossLineToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M3 12h18M12 3v18" /><circle cx="12" cy="12" r="1.9" />
</ToolSvg>;
const ArrowToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M5 19L19 5M13 5h6v6" />
</ToolSvg>;
const TextToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M5 5h14M12 5v14M8.5 19h7" />
</ToolSvg>;
const RectangleToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <rect x="4" y="5" width="16" height="14" rx=".7" />
</ToolSvg>;
const CircleToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <ellipse cx="12" cy="12" rx="8" ry="8.5" />
</ToolSvg>;
const TriangleToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M12 4L21 20H3L12 4z" />
</ToolSvg>;
const ParallelChannelToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M3 16 17 4M7 20 21 8" /><circle cx="3" cy="16" r="1.45" /><circle cx="17" cy="4" r="1.45" /><circle cx="7" cy="20" r="1.45" /><circle cx="21" cy="8" r="1.45" />
</ToolSvg>;
const PriceRangeToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M4 7h16M4 17h16M12 7v10M9.5 9.5L12 7l2.5 2.5M9.5 14.5L12 17l2.5-2.5" />
</ToolSvg>;
const DateRangeToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3" />
</ToolSvg>;
const LongPositionToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M4 12h16M7 12V5h10v7M7 12v7h10v-7" />
  <path d="M10 8h4M12 6v4M10 16h4" />
</ToolSvg>;
const ShortPositionToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M4 12h16M7 12V5h10v7M7 12v7h10v-7" />
  <path d="M10 8h4M10 16h4M12 14v4" />
</ToolSvg>;
const FibToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M3 5h18M6 9h15M3 13h15M6 17h15" /><circle cx="4" cy="9" r="1.45" /><circle cx="20" cy="13" r="1.45" />
</ToolSvg>;
const FibExtensionToolIcon: React.FC<ToolIconProps> = props => <ToolSvg {...props}>
  <path d="M3 5h14M7 9h14M3 13h18M7 17h14" />
  <path d="m4 19 5-5 5 3 6-12" />
  <circle cx="4" cy="19" r="1.35" /><circle cx="9" cy="14" r="1.35" /><circle cx="14" cy="17" r="1.35" />
</ToolSvg>;
const MagnetToolIcon: React.FC<ToolIconProps & { strong?: boolean }> = ({ strong = false, size = 24, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    className={className}
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.35"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path
      d="M5.5 18.5V11a6.5 6.5 0 0 1 13 0v7.5h-4V11a2.5 2.5 0 0 0-5 0v7.5h-4Z"
    />
    <path d="M5.5 15.25h4M14.5 15.25h4" />
    {strong && <path d="M7.5 20v2M5.75 21.5 7.5 23l1.75-1.5M16.5 20v2m-1.75-.5L16.5 23l1.75-1.5" />}
  </svg>
);
const KeepDrawingToolIcon: React.FC<ToolIconProps> = ({ size = 24, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    className={className}
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.25"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m5 16.5-.8 3.3 3.3-.8L18 8.5 15.5 6 5 16.5Z" />
    <path d="m13.9 7.6 2.5 2.5M7.4 15.9l1.2 1.2" />
    <path d="M13 17.5v-1.2a2.4 2.4 0 0 1 4.8 0v1.2M12 17.5h6.8v4H12z" />
  </svg>
);

const ALPHATRADE_DRAWING_TOOLS: AlphaTradeDrawingTool[] = [
  { id: 'TrendLine', title: 'Trendová čára', icon: TrendLineToolIcon, shortcut: 'Alt+T' },
  { id: 'Ray', title: 'Paprsek', icon: RayToolIcon },
  { id: 'ExtendedLine', title: 'Prodloužená čára', icon: ExtendedLineToolIcon },
  { id: 'HorizontalLine', title: 'Horizontální čára', icon: HorizontalLineToolIcon, shortcut: 'Alt+H' },
  { id: 'HorizontalRay', title: 'Horizontální paprsek', icon: HorizontalRayToolIcon, shortcut: 'Alt+J' },
  { id: 'VerticalLine', title: 'Vertikální čára', icon: VerticalLineToolIcon, shortcut: 'Alt+V' },
  { id: 'CrossLine', title: 'Křížová čára', icon: CrossLineToolIcon, shortcut: 'Alt+C' },
  { id: 'Arrow', title: 'Šipka', icon: ArrowToolIcon, dividerBefore: true },
  { id: 'Text', title: 'Text', icon: TextToolIcon },
  { id: 'Rectangle', title: 'Obdélník', icon: RectangleToolIcon },
  { id: 'Circle', title: 'Elipsa', icon: CircleToolIcon },
  { id: 'Triangle', title: 'Trojúhelník', icon: TriangleToolIcon },
  { id: 'ParallelChannel', title: 'Paralelní kanál', icon: ParallelChannelToolIcon, dividerBefore: true },
  { id: 'PriceRange', title: 'Cenové rozpětí', icon: PriceRangeToolIcon },
  { id: 'DateRange', title: 'Časové rozpětí', icon: DateRangeToolIcon },
  { id: 'LongPosition', title: 'Long position', icon: LongPositionToolIcon },
  { id: 'ShortPosition', title: 'Short position', icon: ShortPositionToolIcon },
  { id: 'FibRetracement', title: 'Fibonacci retracement', icon: FibToolIcon },
  { id: 'FibExtension', title: 'Fibonacci extension', icon: FibExtensionToolIcon },
];
const ALPHATRADE_DRAWING_TOOL_MAP = new Map(ALPHATRADE_DRAWING_TOOLS.map(tool => [tool.id, tool]));
const DRAWING_TOOL_SELECTIONS_STORAGE_KEY = 'alphatrade:chart-drawing-tool-selections';
const DRAWING_TOOL_SELECTIONS_EVENT = 'alphatrade:chart-drawing-tool-selections-change';
const DRAWING_TOOL_FAVORITES_STORAGE_KEY = 'alphatrade:chart-drawing-tool-favorites';
const DRAWING_TOOL_FAVORITES_VISIBLE_STORAGE_KEY = 'alphatrade:chart-drawing-tool-favorites-visible';
const DRAWING_TOOL_FAVORITES_POSITION_STORAGE_KEY = 'alphatrade:chart-drawing-tool-favorites-position';
const DRAWING_TOOL_FAVORITES_EVENT = 'alphatrade:chart-drawing-tool-favorites-change';
const KEEP_DRAWING_STORAGE_KEY = 'alphatrade:chart-keep-drawing';
const KEEP_DRAWING_EVENT = 'alphatrade:chart-keep-drawing-change';

const loadDrawingToolSelections = () => {
  const defaults = defaultChartDrawingToolSelections();
  try {
    const stored = JSON.parse(window.localStorage.getItem(DRAWING_TOOL_SELECTIONS_STORAGE_KEY) || '{}') as Record<string, unknown>;
    CHART_DRAWING_TOOL_GROUPS.forEach(group => {
      const tool = stored[group.id];
      if (typeof tool === 'string' && group.tools.includes(tool as DrawingToolId)) defaults[group.id] = tool as DrawingToolId;
    });
  } catch { /* private storage or malformed legacy value */ }
  return defaults;
};

const loadDrawingToolFavorites = (): DrawingToolId[] => {
  try { return normalizeChartDrawingFavorites(JSON.parse(window.localStorage.getItem(DRAWING_TOOL_FAVORITES_STORAGE_KEY) || '[]')); }
  catch { return []; }
};

const loadDrawingFavoritesVisible = (): boolean => {
  try { return window.localStorage.getItem(DRAWING_TOOL_FAVORITES_VISIBLE_STORAGE_KEY) !== 'false'; }
  catch { return true; }
};

const loadDrawingFavoritesPosition = () => {
  const fallback = { left: Math.max(64, Math.round(window.innerWidth / 2 - 130)), top: 56 };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DRAWING_TOOL_FAVORITES_POSITION_STORAGE_KEY) || '{}') as { left?: unknown; top?: unknown };
    return {
      left: typeof parsed.left === 'number' ? parsed.left : fallback.left,
      top: typeof parsed.top === 'number' ? parsed.top : fallback.top,
    };
  } catch { return fallback; }
};

const loadKeepDrawing = (): boolean => {
  try { return window.localStorage.getItem(KEEP_DRAWING_STORAGE_KEY) === 'true'; }
  catch { return false; }
};

export type CandleKitDrawingEngine = NonNullable<ChartViewApi['drawing']>['engine'];

export const AlphaTradeDrawingToolbar: React.FC<{
  isDark: boolean;
  drawingEngine?: CandleKitDrawingEngine | null;
  drawingEngines?: CandleKitDrawingEngine[];
  indicatorCount?: number;
  onRemoveIndicators?: () => void;
  docked?: boolean;
}> = ({
  isDark,
  drawingEngine,
  drawingEngines,
  indicatorCount = 0,
  onRemoveIndicators,
  docked = false,
}) => {
  const api = useChartApiOptional();
  const engine = drawingEngine ?? api?.drawing?.engine ?? null;
  const [activeTool, setActiveTool] = useState<DrawingToolId | null>(null);
  const [locked, setLocked] = useState(false);
  const [drawingCount, setDrawingCount] = useState(0);
  const [hasSelection, setHasSelection] = useState(false);
  const [magnet, setMagnet] = useState<DrawingMagnetSettings>(getDrawingMagnetSettings);
  const [magnetMenuOpen, setMagnetMenuOpen] = useState(false);
  const [magnetMenuPosition, setMagnetMenuPosition] = useState({ left: 58, top: 0 });
  const [removeMenuOpen, setRemoveMenuOpen] = useState(false);
  const [removeMenuPosition, setRemoveMenuPosition] = useState({ left: 58, top: 0 });
  const [toolSelections, setToolSelections] = useState(loadDrawingToolSelections);
  const [favoriteTools, setFavoriteTools] = useState(loadDrawingToolFavorites);
  const [favoritesVisible, setFavoritesVisible] = useState(loadDrawingFavoritesVisible);
  const [favoritesPosition, setFavoritesPosition] = useState(loadDrawingFavoritesPosition);
  const [keepDrawing, setKeepDrawing] = useState(loadKeepDrawing);
  const [toolGroupMenu, setToolGroupMenu] = useState<{
    id: ChartDrawingToolGroupId;
    left: number;
    top: number;
  } | null>(null);
  const magnetControlRef = useRef<HTMLDivElement>(null);
  const magnetMenuRef = useRef<HTMLDivElement>(null);
  const removeControlRef = useRef<HTMLDivElement>(null);
  const removeMenuRef = useRef<HTMLDivElement>(null);
  const toolGroupMenuRef = useRef<HTMLDivElement>(null);
  const favoritesToolbarRef = useRef<HTMLDivElement>(null);
  const toolSelectionSourceRef = useRef(Symbol('drawing-tool-selection'));
  const favoriteToolsSourceRef = useRef(Symbol('drawing-tool-favorites'));
  const keepDrawingSourceRef = useRef(Symbol('keep-drawing'));
  const keepDrawingRef = useRef(keepDrawing);
  const toolSelectionsRef = useRef(toolSelections);
  const favoritesPositionRef = useRef(favoritesPosition);
  toolSelectionsRef.current = toolSelections;
  favoritesPositionRef.current = favoritesPosition;
  keepDrawingRef.current = keepDrawing;
  const workspaceEngines = useMemo(
    () => [...new Set((drawingEngines?.length ? drawingEngines : engine ? [engine] : []))],
    [drawingEngines, engine],
  );

  useEffect(() => {
    if (!engine) return;
    const sync = () => {
      setActiveTool(engine.getActiveTool());
      setLocked(engine.isLocked());
      setDrawingCount(countManualChartDrawings(engine));
      const selectedId = engine.getSelectedId();
      setHasSelection(Boolean(selectedId && !selectedId.startsWith('auto-')));
    };
    sync();
    return engine.onChange(sync);
  }, [engine]);

  useEffect(() => subscribeDrawingMagnetSettings(setMagnet), []);

  const rememberToolSelection = useCallback((tool: DrawingToolId) => {
    const next = rememberChartDrawingTool(toolSelectionsRef.current, tool);
    if (next === toolSelectionsRef.current) return;
    toolSelectionsRef.current = next;
    setToolSelections(next);
    try { window.localStorage.setItem(DRAWING_TOOL_SELECTIONS_STORAGE_KEY, JSON.stringify(next)); } catch { /* private storage */ }
    window.dispatchEvent(new CustomEvent(DRAWING_TOOL_SELECTIONS_EVENT, {
      detail: { selections: next, source: toolSelectionSourceRef.current },
    }));
  }, []);

  const toggleFavoriteTool = useCallback((tool: DrawingToolId) => {
    setFavoriteTools(current => {
      const next = toggleChartDrawingFavorite(current, tool);
      try { window.localStorage.setItem(DRAWING_TOOL_FAVORITES_STORAGE_KEY, JSON.stringify(next)); } catch { /* private storage */ }
      window.dispatchEvent(new CustomEvent(DRAWING_TOOL_FAVORITES_EVENT, {
        detail: { favorites: next, source: favoriteToolsSourceRef.current },
      }));
      return next;
    });
  }, []);

  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{ favorites: DrawingToolId[]; source: symbol }>).detail;
      if (!detail || detail.source === favoriteToolsSourceRef.current) return;
      setFavoriteTools(normalizeChartDrawingFavorites(detail.favorites));
    };
    window.addEventListener(DRAWING_TOOL_FAVORITES_EVENT, sync);
    return () => window.removeEventListener(DRAWING_TOOL_FAVORITES_EVENT, sync);
  }, []);

  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{
        selections: ReturnType<typeof defaultChartDrawingToolSelections>;
        source: symbol;
      }>).detail;
      if (!detail || detail.source === toolSelectionSourceRef.current) return;
      toolSelectionsRef.current = detail.selections;
      setToolSelections(detail.selections);
    };
    window.addEventListener(DRAWING_TOOL_SELECTIONS_EVENT, sync);
    return () => window.removeEventListener(DRAWING_TOOL_SELECTIONS_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!activeTool) return;
    rememberToolSelection(activeTool);
  }, [activeTool, rememberToolSelection]);

  useEffect(() => installWorkspaceDrawingToolSync(workspaceEngines), [workspaceEngines]);

  useEffect(() => {
    const cleanups = workspaceEngines.map(currentEngine => (
      installKeepDrawingBehavior(currentEngine, () => keepDrawingRef.current)
    ));
    return () => cleanups.forEach(cleanup => cleanup());
  }, [workspaceEngines]);

  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled: boolean; source: symbol }>).detail;
      if (!detail || detail.source === keepDrawingSourceRef.current) return;
      keepDrawingRef.current = detail.enabled;
      setKeepDrawing(detail.enabled);
    };
    window.addEventListener(KEEP_DRAWING_EVENT, sync);
    return () => window.removeEventListener(KEEP_DRAWING_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!engine) return;
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      const tool = chartDrawingToolForShortcut(event);
      if (!tool) return;
      event.preventDefault();
      event.stopPropagation();
      setWorkspaceDrawingTool(workspaceEngines, tool);
    };
    window.addEventListener('keydown', handleShortcut, true);
    return () => window.removeEventListener('keydown', handleShortcut, true);
  }, [engine, workspaceEngines]);

  useEffect(() => {
    if (!toolGroupMenu) return;
    const focusFrame = window.requestAnimationFrame(() => {
      toolGroupMenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitemradio"]')?.focus();
    });
    const close = (event: PointerEvent) => {
      if (!toolGroupMenuRef.current?.contains(event.target as Node)) setToolGroupMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setToolGroupMenu(null);
    };
    const closeMenu = () => setToolGroupMenu(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [toolGroupMenu]);

  useEffect(() => {
    if (!magnetMenuOpen) return;
    const position = () => {
      const rect = magnetControlRef.current?.getBoundingClientRect();
      if (rect) setMagnetMenuPosition({ left: rect.right + 6, top: Math.min(window.innerHeight - 164, rect.top) });
    };
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('[data-chart-magnet-menu]') && !magnetControlRef.current?.contains(target)) setMagnetMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setMagnetMenuOpen(false);
    };
    const closeMenu = () => setMagnetMenuOpen(false);
    position();
    const focusFrame = window.requestAnimationFrame(() => {
      magnetMenuRef.current?.querySelector<HTMLButtonElement>('button[role^="menuitem"]')?.focus();
    });
    window.addEventListener('resize', position);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('resize', position);
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [magnetMenuOpen]);

  useEffect(() => {
    if (!removeMenuOpen) return;
    const position = () => {
      const rect = removeControlRef.current?.getBoundingClientRect();
      if (!rect) return;
      setRemoveMenuPosition({
        left: Math.max(6, Math.min(window.innerWidth - 250, rect.right + 6)),
        top: Math.max(6, Math.min(rect.top, window.innerHeight - 136)),
      });
    };
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!removeMenuRef.current?.contains(target) && !removeControlRef.current?.contains(target)) {
        setRemoveMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setRemoveMenuOpen(false);
    };
    position();
    const focusFrame = window.requestAnimationFrame(() => {
      removeMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
    window.addEventListener('resize', position);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('scroll', position, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('resize', position);
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('scroll', position, true);
    };
  }, [removeMenuOpen]);

  if (!engine) return null;

  const selectPointer = () => {
    setWorkspaceDrawingTool(workspaceEngines, null);
  };
  const selectTool = (tool: DrawingToolId) => {
    setWorkspaceDrawingTool(workspaceEngines, engine.getActiveTool() === tool ? null : tool);
  };
  const selectToolFromGroup = (tool: DrawingToolId) => {
    rememberToolSelection(tool);
    setWorkspaceDrawingTool(workspaceEngines, tool);
    setToolGroupMenu(null);
  };
  const openToolGroupMenu = (id: ChartDrawingToolGroupId, target: HTMLElement, itemCount: number) => {
    const rect = target.getBoundingClientRect();
    const menuHeight = 36 + itemCount * 40 + 8;
    setToolGroupMenu(current => current?.id === id ? null : {
      id,
      left: Math.max(6, Math.min(window.innerWidth - 268, rect.right + 6)),
      top: Math.max(6, Math.min(rect.top, window.innerHeight - menuHeight - 6)),
    });
  };
  const toggleFavoritesToolbar = () => {
    if (!favoriteTools.length) return;
    setFavoritesVisible(current => {
      const next = !current;
      try { window.localStorage.setItem(DRAWING_TOOL_FAVORITES_VISIBLE_STORAGE_KEY, String(next)); } catch { /* private storage */ }
      return next;
    });
  };
  const toggleKeepDrawing = () => {
    const next = !keepDrawingRef.current;
    keepDrawingRef.current = next;
    setKeepDrawing(next);
    try { window.localStorage.setItem(KEEP_DRAWING_STORAGE_KEY, String(next)); } catch { /* private storage */ }
    window.dispatchEvent(new CustomEvent(KEEP_DRAWING_EVENT, {
      detail: { enabled: next, source: keepDrawingSourceRef.current },
    }));
  };
  const startFavoritesDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !favoritesToolbarRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = favoritesToolbarRef.current.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    const move = (moveEvent: PointerEvent) => {
      const width = favoritesToolbarRef.current?.offsetWidth ?? rect.width;
      const height = favoritesToolbarRef.current?.offsetHeight ?? rect.height;
      setFavoritesPosition({
        left: Math.max(4, Math.min(window.innerWidth - width - 4, moveEvent.clientX - offsetX)),
        top: Math.max(4, Math.min(window.innerHeight - height - 4, moveEvent.clientY - offsetY)),
      });
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      try { window.localStorage.setItem(DRAWING_TOOL_FAVORITES_POSITION_STORAGE_KEY, JSON.stringify(favoritesPositionRef.current)); } catch { /* private storage */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  };
  const removeAllDrawings = () => {
    if (!drawingCount || locked) return;
    removeManualChartDrawings(engine);
    setRemoveMenuOpen(false);
  };
  const removeAllIndicators = () => {
    if (!indicatorCount || !onRemoveIndicators) return;
    onRemoveIndicators();
    setRemoveMenuOpen(false);
  };
  const removeAllObjects = () => {
    if (drawingCount && !locked) removeManualChartDrawings(engine);
    if (indicatorCount && onRemoveIndicators) onRemoveIndicators();
    setRemoveMenuOpen(false);
  };
  const buttonClass = (active = false) => `alphatrade-chart-tool ${active ? 'is-active' : ''} ${isDark ? 'is-dark' : ''}`;

  return (
    <aside className={`alphatrade-chart-drawing-bar ${docked ? 'is-docked' : ''} ${isDark ? 'is-dark' : ''}`} aria-label="Kreslicí nástroje">
      <button
        type="button"
        className={buttonClass(activeTool === null)}
        onClick={selectPointer}
        title="Kurzor / výběr"
        aria-label="Kurzor / výběr"
        aria-pressed={activeTool === null}
      >
        <CursorToolIcon size={25} />
      </button>
      {CHART_DRAWING_TOOL_GROUPS.map(group => {
        const selectedTool = ALPHATRADE_DRAWING_TOOL_MAP.get(
          group.tools.includes(activeTool as DrawingToolId) ? activeTool as DrawingToolId : toolSelections[group.id],
        );
        if (!selectedTool) return null;
        const Icon = selectedTool.icon;
        const hasMenu = group.tools.length > 1;
        return (
          <React.Fragment key={group.id}>
            {group.dividerBefore && <span className="alphatrade-chart-tool-divider" />}
            <div className="alphatrade-chart-tool-group">
            <button
              type="button"
              className={buttonClass(activeTool === selectedTool.id)}
              onClick={() => selectTool(selectedTool.id)}
              title={`${selectedTool.title}${selectedTool.shortcut ? ` (${selectedTool.shortcut.replace('Alt', '⌥')})` : ''}`}
              aria-label={selectedTool.title}
              aria-keyshortcuts={selectedTool.shortcut}
              aria-pressed={activeTool === selectedTool.id}
            >
              <Icon size={25} />
            </button>
            {hasMenu && <button
              type="button"
              className="alphatrade-chart-tool-group-trigger"
              onClick={event => openToolGroupMenu(group.id, event.currentTarget.parentElement!, group.tools.length)}
              title={`Další nástroje: ${group.title}`}
              aria-label={`Další nástroje: ${group.title}`}
              aria-haspopup="menu"
              aria-expanded={toolGroupMenu?.id === group.id}
            ><ChevronDown size={8} /></button>}
            </div>
          </React.Fragment>
        );
      })}
      {toolGroupMenu && createPortal((() => {
        const group = CHART_DRAWING_TOOL_GROUPS.find(item => item.id === toolGroupMenu.id);
        if (!group) return null;
        return <div
          ref={toolGroupMenuRef}
          data-chart-overlay-menu
          className={`alphatrade-chart-tool-menu ${isDark ? 'is-dark' : ''}`}
          style={{ left: toolGroupMenu.left, top: toolGroupMenu.top }}
          role="menu"
          aria-label={group.title}
          onKeyDown={event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const items = [...(toolGroupMenuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]') ?? [])];
            if (!items.length) return;
            event.preventDefault();
            const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
              : event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          <div className="alphatrade-chart-tool-menu-title">{group.title}</div>
          {group.tools.map(toolId => {
            const tool = ALPHATRADE_DRAWING_TOOL_MAP.get(toolId);
            if (!tool) return null;
            const MenuIcon = tool.icon;
            const selected = toolSelections[group.id] === toolId;
            const favorite = favoriteTools.includes(toolId);
            return <div className="alphatrade-chart-tool-menu-row" key={toolId}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={selected ? 'is-selected' : ''}
                onClick={() => selectToolFromGroup(toolId)}
              >
                <MenuIcon size={23} />
                <span>{tool.title}</span>
                {tool.shortcut && <kbd>{tool.shortcut.replace('Alt', '⌥')}</kbd>}
              </button>
              <button
                type="button"
                className={`alphatrade-chart-tool-favorite ${favorite ? 'is-favorite' : ''}`}
                onClick={event => { event.stopPropagation(); toggleFavoriteTool(toolId); }}
                title={favorite ? 'Odebrat z oblíbených' : 'Přidat do oblíbených'}
                aria-label={`${favorite ? 'Odebrat z oblíbených' : 'Přidat do oblíbených'}: ${tool.title}`}
                aria-pressed={favorite}
              ><Star size={15} fill={favorite ? 'currentColor' : 'none'} /></button>
            </div>;
          })}
        </div>;
      })(), document.body)}
      <span className="alphatrade-chart-tool-divider" />
      <div ref={magnetControlRef} className="alphatrade-chart-magnet-control">
        <button
          type="button"
          className={`${buttonClass()} ${magnet.mode !== 'off' ? 'is-magnet-active' : ''}`}
          onClick={() => setDrawingMagnetSettings({ mode: magnet.mode === 'off' ? magnet.lastEnabledMode : 'off' })}
          title={magnet.mode === 'off' ? 'Zapnout magnet' : 'Vypnout magnet'}
          aria-label={magnet.mode === 'off' ? 'Zapnout magnet' : 'Vypnout magnet'}
          aria-pressed={magnet.mode !== 'off'}
        >
          <MagnetToolIcon size={25} strong={magnet.mode === 'strong'} />
        </button>
        <button
          type="button"
          className="alphatrade-chart-magnet-menu-trigger"
          onClick={() => setMagnetMenuOpen(open => !open)}
          title="Nastavení magnetu"
          aria-label="Nastavení magnetu"
          aria-expanded={magnetMenuOpen}
        ><ChevronDown size={9} /></button>
      </div>
      {magnetMenuOpen && createPortal(
        <div
          ref={magnetMenuRef}
          data-chart-magnet-menu
          data-chart-overlay-menu
          className={`alphatrade-chart-magnet-menu ${isDark ? 'is-dark' : ''}`}
          style={{ left: magnetMenuPosition.left, top: magnetMenuPosition.top }}
          role="menu"
          aria-label="Nastavení magnetu"
          onKeyDown={event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const items = [...(magnetMenuRef.current?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]') ?? [])];
            if (!items.length) return;
            event.preventDefault();
            const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
              : event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          {(['weak', 'strong'] as const).map(mode => (
            <button
              key={mode}
              type="button"
              className={magnet.lastEnabledMode === mode ? 'is-selected' : ''}
              onClick={() => setDrawingMagnetSettings({ mode, lastEnabledMode: mode })}
              role="menuitemradio"
              aria-checked={magnet.lastEnabledMode === mode}
            >
              <MagnetToolIcon size={23} strong={mode === 'strong'} />
              <span>{mode === 'weak' ? 'Slabý magnet' : 'Silný magnet'}</span>
            </button>
          ))}
          <span className="alphatrade-chart-magnet-menu-divider" />
          <button
            type="button"
            className="alphatrade-chart-magnet-indicators"
            onClick={() => setDrawingMagnetSettings({ snapToIndicators: !magnet.snapToIndicators })}
            role="menuitemcheckbox"
            aria-checked={magnet.snapToIndicators}
          >
            <span>Přichytit k indikátorům</span>
            <span className={`alphatrade-chart-magnet-switch ${magnet.snapToIndicators ? 'is-on' : ''}`}><i /></span>
          </button>
        </div>,
        document.body,
      )}
      <button
        type="button"
        className={buttonClass(keepDrawing)}
        onClick={toggleKeepDrawing}
        title={keepDrawing ? 'Vypnout opakované kreslení' : 'Pokračovat v kreslení po dokončení objektu'}
        aria-label={keepDrawing ? 'Vypnout opakované kreslení' : 'Zapnout opakované kreslení'}
        aria-pressed={keepDrawing}
      >
        <KeepDrawingToolIcon size={24} />
      </button>
      <button
        type="button"
        className={buttonClass(locked)}
        onClick={() => engine.setLocked(!locked)}
        title={locked ? 'Odemknout ruční kresby' : 'Zamknout ruční kresby'}
        aria-label={locked ? 'Odemknout ruční kresby' : 'Zamknout ruční kresby'}
        aria-pressed={locked}
      >
        {locked ? <Lock size={22} strokeWidth={1.05} /> : <Unlock size={22} strokeWidth={1.05} />}
      </button>
      <button type="button" className={buttonClass()} onClick={() => engine.removeSelected()} title="Smazat vybranou kresbu" aria-label="Smazat vybranou kresbu" disabled={!hasSelection || locked}>
        <Eraser size={22} strokeWidth={1.05} />
      </button>
      <div ref={removeControlRef} className="alphatrade-chart-remove-control">
        <button
          type="button"
          className={`${buttonClass(removeMenuOpen)} alphatrade-chart-tool-clear`}
          onClick={() => setRemoveMenuOpen(open => !open)}
          title="Odstranit objekty"
          aria-label="Odstranit objekty"
          aria-haspopup="menu"
          aria-expanded={removeMenuOpen}
          disabled={drawingCount === 0 && indicatorCount === 0}
        >
          <Trash2 size={22} strokeWidth={1.05} />
        </button>
        <button
          type="button"
          className="alphatrade-chart-remove-menu-trigger"
          onClick={() => setRemoveMenuOpen(open => !open)}
          title="Možnosti odstranění"
          aria-label="Možnosti odstranění"
          aria-haspopup="menu"
          aria-expanded={removeMenuOpen}
          disabled={drawingCount === 0 && indicatorCount === 0}
        ><ChevronDown size={9} /></button>
      </div>
      {removeMenuOpen && createPortal(
        <div
          ref={removeMenuRef}
          data-chart-overlay-menu
          className={`alphatrade-chart-remove-menu ${isDark ? 'is-dark' : ''}`}
          style={{ left: removeMenuPosition.left, top: removeMenuPosition.top }}
          role="menu"
          aria-label="Odstranit objekty"
          onKeyDown={event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const items = [...(removeMenuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
            if (!items.length) return;
            event.preventDefault();
            const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
              : event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          <button type="button" role="menuitem" onClick={removeAllDrawings} disabled={drawingCount === 0 || locked}>
            Remove {drawingCount} drawing{drawingCount === 1 ? '' : 's'}
          </button>
          <button type="button" role="menuitem" onClick={removeAllIndicators} disabled={indicatorCount === 0 || !onRemoveIndicators}>
            Remove {indicatorCount} indicator{indicatorCount === 1 ? '' : 's'}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={removeAllObjects}
            disabled={(drawingCount === 0 || locked) && (indicatorCount === 0 || !onRemoveIndicators)}
          >
            Remove {drawingCount} drawing{drawingCount === 1 ? '' : 's'} &amp; {indicatorCount} indicator{indicatorCount === 1 ? '' : 's'}
          </button>
        </div>,
        document.body,
      )}
      <button
        type="button"
        className={`${buttonClass(favoritesVisible && favoriteTools.length > 0)} alphatrade-chart-tool-favorites-toggle`}
        onClick={toggleFavoritesToolbar}
        title={favoriteTools.length ? `${favoritesVisible ? 'Skrýt' : 'Zobrazit'} panel oblíbených nástrojů` : 'Nejdřív označte nástroj hvězdičkou'}
        aria-label={favoriteTools.length ? `${favoritesVisible ? 'Skrýt' : 'Zobrazit'} panel oblíbených kreslicích nástrojů` : 'Panel oblíbených kreslicích nástrojů je prázdný'}
        aria-pressed={favoritesVisible && favoriteTools.length > 0}
        disabled={!favoriteTools.length}
      ><Star size={23} strokeWidth={1.15} fill={favoritesVisible && favoriteTools.length ? 'currentColor' : 'none'} /></button>
      {docked && favoritesVisible && favoriteTools.length > 0 && createPortal(
        <div
          ref={favoritesToolbarRef}
          className={`alphatrade-chart-favorites-toolbar ${isDark ? 'is-dark' : ''}`}
          style={{ left: favoritesPosition.left, top: favoritesPosition.top }}
          role="toolbar"
          aria-label="Oblíbené kreslicí nástroje"
        >
          <button
            type="button"
            className="alphatrade-chart-favorites-grip"
            onPointerDown={startFavoritesDrag}
            title="Přesunout panel"
            aria-label="Přesunout panel oblíbených nástrojů"
          ><GripVertical size={14} /></button>
          {favoriteTools.map(toolId => {
            const tool = ALPHATRADE_DRAWING_TOOL_MAP.get(toolId);
            if (!tool) return null;
            const FavoriteIcon = tool.icon;
            return <button
              key={toolId}
              type="button"
              className={activeTool === toolId ? 'is-active' : ''}
              onClick={() => selectTool(toolId)}
              title={tool.title}
              aria-label={`Oblíbený nástroj: ${tool.title}`}
              aria-pressed={activeTool === toolId}
            ><FavoriteIcon size={22} /></button>;
          })}
        </div>,
        document.body,
      )}
    </aside>
  );
};

const asUnix = (value: number | string | undefined, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value > 10_000_000_000 ? value / 1000 : value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return Math.floor(fallback / 1000);
};

const nearestCandleIndex = (candles: MarketCandle[], target: number): number => {
  let nearestIndex = 0;
  let distance = Math.abs((candles[0]?.time || target) - target);
  for (let index = 1; index < candles.length; index += 1) {
    const nextDistance = Math.abs(candles[index].time - target);
    if (nextDistance < distance) {
      nearestIndex = index;
      distance = nextDistance;
    }
  }
  return nearestIndex;
};

const nearestCandleTime = (candles: MarketCandle[], target: number): UTCTimestamp => (
  candles[nearestCandleIndex(candles, target)]?.time || target
) as UTCTimestamp;

const colorWithOpacity = (hex: string, opacity: number): string => {
  const normalized = hex.replace('#', '');
  const value = normalized.length === 3
    ? normalized.split('').map(character => character + character).join('')
    : normalized.padEnd(6, '0').slice(0, 6);
  const numeric = Number.parseInt(value, 16);
  const red = (numeric >> 16) & 255;
  const green = (numeric >> 8) & 255;
  const blue = numeric & 255;
  return `rgba(${red},${green},${blue},${Math.max(0, Math.min(1, opacity))})`;
};

const SHARED_INDICATOR_SETTINGS_KEY = 'alphatrade:chart-indicators:shared';
const SHARED_INDICATOR_SETTINGS_EVENT = 'alphatrade:chart-indicators-change';
const sharedIndicatorSettingsCache = new Map<string, AlphaTradeIndicatorSettings>();

const mergeIndicatorSettings = (saved: string | null): AlphaTradeIndicatorSettings => {
  const defaults = structuredClone(DEFAULT_INDICATOR_SETTINGS);
  if (!saved) return defaults;
  try {
    const parsed = JSON.parse(saved) as Partial<AlphaTradeIndicatorSettings>;
    const savedFvg = parsed.fvg;
    return {
      fvg: {
        ...defaults.fvg,
        ...savedFvg,
        bullOpacity: savedFvg?.bullOpacity ?? savedFvg?.fillOpacity ?? defaults.fvg.bullOpacity,
        bearOpacity: savedFvg?.bearOpacity ?? savedFvg?.fillOpacity ?? defaults.fvg.bearOpacity,
        visibility: { ...defaults.fvg.visibility, ...savedFvg?.visibility },
      },
      structure: {
        ...defaults.structure,
        ...parsed.structure,
        visibility: { ...defaults.structure.visibility, ...parsed.structure?.visibility },
      },
      levels: {
        ...defaults.levels,
        ...parsed.levels,
        visibility: { ...defaults.levels.visibility, ...parsed.levels?.visibility },
      },
    };
  } catch {
    return defaults;
  }
};

const loadSharedIndicatorSettings = (legacyKey: string): AlphaTradeIndicatorSettings => {
  const cached = sharedIndicatorSettingsCache.get(SHARED_INDICATOR_SETTINGS_KEY);
  if (cached) return structuredClone(cached);
  let shared: string | null = null;
  let legacy: string | null = null;
  try {
    shared = window.localStorage.getItem(SHARED_INDICATOR_SETTINGS_KEY);
    legacy = shared ? null : window.localStorage.getItem(legacyKey);
  } catch { /* private storage */ }
  const settings = mergeIndicatorSettings(shared ?? legacy);
  sharedIndicatorSettingsCache.set(SHARED_INDICATOR_SETTINGS_KEY, settings);
  if (!shared) {
    try { window.localStorage.setItem(SHARED_INDICATOR_SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private storage */ }
  }
  return structuredClone(settings);
};

const CandleKitTradeChart: React.FC<CandleKitTradeChartProps> = ({
  trade,
  candles,
  rawCandles,
  timeframe,
  entryMs,
  exitMs,
  showFvg,
  showLevels,
  showStructure,
  isDark,
  drawingScope,
  compactToolbar = false,
  showIndicatorPicker = false,
  indicatorController: suppliedIndicatorController,
  focusRequest,
  hideFocusButton = false,
  compactMode = false,
  hideDrawingToolbar = false,
  keyboardShortcutsActive = true,
  onChartApiReady,
  activeLibraryIndicators = [],
  onToggleFvg,
  onToggleLevels,
  onToggleStructure,
  instrumentRoot,
  replayActive = false,
  replayCursorTime = null,
  replaySelecting = false,
  replaySelectionCandles = [],
  replaySelectionTime = null,
  onReplaySelectionTimeChange,
  onReplayStart,
}) => {
  const apiRef = useRef<ChartViewApi | null>(null);
  const chartRootRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const rangeSubscriptionRef = useRef<{ chart: IChartApi; handler: () => void } | null>(null);
  const crosshairSubscriptionRef = useRef<{
    chart: IChartApi;
    handler: Parameters<IChartApi['subscribeCrosshairMove']>[0];
  } | null>(null);
  const protectedDrawingsUnsubscribeRef = useRef<(() => void) | null>(null);
  const drawingMagnetCleanupRef = useRef<(() => void) | null>(null);
  const drawingSelectionUnsubscribeRef = useRef<(() => void) | null>(null);
  const drawingMagnetResolverRef = useRef<(point: { time: number; price: number }) => { time: number; price: number }>(point => point);
  const magnetCrosshairFrameRef = useRef<number | null>(null);
  const magnetPendingSnapRef = useRef<{ time: number; price: number } | null>(null);
  const magnetCrosshairUpdatingRef = useRef(false);
  const magnetFirstAnchorPreviewRef = useRef(false);
  const overlayArtifactsRef = useRef<{
    api: ChartViewApi | null;
    lines: ISeriesApi<'Line'>[];
    primitives: ISeriesPrimitive<Time>[];
  }>({ api: null, lines: [], primitives: [] });
  const ohlcValuesRef = useRef<HTMLSpanElement>(null);
  const ohlcChangeRef = useRef<HTMLSpanElement>(null);
  const pendingVisibleRangeRef = useRef<{ from: Time; to: Time } | null>(null);
  const expandingWindowRef = useRef(false);
  const priceWheelFrameRef = useRef<number | null>(null);
  const priceWheelDeltaRef = useRef(0);
  const fvgPrimitiveRequestUpdateRef = useRef<(() => void) | null>(null);
  const levelsPrimitiveRequestUpdateRef = useRef<(() => void) | null>(null);
  const structurePrimitiveRequestUpdateRef = useRef<(() => void) | null>(null);
  const replayStructureSyncSignatureRef = useRef('');
  const replayViewportFrameRef = useRef<number | null>(null);
  const replayViewportTargetRef = useRef<{ from: number; to: number } | null>(null);
  const replayPriceRangeTargetRef = useRef<{ from: number; to: number } | null>(null);
  const replayStartAnimationFrameRef = useRef<number | null>(null);
  const replayStartTransitionRef = useRef<{
    cutRatio: number;
    logicalSpan: number;
  } | null>(null);
  const settingsStorageKey = SHARED_INDICATOR_SETTINGS_KEY;
  const legacySettingsStorageKey = `alphatrade:chart-indicators:${drawingScope || trade.id}`;
  const resolvedInstrumentRoot = resolveNasdaqFuturesRoot(instrumentRoot, trade.symbol || trade.instrument);
  const instrumentLegend = chartInstrumentLegend(resolvedInstrumentRoot, timeframe);
  const [indicatorSettings, setIndicatorSettings] = useState<AlphaTradeIndicatorSettings>(() => {
    if (typeof window === 'undefined') return structuredClone(DEFAULT_INDICATOR_SETTINGS);
    return loadSharedIndicatorSettings(legacySettingsStorageKey);
  });
  const settingsSyncSourceRef = useRef(Symbol('chart-indicator-settings'));
  const [selectedFib, setSelectedFib] = useState<{ engine: CandleKitDrawingEngine; drawing: FibDrawing } | null>(null);
  const [selectedDrawing, setSelectedDrawing] = useState<{ engine: CandleKitDrawingEngine; drawing: Drawing } | null>(null);
  const [fibSettingsOpen, setFibSettingsOpen] = useState(false);
  const [drawingSettingsOpen, setDrawingSettingsOpen] = useState(false);
  const [replaySelectionPreview, setReplaySelectionPreview] = useState<{
    time: number;
    x: number;
    y: number | null;
    plotWidth: number;
  } | null>(null);
  const replaySelectionDragRef = useRef<{
    pointerId: number;
    startX: number;
    lastX: number;
    moved: boolean;
  } | null>(null);
  const suppressReplaySelectionClickRef = useRef(false);
  const replaySelectionPointerRef = useRef<{
    clientX: number;
    clientY: number;
    element: HTMLDivElement;
  } | null>(null);
  const replaySelectionRefreshFrameRef = useRef<number | null>(null);
  const updateSharedIndicatorSettings = useCallback((next: AlphaTradeIndicatorSettings) => {
    sharedIndicatorSettingsCache.set(settingsStorageKey, next);
    setIndicatorSettings(next);
    window.dispatchEvent(new CustomEvent(SHARED_INDICATOR_SETTINGS_EVENT, {
      detail: { key: settingsStorageKey, settings: next, source: settingsSyncSourceRef.current },
    }));
  }, [settingsStorageKey]);
  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; settings: AlphaTradeIndicatorSettings; source: symbol }>).detail;
      if (!detail || detail.key !== settingsStorageKey || detail.source === settingsSyncSourceRef.current) return;
      setIndicatorSettings(structuredClone(detail.settings));
    };
    window.addEventListener(SHARED_INDICATOR_SETTINGS_EVENT, sync);
    return () => window.removeEventListener(SHARED_INDICATOR_SETTINGS_EVENT, sync);
  }, [settingsStorageKey]);
  const indicatorSettingsRef = useRef(indicatorSettings);
  indicatorSettingsRef.current = indicatorSettings;
  const [settingsDialogIndicator, setSettingsDialogIndicator] = useState<AlphaTradeIndicatorId | null>(null);
  const [contextMenu, setContextMenu] = useState<{ left: number; top: number; drawingCount: number } | null>(null);
  const settingsBackupRef = useRef<AlphaTradeIndicatorSettings | null>(null);
  const [hiddenCustomIndicators, setHiddenCustomIndicators] = useState<Set<AlphaTradeIndicatorId>>(new Set());
  const setCustomIndicatorHidden = useCallback((id: AlphaTradeIndicatorId, hidden: boolean) => {
    setHiddenCustomIndicators(current => {
      const next = new Set(current);
      if (hidden) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const indicatorCount = countChartIndicators(
    [showFvg, showLevels, showStructure],
    activeLibraryIndicators,
  );

  useEffect(() => {
    if (!keyboardShortcutsActive) return;
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
      if (!isResetChartViewShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      resetChartView(apiRef.current);
      setContextMenu(null);
    };
    window.addEventListener('keydown', handleShortcut, true);
    return () => window.removeEventListener('keydown', handleShortcut, true);
  }, [keyboardShortcutsActive]);

  useEffect(() => {
    if (!contextMenu) return;
    const focusFrame = window.requestAnimationFrame(() => {
      contextMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
    const close = () => setContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  const handleContextMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!contextMenu) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setContextMenu(null);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...(contextMenuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }, [contextMenu]);

  const openContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, input, select, textarea, [role="dialog"], [role="menu"]')) return;
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 236;
    const menuHeight = 116;
    setContextMenu({
      left: Math.max(6, Math.min(event.clientX, window.innerWidth - menuWidth - 6)),
      top: Math.max(6, Math.min(event.clientY, window.innerHeight - menuHeight - 6)),
      drawingCount: countManualChartDrawings(apiRef.current?.drawing?.engine),
    });
  }, []);

  const removeDrawings = useCallback(() => {
    removeManualChartDrawings(apiRef.current?.drawing?.engine);
    setContextMenu(null);
  }, []);
  const replaySelectionForTime = useCallback((time: number) => {
    const api = apiRef.current;
    if (!api) return null;
    const timeScale = api.controller.getChart().timeScale();
    const plotWidth = timeScale.width();
    // A shared replay timestamp will often fall inside, rather than exactly on,
    // a candle on a higher timeframe. Anchor the cut to the panel candle that
    // contains that moment so every chart can display the same replay boundary.
    let low = 0;
    let high = candles.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (candles[middle].time <= time) low = middle + 1;
      else high = middle;
    }
    const panelTime = candles[Math.max(0, low - 1)]?.time;
    const coordinate = panelTime === undefined
      ? null
      : timeScale.timeToCoordinate(panelTime as UTCTimestamp);
    let x: number;
    if (coordinate === null) {
      const firstTime = candles[0]?.time;
      const lastTime = candles.at(-1)?.time;
      if (firstTime !== undefined && time <= firstTime) x = 0;
      else if (lastTime !== undefined && time >= lastTime) x = plotWidth;
      else return null;
    } else x = Number(coordinate);
    return { time, x: Math.max(0, Math.min(plotWidth, x)), plotWidth };
  }, [candles]);
  const replaySelectionAtClientX = useCallback((clientX: number, element: HTMLDivElement) => {
    const api = apiRef.current;
    if (!api) return null;
    const rect = element.getBoundingClientRect();
    const requested = api.controller.getChart().timeScale().coordinateToTime(clientX - rect.left);
    if (requested === null) return null;
    const time = nearestReplayCandleTime(replaySelectionCandles, Number(requested));
    if (time === null) return null;
    return replaySelectionForTime(time);
  }, [replaySelectionCandles, replaySelectionForTime]);
  const rememberReplayStartTransition = useCallback((selection: { x: number; plotWidth: number }) => {
    const timeScale = apiRef.current?.controller.getChart().timeScale();
    const range = timeScale?.getVisibleLogicalRange();
    if (!range || selection.plotWidth <= 0) return;
    const logicalSpan = range.to - range.from;
    if (!Number.isFinite(logicalSpan) || logicalSpan <= 0) return;
    replayStartTransitionRef.current = {
      cutRatio: Math.max(0, Math.min(1, selection.x / selection.plotWidth)),
      logicalSpan,
    };
  }, []);
  const updateReplaySelectionPreview = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!replaySelecting) return;
    replaySelectionPointerRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      element: event.currentTarget,
    };
    const selection = replaySelectionAtClientX(event.clientX, event.currentTarget);
    if (!selection) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setReplaySelectionPreview({
      ...selection,
      y: Math.max(20, Math.min(rect.height - 36, event.clientY - rect.top)),
    });
    onReplaySelectionTimeChange?.(selection.time);
  }, [onReplaySelectionTimeChange, replaySelecting, replaySelectionAtClientX]);
  const scheduleReplaySelectionRefresh = useCallback(() => {
    if (replaySelectionRefreshFrameRef.current !== null) return;
    replaySelectionRefreshFrameRef.current = window.requestAnimationFrame(() => {
      replaySelectionRefreshFrameRef.current = null;
      const pointer = replaySelectionPointerRef.current;
      if (!pointer) return;
      const selection = replaySelectionAtClientX(pointer.clientX, pointer.element);
      if (!selection) return;
      const rect = pointer.element.getBoundingClientRect();
      setReplaySelectionPreview({
        ...selection,
        y: Math.max(20, Math.min(rect.height - 36, pointer.clientY - rect.top)),
      });
      onReplaySelectionTimeChange?.(selection.time);
    });
  }, [onReplaySelectionTimeChange, replaySelectionAtClientX]);
  const commitReplaySelection = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (suppressReplaySelectionClickRef.current) {
      suppressReplaySelectionClickRef.current = false;
      return;
    }
    const selection = replaySelectionAtClientX(event.clientX, event.currentTarget);
    if (selection) {
      rememberReplayStartTransition(selection);
      onReplayStart?.(selection.time);
    }
  }, [onReplayStart, rememberReplayStartTransition, replaySelectionAtClientX]);
  const panReplaySelection = useCallback((deltaPixels: number) => {
    const api = apiRef.current;
    if (!api || deltaPixels === 0) return;
    const timeScale = api.controller.getChart().timeScale();
    const range = timeScale.getVisibleLogicalRange();
    const width = timeScale.width();
    if (!range || width <= 0) return;
    const shift = -deltaPixels / width * (range.to - range.from);
    timeScale.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
  }, []);
  const handleReplaySelectionPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const plotWidth = apiRef.current?.controller.getChart().timeScale().width() ?? 0;
    const localX = event.clientX - event.currentTarget.getBoundingClientRect().left;
    if (localX > plotWidth) return;
    replaySelectionDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      lastX: event.clientX,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);
  const handleReplaySelectionPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = replaySelectionDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      const deltaX = event.clientX - drag.lastX;
      if (Math.abs(event.clientX - drag.startX) > 3) drag.moved = true;
      drag.lastX = event.clientX;
      if (drag.moved) panReplaySelection(deltaX);
    }
    updateReplaySelectionPreview(event);
    if (drag?.moved) scheduleReplaySelectionRefresh();
  }, [panReplaySelection, scheduleReplaySelectionRefresh, updateReplaySelectionPreview]);
  const finishReplaySelectionDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = replaySelectionDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressReplaySelectionClickRef.current = drag.moved;
    replaySelectionDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);
  const handleReplaySelectionWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const api = apiRef.current;
    if (!api) return;
    const timeScale = api.controller.getChart().timeScale();
    const range = timeScale.getVisibleLogicalRange();
    const plotWidth = timeScale.width();
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    if (!range || plotWidth <= 0 || localX > plotWidth) return;
    event.preventDefault();
    event.stopPropagation();
    replaySelectionPointerRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      element: event.currentTarget,
    };
    const span = range.to - range.from;
    if (Math.abs(event.deltaX) > 0.5) {
      const shift = event.deltaX / plotWidth * span;
      timeScale.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
    } else {
      const anchor = Math.max(0, Math.min(1, localX / plotWidth));
      const zoomFactor = Math.exp(Math.max(-0.25, Math.min(0.25, event.deltaY * 0.0015)));
      const nextSpan = Math.max(8, Math.min(candles.length + 100, span * zoomFactor));
      const anchorLogical = range.from + span * anchor;
      timeScale.setVisibleLogicalRange({
        from: anchorLogical - nextSpan * anchor,
        to: anchorLogical + nextSpan * (1 - anchor),
      });
    }
    scheduleReplaySelectionRefresh();
  }, [candles.length, scheduleReplaySelectionRefresh]);
  const handleReplaySelectionPointerLeave = useCallback(() => {
    if (!replaySelectionDragRef.current) replaySelectionPointerRef.current = null;
    setReplaySelectionPreview(current => current ? { ...current, y: null } : null);
  }, []);

  useLayoutEffect(() => {
    if (!replaySelecting || replaySelectionTime === null) {
      setReplaySelectionPreview(null);
      return;
    }
    const selection = replaySelectionForTime(replaySelectionTime);
    if (selection) rememberReplayStartTransition(selection);
    setReplaySelectionPreview(current => selection ? {
      ...selection,
      y: current?.time === replaySelectionTime ? current.y : null,
    } : null);
  }, [rememberReplayStartTransition, replaySelecting, replaySelectionForTime, replaySelectionTime]);
  const visibleFvg = showFvg
    && !hiddenCustomIndicators.has('fvg')
    && indicatorSettings.fvg.enabled
    && indicatorSettings.fvg.boxes
    && indicatorVisibleOnTimeframe(timeframe, indicatorSettings.fvg.visibility);
  const visibleLevels = showLevels
    && !hiddenCustomIndicators.has('levels')
    && indicatorVisibleOnTimeframe(timeframe, indicatorSettings.levels.visibility);
  const visibleStructure = showStructure
    && !hiddenCustomIndicators.has('structure')
    && indicatorSettings.structure.enabled
    && indicatorVisibleOnTimeframe(timeframe, indicatorSettings.structure.visibility);
  const showEntryFvg = !replayActive && !hiddenCustomIndicators.has('fvg');
  const showEntryStructure = !replayActive && !hiddenCustomIndicators.has('structure');
  const overlayRebuildSignature = JSON.stringify({
    visibleFvg,
    visibleLevels,
    visibleStructure,
    showEntryFvg,
    showEntryStructure,
    structure: indicatorSettings.structure,
  });
  const fvgPaintSignature = JSON.stringify({
    bullColor: indicatorSettings.fvg.bullColor,
    bearColor: indicatorSettings.fvg.bearColor,
    bullOpacity: indicatorSettings.fvg.bullOpacity ?? indicatorSettings.fvg.fillOpacity,
    bearOpacity: indicatorSettings.fvg.bearOpacity ?? indicatorSettings.fvg.fillOpacity,
    mitigatedTransparency: indicatorSettings.fvg.mitigatedTransparency,
    maxCount: indicatorSettings.fvg.maxCount,
    labelText: indicatorSettings.fvg.labelText,
    labelSize: indicatorSettings.fvg.labelSize,
    labelColor: indicatorSettings.fvg.labelColor,
  });
  const previousOverlayRebuildRef = useRef(overlayRebuildSignature);
  const internalIndicatorController = useMemo(
    () => showIndicatorPicker ? new IndicatorController(createBuiltinRegistry()) : null,
    [showIndicatorPicker],
  );
  const indicatorController = suppliedIndicatorController ?? internalIndicatorController;
  const removeIndicators = useCallback(() => {
    indicatorController?.clear();
    if (showFvg) onToggleFvg?.();
    if (showLevels) onToggleLevels?.();
    if (showStructure) onToggleStructure?.();
    setHiddenCustomIndicators(new Set());
    setContextMenu(null);
  }, [indicatorController, onToggleFvg, onToggleLevels, onToggleStructure, showFvg, showLevels, showStructure]);
  const chartTheme = useMemo(
    () => ({
      ...(isDark ? darkTheme : lightTheme),
      grid: 'transparent',
      up: isDark ? chartStyle.bullBodyDark : chartStyle.bullBodyLight,
      down: chartStyle.bear,
      volumeUp: 'rgba(107,114,128,0.16)',
      volumeDown: 'rgba(31,91,196,0.16)',
      fontFamily: chartStyle.fontFamily,
    }),
    [isDark],
  );
  const initialWindow = useMemo(
    () => initialCandleWindow(candles, timeframe, trade, entryMs, exitMs, compactMode),
    [candles, timeframe, trade, entryMs, exitMs, compactMode],
  );
  const [candleWindow, setCandleWindow] = useState<CandleWindow>(initialWindow);
  const replayWindowRef = useRef<{ timeframe: MarketTimeframe; compactMode: boolean; start: number } | null>(null);

  if (!replayActive) {
    replayWindowRef.current = null;
  } else if (!replayWindowRef.current
    || replayWindowRef.current.timeframe !== timeframe
    || replayWindowRef.current.compactMode !== compactMode) {
    const sizing = (compactMode ? COMPACT_WINDOW_BARS : INITIAL_WINDOW_BARS)[timeframe];
    replayWindowRef.current = {
      timeframe,
      compactMode,
      start: Math.max(0, candles.length - sizing.before - sizing.after),
    };
  }

  useEffect(() => {
    if (replayActive) return;
    pendingVisibleRangeRef.current = null;
    expandingWindowRef.current = false;
    setCandleWindow(initialWindow);
  }, [candles.length, compactMode, initialWindow, replayActive, timeframe]);

  useEffect(() => () => {
    unsubscribeVisibleRangeSafely(rangeSubscriptionRef.current);
    unsubscribeCrosshairSafely(crosshairSubscriptionRef.current);
    protectedDrawingsUnsubscribeRef.current?.();
    drawingMagnetCleanupRef.current?.();
    drawingSelectionUnsubscribeRef.current?.();
    if (magnetCrosshairFrameRef.current !== null) window.cancelAnimationFrame(magnetCrosshairFrameRef.current);
    magnetPendingSnapRef.current = null;
    magnetCrosshairUpdatingRef.current = false;
    const artifacts = overlayArtifactsRef.current;
    if (artifacts.api) {
      const chart = artifacts.api.controller.getChart();
      const series = artifacts.api.controller.getSeries() as ISeriesApi<'Candlestick'>;
      artifacts.primitives.forEach(primitive => {
        try { series.detachPrimitive(primitive); } catch { /* chart already destroyed */ }
      });
      artifacts.lines.forEach(line => {
        try { chart.removeSeries(line); } catch { /* chart already destroyed */ }
      });
    }
    overlayArtifactsRef.current = { api: null, lines: [], primitives: [] };
    if (priceWheelFrameRef.current !== null) window.cancelAnimationFrame(priceWheelFrameRef.current);
    if (replayViewportFrameRef.current !== null) window.cancelAnimationFrame(replayViewportFrameRef.current);
    if (replayStartAnimationFrameRef.current !== null) window.cancelAnimationFrame(replayStartAnimationFrameRef.current);
    if (replaySelectionRefreshFrameRef.current !== null) window.cancelAnimationFrame(replaySelectionRefreshFrameRef.current);
    replayViewportTargetRef.current = null;
    replayPriceRangeTargetRef.current = null;
    replaySelectionPointerRef.current = null;
    onChartApiReady?.(null);
  }, [onChartApiReady]);

  const renderedCandleWindow = useMemo<CandleWindow>(() => {
    if (!replayActive) return candleWindow;
    return {
      // Keep the beginning of a replay window stable. New candles are then
      // genuine appends instead of a rolling full-series replacement, so the
      // time scale advances by one bar without snapping to the right edge.
      start: Math.min(replayWindowRef.current?.start ?? 0, candles.length),
      end: candles.length,
    };
  }, [candleWindow, candles.length, compactMode, replayActive, timeframe]);
  const visibleCandles = useMemo(
    () => candles.slice(renderedCandleWindow.start, renderedCandleWindow.end),
    [candles, renderedCandleWindow],
  );

  const visibleCandlesRef = useRef(visibleCandles);
  visibleCandlesRef.current = visibleCandles;
  const visibleCandleLookup = useMemo(() => new Map(visibleCandles.map((candle, index) => [
    candle.time,
    { candle, previousClose: visibleCandles[index - 1]?.close },
  ])), [visibleCandles]);
  const visibleCandleLookupRef = useRef(visibleCandleLookup);
  visibleCandleLookupRef.current = visibleCandleLookup;
  const liquidityLevels = useMemo(
    () => visibleLevels
      ? calculateLiquidityLevels(candles.slice(0, renderedCandleWindow.end), indicatorSettings.levels)
      : EMPTY_LIQUIDITY_LEVELS,
    [candles, renderedCandleWindow.end, indicatorSettings.levels, visibleLevels],
  );
  const liquidityLevelsRef = useRef(liquidityLevels);
  liquidityLevelsRef.current = liquidityLevels;
  const fvgs = useMemo(() => {
    if (!visibleFvg) return [];
    if (replayActive) {
      const replayContextStart = Math.max(0, renderedCandleWindow.start - 600);
      return findFairValueGaps(candles.slice(replayContextStart, renderedCandleWindow.end));
    }
    const from = Math.floor(entryMs / 1000) - 8 * 3600;
    return findFairValueGaps(candles.filter(candle => candle.time >= from));
  }, [candles, entryMs, renderedCandleWindow.end, renderedCandleWindow.start, replayActive, visibleFvg]);
  const structureEvents = useMemo(() => {
    if (!visibleStructure || timeframe !== '1m') return [];
    const firstRenderedTime = visibleCandles[0]?.time ?? Number.NEGATIVE_INFINITY;
    return calculateMarketStructure(candles)
      .filter(event => event.breakTime >= firstRenderedTime);
  }, [candles, timeframe, visibleCandles, visibleStructure]);
  const entryStructureEvents = useMemo(() => {
    if (!showEntryStructure) return [];
    const from = Math.floor(entryMs / 1000) - 200 * 60;
    const to = Math.floor(Math.max(entryMs, exitMs) / 1000) + 30 * 60;
    return calculateMarketStructure(rawCandles)
      .filter(event => event.breakTime >= from && event.pivotTime <= to);
  }, [entryMs, exitMs, rawCandles, showEntryStructure]);
  const entryFvg = useMemo(() => {
    if (!showEntryFvg) return null;
    const entryMappedToFvg = trade.entryMap?.entryFvg === true
      || trade.ltfConfluence?.some(tag => /entry.*fvg/i.test(tag));
    if (!entryMappedToFvg) return null;
    const entryUnix = Math.floor(entryMs / 1000);
    return findEntryFairValueGap(
      findFairValueGaps(rawCandles.filter(candle => candle.time >= entryUnix - 8 * 3600 && candle.time <= entryUnix)),
      entryUnix,
      Number(trade.entryPrice),
      String(trade.direction).toLowerCase() === 'long' ? 'long' : 'short',
    );
  }, [rawCandles, entryMs, showEntryFvg, trade]);
  const displayedEntryFvg = useMemo(() => {
    if (!entryFvg) return null;
    const from = Math.floor(entryMs / 1000) - 8 * 3600;
    return findFairValueGaps(rawCandles.filter(candle => candle.time >= from))
      .find(gap => gap.startTime === entryFvg.startTime) ?? entryFvg;
  }, [entryFvg, entryMs, rawCandles]);
  const entryStructure = useMemo(() => {
    const mappedType = String(trade.entryMap?.structureType || '').toUpperCase();
    const tagType = trade.ltfConfluence?.find(tag => /^(choch|bos)\b/i.test(tag));
    const desiredType = mappedType === 'CHOCH' || /^choch\b/i.test(tagType || '')
      ? 'CHoCH'
      : mappedType === 'BOS' || /^bos\b/i.test(tagType || '')
        ? 'BOS'
        : null;
    if (!desiredType) return null;
    return findEntryStructureEvent(
      entryStructureEvents,
      Math.floor(entryMs / 1000),
      String(trade.direction).toLowerCase() === 'long' ? 'long' : 'short',
      desiredType,
    );
  }, [entryStructureEvents, entryMs, trade]);
  const renderedFvgs = useMemo(() => {
    const drawn = [
      ...(visibleFvg
        ? fvgs
          .filter(gap => gap.startTime !== displayedEntryFvg?.startTime)
          .map(gap => ({ gap, isEntry: false }))
        : []),
      ...(showEntryFvg && displayedEntryFvg ? [{ gap: displayedEntryFvg, isEntry: true }] : []),
    ];
    const rendered = drawn.map(item => {
      const confirmationIndex = nearestCandleIndex(candles, item.gap.startTime);
      return {
        ...item,
        formingTime: candles[Math.max(0, confirmationIndex - 1)]?.time,
      };
    }).filter((item): item is typeof item & { formingTime: number } => item.formingTime !== undefined);
    return {
      regular: rendered.filter(item => !item.isEntry),
      entry: rendered.filter(item => item.isEntry),
    };
  }, [candles, displayedEntryFvg, fvgs, showEntryFvg, visibleFvg]);
  const renderedFvgsRef = useRef(renderedFvgs);
  renderedFvgsRef.current = renderedFvgs;
  const structureOverlayEvents = useMemo(() => {
    const style = indicatorSettings.structure;
    const events = [
      ...(visibleStructure ? structureEvents : []),
      ...(showEntryStructure && entryStructure ? [entryStructure] : []),
    ].filter((event, index, all) => (
      all.findIndex(candidate => (
        candidate.pivotTime === event.pivotTime
        && candidate.breakTime === event.breakTime
        && candidate.price === event.price
        && candidate.type === event.type
      )) === index
    )).filter(event => (
      (event.type === 'BOS' && style.showBos)
      || (event.type === 'CHoCH' && style.showChoch)
    ));
    return events.map(event => ({
      event,
      midpoint: nearestCandleTime(
        visibleCandles,
        Math.floor((event.pivotTime + event.breakTime) / 2),
      ),
    }));
  }, [entryStructure, indicatorSettings.structure, showEntryStructure, structureEvents, visibleCandles, visibleStructure]);
  const structureOverlayEventsRef = useRef(structureOverlayEvents);
  structureOverlayEventsRef.current = structureOverlayEvents;
  const replayStructureSyncSignature = useMemo(() => JSON.stringify({
    events: structureOverlayEvents.map(({ event }) => [
      event.pivotTime,
      event.breakTime,
      event.price,
      event.type,
      event.direction,
    ]),
    style: indicatorSettings.structure,
  }), [indicatorSettings.structure, structureOverlayEvents]);
  const bars = useMemo(() => visibleCandles.map(candle => ({
    ts: candle.time * 1000,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  })), [visibleCandles]);
  const replayDataSeedRef = useRef<{ key: string; bars: typeof bars } | null>(null);
  const replayDataKey = `${trade.id}:${timeframe}:${renderedCandleWindow.start}`;
  if (!replayActive) {
    replayDataSeedRef.current = null;
  } else if (!replayDataSeedRef.current || replayDataSeedRef.current.key !== replayDataKey) {
    // ChartView observes the data array by identity and calls setData whenever
    // that identity changes. Keep one seed for the replay session; subsequent
    // candles are applied through updateBar below so neither pane flashes nor
    // silently resets its viewport when its current HTF candle is updated.
    replayDataSeedRef.current = { key: replayDataKey, bars };
  }
  const chartBars = replayActive ? replayDataSeedRef.current?.bars ?? bars : bars;

  useLayoutEffect(() => {
    if (!replayActive || bars.length === 0) return;
    const controller = apiRef.current?.controller;
    if (!controller) return;

    const chart = controller.getChart();
    const timeScale = chart.timeScale();
    const priceScale = chart.priceScale('right');
    const viewportBeforeUpdate = replayViewportTargetRef.current
      ?? timeScale.getVisibleLogicalRange();
    const visiblePriceRange = priceScale.options().autoScale === false
      ? priceScale.getVisibleRange()
      : null;
    const priceRangeBeforeUpdate = visiblePriceRange
      ? { from: visiblePriceRange.from, to: visiblePriceRange.to }
      : null;
    replayPriceRangeTargetRef.current = priceRangeBeforeUpdate;

    const controllerBars = controller.getBars();
    const lastControllerTime = controllerBars.at(-1)?.ts;
    let firstUpdateIndex = lastControllerTime === undefined
      ? 0
      : bars.findIndex(bar => bar.ts >= lastControllerTime);
    if (firstUpdateIndex < 0) return;

    // Include the matching last bar: on higher timeframes a replay step often
    // changes OHLC of the still-open candle without increasing bar count.
    for (; firstUpdateIndex < bars.length; firstUpdateIndex += 1) {
      controller.updateBar(bars[firstUpdateIndex]);
    }

    if (viewportBeforeUpdate) {
      // TradingView keeps the viewport fixed while replay candles consume the
      // empty space on the right. Only once the newest bar reaches the edge do
      // we move by the minimum necessary amount. Doing this in a layout effect
      // makes updateBar + viewport restoration one paint, avoiding flashes.
      const rightPaddingBars = 6;
      const newestLogicalIndex = bars.length - 1;
      const shift = Math.max(0, newestLogicalIndex + rightPaddingBars - viewportBeforeUpdate.to);
      const nextRange = {
        from: viewportBeforeUpdate.from + shift,
        to: viewportBeforeUpdate.to + shift,
      };
      replayViewportTargetRef.current = nextRange;
      chartRootRef.current?.setAttribute('data-replay-logical-range', `${nextRange.from}:${nextRange.to}`);
    }

    const applyLatestReplayView = () => {
      const currentApi = apiRef.current;
      if (!currentApi) return;
      const currentChart = currentApi.controller.getChart();
      const viewportTarget = replayViewportTargetRef.current;
      if (viewportTarget) currentChart.timeScale().setVisibleLogicalRange(viewportTarget);
      const priceRangeTarget = replayPriceRangeTargetRef.current;
      if (priceRangeTarget) {
        const currentPriceScale = currentChart.priceScale('right');
        currentPriceScale.setAutoScale(false);
        currentPriceScale.setVisibleRange(priceRangeTarget);
      }
    };
    applyLatestReplayView();
    queueMicrotask(applyLatestReplayView);
    if (replayViewportFrameRef.current === null) {
      replayViewportFrameRef.current = window.requestAnimationFrame(() => {
        replayViewportFrameRef.current = null;
        applyLatestReplayView();
        replayViewportTargetRef.current = null;
        replayPriceRangeTargetRef.current = null;
      });
    }
    if (priceRangeBeforeUpdate) {
      chartRootRef.current?.setAttribute(
        'data-replay-price-range',
        `${priceRangeBeforeUpdate.from}:${priceRangeBeforeUpdate.to}`,
      );
    } else {
      chartRootRef.current?.removeAttribute('data-replay-price-range');
    }
    chartRootRef.current?.setAttribute('data-replay-update-mode', 'incremental');
  }, [bars, replayActive, replayCursorTime, timeframe]);
  const drawingOptions = useMemo(() => ({
    storageKey: `alphatrade:candlekit:${trade.id}:${drawingScope || timeframe}`,
  }), [drawingScope, trade.id, timeframe]);

  const focusTrade = useCallback(() => {
    const api = apiRef.current;
    if (!api || visibleCandles.length === 0) return;
    if (priceWheelFrameRef.current !== null) {
      window.cancelAnimationFrame(priceWheelFrameRef.current);
      priceWheelFrameRef.current = null;
      priceWheelDeltaRef.current = 0;
    }
    try {
      const chart = api.controller.getChart();
      chart.priceScale('right').setAutoScale(true);
      const context = CONTEXT_BARS[timeframe];
      const entryIndex = nearestCandleIndex(visibleCandles, asUnix(trade.entryTime || trade.entryDate, entryMs));
      const exitIndex = nearestCandleIndex(visibleCandles, asUnix(trade.timestamp || trade.exitDate, exitMs));
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, entryIndex - context.before),
        to: Math.min(visibleCandles.length - 1, Math.max(entryIndex, exitIndex) + context.after),
      });
    } catch {
      // During an interval/symbol change the previous ChartView can be disposed
      // one render before the replacement calls onReady. The new chart focuses
      // itself from handleReady, so the stale frame can be ignored safely.
    }
  }, [visibleCandles, timeframe, trade, entryMs, exitMs]);

  useEffect(() => {
    if (focusRequest === undefined) return;
    focusTrade();
  }, [focusRequest, focusTrade]);

  const handlePriceScaleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-chart-settings-dialog]')) return;
    const api = apiRef.current;
    if (!api) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const priceScale = api.controller.getChart().priceScale('right');
    const interactiveWidth = Math.max(64, priceScale.width());
    if (event.clientX < rect.right - interactiveWidth) return;
    event.preventDefault();
    event.stopPropagation();
    priceWheelDeltaRef.current = Math.max(-240, Math.min(240, priceWheelDeltaRef.current + event.deltaY));
    if (priceWheelFrameRef.current !== null) return;
    priceWheelFrameRef.current = window.requestAnimationFrame(() => {
      priceWheelFrameRef.current = null;
      const currentApi = apiRef.current;
      if (!currentApi) return;
      const currentPriceScale = currentApi.controller.getChart().priceScale('right');
      const range = currentPriceScale.getVisibleRange();
      const delta = priceWheelDeltaRef.current;
      priceWheelDeltaRef.current = 0;
      if (!range || delta === 0) return;
      const span = range.to - range.from;
      const center = (range.from + range.to) / 2;
      const zoomFactor = Math.exp(Math.max(-0.24, Math.min(0.24, delta * 0.0015)));
      const nextSpan = Math.max(5, Math.min(20_000, span * zoomFactor));
      if (currentPriceScale.options().autoScale) currentPriceScale.setAutoScale(false);
      currentPriceScale.setVisibleRange({
        from: center - nextSpan / 2,
        to: center + nextSpan / 2,
      });
    });
  }, []);

  const handlePriceScaleDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const api = apiRef.current;
    if (!api) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const priceScale = api.controller.getChart().priceScale('right');
    if (event.clientX < rect.right - Math.max(64, priceScale.width())) return;
    event.preventDefault();
    event.stopPropagation();
    if (priceWheelFrameRef.current !== null) {
      window.cancelAnimationFrame(priceWheelFrameRef.current);
      priceWheelFrameRef.current = null;
      priceWheelDeltaRef.current = 0;
    }
    replayPriceRangeTargetRef.current = null;
    priceScale.setAutoScale(true);
  }, []);

  const handleReady = useCallback((api: ChartViewApi) => {
    const chartChanged = overlayArtifactsRef.current.api !== api;
    apiRef.current = api;
    onChartApiReady?.(api);
    const chart = api.controller.getChart();
    const series = api.controller.getSeries() as ISeriesApi<'Candlestick'>;
    installFibDrawingDefaults(api.drawing?.engine, () => timeframe);
    installDrawingStyleDefaults(api.drawing?.engine);
    installPositionDrawingDefaults(api.drawing?.engine, resolvedInstrumentRoot, timeframeMinutes(timeframe) * 60);
    applyFibRuntimeTimeframe(api.drawing?.engine, timeframe);
    if (chartChanged) {
      overlayArtifactsRef.current = { api, lines: [], primitives: [] };
    } else {
      overlayArtifactsRef.current.primitives.forEach(primitive => {
        try { series.detachPrimitive(primitive); } catch { /* chart already refreshed */ }
      });
      overlayArtifactsRef.current.lines.forEach(line => {
        try { chart.removeSeries(line); } catch { /* chart already refreshed */ }
      });
      overlayArtifactsRef.current.lines = [];
      overlayArtifactsRef.current.primitives = [];
    }
    const applyTradingViewCandleStyle = () => {
      chart.applyOptions({ layout: { fontFamily: chartStyle.fontFamily } });
      series.applyOptions({
        upColor: isDark ? chartStyle.bullBodyDark : chartStyle.bullBodyLight,
        downColor: chartStyle.bear,
        borderVisible: true,
        borderUpColor: isDark ? chartStyle.bullLineDark : chartStyle.bullLineLight,
        borderDownColor: chartStyle.bear,
        wickVisible: true,
        wickUpColor: isDark ? chartStyle.bullLineDark : chartStyle.bullLineLight,
        wickDownColor: chartStyle.bear,
        priceFormat: { type: 'price', precision: 2, minMove: 0.25 },
      });
    };
    applyTradingViewCandleStyle();
    // CandleKit applies its theme once more after onReady. Re-apply the per-side
    // border/wick palette afterwards so the grey candles keep their TV styling.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(applyTradingViewCandleStyle);
    });

    const formatOhlcPrice = (value: number) => value.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const updateOhlcLegend = (candle: MarketCandle, previousClose?: number) => {
      if (ohlcValuesRef.current) {
        ohlcValuesRef.current.textContent = `O ${formatOhlcPrice(candle.open)}  H ${formatOhlcPrice(candle.high)}  L ${formatOhlcPrice(candle.low)}  C ${formatOhlcPrice(candle.close)}`;
      }
      if (!ohlcChangeRef.current) return;
      if (!Number.isFinite(previousClose)) {
        ohlcChangeRef.current.textContent = '';
        return;
      }
      const change = candle.close - Number(previousClose);
      const percent = Number(previousClose) !== 0 ? change / Number(previousClose) * 100 : 0;
      const sign = change > 0 ? '+' : change < 0 ? '−' : '';
      ohlcChangeRef.current.textContent = `${sign}${formatOhlcPrice(Math.abs(change))} (${sign}${Math.abs(percent).toFixed(2)}%)`;
      ohlcChangeRef.current.style.color = change > 0
        ? chartStyle.bullishStructure
        : change < 0 ? chartStyle.bearishStructure : (isDark ? '#94a3b8' : '#64748b');
    };
    const latest = visibleCandles[visibleCandles.length - 1];
    const latestPreviousClose = visibleCandles[visibleCandles.length - 2]?.close;
    if (latest) updateOhlcLegend(latest, latestPreviousClose);
    unsubscribeCrosshairSafely(crosshairSubscriptionRef.current);
    const handleCrosshairMove: Parameters<IChartApi['subscribeCrosshairMove']>[0] = param => {
      const drawingEngine = api.drawing?.engine;
      if (
        !magnetCrosshairUpdatingRef.current
        && drawingEngine?.getActiveTool()
        && !drawingEngine.getDraft()
        && param.time !== undefined
        && param.point
      ) {
        const price = series.coordinateToPrice(param.point.y);
        if (price !== null) {
          magnetFirstAnchorPreviewRef.current = true;
          try {
            drawingMagnetResolverRef.current({ time: Number(param.time), price });
          } finally {
            magnetFirstAnchorPreviewRef.current = false;
          }
        }
      }
      const selected = param.time === undefined ? undefined : visibleCandleLookupRef.current.get(Number(param.time));
      if (selected) updateOhlcLegend(selected.candle, selected.previousClose);
      else {
        const current = visibleCandlesRef.current;
        const currentLatest = current.at(-1);
        if (currentLatest) updateOhlcLegend(currentLatest, current.at(-2)?.close);
      }
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);
    crosshairSubscriptionRef.current = { chart, handler: handleCrosshairMove };

    if (visibleLevels) {
      const currentLevelLabels = (rightTime?: number) => {
        const result = liquidityLevelsRef.current;
        const style = indicatorSettingsRef.current.levels;
        const labels = result.levels.filter(level => rightTime === undefined || level.startTime <= rightTime);
        const pointAt = (points: Array<{ time: number; value: number }>) => {
          if (rightTime === undefined) return points.at(-1);
          for (let index = points.length - 1; index >= 0; index -= 1) {
            if (points[index].time <= rightTime) return points[index];
          }
          return undefined;
        };
        const addDynamic = (name: string, price: number | undefined, color: string) => {
          if (!Number.isFinite(price)) return;
          labels.push({ name, price: Number(price), color, width: 1, style: 'solid', startTime: visibleCandlesRef.current.at(-1)?.time ?? 0, swept: false });
        };
        if (style.showVwap) {
          addDynamic('VWAP', pointAt(result.vwap)?.value, style.vwapColor);
          if (style.showDeviations) {
            addDynamic('VWAP +1σ', pointAt(result.upper1)?.value, style.bandsColor);
            addDynamic('VWAP -1σ', pointAt(result.lower1)?.value, style.bandsColor);
            addDynamic('VWAP +2σ', pointAt(result.upper2)?.value, style.bandsColor);
            addDynamic('VWAP -2σ', pointAt(result.lower2)?.value, style.bandsColor);
          }
        }
        return labels;
      };
      const levelRenderer: IPrimitivePaneRenderer = {
        draw: target => {
          target.useMediaCoordinateSpace(({ context, mediaSize }) => {
            const result = liquidityLevelsRef.current;
            const style = indicatorSettingsRef.current.levels;
            const visibleTimeRange = chart.timeScale().getVisibleRange();
            const x = (time: number) => chart.timeScale().timeToCoordinate(time as UTCTimestamp);
            const y = (price: number) => series.priceToCoordinate(price);
            const dash = (lineStyle: string) => lineStyle === 'dashed' ? [7, 5] : lineStyle === 'dotted' ? [2, 4] : [];
            const drawCurve = (points: Array<{ time: number; value: number }>, color: string, width: number) => {
              context.beginPath(); let started = false;
              points.forEach(point => {
                const px = x(point.time); const py = y(point.value);
                if (px === null || py === null || px < -2 || px > mediaSize.width + 2) return;
                if (!started) { context.moveTo(px, py); started = true; } else context.lineTo(px, py);
              });
              if (started) { context.strokeStyle = color; context.lineWidth = width; context.setLineDash([]); context.stroke(); }
            };
            context.save();
            if (style.showSessionBoxes) result.sessionBoxes.forEach(box => {
              const left = x(box.startTime); const right = x(box.endTime); const top = y(box.high); const bottom = y(box.low);
              if (left === null || right === null || top === null || bottom === null) return;
              context.fillStyle = colorWithOpacity(box.color, (100 - style.sessionBoxTransparency) / 100);
              context.fillRect(left, Math.min(top, bottom), Math.max(1, right - left), Math.abs(bottom - top));
              context.fillStyle = box.color; context.font = `500 9px ${chartStyle.fontFamily}`; context.textAlign = 'center'; context.textBaseline = 'bottom';
              context.fillText(box.name, (left + right) / 2, Math.min(top, bottom) - 3);
            });
            result.levels.forEach(level => {
              const start = x(level.startTime); const py = y(level.price);
              if (py === null || py < 0 || py > mediaSize.height) return;
              if (visibleTimeRange && level.startTime > Number(visibleTimeRange.to)) return;
              if (start !== null && start > mediaSize.width) return;
              const left = start === null || start < 0 ? 0 : start;
              if (level.zone) {
                const top = y(level.zone.top); const bottom = y(level.zone.bottom);
                if (top !== null && bottom !== null) {
                  context.fillStyle = colorWithOpacity(level.color, .08);
                  context.fillRect(left, Math.min(top, bottom), mediaSize.width - left, Math.abs(bottom - top));
                }
              }
              context.beginPath(); context.moveTo(left, py); context.lineTo(mediaSize.width, py);
              context.strokeStyle = level.swept ? colorWithOpacity(level.color, .25) : level.color;
              context.lineWidth = level.swept ? 1 : level.width; context.setLineDash(dash(level.style)); context.stroke();
            });
            if (style.showVwap) drawCurve(result.vwap, style.vwapColor, 2);
            if (style.showVwap && style.showDeviations) {
              drawCurve(result.upper1, style.bandsColor, 1); drawCurve(result.lower1, style.bandsColor, 1);
              drawCurve(result.upper2, style.bandsColor, 1); drawCurve(result.lower2, style.bandsColor, 1);
            }
            if (style.showLabels) {
              const fontSize = style.labelSize === 'large' ? 14 : style.labelSize === 'medium' ? 12 : 10;
              context.font = `500 ${fontSize}px ${chartStyle.fontFamily}`; context.textBaseline = 'middle'; context.textAlign = 'right';
              let previousY = Number.NEGATIVE_INFINITY;
              const endpointTime = visibleCandlesRef.current.at(-1)?.time;
              const endpointX = endpointTime === undefined ? null : x(endpointTime);
              const atDataEnd = endpointTime !== undefined && visibleTimeRange !== null
                && endpointTime >= Number(visibleTimeRange.from)
                && endpointTime <= Number(visibleTimeRange.to);
              const labelAnchor = atDataEnd && endpointX !== null
                ? Math.min(mediaSize.width - 5, endpointX + style.extendLines * chart.timeScale().options().barSpacing)
                : mediaSize.width - 5;
              let previousLabelLeft = labelAnchor;
              const rightTime = atDataEnd ? endpointTime : visibleTimeRange ? Number(visibleTimeRange.to) : endpointTime;
              currentLevelLabels(rightTime).sort((a, b) => b.price - a.price).forEach(level => {
                const py = y(level.price); if (py === null || py < 0 || py > mediaSize.height) return;
                const text = `${level.name}${level.hits === undefined ? '' : level.hits === 0 ? ' [Untested]' : ` [${level.hits}x]`}`;
                const width = context.measureText(text).width + 6;
                const samePriceCluster = Math.abs(py - previousY) < fontSize + 4;
                const tx = samePriceCluster ? previousLabelLeft - 8 : labelAnchor;
                if (tx - width < 0 || tx > mediaSize.width) return;
                context.fillStyle = isDark ? '#101722' : '#ffffff'; context.fillRect(tx - width, py - fontSize / 2 - 2, width, fontSize + 4);
                context.fillStyle = level.swept ? colorWithOpacity(level.color, .4) : level.color; context.fillText(text, tx - 3, py);
                previousY = py;
                previousLabelLeft = tx - width;
              });
            }
            if (style.showBiasTable && result.biasRows.length) {
              const width = 220; const rowHeight = 21; const left = mediaSize.width - width - 8; const top = 8;
              context.fillStyle = isDark ? 'rgba(15,23,42,.82)' : 'rgba(255,255,255,.88)'; context.fillRect(left, top, width, result.biasRows.length * rowHeight + 8);
              context.font = `500 10px ${chartStyle.fontFamily}`; context.textBaseline = 'middle';
              result.biasRows.forEach((row, index) => {
                const cy = top + 5 + index * rowHeight + rowHeight / 2;
                if (row.strong) { context.fillStyle = row.tone === 'bull' ? 'rgba(38,166,154,.25)' : row.tone === 'bear' ? 'rgba(239,83,80,.25)' : 'rgba(176,190,197,.25)'; context.fillRect(left + 3, cy - rowHeight / 2, width - 6, rowHeight); }
                context.fillStyle = isDark ? '#cbd5e1' : '#64748b'; context.textAlign = 'left'; context.fillText(row.label, left + 8, cy);
                context.fillStyle = row.tone === 'bull' ? '#26a69a' : row.tone === 'bear' ? '#ef5350' : row.tone === 'warning' ? '#ffb74d' : (isDark ? '#cbd5e1' : '#64748b');
                context.textAlign = 'right'; context.fillText(row.value, left + width - 8, cy);
              });
            }
            context.restore();
          });
        },
      };
      const priceAxisViews = (): ISeriesPrimitiveAxisView[] => {
        const timeRange = chart.timeScale().getVisibleRange();
        const rightTime = timeRange ? Number(timeRange.to) : visibleCandlesRef.current.at(-1)?.time;
        return indicatorSettingsRef.current.levels.showLabels
          ? currentLevelLabels(rightTime).map(level => ({
          coordinate: () => series.priceToCoordinate(level.price) ?? -1000,
          text: () => level.price.toFixed(2),
          textColor: () => '#ffffff',
          backColor: () => level.swept ? colorWithOpacity(level.color, .35) : level.color,
          visible: () => true,
          })) : [];
      };
      const levelPrimitive: ISeriesPrimitive<Time> = {
        attached: ({ requestUpdate }) => { levelsPrimitiveRequestUpdateRef.current = requestUpdate; },
        detached: () => { levelsPrimitiveRequestUpdateRef.current = null; },
        paneViews: () => [{ zOrder: () => 'bottom', renderer: () => levelRenderer }],
        priceAxisViews,
      };
      series.attachPrimitive(levelPrimitive);
      overlayArtifactsRef.current.primitives.push(levelPrimitive);
    }

    const entryTime = nearestCandleTime(visibleCandles, asUnix(trade.entryTime || trade.entryDate, entryMs));
    const exitTime = nearestCandleTime(visibleCandles, asUnix(trade.timestamp || trade.exitDate, exitMs));
    const isLong = String(trade.direction).toLowerCase() === 'long';
    createSeriesMarkers(series, replayActive ? [] : [
      {
        time: entryTime,
        position: isLong ? 'belowBar' as const : 'aboveBar' as const,
        color: chartStyle.entry,
        shape: isLong ? 'arrowUp' as const : 'arrowDown' as const,
        text: entryFvg ? 'ENTRY FVG' : 'ENTRY',
      },
      {
        time: exitTime,
        position: isLong ? 'aboveBar' as const : 'belowBar' as const,
        color: chartStyle.exit,
        shape: isLong ? 'arrowDown' as const : 'arrowUp' as const,
        text: 'EXIT',
      },
    ].sort((a, b) => Number(a.time) - Number(b.time)));

    const engine = api.drawing?.engine;
    if (engine) {
      drawingSelectionUnsubscribeRef.current?.();
      if (!hideDrawingToolbar) {
        const syncSelectedDrawing = () => {
          const selectedId = engine.getSelectedId();
          const selected = selectedId ? engine.getById(selectedId) : undefined;
          if (selected?.tool === 'FibRetracement') {
            setSelectedFib({ engine, drawing: selected as FibDrawing });
            setSelectedDrawing(null);
            setDrawingSettingsOpen(false);
          } else {
            setSelectedFib(null);
            setFibSettingsOpen(false);
            setSelectedDrawing(selected && !selected.id.startsWith('auto-') ? { engine, drawing: selected } : null);
            if (!selected || selected.id.startsWith('auto-')) setDrawingSettingsOpen(false);
            else if (selected.tool === 'Text' && !selected.style.text?.trim()) setDrawingSettingsOpen(true);
          }
        };
        syncSelectedDrawing();
        drawingSelectionUnsubscribeRef.current = engine.onChange(syncSelectedDrawing);
      }
      drawingMagnetCleanupRef.current?.();
      const indicatorSeries = visibleLevels && indicatorSettingsRef.current.levels.showVwap
        ? [
          liquidityLevelsRef.current.vwap,
          ...(indicatorSettingsRef.current.levels.showDeviations ? [
            liquidityLevelsRef.current.upper1,
            liquidityLevelsRef.current.lower1,
            liquidityLevelsRef.current.upper2,
            liquidityLevelsRef.current.lower2,
          ] : []),
        ] : [];
      const lastCandleTime = visibleCandles.at(-1)?.time ?? 0;
      const indicatorSegments = [
        ...(visibleLevels ? liquidityLevelsRef.current.levels.map(level => ({
          startTime: level.startTime,
          endTime: lastCandleTime,
          price: level.price,
        })) : []),
        ...(visibleFvg ? fvgs.flatMap(gap => [
          { startTime: gap.startTime, endTime: gap.endTime, price: gap.top },
          { startTime: gap.startTime, endTime: gap.endTime, price: gap.bottom },
        ]) : []),
        ...(visibleStructure ? structureEvents.map(event => ({
          startTime: event.pivotTime,
          endTime: event.breakTime,
          price: event.price,
        })) : []),
      ];
      const resolveMagnetPoint = createDrawingMagnetResolver(
        { candles: visibleCandles, indicatorSeries, indicatorSegments },
        {
          timeToX: time => chart.timeScale().timeToCoordinate(time as UTCTimestamp),
          priceToY: price => series.priceToCoordinate(price),
          onSnap: point => {
            if (magnetFirstAnchorPreviewRef.current) {
              // CrosshairMove fires after Lightweight Charts has processed the
              // pointer, so the first-anchor preview can be applied immediately
              // without a frame-delayed update that lags behind a moving mouse.
              magnetCrosshairUpdatingRef.current = true;
              chart.setCrosshairPosition(point.price, point.time as UTCTimestamp, series);
              queueMicrotask(() => { magnetCrosshairUpdatingRef.current = false; });
              return;
            }
            magnetPendingSnapRef.current = point;
            magnetCrosshairUpdatingRef.current = true;
            chart.setCrosshairPosition(point.price, point.time as UTCTimestamp, series);
            if (magnetCrosshairFrameRef.current !== null) return;
            magnetCrosshairFrameRef.current = window.requestAnimationFrame(() => {
              // Throttle to one update per paint while always using the newest
              // snap target. Cancelling and rescheduling here would debounce
              // the preview until the pointer stopped moving.
              const pending = magnetPendingSnapRef.current;
              if (pending) chart.setCrosshairPosition(pending.price, pending.time as UTCTimestamp, series);
              magnetPendingSnapRef.current = null;
              magnetCrosshairUpdatingRef.current = false;
              magnetCrosshairFrameRef.current = null;
            });
          },
        },
      );
      drawingMagnetResolverRef.current = resolveMagnetPoint;
      drawingMagnetCleanupRef.current = installDrawingMagnet(engine, resolveMagnetPoint);
      engine.getDrawings()
        .filter(drawing => drawing.id.startsWith('auto-'))
        .forEach(drawing => engine.remove(drawing.id));
      const commitOnce = (drawing: Parameters<typeof engine.commit>[0]) => {
        if (!engine.getById(drawing.id)) engine.commit(drawing);
      };
      const entry = Number(trade.entryPrice);
      const stop = Number(trade.stopLoss);
      const target = Number(trade.takeProfit);
      const riskEnd = nearestCandleTime(visibleCandles, Math.max(
        Number(exitTime),
        Number(entryTime) + Math.max(10, MARKET_TIMEFRAME_MINUTES[timeframe]) * 60,
      ));
      if (!replayActive && Number.isFinite(entry) && entry > 0 && Number.isFinite(stop) && stop > 0) {
        commitOnce({
          id: `auto-risk-${trade.id}`,
          tool: 'Rectangle',
          points: [{ time: Number(entryTime), price: entry }, { time: Number(riskEnd), price: stop }],
          style: { color: chartStyle.positionRiskBorder, width: 1, dashed: false, fill: chartStyle.positionRiskFill },
        });
        if (Number.isFinite(target) && target > 0) {
          commitOnce({
            id: `auto-target-${trade.id}`,
            tool: 'Rectangle',
            points: [{ time: Number(entryTime), price: entry }, { time: Number(riskEnd), price: target }],
            style: { color: chartStyle.positionTargetBorder, width: 1, dashed: false, fill: chartStyle.positionTargetFill },
          });
        }
      }
      if (visibleFvg || showEntryFvg) {
        const fvgRenderer: IPrimitivePaneRenderer = {
          draw: target => {
            target.useMediaCoordinateSpace(({ context, mediaSize }) => {
              context.save();
              const fvgStyle = indicatorSettingsRef.current.fvg;
              const mitigatedFill = colorWithOpacity(
                '#808080',
                (100 - fvgStyle.mitigatedTransparency) / 100,
              );
              const xCoordinates = new Map<number, number | null>();
              const yCoordinates = new Map<number, number | null>();
              // The primitive is intentionally attached once. Always read the
              // current replay window through the ref instead of capturing the
              // candles that existed when replay started.
              const currentVisibleCandles = visibleCandlesRef.current;
              const firstVisibleTime = currentVisibleCandles[0]?.time ?? Number.NEGATIVE_INFINITY;
              const lastVisibleTime = currentVisibleCandles[currentVisibleCandles.length - 1]?.time ?? Number.POSITIVE_INFINITY;
              const xForTime = (time: number, projectAtRightEdge = false) => {
                if (time <= firstVisibleTime) return 0;
                // An active FVG is projected into the empty space on the
                // right, just like Pine's `bar_index + 20`. A gap mitigated by
                // the currently revealed replay candle must instead end on
                // that candle immediately. Treating equality as the right
                // edge delayed the visual mitigation until the next candle.
                if (time > lastVisibleTime || (projectAtRightEdge && time >= lastVisibleTime)) {
                  return mediaSize.width;
                }
                if (!xCoordinates.has(time)) {
                  xCoordinates.set(time, chart.timeScale().timeToCoordinate(time as UTCTimestamp));
                }
                return xCoordinates.get(time) ?? null;
              };
              const yForPrice = (price: number) => {
                if (!yCoordinates.has(price)) yCoordinates.set(price, series.priceToCoordinate(price));
                return yCoordinates.get(price) ?? null;
              };
              const activeFvgLimit = Math.max(1, Math.min(30, Number(fvgStyle.maxCount) || 1));
              const { regular: regularRenderedFvgs, entry: entryRenderedFvgs } = renderedFvgsRef.current;
              const visibleRenderedFvgs = [
                ...regularRenderedFvgs
                  .filter(item => item.formingTime <= lastVisibleTime && item.gap.endTime >= firstVisibleTime)
                  .slice(-activeFvgLimit * 2),
                ...entryRenderedFvgs.filter(item => item.formingTime <= lastVisibleTime && item.gap.endTime >= firstVisibleTime),
              ];
              visibleRenderedFvgs.forEach(({ gap, formingTime }) => {
                const drawSegment = (
                  startTime: number,
                  endTime: number,
                  topPrice: number,
                  bottomPrice: number,
                  fill: string,
                  projectAtRightEdge = false,
                ) => {
                  const startX = xForTime(startTime);
                  const endX = xForTime(endTime, projectAtRightEdge);
                  const topY = yForPrice(topPrice);
                  const bottomY = yForPrice(bottomPrice);
                  if (startX === null || endX === null || topY === null || bottomY === null) return;
                  const left = Math.max(0, Math.min(startX, endX));
                  const right = Math.min(mediaSize.width, Math.max(startX, endX));
                  const top = Math.max(0, Math.min(topY, bottomY));
                  const bottom = Math.min(mediaSize.height, Math.max(topY, bottomY));
                  if (right <= left || bottom <= top) return;
                  context.fillStyle = fill;
                  context.fillRect(left, top, right - left, bottom - top);
                };
                const baseColor = gap.direction === 'bullish'
                  ? fvgStyle.bullColor
                  : fvgStyle.bearColor;
                const baseOpacity = (gap.direction === 'bullish'
                  ? (fvgStyle.bullOpacity ?? fvgStyle.fillOpacity)
                  : (fvgStyle.bearOpacity ?? fvgStyle.fillOpacity)) / 100;
                // Pine uses color.new(..., 85) after the first touch, i.e. a
                // fixed 15% opacity regardless of the original fill opacity.
                const activeFill = colorWithOpacity(baseColor, gap.touched ? 0.15 : baseOpacity);

                // Pine creates the first box at bar_index - 1. Starting at the
                // middle candle's centre and drawing below the candles removes
                // the visible inter-bar gap while preserving that geometry.
                let stageStart = formingTime;
                let stageTop = gap.top;
                let stageBottom = gap.bottom;
                gap.mitigationSteps.forEach(step => {
                  drawSegment(stageStart, step.time, stageTop, stageBottom, activeFill);
                  stageStart = step.time;
                  stageTop = step.remainingTop;
                  stageBottom = step.remainingBottom;
                });
                drawSegment(
                  stageStart,
                  gap.endTime,
                  stageTop,
                  stageBottom,
                  activeFill,
                  !gap.mitigated,
                );

                // Every confirmed partial wick adds a persistent grey strip
                // from that candle onward, producing the same stepped fill as
                // the TradingView box-array implementation.
                gap.mitigationSteps.forEach(step => {
                  drawSegment(
                    step.time,
                    gap.endTime,
                    step.filledTop,
                    step.filledBottom,
                    mitigatedFill,
                    !gap.mitigated,
                  );
                });

                if (fvgStyle.labelText && !gap.mitigated) {
                  const endX = xForTime(gap.endTime);
                  const topY = yForPrice(stageTop);
                  const bottomY = yForPrice(stageBottom);
                  if (endX !== null && topY !== null && bottomY !== null) {
                    const fontSize = fvgStyle.labelSize === 'tiny' ? 9 : fvgStyle.labelSize === 'medium' ? 13 : 11;
                    context.font = `500 ${fontSize}px ${chartStyle.fontFamily}`;
                    context.textAlign = 'right';
                    context.textBaseline = 'middle';
                    context.fillStyle = fvgStyle.labelColor;
                    context.fillText(fvgStyle.labelText, Math.min(mediaSize.width - 4, endX - 4), (topY + bottomY) / 2);
                  }
                }
              });
              context.restore();
            });
          },
        };
        const fvgPrimitive: ISeriesPrimitive<Time> = {
          attached: ({ requestUpdate }) => { fvgPrimitiveRequestUpdateRef.current = requestUpdate; },
          detached: () => { fvgPrimitiveRequestUpdateRef.current = null; },
          paneViews: () => [{
            zOrder: () => 'bottom',
            renderer: () => fvgRenderer,
          }],
        };
        series.attachPrimitive(fvgPrimitive);
        overlayArtifactsRef.current.primitives.push(fvgPrimitive);
      }
      const structureStyle = indicatorSettingsRef.current.structure;
      structureOverlayEventsRef.current.forEach(({ event }, index) => commitOnce({
          id: `auto-structure-${event.breakTime}-${index}`,
          tool: 'TrendLine',
          points: [{ time: event.pivotTime, price: event.price }, { time: event.breakTime, price: event.price }],
          style: {
            color: event.direction === 'bullish' ? structureStyle.bullishColor : structureStyle.bearishColor,
            width: structureStyle.lineWidth,
            dashed: false,
            fill: null,
          },
        }));

      // CandleKit does not currently provide a text drawing tool. Render the
      // market-structure caption as a tiny series primitive so it remains
      // anchored to the exact price and midpoint of its line while panning or
      // scaling, just like the TradingView indicator label.
      const structureLabelRenderer: IPrimitivePaneRenderer = {
        draw: target => {
          target.useMediaCoordinateSpace(({ context, mediaSize }) => {
            context.save();
            const currentStructureStyle = indicatorSettingsRef.current.structure;
            const structureFontSize = currentStructureStyle.textSize === 'tiny'
              ? 9 : currentStructureStyle.textSize === 'small' ? 10 : currentStructureStyle.textSize === 'large' ? 14 : 12;
            context.font = `600 ${structureFontSize}px ${chartStyle.fontFamily}`;
            context.textAlign = 'center';
            context.textBaseline = 'bottom';
            structureOverlayEventsRef.current.forEach(({ event, midpoint }) => {
              const x = chart.timeScale().timeToCoordinate(midpoint);
              const y = series.priceToCoordinate(event.price);
              if (x === null || y === null || x < 0 || x > mediaSize.width || y < 0 || y > mediaSize.height) return;
              if (currentStructureStyle.textBackground) {
                const width = context.measureText(event.type).width + 6;
                context.fillStyle = colorWithOpacity(currentStructureStyle.textBackgroundColor, 0.9);
                context.fillRect(x - width / 2, y - structureFontSize - 5, width, structureFontSize + 4);
              }
              context.fillStyle = event.direction === 'bullish'
                ? currentStructureStyle.bullishColor
                : currentStructureStyle.bearishColor;
              context.fillText(event.type, x, y - 2);
            });
            context.restore();
          });
        },
      };
      const structureLabelPrimitive: ISeriesPrimitive<Time> = {
        attached: ({ requestUpdate }) => { structurePrimitiveRequestUpdateRef.current = requestUpdate; },
        detached: () => { structurePrimitiveRequestUpdateRef.current = null; },
        paneViews: () => [{
          zOrder: () => 'top',
          renderer: () => structureLabelRenderer,
        }],
      };
      series.attachPrimitive(structureLabelPrimitive);
      overlayArtifactsRef.current.primitives.push(structureLabelPrimitive);

      protectedDrawingsUnsubscribeRef.current?.();
      protectedDrawingsUnsubscribeRef.current = protectGeneratedDrawings(engine);
      engine.select(null);
    }

    unsubscribeVisibleRangeSafely(rangeSubscriptionRef.current);
    const handleVisibleRangeChange = () => {
      if (expandingWindowRef.current) return;
      const logicalRange = chart.timeScale().getVisibleLogicalRange();
      if (!logicalRange) return;
      const nearLeftEdge = logicalRange.from < 80 && renderedCandleWindow.start > 0;
      const nearRightEdge = logicalRange.to > visibleCandles.length - 80 && renderedCandleWindow.end < candles.length;
      if (!nearLeftEdge && !nearRightEdge) return;
      const visibleRange = chart.timeScale().getVisibleRange();
      if (visibleRange) pendingVisibleRangeRef.current = visibleRange;
      expandingWindowRef.current = true;
      const chunk = (compactMode ? COMPACT_WINDOW_BARS : INITIAL_WINDOW_BARS)[timeframe].chunk;
      setCandleWindow(current => ({
        start: nearLeftEdge ? Math.max(0, current.start - chunk) : current.start,
        end: nearRightEdge ? Math.min(candles.length, current.end + chunk) : current.end,
      }));
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
    rangeSubscriptionRef.current = { chart, handler: handleVisibleRangeChange };

    window.setTimeout(() => {
      const pendingRange = pendingVisibleRangeRef.current;
      if (pendingRange) {
        chart.timeScale().setVisibleRange(pendingRange);
        pendingVisibleRangeRef.current = null;
      } else if (replayActive) {
        const transition = replayStartTransitionRef.current;
        replayStartTransitionRef.current = null;
        if (transition && visibleCandles.length > 0) {
          const newestLogicalIndex = visibleCandles.length - 1;
          const initialRange = {
            from: newestLogicalIndex - transition.logicalSpan * transition.cutRatio,
            to: newestLogicalIndex + transition.logicalSpan * (1 - transition.cutRatio),
          };
          const targetRange = {
            from: newestLogicalIndex + 6 - transition.logicalSpan,
            to: newestLogicalIndex + 6,
          };
          chart.timeScale().setVisibleLogicalRange(initialRange);
          replayViewportTargetRef.current = targetRange;

          const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
          if (reducedMotion) {
            chart.timeScale().setVisibleLogicalRange(targetRange);
            replayViewportTargetRef.current = null;
          } else {
            const durationMs = 220;
            let startedAt: number | null = null;
            chartRootRef.current?.setAttribute('data-replay-start-transition', 'animating');
            const animate = (now: number) => {
              if (startedAt === null) startedAt = now;
              const progress = Math.min(1, (now - startedAt) / durationMs);
              const eased = 1 - Math.pow(1 - progress, 3);
              chart.timeScale().setVisibleLogicalRange({
                from: initialRange.from + (targetRange.from - initialRange.from) * eased,
                to: initialRange.to + (targetRange.to - initialRange.to) * eased,
              });
              if (progress < 1) {
                replayStartAnimationFrameRef.current = window.requestAnimationFrame(animate);
              } else {
                replayStartAnimationFrameRef.current = null;
                replayViewportTargetRef.current = null;
                chartRootRef.current?.setAttribute('data-replay-start-transition', 'complete');
              }
            };
            replayStartAnimationFrameRef.current = window.requestAnimationFrame(animate);
          }
        } else {
          const replayBars = compactMode ? 90 : 130;
          chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, visibleCandles.length - replayBars),
            to: visibleCandles.length + 6,
          });
        }
      } else {
        focusTrade();
      }
      window.setTimeout(() => { expandingWindowRef.current = false; }, 50);
    }, 0);
  }, [candles.length, compactMode, displayedEntryFvg, entryFvg, entryMs, entryStructure, exitMs, focusTrade, fvgs, hideDrawingToolbar, onChartApiReady, renderedCandleWindow, replayActive, showEntryFvg, showEntryStructure, structureEvents, timeframe, trade, visibleCandles, visibleFvg, visibleLevels, visibleStructure, isDark]);

  useEffect(() => {
    if (previousOverlayRebuildRef.current === overlayRebuildSignature) return;
    previousOverlayRebuildRef.current = overlayRebuildSignature;
    const api = apiRef.current;
    if (!api) return;
    const currentRange = api.controller.getChart().timeScale().getVisibleRange();
    if (currentRange) pendingVisibleRangeRef.current = currentRange;
    handleReady(api);
    // Indicator visibility is refreshed imperatively so the expensive
    // CandleKit chart and its viewport never remount or flash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayRebuildSignature, showEntryFvg, showEntryStructure, visibleFvg, visibleLevels, visibleStructure]);

  useLayoutEffect(() => {
    fvgPrimitiveRequestUpdateRef.current?.();
  }, [fvgPaintSignature, renderedFvgs]);

  useLayoutEffect(() => {
    levelsPrimitiveRequestUpdateRef.current?.();
  }, [liquidityLevels, indicatorSettings.levels]);

  useLayoutEffect(() => {
    structurePrimitiveRequestUpdateRef.current?.();
    if (!replayActive || replayCursorTime === null) return;
    if (replayStructureSyncSignatureRef.current === replayStructureSyncSignature) return;
    replayStructureSyncSignatureRef.current = replayStructureSyncSignature;
    const engine = apiRef.current?.drawing?.engine;
    if (!engine) return;
    const style = indicatorSettingsRef.current.structure;
    const desired = structureOverlayEventsRef.current.map(({ event }, index) => ({
      id: `auto-structure-${event.breakTime}-${index}`,
      event,
      color: event.direction === 'bullish' ? style.bullishColor : style.bearishColor,
    }));
    const desiredIds = new Set(desired.map(item => item.id));
    const existing = new Map(engine.getDrawings()
      .filter(drawing => drawing.id.startsWith('auto-structure-'))
      .map(drawing => [drawing.id, drawing]));

    existing.forEach(drawing => {
      if (!desiredIds.has(drawing.id)) engine.remove(drawing.id);
    });
    desired.forEach(({ id, event, color }) => {
      const current = existing.get(id);
      const unchanged = current
        && current.points[0]?.time === event.pivotTime
        && current.points[0]?.price === event.price
        && current.points[1]?.time === event.breakTime
        && current.points[1]?.price === event.price
        && current.style.color === color
        && current.style.width === style.lineWidth;
      if (unchanged) return;
      if (current) engine.remove(id);
      engine.commit({
        id,
        tool: 'TrendLine',
        points: [{ time: event.pivotTime, price: event.price }, { time: event.breakTime, price: event.price }],
        style: {
          color,
          width: style.lineWidth,
          dashed: false,
          fill: null,
        },
      });
    });
  }, [replayActive, replayCursorTime, replayStructureSyncSignature]);

  useEffect(() => {
    if (!replayActive) return;
    const latest = visibleCandles.at(-1);
    if (!latest) return;
    const format = (value: number) => value.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    if (ohlcValuesRef.current) {
      ohlcValuesRef.current.textContent = `O ${format(latest.open)}  H ${format(latest.high)}  L ${format(latest.low)}  C ${format(latest.close)}`;
    }
    const previousClose = visibleCandles.at(-2)?.close;
    if (!ohlcChangeRef.current || !Number.isFinite(previousClose)) return;
    const change = latest.close - Number(previousClose);
    const percent = Number(previousClose) !== 0 ? change / Number(previousClose) * 100 : 0;
    const sign = change > 0 ? '+' : change < 0 ? '−' : '';
    ohlcChangeRef.current.textContent = `${sign}${format(Math.abs(change))} (${sign}${Math.abs(percent).toFixed(2)}%)`;
    ohlcChangeRef.current.style.color = change > 0
      ? chartStyle.bullishStructure
      : change < 0 ? chartStyle.bearishStructure : (isDark ? '#94a3b8' : '#64748b');
  }, [isDark, replayActive, replayCursorTime, visibleCandles]);

  const background = isDark ? '#090d12' : '#ffffff';
  const text = isDark ? '#8794a5' : '#64748b';
  const grid = 'transparent';

  return (
    <div
      ref={chartRootRef}
      className="absolute inset-0"
      data-visible-bars={visibleCandles.length}
      data-total-bars={candles.length}
      data-window-start={renderedCandleWindow.start}
      data-window-end={renderedCandleWindow.end}
      data-entry-fvg={entryFvg ? entryFvg.startTime : undefined}
      data-entry-structure={entryStructure ? `${entryStructure.type}:${entryStructure.breakTime}` : undefined}
      data-fvg-settings-signature={fvgPaintSignature}
      data-replay-fvg-count={replayActive ? renderedFvgs.regular.length : undefined}
      data-replay-structure-count={replayActive ? structureOverlayEvents.length : undefined}
      data-trade-box-locked="true"
      onContextMenu={openContextMenu}
      onWheelCapture={handlePriceScaleWheel}
      onDoubleClickCapture={event => {
        if (selectedFib || selectedDrawing) {
          const rect = event.currentTarget.getBoundingClientRect();
          const priceScale = apiRef.current?.controller.getChart().priceScale('right');
          if (!priceScale || event.clientX < rect.right - Math.max(64, priceScale.width())) {
            event.preventDefault();
            event.stopPropagation();
            if (selectedFib) setFibSettingsOpen(true);
            else setDrawingSettingsOpen(true);
            return;
          }
        }
        handlePriceScaleDoubleClick(event);
      }}
    >
      <ChartView
        key={replayActive
          ? `overlay-v2:${trade.id}:${timeframe}:replay`
          : `overlay-v2:${trade.id}:${timeframe}:${renderedCandleWindow.start}:${renderedCandleWindow.end}`}
        data={chartBars}
        theme={chartTheme}
        showVolume={false}
        autoFit={false}
        drawing={drawingOptions}
        indicators={indicatorController}
        measurement
        onReady={handleReady}
        chartOptions={{
          layout: {
            background: { type: ColorType.Solid, color: background },
            textColor: text,
            fontFamily: chartStyle.fontFamily,
          },
          grid: { vertLines: { color: grid }, horzLines: { color: grid } },
          rightPriceScale: { borderColor: grid, scaleMargins: { top: 0.08, bottom: 0.22 } },
          timeScale: {
            borderColor: grid,
            timeVisible: true,
            secondsVisible: false,
            rightOffset: 6,
            barSpacing: 8,
            minBarSpacing: 0.5,
            lockVisibleTimeRangeOnResize: true,
            tickMarkFormatter: (time: Time) => new Date(Number(time) * 1000).toLocaleTimeString('cs-CZ', {
              timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit',
            }),
          },
          localization: {
            locale: 'cs-CZ',
            timeFormatter: (time: Time) => new Date(Number(time) * 1000).toLocaleString('cs-CZ', {
              timeZone: 'Europe/Prague', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
            }),
            priceFormatter: formatNqMnqTickPrice,
          },
          handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
          handleScale: { axisPressedMouseMove: true, axisDoubleClickReset: true, mouseWheel: true, pinch: true },
          kineticScroll: { mouse: true, touch: true },
        }}
      >
        {!hideDrawingToolbar && <AlphaTradeDrawingToolbar
          isDark={isDark}
          indicatorCount={indicatorCount}
          onRemoveIndicators={removeIndicators}
        />}
        <MeasurementOverlay />
      </ChartView>
      {replaySelecting && (
        <div
          className="absolute inset-0 z-[70] cursor-crosshair"
          onPointerDown={handleReplaySelectionPointerDown}
          onPointerMove={handleReplaySelectionPointerMove}
          onPointerUp={finishReplaySelectionDrag}
          onPointerCancel={finishReplaySelectionDrag}
          onWheel={handleReplaySelectionWheel}
          onPointerLeave={handleReplaySelectionPointerLeave}
          onClick={commitReplaySelection}
          role="button"
          tabIndex={0}
          aria-label="Vyber počáteční svíčku Bar Replay"
          onKeyDown={event => {
            if ((event.key === 'Enter' || event.key === ' ') && replaySelectionPreview) {
              event.preventDefault();
              onReplayStart?.(replaySelectionPreview.time);
            }
          }}
        >
          {replaySelectionPreview && (
            <>
              <span
                className="pointer-events-none absolute inset-y-0"
                style={{
                  left: replaySelectionPreview.x,
                  width: Math.max(0, replaySelectionPreview.plotWidth - replaySelectionPreview.x),
                  background: isDark ? 'rgba(9, 13, 18, 0.76)' : 'rgba(255, 255, 255, 0.76)',
                }}
              />
              <span
                className="pointer-events-none absolute inset-y-0 w-px bg-[#2962ff]"
                style={{ left: replaySelectionPreview.x }}
              />
              {replaySelectionPreview.y !== null && (
                <span
                  className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2 text-slate-950 drop-shadow-[0_1px_0_rgba(255,255,255,0.9)]"
                  style={{ left: replaySelectionPreview.x, top: replaySelectionPreview.y }}
                >
                  <Scissors size={19} strokeWidth={2.4} />
                </span>
              )}
              <span
                className="pointer-events-none absolute bottom-7 -translate-x-1/2 rounded bg-[#2962ff] px-2 py-1 text-[10px] font-bold text-white shadow"
                style={{ left: replaySelectionPreview.x }}
              >
                {new Date(replaySelectionPreview.time * 1_000).toLocaleString('cs-CZ', {
                  timeZone: 'Europe/Prague',
                  day: '2-digit', month: '2-digit', year: '2-digit',
                  hour: '2-digit', minute: '2-digit',
                })}
              </span>
            </>
          )}
        </div>
      )}
      {!hideDrawingToolbar && selectedFib && <FibDrawingFloatingToolbar
        engine={selectedFib.engine}
        drawing={selectedFib.drawing}
        onOpenSettings={() => setFibSettingsOpen(true)}
      />}
      {!hideDrawingToolbar && selectedDrawing && <GenericDrawingFloatingToolbar
        engine={selectedDrawing.engine}
        drawing={selectedDrawing.drawing}
        isDark={isDark}
        onOpenSettings={() => setDrawingSettingsOpen(true)}
      />}
      <div className={`pointer-events-none absolute left-2 top-1.5 z-20 max-w-[calc(100%-72px)] whitespace-nowrap text-[10px] ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
        <div className="flex h-4 min-w-0 items-center gap-1.5" aria-label="Instrument a timeframe grafu">
          <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-cyan-500 text-[9px] font-bold text-white">
            {instrumentLegend.badge}
          </span>
          <span className="truncate font-semibold">{instrumentLegend.name}</span>
          <span className={`shrink-0 font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>· {instrumentLegend.timeframe}</span>
        </div>
        <div className={`flex h-4 items-center gap-2 font-medium ${isDark ? 'text-slate-300' : 'text-slate-600'}`} aria-label="OHLC označené svíčky">
          <span ref={ohlcValuesRef} />
          <span ref={ohlcChangeRef} />
        </div>
      </div>
      <ChartIndicatorLegend
        isDark={isDark}
        timeframe={timeframe}
        showFvg={showFvg}
        showLevels={showLevels}
        showStructure={showStructure}
        hiddenCustom={hiddenCustomIndicators}
        setCustomHidden={setCustomIndicatorHidden}
        onToggleFvg={onToggleFvg}
        onToggleLevels={onToggleLevels}
        onToggleStructure={onToggleStructure}
        controller={indicatorController}
        activeLibraryIndicators={activeLibraryIndicators}
        onEditCustom={id => {
          settingsBackupRef.current = structuredClone(indicatorSettings);
          setSettingsDialogIndicator(id);
        }}
        offsetForToolbar={!hideDrawingToolbar}
      />
      {!hideFocusButton && <button
        type="button"
        onClick={focusTrade}
        className={`absolute ${hideDrawingToolbar ? 'left-12' : 'left-24'} ${compactToolbar ? 'top-7' : 'top-9'} z-20 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border backdrop-blur-md text-[8px] font-black uppercase tracking-wider shadow-sm transition-colors ${isDark ? 'bg-black/65 border-white/10 text-slate-300 hover:text-white' : 'bg-white/85 border-slate-200 text-slate-600 hover:text-slate-900'}`}
        title="Vrátit graf na vstup obchodu"
      >
        <LocateFixed size={11} /> Obchod
      </button>}
      {settingsDialogIndicator && (
        <ChartIndicatorSettingsDialog
          indicator={settingsDialogIndicator}
          settings={indicatorSettings}
          onPreview={updateSharedIndicatorSettings}
          onCancel={() => {
            if (settingsBackupRef.current) updateSharedIndicatorSettings(settingsBackupRef.current);
            settingsBackupRef.current = null;
            setSettingsDialogIndicator(null);
          }}
          onApply={next => {
            updateSharedIndicatorSettings(next);
            try { window.localStorage.setItem(settingsStorageKey, JSON.stringify(next)); } catch { /* private storage */ }
            settingsBackupRef.current = null;
            setSettingsDialogIndicator(null);
          }}
        />
      )}
      {!hideDrawingToolbar && selectedFib && fibSettingsOpen && <FibDrawingSettingsDialog
        engine={selectedFib.engine}
        drawing={selectedFib.drawing}
        onClose={() => setFibSettingsOpen(false)}
      />}
      {!hideDrawingToolbar && selectedDrawing && drawingSettingsOpen && <GenericDrawingSettingsDialog
        key={selectedDrawing.drawing.id}
        engine={selectedDrawing.engine}
        drawing={selectedDrawing.drawing}
        onClose={() => setDrawingSettingsOpen(false)}
      />}
      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          role="menu"
          aria-label="Nabídka grafu"
          data-chart-context-menu
          data-chart-overlay-menu
          className={`fixed z-[10020] w-[230px] overflow-hidden rounded-md border py-1 text-[12px] shadow-[0_4px_16px_rgba(0,0,0,0.18)] ${isDark ? 'border-white/10 bg-[#1e222d] text-[#d1d4dc]' : 'border-[#d1d4dc] bg-white text-[#131722]'}`}
          style={{ left: contextMenu.left, top: contextMenu.top }}
          onPointerDown={event => event.stopPropagation()}
          onContextMenu={event => event.preventDefault()}
          onKeyDown={handleContextMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            aria-keyshortcuts="Alt+R"
            className={`group flex h-9 w-full items-center px-2 text-left outline-none transition-colors ${isDark ? 'hover:bg-[#2a2e39] focus-visible:bg-[#2a2e39]' : 'hover:bg-[#f0f3fa] focus-visible:bg-[#f0f3fa]'}`}
            onClick={() => {
              resetChartView(apiRef.current);
              setContextMenu(null);
            }}
          >
            <span className="mr-2 flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden="true">
              <RotateCcw size={15} strokeWidth={1.55} />
            </span>
            <span>Reset chart view</span>
            <kbd className="ml-auto text-[10px] font-normal text-[#787b86]">⌥ R</kbd>
          </button>
          <div className={`mx-2 h-px ${isDark ? 'bg-white/10' : 'bg-[#e0e3eb]'}`} />
          <button
            type="button"
            role="menuitem"
            disabled={indicatorCount === 0}
            className={`flex h-9 w-full items-center px-2 text-left outline-none transition-colors ${indicatorCount === 0 ? 'cursor-default opacity-40' : isDark ? 'hover:bg-[#2a2e39] focus-visible:bg-[#2a2e39]' : 'hover:bg-[#f0f3fa] focus-visible:bg-[#f0f3fa]'}`}
            onClick={removeIndicators}
          >
            <span className="mr-2 flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden="true">
              <ChartNoAxesCombined size={15} strokeWidth={1.55} />
            </span>
            Remove indicators ({indicatorCount})
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={contextMenu.drawingCount === 0}
            className={`flex h-9 w-full items-center px-2 text-left outline-none transition-colors ${contextMenu.drawingCount === 0 ? 'cursor-default opacity-40' : isDark ? 'hover:bg-[#2a2e39] focus-visible:bg-[#2a2e39]' : 'hover:bg-[#f0f3fa] focus-visible:bg-[#f0f3fa]'}`}
            onClick={removeDrawings}
          >
            <span className="mr-2 flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden="true">
              <Eraser size={15} strokeWidth={1.55} />
            </span>
            Remove drawings ({contextMenu.drawingCount})
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default CandleKitTradeChart;
