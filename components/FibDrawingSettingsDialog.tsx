import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DrawingEngine } from '@getcandlekit/charts';
import { ArrowDownToLine, ArrowUpToLine, Copy, Eye, EyeOff, GripVertical, Lock, MoreHorizontal, RotateCcw, Settings, Trash2, Unlock, X } from 'lucide-react';
import TradingViewColorPicker from './TradingViewColorPicker';
import IndicatorTemplateMenu from './IndicatorTemplateMenu';
import {
  DEFAULT_FIB_SETTINGS,
  getFibSettings,
  normalizeFibSettings,
  updateFibDrawing,
  type FibDrawing,
  type FibLevelStyle,
  type FibLineStyle,
  type FibRetracementSettings,
  type FibVisibilityRange,
} from '../services/chartFibDrawing';

type Tab = 'style' | 'coordinates' | 'visibility';

const FIB_DIALOG_WIDTH = 440;

const clone = <T,>(value: T): T => (
  typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
);

const toLocalInput = (seconds: number) => {
  const date = new Date(seconds * 1000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

const fromLocalInput = (value: string, fallback: number) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : fallback;
};

const CheckRow: React.FC<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  children?: React.ReactNode;
}> = ({ checked, onChange, label, children }) => <div className="flex min-h-9 items-center gap-3 text-[13px] text-slate-800">
  <input type="checkbox" aria-label={label} checked={checked} onChange={event => onChange(event.target.checked)} className="h-5 w-5 accent-[#2962ff]" />
  <span>{label}</span>
  {children}
</div>;

const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement>> = props => <select
  {...props}
  className={`h-9 rounded-md border border-slate-300 bg-white px-2 text-[13px] text-slate-800 outline-none focus:border-[#2962ff] ${props.className ?? ''}`}
/>;

const Numeric: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = props => <input
  {...props}
  type="number"
  onWheel={event => event.currentTarget.blur()}
  className={`h-9 rounded-md border border-slate-300 bg-white px-2 text-[13px] text-slate-900 outline-none focus:border-[#2962ff] disabled:bg-slate-100 disabled:text-slate-400 ${props.className ?? ''}`}
/>;

const FibLevelEditor: React.FC<{
  level: FibLevelStyle;
  onChange: (level: FibLevelStyle) => void;
}> = ({ level, onChange }) => <div className="grid grid-cols-[18px_minmax(0,1fr)_40px] items-center gap-1.5">
  <input type="checkbox" checked={level.visible} onChange={event => onChange({ ...level, visible: event.target.checked })} className="h-[18px] w-[18px] accent-[#2962ff]" />
  <Numeric
    value={Number.isFinite(level.value) ? level.value : ''}
    step="0.001"
    disabled={!level.visible}
    onChange={event => onChange({ ...level, value: Number(event.target.value) })}
  />
  <TradingViewColorPicker
    value={level.color}
    opacity={level.opacity}
    onChange={(color, opacity) => onChange({ ...level, color, opacity })}
    label={`Barva úrovně ${level.value}`}
  />
</div>;

const VisibilityRow: React.FC<{
  label: string;
  value: FibVisibilityRange;
  onChange: (value: FibVisibilityRange) => void;
}> = ({ label, value, onChange }) => <div className="grid grid-cols-[22px_1fr_92px_92px] items-center gap-3">
  <input type="checkbox" checked={value.enabled} onChange={event => onChange({ ...value, enabled: event.target.checked })} className="h-5 w-5 accent-[#2962ff]" />
  <span className="text-[13px] text-slate-800">{label}</span>
  <Numeric value={value.min} min={1} disabled={!value.enabled} onChange={event => onChange({ ...value, min: Math.max(1, Number(event.target.value)) })} />
  <Numeric value={value.max} min={1} disabled={!value.enabled} onChange={event => onChange({ ...value, max: Math.max(1, Number(event.target.value)) })} />
</div>;

interface FibDrawingSettingsDialogProps {
  engine: DrawingEngine;
  drawing: FibDrawing;
  onClose: () => void;
}

