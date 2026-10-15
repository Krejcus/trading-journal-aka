import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { Drawing, DrawingToolId } from '@getcandlekit/charts';
import { Check, ChevronDown, Magnet, Maximize2, Mic, Minimize2, PenLine, RotateCcw, Trash2, X } from 'lucide-react';
import type { Trade } from '../../types';
import CandleKitTradeChart from '../CandleKitTradeChart';
import { QuantumSpinner } from '../QuantumLoader';
import { aggregateCandles, MARKET_TIMEFRAME_MINUTES, type MarketTimeframe } from '../../services/marketData';
import { onTradeChartIndicatorsChange, readTradeChartIndicators, writeTradeChartIndicators } from '../../services/detailIndicators';
import { tradeChartTiming } from '../../services/tradeChartData';
import { getDrawingMagnetSettings, setDrawingMagnetSettings, subscribeDrawingMagnetSettings } from '../../services/chartDrawingMagnet';
import { setNativeShellTabBarHidden } from '../../utils/nativeShell';
import { DAY_DRAW_COLORS, DAY_DRAW_TOOLS, DAY_PATH_TOOL, dayDrawColorOf, dayDrawStyle, lastManualDrawingId, nextDayChartTimeframe, pathGroupOf, pathSegmentIds, type DayDrawColorId } from '../../lib/dayChartTools';
import DayNotesLayer, { type DayBand, type DayPinPoint, type DayPinView } from './DayNotesLayer';
import DayTouchDrawLayer from './DayTouchDrawLayer';
import { dayAnchorTrade, focusTarget, useReviewFocus } from './dayFocus';
import { LiveChip, ScopeSwitch, dayTitle } from './DayPanels';
import type { DayController } from './useDayController';

type DrawingEngine = NonNullable<ChartViewApi['drawing']>['engine'];

