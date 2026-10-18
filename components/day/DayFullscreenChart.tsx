import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { Drawing, DrawingToolId } from '@getcandlekit/charts';
import { ChevronDown, Lock, Magnet, Maximize2, Mic, Minimize2, Pause, PenLine, Play, RotateCcw, SkipBack, SkipForward, StepBack, StepForward, StickyNote, Trash2, Type, Unlock, X } from 'lucide-react';
import type { Trade } from '../../types';
import CandleKitTradeChart, { ALPHATRADE_DRAWING_TOOLS } from '../CandleKitTradeChart';
import { QuantumSpinner } from '../QuantumLoader';
import { aggregateCandles, MARKET_TIMEFRAME_MINUTES, type MarketTimeframe } from '../../services/marketData';
import { onTradeChartIndicatorsChange, readTradeChartIndicators, writeTradeChartIndicators } from '../../services/detailIndicators';
import { tradeChartTiming } from '../../services/tradeChartData';
import { getDrawingMagnetSettings, setDrawingMagnetSettings, subscribeDrawingMagnetSettings } from '../../services/chartDrawingMagnet';
import { setNativeShellTabBarHidden } from '../../utils/nativeShell';
import { installChartWorkspaceSync } from '../../services/chartWorkspaceSync';
import { DAY_REPLAY_SPEEDS, candlesUntil, dayReplayRange, dayReplayTickMs, stepDayReplay, type DayReplaySpeed } from '../../lib/dayReplay';
import {
  DAY_CHART_TIMEFRAMES, DAY_DRAW_COLORS, DAY_DRAW_TOOLS, DAY_PATH_TOOL, dayDrawColorOf, dayDrawStyle,
  pathGroupOf, pathSegmentIds, type DayDrawColorId,
} from '../../lib/dayChartTools';
import ChartNotesLayer from '../ChartNotesLayer';
import { chartNotesOfTrades } from '../../lib/chartNotes';
import DayNotesLayer, { type DayBand, type DayPinPoint, type DayPinView } from './DayNotesLayer';
import DayTouchDrawLayer from './DayTouchDrawLayer';
import { dayAnchorTrade, focusTarget, useReviewFocus } from './dayFocus';
import { LiveChip, ScopeSwitch } from './DayPanels';
import type { DayController } from './useDayController';

type DrawingEngine = NonNullable<ChartViewApi['drawing']>['engine'];