export const FibDrawingSettingsDialog: React.FC<FibDrawingSettingsDialogProps> = ({ engine, drawing, onClose }) => {
  const originalSettingsRef = useRef(getFibSettings(drawing));
  const originalPointsRef = useRef(clone(drawing.points));
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [tab, setTab] = useState<Tab>('style');
  const [settings, setSettings] = useState(() => getFibSettings(drawing));
  const [points, setPoints] = useState(() => clone(drawing.points));
  const [position, setPosition] = useState(() => ({
    left: Math.max(16, Math.round((window.innerWidth - FIB_DIALOG_WIDTH) / 2)),
    top: Math.max(16, Math.round((window.innerHeight - 680) / 2)),
  }));

  const update = (next: FibRetracementSettings) => {
    const normalized = normalizeFibSettings(next);
    setSettings(normalized);
    updateFibDrawing(engine, drawing.id, normalized);
  };

  const updatePoints = (next: typeof points) => {
    setPoints(next);
    engine.setPoints(drawing.id, next);
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragRef.current) return;
      setPosition({
        left: Math.max(0, Math.min(window.innerWidth - FIB_DIALOG_WIDTH, dragRef.current.left + event.clientX - dragRef.current.x)),
        top: Math.max(0, Math.min(window.innerHeight - 80, dragRef.current.top + event.clientY - dragRef.current.y)),
      });
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, []);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      updateFibDrawing(engine, drawing.id, originalSettingsRef.current);
      engine.setPoints(drawing.id, originalPointsRef.current);
      onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [drawing.id, engine, onClose]);

  const cancel = () => {
    updateFibDrawing(engine, drawing.id, originalSettingsRef.current);
    engine.setPoints(drawing.id, originalPointsRef.current);
    onClose();
  };

  const levelRows = useMemo(() => {
    const rows: FibLevelStyle[][] = [];
    for (let index = 0; index < settings.levels.length; index += 2) rows.push(settings.levels.slice(index, index + 2));
    return rows;
  }, [settings.levels]);

  const setLevel = (index: number, level: FibLevelStyle) => update({
    ...settings,
    levels: settings.levels.map((item, itemIndex) => itemIndex === index ? level : item),
  });

  const setVisibility = (key: keyof Omit<FibRetracementSettings['visibility'], 'ticks' | 'ranges'>, value: FibVisibilityRange) => update({
    ...settings,
    visibility: { ...settings.visibility, [key]: value },
  });

  const tabButton = (id: Tab, label: string) => <button
    type="button"
    role="tab"
    aria-selected={tab === id}
    onClick={() => setTab(id)}
    className={`relative h-12 px-1 text-[14px] font-semibold ${tab === id ? 'text-slate-950 after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:rounded-full after:bg-[#2962ff]' : 'text-slate-600'}`}
  >{label}</button>;

  return <div className="pointer-events-none fixed inset-0 z-[650]" data-chart-settings-dialog="true">
    <section
      role="dialog"
      aria-label="Fibonacci retracement"
      className="pointer-events-auto absolute flex max-h-[min(760px,calc(100vh-24px))] w-[440px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl"
      style={position}
      onPointerDown={event => event.stopPropagation()}
      onWheelCapture={event => event.stopPropagation()}
    >
      <header
        className="flex h-14 shrink-0 cursor-move items-center gap-2 px-4"
        onPointerDown={event => {
          if ((event.target as Element).closest('button,input,select')) return;
          dragRef.current = { x: event.clientX, y: event.clientY, ...position };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
      >
        <GripVertical size={16} className="-ml-2 text-slate-400" />
        <h2 className="text-[20px] font-bold">Fib retracement</h2>
        <button type="button" onClick={cancel} className="ml-auto flex h-9 w-9 items-center justify-center rounded hover:bg-slate-100" aria-label="Zavřít nastavení Fibonacci"><X size={24} /></button>
      </header>
      <nav role="tablist" className="flex h-12 shrink-0 gap-7 border-b border-slate-200 px-4">
        {tabButton('style', 'Style')}
        {tabButton('coordinates', 'Coordinates')}
        {tabButton('visibility', 'Visibility')}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {tab === 'style' && <div className="space-y-4">
          <div className="grid grid-cols-[1fr_auto] items-center gap-4">
            <CheckRow checked={settings.trendLineVisible} onChange={checked => update({ ...settings, trendLineVisible: checked })} label="Trend line" />
            <div className="flex items-center gap-2 opacity-100">
              <TradingViewColorPicker value={settings.trendLineColor} opacity={settings.trendLineOpacity} onChange={(color, opacity) => update({ ...settings, trendLineColor: color, trendLineOpacity: opacity })} label="Barva trend line" />
              <Select value={settings.trendLineWidth} onChange={event => update({ ...settings, trendLineWidth: Number(event.target.value) })} disabled={!settings.trendLineVisible}>{[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}px</option>)}</Select>
              <Select value={settings.trendLineStyle} onChange={event => update({ ...settings, trendLineStyle: event.target.value as FibLineStyle })} disabled={!settings.trendLineVisible}><option value="solid">—</option><option value="dashed">– –</option><option value="dotted">···</option></Select>
            </div>
          </div>
          <div className="grid grid-cols-[1fr_auto] items-center gap-4">
            <span className="text-[13px] text-slate-800">Levels line</span>
            <div className="flex items-center gap-2">
              <Select value={settings.levelLineWidth} onChange={event => update({ ...settings, levelLineWidth: Number(event.target.value) })}>{[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}px</option>)}</Select>
              <Select value={settings.levelLineStyle} onChange={event => update({ ...settings, levelLineStyle: event.target.value as FibLineStyle })}><option value="solid">—</option><option value="dashed">– –</option><option value="dotted">···</option></Select>
            </div>
          </div>
          <div className="grid grid-cols-[1fr_180px] items-center gap-4">
            <span className="text-[13px] text-slate-800">Extend</span>
            <Select value={settings.extend} onChange={event => update({ ...settings, extend: event.target.value as FibRetracementSettings['extend'] })}>
              <option value="none">No extension</option><option value="left">Extend lines left</option><option value="right">Extend lines right</option><option value="both">Extend both sides</option>
            </Select>
          </div>
          <div className="space-y-2 border-y border-slate-200 py-3">
            {levelRows.map((row, rowIndex) => <div key={rowIndex} className="grid grid-cols-2 gap-3">
              {row.map((level, columnIndex) => {
                const index = rowIndex * 2 + columnIndex;
                return <FibLevelEditor key={index} level={level} onChange={next => setLevel(index, next)} />;
              })}
            </div>)}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <CheckRow checked={settings.oneColor} onChange={checked => update({ ...settings, oneColor: checked })} label="Use one color">
              <TradingViewColorPicker value={settings.oneColorValue} opacity={settings.oneColorOpacity} onChange={(color, opacity) => update({ ...settings, oneColorValue: color, oneColorOpacity: opacity })} label="Jedna barva všech úrovní" />
            </CheckRow>
            <CheckRow checked={settings.backgroundVisible} onChange={checked => update({ ...settings, backgroundVisible: checked })} label="Background">
              <Numeric className="w-16" min={0} max={100} value={settings.backgroundOpacity} onChange={event => update({ ...settings, backgroundOpacity: Number(event.target.value) })} />
            </CheckRow>
            <CheckRow checked={settings.reverse} onChange={checked => update({ ...settings, reverse: checked })} label="Reverse" />
            <CheckRow checked={settings.showPrices} onChange={checked => update({ ...settings, showPrices: checked })} label="Prices" />
            <CheckRow checked={settings.showLevels} onChange={checked => update({ ...settings, showLevels: checked })} label="Levels" />
            <CheckRow checked={settings.showText} onChange={checked => update({ ...settings, showText: checked })} label="Text" />
          </div>
          <div className="grid grid-cols-[1fr_120px_120px] items-center gap-3">
            <span className="text-[13px] text-slate-800">Labels</span>
            <Select value={settings.labelsPosition} onChange={event => update({ ...settings, labelsPosition: event.target.value as FibRetracementSettings['labelsPosition'] })}><option value="left">Left</option><option value="right">Right</option></Select>
            <Select value={settings.labelsVertical} onChange={event => update({ ...settings, labelsVertical: event.target.value as FibRetracementSettings['labelsVertical'] })}><option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option></Select>
          </div>
          <div className="grid grid-cols-[1fr_120px_120px] items-center gap-3">
            <input value={settings.text} disabled={!settings.showText} onChange={event => update({ ...settings, text: event.target.value })} placeholder="Text" className="h-9 rounded-md border border-slate-300 px-2 text-[13px] outline-none focus:border-[#2962ff] disabled:bg-slate-100" />
            <Select value={settings.textPosition} onChange={event => update({ ...settings, textPosition: event.target.value as FibRetracementSettings['textPosition'] })}><option value="left">Left</option><option value="right">Right</option></Select>
            <Select value={settings.textVertical} onChange={event => update({ ...settings, textVertical: event.target.value as FibRetracementSettings['textVertical'] })}><option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option></Select>
          </div>
          <div className="grid grid-cols-[1fr_120px] items-center gap-3"><span className="text-[13px] text-slate-800">Font size</span><Select value={settings.fontSize} onChange={event => update({ ...settings, fontSize: Number(event.target.value) })}>{[10, 11, 12, 14, 16, 20, 24, 28, 32, 40].map(value => <option key={value}>{value}</option>)}</Select></div>
          <CheckRow checked={settings.logScale} onChange={checked => update({ ...settings, logScale: checked })} label="Fib levels based on log scale" />
        </div>}
        {tab === 'coordinates' && <div className="space-y-5">
          {points.slice(0, 2).map((point, index) => <fieldset key={index} className="rounded-md border border-slate-200 p-4">
            <legend className="px-2 text-[12px] font-semibold text-slate-500">#{index + 1} (price, time)</legend>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1"><span className="text-[11px] text-slate-500">Price</span><Numeric step="0.25" value={point.price} onChange={event => updatePoints(points.map((item, itemIndex) => itemIndex === index ? { ...item, price: Number(event.target.value) } : item))} /></label>
              <label className="space-y-1"><span className="text-[11px] text-slate-500">Time</span><input type="datetime-local" value={toLocalInput(point.time)} onChange={event => updatePoints(points.map((item, itemIndex) => itemIndex === index ? { ...item, time: fromLocalInput(event.target.value, item.time) } : item))} className="h-9 w-full rounded-md border border-slate-300 px-2 text-[13px] outline-none focus:border-[#2962ff]" /></label>
            </div>
          </fieldset>)}
        </div>}
        {tab === 'visibility' && <div className="space-y-4 py-1">
          <CheckRow checked={settings.visibility.ticks} onChange={checked => update({ ...settings, visibility: { ...settings.visibility, ticks: checked } })} label="Ticks" />
          <VisibilityRow label="Seconds" value={settings.visibility.seconds} onChange={value => setVisibility('seconds', value)} />
          <VisibilityRow label="Minutes" value={settings.visibility.minutes} onChange={value => setVisibility('minutes', value)} />
          <VisibilityRow label="Hours" value={settings.visibility.hours} onChange={value => setVisibility('hours', value)} />
          <VisibilityRow label="Days" value={settings.visibility.days} onChange={value => setVisibility('days', value)} />
          <VisibilityRow label="Weeks" value={settings.visibility.weeks} onChange={value => setVisibility('weeks', value)} />
          <VisibilityRow label="Months" value={settings.visibility.months} onChange={value => setVisibility('months', value)} />
          <CheckRow checked={settings.visibility.ranges} onChange={checked => update({ ...settings, visibility: { ...settings.visibility, ranges: checked } })} label="Ranges" />
        </div>}
      </div>
      <footer className="flex h-16 shrink-0 items-center border-t border-slate-200 px-4">
        <IndicatorTemplateMenu indicator="drawing:fib-retracement" value={settings} defaultValue={DEFAULT_FIB_SETTINGS} onApply={value => update(normalizeFibSettings(value as FibRetracementSettings))} />
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={cancel} className="h-9 rounded-md border border-slate-300 px-5 text-[13px] font-semibold hover:bg-slate-50">Cancel</button>
          <button type="button" onClick={onClose} className="h-9 rounded-md bg-[#2962ff] px-5 text-[13px] font-semibold text-white hover:bg-[#1e53d8]">Ok</button>
        </div>
      </footer>
    </section>
  </div>;
};