/**
 * Graf dne přes celou obrazovku telefonu (docs/DAY_CHART_PHONE_FULLSCREEN.md).
 * Hlavička na jeden řádek, graf, spodní pruh se dvěma režimy (normální /
 * kreslení) jako v mobilním TradingView. Kresby jdou do stejného klíče jako
 * na desktopu (`day:<den>`, scope `day` = společné pro všechny timeframy).
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
  const [drawing, setDrawing] = useState(false);
  const [activeTool, setActiveTool] = useState<DrawingToolId | null>(null);
  const [selected, setSelected] = useState<Drawing | null>(null);
  const [manualCount, setManualCount] = useState(0);
  const [colorId, setColorId] = useState<DayDrawColorId>('neutral');
  const [magnet, setMagnet] = useState(getDrawingMagnetSettings);
  useEffect(() => subscribeDrawingMagnetSettings(setMagnet), []);
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Na výšku (375–430 px) se do pruhů nevejde všechno: zkrácené popisky, bez živého chipu.
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 440);
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 440));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ── Svíčky a záběr (stejné jako kompaktní graf) ───────────────────────
  const raw = ctl.chart.candles;
  const candles = useMemo(() => aggregateCandles(raw, timeframe), [raw, timeframe]);
  const barTimes = useMemo(() => candles.map(candle => candle.time), [candles]);
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
  const engine: DrawingEngine | null = api?.drawing?.engine ?? null;
  useEffect(() => {
    if (!engine) return;
    const sync = () => {
      setActiveTool(engine.getActiveTool());
      const id = engine.getSelectedId();
      setSelected(id ? engine.getById(id) ?? null : null);
      setManualCount(engine.getDrawings().filter(item => !item.id.startsWith('auto-')).length);
    };
    sync();
    return engine.onChange(sync);
  }, [engine]);
  // Cesta (Šipka) je virtuální nástroj: vede ji dotyková vrstva, motor
  // dostává jen hotové úseky. Chip svítí přes `pathActive`.
  const [pathActive, setPathActive] = useState(false);
  const endPath = useCallback(() => setPathActive(false), []);
  const pathStyle = useMemo(() => ({ color: dayDrawStyle(colorId, 'Arrow').color, width: 2 }), [colorId]);
  const startTool = useCallback((tool: DrawingToolId) => {
    if (!engine) return;
    onCancelPlacing();
    if (tool === DAY_PATH_TOOL) {
      engine.stopTool();
      engine.select(null);
      setPathActive(active => !active);
      return;
    }
    setPathActive(false);
    if (engine.getActiveTool() === tool) { engine.stopTool(); return; }
    engine.setDefaultStyle(dayDrawStyle(colorId, tool));
    engine.startTool(tool);
  }, [colorId, engine, onCancelPlacing]);
  const selectedGroup = pathGroupOf(selected?.id);
  const pickColor = (id: DayDrawColorId) => {
    setColorId(id);
    if (!engine) return;
    if (selected) {
      const ids = selectedGroup ? pathSegmentIds(engine.getDrawings(), selectedGroup) : [selected.id];
      for (const drawingId of ids) engine.setStyle(drawingId, dayDrawStyle(id, engine.getById(drawingId)?.tool));
    }
    engine.setDefaultStyle(dayDrawStyle(id, engine.getActiveTool()));
  };
  const removeSelected = () => {
    if (!engine || !selected) return;
    const ids = selectedGroup ? pathSegmentIds(engine.getDrawings(), selectedGroup) : [selected.id];
    for (const drawingId of ids) engine.remove(drawingId);
  };
  const undo = () => {
    if (!engine) return;
    const id = lastManualDrawingId(engine.getDrawings());
    if (id) engine.remove(id);
  };
  const finishDrawing = () => {
    setPathActive(false);
    engine?.stopTool();
    engine?.select(null);
    onCancelPlacing();
    setDrawing(false);
  };
  const toggleIndicator = (id: 'fvg' | 'levels' | 'structure') => writeTradeChartIndicators({ ...indicators, [id]: !indicators[id] });
  const indicatorCount = Number(indicators.levels) + Number(indicators.fvg) + Number(indicators.structure);
  const selectedColor = selected ? dayDrawColorOf(selected.style.color) : null;

  const bar: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px calc(6px + env(safe-area-inset-bottom, 0px))', borderTop: '1px solid var(--dj-line)', background: 'var(--dj-card)', flex: 'none', minHeight: 52 };

  return createPortal(
    <div ref={rootRef} className="dj" role="dialog" aria-label="Graf dne na celou obrazovku" style={{ position: 'fixed', inset: 0, zIndex: 880, display: 'flex', flexDirection: 'column', background: 'var(--dj-bg)', color: 'var(--dj-text)', paddingTop: chromeHidden ? 0 : 'env(safe-area-inset-top, 0px)', animation: 'dj-fade .18s ease both' }}>
      {!chromeHidden && (
        <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px 6px 14px', flex: 'none', borderBottom: '1px solid var(--dj-line)', background: 'var(--dj-card)' }}>
          <span style={{ fontSize: 13.5, fontWeight: 800, whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>MNQ · {timeframe} · {dayTitle(ctl.day)}</span>
          <button type="button" className="dj-btn" aria-expanded={indicatorsOpen} aria-label="Indikátory" onClick={() => setIndicatorsOpen(open => !open)} style={{ ...chip, gap: 3, flex: 'none' }}>
            <ChevronDown size={12} style={{ transform: indicatorsOpen ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }} /> {indicatorCount}
          </button>
          <span style={{ flex: 1 }} />
          {!narrow && <LiveChip status={ctl.chart.liveStatus} capturedAt={ctl.chart.liveCapturedAt} />}
          <button type="button" className="dj-btn" aria-label="Zavřít" onClick={onClose} style={{ ...iconButton, border: '1px solid var(--dj-line)' }}><X size={18} /></button>
        </header>
      )}
      {!chromeHidden && indicatorsOpen && (
        <div style={{ display: 'flex', gap: 6, padding: '6px 14px', flex: 'none', borderBottom: '1px solid var(--dj-line)', background: 'var(--dj-card)' }}>
          {([['levels', 'Úrovně'], ['fvg', 'FVG'], ['structure', 'Struktura']] as const).map(([id, label]) => (
            <button key={id} type="button" className="dj-btn" aria-pressed={indicators[id]} onClick={() => toggleIndicator(id)} style={{ ...chip, border: indicators[id] ? '1px solid var(--dj-line)' : '1px dashed var(--dj-line)', background: indicators[id] ? 'var(--dj-chip)' : 'transparent', color: indicators[id] ? 'var(--dj-text)' : 'var(--dj-muted)' }}>{label}</button>
          ))}
        </div>
      )}

      <div ref={containerRef} style={{ position: 'relative', flex: 1, minHeight: 0, background: isDark ? '#05080f' : '#fff' }}>
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
        <DayNotesLayer
          chartApi={api}
          containerRef={containerRef}
          barTimes={barTimes}
          intervalSeconds={MARKET_TIMEFRAME_MINUTES[timeframe] * 60}
          pins={pins}
          selectedId={ctl.selected?.kind === 'note' ? ctl.selected.id : null}
          onSelect={id => ctl.setSelected(id ? { kind: 'note', id } : null)}
          bubbles={bubbles}
          placing={placing}
          placingHint="Ťukni, kam to patří"
          onPick={onPick}
          onCancelPlacing={onCancelPlacing}
          pending={pending}
          nowTime={nowTime}
          bands={bands}
        />
        <DayTouchDrawLayer chartApi={api} containerRef={containerRef} enabled={drawing && !placing} pathActive={pathActive} pathStyle={pathStyle} onPathEnd={endPath} />
        {/* Lišta vybrané kresby: barva, koš (jako plovoucí lišta v TradingView, jen nahoře uprostřed). */}
        {drawing && selected && (
          <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 25, display: 'flex', alignItems: 'center', gap: 6, padding: 6, borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-card)', boxShadow: '0 12px 30px -12px rgba(0,0,0,0.6)', animation: 'dj-rise .18s ease both' }}>
            {DAY_DRAW_COLORS.map(item => (
              <button key={item.id} type="button" className="dj-btn" aria-label={item.label} aria-pressed={selectedColor === item.id} onClick={() => pickColor(item.id)} style={{ width: 32, height: 32, borderRadius: 9, border: selectedColor === item.id ? '2px solid var(--dj-text)' : '2px solid transparent', background: item.color, cursor: 'pointer', padding: 0 }} />
            ))}
            <span style={{ width: 1, height: 22, background: 'var(--dj-line)', margin: '0 2px' }} />
            <button type="button" className="dj-btn" aria-label={selectedGroup ? 'Smazat cestu' : 'Smazat kresbu'} onClick={removeSelected} style={{ ...iconButton, color: 'var(--dj-rose)' }}><Trash2 size={16} /></button>
          </div>
        )}
        {chromeHidden && (
          <button type="button" className="dj-btn" aria-label="Zobrazit ovládání" onClick={() => setChromeHidden(false)} style={{ position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 8px)', right: 10, zIndex: 25, ...iconButton, background: 'var(--dj-card)', border: '1px solid var(--dj-line)', opacity: 0.85 }}><Minimize2 size={16} /></button>
        )}
      </div>

      {!chromeHidden && !drawing && (
        <div style={bar}>
          <div style={{ flex: narrow ? 1 : 'none', minWidth: 0 }}><ScopeSwitch ctl={ctl} fill={narrow} /></div>
          <button type="button" className="dj-btn" aria-label={`Timeframe ${timeframe}, další`} onClick={() => onTimeframe(nextDayChartTimeframe(timeframe))} style={{ ...chip, minWidth: 44, justifyContent: 'center', fontWeight: 800, flex: 'none' }}>{timeframe}</button>
          {!narrow && <span style={{ flex: 1 }} />}
          <button type="button" className="dj-btn" aria-label="Kreslit" onClick={() => setDrawing(true)} style={iconButton}><PenLine size={18} /></button>
          <button type="button" className="dj-btn" aria-label="Poznámka hlasem" aria-pressed={placing === 'voice'} onClick={onVoice} style={{ ...iconButton, ...(placing === 'voice' ? { color: '#fff', background: '#f43f5e' } : {}) }}><Mic size={18} /></button>
          <button type="button" className="dj-btn" aria-label="Skrýt ovládání" onClick={() => setChromeHidden(true)} style={iconButton}><Maximize2 size={17} /></button>
        </div>
      )}
      {!chromeHidden && drawing && (
        <div style={{ ...bar, gap: narrow ? 4 : 6 }}>
          {DAY_DRAW_TOOLS.map(tool => (
            <button key={tool.id} type="button" className="dj-btn" aria-pressed={tool.virtual ? pathActive : activeTool === tool.id} onClick={() => startTool(tool.id)} style={{ ...chip, height: 36, padding: narrow ? '0 6px' : '0 10px', fontSize: narrow ? 11.5 : 12, flex: 'none', ...((tool.virtual ? pathActive : activeTool === tool.id) ? { color: 'var(--dj-seg-on-ink)', background: 'var(--dj-seg-on)' } : {}) }}>{tool.label}</button>
          ))}
          <button type="button" className="dj-btn" aria-label="Poznámka do grafu" aria-pressed={placing === 'note'} onClick={() => { setPathActive(false); engine?.stopTool(); ctl.setPendingPoint(null); ctl.setPlacing(placing === 'note' ? null : 'note'); }} style={{ ...chip, height: 36, padding: narrow ? '0 6px' : '0 10px', fontSize: narrow ? 11.5 : 12, flex: 'none', ...(placing === 'note' ? { color: '#1c1203', background: '#fbbf24' } : {}) }}>Pozn.</button>
          <span style={{ flex: 1 }} />
          <button type="button" className="dj-btn" aria-label={`Magnet ${magnet.mode === 'off' ? 'vypnutý' : 'zapnutý'}`} aria-pressed={magnet.mode !== 'off'} onClick={() => setDrawingMagnetSettings({ mode: magnet.mode === 'off' ? magnet.lastEnabledMode : 'off' })} style={{ ...iconButton, width: 36, ...(magnet.mode !== 'off' ? { color: 'var(--dj-indigo)', background: 'var(--dj-indigo-bg-soft)' } : {}) }}><Magnet size={17} /></button>
          <button type="button" className="dj-btn" aria-label="Vrátit poslední kresbu" disabled={!manualCount} onClick={undo} style={{ ...iconButton, width: 36, opacity: manualCount ? 1 : 0.35 }}><RotateCcw size={16} /></button>
          <button type="button" className="dj-btn" aria-label="Hotovo" onClick={finishDrawing} style={{ ...iconButton, width: 44, color: '#fff', background: 'linear-gradient(180deg,#6366f1,#4f46e5)' }}><Check size={20} strokeWidth={2.6} /></button>
        </div>
      )}
    </div>,
    document.body,
  );
}

const chip: React.CSSProperties = { height: 30, padding: '0 9px', borderRadius: 9, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', color: 'var(--dj-text)', display: 'inline-flex', alignItems: 'center', gap: 5, font: '700 12px Inter, sans-serif', cursor: 'pointer', whiteSpace: 'nowrap' };
const iconButton: React.CSSProperties = { width: 40, height: 40, borderRadius: 11, border: 0, background: 'transparent', color: 'var(--dj-text-2)', display: 'grid', placeItems: 'center', cursor: 'pointer', padding: 0, flex: 'none' };
