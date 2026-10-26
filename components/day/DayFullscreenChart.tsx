import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { Drawing, DrawingToolId } from '@getcandlekit/charts';
import { Check, ChevronDown, ClipboardCheck, Scissors, ChevronLeft, Redo2, MoreHorizontal, Settings, SlidersHorizontal, Expand, GripVertical, Lock, Shrink, Undo2, Magnet, Maximize2, Mic, Minimize2, Pause, PenLine, Play, SkipForward, StepBack, StepForward, Star, StickyNote, Trash2, Unlock, X } from 'lucide-react';
import type { Trade } from '../../types';
import CandleKitTradeChart, { ALPHATRADE_DRAWING_TOOLS } from '../CandleKitTradeChart';
import GenericDrawingSettingsDialog from '../GenericDrawingSettingsDialog';
import GenericDrawingFloatingToolbar from '../GenericDrawingFloatingToolbar';
import FibDrawingSettingsDialog, { FibDrawingFloatingToolbar } from '../FibDrawingSettingsDialog';
import PositionDrawingSettingsDialog, { PositionDrawingFloatingToolbar } from '../PositionDrawingSettingsDialog';
import { isPositionDrawing } from '../../services/chartPositionDrawing';
import { playNativeHapticIfAvailable } from '../../services/nativeCapabilities';
import type { FibDrawing } from '../../services/chartFibDrawing';
import { QuantumSpinner } from '../QuantumLoader';
import { aggregateCandles, MARKET_TIMEFRAME_MINUTES, type MarketCandle, type MarketTimeframe } from '../../services/marketData';
import { onTradeChartIndicatorsChange, readTradeChartIndicators, writeTradeChartIndicators } from '../../services/detailIndicators';
import { tradeChartTiming } from '../../services/tradeChartData';
import { getDrawingMagnetSettings, setDrawingMagnetSettings, subscribeDrawingMagnetSettings } from '../../services/chartDrawingMagnet';
import { setNativeShellTabBarHidden } from '../../utils/nativeShell';
import { installChartWorkspaceSync } from '../../services/chartWorkspaceSync';
import { ChartWorkspaceHistory, type ChartWorkspaceHistoryState } from '../../services/chartWorkspaceHistory';
import { SessionSwitchFx, scopeSwitchFxSub } from './DayPanels';
import { CHART_WORKSPACE_LAYOUT_ROWS, getChartWorkspaceLayout } from '../../services/chartWorkspaceLayouts';
import type { ReviewSlotElements } from '../AlphaTradeChartWorkspace';
import { ChartLayoutGlyph } from '../ChartLayoutPicker';
import { DAY_REPLAY_STEP_CHOICES, candlesUntil, dayReplayRange, readDayReplayPrefs, retreatDayReplay, writeDayReplayPrefs, type DayReplayStep } from '../../lib/dayReplay';
import { CHART_REPLAY_SPEEDS, advanceReplayTimeByInterval, chartReplayDelayMs, chartReplaySpeedDescription, replayViewportAfterBarsUpdate, type ChartReplaySpeed } from '../../services/chartReplay';
import { formingReplayBar, formingReplayBase } from '../../services/chartReplayForming';
import { REPLAY_CANDLE_MODE_OPTIONS, setReplayCandleMode, useReplayCandleMode } from '../../services/chartReplayCandleMode';
import { candleReplayPath, partialReplayCandle } from '../../lib/candleReplayPath';
import { historyAt } from '../../lib/tradeReplay';
import {
  DAY_CHART_TIMEFRAME_LABEL, DAY_DRAW_COLORS, cycleDayChartTimeframe, DAY_DRAW_TOOLS, DAY_PATH_TOOL, dayDrawStyle,
  pathGroupOf, pathSegmentIds, readDayDrawFavorites, readDayDrawPanel, toggleDayDrawFavorite, writeDayDrawFavorites, writeDayDrawPanel,
  effectiveDayChartLayout, readDayChartLayout, readDayChartSync, readDayPaneTimeframes, writeDayChartLayout, writeDayChartSync, writeDayPaneTimeframes,
  type DayChartLayout, type DayChartSync, type DayDrawColorId, type DayDrawPanel,
} from '../../lib/dayChartTools';
import ChartNotesLayer from '../ChartNotesLayer';
import { chartNotesOfTrades, type ChartNote } from '../../lib/chartNotes';
import DayNotesLayer, { type DayBand, type DayPinPoint, type DayPinView } from './DayNotesLayer';
import DayTouchDrawLayer from './DayTouchDrawLayer';
import { dayAnchorTrade, focusTarget, useReviewFocus } from './dayFocus';
import type { DayController } from './useDayController';
import { useLiveCandleBinding, type LiveCandleTarget } from '../../hooks/useLiveCandleBinding';

type DrawingEngine = NonNullable<ChartViewApi['drawing']>['engine'];
type MarketCandleLike = { time: number; open: number; high: number; low: number; close: number; volume: number };

const TOOL_BY_ID = new Map(ALPHATRADE_DRAWING_TOOLS.map(tool => [tool.id, tool]));
// Všechny nástroje pro oblíbené: virtuální Šipka (cesta) + nástroje motoru.
const ALL_TOOL_IDS: readonly string[] = [DAY_PATH_TOOL, ...ALPHATRADE_DRAWING_TOOLS.map(tool => tool.id)];
const toolIcon = (tool: string) => (tool === DAY_PATH_TOOL ? TOOL_BY_ID.get('Arrow')?.icon : TOOL_BY_ID.get(tool as DrawingToolId)?.icon);
// „Šipka“ je na telefonu cesta se zlomy; jednoduchá šipka motoru se jmenuje jinak, ať se neplete.
const toolTitle = (tool: string | null) => (tool === DAY_PATH_TOOL ? 'Šipka' : tool === 'Arrow' ? 'Rovná šipka' : tool ? DAY_DRAW_TOOLS.find(item => item.id === tool)?.label ?? TOOL_BY_ID.get(tool)?.title ?? tool : '');
const SCOPE_LABEL: Record<'day' | 'london' | 'ny', string> = { day: 'Celý den', london: 'London', ny: 'New York' };

/**
 * Graf dne přes celou obrazovku telefonu (docs/DAY_CHART_PHONE_FULLSCREEN.md,
 * schválený návrh telefonního grafu): časové rámce jako čipy nahoře, plovoucí
 * tužka otevře spodní list nástrojů (oblíbené + všechny, magnet, zámek,
 * smazání), výběr nástroje list zavře a kreslí se crosshairem jako touchpad.
 * Hotové kresby jde kdykoli ťuknutím vybrat, přesunout, přebarvit a smazat.
 * Kresby patří do vrstvy kreseb dne (`day:<den>`, scope `day`).
 * Jen zobrazení a poznámky — nic odsud nesahá na copier.
 */
/** Zdroj grafu mimo deník dne (detail obchodu, Hodnotit…): svíčky, obchody, kresby. */
export interface PhoneChartSource {
  /** Identita grafu (klíče, záběr), např. `trade:123`. */
  key: string;
  /** 1m svíčky. */
  candles: MarketCandle[];
  loading?: boolean;
  error?: string | null;
  /** Obchody v grafu (kontext). */
  trades: Trade[];
  /** Obchod, na který se graf zaměří. */
  anchor: Trade;
  drawingKeyId: string;
  drawingScope: string;
  /** Upravitelné poznámky v grafu (detail obchodu). */
  chartNotes?: readonly ChartNote[];
  onChartNotesChange?: (notes: ChartNote[]) => void;
  /**
   * Review týdne: místa pro panely (pruh nahoře, pás obchodů dole, hodnocení
   * ve výsuvném listu) — review do nich kreslí přes portál jako na PC.
   */
  onSlotsReady?: (slots: ReviewSlotElements | null) => void;
  /** Kurzor přehrávání (unix s) pro review, null mimo přehrávání. */
  onReplayCursor?: (cursorTime: number | null) => void;
}