const SHORT_DAY = new Intl.DateTimeFormat('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' });
const shortDay = (day: string) => SHORT_DAY.format(new Date(`${day}T12:00:00Z`));
const TOOL_BY_ID = new Map(ALPHATRADE_DRAWING_TOOLS.map(tool => [tool.id, tool]));
const toolTitle = (tool: string | null) => (tool === DAY_PATH_TOOL ? 'Šipka' : tool ? DAY_DRAW_TOOLS.find(item => item.id === tool)?.label ?? TOOL_BY_ID.get(tool)?.title ?? tool : '');
const WIDTHS = [1, 2, 3] as const;
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
export default function DayFullscreenChart({ ctl, isDark, timeframe, onTimeframe, range, focusKeyPrefix, selectedTrade, pins, bubbles, placing, onPick, onCancelPlacing, pending, nowTime, bands, onClose, onVoice }: {
  ctl: DayController;
  isDark: boolean;
  timeframe: MarketTimeframe;
  onTimeframe: (timeframe: MarketTimeframe) => void;
  range: { from: number; to: number };
  focusKeyPrefix: string;
  selectedTrade: Trade | null;
  pins: DayPinView[];
  bubbles: 'all' | 'selected';
  placing: 'note' | 'voice' | null;
  onPick: (point: DayPinPoint) => void;
  onCancelPlacing: () => void;
  pending: DayPinPoint | null;
  nowTime?: number | null;
  bands: DayBand[];
  onClose: () => void;
  /** Poznámka hlasem: přepne umisťování (`placing: 'voice'`). */
  onVoice: () => void;
}) {
  const [indicators, setIndicators] = useState(readTradeChartIndicators);
  useEffect(() => onTradeChartIndicatorsChange(setIndicators), []);
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  const [api, setApi] = useState<ChartViewApi | null>(null);
  const [chromeHidden, setChromeHidden] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<DrawingToolId | null>(null);
  const [selected, setSelected] = useState<Drawing | null>(null);
  const [manualCount, setManualCount] = useState(0);
  // Zpět bere jen kresby z tohohle otevření grafu — nikdy starší kresby (třeba z Macu).
  const createdRef = useRef<string[]>([]);
  const [createdCount, setCreatedCount] = useState(0);
  const [locked, setLocked] = useState(false);
  // null = barvy z předvoleb kreslení (jako na Macu), dokud si v listu nevybereš.
  const [colorId, setColorId] = useState<DayDrawColorId | null>(null);
  const colorRef = useRef(colorId);
  colorRef.current = colorId;
  const [magnet, setMagnet] = useState(getDrawingMagnetSettings);
  useEffect(() => subscribeDrawingMagnetSettings(setMagnet), []);
  const [textEdit, setTextEdit] = useState<{ id: string; text: string; fresh: boolean } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Na výšku (375–430 px) se do pruhů nevejde všechno: bez živého chipu.
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 440);
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 440));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Na šířku dva grafy vedle sebe (schválený návrh): vlevo zvolený rámec,
  // vpravo o stupeň vyšší. Kreslí se a vybírá v tom, na který jsi naposled klepl.
  const [landscape, setLandscape] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(orientation: landscape) and (min-width: 560px)').matches === true);
  useEffect(() => {
    const media = window.matchMedia?.('(orientation: landscape) and (min-width: 560px)');
    if (!media) return;
    const update = () => setLandscape(media.matches);
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  const [activePane, setActivePane] = useState<0 | 1>(0);
  const [secondApi, setSecondApi] = useState<ChartViewApi | null>(null);
  const secondContainerRef = useRef<HTMLDivElement>(null);
  // Druhý graf: o stupeň vyšší rámec (15m → 5m, ať nejsou dva stejné).
  const secondTimeframe: MarketTimeframe = timeframe === '15m' ? '5m' : timeframe === '5m' ? '15m' : '5m';
  // Po otočení zpět zůstane aktivní graf, na který ses díval.
  useEffect(() => {
    if (landscape || activePane === 0) return;
    setActivePane(0);
    onTimeframe(secondTimeframe);
  }, [activePane, landscape, onTimeframe, secondTimeframe]);

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
  const fullRaw = ctl.chart.candles;
  // ── Přehrávání (lišta dole, schválený návrh): kurzor nad 1m svíčkami dne ──
  const [replayOn, setReplayOn] = useState(false);
  const [replayCursor, setReplayCursor] = useState<number | null>(null);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState<DayReplaySpeed>(3);
  const [speedSheet, setSpeedSheet] = useState(false);
  const replayRange = useMemo(() => dayReplayRange(fullRaw.map(candle => candle.time), Math.floor(range.from / 1000)), [fullRaw, range.from]);
  const startReplay = () => {
    if (!replayRange) return;
    setReplayOn(true); setReplayCursor(replayRange.start); setReplayPlaying(false);
  };
  const stopReplay = () => { setReplayOn(false); setReplayCursor(null); setReplayPlaying(false); setSpeedSheet(false); };
  useEffect(() => {
    if (!replayPlaying || !replayRange) return;
    const timer = window.setInterval(() => {
      setReplayCursor(current => {
        const next = stepDayReplay(current ?? replayRange.start, 1, replayRange);
        if (next >= replayRange.end) setReplayPlaying(false);
        return next;
      });
    }, dayReplayTickMs(replaySpeed));
    return () => window.clearInterval(timer);
  }, [replayPlaying, replayRange, replaySpeed]);
  const raw = useMemo(() => (replayOn ? candlesUntil(fullRaw, replayCursor) : fullRaw), [fullRaw, replayCursor, replayOn]);
  const candles = useMemo(() => aggregateCandles(raw, timeframe), [raw, timeframe]);
  const barTimes = useMemo(() => candles.map(candle => candle.time), [candles]);
  const secondCandles = useMemo(() => (landscape ? aggregateCandles(raw, secondTimeframe) : []), [landscape, raw, secondTimeframe]);
  const secondBarTimes = useMemo(() => secondCandles.map(candle => candle.time), [secondCandles]);
  // Kurzor a čas mezi oběma grafy (jako workspace na Macu).
  useEffect(() => {
    if (!landscape || !api || !secondApi) return;
    return installChartWorkspaceSync(
      [['a', { chartApi: api, candles }], ['b', { chartApi: secondApi, candles: secondCandles }]],
      { crosshair: true, time: true, dateRange: false },
    );
  }, [api, candles, landscape, secondApi, secondCandles]);
  const tradeNotes = useMemo(() => chartNotesOfTrades(ctl.chart.chartTrades), [ctl.chart.chartTrades]);
  const target = focusTarget(range);
  const anchorRef = useRef<{ day: string; trade: Trade } | null>(null);
  if (!anchorRef.current || anchorRef.current.day !== ctl.day) anchorRef.current = { day: ctl.day, trade: dayAnchorTrade(ctl.day, target) };
  const anchor = anchorRef.current.trade;
  const chartTrade = selectedTrade ?? anchor;
  const timing = selectedTrade ? tradeChartTiming(selectedTrade) : { entryMs: anchor.entryTime!, exitMs: anchor.timestamp };
  const focusKey = selectedTrade ? `trade:${selectedTrade.id}` : `${focusKeyPrefix}:${Math.round(target.entryMs / 60_000)}:${Math.round(target.exitMs / 60_000)}`;
  const detail = selectedTrade ? { ...tradeChartTiming(selectedTrade), id: String(selectedTrade.id) } : { entryMs: target.entryMs, exitMs: target.exitMs, id: String(anchor.id) };
  useReviewFocus(focusKey, { entryMs: detail.entryMs, exitMs: detail.exitMs, id: detail.id }, Boolean(api), `${ctl.day}:${timeframe}:full`);

  // ── Kreslení: stav motoru (aktivní nástroj, výběr, počet kreseb) ──────
  const activeApi = landscape && activePane === 1 ? secondApi : api;
  const engine: DrawingEngine | null = activeApi?.drawing?.engine ?? null;
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
      const id = engine.getSelectedId();
      setSelected(id ? engine.getById(id) ?? null : null);
      setManualCount(engine.getDrawings().filter(item => !item.id.startsWith('auto-')).length);
      createdRef.current = createdRef.current.filter(id => engine.getById(id));
      setCreatedCount(createdRef.current.length);
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
  const pickColor = (id: DayDrawColorId) => {
    setColorId(id);
    if (!engine) return;
    for (const drawingId of selectedIds()) engine.setStyle(drawingId, dayDrawStyle(id, engine.getById(drawingId)?.tool));
  };
  const pickWidth = (width: number) => {
    if (!engine) return;
    for (const drawingId of selectedIds()) engine.setStyle(drawingId, { width });
  };
  const removeSelected = () => {
    if (!engine) return;
    for (const drawingId of selectedIds()) engine.remove(drawingId);
  };
  const undo = () => {
    if (!engine) return;
    const id = createdRef.current.at(-1);
    if (!id) return;
    // Úsek cesty: zpět bere celou cestu, ne jen poslední úsek.
    const group = pathGroupOf(id);
    for (const drawingId of group ? pathSegmentIds(engine.getDrawings(), group) : [id]) engine.remove(drawingId);
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
  const indicatorCount = Number(indicators.levels) + Number(indicators.fvg) + Number(indicators.structure);
  const selectedColor = selected ? dayDrawColorOf(selected.style.color) : null;
  const drawingNow = pathActive || Boolean(activeTool);
  const toolName = pathActive ? DAY_PATH_TOOL : activeTool;

  const bar: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px calc(6px + env(safe-area-inset-bottom, 0px))', borderTop: '1px solid var(--dj-line)', background: 'var(--dj-card)', flex: 'none', minHeight: 52 };

  return createPortal(
    <div ref={rootRef} className="dj" role="dialog" aria-label="Graf dne na celou obrazovku" style={{ position: 'fixed', inset: 0, zIndex: 880, display: 'flex', flexDirection: 'column', background: 'var(--dj-bg)', color: 'var(--dj-text)', paddingTop: chromeHidden ? 0 : 'env(safe-area-inset-top, 0px)', paddingLeft: 'env(safe-area-inset-left, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)', animation: 'dj-fade .18s ease both' }}>
      {!chromeHidden && (
        <header style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 6px 6px 12px', flex: 'none', borderBottom: '1px solid var(--dj-line)', background: 'var(--dj-card)' }}>
          <div style={{ minWidth: 0, flex: 'none' }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 800, lineHeight: 1.15, whiteSpace: 'nowrap' }}>MNQ</p>
            <p style={{ margin: 0, fontSize: 10.5, fontWeight: 600, lineHeight: 1.2, color: 'var(--dj-muted)', whiteSpace: 'nowrap' }}>{shortDay(ctl.weekendMarketDay ?? ctl.day)}</p>
          </div>
          <div role="radiogroup" aria-label="Časový rámec" style={{ display: 'flex', gap: 2, padding: 2, marginLeft: 4, borderRadius: 10, background: 'var(--dj-chip)', flex: 'none' }}>
            {DAY_CHART_TIMEFRAMES.map(item => (
              <button key={item} type="button" role="radio" aria-checked={timeframe === item} className="dj-btn" onClick={() => onTimeframe(item)} style={{ height: 30, minWidth: 38, padding: '0 8px', borderRadius: 8, border: 0, cursor: 'pointer', font: '800 12px Inter, sans-serif', background: timeframe === item ? 'var(--dj-seg-on)' : 'transparent', color: timeframe === item ? 'var(--dj-seg-on-ink)' : 'var(--dj-muted)' }}>{item}</button>
            ))}
          </div>
          <button type="button" className="dj-btn" aria-expanded={indicatorsOpen} aria-label="Indikátory" onClick={() => setIndicatorsOpen(open => !open)} style={{ ...chip, gap: 3, flex: 'none' }}>
            <ChevronDown size={12} style={{ transform: indicatorsOpen ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }} /> {indicatorCount}
          </button>
          <span style={{ flex: 1 }} />
          {!narrow && <LiveChip status={ctl.chart.liveStatus} capturedAt={ctl.chart.liveCapturedAt} weekendMarketDay={ctl.weekendMarketDay} />}
          <button type="button" className="dj-btn" aria-label="Zavřít" onClick={onClose} style={{ ...iconButton, border: '1px solid var(--dj-line)' }}><X size={18} /></button>
        </header>
      )}
      {!chromeHidden && indicatorsOpen && (
        <div style={{ display: 'flex', gap: 6, padding: '6px 12px', flex: 'none', borderBottom: '1px solid var(--dj-line)', background: 'var(--dj-card)' }}>
          {([['levels', 'Úrovně'], ['fvg', 'FVG'], ['structure', 'Struktura']] as const).map(([id, label]) => (
            <button key={id} type="button" className="dj-btn" aria-pressed={indicators[id]} onClick={() => toggleIndicator(id)} style={{ ...chip, border: indicators[id] ? '1px solid var(--dj-line)' : '1px dashed var(--dj-line)', background: indicators[id] ? 'var(--dj-chip)' : 'transparent', color: indicators[id] ? 'var(--dj-text)' : 'var(--dj-muted)' }}>{label}</button>
          ))}
        </div>
      )}

      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', background: isDark ? '#05080f' : '#fff' }}>
      <div ref={containerRef} onPointerDownCapture={() => { if (landscape && activePane !== 0) { engine?.stopTool(); setPathActive(false); setActivePane(0); } }} style={{ position: 'relative', flex: 1, minWidth: 0, boxShadow: landscape && activePane === 0 ? 'inset 0 0 0 1.5px rgba(99,102,241,0.55)' : undefined }}>
        {candles.length ? (
          <CandleKitTradeChart
            key={`${ctl.day}:${timeframe}:full`}
            trade={chartTrade}
            candles={candles}
            rawCandles={raw}
            timeframe={timeframe}
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
            contextTrades={ctl.chart.chartTrades}
            drawingKeyId={`day:${ctl.day}`}
            drawingScope="day"
            drawingHitTolerance={14}
            replayActive={replayOn}
            replayCursorTime={replayOn ? replayCursor : null}
            onChartApiReady={setApi}
            onToggleFvg={() => toggleIndicator('fvg')}
            onToggleLevels={() => toggleIndicator('levels')}
            onToggleStructure={() => toggleIndicator('structure')}
          />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 16, textAlign: 'center' }}>
            {ctl.chart.loading ? <QuantumSpinner /> : <p style={{ margin: 0, fontSize: 12, color: 'var(--dj-text-2)' }}>{ctl.chart.error ?? 'Svíčky pro tenhle den zatím nejsou.'}</p>}
          </div>
        )}
        {/* Poznámky k obchodům dne (detail obchodu, Review) — jen pro čtení. */}
        {tradeNotes.length > 0 && (
          <ChartNotesLayer
            chartApi={api}
            containerRef={containerRef}
            notes={tradeNotes}
            barTimes={barTimes}
            replayCursor={null}
            editable={false}
            isDark={isDark}
            addRequest={null}
            onChange={() => {}}
          />
        )}
        <DayNotesLayer
          chartApi={api}
          containerRef={containerRef}
          barTimes={barTimes}
          intervalSeconds={MARKET_TIMEFRAME_MINUTES[timeframe] * 60}
          pins={pins}
          selectedId={ctl.selected?.kind === 'note' ? ctl.selected.id : null}
          onSelect={id => ctl.setSelected(id ? { kind: 'note', id } : null)}
          bubbles={bubbles}
          placing={!landscape || activePane === 0 ? placing : null}
          placingHint="Ťukni, kam to patří"
          onPick={onPick}
          onCancelPlacing={onCancelPlacing}
          pending={pending}
          nowTime={nowTime}
          bands={bands}
          ticks={ctl.mindTicks}
        />
        {/* Dotyky na kresby: výběr, přesun, úprava bodů vždy; s nástrojem v ruce crosshair. */}
        <DayTouchDrawLayer chartApi={api} containerRef={containerRef} enabled={!placing && !textEdit && (!landscape || activePane === 0)} pathActive={pathActive} pathStyle={pathStyle} onPathEnd={toolDone} />
      </div>
      {landscape && (
        <div ref={secondContainerRef} onPointerDownCapture={() => { if (activePane !== 1) { engine?.stopTool(); setPathActive(false); setActivePane(1); } }} style={{ position: 'relative', flex: 1, minWidth: 0, borderLeft: '1px solid var(--dj-line)', boxShadow: activePane === 1 ? 'inset 0 0 0 1.5px rgba(99,102,241,0.55)' : undefined }}>
          {secondCandles.length > 0 && (
            <CandleKitTradeChart
              key={`${ctl.day}:${secondTimeframe}:full2`}
              trade={chartTrade}
              candles={secondCandles}
              rawCandles={raw}
              timeframe={secondTimeframe}
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
              contextTrades={ctl.chart.chartTrades}
              drawingKeyId={`day:${ctl.day}`}
              drawingScope="day"
              drawingHitTolerance={14}
              replayActive={replayOn}
              replayCursorTime={replayOn ? replayCursor : null}
              onChartApiReady={setSecondApi}
              onToggleFvg={() => toggleIndicator('fvg')}
              onToggleLevels={() => toggleIndicator('levels')}
              onToggleStructure={() => toggleIndicator('structure')}
            />
          )}
          <DayNotesLayer
            chartApi={secondApi}
            containerRef={secondContainerRef}
            barTimes={secondBarTimes}
            intervalSeconds={MARKET_TIMEFRAME_MINUTES[secondTimeframe] * 60}
            pins={pins}
            selectedId={ctl.selected?.kind === 'note' ? ctl.selected.id : null}
            onSelect={id => ctl.setSelected(id ? { kind: 'note', id } : null)}
            bubbles={bubbles}
            placing={activePane === 1 ? placing : null}
            placingHint="Ťukni, kam to patří"
            onPick={onPick}
            onCancelPlacing={onCancelPlacing}
            pending={pending}
            nowTime={nowTime}
            bands={bands}
            ticks={ctl.mindTicks}
          />
          <DayTouchDrawLayer chartApi={secondApi} containerRef={secondContainerRef} enabled={!placing && !textEdit && activePane === 1} pathActive={pathActive} pathStyle={pathStyle} onPathEnd={toolDone} />
          <span style={{ position: 'absolute', left: 8, top: 34, zIndex: 20, padding: '2px 7px', borderRadius: 6, fontSize: 11, fontWeight: 800, color: 'var(--dj-text-2)', background: 'var(--dj-chip)', pointerEvents: 'none' }}>{secondTimeframe}</span>
        </div>
      )}

        {/* Nástroj v ruce: co se kreslí, jak to skončí, zrušit. */}
        {drawingNow && (
          <div style={{ ...floatingBar, gap: 8, padding: '6px 6px 6px 12px', borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-card)', boxShadow: '0 12px 30px -12px rgba(0,0,0,0.6)', whiteSpace: 'nowrap', animation: 'dj-rise .18s ease both' }}>
            <span style={{ fontSize: 12.5, fontWeight: 800 }}>{toolTitle(toolName)}</span>
            <span style={{ fontSize: 11.5, color: 'var(--dj-muted)' }}>{pathActive ? 'ťuk = bod · dvojklep = konec' : 'tah posune · ťuk = bod'}</span>
            <button type="button" className="dj-btn" aria-label="Zrušit nástroj" onClick={cancelTool} style={{ ...iconButton, width: 32, height: 32 }}><X size={16} /></button>
          </div>
        )}
        {/* Vybraná kresba: barva, tloušťka, text, koš (plovoucí lišta jako v TradingView). */}
        {!drawingNow && selected && !textEdit && (
          <div style={{ ...floatingBar, gap: 5, padding: 5, overflowX: 'auto', borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-card)', boxShadow: '0 12px 30px -12px rgba(0,0,0,0.6)', animation: 'dj-rise .18s ease both' }}>
            {DAY_DRAW_COLORS.map(item => (
              <button key={item.id} type="button" className="dj-btn" aria-label={item.label} aria-pressed={selectedColor === item.id} onClick={() => pickColor(item.id)} style={{ width: 30, height: 30, borderRadius: 9, border: selectedColor === item.id ? '2px solid var(--dj-text)' : '2px solid transparent', background: item.color, cursor: 'pointer', padding: 0, flex: 'none' }} />
            ))}
            <span style={{ width: 1, height: 22, background: 'var(--dj-line)', margin: '0 1px' }} />
            {selected.tool !== 'Text' && WIDTHS.map(width => (
              <button key={width} type="button" className="dj-btn" aria-label={`Tloušťka ${width}`} aria-pressed={selected.style.width === width} onClick={() => pickWidth(width)} style={{ width: 30, height: 30, borderRadius: 9, border: 0, cursor: 'pointer', display: 'grid', placeItems: 'center', background: selected.style.width === width ? 'var(--dj-tab-on)' : 'transparent', flex: 'none' }}>
                <span style={{ width: 16, height: width + 0.5, borderRadius: 2, background: 'var(--dj-text)' }} />
              </button>
            ))}
            {selected.tool === 'Text' && (
              <button type="button" className="dj-btn" aria-label="Upravit text" onClick={() => setTextEdit({ id: selected.id, text: selected.style.text ?? '', fresh: false })} style={{ ...iconButton, width: 34, height: 32 }}><Type size={16} /></button>
            )}
            <button type="button" className="dj-btn" aria-label={selectedGroup ? 'Smazat cestu' : 'Smazat kresbu'} onClick={removeSelected} style={{ ...iconButton, width: 34, height: 32, color: 'var(--dj-rose)' }}><Trash2 size={16} /></button>
            <button type="button" className="dj-btn" aria-label="Zrušit výběr" onClick={() => engine?.select(null)} style={{ ...iconButton, width: 30, height: 32 }}><X size={15} /></button>
          </div>
        )}
        {/* Plovoucí tužka a zpět (vpravo dole nad grafem, mimo cenovou osu). */}
        {!chromeHidden && !toolsOpen && !textEdit && (
          <div style={{ position: 'absolute', right: 74, bottom: landscape ? 14 : 34, zIndex: 24, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
            {createdCount > 0 && !drawingNow && (
              <button type="button" className="dj-btn" aria-label="Vrátit poslední kresbu" onClick={undo} style={{ ...floatButton, width: 40, height: 40 }}><RotateCcw size={16} /></button>
            )}
            <button type="button" className="dj-btn" aria-label="Nástroje kreslení" onClick={() => (drawingNow ? cancelTool() : setToolsOpen(true))} style={{ ...floatButton, ...(drawingNow ? { color: '#fff', background: 'linear-gradient(180deg,#6366f1,#4f46e5)', border: 0 } : {}) }}>{drawingNow ? <X size={20} /> : <PenLine size={20} />}</button>
          </div>
        )}
        {chromeHidden && (
          <button type="button" className="dj-btn" aria-label="Zobrazit ovládání" onClick={() => setChromeHidden(false)} style={{ position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 8px)', right: 10, zIndex: 25, ...iconButton, background: 'var(--dj-card)', border: '1px solid var(--dj-line)', opacity: 0.85 }}><Minimize2 size={16} /></button>
        )}
      </div>

      {!chromeHidden && replayOn && replayRange && (
        <div role="toolbar" aria-label="Přehrávání" style={{ ...bar, gap: 2, justifyContent: 'space-between' }}>
          <button type="button" className="dj-btn" aria-label="Na začátek" onClick={() => { setReplayPlaying(false); setReplayCursor(replayRange.start); }} style={iconButton}><SkipBack size={18} /></button>
          <button type="button" className="dj-btn" aria-label="O svíčku zpět" onClick={() => { setReplayPlaying(false); setReplayCursor(current => stepDayReplay(current ?? replayRange.start, -1, replayRange)); }} style={iconButton}><StepBack size={18} /></button>
          <button type="button" className="dj-btn" aria-label={replayPlaying ? 'Pauza' : 'Přehrát'} onClick={() => { if (!replayPlaying && (replayCursor ?? 0) >= replayRange.end) setReplayCursor(replayRange.start); setReplayPlaying(playing => !playing); }} style={{ ...iconButton, width: 48, height: 44, borderRadius: 14, color: '#fff', background: 'linear-gradient(180deg,#6366f1,#4f46e5)' }}>{replayPlaying ? <Pause size={20} /> : <Play size={20} />}</button>
          <button type="button" className="dj-btn" aria-label="O svíčku vpřed" onClick={() => { setReplayPlaying(false); setReplayCursor(current => stepDayReplay(current ?? replayRange.start, 1, replayRange)); }} style={iconButton}><StepForward size={18} /></button>
          <button type="button" className="dj-btn" aria-label="Na konec" onClick={() => { setReplayPlaying(false); setReplayCursor(replayRange.end); }} style={iconButton}><SkipForward size={18} /></button>
          <button type="button" className="dj-btn" aria-label={`Rychlost ${replaySpeed}×`} onClick={() => setSpeedSheet(true)} style={{ ...chip, minWidth: 44, justifyContent: 'center', fontWeight: 800 }}>{replaySpeed}×</button>
          <span className="dj-mono" style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--dj-text-2)', minWidth: 38, textAlign: 'center' }}>{replayCursor != null ? new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit' }).format(replayCursor * 1000) : ''}</span>
          <button type="button" className="dj-btn" aria-label="Ukončit přehrávání" onClick={stopReplay} style={{ ...iconButton, border: '1px solid var(--dj-line)' }}><X size={17} /></button>
        </div>
      )}
      {speedSheet && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 40 }}>
          <div onClick={() => setSpeedSheet(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)' }} />
          <section aria-label="Rychlost přehrávání" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, borderRadius: '20px 20px 0 0', background: 'var(--dj-card)', borderTop: '1px solid var(--dj-line)', padding: '14px 14px calc(14px + env(safe-area-inset-bottom, 0px))', animation: 'dj-sheet .24s ease both' }}>
            <p style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 800 }}>Rychlost přehrávání</p>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${DAY_REPLAY_SPEEDS.length}, minmax(0, 1fr))`, gap: 8 }}>
              {DAY_REPLAY_SPEEDS.map(item => (
                <button key={item} type="button" className="dj-btn" aria-pressed={replaySpeed === item} onClick={() => { setReplaySpeed(item); setSpeedSheet(false); }} style={{ height: 48, borderRadius: 12, cursor: 'pointer', font: '800 15px Inter, sans-serif', border: '1px solid var(--dj-line)', background: replaySpeed === item ? 'var(--dj-seg-on)' : 'var(--dj-chip)', color: replaySpeed === item ? 'var(--dj-seg-on-ink)' : 'var(--dj-text)' }}>{item}×</button>
              ))}
            </div>
            <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--dj-muted)' }}>1× = minuta trhu za 0,6 s. Svíčky přibývají po minutě od začátku zvolené seance.</p>
          </section>
        </div>
      )}
      {!chromeHidden && !replayOn && (
        <div style={bar}>
          {narrow ? (
            // Úzký displej: rozsah jako jeden čip (Den → LDN → NY), ať se pruh vejde.
            <button type="button" className="dj-btn" aria-label={`Rozsah: ${SCOPE_LABEL[ctl.scope]}, další`} onClick={() => ctl.setScope(ctl.scope === 'day' ? 'london' : ctl.scope === 'london' ? 'ny' : 'day')} style={{ ...chip, height: 36, padding: '0 12px', gap: 7, fontWeight: 800 }}>
              <span style={{ width: 8, height: 8, borderRadius: 9, background: ctl.scope === 'london' ? '#3b82f6' : ctl.scope === 'ny' ? '#f97316' : '#94a3b8' }} />{SCOPE_LABEL[ctl.scope]}
            </button>
          ) : <ScopeSwitch ctl={ctl} />}
          <span style={{ flex: 1 }} />
          <button type="button" className="dj-btn" aria-label="Poznámka do grafu" aria-pressed={placing === 'note'} onClick={() => { cancelTool(); ctl.setPendingPoint(null); ctl.setPlacing(placing === 'note' ? null : 'note'); }} style={{ ...iconButton, ...(placing === 'note' ? { color: '#1c1203', background: '#fbbf24' } : {}) }}><StickyNote size={18} /></button>
          <button type="button" className="dj-btn" aria-label="Poznámka hlasem" aria-pressed={placing === 'voice'} onClick={() => { cancelTool(); onVoice(); }} style={{ ...iconButton, ...(placing === 'voice' ? { color: '#fff', background: '#f43f5e' } : {}) }}><Mic size={18} /></button>
          <button type="button" className="dj-btn" aria-label="Přehrávání" disabled={!replayRange} onClick={() => { cancelTool(); startReplay(); }} style={{ ...iconButton, opacity: replayRange ? 1 : 0.35 }}><Play size={18} /></button>
          <button type="button" className="dj-btn" aria-label="Skrýt ovládání" onClick={() => setChromeHidden(true)} style={iconButton}><Maximize2 size={17} /></button>
        </div>
      )}

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
            <p style={sheetLabel}>Oblíbené</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginBottom: 14 }}>
              {DAY_DRAW_TOOLS.map(tool => {
                const Icon = tool.id === DAY_PATH_TOOL ? TOOL_BY_ID.get('Arrow')?.icon : TOOL_BY_ID.get(tool.id)?.icon;
                return (
                  <button key={tool.id} type="button" className="dj-btn" onClick={() => startTool(tool.id)} style={toolTile}>
                    {Icon && <Icon size={24} />}
                    <span style={{ fontSize: 11.5, fontWeight: 700 }}>{tool.label}</span>
                  </button>
                );
              })}
            </div>
            <p style={sheetLabel}>Všechny nástroje</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginBottom: 14 }}>
              {ALPHATRADE_DRAWING_TOOLS.map(tool => (
                <button key={tool.id} type="button" className="dj-btn" onClick={() => startTool(tool.id)} style={toolTile}>
                  <tool.icon size={22} />
                  <span style={{ fontSize: 10.5, fontWeight: 600, lineHeight: 1.15, textAlign: 'center' }}>{tool.title}</span>
                </button>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
              <button type="button" className="dj-btn" aria-pressed={magnet.mode !== 'off'} onClick={() => setDrawingMagnetSettings({ mode: magnet.mode === 'off' ? magnet.lastEnabledMode : 'off' })} style={{ ...sheetAction, ...(magnet.mode !== 'off' ? { color: 'var(--dj-indigo-text)', borderColor: 'rgba(99,102,241,0.45)', background: 'var(--dj-indigo-bg-soft)' } : {}) }}><Magnet size={16} />Magnet {magnet.mode === 'off' ? 'vyp.' : 'zap.'}</button>
              <button type="button" className="dj-btn" aria-pressed={locked} onClick={() => engine?.setLocked(!locked)} style={{ ...sheetAction, ...(locked ? { color: 'var(--dj-amber-text)', borderColor: 'rgba(245,158,11,0.45)', background: 'var(--dj-amber-bg-soft)' } : {}) }}>{locked ? <Lock size={16} /> : <Unlock size={16} />}{locked ? 'Zamčeno' : 'Zamknout'}</button>
              <button type="button" className="dj-btn" disabled={!manualCount} onClick={removeAll} style={{ ...sheetAction, color: 'var(--dj-rose)', opacity: manualCount ? 1 : 0.4 }}><Trash2 size={16} />Smazat vše</button>
            </div>
          </section>
        </div>
      )}

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
const floatButton: React.CSSProperties = { width: 50, height: 50, borderRadius: 99, display: 'grid', placeItems: 'center', cursor: 'pointer', padding: 0, color: 'var(--dj-text)', background: 'var(--dj-card)', border: '1px solid var(--dj-line)', boxShadow: '0 10px 26px -10px rgba(0,0,0,0.6)' };
const toolTile: React.CSSProperties = { minHeight: 64, padding: '8px 4px', borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', color: 'var(--dj-text)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5, cursor: 'pointer', fontFamily: 'inherit' };
const sheetLabel: React.CSSProperties = { margin: '0 0 7px', fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--dj-muted)' };
const sheetAction: React.CSSProperties = { height: 42, borderRadius: 12, border: '1px solid var(--dj-line)', background: 'transparent', color: 'var(--dj-text)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, font: '700 12px Inter, sans-serif', cursor: 'pointer' };
