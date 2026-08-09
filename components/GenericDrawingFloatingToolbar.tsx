import React, { useEffect, useRef, useState } from 'react';
import { DEFAULT_STYLE, type Drawing, type DrawingEngine } from '@getcandlekit/charts';
import { GripVertical, Settings, Trash2 } from 'lucide-react';
import { drawingToolSupportsFill } from '../services/chartDrawingStyle';
import {
  normalizeDrawingStyle,
  updateDrawingStyleAndDefault,
} from '../services/chartDrawingStyleDefaults';
import TradingViewColorPicker, { colorWithAlpha, splitColorAlpha } from './TradingViewColorPicker';
import IndicatorTemplateMenu from './IndicatorTemplateMenu';

interface GenericDrawingFloatingToolbarProps {
  engine: DrawingEngine;
  drawing: Drawing;
  isDark?: boolean;
  onOpenSettings?: () => void;
}

const DEFAULT_FILL = '#2962ff1f';

const GenericDrawingFloatingToolbar: React.FC<GenericDrawingFloatingToolbarProps> = ({
  engine,
  drawing,
  isDark = false,
  onOpenSettings,
}) => {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerX: number;
    pointerY: number;
    left: number;
    top: number;
    maxLeft: number;
    maxTop: number;
  } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      setPosition({
        left: Math.max(4, Math.min(drag.maxLeft, drag.left + event.clientX - drag.pointerX)),
        top: Math.max(4, Math.min(drag.maxTop, drag.top + event.clientY - drag.pointerY)),
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

  const startDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const toolbar = toolbarRef.current;
    const parent = toolbar?.offsetParent as HTMLElement | null;
    if (!toolbar || !parent) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = toolbar.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const left = rect.left - parentRect.left;
    const top = rect.top - parentRect.top;
    setPosition({ left, top });
    dragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left,
      top,
      maxLeft: Math.max(4, parent.clientWidth - rect.width - 4),
      maxTop: Math.max(4, parent.clientHeight - rect.height - 4),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const lineColor = splitColorAlpha(drawing.style.color);
  const fillColor = splitColorAlpha(drawing.style.fill ?? DEFAULT_FILL);
  const lineStyle = drawing.style.lineStyle ?? (drawing.style.dashed ? 'dashed' : 'solid');
  const templateStyle = normalizeDrawingStyle(drawing.style, DEFAULT_STYLE);
  const controlClass = `flex h-7 min-w-7 items-center justify-center rounded px-1 transition-colors ${
    isDark ? 'text-[#d1d4dc] hover:bg-white/10' : 'text-[#131722] hover:bg-[#f0f3fa]'
  }`;
  const selectClass = `h-7 rounded border px-1 text-[11px] outline-none ${
    isDark ? 'border-white/15 bg-[#1e222d] text-[#d1d4dc]' : 'border-[#d1d4dc] bg-white text-[#131722]'
  }`;

  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Nástroje kresby"
      data-chart-overlay-menu
      className={`absolute z-[121] flex items-center gap-0.5 rounded-md border p-0.5 shadow-md ${
        position ? '' : 'left-1/2 top-1 -translate-x-1/2'
      } ${isDark ? 'border-white/15 bg-[#1e222d]' : 'border-[#d1d4dc] bg-white'}`}
      style={position ?? undefined}
      onPointerDown={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Přesunout nástroje kresby"
        title="Přesunout"
        onPointerDown={startDrag}
        className={`${controlClass} w-5 min-w-5 cursor-move touch-none ${isDark ? 'text-[#787b86]' : 'text-[#9598a1]'}`}
      >
        <GripVertical size={13} strokeWidth={1.4} />
      </button>
      <IndicatorTemplateMenu
        compact
        placement="bottom"
        indicator={`drawing:${drawing.tool}`}
        value={templateStyle}
        defaultValue={DEFAULT_STYLE}
        onApply={value => updateDrawingStyleAndDefault(
          engine,
          drawing,
          normalizeDrawingStyle(value, DEFAULT_STYLE),
        )}
      />
      <TradingViewColorPicker
        compact
        value={lineColor.color}
        opacity={lineColor.opacity}
        label="Barva čáry"
        onChange={(color, opacity) => updateDrawingStyleAndDefault(engine, drawing, { color: colorWithAlpha(color, opacity) })}
      />
      {drawing.tool === 'Text' ? <select
        className={selectClass}
        aria-label="Velikost textu"
        value={drawing.style.fontSize ?? 14}
        onChange={event => updateDrawingStyleAndDefault(engine, drawing, { fontSize: Number(event.target.value) })}
      >
        {[10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48].map(size => <option key={size} value={size}>{size}px</option>)}
      </select> : <>
        <select
          className={selectClass}
          aria-label="Tloušťka čáry"
          value={drawing.style.width}
          onChange={event => updateDrawingStyleAndDefault(engine, drawing, { width: Number(event.target.value) })}
        >
          {[1, 2, 3, 4].map(width => <option key={width} value={width}>{width}px</option>)}
        </select>
        <select
          className={`${selectClass} w-10 px-1 text-center font-mono`}
          aria-label="Styl čáry"
          value={lineStyle}
          onChange={event => {
            const next = event.target.value as 'solid' | 'dashed' | 'dotted';
            updateDrawingStyleAndDefault(engine, drawing, { lineStyle: next, dashed: next === 'dashed' });
          }}
        >
          <option value="solid">—</option>
          <option value="dashed">– –</option>
          <option value="dotted">···</option>
        </select>
      </>}
      {drawingToolSupportsFill(drawing.tool) && (
        <TradingViewColorPicker
          compact
          value={fillColor.color}
          opacity={fillColor.opacity}
          label="Barva výplně"
          onChange={(color, opacity) => updateDrawingStyleAndDefault(engine, drawing, { fill: colorWithAlpha(color, opacity) })}
        />
      )}
      {onOpenSettings && <button
        type="button"
        className={controlClass}
        aria-label="Nastavení kresby"
        title="Settings"
        onClick={onOpenSettings}
      >
        <Settings size={14} strokeWidth={1.35} />
      </button>}
      <button
        type="button"
        className={controlClass}
        aria-label="Smazat kresbu"
        title="Smazat"
        onClick={() => engine.remove(drawing.id)}
      >
        <Trash2 size={14} strokeWidth={1.35} />
      </button>
    </div>
  );
};

export default GenericDrawingFloatingToolbar;