export default function DayFullscreenChart({ ctl, source, isDark, timeframe, onTimeframe, range, focusKeyPrefix, selectedTrade, pins = [], bubbles = 'selected', placing = null, onPick = () => {}, onCancelPlacing = () => {}, pending = null, nowTime = null, bands = [], onClose, onVoice = () => {} }: {
  /** Deník dne: poznámky, seance, mikrofon. Bez něj je to obecný telefonní graf (`source`). */
  ctl?: DayController;
  source?: PhoneChartSource;
  isDark: boolean;
  timeframe: MarketTimeframe;
  onTimeframe: (timeframe: MarketTimeframe) => void;
  range: { from: number; to: number };
  focusKeyPrefix: string;
  selectedTrade: Trade | null;
  pins?: DayPinView[];
  bubbles?: 'all' | 'selected';
  placing?: 'note' | 'voice' | null;
  onPick?: (point: DayPinPoint) => void;
  onCancelPlacing?: () => void;
  pending?: DayPinPoint | null;
  nowTime?: number | null;
  bands?: DayBand[];
  onClose: () => void;
  /** Poznámka hlasem: přepne umisťování (`placing: 'voice'`). */
  onVoice?: () => void;
}) {
  // Jednotný zdroj: deník dne z controlleru, jinde ze `source`.
  const src = {
    key: ctl ? ctl.day : source!.key,
    candles: ctl ? ctl.chart.candles : source!.candles,
    loading: ctl ? ctl.chart.loading : Boolean(source!.loading),
    error: ctl ? ctl.chart.error : source!.error ?? null,
    trades: ctl ? ctl.chart.chartTrades : source!.trades,
    drawingKeyId: ctl ? `day:${ctl.day}` : source!.drawingKeyId,
    drawingScope: ctl ? 'day' : source!.drawingScope,
  };
  // Místa pro panely review (jen se `source.onSlotsReady`).
  const slotHeaderRef = useRef<HTMLDivElement>(null);
  const slotBottomRef = useRef<HTMLDivElement>(null);
  const slotSideRef = useRef<HTMLDivElement>(null);
  const slotLeftRef = useRef<HTMLDivElement>(null);
  const slotOverlayRef = useRef<HTMLDivElement>(null);
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false);
  const onSlotsReady = source?.onSlotsReady;
  useEffect(() => {
    if (!onSlotsReady) return;
    const header = slotHeaderRef.current, bottom = slotBottomRef.current, side = slotSideRef.current, left = slotLeftRef.current, overlay = slotOverlayRef.current;
    if (header && bottom && side && left && overlay) onSlotsReady({ header, bottom, side, left, overlay });
    return () => onSlotsReady(null);
  }, [onSlotsReady]);
  const [indicators, setIndicators] = useState(readTradeChartIndicators);
  useEffect(() => onTradeChartIndicatorsChange(setIndicators), []);
  const [api, setApi] = useState<ChartViewApi | null>(null);
  const [chromeHidden, setChromeHidden] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<DrawingToolId | null>(null);
  const [selected, setSelected] = useState<Drawing | null>(null);
  const [, setDrawingRev] = useState(0);
  const [manualCount, setManualCount] = useState(0);
  // Zpět bere jen kresby z tohohle otevření grafu — nikdy starší kresby (třeba z Macu).
  const createdRef = useRef<string[]>([]);
  const [locked, setLocked] = useState(false);
  // null = barvy z předvoleb kreslení (jako na Macu), dokud si v listu nevybereš.
  const [colorId, setColorId] = useState<DayDrawColorId | null>(null);
  const colorRef = useRef(colorId);
  colorRef.current = colorId;
  const [magnet, setMagnet] = useState(getDrawingMagnetSettings);
  useEffect(() => subscribeDrawingMagnetSettings(setMagnet), []);
  // Oblíbené nástroje (hvězdička v listu) a plovoucí panel s nimi nad grafem.
  const [favorites, setFavorites] = useState(() => readDayDrawFavorites(window.localStorage, ALL_TOOL_IDS));
  const [editFavorites, setEditFavorites] = useState(false);
  const toggleFavorite = (tool: string) => setFavorites(current => {
    const next = toggleDayDrawFavorite(current, tool);
    writeDayDrawFavorites(window.localStorage, next);
    return next;
  });
  const [panel, setPanel] = useState(() => readDayDrawPanel(window.localStorage));
  const savePanel = (next: DayDrawPanel) => { setPanel(next); writeDayDrawPanel(window.localStorage, next); };
  const chartAreaRef = useRef<HTMLDivElement>(null);
  const panelDragRef = useRef<{ startX: number; startY: number; x: number; y: number; spanX: number; spanY: number } | null>(null);
  // Vodorovná lišta (jako TradingView): úchyt vlevo + nástroje vedle sebe.
  const PANEL_ITEM = 42;
  const panelWidth = 28 + favorites.length * PANEL_ITEM + 4;
  const PANEL_HEIGHT = 48;
  const [textEdit, setTextEdit] = useState<{ id: string; text: string; fresh: boolean } | null>(null);
  // Plné nastavení kresby (stejné dialogy jako na PC, včetně šablon) přes celou obrazovku.
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Rozvržení oken jako na PC/TV (1–4 grafy, šablony z chartWorkspaceLayouts).
  // „Podle otočení“: na výšku 1 graf, na šířku 2 vedle sebe (schválený návrh).
  const [landscape, setLandscape] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(orientation: landscape) and (min-width: 560px)').matches === true);
  useEffect(() => {
    const media = window.matchMedia?.('(orientation: landscape) and (min-width: 560px)');
    if (!media) return;
    const update = () => setLandscape(media.matches);
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  const [layout, setLayoutState] = useState<DayChartLayout>(() => readDayChartLayout(window.localStorage));
  const template = getChartWorkspaceLayout(effectiveDayChartLayout(layout, landscape));
  const paneCount = template.panelCount;
  const split = paneCount > 1;
  const [activePane, setActivePane] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const [layoutSheet, setLayoutSheet] = useState(false);
  // Menu ⋯ (jako „Analysis hub“ v TradingView): rozvržení, indikátory, nastavení grafu, přehrávání.
  const [hubOpen, setHubOpen] = useState(false);
  const [chartReq, setChartReq] = useState<{ pane: number; n: number } | null>(null);
  const [indicatorReq, setIndicatorReq] = useState<{ pane: number; id: 'fvg' | 'levels' | 'structure'; n: number } | null>(null);
  const setLayout = (next: DayChartLayout) => { setLayoutState(next); writeDayChartLayout(window.localStorage, next); setMaximized(false); };
  const [sync, setSyncState] = useState<DayChartSync>(() => readDayChartSync(window.localStorage));
  const setSync = (next: DayChartSync) => { setSyncState(next); writeDayChartSync(window.localStorage, next); };
  // Okno 1 má rámec sdílený s malým grafem (`timeframe`), okna 2–4 vlastní.
  const [paneTimeframes, setPaneTimeframesState] = useState<MarketTimeframe[]>(() => readDayPaneTimeframes(window.localStorage));
  const setPaneTimeframes = (next: MarketTimeframe[]) => { setPaneTimeframesState(next); writeDayPaneTimeframes(window.localStorage, next); };
  const paneTimeframe = (index: number): MarketTimeframe => (index === 0 ? timeframe : paneTimeframes[index - 1] ?? '5m');
  const setPaneTimeframe = (index: number, next: MarketTimeframe) => {
    // „Interval“ v synchronizaci: rámec se mění ve všech oknech.
    if (sync.interval) { onTimeframe(next); setPaneTimeframes(paneTimeframes.map(() => next)); return; }
    if (index === 0) onTimeframe(next);
    else setPaneTimeframes(paneTimeframes.map((item, itemIndex) => (itemIndex === index - 1 ? next : item)));
  };
  const [extraApis, setExtraApis] = useState<(ChartViewApi | null)[]>([null, null, null]);
  const extraApiSetters = useMemo(() => [0, 1, 2].map(slot => (next: ChartViewApi | null) => setExtraApis(current => {
    if (current[slot] === next) return current;
    const copy = current.slice(); copy[slot] = next; return copy;
  })), []);
  const pane2Ref = useRef<HTMLDivElement>(null);
  const pane3Ref = useRef<HTMLDivElement>(null);
  const pane4Ref = useRef<HTMLDivElement>(null);
  const paneRefs = [containerRef, pane2Ref, pane3Ref, pane4Ref];
  const paneApi = (index: number) => (index === 0 ? api : extraApis[index - 1] ?? null);
  // Přepnutí timeframe (i živě během točení kolečka): nový graf se krátce vynoří.
  const paneTfKey = paneTimeframes.join(',');
  const firstTimeframeRef = useRef(true);
  const [tfSwap, setTfSwap] = useState(0);
  // Přepnutí Den / London / NY: záblesk s nápisem přes graf (jako malý graf a PC).
  const [scopeFx, setScopeFx] = useState<{ key: number; session: DayController['scope']; sub: string } | null>(null);
  const pickScope = (next: DayController['scope']) => {
    if (!ctl) return;
    ctl.setScope(next);
    setScopeFx({ key: Date.now(), session: next, sub: scopeSwitchFxSub(ctl, next) });
  };
  useEffect(() => {
    if (!scopeFx) return;
    const timer = window.setTimeout(() => setScopeFx(null), 1000);
    return () => window.clearTimeout(timer);
  }, [scopeFx]);
  useEffect(() => {
    if (firstTimeframeRef.current) { firstTimeframeRef.current = false; return; }
    for (const ref of [containerRef, pane2Ref, pane3Ref, pane4Ref]) {
      ref.current?.animate?.(
        [{ opacity: 0, transform: 'scale(0.965)', filter: 'blur(8px)' }, { opacity: 1, transform: 'none', filter: 'none' }],
        { duration: 460, easing: 'cubic-bezier(.16,1,.3,1)' },
      );
    }
    setTfSwap(key => key + 1);
  }, [timeframe, paneTfKey]);
  // Méně oken: když zmizí okno, na které ses díval, okno 1 převezme jeho rámec.
  useEffect(() => {
    if (activePane < paneCount) return;
    const viewed = paneTimeframes[activePane - 1];
    setActivePane(0);
    if (viewed && viewed !== timeframe) onTimeframe(viewed);
  }, [activePane, paneCount, paneTimeframes, timeframe, onTimeframe]);
  useEffect(() => { if (!split) setMaximized(false); }, [split]);

  // Nativní lišta pryč po dobu celé obrazovky; stránka pod vrstvou neroluje.
  useEffect(() => {
    void setNativeShellTabBarHidden(true);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
      void setNativeShellTabBarHidden(false);
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !textEdit) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, textEdit]);

  // ── Svíčky a záběr (stejné jako kompaktní graf) ───────────────────────
  const fullRaw = src.candles;
  // ── Přehrávání (lišta dole, schválený návrh): kurzor nad 1m svíčkami dne ──
  // ── Bar Replay jako na PC (services/chartReplay): nůžky → start, rychlost
  // (kroky za sekundu), interval kroku, plynulé/celé svíčky, krok zpět/vpřed.
  const [replayPhase, setReplayPhase] = useState<'off' | 'selecting' | 'active'>('off');
  const [replayCursor, setReplayCursor] = useState<number | null>(null);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayPrefs, setReplayPrefsState] = useState(() => readDayReplayPrefs(window.localStorage, CHART_REPLAY_SPEEDS));
  const replaySpeed = replayPrefs.speed as ChartReplaySpeed;
  const replayStep = replayPrefs.step;
  const setReplayPrefs = (next: { speed: number; step: DayReplayStep }) => { setReplayPrefsState(next); writeDayReplayPrefs(window.localStorage, next); };
  const [replaySheet, setReplaySheet] = useState<'speed' | 'step' | 'candles' | null>(null);
  const [replaySelectionTime, setReplaySelectionTime] = useState<number | null>(null);
  const replayCandleMode = useReplayCandleMode(isDark);
  const replayOn = replayPhase === 'active';
  const replayRange = useMemo(() => dayReplayRange(fullRaw.map(candle => candle.time), Math.floor(range.from / 1000)), [fullRaw, range.from]);
  const replayAtEnd = replayRange != null && replayCursor != null && replayCursor >= replayRange.end;
  const startReplay = () => {
    if (!replayRange) return;
    setReplayPhase('selecting'); setReplayPlaying(false); setReplaySelectionTime(null);
  };
  const beginReplayAt = (time: number) => {
    if (!replayRange) return;
    const start = Math.min(replayRange.end, Math.max(fullRaw[0]?.time ?? time, time));
    setReplayCursor(start);
    setReplayPhase('active'); setReplayPlaying(false); setReplaySelectionTime(null);
    setCutFx({ key: Date.now(), time: start, pane: split ? activePane : 0 });
    playNativeHapticIfAvailable('medium');
  };
  // Po ukončení se graf jednou přestaví (záběr zpět na celý den); při startu ne —
  // CandleKit pak plynule dojede záběrem na střih (jako PC).
  const [replayExitKey, setReplayExitKey] = useState(0);
  const [cutFx, setCutFx] = useState<{ key: number; time: number; pane: number } | null>(null);
  useEffect(() => {
    if (!cutFx) return;
    const timer = window.setTimeout(() => setCutFx(null), 700);
    return () => window.clearTimeout(timer);
  }, [cutFx]);
  const stopReplay = () => { setReplayExitKey(key => key + 1); setReplayPhase('off'); setReplayCursor(null); setReplayPlaying(false); setReplaySheet(null); setReplaySelectionTime(null); };
  const stepReplay = (direction: 1 | -1) => {
    if (replayCursor == null || !replayRange) return;
    setReplayPlaying(false);
    if (direction > 0) setReplayCursor(advanceReplayTimeByInterval(fullRaw, replayCursor, replayStep) ?? replayRange.end);
    else setReplayCursor(retreatDayReplay(fullRaw, replayCursor, replayStep, fullRaw[0]?.time ?? replayRange.start));
  };
  useEffect(() => {
    if (!replayOn || !replayPlaying) return;
    const timer = window.setInterval(() => {
      setReplayCursor(current => {
        const next = advanceReplayTimeByInterval(fullRaw, current, replayStep);
        if (next == null) { setReplayPlaying(false); return current; }
        return next;
      });
    }, chartReplayDelayMs(replaySpeed));
    return () => window.clearInterval(timer);
  }, [fullRaw, replayOn, replayPlaying, replaySpeed, replayStep]);
  useEffect(() => { if (replayAtEnd) setReplayPlaying(false); }, [replayAtEnd]);
  const onReplayCursor = source?.onReplayCursor;
  useEffect(() => { onReplayCursor?.(replayOn ? replayCursor : null); }, [onReplayCursor, replayCursor, replayOn]);
  const raw = useMemo(() => (replayOn ? candlesUntil(fullRaw, replayCursor) : fullRaw), [fullRaw, replayCursor, replayOn]);
  const candles = useMemo(() => aggregateCandles(raw, timeframe), [raw, timeframe]);
  const barTimes = useMemo(() => candles.map(candle => candle.time), [candles]);
  const extraCandles = useMemo(
    () => [1, 2, 3].map(index => (index < paneCount ? aggregateCandles(raw, paneTimeframes[index - 1] ?? '5m') : [])),
    [paneCount, raw, paneTimeframes],
  );
  const paneCandles = (index: number) => (index === 0 ? candles : extraCandles[index - 1] ?? []);
  const extraBarTimes = useMemo(() => extraCandles.map(list => list.map(candle => candle.time)), [extraCandles]);
  // Živá poslední svíčka jen v deníku dne a mimo přehrávání (jen překreslení v grafu).
  const liveCandleTargets: LiveCandleTarget[] = Array.from({ length: paneCount }, (_, index) => ({
    api: paneApi(index), root: 'MNQ', timeframe: paneTimeframe(index), rawCandles: raw,
  }));
  useLiveCandleBinding(ctl && !replayOn ? ctl.chart.liveFeed : null, liveCandleTargets);
  // Kurzor / čas / rozsah mezi okny podle „Synchronizace“ (jako workspace na Macu).
  useEffect(() => {
    if (!split || (!sync.crosshair && !sync.time && !sync.dateRange)) return;
    const entries: [string, { chartApi: ChartViewApi; candles: typeof candles }][] = [];
    if (api) entries.push(['p0', { chartApi: api, candles }]);
    extraApis.forEach((paneChart, slot) => {
      if (paneChart && slot + 1 < paneCount) entries.push([`p${slot + 1}`, { chartApi: paneChart, candles: extraCandles[slot] }]);
    });
    if (entries.length < 2) return;
    return installChartWorkspaceSync(entries, { crosshair: sync.crosshair, time: sync.time, dateRange: sync.dateRange });
  }, [api, candles, extraApis, extraCandles, paneCount, split, sync.crosshair, sync.dateRange, sync.time]);
  const tradeNotes = useMemo(() => source?.chartNotes ?? chartNotesOfTrades(src.trades), [source?.chartNotes, src.trades]);
  // V přehrávání jen obchody do kurzoru (budoucnost se neukazuje, jako review na PC).
  const replayCutoffMs = replayOn && replayCursor != null ? (replayCursor + 60) * 1000 - 1 : null;
  const replayContextTrades = useMemo(() => (replayCutoffMs == null ? src.trades : src.trades
    .filter(trade => (trade.entryTime ?? Infinity) <= replayCutoffMs)
    .map(trade => (trade.executionHistory ? { ...trade, executionHistory: historyAt(trade.executionHistory, replayCutoffMs) } : trade))),
  [src.trades, replayCutoffMs]);
  const target = focusTarget(range);
  const anchorRef = useRef<{ day: string; trade: Trade } | null>(null);
  if (!anchorRef.current || anchorRef.current.day !== src.key) anchorRef.current = { day: src.key, trade: ctl ? dayAnchorTrade(ctl.day, target) : source!.anchor };
  const anchor = anchorRef.current.trade;
  const chartTrade = selectedTrade ?? anchor;
  const replayChartTrade = useMemo(() => (replayCutoffMs != null && chartTrade.executionHistory
    ? { ...chartTrade, executionHistory: historyAt(chartTrade.executionHistory, replayCutoffMs) }
    : chartTrade), [chartTrade, replayCutoffMs]);
  /**
   * Plynulé svíčky (nastavení „Svíčky v přehrávání“ = Plynule), jako PC:
   * mezi kroky se další 1m svíčka rodí po cestě open → high/low → close přímo
   * v grafu (mimo React); kurzor pak svíčku převezme. Jen krok 1m.
   */
  const replayCursorRef = useRef(replayCursor);
  replayCursorRef.current = replayCursor;
  useEffect(() => {
    if (!replayOn || !replayPlaying || replayStep !== 1 || replayCandleMode !== 'smooth') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const delay = chartReplayDelayMs(replaySpeed);
    if (delay < 150) return;
    const fills = src.trades.flatMap(trade => trade.executionHistory?.fills ?? []);
    let frame = 0;
    let stepStartedAt = performance.now();
    let lastCursor = replayCursorRef.current;
    let path: { candle: MarketCandleLike; points: ReturnType<typeof candleReplayPath> } | null = null;
    const bases = new Map<number, { cursor: number; base: MarketCandleLike | null }>();
    const appended = new Set<number>();
    const tick = (now: number) => {
      const cursor = replayCursorRef.current;
      if (cursor !== lastCursor) { lastCursor = cursor; stepStartedAt = now; path = null; appended.clear(); }
      if (cursor == null) { frame = window.requestAnimationFrame(tick); return; }
      if (!path) {
        const next = fullRaw.find(candle => candle.time > cursor);
        path = next ? { candle: next, points: candleReplayPath(next, fills.filter(fill => fill.at >= next.time * 1000 && fill.at < next.time * 1000 + 60_000)) } : null;
      }
      if (path) {
        const progress = Math.min(0.98, (now - stepStartedAt) / delay);
        const tick025 = (price: number) => Math.round(price * 4) / 4;
        const partialRaw = partialReplayCandle(path.candle, path.points, progress);
        const partial = { ...partialRaw, high: tick025(partialRaw.high), low: tick025(partialRaw.low), close: tick025(partialRaw.close) };
        for (let index = 0; index < paneCount; index += 1) {
          const chartApi = paneApi(index);
          if (!chartApi) continue;
          const paneTf = paneTimeframe(index);
          let bar: MarketCandleLike = partial;
          if (paneTf !== '1m') {
            let cached = bases.get(index);
            if (!cached || cached.cursor !== cursor) { cached = { cursor, base: formingReplayBase(fullRaw, cursor, paneTf) }; bases.set(index, cached); }
            bar = formingReplayBar(cached.base, partial, paneTf);
          }
          try {
            const controller = chartApi.controller;
            const lastTs = controller.getBars().at(-1)?.ts;
            if (lastTs !== undefined && lastTs > bar.time * 1000) continue;
            const isNewBar = lastTs === undefined || lastTs < bar.time * 1000;
            const timeScale = controller.getChart().timeScale();
            const rangeBefore = isNewBar ? timeScale.getVisibleLogicalRange() : null;
            const countBefore = controller.getBars().length;
            controller.updateBar({ ts: bar.time * 1000, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
            if (isNewBar && rangeBefore && !appended.has(index)) timeScale.setVisibleLogicalRange(replayViewportAfterBarsUpdate(rangeBefore, countBefore, countBefore + 1));
            appended.add(index);
          } catch { /* graf se právě přestavuje */ }
        }
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- panely čte z aktuálního renderu
  }, [replayOn, replayPlaying, replayStep, replayCandleMode, replaySpeed, fullRaw, paneCount, api, extraApis, paneTfKey, timeframe]);
  const timing = selectedTrade ? tradeChartTiming(selectedTrade) : { entryMs: anchor.entryTime!, exitMs: anchor.timestamp };
  const focusKey = selectedTrade ? `trade:${selectedTrade.id}` : `${focusKeyPrefix}:${Math.round(target.entryMs / 60_000)}:${Math.round(target.exitMs / 60_000)}`;
  const detail = selectedTrade ? { ...tradeChartTiming(selectedTrade), id: String(selectedTrade.id) } : { entryMs: target.entryMs, exitMs: target.exitMs, id: String(anchor.id) };
  useReviewFocus(focusKey, { entryMs: detail.entryMs, exitMs: detail.exitMs, id: detail.id }, Boolean(api), `${src.key}:${timeframe}:full`);

  // ── Kreslení: stav motoru (aktivní nástroj, výběr, počet kreseb) ──────
  const activeApi = split ? paneApi(activePane) : api;
  const engine: DrawingEngine | null = activeApi?.drawing?.engine ?? null;
  // Zpět / Vpřed pro kresby (přidání, přesun, přebarvení, smazání) — stejná historie jako na PC.
  const [history] = useState(() => new ChartWorkspaceHistory());
  const [historyState, setHistoryState] = useState<ChartWorkspaceHistoryState>({ canUndo: false, canRedo: false });
  useEffect(() => history.subscribe(setHistoryState), [history]);
  useEffect(() => {
    history.updatePanels(new Map(engine ? [['day', { drawingEngine: engine, chartApi: null }]] : []));
  }, [engine, history]);
  useEffect(() => {
    if (!engine) return;
    const known = new Set(engine.getDrawings().map(item => item.id));
    const sync = () => {
      // Nová ruční kresba (mimo cestu, ta má barvu sama) dostane barvu zvolenou v listu.
      for (const item of engine.getDrawings()) {
        if (known.has(item.id)) continue;
        known.add(item.id);
        if (!item.id.startsWith('auto-')) createdRef.current.push(item.id);
        if (colorRef.current && !item.id.startsWith('auto-') && !pathGroupOf(item.id)) engine.setStyle(item.id, dayDrawStyle(colorRef.current, item.tool));
      }
      setActiveTool(engine.getActiveTool());
      // Motor mění kresbu na místě: bez nové revize by lišta ukazovala starou tloušťku/průhlednost.
      setDrawingRev(rev => rev + 1);
      const id = engine.getSelectedId();
      // Cesta: změna vzhledu jednoho úseku (lišta, šablona) platí pro celou cestu.
      const group = pathGroupOf(id);
      const source = id && group ? engine.getById(id)?.style : undefined;
      if (group && source) {
        for (const other of pathSegmentIds(engine.getDrawings(), group)) {
          const style = engine.getById(other)?.style;
          if (other === id || !style) continue;
          if (style.color !== source.color || style.width !== source.width || style.lineStyle !== source.lineStyle || style.dashed !== source.dashed) {
            engine.setStyle(other, { color: source.color, width: source.width, lineStyle: source.lineStyle, dashed: source.dashed });
          }
        }
      }
      setSelected(id ? engine.getById(id) ?? null : null);
      setManualCount(engine.getDrawings().filter(item => !item.id.startsWith('auto-')).length);
      createdRef.current = createdRef.current.filter(id => engine.getById(id));
      setLocked(engine.isLocked());
    };
    sync();
    return engine.onChange(sync);
  }, [engine]);
  // Nově položený Text bez obsahu: hned pole pro text (dialog grafu obchodu je tu skrytý).
  useEffect(() => {
    if (selected?.tool === 'Text' && !selected.style.text?.trim() && !textEdit) setTextEdit({ id: selected.id, text: '', fresh: true });
  }, [selected, textEdit]);
  // Cesta (Šipka) je virtuální nástroj: vede ji dotyková vrstva, motor
  // dostává jen hotové úseky. Chip svítí přes `pathActive`.
  const [pathActive, setPathActive] = useState(false);
  const toolDone = useCallback(() => setPathActive(false), []);
  const pathStyle = useMemo(() => ({ color: dayDrawStyle(colorId ?? 'neutral', 'Arrow').color, width: 2 }), [colorId]);
  const startTool = useCallback((tool: DrawingToolId) => {
    if (!engine) return;
    onCancelPlacing();
    setToolsOpen(false);
    engine.select(null);
    if (engine.isLocked()) engine.setLocked(false);
    if (tool === DAY_PATH_TOOL) {
      engine.stopTool();
      setPathActive(true);
      return;
    }
    setPathActive(false);
    engine.startTool(tool);
  }, [engine, onCancelPlacing]);
  const cancelTool = () => {
    setPathActive(false);
    engine?.cancelDraft();
    engine?.stopTool();
  };
  const selectedGroup = pathGroupOf(selected?.id);
  const selectedIds = () => (engine && selected ? (selectedGroup ? pathSegmentIds(engine.getDrawings(), selectedGroup) : [selected.id]) : []);
  // Cesta = víc úseků: po nastavení jednoho dostanou stejný vzhled i ostatní.
  const closeSettings = () => {
    const id = settingsFor;
    setSettingsFor(null);
    const group = pathGroupOf(id);
    if (!engine || !id || !group) return;
    const source = engine.getById(id)?.style;
    if (!source) return;
    for (const other of pathSegmentIds(engine.getDrawings(), group)) {
      if (other === id) continue;
      engine.setStyle(other, { color: source.color, width: source.width, lineStyle: source.lineStyle, dashed: source.dashed });
    }
  };
  const openSettingsFor = useCallback((id: string) => { if (!id.startsWith('auto-')) setSettingsFor(id); }, []);
  const settingsDrawing = settingsFor && engine ? engine.getById(settingsFor) ?? null : null;
  const removeSelected = () => {
    if (!engine) return;
    for (const drawingId of selectedIds()) engine.remove(drawingId);
  };
  const removeAll = () => {
    if (!engine || !manualCount) return;
    if (!window.confirm(`Smazat všechny kresby tohohle dne (${manualCount})?`)) return;
    for (const drawing of engine.getDrawings().filter(item => !item.id.startsWith('auto-'))) engine.remove(drawing.id);
    setToolsOpen(false);
  };
  const saveText = () => {
    if (!engine || !textEdit) return;
    const text = textEdit.text.trim();
    if (text) engine.setStyle(textEdit.id, { text });
    else if (textEdit.fresh) engine.remove(textEdit.id);
    setTextEdit(null);
  };
  const cancelText = () => {
    if (engine && textEdit?.fresh) engine.remove(textEdit.id);
    setTextEdit(null);
  };
  const toggleIndicator = (id: 'fvg' | 'levels' | 'structure') => writeTradeChartIndicators({ ...indicators, [id]: !indicators[id] });
  const drawingNow = pathActive || Boolean(activeTool);
  const toolName = pathActive ? DAY_PATH_TOOL : activeTool;

  const bar: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px calc(6px + env(safe-area-inset-bottom, 0px))', borderTop: '1px solid var(--dj-line)', background: 'var(--dj-card)', flex: 'none', minHeight: 52 };

  return createPortal(
    <div ref={rootRef} className="dj" role="dialog" aria-label="Graf dne na celou obrazovku" style={{ position: 'fixed', inset: 0, zIndex: 880, display: 'flex', flexDirection: 'column', background: 'var(--dj-bg)', color: 'var(--dj-text)', paddingTop: chromeHidden ? 0 : 'env(safe-area-inset-top, 0px)', paddingLeft: 'env(safe-area-inset-left, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)', animation: 'dj-fade .18s ease both' }}>
      {onSlotsReady && <div ref={slotHeaderRef} data-phone-review-slot="header" style={{ flex: 'none', display: chromeHidden ? 'none' : undefined }} />}
      <div ref={chartAreaRef} style={{ position: 'relative', flex: 1, minHeight: 0, background: isDark ? '#05080f' : '#fff' }}>
      {onSlotsReady && <div ref={slotOverlayRef} style={{ position: 'absolute', inset: 0, zIndex: 26, pointerEvents: 'none' }} />}
      {template.cells.map(cell => {
        const index = cell.panel - 1;
        const ref = paneRefs[index];
        const paneTf = paneTimeframe(index);
        const list = paneCandles(index);
        const times = index === 0 ? barTimes : extraBarTimes[index - 1] ?? [];
        const isActive = index === activePane;
        const visible = !maximized || isActive;
        // Okno v mřížce (procenta šablony); roztažené okno přes celou plochu.
        const box: React.CSSProperties = maximized && isActive
          ? { left: 0, top: 0, width: '100%', height: '100%' }
          : { left: `${cell.x * 100}%`, top: `${cell.y * 100}%`, width: `${cell.width * 100}%`, height: `${cell.height * 100}%` };
        return (
          <div
            key={cell.panel}
            ref={ref}
            onPointerDownCapture={() => { if (split && !isActive) { engine?.stopTool(); setPathActive(false); setActivePane(index); } }}
            style={{
              position: 'absolute', ...box, display: visible ? undefined : 'none', boxSizing: 'border-box',
              borderLeft: split && !maximized && cell.x > 0 ? '1px solid var(--dj-line)' : undefined,
              borderTop: split && !maximized && cell.y > 0 ? '1px solid var(--dj-line)' : undefined,
              boxShadow: split && !maximized && isActive ? 'inset 0 0 0 1.5px rgba(99,102,241,0.55)' : undefined,
            }}
          >
            {list.length ? (
              <CandleKitTradeChart
                key={`${src.key}:${paneTf}:full${index}:${replayExitKey}`}
                trade={replayChartTrade}
                candles={list}
                rawCandles={raw}
                timeframe={paneTf}
                entryMs={timing.entryMs}
                exitMs={timing.exitMs}
                showFvg={indicators.fvg}
                showLevels={indicators.levels}
                showStructure={indicators.structure}
                isDark={isDark}
                compactMode
                phoneLayout
                compactToolbar
                hideDrawingToolbar
                hideFocusButton
                reviewMode
                contextTrades={replayContextTrades}
                drawingKeyId={src.drawingKeyId}
                drawingScope={src.drawingScope}
                drawingHitTolerance={14}
                replayActive={replayOn}
                replayCursorTime={replayOn ? replayCursor : null}
                replaySelecting={replayPhase === 'selecting'}
                replaySelectionCandles={fullRaw}
                replaySelectionTime={replaySelectionTime}
                onReplaySelectionTimeChange={setReplaySelectionTime}
                onReplayStart={beginReplayAt}
                journalHistoryInReplay
                onChartApiReady={index === 0 ? setApi : extraApiSetters[index - 1]}
                chartSettingsRequest={chartReq && chartReq.pane === index ? chartReq.n : 0}
                indicatorSettingsRequest={indicatorReq && indicatorReq.pane === index ? { id: indicatorReq.id, n: indicatorReq.n } : null}
                onToggleFvg={() => toggleIndicator('fvg')}
                onToggleLevels={() => toggleIndicator('levels')}
                onToggleStructure={() => toggleIndicator('structure')}
              />
            ) : index === 0 ? (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 16, textAlign: 'center' }}>
                {src.loading ? <QuantumSpinner /> : <p style={{ margin: 0, fontSize: 12, color: 'var(--dj-text-2)' }}>{src.error ?? (ctl ? 'Svíčky pro tenhle den zatím nejsou.' : 'Svíčky zatím nejsou.')}</p>}
              </div>
            ) : null}
            {/* Poznámky k obchodům dne (detail obchodu, Review) — jen pro čtení, v hlavním okně. */}
            {index === 0 && (tradeNotes.length > 0 || source?.onChartNotesChange) && (
              <ChartNotesLayer
                chartApi={api}
                containerRef={containerRef}
                notes={tradeNotes}
                barTimes={barTimes}
                replayCursor={replayOn ? replayCursor : null}
                editable={Boolean(source?.onChartNotesChange)}
                isDark={isDark}
                addRequest={null}
                onChange={source?.onChartNotesChange ?? (() => {})}
              />
            )}
            {ctl && (
              <DayNotesLayer
                chartApi={paneApi(index)}
                containerRef={ref}
                barTimes={times}
                intervalSeconds={MARKET_TIMEFRAME_MINUTES[paneTf] * 60}
                pins={pins}
                selectedId={ctl.selected?.kind === 'note' ? ctl.selected.id : null}
                onSelect={id => ctl.setSelected(id ? { kind: 'note', id } : null)}
                bubbles={bubbles}
                placing={!split || isActive ? placing : null}
                placingHint="Ťukni, kam to patří"
                onPick={onPick}
                onCancelPlacing={onCancelPlacing}
                pending={pending}
                nowTime={nowTime}
                bands={bands}
                ticks={ctl.mindTicks}
              />
            )}
            {tfSwap > 0 && <TimeframeSwapFx key={tfSwap} />}
            {cutFx && <ReplayCutFx key={cutFx.key} chartApi={paneApi(index)} time={cutFx.time} />}
            {/* Dotyky na kresby: výběr, přesun, úprava bodů vždy; s nástrojem v ruce crosshair. */}
            <DayTouchDrawLayer chartApi={paneApi(index)} containerRef={ref} enabled={!placing && !textEdit && replayPhase !== 'selecting' && (!split || isActive)} pathActive={pathActive} pathStyle={pathStyle} onPathEnd={toolDone} onDrawingDoubleTap={openSettingsFor} />
          </div>
        );
      })}

        {scopeFx && <SessionSwitchFx key={scopeFx.key} session={scopeFx.session} sub={scopeFx.sub} />}
        {/* Nástroj v ruce: co se kreslí, jak to skončí, zrušit. */}
        {drawingNow && (
          <div style={{ ...floatingBar, gap: 8, padding: '6px 6px 6px 12px', borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-card)', boxShadow: '0 12px 30px -12px rgba(0,0,0,0.6)', whiteSpace: 'nowrap', animation: 'dj-rise .18s ease both' }}>
            <span style={{ fontSize: 12.5, fontWeight: 800 }}>{toolTitle(toolName)}</span>
            <span style={{ fontSize: 11.5, color: 'var(--dj-muted)' }}>{pathActive ? 'ťuk = bod · dvojklep = konec' : 'tah posune · ťuk = bod'}</span>
            <button type="button" className="dj-btn" aria-label="Zrušit nástroj" onClick={cancelTool} style={{ ...iconButton, width: 32, height: 32 }}><X size={16} /></button>
          </div>
        )}
        {/* Vybraná kresba: stejné plovoucí lišty jako na PC (posun za úchyt, šablony, barvy,
            ⚙ nastavení, koš); dvojklep na kresbu otevře nastavení. */}
        {!drawingNow && selected && engine && !textEdit && !settingsFor && (
          <div data-touch-toolbar style={{ display: 'contents' }}>
            {selected.tool === 'FibRetracement'
              ? <FibDrawingFloatingToolbar key={selected.id} engine={engine} drawing={selected as FibDrawing} isDark={isDark} onOpenSettings={() => setSettingsFor(selected.id)} />
              : isPositionDrawing(selected)
                ? <PositionDrawingFloatingToolbar key={selected.id} engine={engine} drawing={selected} isDark={isDark} onClose={() => {}} onOpenSettings={() => setSettingsFor(selected.id)} />
                : <GenericDrawingFloatingToolbar key={selected.id} engine={engine} drawing={selected} isDark={isDark} onOpenSettings={() => setSettingsFor(selected.id)} onRemove={removeSelected} />}
          </div>
        )}
        {/* Plovoucí panel oblíbených (jako na PC): klepnutí vezme nástroj, za úchyt jde posunout. */}
        {panel.on && favorites.length > 0 && !chromeHidden && !toolsOpen && !textEdit && (
          <div role="toolbar" aria-label="Oblíbené nástroje" style={{ position: 'absolute', left: `calc((100% - ${panelWidth}px) * ${panel.x})`, top: `calc((100% - ${PANEL_HEIGHT}px) * ${panel.y})`, zIndex: 24, height: PANEL_HEIGHT, padding: '0 2px 0 0', boxSizing: 'border-box', borderRadius: 14, border: '1px solid var(--dj-line)', background: 'var(--dj-card)', boxShadow: '0 12px 30px -14px rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', touchAction: 'none' }}>
            <span
              aria-label="Posunout panel"
              onPointerDown={event => {
                const area = chartAreaRef.current;
                panelDragRef.current = { startX: event.clientX, startY: event.clientY, x: panel.x, y: panel.y, spanX: Math.max(1, (area?.clientWidth ?? 0) - panelWidth), spanY: Math.max(1, (area?.clientHeight ?? 0) - PANEL_HEIGHT) };
                event.currentTarget.setPointerCapture(event.pointerId);
                event.stopPropagation();
              }}
              onPointerMove={event => {
                const drag = panelDragRef.current;
                if (!drag) return;
                const clamp = (value: number) => Math.min(1, Math.max(0, value));
                setPanel(current => ({ ...current, x: clamp(drag.x + (event.clientX - drag.startX) / drag.spanX), y: clamp(drag.y + (event.clientY - drag.startY) / drag.spanY) }));
              }}
              onPointerUp={() => { if (panelDragRef.current) { panelDragRef.current = null; writeDayDrawPanel(window.localStorage, panel); } }}
              onPointerCancel={() => { panelDragRef.current = null; }}
              style={{ width: 28, height: '100%', display: 'grid', placeItems: 'center', color: 'var(--dj-muted)', cursor: 'grab', touchAction: 'none' }}
            ><GripVertical size={16} /></span>
            {favorites.map(tool => {
              const Icon = toolIcon(tool);
              const on = toolName === tool;
              return (
                <button key={tool} type="button" className="dj-btn" aria-label={toolTitle(tool)} aria-pressed={on} onClick={() => (on ? cancelTool() : startTool(tool as DrawingToolId))} style={{ width: 40, height: 40, marginLeft: 2, borderRadius: 10, border: 0, padding: 0, display: 'grid', placeItems: 'center', cursor: 'pointer', color: on ? '#fff' : 'var(--dj-text)', background: on ? 'linear-gradient(180deg,#6366f1,#4f46e5)' : 'transparent' }}>
                  {Icon ? <Icon size={20} /> : <span style={{ fontSize: 10, fontWeight: 700 }}>{toolTitle(tool).slice(0, 3)}</span>}
                </button>
              );
            })}
          </div>
        )}
        {chromeHidden && (
          <button type="button" className="dj-btn" aria-label="Zobrazit ovládání" onClick={() => setChromeHidden(false)} style={{ position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 8px)', right: 10, zIndex: 25, ...iconButton, background: 'var(--dj-card)', border: '1px solid var(--dj-line)', opacity: 0.85 }}><Minimize2 size={16} /></button>
        )}
      </div>

      {onSlotsReady && <div ref={slotBottomRef} data-phone-review-slot="bottom" style={{ flex: 'none', display: chromeHidden ? 'none' : undefined }} />}
      {onSlotsReady && <div ref={slotLeftRef} hidden />}
      {!chromeHidden && replayPhase === 'selecting' && (
        // Nůžky: vybírá se svíčka, od které přehrávání začne (jako PC/TV).
        <div role="toolbar" aria-label="Výběr startu přehrávání" style={{ ...bar, gap: 8, padding: '6px 10px', animation: 'dj-rise .2s ease both' }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--dj-indigo-bg-soft)', color: 'var(--dj-indigo-text)', flex: 'none' }}><Scissors size={17} /></span>
          <p style={{ margin: 0, flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, lineHeight: 1.3, color: 'var(--dj-text-2)' }}>{replaySelectionTime != null ? 'Posuň nůžky prstem, pak potvrď' : 'Ťukni nebo táhni po grafu na svíčku, od které přehrávat'}</p>
          {replaySelectionTime != null
            ? <button type="button" className="dj-btn" onClick={() => beginReplayAt(replaySelectionTime)} style={{ ...chip, height: 34, padding: '0 12px', fontWeight: 800, flex: 'none', color: '#fff', border: 0, background: 'linear-gradient(180deg,#6366f1,#4f46e5)' }}>Začít {new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit' }).format(replaySelectionTime * 1000)}</button>
            : replayRange && <button type="button" className="dj-btn" onClick={() => beginReplayAt(replayRange.start)} style={{ ...chip, height: 34, padding: '0 10px', fontWeight: 800, flex: 'none' }}>Od začátku</button>}
          <button type="button" className="dj-btn" aria-label="Zrušit přehrávání" onClick={stopReplay} style={{ ...iconButton, border: '1px solid var(--dj-line)' }}><X size={17} /></button>
        </div>
      )}
      {!chromeHidden && replayOn && replayRange && (
        <div role="toolbar" aria-label="Přehrávání" style={{ ...bar, gap: 0, padding: 4, minHeight: 48, animation: 'dj-rise .2s ease both' }}>
          <div className="dj-scroll" style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 2, overflowX: 'auto', scrollbarWidth: 'none' }}>
            <button type="button" className="dj-btn" aria-label="Vybrat nový start" onClick={startReplay} style={iconButton}><Scissors size={18} /></button>
            <span style={divider} />
            <button type="button" className="dj-btn" aria-label="Krok zpět" onClick={() => stepReplay(-1)} style={iconButton}><StepBack size={18} /></button>
            <button type="button" className="dj-btn" aria-label={replayPlaying ? 'Pozastavit' : 'Přehrát'} disabled={replayAtEnd} onClick={() => setReplayPlaying(playing => !playing)} style={{ ...iconButton, width: 46, height: 40, borderRadius: 12, color: '#fff', background: 'linear-gradient(180deg,#6366f1,#4f46e5)', opacity: replayAtEnd ? 0.4 : 1 }}>{replayPlaying ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button>
            <button type="button" className="dj-btn" aria-label="Krok vpřed" disabled={replayAtEnd} onClick={() => stepReplay(1)} style={{ ...iconButton, opacity: replayAtEnd ? 0.35 : 1 }}><StepForward size={18} /></button>
            <span style={divider} />
            <button type="button" className="dj-btn" aria-label={`Rychlost ${replaySpeed}x`} onClick={() => setReplaySheet('speed')} style={{ ...chip, height: 34, minWidth: 44, justifyContent: 'center', fontWeight: 800, flex: 'none' }}>{replaySpeed}x</button>
            <button type="button" className="dj-btn" aria-label={`Interval kroku ${replayStep} min`} onClick={() => setReplaySheet('step')} style={{ ...chip, height: 34, minWidth: 44, justifyContent: 'center', fontWeight: 800, flex: 'none', marginLeft: 4 }}>{DAY_REPLAY_STEP_LABEL[replayStep]}</button>
            <button type="button" className="dj-btn" aria-label="Svíčky v přehrávání" onClick={() => setReplaySheet('candles')} style={{ ...chip, height: 34, fontWeight: 700, flex: 'none', marginLeft: 4 }}>{REPLAY_CANDLE_MODE_OPTIONS.find(option => option.value === replayCandleMode)?.label ?? 'Plynule'}</button>
            <span className="dj-mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--dj-text-2)', minWidth: 42, textAlign: 'center', flex: 'none' }}>{replayCursor != null ? new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit' }).format(replayCursor * 1000) : ''}</span>
            <button type="button" className="dj-btn" aria-label="Skočit na konec" disabled={replayAtEnd} onClick={() => { setReplayPlaying(false); setReplayCursor(replayRange.end); }} style={{ ...iconButton, opacity: replayAtEnd ? 0.35 : 1 }}><SkipForward size={18} /></button>
          </div>
          <span style={{ ...divider, margin: '0 4px' }} />
          <button type="button" className="dj-btn" aria-label="Ukončit přehrávání" onClick={stopReplay} style={{ ...iconButton, border: '1px solid var(--dj-line)' }}><X size={17} /></button>
        </div>
      )}
      {replaySheet && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 40 }}>
          <div onClick={() => setReplaySheet(null)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', animation: 'dj-fade .18s ease both' }} />
          <section aria-label="Volby přehrávání" className="dj-scroll" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '80%', overflowY: 'auto', borderRadius: '20px 20px 0 0', background: 'var(--dj-card)', borderTop: '1px solid var(--dj-line)', padding: '8px 14px calc(14px + env(safe-area-inset-bottom, 0px))', animation: 'dj-sheet .24s cubic-bezier(.2,.9,.25,1) both' }}>
            <span style={{ display: 'block', width: 38, height: 5, borderRadius: 9, background: 'var(--dj-line)', margin: '0 auto 10px' }} />
            <p style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 800, textAlign: 'center' }}>{replaySheet === 'speed' ? 'Rychlost přehrávání' : replaySheet === 'step' ? 'Interval kroku' : 'Svíčky v přehrávání'}</p>
            {(replaySheet === 'speed'
              ? CHART_REPLAY_SPEEDS.map(speed => ({ key: String(speed), label: `${speed}x`, detail: chartReplaySpeedDescription(speed), on: replaySpeed === speed, pick: () => setReplayPrefs({ ...replayPrefs, speed }) }))
              : replaySheet === 'step'
                ? DAY_REPLAY_STEP_CHOICES.map(step => ({ key: String(step), label: DAY_REPLAY_STEP_LABEL[step], detail: step === 1 ? 'po minutách' : `jeden krok = ${DAY_REPLAY_STEP_LABEL[step]}`, on: replayStep === step, pick: () => setReplayPrefs({ ...replayPrefs, step }) }))
                : REPLAY_CANDLE_MODE_OPTIONS.map(option => ({ key: option.value, label: option.label, detail: option.description, on: replayCandleMode === option.value, pick: () => setReplayCandleMode(option.value, isDark) }))
            ).map(row => (
              <button key={row.key} type="button" className="dj-btn" aria-pressed={row.on} onClick={() => { row.pick(); setReplaySheet(null); }} style={{ width: '100%', minHeight: 48, display: 'flex', alignItems: 'center', gap: 12, padding: '6px 10px', border: 0, borderRadius: 12, background: row.on ? 'var(--dj-indigo-bg-soft)' : 'transparent', color: 'var(--dj-text)', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ width: 18, display: 'grid', placeItems: 'center', color: 'var(--dj-indigo-text)' }}>{row.on && <Check size={17} />}</span>
                <span style={{ fontSize: 15, fontWeight: 800, minWidth: 56 }}>{row.label}</span>
                <span style={{ fontSize: 12.5, color: 'var(--dj-muted)' }}>{row.detail}</span>
              </button>
            ))}
            {replaySheet === 'candles' && <p style={{ margin: '6px 10px 0', fontSize: 12, color: 'var(--dj-muted)' }}>Plynule platí pro krok 1m a pomalejší rychlosti; stejné nastavení jako na PC.</p>}
          </section>
        </div>
      )}
      {!chromeHidden && (
        // Jedna spodní lišta jako v TradingView: posouvá se do strany, zavřít je vždy vpravo.
        <div style={{ ...bar, gap: 0, padding: '4px 4px calc(4px + env(safe-area-inset-bottom, 0px)) 4px' }}>
          {/* Kolečko rámce je vlevo vždy vidět (jako zavřít vpravo); posouvá se jen střed lišty. */}
          <TimeframeWheel key={split ? `pane${activePane}` : 'pane0'} value={paneTimeframe(split ? activePane : 0)} onChange={item => setPaneTimeframe(split ? activePane : 0, item)} />
          <span style={{ ...divider, margin: '0 4px 0 0' }} />
          <div className="dj-scroll" style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 2, overflowX: 'auto', scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
            {ctl && (<>
            {/* Rozsah dne jako jeden čip (Den → LDN → NY). */}
            <button type="button" className="dj-btn" aria-label={`Rozsah: ${SCOPE_LABEL[ctl.scope]}, další`} onClick={() => pickScope(ctl.scope === 'day' ? 'london' : ctl.scope === 'london' ? 'ny' : 'day')} style={{ ...chip, height: 34, padding: '0 10px', gap: 6, fontWeight: 800, flex: 'none', margin: '0 2px' }}>
              <span style={{ width: 8, height: 8, borderRadius: 9, background: ctl.scope === 'london' ? '#3b82f6' : ctl.scope === 'ny' ? '#f97316' : '#94a3b8' }} />{SCOPE_LABEL[ctl.scope]}
            </button>
            </>)}
            <span style={divider} />
            <button type="button" className="dj-btn" aria-label="Nástroje kreslení" aria-pressed={drawingNow} onClick={() => (drawingNow ? cancelTool() : setToolsOpen(true))} style={{ ...iconButton, ...(drawingNow ? { color: '#fff', background: 'linear-gradient(180deg,#6366f1,#4f46e5)' } : {}) }}>{drawingNow ? <X size={18} /> : <PenLine size={18} />}</button>
            <button type="button" className="dj-btn" aria-label={historyState.undoLabel ? `Zpět: ${historyState.undoLabel}` : 'Zpět'} disabled={!historyState.canUndo || drawingNow} onClick={() => history.undo()} style={{ ...iconButton, opacity: historyState.canUndo && !drawingNow ? 1 : 0.35 }}><Undo2 size={18} /></button>
            <button type="button" className="dj-btn" aria-label={historyState.redoLabel ? `Vpřed: ${historyState.redoLabel}` : 'Vpřed'} disabled={!historyState.canRedo || drawingNow} onClick={() => history.redo()} style={{ ...iconButton, opacity: historyState.canRedo && !drawingNow ? 1 : 0.35 }}><Redo2 size={18} /></button>
            <span style={divider} />
            {split && (
              <button type="button" className="dj-btn" aria-label={maximized ? 'Zpět na obě okna' : 'Označené okno přes celou plochu'} aria-pressed={maximized} onClick={() => setMaximized(on => !on)} style={{ ...iconButton, ...(maximized ? { color: 'var(--dj-indigo-text)', background: 'var(--dj-indigo-bg-soft)' } : {}) }}>{maximized ? <Shrink size={18} /> : <Expand size={18} />}</button>
            )}
            <span style={divider} />
{ctl && (<>
            <button type="button" className="dj-btn" aria-label="Poznámka do grafu" aria-pressed={placing === 'note'} onClick={() => { cancelTool(); ctl?.setPendingPoint(null); ctl?.setPlacing(placing === 'note' ? null : 'note'); }} style={{ ...iconButton, ...(placing === 'note' ? { color: '#1c1203', background: '#fbbf24' } : {}) }}><StickyNote size={18} /></button>
            <button type="button" className="dj-btn" aria-label="Poznámka hlasem" aria-pressed={placing === 'voice'} onClick={() => { cancelTool(); onVoice(); }} style={{ ...iconButton, ...(placing === 'voice' ? { color: '#fff', background: '#f43f5e' } : {}) }}><Mic size={18} /></button>
            </>)}
            <button type="button" className="dj-btn" aria-label="Další volby grafu" aria-expanded={hubOpen} onClick={() => { cancelTool(); setHubOpen(true); }} style={{ ...iconButton, ...(hubOpen ? { color: 'var(--dj-indigo-text)', background: 'var(--dj-indigo-bg-soft)' } : {}) }}><MoreHorizontal size={19} /></button>
            <button type="button" className="dj-btn" aria-label="Skrýt ovládání" onClick={() => setChromeHidden(true)} style={iconButton}><Maximize2 size={17} /></button>
          </div>
          <span style={{ ...divider, margin: '0 4px' }} />
          {onSlotsReady && (
            <button type="button" className="dj-btn" aria-label="Hodnocení obchodu" aria-expanded={reviewPanelOpen} onClick={() => { cancelTool(); setReviewPanelOpen(open => !open); }} style={{ ...chip, height: 38, padding: '0 10px', gap: 6, fontWeight: 800, flex: 'none', marginRight: 4, ...(reviewPanelOpen ? { color: '#fff', border: 0, background: 'linear-gradient(180deg,#10b981,#059669)' } : {}) }}><ClipboardCheck size={16} />Hodnotit</button>
          )}
          <button type="button" className="dj-btn" aria-label="Zavřít" onClick={onClose} style={{ ...iconButton, border: '1px solid var(--dj-line)' }}><X size={18} /></button>
        </div>
      )}
      {onSlotsReady && (
        // Hodnocení obchodu (panel review) jako výsuvný list; místo zůstává v DOM i zavřené.
        <div style={{ position: 'absolute', inset: 0, zIndex: 38, pointerEvents: reviewPanelOpen ? 'auto' : 'none', visibility: reviewPanelOpen ? 'visible' : 'hidden' }}>
          <div onClick={() => setReviewPanelOpen(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)', opacity: reviewPanelOpen ? 1 : 0, transition: 'opacity .2s' }} />
          <section aria-label="Hodnocení obchodu" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '72%', display: 'flex', flexDirection: 'column', borderRadius: '20px 20px 0 0', overflow: 'hidden', background: 'var(--dj-card)', borderTop: '1px solid var(--dj-line)', paddingBottom: 'env(safe-area-inset-bottom, 0px)', transform: reviewPanelOpen ? 'none' : 'translateY(100%)', transition: 'transform .28s cubic-bezier(.2,.9,.25,1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '8px 10px 4px' }}>
              <span style={{ flex: 1 }} />
              <span style={{ width: 38, height: 5, borderRadius: 9, background: 'var(--dj-line)' }} />
              <span style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
                <button type="button" className="dj-btn" aria-label="Zavřít hodnocení" onClick={() => setReviewPanelOpen(false)} style={{ ...iconButton, width: 32, height: 32, borderRadius: 99, background: 'var(--dj-chip)' }}><X size={16} /></button>
              </span>
            </div>
            <div ref={slotSideRef} data-phone-review-slot="side" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }} />
          </section>
        </div>
      )}
      {hubOpen && (
        <AnalysisHub
          layoutCells={template.cells}
          magnetMode={magnet.mode}
          onMagnet={mode => setDrawingMagnetSettings(mode === 'off' ? { mode } : { mode, lastEnabledMode: mode })}
          locked={locked}
          onLock={() => engine?.setLocked(!locked)}
          indicators={indicators}
          canReplay={Boolean(replayRange)}
          onToggleIndicator={toggleIndicator}
          onIndicatorSettings={id => { setHubOpen(false); setIndicatorReq({ pane: split ? activePane : 0, id, n: Date.now() }); }}
          onLayout={() => { setHubOpen(false); setLayoutSheet(true); }}
          onChartSettings={() => { setHubOpen(false); setChartReq({ pane: split ? activePane : 0, n: Date.now() }); }}
          onReplay={() => { setHubOpen(false); startReplay(); }}
          onClose={() => setHubOpen(false)}
        />
      )}
      {layoutSheet && <LayoutSheet layout={layout} activeId={template.id} sync={sync} onSync={setSync} onPick={next => { setLayout(next); setLayoutSheet(false); }} onClose={() => setLayoutSheet(false)} />}

      {/* Spodní list nástrojů: oblíbené nahoře, pak všechny, dole magnet/zámek/smazání. */}
      {toolsOpen && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 40 }}>
          <div onClick={() => setToolsOpen(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', animation: 'dj-fade .18s ease both' }} />
          <section aria-label="Nástroje kreslení" className="dj-scroll" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '78%', overflowY: 'auto', overscrollBehavior: 'contain', borderRadius: '20px 20px 0 0', borderTop: '1px solid var(--dj-line)', background: 'var(--dj-card)', padding: '8px 14px calc(14px + env(safe-area-inset-bottom, 0px))', animation: 'dj-sheet .26s cubic-bezier(.2,.9,.25,1) both' }}>
            <span style={{ display: 'block', width: 38, height: 5, borderRadius: 9, background: 'var(--dj-line)', margin: '0 auto 12px' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <p style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>Kreslení</p>
              <span style={{ flex: 1 }} />
              <div role="radiogroup" aria-label="Barva nových kreseb" style={{ display: 'flex', gap: 6 }}>
                {DAY_DRAW_COLORS.map(item => (
                  <button key={item.id} type="button" role="radio" aria-checked={colorId === item.id} aria-label={item.label} className="dj-btn" onClick={() => setColorId(current => (current === item.id ? null : item.id))} style={{ width: 26, height: 26, borderRadius: 99, padding: 0, cursor: 'pointer', background: item.color, border: colorId === item.id ? '2px solid var(--dj-text)' : '2px solid transparent' }} />
                ))}
              </div>
              <button type="button" className="dj-btn" aria-label="Zavřít nástroje" onClick={() => setToolsOpen(false)} style={{ ...iconButton, width: 34, height: 34 }}><X size={17} /></button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
              <p style={{ ...sheetLabel, margin: 0, flex: 1 }}>Oblíbené</p>
              <button type="button" className="dj-btn" aria-pressed={editFavorites} onClick={() => setEditFavorites(on => !on)} style={{ ...miniToggle, ...(editFavorites ? { color: 'var(--dj-amber-text)', borderColor: 'rgba(245,158,11,0.45)', background: 'var(--dj-amber-bg-soft)' } : {}) }}>{editFavorites ? 'Hotovo' : 'Upravit'}</button>
            </div>
            {favorites.length === 0 ? (
              <p style={{ margin: '0 0 14px', fontSize: 12.5, color: 'var(--dj-muted)' }}>Žádné oblíbené. Klepni na Upravit a přidej je hvězdičkou.</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginBottom: 14 }}>
                {favorites.map(tool => {
                  const Icon = toolIcon(tool);
                  return (
                    <button key={tool} type="button" className="dj-btn" onClick={() => (editFavorites ? toggleFavorite(tool) : startTool(tool as DrawingToolId))} style={{ ...toolTile, position: 'relative' }}>
                      {Icon && <Icon size={24} />}
                      <span style={{ fontSize: 11.5, fontWeight: 700, lineHeight: 1.15, textAlign: 'center' }}>{toolTitle(tool)}</span>
                      {editFavorites && <Star size={14} fill="#f59e0b" color="#f59e0b" style={{ position: 'absolute', top: 5, right: 5 }} />}
                    </button>
                  );
                })}
              </div>
            )}
            <p style={sheetLabel}>{editFavorites ? 'Hvězdičkou přidáš do oblíbených' : 'Všechny nástroje'}</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginBottom: 14 }}>
              {ALL_TOOL_IDS.map(tool => {
                const Icon = toolIcon(tool);
                const favorite = favorites.includes(tool);
                return (
                  <button key={tool} type="button" className="dj-btn" aria-pressed={editFavorites ? favorite : undefined} onClick={() => (editFavorites ? toggleFavorite(tool) : startTool(tool as DrawingToolId))} style={{ ...toolTile, position: 'relative' }}>
                    {Icon && <Icon size={22} />}
                    <span style={{ fontSize: 10.5, fontWeight: 600, lineHeight: 1.15, textAlign: 'center' }}>{toolTitle(tool)}</span>
                    {editFavorites && <Star size={14} fill={favorite ? '#f59e0b' : 'none'} color={favorite ? '#f59e0b' : 'var(--dj-muted)'} style={{ position: 'absolute', top: 5, right: 5 }} />}
                  </button>
                );
              })}
            </div>
            <button type="button" role="switch" aria-checked={panel.on} className="dj-btn" onClick={() => savePanel({ ...panel, on: !panel.on })} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 2px', marginBottom: 10, border: 0, borderTop: '1px solid var(--dj-line)', background: 'transparent', color: 'var(--dj-text)', font: '700 14px Inter, sans-serif', cursor: 'pointer', textAlign: 'left' }}>
              <Star size={18} color="var(--dj-muted)" />
              <span style={{ flex: 1 }}>Zobrazit oblíbené na grafu</span>
              <span aria-hidden="true" style={{ width: 46, height: 28, borderRadius: 99, padding: 3, boxSizing: 'border-box', background: panel.on ? 'linear-gradient(180deg,#6366f1,#4f46e5)' : 'var(--dj-chip)', border: '1px solid var(--dj-line)', display: 'flex', justifyContent: panel.on ? 'flex-end' : 'flex-start', transition: 'background .2s' }}>
                <span style={{ width: 20, height: 20, borderRadius: 99, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
              </span>
            </button>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
              <button type="button" className="dj-btn" aria-pressed={magnet.mode !== 'off'} onClick={() => { const next = magnet.mode === 'off' ? 'weak' : magnet.mode === 'weak' ? 'strong' : 'off'; setDrawingMagnetSettings(next === 'off' ? { mode: next } : { mode: next, lastEnabledMode: next }); }} style={{ ...sheetAction, ...(magnet.mode !== 'off' ? { color: 'var(--dj-indigo-text)', borderColor: 'rgba(99,102,241,0.45)', background: 'var(--dj-indigo-bg-soft)' } : {}) }}><Magnet size={16} />Magnet {MAGNET_LABEL[magnet.mode]}</button>
              <button type="button" className="dj-btn" aria-pressed={locked} onClick={() => engine?.setLocked(!locked)} style={{ ...sheetAction, ...(locked ? { color: 'var(--dj-amber-text)', borderColor: 'rgba(245,158,11,0.45)', background: 'var(--dj-amber-bg-soft)' } : {}) }}>{locked ? <Lock size={16} /> : <Unlock size={16} />}{locked ? 'Zamčeno' : 'Zamknout'}</button>
              <button type="button" className="dj-btn" disabled={!manualCount} onClick={removeAll} style={{ ...sheetAction, color: 'var(--dj-rose)', opacity: manualCount ? 1 : 0.4 }}><Trash2 size={16} />Smazat vše</button>
            </div>
          </section>
        </div>
      )}

      {engine && settingsDrawing && (settingsDrawing.tool === 'FibRetracement'
        ? <FibDrawingSettingsDialog key={settingsDrawing.id} fullScreen engine={engine} drawing={settingsDrawing as FibDrawing} onClose={closeSettings} />
        : isPositionDrawing(settingsDrawing)
          ? <PositionDrawingSettingsDialog key={settingsDrawing.id} fullScreen engine={engine} drawing={settingsDrawing} onClose={closeSettings} />
          : <GenericDrawingSettingsDialog key={settingsDrawing.id} fullScreen engine={engine} drawing={settingsDrawing} onClose={closeSettings} />)}
      {/* Text kresby: pole přes celou šířku nad klávesnicí. */}
      {textEdit && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 45, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div onClick={cancelText} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)' }} />
          <section aria-label="Text v grafu" style={{ position: 'relative', borderRadius: '20px 20px 0 0', background: 'var(--dj-card)', borderTop: '1px solid var(--dj-line)', padding: '14px 14px calc(14px + env(safe-area-inset-bottom, 0px))', animation: 'dj-sheet .24s ease both' }}>
            {/* Tlačítka nad polem: lišta nad klávesnicí iOS by je jinak zakryla. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <button type="button" className="dj-btn" onClick={cancelText} style={{ height: 36, padding: '0 12px', borderRadius: 10, border: '1px solid var(--dj-line)', background: 'transparent', color: 'var(--dj-text-2)', font: '600 13px Inter, sans-serif', cursor: 'pointer' }}>{textEdit.fresh ? 'Zahodit' : 'Zrušit'}</button>
              <p style={{ margin: 0, flex: 1, textAlign: 'center', fontSize: 14, fontWeight: 800 }}>Text v grafu</p>
              <button type="button" className="dj-btn" onClick={saveText} style={{ height: 36, padding: '0 16px', borderRadius: 10, border: 0, color: '#fff', background: 'linear-gradient(180deg,#6366f1,#4f46e5)', font: '800 13px Inter, sans-serif', cursor: 'pointer' }}>Uložit</button>
            </div>
            <textarea className="dj-input" autoFocus rows={2} value={textEdit.text} onChange={event => setTextEdit(current => current && { ...current, text: event.target.value })} placeholder="Co tu je…" aria-label="Text v grafu" style={{ fontSize: 16 }} />
          </section>
        </div>
      )}
    </div>,
    document.body,
  );
}

const floatingBar: React.CSSProperties = { position: 'absolute', top: 10, left: 10, right: 10, margin: '0 auto', width: 'max-content', maxWidth: 'calc(100% - 20px)', boxSizing: 'border-box', zIndex: 25, display: 'flex', alignItems: 'center' };
const chip: React.CSSProperties = { height: 30, padding: '0 9px', borderRadius: 9, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', color: 'var(--dj-text)', display: 'inline-flex', alignItems: 'center', gap: 5, font: '700 12px Inter, sans-serif', cursor: 'pointer', whiteSpace: 'nowrap' };
const iconButton: React.CSSProperties = { width: 40, height: 40, borderRadius: 11, border: 0, background: 'transparent', color: 'var(--dj-text-2)', display: 'grid', placeItems: 'center', cursor: 'pointer', padding: 0, flex: 'none' };
const toolTile: React.CSSProperties = { minHeight: 64, padding: '8px 4px', borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', color: 'var(--dj-text)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5, cursor: 'pointer', fontFamily: 'inherit' };
const sheetLabel: React.CSSProperties = { margin: '0 0 7px', fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--dj-muted)' };
const divider: React.CSSProperties = { width: 1, height: 26, background: 'var(--dj-line)', margin: '0 3px', flex: 'none' };

/**
 * Časový rámec jako kolečko (TradingView): tah nahoru/dolů točí seznam dokola,
 * rychlé švihnutí dojede setrvačností (kolo štěstí) a zastaví se na položce.
 * Uprostřed obrazovky je při tom velká skleněná karta; každý krok = haptika.
 */
const WHEEL_STEP_PX = 30;
const WHEEL_ROW_PX = 24; // výška řádku pro výpočet; skutečná poloha je na válci
const WHEEL_FRICTION = 0.972; // na snímek (≈16 ms) — volné dojíždění jako kolo štěstí
const WHEEL_MIN_VELOCITY = 0.0025; // položek / ms
const WHEEL_FLING_BOOST = 1.6; // švihnutí roztočí víc, než ukazuje samotný prst
// Buben jako TradingView (změřeno z videa): položky na válci po 18°, poloměr 76 pt —
// řádky se ke krajům zhušťují, zmenšují a šednou; střed je největší a tmavý.
const WHEEL_ANGLE = 18;
const WHEEL_RADIUS = 96;
const WHEEL_DWELL_MS = 240; // jak dlouho musí prst na rámci setrvat, než se graf přepne
const WHEEL_ARC_PX = 52; // jak moc se okrajové řádky stáčí doleva
function TimeframeWheel({ value, onChange }: { value: MarketTimeframe; onChange: (next: MarketTimeframe) => void }) {
  // `pos` = posun v položkách od `base` (rámec při začátku tahu); plynulé číslo, i záporné.
  // Base drží kolečko pevně, i když se graf během tahu přepíná.
  const [pos, setPos] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  const [base, setBase] = useState<MarketTimeframe>(value);
  const baseRef = useRef(value);
  const posRef = useRef(0);
  const dragRef = useRef<{ startY: number; startPos: number; moved: boolean; samples: { t: number; pos: number }[] } | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastStepRef = useRef(0);
  /** Během držení prstu (ne při dojíždění) se graf přepíná hned na každém kroku. */
  const liveRef = useRef(false);
  // Při držení se graf přepne až po krátkém setrvání na rámci (rychlé točení nepřepíná).
  const dwellRef = useRef<number | null>(null);
  const clearDwell = () => { if (dwellRef.current != null) { window.clearTimeout(dwellRef.current); dwellRef.current = null; } };
  useEffect(() => () => clearDwell(), []);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => () => { if (frameRef.current != null) cancelAnimationFrame(frameRef.current); }, []);
  const stopFrame = () => { if (frameRef.current != null) { cancelAnimationFrame(frameRef.current); frameRef.current = null; } };
  const apply = (step: number) => {
    const target = cycleDayChartTimeframe(baseRef.current, step);
    if (target !== valueRef.current) onChangeRef.current(target);
  };

  const show = (next: number) => {
    posRef.current = next;
    setPos(next);
    const step = Math.round(next);
    if (step !== lastStepRef.current) {
      lastStepRef.current = step;
      playNativeHapticIfAvailable('selection');
      if (liveRef.current) {
        clearDwell();
        dwellRef.current = window.setTimeout(() => { dwellRef.current = null; if (liveRef.current) apply(step); }, WHEEL_DWELL_MS);
      }
    }
  };
  const finish = () => {
    liveRef.current = false;
    clearDwell();
    const step = Math.round(posRef.current);
    playNativeHapticIfAvailable('light');
    // Dojetí na střed položky; po rozjetí se rámec přepne až teď (když kolo dojede).
    const from = posRef.current;
    const started = performance.now();
    const settle = (now: number) => {
      const k = Math.min(1, (now - started) / 160);
      posRef.current = from + (step - from) * (1 - (1 - k) ** 3);
      setPos(posRef.current);
      if (k < 1) { frameRef.current = requestAnimationFrame(settle); return; }
      frameRef.current = null;
      apply(step);
      // Karta chvíli zůstane, pak odjede (animace zavření), a teprve pak zmizí.
      window.setTimeout(() => {
        if (dragRef.current || frameRef.current != null) return; // mezitím znovu chycené
        setClosing(true);
        window.setTimeout(() => {
          if (dragRef.current || frameRef.current != null) { setClosing(false); return; }
          setClosing(false);
          setPos(null); posRef.current = 0; lastStepRef.current = 0;
        }, 200);
      }, 260);
    };
    frameRef.current = requestAnimationFrame(settle);
  };
  const coast = (velocity: number) => {
    liveRef.current = false;
    clearDwell();
    let v = velocity;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      show(posRef.current + v * dt);
      v *= WHEEL_FRICTION ** (dt / 16);
      if (Math.abs(v) > WHEEL_MIN_VELOCITY) { frameRef.current = requestAnimationFrame(tick); return; }
      frameRef.current = null;
      finish();
    };
    frameRef.current = requestAnimationFrame(tick);
  };

  const shown = pos == null ? value : cycleDayChartTimeframe(base, Math.round(pos));
  const around = (offset: number) => cycleDayChartTimeframe(shown, offset);
  const fraction = pos == null ? 0 : pos - Math.round(pos);
  return (
    <>
      <div
        role="spinbutton"
        aria-label="Časový rámec"
        aria-valuetext={shown}
        onPointerDown={event => {
          stopFrame();
          setClosing(false);
          if (pos == null) {
            // Nový tah: kolečko se točí od aktuálního rámce.
            baseRef.current = value; setBase(value);
            posRef.current = 0; lastStepRef.current = 0;
          }
          liveRef.current = true;
          dragRef.current = { startY: event.clientY, startPos: posRef.current, moved: false, samples: [{ t: performance.now(), pos: posRef.current }] };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const drag = dragRef.current;
          if (!drag) return;
          if (!drag.moved && Math.abs(drag.startY - event.clientY) < 6) return;
          drag.moved = true;
          const next = drag.startPos + (drag.startY - event.clientY) / WHEEL_STEP_PX;
          const now = performance.now();
          drag.samples.push({ t: now, pos: next });
          while (drag.samples.length > 2 && now - drag.samples[0].t > 90) drag.samples.shift();
          show(next);
        }}
        onPointerUp={() => {
          const drag = dragRef.current;
          dragRef.current = null;
          if (!drag) return;
          if (!drag.moved) {
            if (pos == null) {
              liveRef.current = false;
              playNativeHapticIfAvailable('selection');
              onChange(cycleDayChartTimeframe(value, 1));
            } else finish();
            return;
          }
          const first = drag.samples[0];
          const last = drag.samples[drag.samples.length - 1];
          const velocity = last.t > first.t ? (last.pos - first.pos) / (last.t - first.t) : 0;
          if (Math.abs(velocity) > 0.008) coast(velocity * WHEEL_FLING_BOOST);
          else finish();
        }}
        onPointerCancel={() => { dragRef.current = null; finish(); }}
        style={{ width: 50, height: 46, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', touchAction: 'none', cursor: 'ns-resize', userSelect: 'none' }}
      >
        <span style={{ height: 11, fontSize: 9.5, fontWeight: 700, lineHeight: '11px', color: 'var(--dj-muted)', opacity: 0.6 }}>{around(-1)}</span>
        <span style={{ fontSize: 16, fontWeight: 800, lineHeight: '20px', color: 'var(--dj-text)' }}>{shown}</span>
        <span style={{ height: 11, fontSize: 9.5, fontWeight: 700, lineHeight: '11px', color: 'var(--dj-muted)', opacity: 0.6 }}>{around(1)}</span>
      </div>
      {pos != null && createPortal(
        <div aria-hidden="true" className={`dj dj-wheel-card${closing ? ' is-closing' : ''}`}>
          {[-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map(offset => {
            const item = around(offset);
            const d = offset - fraction; // vzdálenost od středu v položkách (plynule)
            const angle = (d * WHEEL_ANGLE * Math.PI) / 180;
            if (Math.abs(angle) > Math.PI * 0.47) return null;
            const y = WHEEL_RADIUS * Math.sin(angle);
            // Střed uprostřed karty, ostatní se po oblouku stáčí doleva (kolo s osou vlevo).
            const x = -WHEEL_ARC_PX * (1 - Math.cos(angle));
            const scale = Math.max(0.34, 1 - 0.2 * Math.abs(d));
            const near = Math.max(0, 1 - Math.abs(d)); // 1 = přesně uprostřed
            return (
              <span key={offset} className="dj-wheel-item" style={{
                transform: `translate(calc(-50% + ${x.toFixed(2)}px), ${y.toFixed(2)}px) scale(${scale.toFixed(3)})`,
                color: `color-mix(in srgb, var(--dj-wheel-on) ${Math.round(near * 100)}%, var(--dj-wheel-off))`,
                opacity: Math.max(0, 1 - Math.max(0, Math.abs(d) - 1) * 0.2),
              }}>{DAY_CHART_TIMEFRAME_LABEL[item] ?? item}</span>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Přepnutí timeframe: přes graf přejede jemný pruh světla (jako přepnutí seance). */
function TimeframeSwapFx() {
  return (
    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, zIndex: 18, pointerEvents: 'none', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: '55%', background: 'linear-gradient(90deg, transparent, rgba(99,102,241,0.16), transparent)', animation: 'dj-wipe .7s cubic-bezier(.4,0,.2,1) both' }} />
    </div>
  );
}

/**
 * Rozvržení jako v TradingView na telefonu: „Synchronizace“ s fajfkami, pod ní
 * skupiny 1–4 okna se šablonami z PC; navíc „Podle otočení“ (výchozí).
 */
const SYNC_ROWS: { key: keyof DayChartSync; label: string }[] = [
  { key: 'interval', label: 'Interval' },
  { key: 'crosshair', label: 'Kurzor' },
  { key: 'time', label: 'Čas' },
  { key: 'dateRange', label: 'Rozsah dat' },
];
function LayoutSheet({ layout, activeId, sync, onSync, onPick, onClose }: {
  layout: DayChartLayout;
  activeId: string;
  sync: DayChartSync;
  onSync: (next: DayChartSync) => void;
  onPick: (next: DayChartLayout) => void;
  onClose: () => void;
}) {
  const [syncOpen, setSyncOpen] = useState(false);
  const anySync = sync.interval || sync.crosshair || sync.time || sync.dateRange;
  const tile = (on: boolean): React.CSSProperties => ({ height: 46, borderRadius: 12, border: 0, cursor: 'pointer', display: 'grid', placeItems: 'center', background: on ? 'var(--dj-seg-on)' : 'var(--dj-chip)', color: on ? 'var(--dj-seg-on-ink)' : 'var(--dj-text)', transition: 'background .15s, color .15s' });
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 40 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', animation: 'dj-fade .18s ease both' }} />
      <section aria-label="Rozvržení grafů" className="dj-scroll" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '86%', overflowY: 'auto', overscrollBehavior: 'contain', borderRadius: '20px 20px 0 0', background: 'var(--dj-card)', borderTop: '1px solid var(--dj-line)', padding: '8px 16px calc(16px + env(safe-area-inset-bottom, 0px))', animation: 'dj-sheet .26s cubic-bezier(.2,.9,.25,1) both' }}>
        <span style={{ display: 'block', width: 38, height: 5, borderRadius: 9, background: 'var(--dj-line)', margin: '0 auto 10px' }} />
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ width: 34 }} />
          <p style={{ margin: 0, flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 800 }}>Rozvržení</p>
          <button type="button" className="dj-btn" aria-label="Zavřít" onClick={onClose} style={{ ...iconButton, width: 34, height: 34, borderRadius: 99, background: 'var(--dj-chip)' }}><X size={17} /></button>
        </div>
        <div style={{ position: 'relative', marginBottom: 6 }}>
          <button type="button" className="dj-btn" aria-expanded={syncOpen} onClick={() => setSyncOpen(open => !open)} style={{ height: 36, padding: '0 12px', borderRadius: 10, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-text)', font: '700 13.5px Inter, sans-serif', display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            Synchronizace{!anySync && <span style={{ color: 'var(--dj-muted)', fontWeight: 600 }}> · vyp.</span>}<ChevronDown size={15} style={{ transform: syncOpen ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }} />
          </button>
          {syncOpen && (
            <div role="menu" style={{ position: 'absolute', left: 0, top: 42, zIndex: 2, width: 230, padding: 6, borderRadius: 14, background: 'var(--dj-card)', border: '1px solid var(--dj-line)', boxShadow: '0 18px 44px -16px rgba(0,0,0,0.5)', animation: 'dj-fade .14s ease both' }}>
              {SYNC_ROWS.map(row => (
                <button key={row.key} type="button" role="menuitemcheckbox" aria-checked={sync[row.key]} className="dj-btn" onClick={() => onSync({ ...sync, [row.key]: !sync[row.key] })} style={{ width: '100%', height: 42, display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', border: 0, borderRadius: 9, background: 'transparent', color: 'var(--dj-text)', font: '600 15px Inter, sans-serif', cursor: 'pointer', textAlign: 'left' }}>
                  <span style={{ width: 16, display: 'grid', placeItems: 'center' }}>{sync[row.key] && <Check size={16} />}</span>{row.label}
                </button>
              ))}
              <span style={{ display: 'block', height: 1, margin: '4px 8px', background: 'var(--dj-line)' }} />
              <button type="button" className="dj-btn" onClick={() => onSync({ interval: false, crosshair: false, time: false, dateRange: false })} style={{ width: '100%', height: 42, display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', border: 0, borderRadius: 9, background: 'transparent', color: 'var(--dj-text)', font: '600 15px Inter, sans-serif', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ width: 16 }} />Vypnout synchronizaci
              </button>
            </div>
          )}
        </div>
        <p style={{ ...sheetLabel, margin: '12px 0 7px' }}>Automaticky</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
          <button type="button" className="dj-btn" aria-pressed={layout === 'auto'} onClick={() => onPick('auto')} style={{ ...tile(layout === 'auto'), gridColumn: 'span 2', font: '700 13px Inter, sans-serif' }}>Podle otočení</button>
        </div>
        {CHART_WORKSPACE_LAYOUT_ROWS.map((row, rowIndex) => (
          <div key={rowIndex} style={{ borderTop: '1px solid var(--dj-line)', marginTop: 14, paddingTop: 10 }}>
            <p style={{ ...sheetLabel, margin: '0 0 7px' }}>{rowIndex + 1}</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
              {row.map(item => {
                const on = layout !== 'auto' && activeId === item.id;
                return (
                  <button key={item.id} type="button" className="dj-btn" aria-label={`Rozvržení ${item.id}`} aria-pressed={on} onClick={() => onPick(item.id)} style={tile(on)}>
                    <ChartLayoutGlyph cells={item.cells} size={20} />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

const MAGNET_LABEL: Record<'off' | 'weak' | 'strong', string> = { off: 'vyp.', weak: 'slabý', strong: 'silný' };

/** Menu ⋯ grafu dne (TradingView „Analysis hub“): vše, co se nevešlo do spodní lišty. */
function AnalysisHub({ layoutCells, indicators, canReplay, magnetMode, onMagnet, locked, onLock, onToggleIndicator, onIndicatorSettings, onLayout, onChartSettings, onReplay, onClose }: {
  layoutCells: Parameters<typeof ChartLayoutGlyph>[0]['cells'];
  indicators: { levels: boolean; fvg: boolean; structure: boolean };
  canReplay: boolean;
  magnetMode: 'off' | 'weak' | 'strong';
  onMagnet: (mode: 'off' | 'weak' | 'strong') => void;
  locked: boolean;
  onLock: () => void;
  onToggleIndicator: (id: 'fvg' | 'levels' | 'structure') => void;
  onIndicatorSettings: (id: 'fvg' | 'levels' | 'structure') => void;
  onLayout: () => void;
  onChartSettings: () => void;
  onReplay: () => void;
  onClose: () => void;
}) {
  // Složky jako v TradingView: hlavní stránka → Indikátory.
  const [page, setPage] = useState<'main' | 'indicators'>('main');
  const tile: React.CSSProperties = { ...toolTile, minHeight: 72, gap: 7, font: '700 12.5px Inter, sans-serif' };
  const rows: { id: 'levels' | 'fvg' | 'structure'; label: string; detail: string }[] = [
    { id: 'levels', label: 'Úrovně likvidity', detail: 'Liquidity Levels CZ' },
    { id: 'fvg', label: 'Fair Value Gaps', detail: 'AlphaTrade FVG INSTANT' },
    { id: 'structure', label: 'Struktura', detail: 'AlphaTrade BOS/CHoCH' },
  ];
  const activeCount = rows.filter(row => indicators[row.id]).length;
  const toggle = (on: boolean, onClick: () => void, label: string) => (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="dj-btn" onClick={onClick} style={{ width: 46, height: 28, borderRadius: 99, padding: 3, boxSizing: 'border-box', border: '1px solid var(--dj-line)', cursor: 'pointer', background: on ? 'linear-gradient(180deg,#6366f1,#4f46e5)' : 'var(--dj-chip)', display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start', flex: 'none' }}>
      <span style={{ width: 20, height: 20, borderRadius: 99, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
    </button>
  );
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 40 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', animation: 'dj-fade .18s ease both' }} />
      <section aria-label="Další volby grafu" className="dj-scroll" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '86%', overflowY: 'auto', overscrollBehavior: 'contain', borderRadius: '20px 20px 0 0', background: 'var(--dj-card)', borderTop: '1px solid var(--dj-line)', padding: '8px 16px calc(16px + env(safe-area-inset-bottom, 0px))', animation: 'dj-sheet .26s cubic-bezier(.2,.9,.25,1) both' }}>
        <span style={{ display: 'block', width: 38, height: 5, borderRadius: 9, background: 'var(--dj-line)', margin: '0 auto 10px' }} />
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          {page === 'main'
            ? <span style={{ width: 34 }} />
            : <button type="button" className="dj-btn" aria-label="Zpět" onClick={() => setPage('main')} style={{ ...iconButton, width: 34, height: 34, borderRadius: 99, background: 'var(--dj-chip)' }}><ChevronLeft size={18} /></button>}
          <p style={{ margin: 0, flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 800 }}>{page === 'main' ? 'Graf' : 'Indikátory'}</p>
          <button type="button" className="dj-btn" aria-label="Zavřít" onClick={onClose} style={{ ...iconButton, width: 34, height: 34, borderRadius: 99, background: 'var(--dj-chip)' }}><X size={17} /></button>
        </div>
        {page === 'main' ? (
          <div key="main" style={{ animation: 'dj-fade .16s ease both' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
              <button type="button" className="dj-btn" onClick={onLayout} style={tile}><ChartLayoutGlyph cells={layoutCells} size={22} />Rozvržení</button>
              <button type="button" className="dj-btn" onClick={() => setPage('indicators')} style={{ ...tile, position: 'relative' }}>
                <SlidersHorizontal size={22} />Indikátory
                <span style={{ position: 'absolute', top: 8, right: 10, minWidth: 20, height: 20, padding: '0 6px', boxSizing: 'border-box', borderRadius: 99, background: 'var(--dj-indigo-bg-soft)', color: 'var(--dj-indigo-text)', font: '800 11px/20px Inter, sans-serif' }}>{activeCount}</span>
              </button>
              <button type="button" className="dj-btn" onClick={onChartSettings} style={tile}><Settings size={22} />Nastavení grafu</button>
              <button type="button" className="dj-btn" disabled={!canReplay} onClick={onReplay} style={{ ...tile, opacity: canReplay ? 1 : 0.4 }}><Play size={22} />Přehrávání</button>
            </div>
            <p style={{ ...sheetLabel, margin: '18px 0 6px' }}>Kreslení</p>
            <div style={{ borderRadius: 14, border: '1px solid var(--dj-line)', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 10px 10px 12px' }}>
                <Magnet size={18} color="var(--dj-muted)" />
                <p style={{ margin: 0, flex: 1, fontSize: 14, fontWeight: 700 }}>Magnet</p>
                <div role="radiogroup" aria-label="Síla magnetu" style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 10, background: 'var(--dj-chip)' }}>
                  {(['off', 'weak', 'strong'] as const).map(mode => (
                    <button key={mode} type="button" role="radio" aria-checked={magnetMode === mode} className="dj-btn" onClick={() => onMagnet(mode)} style={{ height: 30, padding: '0 11px', borderRadius: 8, border: 0, cursor: 'pointer', font: '700 12.5px Inter, sans-serif', background: magnetMode === mode ? 'var(--dj-seg-on)' : 'transparent', color: magnetMode === mode ? 'var(--dj-seg-on-ink)' : 'var(--dj-muted)' }}>{mode === 'off' ? 'Vyp.' : mode === 'weak' ? 'Slabý' : 'Silný'}</button>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 10px 10px 12px', borderTop: '1px solid var(--dj-line)' }}>
                {locked ? <Lock size={18} color="var(--dj-muted)" /> : <Unlock size={18} color="var(--dj-muted)" />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Zamknout kresby</p>
                  <p style={{ margin: '1px 0 0', fontSize: 11.5, color: 'var(--dj-muted)' }}>Kresby nejde omylem posunout</p>
                </div>
                {toggle(locked, onLock, 'Zamknout kresby')}
              </div>
            </div>
          </div>
        ) : (
          <div key="indicators" style={{ animation: 'dj-fade .16s ease both' }}>
            <div style={{ borderRadius: 14, border: '1px solid var(--dj-line)', overflow: 'hidden' }}>
              {rows.map((row, index) => (
                <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 8px 8px 12px', borderTop: index ? '1px solid var(--dj-line)' : undefined }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{row.label}</p>
                    <p style={{ margin: '1px 0 0', fontSize: 11.5, color: 'var(--dj-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.detail}</p>
                  </div>
                  <button type="button" className="dj-btn" aria-label={`Nastavení a šablony: ${row.label}`} onClick={() => onIndicatorSettings(row.id)} style={{ ...iconButton, width: 38, height: 38 }}><Settings size={18} /></button>
                  {toggle(indicators[row.id], () => onToggleIndicator(row.id), row.label)}
                </div>
              ))}
            </div>
            <p style={{ margin: '8px 2px 0', fontSize: 12, color: 'var(--dj-muted)' }}>⚙ otevře nastavení indikátoru včetně šablon (Uložit jako… / Použít výchozí), stejné jako na PC.</p>
          </div>
        )}
      </section>
    </div>
  );
}

const DAY_REPLAY_STEP_LABEL: Record<DayReplayStep, string> = { 1: '1m', 5: '5m', 15: '15m', 30: '30m', 60: '1h' };

/**
 * Střih nůžkami: ořezaná budoucnost (vpravo od startu) jako závoj odjede
 * doprava a zmizí, na místě střihu krátce svítí svislá čára s nůžkami.
 */
function ReplayCutFx({ chartApi, time }: { chartApi: ChartViewApi | null; time: number }) {
  const [x] = useState<number | null>(() => {
    try {
      const chart = chartApi?.controller.getChart();
      const coordinate = chart?.timeScale().timeToCoordinate(time as never);
      return coordinate == null ? null : Number(coordinate);
    } catch { return null; }
  });
  if (x == null) return null;
  return (
    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, zIndex: 19, pointerEvents: 'none', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: x, right: 0, background: 'linear-gradient(90deg, rgba(99,102,241,0.22), var(--dj-bg) 40%)', animation: 'dj-cut-away .62s cubic-bezier(.4,0,.2,1) both' }} />
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: x - 1, width: 2, background: '#6366f1', boxShadow: '0 0 12px rgba(99,102,241,0.8)', animation: 'dj-fade-out .62s ease both' }} />
      <span style={{ position: 'absolute', left: x - 13, top: 10, width: 26, height: 26, borderRadius: 99, display: 'grid', placeItems: 'center', color: '#fff', background: '#6366f1', animation: 'dj-fade-out .62s ease both' }}><Scissors size={14} /></span>
    </div>
  );
}

const miniToggle: React.CSSProperties = { height: 28, padding: '0 10px', borderRadius: 8, border: '1px solid var(--dj-line)', background: 'transparent', color: 'var(--dj-text-2)', font: '700 11.5px Inter, sans-serif', cursor: 'pointer', whiteSpace: 'nowrap' };
const sheetAction: React.CSSProperties = { height: 42, borderRadius: 12, border: '1px solid var(--dj-line)', background: 'transparent', color: 'var(--dj-text)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, font: '700 12px Inter, sans-serif', cursor: 'pointer' };
