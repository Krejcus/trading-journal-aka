import React, { useEffect, useRef, useState } from 'react';
import type { DrawingEngine, DrawingStyle } from '@getcandlekit/charts';
import { GripVertical, Settings, Trash2, X } from 'lucide-react';
import TradingViewColorPicker, { colorWithAlpha, splitColorAlpha } from './TradingViewColorPicker';
import IndicatorTemplateMenu from './IndicatorTemplateMenu';
import {
  calculatePositionMetrics,
  normalizePositionSettings,
  type PositionDrawing,
  type PositionDrawingSettings,
  type PositionDrawingStyle,
} from '../services/chartPositionDrawing';
import { rememberDrawingStyleDefault } from '../services/chartDrawingStyleDefaults';

type Tab = 'inputs' | 'style' | 'visibility';
const DIALOG_WIDTH = 500;
const clone = <T,>(value: T): T => typeof structuredClone === 'function'
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const Numeric: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = props => <input
  {...props}
  type="number"
  onWheel={event => { event.stopPropagation(); event.currentTarget.blur(); }}
  className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-right text-[13px] text-slate-900 outline-none focus:border-[#2962ff]"
/>;

interface Props {
  engine: DrawingEngine;
  drawing: PositionDrawing;
  onClose: () => void;
}

export const PositionDrawingFloatingToolbar: React.FC<Props & { onOpenSettings: () => void }> = ({
  engine, drawing, onOpenSettings,
}) => {
  const settings = normalizePositionSettings(drawing.style.position);
  const setPosition = (patch: Partial<PositionDrawingSettings>) => engine.setStyle(drawing.id, {
    position: { ...settings, ...patch },
  } as Partial<DrawingStyle>);
  return <div
    role="toolbar"
    aria-label={`${drawing.tool === 'LongPosition' ? 'Long' : 'Short'} position tools`}
    data-chart-overlay-menu
    className="absolute left-1/2 top-1 z-[121] flex -translate-x-1/2 items-center gap-0.5 rounded-md border border-[#d1d4dc] bg-white p-0.5 shadow-md"
    onPointerDown={event => event.stopPropagation()}
  >
    <IndicatorTemplateMenu
      compact
      placement="bottom"
      indicator={`drawing:${drawing.tool}`}
      value={drawing.style}
      defaultValue={drawing.style}
      onApply={value => engine.setStyle(drawing.id, value as DrawingStyle)}
    />
    <TradingViewColorPicker compact value={splitColorAlpha(settings.targetColor).color} opacity={splitColorAlpha(settings.targetColor).opacity} label="Target color" onChange={(color, opacity) => setPosition({ targetColor: colorWithAlpha(color, opacity) })} />
    <TradingViewColorPicker compact value={splitColorAlpha(settings.stopColor).color} opacity={splitColorAlpha(settings.stopColor).opacity} label="Stop color" onChange={(color, opacity) => setPosition({ stopColor: colorWithAlpha(color, opacity) })} />
    <button type="button" className="flex h-7 w-7 items-center justify-center rounded hover:bg-[#f0f3fa]" onClick={onOpenSettings} aria-label="Position settings"><Settings size={14} strokeWidth={1.35} /></button>
    <button type="button" className="flex h-7 w-7 items-center justify-center rounded hover:bg-[#f0f3fa]" onClick={() => engine.remove(drawing.id)} aria-label="Delete position"><Trash2 size={14} strokeWidth={1.35} /></button>
  </div>;
};

const PositionDrawingSettingsDialog: React.FC<Props> = ({ engine, drawing, onClose }) => {
  const originalStyle = useRef(clone(drawing.style));
  const originalPoints = useRef(clone(drawing.points));
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [tab, setTab] = useState<Tab>('inputs');
  const [style, setStyleState] = useState<PositionDrawingStyle>(() => clone(drawing.style));
  const [points, setPointsState] = useState(() => clone(drawing.points));
  const [position, setPosition] = useState(() => ({
    left: Math.max(12, Math.round((window.innerWidth - DIALOG_WIDTH) / 2)),
    top: Math.max(12, Math.round((window.innerHeight - 600) / 2)),
  }));
  const settings = normalizePositionSettings(style.position);
  const metrics = calculatePositionMetrics({ points, style });

  const setStyle = (patch: Partial<PositionDrawingSettings>) => {
    const next = { ...style, position: { ...settings, ...patch } };
    setStyleState(next);
    engine.setStyle(drawing.id, { position: next.position } as Partial<DrawingStyle>);
  };
  const setPointPrice = (index: number, price: number) => {
    if (!Number.isFinite(price)) return;
    const snappedPrice = Math.round(price / settings.tickSize) * settings.tickSize;
    const next = points.map((point, pointIndex) => pointIndex === index ? { ...point, price: snappedPrice } : point);
    setPointsState(next);
    engine.setPoints(drawing.id, next);
  };
  const cancel = () => {
    engine.setStyle(drawing.id, originalStyle.current);
    engine.setPoints(drawing.id, originalPoints.current);
    onClose();
  };
  const apply = () => {
    rememberDrawingStyleDefault(drawing.tool, style as DrawingStyle);
    onClose();
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!drag.current) return;
      setPosition({
        left: Math.max(0, Math.min(window.innerWidth - DIALOG_WIDTH, drag.current.left + event.clientX - drag.current.x)),
        top: Math.max(0, Math.min(window.innerHeight - 80, drag.current.top + event.clientY - drag.current.y)),
      });
    };
    const stop = () => { drag.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
  }, []);

  const color = (key: 'lineColor' | 'targetColor' | 'stopColor' | 'textColor', label: string) => {
    const current = splitColorAlpha(settings[key]);
    return <TradingViewColorPicker value={current.color} opacity={current.opacity} label={label} onChange={(next, opacity) => setStyle({ [key]: colorWithAlpha(next, opacity) })} />;
  };
  const tabButton = (id: Tab, label: string) => <button type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`relative h-11 text-[13px] font-semibold ${tab === id ? 'text-slate-950 after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:bg-[#2962ff]' : 'text-slate-600'}`}>{label}</button>;
  const field = (label: string, node: React.ReactNode) => <div className="grid grid-cols-[1fr_190px] items-center gap-4"><span className="text-[13px] text-slate-800">{label}</span>{node}</div>;
  const checkbox = (label: string, key: keyof PositionDrawingSettings) => <label className="flex items-center gap-3 text-[13px] text-slate-800"><input type="checkbox" checked={Boolean(settings[key])} onChange={event => setStyle({ [key]: event.target.checked } as Partial<PositionDrawingSettings>)} className="h-4 w-4 accent-[#2962ff]" />{label}</label>;

  return <div className="pointer-events-none fixed inset-0 z-[650]" data-chart-settings-dialog="true">
    <section role="dialog" aria-label={`${drawing.tool === 'LongPosition' ? 'Long' : 'Short'} position settings`} className="pointer-events-auto absolute flex max-h-[min(680px,calc(100vh-24px))] w-[500px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl" style={position} onPointerDown={event => event.stopPropagation()} onWheelCapture={event => event.stopPropagation()}>
      <header className="flex h-14 shrink-0 cursor-move items-center gap-2 px-4" onPointerDown={event => {
        if ((event.target as Element).closest('button,input,select')) return;
        drag.current = { x: event.clientX, y: event.clientY, ...position };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}><GripVertical size={16} className="-ml-2 text-slate-400" /><h2 className="text-[19px] font-bold">{drawing.tool === 'LongPosition' ? 'Long position' : 'Short position'}</h2><button type="button" onClick={cancel} className="ml-auto flex h-9 w-9 items-center justify-center rounded hover:bg-slate-100" aria-label="Close position settings"><X size={23} /></button></header>
      <nav role="tablist" className="flex h-11 shrink-0 gap-8 border-b border-slate-200 px-4">{tabButton('inputs', 'Inputs')}{tabButton('style', 'Style')}{tabButton('visibility', 'Visibility')}</nav>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {tab === 'inputs' && <>
          {field('Account size', <Numeric value={settings.accountSize} onChange={event => setStyle({ accountSize: Number(event.target.value) })} />)}
          {field('Lot size', <Numeric value={settings.lotSize} step="0.01" onChange={event => setStyle({ lotSize: Number(event.target.value) })} />)}
          {field('Risk', <div className="grid grid-cols-[1fr_68px] gap-2"><Numeric value={settings.risk} onChange={event => setStyle({ risk: Number(event.target.value) })} /><select value={settings.riskMode} onChange={event => setStyle({ riskMode: event.target.value as PositionDrawingSettings['riskMode'] })} className="rounded-md border border-slate-300 bg-white px-2 text-[13px]"><option value="USD">USD</option><option value="percent">%</option></select></div>)}
          {field('Entry price', <Numeric value={points[0]?.price ?? 0} step={settings.tickSize} onChange={event => setPointPrice(0, Number(event.target.value))} />)}
          {field('Leverage', <Numeric value={settings.leverage} step="1" onChange={event => setStyle({ leverage: Number(event.target.value) })} />)}
          <div className="border-t border-slate-200 pt-3 text-[12px] font-semibold text-slate-500">Profit level</div>
          {field('Ticks', <Numeric value={metrics?.targetTicks.toFixed(0) ?? 0} readOnly />)}
          {field('Price', <Numeric value={points[1]?.price ?? 0} step={settings.tickSize} onChange={event => setPointPrice(1, Number(event.target.value))} />)}
          <div className="border-t border-slate-200 pt-3 text-[12px] font-semibold text-slate-500">Stop level</div>
          {field('Ticks', <Numeric value={metrics?.stopTicks.toFixed(0) ?? 0} readOnly />)}
          {field('Price', <Numeric value={points[2]?.price ?? 0} step={settings.tickSize} onChange={event => setPointPrice(2, Number(event.target.value))} />)}
          {field('QTY precision', <select value={settings.qtyPrecision ?? 'default'} onChange={event => setStyle({ qtyPrecision: event.target.value === 'default' ? null : Number(event.target.value) })} className="h-9 rounded-md border border-slate-300 bg-white px-2 text-[13px]"><option value="default">Default</option>{[0,1,2,3,4,5].map(value => <option key={value} value={value}>{value}</option>)}</select>)}
        </>}
        {tab === 'style' && <>
          {field('Lines', color('lineColor', 'Line color'))}
          {field('Stop', color('stopColor', 'Stop color'))}
          {field('Target', color('targetColor', 'Target color'))}
          {field('Text', <div className="flex gap-2">{color('textColor', 'Text color')}<select value={settings.fontSize} onChange={event => setStyle({ fontSize: Number(event.target.value) })} className="h-9 rounded-md border border-slate-300 bg-white px-2 text-[13px]">{[9,10,11,12,14,16].map(value => <option key={value}>{value}</option>)}</select></div>)}
          <div className="space-y-3 border-t border-slate-200 pt-4">{checkbox('Price labels', 'priceLabels')}{checkbox('Stats', 'stats')}{checkbox('Compact stats mode', 'compactStats')}{checkbox('Always show stats', 'alwaysShowStats')}</div>
        </>}
        {tab === 'visibility' && <div className="space-y-3"><label className="flex items-center gap-3 text-[13px] text-slate-800"><input type="checkbox" checked readOnly className="h-4 w-4 accent-[#2962ff]" />All intervals</label><p className="text-[12px] text-slate-500">Position je viditelná na všech timeframes uloženého layoutu.</p></div>}
      </div>
      <footer className="flex h-16 shrink-0 items-center border-t border-slate-200 px-4"><IndicatorTemplateMenu indicator={`drawing:${drawing.tool}`} value={style} defaultValue={originalStyle.current} onApply={value => { setStyleState(value as PositionDrawingStyle); engine.setStyle(drawing.id, value as DrawingStyle); }} /><button type="button" onClick={cancel} className="ml-auto h-10 rounded-md border border-slate-300 px-5 text-[13px] font-semibold">Cancel</button><button type="button" onClick={apply} className="ml-2 h-10 rounded-md bg-[#2962ff] px-5 text-[13px] font-semibold text-white">Ok</button></footer>
    </section>
  </div>;
};

export default PositionDrawingSettingsDialog;
