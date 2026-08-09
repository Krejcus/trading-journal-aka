import React, { useEffect, useRef, useState } from 'react';
import { DEFAULT_STYLE, type Drawing, type DrawingEngine, type DrawingStyle } from '@getcandlekit/charts';
import { GripVertical, X } from 'lucide-react';
import { drawingToolSupportsFill } from '../services/chartDrawingStyle';
import {
  normalizeDrawingStyle,
  rememberDrawingStyleDefault,
} from '../services/chartDrawingStyleDefaults';
import TradingViewColorPicker, { colorWithAlpha, splitColorAlpha } from './TradingViewColorPicker';
import IndicatorTemplateMenu from './IndicatorTemplateMenu';

type Tab = 'style' | 'text' | 'coordinates';

const DIALOG_WIDTH = 420;
const DEFAULT_FILL = '#2962ff1f';

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

const toolTitle = (tool: Drawing['tool']) => ({
  TrendLine: 'Trend line',
  Ray: 'Ray',
  ExtendedLine: 'Extended line',
  HorizontalLine: 'Horizontal line',
  HorizontalRay: 'Horizontal ray',
  VerticalLine: 'Vertical line',
  CrossLine: 'Cross line',
  Rectangle: 'Rectangle',
  Circle: 'Circle',
  Triangle: 'Triangle',
  ParallelChannel: 'Parallel channel',
  Arrow: 'Arrow',
  Text: 'Text',
  PriceRange: 'Price range',
  DateRange: 'Date range',
}[tool] ?? 'Drawing');

const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement>> = props => <select
  {...props}
  className={`h-9 rounded-md border border-slate-300 bg-white px-2 text-[13px] text-slate-800 outline-none focus:border-[#2962ff] ${props.className ?? ''}`}
/>;

const Numeric: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = props => <input
  {...props}
  type="number"
  onWheel={event => event.currentTarget.blur()}
  className={`h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-[13px] text-slate-900 outline-none focus:border-[#2962ff] ${props.className ?? ''}`}
/>;

interface GenericDrawingSettingsDialogProps {
  engine: DrawingEngine;
  drawing: Drawing;
  onClose: () => void;
}