export const FibDrawingFloatingToolbar: React.FC<{
  engine: DrawingEngine;
  drawing: FibDrawing;
  onOpenSettings: () => void;
}> = ({ engine, drawing, onOpenSettings }) => {
  const settings = getFibSettings(drawing);
  const [moreOpen, setMoreOpen] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarDragRef = useRef<{
    pointerX: number;
    pointerY: number;
    left: number;
    top: number;
    maxLeft: number;
    maxTop: number;
  } | null>(null);
  const [toolbarPosition, setToolbarPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = toolbarDragRef.current;
      if (!drag) return;
      setToolbarPosition({
        left: Math.max(4, Math.min(drag.maxLeft, drag.left + event.clientX - drag.pointerX)),
        top: Math.max(4, Math.min(drag.maxTop, drag.top + event.clientY - drag.pointerY)),
      });
    };
    const stop = () => { toolbarDragRef.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  const startToolbarDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const toolbar = toolbarRef.current;
    const parent = toolbar?.offsetParent as HTMLElement | null;
    if (!toolbar || !parent) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = toolbar.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const left = rect.left - parentRect.left;
    const top = rect.top - parentRect.top;
    setToolbarPosition({ left, top });
    toolbarDragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left,
      top,
      maxLeft: Math.max(4, parent.clientWidth - rect.width - 4),
      maxTop: Math.max(4, parent.clientHeight - rect.height - 4),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const duplicate = () => {
    const copy = clone(drawing);
    copy.id = engine.newDrawingId();
    copy.points = copy.points.map(point => ({ ...point, time: point.time + 60 }));
    engine.commit(copy);
  };
  const toolbarButton = 'flex h-7 min-w-7 items-center justify-center rounded px-1 text-slate-700 hover:bg-slate-100';
  const moveLayer = (direction: 'front' | 'back') => {
    const drawings = [...engine.getDrawings()];
    const index = drawings.findIndex(item => item.id === drawing.id);
    if (index < 0) return;
    const [item] = drawings.splice(index, 1);
    if (direction === 'front') drawings.push(item);
    else drawings.unshift(item);
    engine.import(JSON.stringify(drawings));
    engine.select(drawing.id);
    setMoreOpen(false);
  };
  return <div ref={toolbarRef} className={`absolute z-[120] flex items-center gap-0 rounded-md border border-slate-300 bg-white p-0.5 shadow-md ${toolbarPosition ? '' : 'left-1/2 top-1 -translate-x-1/2'}`} style={toolbarPosition ?? undefined} role="toolbar" aria-label="Nástroje Fibonacci">
    <button type="button" aria-label="Přesunout nástroje Fibonacci" title="Přesunout" onPointerDown={startToolbarDrag} className="flex h-7 w-5 shrink-0 cursor-move touch-none items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"><GripVertical size={13} strokeWidth={1.5} /></button>
    <IndicatorTemplateMenu compact placement="bottom" indicator="drawing:fib-retracement" value={settings} defaultValue={DEFAULT_FIB_SETTINGS} onApply={value => updateFibDrawing(engine, drawing.id, normalizeFibSettings(value as FibRetracementSettings))} />
    <TradingViewColorPicker compact value={settings.oneColor ? settings.oneColorValue : settings.levels.find(level => level.visible)?.color ?? '#2962ff'} opacity={settings.oneColor ? settings.oneColorOpacity : 100} onChange={(color, opacity) => updateFibDrawing(engine, drawing.id, { ...settings, oneColor: true, oneColorValue: color, oneColorOpacity: opacity })} label="Barva Fibonacci" />
    <Select className="h-7 px-1 text-[11px]" aria-label="Tloušťka Fibonacci čar" value={settings.levelLineWidth} onChange={event => updateFibDrawing(engine, drawing.id, { ...settings, levelLineWidth: Number(event.target.value) })}>{[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}px</option>)}</Select>
    <button type="button" className={toolbarButton} onClick={onOpenSettings} title="Settings" aria-label="Nastavení Fibonacci"><Settings size={14} /></button>
    <button type="button" className={toolbarButton} onClick={() => {
      const next = { ...settings, locked: !settings.locked };
      updateFibDrawing(engine, drawing.id, next);
    }} title={settings.locked ? 'Unlock' : 'Lock'}>{settings.locked ? <Lock size={14} /> : <Unlock size={14} />}</button>
    <button type="button" className={toolbarButton} onClick={() => engine.remove(drawing.id)} title="Remove"><Trash2 size={14} /></button>
    <div className="relative">
      <button type="button" className={toolbarButton} title="More" aria-expanded={moreOpen} onClick={() => setMoreOpen(open => !open)}><MoreHorizontal size={14} /></button>
      {moreOpen && <div role="menu" className="absolute right-0 top-8 w-48 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-xl">
        <button type="button" role="menuitem" onClick={() => { updateFibDrawing(engine, drawing.id, { ...settings, hidden: !settings.hidden }); setMoreOpen(false); }} className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-slate-100">{settings.hidden ? <Eye size={15} /> : <EyeOff size={15} />} {settings.hidden ? 'Show' : 'Hide'}</button>
        <button type="button" role="menuitem" onClick={() => { duplicate(); setMoreOpen(false); }} className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-slate-100"><Copy size={15} /> Duplicate</button>
        <button type="button" role="menuitem" onClick={() => moveLayer('front')} className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-slate-100"><ArrowUpToLine size={15} /> Bring to front</button>
        <button type="button" role="menuitem" onClick={() => moveLayer('back')} className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-slate-100"><ArrowDownToLine size={15} /> Send to back</button>
        <button type="button" role="menuitem" onClick={() => { updateFibDrawing(engine, drawing.id, DEFAULT_FIB_SETTINGS); setMoreOpen(false); }} className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-slate-100"><RotateCcw size={15} /> Apply defaults</button>
      </div>}
    </div>
  </div>;
};

export default FibDrawingSettingsDialog;