const GenericDrawingSettingsDialog: React.FC<GenericDrawingSettingsDialogProps> = ({
  engine,
  drawing,
  onClose,
}) => {
  const originalStyleRef = useRef(clone(drawing.style));
  const originalPointsRef = useRef(clone(drawing.points));
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [tab, setTab] = useState<Tab>('style');
  const [style, setStyle] = useState(() => clone(drawing.style));
  const [points, setPoints] = useState(() => clone(drawing.points));
  const [position, setPosition] = useState(() => ({
    left: Math.max(16, Math.round((window.innerWidth - DIALOG_WIDTH) / 2)),
    top: Math.max(16, Math.round((window.innerHeight - 480) / 2)),
  }));

  const updateStyle = (patch: Partial<DrawingStyle>) => {
    const next = normalizeDrawingStyle({ ...style, ...patch }, style);
    setStyle(next);
    engine.setStyle(drawing.id, patch);
  };

  const updatePoints = (next: typeof points) => {
    setPoints(next);
    engine.setPoints(drawing.id, next);
  };

  const cancel = () => {
    if (drawing.tool === 'Text' && !originalStyleRef.current.text?.trim()) {
      engine.remove(drawing.id);
      onClose();
      return;
    }
    engine.setStyle(drawing.id, originalStyleRef.current);
    engine.setPoints(drawing.id, originalPointsRef.current);
    onClose();
  };

  const apply = () => {
    rememberDrawingStyleDefault(drawing.tool, normalizeDrawingStyle(style, DEFAULT_STYLE));
    onClose();
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragRef.current) return;
      setPosition({
        left: Math.max(0, Math.min(window.innerWidth - DIALOG_WIDTH, dragRef.current.left + event.clientX - dragRef.current.x)),
        top: Math.max(0, Math.min(window.innerHeight - 80, dragRef.current.top + event.clientY - dragRef.current.y)),
      });
    };
    const stop = () => { dragRef.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  });

  const lineColor = splitColorAlpha(style.color);
  const fillColor = splitColorAlpha(style.fill ?? DEFAULT_FILL);
  const textColor = splitColorAlpha(style.textColor ?? style.color);
  const lineStyle = style.lineStyle ?? (style.dashed ? 'dashed' : 'solid');
  const tabButton = (id: Tab, label: string) => <button
    type="button"
    role="tab"
    aria-selected={tab === id}
    onClick={() => setTab(id)}
    className={`relative h-11 px-1 text-[13px] font-semibold ${tab === id ? 'text-slate-950 after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:rounded-full after:bg-[#2962ff]' : 'text-slate-600'}`}
  >{label}</button>;

  return <div className="pointer-events-none fixed inset-0 z-[650]" data-chart-settings-dialog="true">
    <section
      role="dialog"
      aria-label={`${toolTitle(drawing.tool)} settings`}
      className="pointer-events-auto absolute flex max-h-[min(620px,calc(100vh-24px))] w-[420px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl"
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
        <h2 className="text-[19px] font-bold">{toolTitle(drawing.tool)}</h2>
        <button type="button" onClick={cancel} className="ml-auto flex h-9 w-9 items-center justify-center rounded hover:bg-slate-100" aria-label="Close drawing settings"><X size={23} /></button>
      </header>
      <nav role="tablist" className="flex h-11 shrink-0 gap-7 border-b border-slate-200 px-4">
        {tabButton('style', 'Style')}
        {drawing.tool !== 'Text' && tabButton('text', 'Text')}
        {tabButton('coordinates', 'Coordinates')}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {tab === 'style' && <div className="space-y-4">
          {drawing.tool === 'Text' && <label className="block space-y-2">
            <span className="text-[13px] text-slate-800">Text</span>
            <textarea
              autoFocus
              value={style.text ?? ''}
              onChange={event => updateStyle({ text: event.target.value })}
              placeholder="Napište text…"
              rows={4}
              className="w-full resize-y rounded-md border border-slate-300 px-3 py-2 text-[14px] outline-none focus:border-[#2962ff]"
            />
          </label>}
          <div className="grid grid-cols-[1fr_auto] items-center gap-4">
            <span className="text-[13px] text-slate-800">{drawing.tool === 'Text' ? 'Text color' : 'Line'}</span>
            <div className="flex items-center gap-2">
              <TradingViewColorPicker
                value={lineColor.color}
                opacity={lineColor.opacity}
                label="Line color"
                onChange={(color, opacity) => updateStyle({ color: colorWithAlpha(color, opacity) })}
              />
              {drawing.tool === 'Text' ? <Select aria-label="Font size" value={style.fontSize ?? 14} onChange={event => updateStyle({ fontSize: Number(event.target.value) })}>
                {[10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48].map(value => <option key={value} value={value}>{value}px</option>)}
              </Select> : <>
                <Select aria-label="Line width" value={style.width} onChange={event => updateStyle({ width: Number(event.target.value) })}>
                  {[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}px</option>)}
                </Select>
                <Select aria-label="Line style" value={lineStyle} onChange={event => {
                  const next = event.target.value as 'solid' | 'dashed' | 'dotted';
                  updateStyle({ lineStyle: next, dashed: next === 'dashed' });
                }}>
                  <option value="solid">—</option>
                  <option value="dashed">– –</option>
                  <option value="dotted">···</option>
                </Select>
              </>}
            </div>
          </div>
          {drawingToolSupportsFill(drawing.tool) && <div className="grid grid-cols-[1fr_auto] items-center gap-4 border-t border-slate-200 pt-4">
            <span className="text-[13px] text-slate-800">Background</span>
            <TradingViewColorPicker
              value={fillColor.color}
              opacity={fillColor.opacity}
              label="Background color"
              onChange={(color, opacity) => updateStyle({ fill: colorWithAlpha(color, opacity) })}
            />
          </div>}
        </div>}
        {tab === 'coordinates' && <div className="space-y-4">
          {points.map((point, index) => <fieldset key={index} className="rounded-md border border-slate-200 p-3">
            <legend className="px-2 text-[12px] font-semibold text-slate-500">#{index + 1} (price, time)</legend>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-[11px] text-slate-500">Price</span>
                <Numeric step="0.25" value={point.price} onChange={event => updatePoints(points.map((item, itemIndex) => itemIndex === index ? { ...item, price: Number(event.target.value) } : item))} />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] text-slate-500">Time</span>
                <input type="datetime-local" value={toLocalInput(point.time)} onChange={event => updatePoints(points.map((item, itemIndex) => itemIndex === index ? { ...item, time: fromLocalInput(event.target.value, item.time) } : item))} className="h-9 w-full rounded-md border border-slate-300 px-2 text-[13px] outline-none focus:border-[#2962ff]" />
              </label>
            </div>
          </fieldset>)}
        </div>}
        {tab === 'text' && drawing.tool !== 'Text' && <div className="space-y-4">
          <div className="flex items-center gap-3">
            <TradingViewColorPicker
              value={textColor.color}
              opacity={textColor.opacity}
              label="Text color"
              onChange={(color, opacity) => updateStyle({ textColor: colorWithAlpha(color, opacity) })}
            />
            <Select aria-label="Text size" value={style.fontSize ?? 12} onChange={event => updateStyle({ fontSize: Number(event.target.value) })}>
              {[8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48].map(value => <option key={value} value={value}>{value}</option>)}
            </Select>
          </div>
          <textarea
            autoFocus
            aria-label="Add text"
            value={style.text ?? ''}
            onChange={event => updateStyle({ text: event.target.value })}
            placeholder="Add text"
            rows={6}
            className="w-full resize-y rounded-md border border-slate-300 px-3 py-2 text-[14px] outline-none focus:border-[#2962ff]"
          />
          <div className="grid grid-cols-[1fr_auto] items-center gap-4 border-t border-slate-200 pt-4">
            <span className="text-[13px] text-slate-800">Text alignment</span>
            <div className="flex items-center gap-2">
              <Select aria-label="Vertical text alignment" value={style.textVertical ?? 'middle'} onChange={event => updateStyle({ textVertical: event.target.value as DrawingStyle['textVertical'] })}>
                <option value="top">Top</option>
                <option value="middle">Middle</option>
                <option value="bottom">Bottom</option>
              </Select>
              <Select aria-label="Horizontal text alignment" value={style.textHorizontal ?? 'center'} onChange={event => updateStyle({ textHorizontal: event.target.value as DrawingStyle['textHorizontal'] })}>
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </Select>
            </div>
          </div>
        </div>}
      </div>
      <footer className="flex h-16 shrink-0 items-center border-t border-slate-200 px-4">
        <IndicatorTemplateMenu
          indicator={`drawing:${drawing.tool}`}
          value={normalizeDrawingStyle(style, DEFAULT_STYLE)}
          defaultValue={DEFAULT_STYLE}
          onApply={value => updateStyle(normalizeDrawingStyle(value, DEFAULT_STYLE))}
        />
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={cancel} className="h-9 rounded-md border border-slate-300 px-5 text-[13px] font-semibold hover:bg-slate-50">Cancel</button>
          <button type="button" onClick={apply} className="h-9 rounded-md bg-[#2962ff] px-5 text-[13px] font-semibold text-white hover:bg-[#1e53d8]">Ok</button>
        </div>
      </footer>
    </section>
  </div>;
};

export default GenericDrawingSettingsDialog;
